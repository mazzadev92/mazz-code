"""Gateway tests with fake upstreams (httpx.MockTransport): routing, fallback, auth, path safety.

Run: C:\\Python314\\python.exe -m pytest tests -q
"""
import json
import os
import sys
import time

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
        self.payloads = []  # JSON bodies sent to /v1/chat/completions
        self.usage = {"prompt_tokens": 11}  # usage reported by chat answers, None = no usage at all
        self.remote_down = False
        self.remote_status = None  # HTTP status the remote answers chat requests with, None = 200
        self.local_stream_break = False  # local stream dies after its first chunk
        self.local_models = ["local-model"]
        self.draft_down = False  # nothing listens on 127.0.0.1:8081
        self.finish_reason = None  # finish_reason of chat answers ("length" = max_tokens reached)

    def __call__(self, request: httpx.Request):
        self.calls.append((request.url.host, request.url.port, request.url.path, request.headers.get("authorization")))
        remote = request.url.host != "127.0.0.1"
        if self.draft_down and request.url.port == 8081:
            raise httpx.ConnectError("8081 arrêté", request=request)
        if remote and self.remote_down and request.url.path.endswith("/chat/completions"):
            raise httpx.ConnectError("tunnel coupé", request=request)
        if remote and self.remote_status and request.url.path.endswith("/chat/completions"):
            return httpx.Response(self.remote_status, json={"error": {"message": f"HTTP {self.remote_status}"}})
        if not remote and self.local_stream_break and request.url.path == "/v1/chat/completions":
            async def broken():
                yield f"data: {json.dumps({'choices': [{'delta': {'content': 'debut'}}]})}\n\n".encode()
                raise httpx.ReadError("llama-server coupé", request=request)
            return httpx.Response(200, content=broken(), headers={"content-type": "text/event-stream"})
        if request.url.path == "/v1/models":
            ids = ["big-32b"] if remote else self.local_models
            return httpx.Response(200, json={"data": [{"id": i} for i in ids]})
        if request.url.path == "/props":
            return httpx.Response(200, json={"model_path": r"D:\fake\local-model.gguf"})
        if request.url.path == "/v1/chat/completions":
            payload = json.loads(request.content)
            self.payloads.append(payload)
            who = "remote" if remote else "local"
            if payload.get("stream"):
                tail = [{"choices": [], "usage": {**self.usage, "completion_tokens": 7}}] if self.usage is not None else []
                end = [{"choices": [{"delta": {}, "finish_reason": self.finish_reason}]}] if self.finish_reason else []
                return sse({"choices": [{"delta": {"content": who}}]}, *end, *tail)
            body = {"choices": [{"message": {"content": who}, "finish_reason": self.finish_reason}], "model": payload.get("model")}
            if self.usage is not None:
                body["usage"] = {**self.usage, "completion_tokens": 3}
            return httpx.Response(200, json=body)
        return httpx.Response(404)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(backends, "STORE", str(tmp_path / "backends.json"))
    monkeypatch.setattr(library, "MODEL_DIRS", [str(tmp_path / "models")])
    monkeypatch.setattr(library, "list_cloud", lambda max_age=60.0: ([], None))
    monkeypatch.setattr(gateway, "get_hf_token", lambda: None)  # no announcement polling against the real repo
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
        # Inference routes require the control key, as Claude Code and the Studio send it.
        client.headers["x-api-key"] = gateway.CONTROL_KEY
        yield client, up, tmp_path


KEY = {"X-Mazz-Key": gateway.CONTROL_KEY}


def test_mutating_api_requires_key(env):
    client, _, _ = env
    assert client.post("/api/backends", json={}).status_code == 401
    assert client.post("/api/backends", json={}, headers={"X-Mazz-Key": "faux"}).status_code == 401


def test_desktop_shutdown_is_hidden_without_its_token(env, monkeypatch):
    client, _, _ = env
    monkeypatch.delenv("MAZZ_DESKTOP_TOKEN", raising=False)
    assert client.post("/api/desktop/shutdown").status_code == 404


def test_desktop_shutdown_requires_the_desktop_token_and_asks_for_sigint(env, monkeypatch):
    client, _, _ = env
    monkeypatch.setenv("MAZZ_DESKTOP_TOKEN", "jeton-de-bureau")
    assert client.post("/api/desktop/shutdown", headers={"x-mazz-desktop-token": "faux"}).status_code == 403
    # The control key is never a substitute for the desktop token.
    assert client.post("/api/desktop/shutdown", headers={"X-Mazz-Key": gateway.CONTROL_KEY}).status_code == 403

    asked = []
    monkeypatch.setattr(gateway, "_desktop_exit", lambda: asked.append(True))
    accepted = client.post("/api/desktop/shutdown", headers={"x-mazz-desktop-token": "jeton-de-bureau"})
    assert accepted.status_code == 202
    assert accepted.json() == {"ok": True, "stopping": True}
    time.sleep(0.5)
    assert asked == [True]


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
    monkeypatch.setattr(library, "fit_for_local", lambda size, total_ram=None, compactor_bytes=None: {"ram_needed_bytes": 40 * 1024**3, "fits_local": False})
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


