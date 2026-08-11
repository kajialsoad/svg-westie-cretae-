"""Smoke test the running Node server: user panel, admin panel, token API."""
import json
import urllib.error
import urllib.request

BASE = "http://localhost:3000"
ADMIN_SECRET = "super-secure-admin-key-123"


def get(path, headers=None):
    req = urllib.request.Request(BASE + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return None, str(e).encode()


def post(path, body, headers=None):
    data = json.dumps(body).encode()
    h = {"Content-Type": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(BASE + path, data=data, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return None, str(e).encode()


checks = [
    ("USER  panel  /", "/"),
    ("ADMIN panel  /admin.html", "/admin.html"),
    ("ADMIN master /admin-panel/", "/admin-panel/"),
    ("TANVIR SPA   /tanvir-svga", "/tanvir-svga"),
]
for label, path in checks:
    status, body = get(path)
    print(f"{label:32s} -> {status}  {len(body)} bytes")

status, body = get("/api/admin/tokens", {"x-admin-secret": ADMIN_SECRET})
print(f"{'ADMIN API  /api/admin/tokens':32s} -> {status}  {body[:120]!r}")

status, body = get("/api/admin/tokens", {"x-admin-secret": "wrong"})
print(f"{'ADMIN API  wrong secret':32s} -> {status} (401 expected)")

status, body = get("/api/health")
print(f"{'API without token':32s} -> {status} (401 expected)")
