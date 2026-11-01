"""Gateway tests with fake upstreams (httpx.MockTransport): routing, fallback, auth, path safety.

Run: C:\\Python314\\python.exe -m pytest tests -q
"""
import json
import os
import sys

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import app as gateway  # noqa: E402
from core import backends, library, local_runtime  # noqa: E402


def sse(*chunks):
    body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    return httpx.Response(200, content=body.encode(), headers={"content-type": "text/event-stream"})


class Upstreams:
    """Routes fake HTTP calls by host: 127.0.0.1:8080 is the local llama-server, others are remotes."""

    def __init__(self):
        self.calls = []
        self.remote_down = False
        self.local_models = ["local-model"]

    def __call__(self, request: httpx.Request):
        self.calls.append((request.url.host, request.url.port, request.url.path, request.headers.get("authorization")))
        remote = request.url.host != "127.0.0.1"
        if remote and self.remote_down and request.url.path.endswith("/chat/completions"):
            raise httpx.ConnectError("tunnel coupé", request=request)
        if request.url.path == "/v1/models":
            ids = ["big-32b"] if remote else self.local_models
            return httpx.Response(200, json={"data": [{"id": i} for i in ids]})
        if request.url.path == "/props":
            return httpx.Response(200, json={"model_path": r"D:\fake\local-model.gguf"})
        if request.url.path == "/v1/chat/completions":
            payload = json.loads(request.content)
            who = "remote" if remote else "local"
            if payload.get("stream"):
                return sse({"choices": [{"delta": {"content": who}}]}, {"usage": {"completion_tokens": 7}})
            return httpx.Response(200, json={"choices": [{"message": {"content": who}}], "usage": {"completion_tokens": 3}, "model": payload.get("model")})
        return httpx.Response(404)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(backends, "STORE", str(tmp_path / "backends.json"))
    monkeypatch.setattr(library, "MODEL_DIRS", [str(tmp_path / "models")])
    monkeypatch.setattr(library, "list_cloud", lambda max_age=60.0: ([], None))
    os.makedirs(tmp_path / "models")
    backends._backends.clear()
    up = Upstreams()

    async def no_swap(client, path):
        return 0.0

    monkeypatch.setattr(local_runtime, "ensure_loaded", no_swap)
    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(up)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(gateway.httpx, "AsyncClient", fake_client)
    with TestClient(gateway.app) as client:
        yield client, up, tmp_path


KEY = {"X-Mazz-Key": gateway.CONTROL_KEY}


def test_mutating_api_requires_key(env):
    client, _, _ = env
    assert client.post("/api/backends", json={}).status_code == 401
    assert client.post("/api/backends", json={}, headers={"X-Mazz-Key": "faux"}).status_code == 401


def test_foreign_host_is_refused(env):
    client, _, _ = env
    assert client.get("/api/quota", headers={"host": "evil.example:7070"}).status_code == 403


def test_explicit_backend_prefix_routes_remote_with_its_key(env):
    client, up, _ = env
    r = client.post("/api/backends", headers=KEY, json={"id": "colab-a100", "kind": "colab", "base_url": "https://x.trycloudflare.com/v1", "api_key": "k-123"})
    assert r.status_code == 200 and r.json()["backend"]["healthy"] is True
    assert "api_key" not in r.json()["backend"]
    r = client.post("/v1/chat/completions", json={"model": "colab-a100/big-32b", "messages": []})
    assert r.status_code == 200
    assert r.json()["choices"][0]["message"]["content"] == "remote"
    assert r.json()["model"] == "big-32b"
    assert r.headers["x-mazz-backend"] == "colab-a100"
    assert ("x.trycloudflare.com", None, "/v1/chat/completions", "Bearer k-123") in up.calls


def test_bare_model_served_remotely_is_routed_there(env):
    client, _, _ = env
    client.post("/api/backends", headers=KEY, json={"id": "kaggle-t4", "kind": "kaggle", "base_url": "https://k.trycloudflare.com"})
    r = client.post("/v1/chat/completions", json={"model": "big-32b", "messages": []})
    assert r.headers["x-mazz-backend"] == "kaggle-t4"


def test_remote_failure_falls_back_to_local_and_says_so(env):
    client, up, _ = env
    client.post("/api/backends", headers=KEY, json={"id": "colab-a100", "kind": "colab", "base_url": "https://x.trycloudflare.com"})
    up.remote_down = True
    r = client.post("/v1/chat/completions", json={"model": "colab-a100/big-32b", "stream": True, "messages": []})
    assert r.status_code == 200
    assert r.headers["x-mazz-backend"] == "local"
    assert r.headers["x-mazz-fallback"].startswith("colab-a100")
    assert '"local"' in r.text and "[DONE]" in r.text


def test_unknown_model_is_404_and_too_big_local_model_is_409(env, monkeypatch):
    client, _, tmp = env
    assert client.post("/v1/chat/completions", json={"model": "inexistant", "messages": []}).status_code == 404
    (tmp / "models" / "Huge-70B.Q4_K_M.gguf").write_bytes(b"GGUF")
    monkeypatch.setattr(library, "fit_for_local", lambda size, total_ram=None: {"ram_needed_bytes": 40 * 1024**3, "fits_local": False})
    r = client.post("/v1/chat/completions", json={"model": "Huge-70B.Q4_K_M", "messages": []})
    assert r.status_code == 409 and "cloud" in r.json()["error"]["message"]


def test_local_model_by_name_is_routed_locally(env):
    client, _, tmp = env
    (tmp / "models" / "local-model.gguf").write_bytes(b"GGUF")
    r = client.post("/v1/chat/completions", json={"model": "local-model", "messages": []})
    assert r.status_code == 200 and r.headers["x-mazz-backend"] == "local"


def test_upload_hf_and_delete_never_accept_a_path(env):
    client, _, _ = env
    for route in ("/api/models/upload-hf", "/api/models/delete"):
        r = client.post(route, headers=KEY, json={"filename": r"..\..\Windows\win.ini", "filepath": r"C:\Windows\win.ini"})
        assert r.status_code == 404


def test_dashboard_escapes_and_embeds_key_only_in_page(env):
    client, _, _ = env
    html = client.get("/").text
    assert gateway.CONTROL_KEY in html
    assert "tr.innerHTML" not in html
