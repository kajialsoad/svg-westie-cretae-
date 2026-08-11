import os
import io
import json
import uuid
import asyncio
import logging
from pathlib import Path
from datetime import datetime, timezone

from dotenv import load_dotenv
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import requests
from fastapi import FastAPI, APIRouter, Request, Response, UploadFile, File, Form, HTTPException, Header
from fastapi.responses import StreamingResponse
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, EmailStr
from bson import ObjectId

import auth as auth_mod
import storage as storage_mod
import compression
import conversions
import svga_codec
import bgremove

mongo_url = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
client = AsyncIOMotorClient(mongo_url, serverSelectionTimeoutMS=1000)
db = client[os.environ.get('DB_NAME', 'svgastudio')]
APP_NAME = os.environ.get("APP_NAME", "svgastudio")
BG_JOBS_DIR = os.path.join(os.path.dirname(__file__), "bgjobs")

_MEMORY_BG_JOBS = {}
_MEMORY_JOBS = {}

class SafeCollection:
    def __init__(self, real_coll, memory_dict):
        self.real_coll = real_coll
        self.memory_dict = memory_dict

    async def insert_one(self, doc):
        doc_id = str(doc.get("_id", uuid.uuid4().hex))
        doc["_id"] = doc_id
        self.memory_dict[doc_id] = dict(doc)
        try:
            return await self.real_coll.insert_one(doc)
        except Exception as e:
            class FakeResult:
                inserted_id = doc_id
            return FakeResult()

    async def update_one(self, filter_q, update_q, upsert=False):
        doc_id = filter_q.get("_id")
        if doc_id and doc_id in self.memory_dict:
            target = self.memory_dict[doc_id]
            if "$set" in update_q:
                target.update(update_q["$set"])
        try:
            return await self.real_coll.update_one(filter_q, update_q, upsert=upsert)
        except Exception as e:
            return None

    async def find_one(self, filter_q):
        doc_id = filter_q.get("_id")
        try:
            res = await self.real_coll.find_one(filter_q)
            if res:
                return res
        except Exception as e:
            pass
        if doc_id and doc_id in self.memory_dict:
            return self.memory_dict[doc_id]
        return None

bg_jobs_coll = SafeCollection(db.bg_jobs, _MEMORY_BG_JOBS)
jobs_coll = SafeCollection(db.jobs, _MEMORY_JOBS)

app = FastAPI()
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("svga")


# ---------------- models ----------------
class RegisterIn(BaseModel):
    email: EmailStr
    password: str
    name: str = "User"


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class FaqIn(BaseModel):
    question: str
    answer: str
    order: int = 0


class ShowcaseUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    category: str | None = None


def _set_cookie(resp, token):
    resp.set_cookie("access_token", token, httponly=True, secure=False,
                    samesite="lax", max_age=604800, path="/")


async def _bump(field, n=1):
    try:
        await db.stats.update_one({"_id": "global"}, {"$inc": {field: n}}, upsert=True)
    except Exception as e:
        logger.warning(f"Stats bump skipped (MongoDB offline): {e}")


# ---------------- auth ----------------
@api_router.post("/auth/register")
async def register(body: RegisterIn, response: Response):
    email = body.email.lower()
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=400, detail="Email already registered")
    doc = {"email": email, "password_hash": auth_mod.hash_password(body.password),
           "name": body.name, "role": "user", "created_at": datetime.now(timezone.utc).isoformat()}
    res = await db.users.insert_one(doc)
    token = auth_mod.create_access_token(res.inserted_id, email)
    _set_cookie(response, token)
    return {"token": token, "user": {"id": str(res.inserted_id), "email": email, "name": body.name, "role": "user"}}


