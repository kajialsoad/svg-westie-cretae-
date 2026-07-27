"""SVGA Studio backend API integration tests.

Covers: auth (register/login/me/admin), preview/info, all conversion kinds,
admin showcase CRUD, FAQ CRUD, public + admin stats.
"""
import io
import os
import time
import uuid

import pytest
import requests
from dotenv import load_dotenv

# Load frontend env to obtain external public URL the user hits
load_dotenv("/app/frontend/.env")
BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

SAMPLE_SVGA = "/tmp/sample.svga"
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@svga.dev")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")

# ---------------- fixtures ----------------


class _NoCookieSession:
    """Wrapper that mimics requests.Session API but always strips cookies between
    calls. The backend's _extract_token prefers cookies over Authorization headers,
    so a stale cookie from a previous request can mask a Bearer token. Tests must
    not share auth state implicitly.
    """

    def request(self, method, url, **kw):
        kw.setdefault("timeout", 60)
        return requests.request(method, url, **kw)

    def get(self, url, **kw):
        return self.request("GET", url, **kw)

    def post(self, url, **kw):
        return self.request("POST", url, **kw)

    def put(self, url, **kw):
        return self.request("PUT", url, **kw)

    def delete(self, url, **kw):
        return self.request("DELETE", url, **kw)


@pytest.fixture(scope="session")
def session():
    return _NoCookieSession()


@pytest.fixture(scope="session")
def svga_bytes():
    with open(SAMPLE_SVGA, "rb") as f:
        return f.read()


@pytest.fixture(scope="session")
def admin_token(session):
    r = session.post(f"{API}/auth/login",
                     json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                     timeout=30)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    data = r.json()
    assert data["user"]["role"] == "admin"
    assert isinstance(data["token"], str) and len(data["token"]) > 20
    return data["token"]


@pytest.fixture(scope="session")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# ---------------- auth ----------------


