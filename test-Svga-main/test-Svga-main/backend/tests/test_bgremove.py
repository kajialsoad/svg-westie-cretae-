"""Background remover tests: image (sync) + video (async) + stats counters."""
import io
import os
import time

import pytest
import requests
from PIL import Image
from dotenv import load_dotenv

load_dotenv("/app/frontend/.env")
BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"


# ---------- helpers ----------
def _png_bytes(size=(120, 120), color=(220, 80, 30, 255)):
    im = Image.new("RGBA", size, color)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def _jpg_bytes(size=(160, 120), color=(40, 120, 200)):
    im = Image.new("RGB", size, color)
    buf = io.BytesIO()
    im.save(buf, format="JPEG")
    return buf.getvalue()


def _short_mp4(path, duration=2, fps=8):
    """Use ffmpeg via imageio_ffmpeg to make a tiny color mp4."""
    import subprocess
    import imageio_ffmpeg
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run(
        [ff, "-y", "-f", "lavfi", "-i",
         f"color=c=red:s=160x120:d={duration}:r={fps}",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", path],
        check=True, capture_output=True, timeout=30,
    )


@pytest.fixture(scope="module")
def png_bg_target():
    return _png_bytes()


@pytest.fixture(scope="module")
def jpg_bg_replacement():
    return _jpg_bytes(color=(20, 200, 80))


@pytest.fixture(scope="module")
def short_mp4_path(tmp_path_factory):
    p = tmp_path_factory.mktemp("bg") / "tiny.mp4"
    _short_mp4(str(p))
    assert p.stat().st_size > 100
    return str(p)


# ---------- image (sync) ----------
class TestBgImage:
    def test_transparent(self, png_bg_target):
        files = {"file": ("in.png", png_bg_target, "image/png")}
        r = requests.post(f"{API}/bg/image", files=files,
                          data={"mode": "transparent"}, timeout=120)
        assert r.status_code == 200, r.text[:300]
        assert "image/png" in r.headers.get("content-type", "")
        out = Image.open(io.BytesIO(r.content))
        assert out.mode == "RGBA"
        # at least one transparent pixel expected (background removed)
        alphas = set(out.getdata(band=3))
        assert min(alphas) < 255, "expected some transparency"

    def test_color_mode(self, png_bg_target):
        files = {"file": ("in.png", png_bg_target, "image/png")}
        r = requests.post(f"{API}/bg/image", files=files,
                          data={"mode": "color", "color": "#10B981"}, timeout=120)
        assert r.status_code == 200, r.text[:300]
        assert "image/png" in r.headers.get("content-type", "")
        im = Image.open(io.BytesIO(r.content))
        assert im.size == (120, 120)

    def test_image_mode_with_background(self, png_bg_target, jpg_bg_replacement):
        files = {
            "file": ("in.png", png_bg_target, "image/png"),
            "background": ("bg.jpg", jpg_bg_replacement, "image/jpeg"),
        }
        r = requests.post(f"{API}/bg/image", files=files,
                          data={"mode": "image"}, timeout=120)
        assert r.status_code == 200, r.text[:300]
        assert "image/png" in r.headers.get("content-type", "")
        im = Image.open(io.BytesIO(r.content))
        assert im.size == (120, 120)


# ---------- video (async) ----------
def _poll(job_id, timeout=120, interval=3):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        r = requests.get(f"{API}/bg/video/status/{job_id}", timeout=30)
        assert r.status_code == 200, r.text
        last = r.json()
        if last["status"] in ("done", "error"):
            return last
        time.sleep(interval)
    return last


class TestBgVideo:
    def test_transparent_webm(self, short_mp4_path):
        with open(short_mp4_path, "rb") as f:
            files = {"file": ("tiny.mp4", f.read(), "video/mp4")}
        r = requests.post(f"{API}/bg/video/submit", files=files,
                          data={"mode": "transparent"}, timeout=60)
        assert r.status_code == 200, r.text
        jid = r.json()["job_id"]
        assert r.json()["status"] == "processing"

        final = _poll(jid, timeout=150)
        assert final and final["status"] == "done", f"poll result: {final}"
        assert final.get("ext") == "webm"

        rr = requests.get(f"{API}/bg/video/result/{jid}", timeout=60)
        assert rr.status_code == 200
        assert "video/webm" in rr.headers.get("content-type", "")
        assert len(rr.content) > 500

    def test_color_mp4(self, short_mp4_path):
        with open(short_mp4_path, "rb") as f:
            files = {"file": ("tiny.mp4", f.read(), "video/mp4")}
        r = requests.post(f"{API}/bg/video/submit", files=files,
                          data={"mode": "color", "color": "#10B981"}, timeout=60)
        assert r.status_code == 200, r.text
        jid = r.json()["job_id"]
        final = _poll(jid, timeout=150)
        assert final and final["status"] == "done", f"poll result: {final}"
        assert final.get("ext") == "mp4"

        rr = requests.get(f"{API}/bg/video/result/{jid}", timeout=60)
        assert rr.status_code == 200
        assert "video/mp4" in rr.headers.get("content-type", "")
        assert len(rr.content) > 500

    def test_status_404_unknown(self):
        r = requests.get(f"{API}/bg/video/status/nope-abc", timeout=20)
        assert r.status_code == 404


# ---------- stats counters ----------
class TestBgStats:
    def test_stats_has_bg_counters(self):
        r = requests.get(f"{API}/stats", timeout=20)
        assert r.status_code == 200
        s = r.json()
        assert "bg_images" in s and isinstance(s["bg_images"], int)
        assert "bg_videos" in s and isinstance(s["bg_videos"], int)
        # After prior tests we expect non-zero
        assert s["bg_images"] >= 1
        assert s["bg_videos"] >= 1


# ---------- SVGA regression ----------
class TestSvgaRegression:
    def test_admin_login(self):
        r = requests.post(f"{API}/auth/login",
                          json={"email": "admin@svga.dev", "password": "admin123"},
                          timeout=30)
        assert r.status_code == 200
        assert r.json()["user"]["role"] == "admin"

    def test_preview_info(self):
        import sys
        sys.path.insert(0, "/app/backend")
        import svga_codec
        from PIL import Image, ImageDraw
        frames = []
        for i in range(24):
            im = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
            ImageDraw.Draw(im).ellipse([20 + i, 20, 180, 180], fill=(255, 100, 50, 255))
            frames.append(im)
        data = svga_codec.encode(frames, fps=24)
        with open("/tmp/sample.svga", "wb") as f:
            f.write(data)
        files = {"file": ("sample.svga", data, "application/octet-stream")}
        r = requests.post(f"{API}/preview/info", files=files, timeout=30)
        assert r.status_code == 200
        m = r.json()
        assert m["width"] == 200 and m["height"] == 200
        assert m["frames"] == 24 and m["fps"] == 24