def test_dashboard_escapes_and_never_embeds_the_master_key(env):
    client, _, _ = env
    client.cookies.clear()
    html = client.get("/").text
    assert gateway.CONTROL_KEY not in html
    assert "tr.innerHTML" not in html
    assert client.cookies.get("mazz_session")
    # Without the cookie or the header, a mutation is refused; the cookie alone authorizes it.
    client.headers.pop("x-api-key", None)
    client.cookies.clear()
    assert client.post("/api/backends", json={}).status_code == 401
    client.get("/")
    assert client.post("/api/backends", json={}).status_code != 401


def test_announcements_register_runtime_and_withdrawal_removes_it(env):
    # Arrange
    client, _, _ = env
    announced = [{"id": "colab-a100", "kind": "colab", "base_url": "https://a.trycloudflare.com", "api_key": "k", "expires_at": 4102444800}]
    # Act
    backends.sync_announcements(announced)
    listed_while_up = [b["id"] for b in client.get("/api/backends").json()]
    backends.sync_announcements([])
    listed_after = [b["id"] for b in client.get("/api/backends").json()]
    # Assert
    assert "colab-a100" in listed_while_up
    assert "colab-a100" not in listed_after


def test_expired_announcement_is_ignored(env):
    # Arrange
    old = [{"id": "kaggle-t4", "kind": "kaggle", "base_url": "https://k.trycloudflare.com", "expires_at": 1}]
    # Act
    seen = backends.sync_announcements(old)
    # Assert
    assert seen == [] and backends.get("kaggle-t4") is None


def test_quotas_reports_each_source_with_provenance_and_errors_without_guessing(env, monkeypatch):
    # Arrange
    from core import quotas
    client, _, _ = env
    monkeypatch.setattr(quotas, "_cache", {})
    monkeypatch.setattr(quotas, "SOURCES", {
        "modal": lambda: quotas._entry("modal", "Modal", "billing", used=1.5, limit=30.0, remaining=28.5),
        "colab": lambda: (_ for _ in ()).throw(RuntimeError("wsl absent")),
    })
    monkeypatch.setattr(quotas, "CACHE_SECONDS", {"modal": 60, "colab": 60})
    # Act
    body = client.get("/api/quotas").json()
    # Assert
    by_id = {s["id"]: s for s in body["sources"]}
    assert by_id["modal"]["status"] == "ok" and by_id["modal"]["remaining"] == 28.5 and by_id["modal"]["source"] == "billing"
    assert by_id["colab"]["status"] == "error" and "wsl absent" in by_id["colab"]["error"]
    assert "remaining" not in by_id["colab"]


def test_passive_backend_is_routed_without_any_health_probe(env):
    # Arrange
    client, up, _ = env
    # Act
    r = client.post("/api/backends", headers=KEY, json={"id": "modal-l40s", "kind": "modal", "base_url": "https://m.modal.run",
                                                       "api_key": "k", "models": ["mazz-coder-32b"], "passive": True})
    client.get("/api/backends")
    client.get("/v1/models")
    chat = client.post("/v1/chat/completions", json={"model": "modal-l40s/mazz-coder-32b", "messages": []})
    # Assert
    assert r.status_code == 200 and r.json()["backend"]["healthy"] is True
    assert not [c for c in up.calls if c[0] == "m.modal.run" and c[2] == "/v1/models"]
    assert chat.headers["x-mazz-backend"] == "modal-l40s"


def test_inference_requires_key_and_tunnel_never_sees_it(env):
    client, _, _ = env
    body = {"model": "x", "max_tokens": 8, "messages": [{"role": "user", "content": "hi"}]}
    anon = {"x-api-key": ""}
    assert client.post("/v1/messages", json=body, headers=anon).status_code == 401
    assert client.post("/v1/chat/completions", content="{}", headers={**anon, "content-type": "text/plain"}).status_code == 401
    assert client.post("/v1/messages/count_tokens", json=body, headers={"x-api-key": "", "authorization": f"Bearer {gateway.CONTROL_KEY}"}).status_code == 200
    assert gateway.CONTROL_KEY not in client.get("/").text
    assert gateway.CONTROL_KEY not in client.get("/", headers={"cf-connecting-ip": "203.0.113.9"}).text


