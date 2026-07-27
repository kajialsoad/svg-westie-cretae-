"""Tests for new features: layer editor, alpha video conversions, async jobs (mp4-to-svga, svga-export).

Covers /api/svga/layers, /api/convert/svga-to-alpha-webm, /api/convert/svga-to-alpha-mov,
/api/jobs/mp4-to-svga (sync + AI bg-removal), /api/jobs/svga-export (multiple targets),
/api/jobs/{id}/status and /api/jobs/{id}/result.
"""
import io
import os
import json
import time
import pytest
import requests
from dotenv import load_dotenv

load_dotenv("/app/frontend/.env")
BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

SAMPLE_SVGA = "/tmp/sample.svga"
SAMPLE_MP4 = "/tmp/clip.mp4"


@pytest.fixture(scope="module")
def svga_bytes():
    with open(SAMPLE_SVGA, "rb") as f:
        return f.read()


@pytest.fixture(scope="module")
def mp4_bytes():
    with open(SAMPLE_MP4, "rb") as f:
        return f.read()


def _poll(job_id, timeout=180, interval=2.5):
    """Poll a job until done. Returns final status dict."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        r = requests.get(f"{API}/jobs/{job_id}/status", timeout=30)
        assert r.status_code == 200, f"status http {r.status_code}: {r.text}"
        last = r.json()
        if last["status"] == "done":
            return last
        if last["status"] == "error":
            raise AssertionError(f"job errored: {last.get('error')}")
        time.sleep(interval)
    raise AssertionError(f"job timed out after {timeout}s, last status={last}")


# ---------------- layer editor ----------------

class TestLayers:
    def test_layers_endpoint_returns_layer_metadata(self, svga_bytes):
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        r = requests.post(f"{API}/svga/layers", files=files, timeout=60)
        assert r.status_code == 200, r.text
        m = r.json()
        # Basic shape
        for k in ("width", "height", "fps", "frames", "layerCount", "layers"):
            assert k in m, f"missing {k}"
        assert m["width"] == 160
        assert m["height"] == 160
        assert m["frames"] == 20
        assert isinstance(m["layers"], list)
        assert m["layerCount"] == len(m["layers"])
        assert m["layerCount"] >= 1
        first = m["layers"][0]
        for k in ("index", "imageKey", "thumb", "visibleFrames", "frameCount"):
            assert k in first, f"missing layer key {k}"
        # thumb should be a data URI (may be None if image decode fails, but here we expect data)
        assert first["thumb"] is None or first["thumb"].startswith("data:image/png;base64,")
        assert first["frameCount"] == m["frames"]
        assert isinstance(first["visibleFrames"], int)

    def test_layers_rejects_garbage(self):
        files = {"file": ("bad.svga", b"not-an-svga", "application/octet-stream")}
        r = requests.post(f"{API}/svga/layers", files=files, timeout=30)
        assert r.status_code == 400


# ---------------- sync alpha video conversions ----------------

class TestAlphaVideoSync:
    def test_svga_to_alpha_webm(self, svga_bytes):
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        r = requests.post(f"{API}/convert/svga-to-alpha-webm", files=files, timeout=120)
        assert r.status_code == 200, r.text[:300]
        assert "video/webm" in r.headers.get("content-type", "")
        body = r.content
        assert len(body) > 200
        # WebM magic (EBML header)
        assert body[:4] == b"\x1a\x45\xdf\xa3", f"not a webm file, header={body[:4].hex()}"
        cd = r.headers.get("content-disposition", "")
        assert ".webm" in cd

    def test_svga_to_alpha_mov(self, svga_bytes):
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        r = requests.post(f"{API}/convert/svga-to-alpha-mov", files=files, timeout=120)
        assert r.status_code == 200, r.text[:300]
        assert "video/quicktime" in r.headers.get("content-type", "")
        body = r.content
        assert len(body) > 500
        # QuickTime/MOV: first bytes are size then 'ftyp' or 'moov' or 'mdat' at offset 4
        assert body[4:8] in (b"ftyp", b"moov", b"mdat", b"wide", b"free"), \
            f"not a mov file, atom={body[4:8]!r}"
        cd = r.headers.get("content-disposition", "")
        assert ".mov" in cd


# ---------------- async job: mp4 -> svga ----------------

class TestJobMp4ToSvga:
    def test_mp4_to_svga_no_bg_removal(self, mp4_bytes):
        files = {"file": ("clip.mp4", mp4_bytes, "video/mp4")}
        data = {"remove_bg": "false", "preset": "balanced"}
        r = requests.post(f"{API}/jobs/mp4-to-svga", files=files, data=data, timeout=60)
        assert r.status_code == 200, r.text
        sub = r.json()
        assert sub["status"] == "processing"
        assert isinstance(sub["job_id"], str) and len(sub["job_id"]) > 8

        final = _poll(sub["job_id"], timeout=180)
        assert final["status"] == "done"
        assert final.get("ext") == "svga"
        size = final.get("size")
        assert isinstance(size, int) and size > 0
        assert size < 5 * 1024 * 1024, f"result {size} bytes exceeds 5MB"

        # Fetch result
        rr = requests.get(f"{API}/jobs/{sub['job_id']}/result", timeout=60)
        assert rr.status_code == 200
        assert "application/octet-stream" in rr.headers.get("content-type", "")
        body = rr.content
        assert len(body) == size
        # Valid SVGA should be zlib-compressed protobuf
        import zlib
        try:
            zlib.decompress(body)
        except zlib.error:
            pytest.fail("result is not a valid zlib-compressed SVGA")

    def test_mp4_to_svga_with_bg_removal(self, mp4_bytes):
        """Slow path — allow up to ~180s. Uses rembg u2net per frame."""
        files = {"file": ("clip.mp4", mp4_bytes, "video/mp4")}
        data = {"remove_bg": "true", "preset": "small"}  # small preset to keep it fast
        r = requests.post(f"{API}/jobs/mp4-to-svga", files=files, data=data, timeout=60)
        assert r.status_code == 200, r.text
        sub = r.json()
        assert sub["status"] == "processing"
        final = _poll(sub["job_id"], timeout=240)
        assert final["status"] == "done"
        size = final["size"]
        assert size < 5 * 1024 * 1024

        rr = requests.get(f"{API}/jobs/{sub['job_id']}/result", timeout=60)
        assert rr.status_code == 200
        # sanity check content
        import zlib
        zlib.decompress(rr.content)


# ---------------- async job: svga-export with edits ----------------

class TestJobSvgaExport:
    def _submit(self, svga_bytes, edits, target):
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        data = {"edits": json.dumps(edits), "target": target}
        r = requests.post(f"{API}/jobs/svga-export", files=files, data=data, timeout=60)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["status"] == "processing"
        return j["job_id"]

    def test_export_alpha_webm_with_layer_edits(self, svga_bytes):
        # Get layer count first
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        lr = requests.post(f"{API}/svga/layers", files=files, timeout=30).json()
        assert lr["layerCount"] >= 1
        edits = {"0": {"visible": False, "opacity": 0.5, "scale": 1.2, "dx": 10, "dy": 0, "order": 0}}
        job_id = self._submit(svga_bytes, edits, "alpha-webm")
        final = _poll(job_id, timeout=180)
        assert final["status"] == "done"
        assert final["ext"] == "webm"
        rr = requests.get(f"{API}/jobs/{job_id}/result", timeout=60)
        assert rr.status_code == 200
        assert "video/webm" in rr.headers.get("content-type", "")
        assert rr.content[:4] == b"\x1a\x45\xdf\xa3"

    def test_export_gif(self, svga_bytes):
        job_id = self._submit(svga_bytes, {}, "gif")
        final = _poll(job_id, timeout=120)
        assert final["status"] == "done"
        assert final["ext"] == "gif"
        rr = requests.get(f"{API}/jobs/{job_id}/result", timeout=60)
        assert rr.status_code == 200
        assert "image/gif" in rr.headers.get("content-type", "")
        assert rr.content[:6] in (b"GIF87a", b"GIF89a")

    def test_export_mp4(self, svga_bytes):
        job_id = self._submit(svga_bytes, {}, "mp4")
        final = _poll(job_id, timeout=120)
        assert final["status"] == "done"
        assert final["ext"] == "mp4"
        rr = requests.get(f"{API}/jobs/{job_id}/result", timeout=60)
        assert rr.status_code == 200
        assert "video/mp4" in rr.headers.get("content-type", "")
        # mp4 ftyp atom
        assert rr.content[4:8] == b"ftyp"

    def test_bad_job_id_returns_404(self):
        r = requests.get(f"{API}/jobs/nonexistent_job_id_xxx/status", timeout=30)
        assert r.status_code == 404
        r2 = requests.get(f"{API}/jobs/nonexistent_job_id_xxx/result", timeout=30)
        assert r2.status_code == 404


# ---------------- stats increments for new conversions ----------------

class TestStatsIncrement:
    def test_alpha_conversion_bumps_counter(self, svga_bytes):
        before = requests.get(f"{API}/stats", timeout=30).json()
        files = {"file": ("sample.svga", svga_bytes, "application/octet-stream")}
        r = requests.post(f"{API}/convert/svga-to-alpha-webm", files=files, timeout=120)
        assert r.status_code == 200
        time.sleep(0.4)
        after = requests.get(f"{API}/stats", timeout=30).json()
        assert after["conversions"] >= before["conversions"] + 1