class TestAuth:
    def test_admin_login_returns_token_and_admin_role(self, session):
        r = session.post(f"{API}/auth/login",
                         json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        assert r.status_code == 200
        data = r.json()
        assert data["user"]["email"] == ADMIN_EMAIL
        assert data["user"]["role"] == "admin"
        assert "token" in data and isinstance(data["token"], str)

    def test_login_invalid_credentials(self, session):
        r = session.post(f"{API}/auth/login",
                         json={"email": ADMIN_EMAIL, "password": "wrongpass"})
        assert r.status_code == 401

    def test_auth_me_with_bearer(self, session, admin_headers):
        r = session.get(f"{API}/auth/me", headers=admin_headers)
        assert r.status_code == 200
        u = r.json()
        assert u["email"] == ADMIN_EMAIL
        assert u["role"] == "admin"
        assert "id" in u
        assert "password_hash" not in u

    def test_auth_me_unauthenticated(self, session):
        # Use a fresh session so we don't send any login cookies.
        r = requests.get(f"{API}/auth/me")
        assert r.status_code == 401

    def test_register_creates_user_role(self, session):
        email = f"TEST_user_{uuid.uuid4().hex[:8]}@example.com"
        r = session.post(f"{API}/auth/register",
                         json={"email": email, "password": "pw12345", "name": "Tester"})
        assert r.status_code == 200, r.text
        data = r.json()
        # backend lowercases email
        assert data["user"]["email"] == email.lower()
        assert data["user"]["role"] == "user"
        assert isinstance(data["token"], str)

        # duplicate registration should fail
        r2 = session.post(f"{API}/auth/register",
                          json={"email": email, "password": "pw12345"})
        assert r2.status_code == 400

    def test_admin_endpoint_requires_auth(self, session):
        r = requests.get(f"{API}/admin/stats")
        assert r.status_code in (401, 403)

    def test_admin_endpoint_forbidden_for_user(self, session):
        email = f"TEST_user_{uuid.uuid4().hex[:8]}@example.com"
        rr = session.post(f"{API}/auth/register",
                          json={"email": email, "password": "pw12345"})
        token = rr.json()["token"]
        r = requests.get(f"{API}/admin/stats",
                         headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 403


# ---------------- preview ----------------


class TestPreview:
    def test_preview_info_sample(self, session, svga_bytes):
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        r = session.post(f"{API}/preview/info", files=files)
        assert r.status_code == 200, r.text
        m = r.json()
        assert m["width"] == 160
        assert m["height"] == 160
        assert m["frames"] == 20
        assert m["fps"] == 20
        assert m["size"] == len(svga_bytes)
        assert "duration" in m
        assert "assets" in m and "sprites" in m

    def test_preview_info_rejects_garbage(self, session):
        files = {"file": ("bad.svga", b"not-an-svga", "application/octet-stream")}
        r = session.post(f"{API}/preview/info", files=files)
        assert r.status_code == 400


# ---------------- conversions ----------------


SVGA_OUT_KINDS = [
    ("svga-to-gif", "image/gif"),
    ("svga-to-mp4", "video/mp4"),
    ("svga-to-png", "application/zip"),
    ("svga-to-webp", "image/webp"),
    ("svga-to-lottie", "application/json"),
    ("svga-to-json", "application/json"),
]


class TestConversions:
    @pytest.mark.parametrize("kind,mime", SVGA_OUT_KINDS)
    def test_svga_to_x(self, session, svga_bytes, kind, mime):
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        r = session.post(f"{API}/convert/{kind}", files=files, timeout=120)
        assert r.status_code == 200, f"{kind} failed: {r.status_code} {r.text[:300]}"
        assert mime in r.headers.get("content-type", ""), \
            f"{kind} content-type={r.headers.get('content-type')}"
        body = r.content
        assert len(body) > 50, f"{kind} body too small: {len(body)} bytes"
        cd = r.headers.get("content-disposition", "")
        assert "attachment" in cd

    def test_unknown_kind_returns_404(self, session, svga_bytes):
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        r = session.post(f"{API}/convert/foo-to-bar", files=files)
        assert r.status_code == 404

    def test_gif_to_svga_roundtrip(self, session, svga_bytes):
        # 1) produce gif from sample.svga
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        r1 = session.post(f"{API}/convert/svga-to-gif", files=files, timeout=120)
        assert r1.status_code == 200
        gif_bytes = r1.content
        assert gif_bytes[:6] in (b"GIF87a", b"GIF89a")

        # 2) feed gif back into gif-to-svga
        files2 = {"file": ("out.gif", gif_bytes, "image/gif")}
        r2 = session.post(f"{API}/convert/gif-to-svga", files=files2, timeout=120)
        assert r2.status_code == 200, f"gif-to-svga failed: {r2.text[:300]}"
        out = r2.content
        assert len(out) > 100
        cd = r2.headers.get("content-disposition", "")
        assert ".svga" in cd

    def test_webp_to_svga_roundtrip(self, session, svga_bytes):
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        r1 = session.post(f"{API}/convert/svga-to-webp", files=files, timeout=120)
        assert r1.status_code == 200
        webp = r1.content
        files2 = {"file": ("out.webp", webp, "image/webp")}
        r2 = session.post(f"{API}/convert/webp-to-svga", files=files2, timeout=120)
        assert r2.status_code == 200, f"webp-to-svga failed: {r2.text[:300]}"
        assert len(r2.content) > 100

    def test_mp4_to_svga_roundtrip(self, session, svga_bytes):
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        r1 = session.post(f"{API}/convert/svga-to-mp4", files=files, timeout=120)
        assert r1.status_code == 200
        mp4 = r1.content
        files2 = {"file": ("out.mp4", mp4, "video/mp4")}
        r2 = session.post(f"{API}/convert/mp4-to-svga", files=files2, timeout=180)
        assert r2.status_code == 200, f"mp4-to-svga failed: {r2.text[:300]}"
        assert len(r2.content) > 100


# ---------------- showcase ----------------


@pytest.fixture(scope="class")
def showcase_ctx():
    return {"id": None}


class TestShowcase:
    def test_create_showcase_requires_admin(self, session, svga_bytes):
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        r = session.post(f"{API}/admin/showcase", files=files,
                         data={"title": "x", "description": "", "category": "general"})
        assert r.status_code in (401, 403)

    def test_create_showcase_with_admin(self, session, svga_bytes, admin_headers,
                                         showcase_ctx):
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        r = session.post(f"{API}/admin/showcase",
                         files=files,
                         data={"title": "TEST_showcase",
                               "description": "from tests",
                               "category": "demo"},
                         headers=admin_headers, timeout=60)
        assert r.status_code == 200, r.text
        item = r.json()
        assert item["title"] == "TEST_showcase"
        assert item["category"] == "demo"
        assert item["width"] == 160 and item["height"] == 160
        assert item["frames"] == 20
        assert "id" in item
        showcase_ctx["id"] = item["id"]

    def test_list_showcase_public(self, session, showcase_ctx):
        r = requests.get(f"{API}/showcase")  # no auth
        assert r.status_code == 200
        items = r.json()
        assert any(it["id"] == showcase_ctx["id"] for it in items)

    def test_showcase_file_bytes(self, session, svga_bytes, showcase_ctx):
        r = requests.get(f"{API}/showcase/{showcase_ctx['id']}/file")
        assert r.status_code == 200
        assert r.content == svga_bytes

    def test_delete_showcase(self, session, admin_headers, showcase_ctx):
        r = session.delete(f"{API}/admin/showcase/{showcase_ctx['id']}",
                           headers=admin_headers)
        assert r.status_code == 200
        # After soft delete should not appear
        r2 = requests.get(f"{API}/showcase")
        assert all(it["id"] != showcase_ctx["id"] for it in r2.json())
        # File endpoint should now 404
        r3 = requests.get(f"{API}/showcase/{showcase_ctx['id']}/file")
        assert r3.status_code == 404


# ---------------- faq ----------------


@pytest.fixture(scope="class")
def faq_ctx():
    return {"id": None}


class TestFaq:
    def test_create_faq_admin(self, session, admin_headers, faq_ctx):
        r = session.post(f"{API}/admin/faq",
                         json={"question": "TEST_Q?", "answer": "TEST_A.", "order": 99},
                         headers=admin_headers)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["question"] == "TEST_Q?"
        assert "id" in data
        faq_ctx["id"] = data["id"]

    def test_list_faq_public(self, faq_ctx):
        r = requests.get(f"{API}/faq")
        assert r.status_code == 200
        assert any(f["id"] == faq_ctx["id"] for f in r.json())

    def test_delete_faq(self, session, admin_headers, faq_ctx):
        r = session.delete(f"{API}/admin/faq/{faq_ctx['id']}", headers=admin_headers)
        assert r.status_code == 200
        r2 = requests.get(f"{API}/faq")
        assert all(f["id"] != faq_ctx["id"] for f in r2.json())

    def test_faq_admin_requires_auth(self):
        r = requests.post(f"{API}/admin/faq", json={"question": "q", "answer": "a"})
        assert r.status_code in (401, 403)


# ---------------- stats ----------------


class TestStats:
    def test_public_stats_increased(self, session, svga_bytes):
        before = requests.get(f"{API}/stats").json()
        # Trigger a preview & a conversion
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        session.post(f"{API}/preview/info", files=files)
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        session.post(f"{API}/convert/svga-to-json", files=files, timeout=60)
        time.sleep(0.5)
        after = requests.get(f"{API}/stats").json()
        assert after["previews"] >= before["previews"] + 1
        assert after["conversions"] >= before["conversions"] + 1
        assert isinstance(after["showcase_count"], int)

    def test_admin_stats(self, session, admin_headers):
        r = session.get(f"{API}/admin/stats", headers=admin_headers)
        assert r.status_code == 200
        s = r.json()
        for k in ("previews", "conversions", "users", "showcase_count",
                  "faq_count", "conversion_breakdown"):
            assert k in s
        assert isinstance(s["conversion_breakdown"], dict)