def test_local_swap_happens_only_while_holding_the_local_slot(env, monkeypatch):
    client, _, tmp = env
    (tmp / "models" / "local-model.gguf").write_bytes(b"GGUF")
    held = []

    async def swap(client_, path):
        held.append(gateway._local_slot.locked())
        return 1.5

    monkeypatch.setattr(local_runtime, "ensure_loaded", swap)
    r = client.post("/v1/chat/completions", json={"model": "local-model", "messages": []})
    assert r.status_code == 200 and held == [True] and r.headers["x-mazz-swap-seconds"] == "1.5"


def test_fast_model_without_draft_server_never_reloads_local(env, monkeypatch):
    client, up, _ = env
    loads = []

    async def swap(client_, path):
        loads.append(path)
        return 0.0

    monkeypatch.setattr(local_runtime, "ensure_loaded", swap)
    up.draft_down = True
    r = client.post("/v1/messages", json={"model": "claude-haiku-4-5", "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 200 and r.headers["x-mazz-backend"] == "local" and loads == []


def test_local_length_finish_reports_max_tokens_and_keeps_a_real_budget(env):
    client, up, tmp = env
    (tmp / "models" / "local-model.gguf").write_bytes(b"GGUF")
    up.finish_reason = "length"
    body = {"model": "local-model", "max_tokens": 3000, "messages": [{"role": "user", "content": "écris"}]}
    r = client.post("/v1/messages", json=body)
    assert r.json()["stop_reason"] == "max_tokens" and up.payloads[-1]["max_tokens"] == 3000
    events = client.post("/v1/messages", json={**body, "stream": True}).text
    assert '"stop_reason": "max_tokens"' in events


def test_count_tokens_counts_tool_results_and_inputs(env):
    client, _, _ = env
    big = "x" * 30000
    body = {"model": "m", "messages": [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": big}]}]}]}
    assert client.post("/v1/messages/count_tokens", json=body).json()["input_tokens"] >= 10000


def test_bib1_context_goes_to_last_user_turn_not_system(env, monkeypatch):
    client, up, tmp = env
    (tmp / "models" / "local-model.gguf").write_bytes(b"GGUF")
    monkeypatch.setattr(gateway, "get_bib1_rag", lambda prompt, headers: ("[BIB1]", 1))
    client.post("/v1/messages", json={"model": "local-model", "system": "stable", "max_tokens": 8, "messages": [{"role": "user", "content": "comment marche l'api ?"}]})
    sent = up.payloads[-1]["messages"]
    assert sent[0] == {"role": "system", "content": "stable"} and "[BIB1]" in json.dumps(sent[-1])


def test_announcement_with_nonce_gets_the_notebook_key_without_publishing_it(monkeypatch):
    import hashlib
    import hmac
    import types
    token, nonce = "hf_test", "abcd"
    expected = hmac.new(token.encode(), f"mazz-backend:{nonce}".encode(), hashlib.sha256).hexdigest()
    assert backends.announced_key(token, nonce) == expected
    fake = types.SimpleNamespace(
        HfApi=lambda token: types.SimpleNamespace(list_repo_tree=lambda **kw: [types.SimpleNamespace(path="_backends/c1.json")]),
        hf_hub_download=None,
    )

    def download(repo, path, token, force_download):
        p = os.path.join(os.path.dirname(__file__), "..", "__pycache__", "nonce_announce.json")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"id": "c1", "kind": "colab", "base_url": "https://x.trycloudflare.com", "nonce": nonce}, f)
        return p

    fake.hf_hub_download = download
    monkeypatch.setitem(sys.modules, "huggingface_hub", fake)
    found = backends._fetch_announcements("repo", token)
    assert found[0]["api_key"] == expected


def test_gateway_script_start_registersEveryRouteBeforeServing():
    # Arrange: regression of the app.py split : a first `__main__` block started uvicorn before the Anthropic router was included.
    import re
    source = open(gateway.__file__, encoding="utf-8").read()
    main_blocks = [m.start() for m in re.finditer(r'^if __name__ == "__main__":', source, re.M)]
    include_positions = [m.start() for m in re.finditer(r"^app\.include_router\(", source, re.M)]
    # Act / Assert
    assert len(main_blocks) == 1 and all(pos < main_blocks[0] for pos in include_positions)


def _image_backend(client, **extra):
    from core import backends as _b
    _b.register("kaggle-t4", "kaggle", "https://img.trycloudflare.com", api_key="img-secret")
    with _b._lock:
        _b._backends["kaggle-t4"]["capabilities"] = ["image"]
        _b._backends["kaggle-t4"]["models"] = ["sdxl-turbo"]
        _b._backends["kaggle-t4"]["healthy"] = True
        _b._backends["kaggle-t4"]["checked_at"] = __import__("time").time()


def test_images_route_proxiesToImageBackendWithItsKey_andNeverLeaksIt(env, monkeypatch):
    client, up, _ = env
    seen = {}
    orig = Upstreams.__call__

    def handler(self, request):
        if request.url.path == "/v1/images/generations":
            seen["auth"], seen["body"] = request.headers.get("authorization"), json.loads(request.content)
            return httpx.Response(200, json={"created": 1, "data": [{"b64_json": "AAAA"}]})
        return orig(self, request)

    monkeypatch.setattr(Upstreams, "__call__", handler)
    _image_backend(client)
    r = client.post("/v1/images/generations", json={"model": "kaggle-t4/sdxl-turbo", "prompt": "leaf"})
    r2 = client.post("/v1/images/generations", json={"model": "sdxl-turbo", "prompt": "leaf"})
    assert r.status_code == 200, r.text
    assert r.json()["data"][0]["b64_json"] == "AAAA" and r2.status_code == 200
    assert seen["auth"] == "Bearer img-secret" and seen["body"]["model"] == "sdxl-turbo"
    assert "img-secret" not in r.text and "img-secret" not in json.dumps(dict(r.headers))


def test_images_route_noImageBackend_is404InFrench_andNeedsKey(env):
    client, _, _ = env
    r = client.post("/v1/images/generations", json={"prompt": "x"})
    assert r.status_code == 404 and "Aucun modele d'image en ligne" in r.json()["error"]["message"]
    assert client.post("/v1/images/generations", json={"prompt": "x"}, headers={"x-api-key": "faux"}).status_code == 401


def test_images_route_upstreamDown_is502(env, monkeypatch):
    client, _, _ = env
    orig = Upstreams.__call__

    def boom(self, request):
        if request.url.path == "/v1/images/generations":
            raise httpx.ConnectError("tunnel coupe", request=request)
        return orig(self, request)

    monkeypatch.setattr(Upstreams, "__call__", boom)
    _image_backend(client)
    assert client.post("/v1/images/generations", json={"model": "sdxl-turbo", "prompt": "x"}).status_code == 502


def test_announcement_capabilities_roundTripThroughSyncAndPublic(env):
    from core import backends as _b
    _b.sync_announcements([{"id": "kaggle-t4", "kind": "kaggle", "base_url": "https://i.trycloudflare.com", "api_key": "k", "capabilities": ["image"]}])
    pub = _b.public(_b.get("kaggle-t4"))
    assert pub["capabilities"] == ["image"] and "api_key" not in pub


def _media_backend(capability, model):
    from core import backends as _b
    _b.register("kaggle-t4", "kaggle", "https://media.trycloudflare.com", api_key="media-secret")
    with _b._lock:
        _b._backends["kaggle-t4"].update(capabilities=[capability], models=[model], healthy=True, checked_at=__import__("time").time())


MEDIA = [("/v1/videos/generations", "video", "wan21-1b", {"b64_mp4": "AAAA"}, "Aucun modele de video en ligne"),
         ("/v1/3d/generations", "3d", "triposr", {"b64_glb": "AAAA"}, "Aucun modele 3D en ligne")]


@pytest.mark.parametrize("path,cap,model,item,absent", MEDIA)
def test_media_routes_proxyWithBackendKey_neverLeakIt(env, monkeypatch, path, cap, model, item, absent):
    client, up, _ = env
    seen = {}
    orig = Upstreams.__call__

    def handler(self, request):
        if request.url.path == path:
            seen["auth"], seen["body"] = request.headers.get("authorization"), json.loads(request.content)
            return httpx.Response(200, json={"created": 1, "data": [item]})
        return orig(self, request)

    monkeypatch.setattr(Upstreams, "__call__", handler)
    _media_backend(cap, model)
    r = client.post(path, json={"model": f"kaggle-t4/{model}", "prompt": "leaf"})
    assert r.status_code == 200, r.text
    assert r.json()["data"][0] == item and seen["auth"] == "Bearer media-secret" and seen["body"]["model"] == model
    assert "media-secret" not in r.text and "media-secret" not in json.dumps(dict(r.headers))
    assert client.post(path, json={"prompt": "x"}, headers={"x-api-key": "faux"}).status_code == 401


@pytest.mark.parametrize("path,cap,model,item,absent", MEDIA)
def test_media_routes_noBackend_is404InFrench_andUpstreamDown_is502(env, monkeypatch, path, cap, model, item, absent):
    client, _, _ = env
    r = client.post(path, json={"prompt": "x"})
    assert r.status_code == 404 and absent in r.json()["error"]["message"]
    orig = Upstreams.__call__

    def boom(self, request):
        if request.url.path == path:
            raise httpx.ConnectError("tunnel coupe", request=request)
        return orig(self, request)

    monkeypatch.setattr(Upstreams, "__call__", boom)
    _media_backend(cap, model)
    assert client.post(path, json={"model": model, "prompt": "x"}).status_code == 502


def test_media_routes_useTheirTimeouts():
    import routes_videos, routes_3d
    assert routes_videos.TIMEOUT_S == 900.0 and routes_3d.TIMEOUT_S == 300.0