@api_router.post("/auth/login")
async def login(body: LoginIn, response: Response):
    email = body.email.lower()
    user = await db.users.find_one({"email": email})
    if not user or not auth_mod.verify_password(body.password, user.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = auth_mod.create_access_token(user["_id"], email)
    _set_cookie(response, token)
    return {"token": token, "user": {"id": str(user["_id"]), "email": email,
                                     "name": user.get("name", ""), "role": user.get("role", "user")}}


@api_router.post("/auth/google")
async def google_auth(response: Response, x_session_id: str = Header(None)):
    if not x_session_id:
        raise HTTPException(status_code=400, detail="Missing session id")
    r = requests.get("https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data",
                     headers={"X-Session-ID": x_session_id}, timeout=30)
    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid session")
    data = r.json()
    email = data["email"].lower()
    admin_email = os.environ.get("ADMIN_EMAIL", "").lower()
    user = await db.users.find_one({"email": email})
    if not user:
        role = "admin" if email == admin_email else "user"
        doc = {"email": email, "name": data.get("name", ""), "picture": data.get("picture", ""),
               "role": role, "provider": "google", "created_at": datetime.now(timezone.utc).isoformat()}
        res = await db.users.insert_one(doc)
        uid = res.inserted_id
        user = {**doc, "_id": uid}
    token = auth_mod.create_access_token(user["_id"], email)
    _set_cookie(response, token)
    return {"token": token, "user": {"id": str(user["_id"]), "email": email,
                                     "name": user.get("name", ""), "role": user.get("role", "user")}}


@api_router.get("/auth/me")
async def me(request: Request):
    return await auth_mod.get_current_user(request, db)


@api_router.post("/auth/logout")
async def logout(response: Response):
    response.delete_cookie("access_token", path="/")
    return {"ok": True}


# ---------------- preview ----------------
@api_router.post("/preview/info")
async def preview_info(file: UploadFile = File(...)):
    data = await file.read()
    try:
        meta = svga_codec.info(data)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid or unsupported SVGA file")
    meta["size"] = len(data)
    meta["filename"] = file.filename
    await _bump("previews")
    return meta


# ---------------- convert ----------------
@api_router.post("/convert/{kind}")
async def convert(kind: str, file: UploadFile = File(...),
                  tier: str = Form("standard"), one_mb: str = Form("false")):
    if kind not in conversions.CONVERSIONS:
        raise HTTPException(status_code=404, detail="Unknown conversion")
    data = await file.read()
    src_ext = (file.filename.rsplit(".", 1)[-1] if "." in (file.filename or "") else "mp4").lower()
    tier = compression.normalize_tier(tier)
    one_mb_mode = compression.is_one_mb_mode_enabled(one_mb)
    try:
        # Conversions are CPU bound; keep them off the event loop.
        result, out_ext, mime = await asyncio.get_event_loop().run_in_executor(
            None, conversions.convert, kind, data, src_ext, tier, one_mb_mode)
    except Exception as e:
        logger.exception("convert failed")
        raise HTTPException(status_code=400, detail=f"Conversion failed: {str(e)[:200]}")
    await _bump("conversions")
    await _bump(f"convert_{kind.replace('-', '_')}")
    base = (file.filename.rsplit(".", 1)[0] if file.filename else "output")
    name = f"{base}.{out_ext}"
    return StreamingResponse(io.BytesIO(result), media_type=mime,
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---------------- background remover ----------------
@api_router.post("/bg/image")
async def bg_image(file: UploadFile = File(...), mode: str = Form("transparent"),
                   color: str = Form("#FFFFFF"), background: UploadFile = File(None)):
    data = await file.read()
    bg_bytes = await background.read() if background is not None else None
    try:
        result, ext, mime = bgremove.remove_image(data, mode, color, bg_bytes)
    except Exception as e:
        logger.exception("bg image failed")
        raise HTTPException(status_code=400, detail=f"Background removal failed: {str(e)[:200]}")
    await _bump("bg_images")
    base = (file.filename.rsplit(".", 1)[0] if file.filename else "image")
    return StreamingResponse(io.BytesIO(result), media_type=mime,
                             headers={"Content-Disposition": f'attachment; filename="{base}-nobg.{ext}"'})


@api_router.post("/bg/video/submit")
async def bg_video_submit(file: UploadFile = File(...), mode: str = Form("transparent"),
                          color: str = Form("#FFFFFF"), background: UploadFile = File(None)):
    data = await file.read()
    src_ext = (file.filename.rsplit(".", 1)[-1] if "." in (file.filename or "") else "mp4").lower()
    bg_bytes = await background.read() if background is not None else None
    job_id = uuid.uuid4().hex
    base = (file.filename.rsplit(".", 1)[0] if file.filename else "video")
    await bg_jobs_coll.insert_one({
        "_id": job_id, "status": "processing", "mode": mode, "base": base,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    import asyncio
    loop = asyncio.get_event_loop()
    loop.create_task(_run_bg_video(job_id, data, src_ext, mode, color, bg_bytes))
    return {"job_id": job_id, "status": "processing"}


async def _run_bg_video(job_id, data, src_ext, mode, color, bg_bytes):
    import asyncio
    loop = asyncio.get_event_loop()
    try:
        result, ext, mime = await loop.run_in_executor(
            None, bgremove.remove_video, data, src_ext, mode, color, bg_bytes)
        os.makedirs(BG_JOBS_DIR, exist_ok=True)
        path = os.path.join(BG_JOBS_DIR, f"{job_id}.{ext}")
        with open(path, "wb") as f:
            f.write(result)
        await bg_jobs_coll.update_one({"_id": job_id},
                                    {"$set": {"status": "done", "ext": ext, "mime": mime, "path": path}})
        await _bump("bg_videos")
    except Exception as e:
        logger.exception("bg video job failed")
        await bg_jobs_coll.update_one({"_id": job_id},
                                    {"$set": {"status": "error", "error": str(e)[:200]}})


@api_router.get("/bg/video/status/{job_id}")
async def bg_video_status(job_id: str):
    job = await bg_jobs_coll.find_one({"_id": job_id})
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"status": job["status"], "ext": job.get("ext"), "error": job.get("error")}


@api_router.get("/bg/video/result/{job_id}")
async def bg_video_result(job_id: str):
    job = await bg_jobs_coll.find_one({"_id": job_id})
    if not job or job.get("status") != "done":
        raise HTTPException(status_code=404, detail="Result not ready")
    if not job.get("path") or not os.path.exists(job["path"]):
        raise HTTPException(status_code=410, detail="Result expired, please re-run")
    with open(job["path"], "rb") as f:
        content = f.read()
    return StreamingResponse(io.BytesIO(content), media_type=job["mime"],
                             headers={"Content-Disposition": f'attachment; filename="{job["base"]}-nobg.{job["ext"]}"'})


# ---------------- layer editor + heavy async jobs ----------------
@api_router.post("/svga/layers")
async def svga_layers(file: UploadFile = File(...)):
    data = await file.read()
    try:
        return svga_codec.layers(data)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid or unsupported SVGA file")


async def _run_job(job_id, worker, args):
    loop = asyncio.get_event_loop()
    try:
        result, ext, mime = await loop.run_in_executor(None, worker, *args)
        os.makedirs(BG_JOBS_DIR, exist_ok=True)
        path = os.path.join(BG_JOBS_DIR, f"{job_id}.{ext}")
        with open(path, "wb") as f:
            f.write(result)
        await jobs_coll.update_one({"_id": job_id},
                                 {"$set": {"status": "done", "ext": ext, "mime": mime, "path": path,
                                           "size": len(result)}})
    except Exception as e:
        logger.exception("job failed")
        await jobs_coll.update_one({"_id": job_id}, {"$set": {"status": "error", "error": str(e)[:200]}})


async def _create_job(jtype, base, worker, *args):
    job_id = uuid.uuid4().hex
    await jobs_coll.insert_one({"_id": job_id, "type": jtype, "status": "processing", "base": base,
                             "created_at": datetime.now(timezone.utc).isoformat()})
    asyncio.get_event_loop().create_task(_run_job(job_id, worker, args))
    return job_id


@api_router.post("/jobs/mp4-to-svga")
async def job_mp4_to_svga(file: UploadFile = File(...), remove_bg: str = Form("false"),
                          preset: str = Form("balanced"), tier: str = Form(""),
                          one_mb: str = Form("false")):
    data = await file.read()
    ext = (file.filename.rsplit(".", 1)[-1] if "." in (file.filename or "") else "mp4").lower()
    base = (file.filename.rsplit(".", 1)[0] if file.filename else "video")
    rb = remove_bg.lower() in ("1", "true", "yes", "on")
    job_id = await _create_job("mp4-to-svga", base, conversions.mp4_to_svga_advanced,
                               data, ext, rb, preset, tier or None,
                               compression.is_one_mb_mode_enabled(one_mb))
    await _bump("conversions")
    await _bump("convert_mp4_to_svga")
    return {"job_id": job_id, "status": "processing"}


@api_router.post("/jobs/svga-export")
async def job_svga_export(file: UploadFile = File(...), edits: str = Form("{}"),
                          target: str = Form("gif"), tier: str = Form("standard"),
                          one_mb: str = Form("false")):
    data = await file.read()
    base = (file.filename.rsplit(".", 1)[0] if file.filename else "svga")
    try:
        edits_obj = json.loads(edits or "{}")
    except Exception:
        edits_obj = {}
    job_id = await _create_job("svga-export", base, conversions.svga_export,
                               data, edits_obj, target,
                               compression.normalize_tier(tier),
                               compression.is_one_mb_mode_enabled(one_mb))
    await _bump("conversions")
    await _bump(f"convert_svga_to_{target.replace('-', '_')}")
    return {"job_id": job_id, "status": "processing"}


@api_router.get("/tiers")
async def list_tiers():
    """Expose the compression tiers so the UI can offer a size target."""
    return {
        "tiers": [
            {"id": key, "label": cfg["label"], "maxSizeMB": cfg["maxSizeMB"],
             "resolution": cfg["resolution"], "fpsRange": list(cfg["fpsRange"])}
            for key, cfg in compression.SIZE_TIERS.items()
        ],
        "oneMb": {"label": compression.ONE_MB_POLICY["label"],
                  "targetSizeMB": compression.ONE_MB_POLICY["targetSizeMB"]},
    }


@api_router.get("/jobs/{job_id}/status")
async def job_status(job_id: str):
    job = await jobs_coll.find_one({"_id": job_id})
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"status": job["status"], "ext": job.get("ext"), "size": job.get("size"), "error": job.get("error")}


@api_router.get("/jobs/{job_id}/result")
async def job_result(job_id: str):
    job = await jobs_coll.find_one({"_id": job_id})
    if not job or job.get("status") != "done":
        raise HTTPException(status_code=404, detail="Result not ready")
    if not job.get("path") or not os.path.exists(job["path"]):
        raise HTTPException(status_code=410, detail="Result expired, please re-run")
    with open(job["path"], "rb") as f:
        content = f.read()
    return StreamingResponse(io.BytesIO(content), media_type=job["mime"],
                             headers={"Content-Disposition": f'attachment; filename="{job["base"]}.{job["ext"]}"'})


# ---------------- showcase ----------------
def _showcase_public(doc):
    return {
        "id": str(doc["_id"]), "title": doc.get("title", ""),
        "description": doc.get("description", ""), "category": doc.get("category", "general"),
        "width": doc.get("width"), "height": doc.get("height"), "frames": doc.get("frames"),
        "fps": doc.get("fps"), "size": doc.get("size"), "created_at": doc.get("created_at"),
    }


@api_router.get("/showcase")
async def list_showcase(category: str = None):
    try:
        q = {"is_deleted": {"$ne": True}}
        if category and category != "all":
            q["category"] = category
        docs = await db.showcase.find(q).sort("created_at", -1).to_list(500)
        return [_showcase_public(d) for d in docs]
    except Exception as e:
        logger.warning(f"MongoDB showcase fetch skipped: {e}")
        return []


@api_router.get("/showcase/{item_id}/file")
async def showcase_file(item_id: str):
    doc = await db.showcase.find_one({"_id": ObjectId(item_id), "is_deleted": {"$ne": True}})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    data, ct = storage_mod.get_object(doc["storage_path"])
    await _bump("showcase_views")
    return Response(content=data, media_type="application/octet-stream")


@api_router.post("/admin/showcase")
async def create_showcase(request: Request, file: UploadFile = File(...),
                          title: str = Form(...), description: str = Form(""),
                          category: str = Form("general")):
    await auth_mod.require_admin(request, db)
    data = await file.read()
    try:
        meta = svga_codec.info(data)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid SVGA file")
    path = f"{APP_NAME}/showcase/{uuid.uuid4()}.svga"
    storage_mod.put_object(path, data, "application/octet-stream")
    doc = {"title": title, "description": description, "category": category,
           "storage_path": path, "size": len(data), "width": meta["width"],
           "height": meta["height"], "frames": meta["frames"], "fps": meta["fps"],
           "is_deleted": False, "created_at": datetime.now(timezone.utc).isoformat()}
    res = await db.showcase.insert_one(doc)
    return {"id": str(res.inserted_id), **_showcase_public({**doc, "_id": res.inserted_id})}


@api_router.put("/admin/showcase/{item_id}")
async def update_showcase(item_id: str, body: ShowcaseUpdate, request: Request):
    await auth_mod.require_admin(request, db)
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    if upd:
        await db.showcase.update_one({"_id": ObjectId(item_id)}, {"$set": upd})
    return {"ok": True}


@api_router.delete("/admin/showcase/{item_id}")
async def delete_showcase(item_id: str, request: Request):
    await auth_mod.require_admin(request, db)
    await db.showcase.update_one({"_id": ObjectId(item_id)}, {"$set": {"is_deleted": True}})
    return {"ok": True}


# ---------------- faq ----------------
@api_router.get("/faq")
async def list_faq():
    try:
        docs = await db.faq.find({"is_deleted": {"$ne": True}}).sort("order", 1).to_list(200)
        return [{"id": str(d["_id"]), "question": d["question"], "answer": d["answer"],
                 "order": d.get("order", 0)} for d in docs]
    except Exception as e:
        logger.warning(f"MongoDB FAQ fetch skipped: {e}")
        return []


@api_router.post("/admin/faq")
async def create_faq(body: FaqIn, request: Request):
    await auth_mod.require_admin(request, db)
    doc = {**body.model_dump(), "is_deleted": False, "created_at": datetime.now(timezone.utc).isoformat()}
    res = await db.faq.insert_one(doc)
    return {"id": str(res.inserted_id), **body.model_dump()}


@api_router.put("/admin/faq/{faq_id}")
async def update_faq(faq_id: str, body: FaqIn, request: Request):
    await auth_mod.require_admin(request, db)
    await db.faq.update_one({"_id": ObjectId(faq_id)}, {"$set": body.model_dump()})
    return {"ok": True}


@api_router.delete("/admin/faq/{faq_id}")
async def delete_faq(faq_id: str, request: Request):
    await auth_mod.require_admin(request, db)
    await db.faq.update_one({"_id": ObjectId(faq_id)}, {"$set": {"is_deleted": True}})
    return {"ok": True}


# ---------------- stats ----------------
@api_router.get("/stats")
async def stats():
    try:
        s = await db.stats.find_one({"_id": "global"}) or {}
        showcase_count = await db.showcase.count_documents({"is_deleted": {"$ne": True}})
        s.pop("_id", None)
        return {"previews": s.get("previews", 0), "conversions": s.get("conversions", 0),
                "showcase_views": s.get("showcase_views", 0), "showcase_count": showcase_count,
                "bg_images": s.get("bg_images", 0), "bg_videos": s.get("bg_videos", 0)}
    except Exception as e:
        return {"previews": 0, "conversions": 0, "showcase_views": 0, "showcase_count": 0, "bg_images": 0, "bg_videos": 0}


@api_router.get("/admin/stats")
async def admin_stats(request: Request):
    await auth_mod.require_admin(request, db)
    s = await db.stats.find_one({"_id": "global"}) or {}
    s.pop("_id", None)
    showcase_count = await db.showcase.count_documents({"is_deleted": {"$ne": True}})
    faq_count = await db.faq.count_documents({"is_deleted": {"$ne": True}})
    users = await db.users.count_documents({})
    breakdown = {k: v for k, v in s.items() if k.startswith("convert_")}
    return {"previews": s.get("previews", 0), "conversions": s.get("conversions", 0),
            "showcase_views": s.get("showcase_views", 0), "showcase_count": showcase_count,
            "faq_count": faq_count, "users": users, "conversion_breakdown": breakdown,
            "bg_images": s.get("bg_images", 0), "bg_videos": s.get("bg_videos", 0)}


@api_router.get("/")
async def root():
    return {"service": "SVGA Studio API"}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    try:
        await auth_mod.seed_admin(db)
        await db.users.create_index("email", unique=True)
    except Exception as e:
        logger.warning(f"MongoDB admin seed skipped (MongoDB offline): {e}")
    try:
        storage_mod.init_storage()
        logger.info("storage ready")
    except Exception as e:
        logger.error(f"storage init failed: {e}")


@app.on_event("shutdown")
async def shutdown():
    client.close()
