"""MAZZ Control: sovereign gateway between the Studio and every model the user owns.

/v1/*      OpenAI-compatible API. The `model` field picks where the request runs:
             "<backend>/<model>"  explicit backend (kaggle-t4/..., colab-a100/..., an API backend)
             "<model>"            a healthy remote backend serving it, else the local GGUF of that name
                                  (llama-server is switched to it when another model is loaded)
           A remote failure before the first byte falls back to the local server; the response says so in
           the X-Mazz-Fallback header. Nothing is silent and no metric is invented.
/api/*     Dashboard and Studio API. Mutating routes require the X-Mazz-Key header
           (%USERPROFILE%\\.mazz\\control.key); the dashboard page receives it from the server.
"""
import asyncio
import json
import os
import re
import secrets
import sys
import time
import uuid
from contextlib import asynccontextmanager

import httpx
from fastapi import BackgroundTasks, FastAPI, File, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from jinja2 import Environment, FileSystemLoader, select_autoescape
from starlette.background import BackgroundTask

sys.path.insert(0, os.path.dirname(__file__))
from core import backends, library, local_runtime, quotas  # noqa: E402
from core.hf_sync import REPO_ID, get_hf_token, upload_model_to_hf  # noqa: E402
from core.quota_db import (  # noqa: E402
    check_inactivity_timeouts, get_active_session, get_quota_status, init_db,
    register_session_start, register_session_stop, update_session_activity,
)

PORT = int(os.environ.get("MAZZ_PORT", "7070"))
KEY_FILE = os.path.expandvars(r"%USERPROFILE%\.mazz\control.key")
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}", "testserver"}
ALLOWED_ORIGINS = [f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}", "http://127.0.0.1:3333", "http://127.0.0.1:5173", "http://localhost:5173"]
GGUF_NAME = re.compile(r"^[A-Za-z0-9._-]+\.gguf$")
# Long generations on CPU: no read timeout shorter than ten minutes.
UPSTREAM_TIMEOUT = httpx.Timeout(connect=10.0, read=600.0, write=60.0, pool=10.0)
REMOTE_PRIORITY = {"colab": 0, "kaggle": 1, "modal": 2, "api": 3}
ANNOUNCE_PERIOD = 30


def load_control_key():
    try:
        with open(KEY_FILE, "r", encoding="utf-8") as f:
            key = f.read().strip()
            if key:
                return key
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(KEY_FILE), exist_ok=True)
    key = secrets.token_urlsafe(32)
    with open(KEY_FILE, "w", encoding="utf-8") as f:
        f.write(key)
    return key


CONTROL_KEY = load_control_key()


@asynccontextmanager
async def lifespan(app):
    init_db()
    backends.init(local_runtime.base_url())
    # follow_redirects: Modal answers a request still running after 150 s with 303 to its result URL.
    app.state.http = httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT, follow_redirects=True)
    poller = asyncio.create_task(poll_announcements())
    yield
    poller.cancel()
    await app.state.http.aclose()


async def poll_announcements():
    """GPU notebooks announce their tunnel in the private repo; picked up every ANNOUNCE_PERIOD seconds."""
    while True:
        token = get_hf_token()
        if token:
            try:
                found = await asyncio.to_thread(backends._fetch_announcements, REPO_ID, token)
                backends.sync_announcements(found)
            except Exception as exc:
                print("Annonces cloud illisibles :", exc, flush=True)
        await asyncio.sleep(ANNOUNCE_PERIOD)


app = FastAPI(title="MAZZ CONTROL", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type", "Authorization", "X-Mazz-Key"],
)
jinja_env = Environment(loader=FileSystemLoader(os.path.join(os.path.dirname(__file__), "templates")), autoescape=select_autoescape(["html"]))


@app.middleware("http")
async def guard(request: Request, call_next):
    # DNS rebinding: a page on another domain resolving to 127.0.0.1 still sends its own Host.
    if request.headers.get("host", "") not in ALLOWED_HOSTS:
        return JSONResponse({"error": "Hôte refusé"}, status_code=403)
    if request.url.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        if not secrets.compare_digest(request.headers.get("x-mazz-key", ""), CONTROL_KEY):
            return JSONResponse({"error": "Clé X-Mazz-Key absente ou invalide (voir %USERPROFILE%\\.mazz\\control.key)"}, status_code=401)
    return await call_next(request)


def http(request: Request) -> httpx.AsyncClient:
    return request.app.state.http


# ------------------------------------------------------------------ dashboard

@app.get("/", response_class=HTMLResponse)
def index_page():
    return jinja_env.get_template("index.html").render(control_key=(CONTROL_KEY or ""))


@app.get("/api/quota")
def api_quota():
    check_inactivity_timeouts()
    return get_quota_status()


@app.get("/api/session/status")
async def api_session_status(request: Request):
    check_inactivity_timeouts()
    local = backends.get("local")
    await backends.probe(http(request), local)
    sess = get_active_session()
    remote = None
    if sess and sess.get("status") == "running":
        remote = {
            "target": sess["target_type"],
            "model": sess["model_name"],
            "endpoint": sess["endpoint_url"],
            "uptime_minutes": round((time.time() - sess["start_time"]) / 60.0, 1),
            "idle_timeout_minutes": sess["idle_timeout_minutes"],
            "tokens_count": sess["tokens_count"],
        }
    return {
        "local": {
            "healthy": local["healthy"], "models": local["models"], "latency_ms": local.get("latency_ms"),
            "runtime": local_runtime.state,
        },
        "remote_session": remote,
    }


# ------------------------------------------------------------------ library and backends

@app.get("/api/quotas")
async def api_quotas(force: bool = False):
    """Usage and remaining quota per source (Colab, Modal, Kaggle, Groq, local), each with its provenance."""
    return {"sources": await asyncio.to_thread(quotas.collect, force), "generated_at": time.time()}


@app.get("/api/library")
def api_library():
    return library.library()


@app.get("/api/models")
def api_models():
    """Legacy dashboard list: local GGUF files with what the runtime currently holds."""
    loaded = local_runtime.state.get("model_path")
    out = []
    for m in library.list_local():
        out.append({**m, "is_active": bool(loaded) and os.path.normcase(m["path"]) == os.path.normcase(loaded)})
    return out


@app.get("/api/backends")
async def api_backends(request: Request):
    items = backends.all_backends()
    for b in items:
        await backends.probe(http(request), b)
    return [backends.public(b) for b in items]


@app.post("/api/backends")
async def api_backends_register(request: Request, payload: dict):
    try:
        b = backends.register(
            payload.get("id", ""), payload.get("kind", ""), payload.get("base_url", ""),
            api_key=payload.get("api_key"), label=payload.get("label"), ttl_minutes=payload.get("ttl_minutes"),
            models=payload.get("models"), passive=bool(payload.get("passive")),
        )
    except ValueError as exc:
        return JSONResponse({"success": False, "error": str(exc)}, status_code=400)
    full = backends.get(b["id"])
    await backends.probe(http(request), full, force=True)
    return {"success": True, "backend": backends.public(full)}


@app.delete("/api/backends/{backend_id}")
def api_backends_delete(backend_id: str):
    return {"success": backends.remove(backend_id)}


@app.post("/api/run")
async def api_run(request: Request, payload: dict):
    """Loads a local model now (target=local) so the first chat request does not pay the swap."""
    target = payload.get("target", "local")
    model = payload.get("model", "")
    if target != "local":
        return JSONResponse({"success": False, "error": "Les cibles kaggle/colab se lancent depuis leur notebook puis s'enregistrent via /api/backends."}, status_code=400)
    entry = library.find_local(model)
    if not entry:
        return JSONResponse({"success": False, "error": f"Modèle local introuvable : {model}"}, status_code=404)
    if not entry["fits_local"]:
        return JSONResponse({"success": False, "error": "Trop gros pour la RAM de cette machine : choisir une cible cloud.", "ram_needed_bytes": entry["ram_needed_bytes"]}, status_code=409)
    try:
        seconds = await local_runtime.ensure_loaded(http(request), entry["path"])
    except RuntimeError as exc:
        return JSONResponse({"success": False, "error": str(exc)}, status_code=502)
    return {"success": True, "model": entry["id"], "load_seconds": seconds}


@app.post("/api/runtime/stop")
async def api_runtime_stop():
    return {"success": True, "stopped": await local_runtime.stop()}


@app.post("/api/models/select-active")
async def api_select_active_model(request: Request, payload: dict):
    return await api_run(request, {"target": "local", "model": library.model_id(os.path.basename(payload.get("filename", "")))})


@app.post("/api/models/upload-local")
async def api_upload_local(file: UploadFile = File(...)):
    filename = os.path.basename(file.filename or "")
    if not GGUF_NAME.match(filename):
        return JSONResponse({"success": False, "error": "Nom attendu : lettres, chiffres, . _ - et extension .gguf"}, status_code=400)
    dest_dir = library.MODEL_DIRS[0]
    os.makedirs(dest_dir, exist_ok=True)
    dest_path = os.path.join(dest_dir, filename)
    written = 0
    try:
        with open(dest_path, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                out.write(chunk)
                written += len(chunk)
    except Exception as exc:
        if os.path.exists(dest_path):
            os.remove(dest_path)
        return JSONResponse({"success": False, "error": str(exc)}, status_code=500)
    return {"success": True, "filename": filename, "size_bytes": written}


def _local_file(filename):
    """Resolves a bare GGUF file name inside the library folders; never an arbitrary path."""
    name = os.path.basename(filename or "")
    if not GGUF_NAME.match(name):
        return None
    for directory in library.MODEL_DIRS:
        path = os.path.realpath(os.path.join(directory, name))
        if path.startswith(os.path.realpath(directory) + os.sep) and os.path.isfile(path):
            return path
    return None


@app.post("/api/models/delete")
def api_delete_model(payload: dict):
    path = _local_file(payload.get("filename", ""))
    if not path:
        return JSONResponse({"success": False, "error": "Fichier introuvable dans la bibliothèque locale."}, status_code=404)
    loaded = local_runtime.state.get("model_path")
    if loaded and os.path.normcase(loaded) == os.path.normcase(path):
        return JSONResponse({"success": False, "error": "Modèle chargé dans llama-server : l'arrêter avant suppression."}, status_code=409)
    os.remove(path)
    return {"success": True}


@app.post("/api/models/upload-hf")
def api_upload_hf(payload: dict, background_tasks: BackgroundTasks):
    path = _local_file(payload.get("filename", ""))
    if not path:
        return JSONResponse({"success": False, "error": "Fichier introuvable dans la bibliothèque locale."}, status_code=404)
    remote_name = os.path.basename(path)

    def do_upload():
        try:
            upload_model_to_hf(path, remote_filename=remote_name)
            library._cloud_cache["at"] = 0.0
        except Exception as exc:
            print("Erreur upload HF:", exc, flush=True)

    background_tasks.add_task(do_upload)
    return {"success": True, "status": "started", "filename": remote_name}


@app.post("/api/session/start")
def api_session_start(payload: dict):
    quota = get_quota_status()
    if quota["alert_level"] == "blocked":
        return {"success": False, "error": "Quota hebdomadaire Kaggle épuisé (29 h ou plus)."}
    session_id = str(uuid.uuid4())[:8]
    register_session_start(
        session_uuid=session_id, model_name=payload.get("model_name", ""), target_type=payload.get("target_type", "kaggle_t4"),
        idle_timeout_minutes=int(payload.get("idle_timeout_minutes", 30)), endpoint_url=payload.get("endpoint_url"),
    )
    return {"success": True, "session_uuid": session_id}


@app.post("/api/session/stop")
def api_session_stop():
    sess = get_active_session()
    if sess:
        return {"success": True, "duration_minutes": register_session_stop(sess["session_uuid"], status="completed")}
    return {"success": True, "duration_minutes": 0}


# ------------------------------------------------------------------ OpenAI-compatible API

@app.get("/v1/models")
async def openai_models(request: Request):
    """Models that can answer now or after a local swap: remote ones as <backend>/<model>, local ones by name."""
    data = []
    now = int(time.time())
    for b in backends.all_backends():
        if b["kind"] == "local":
            continue
        await backends.probe(http(request), b)
        if b["healthy"]:
            data += [{"id": f"{b['id']}/{m}", "object": "model", "created": now, "owned_by": b["kind"]} for m in b["models"]]
    for m in library.list_local():
        if m["readable"] and m["fits_local"]:
            data.append({"id": m["id"], "object": "model", "created": now, "owned_by": "local"})
    return {"object": "list", "data": data}


class RouteError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


async def resolve_route(client, model):
    """Returns (backend dict, upstream model name, swap seconds)."""
    if "/" in model:
        prefix, rest = model.split("/", 1)
        b = backends.get(prefix)
        if b:
            await backends.probe(client, b)
            if not b["healthy"]:
                raise RouteError(503, f"Backend {prefix} injoignable : {b.get('error')}")
            return b, rest, 0.0
    remotes = sorted((b for b in backends.all_backends() if b["kind"] != "local"), key=lambda b: REMOTE_PRIORITY.get(b["kind"], 9))
    for b in remotes:
        await backends.probe(client, b)
        if b["healthy"] and model in b["models"]:
            return b, model, 0.0
    local = backends.get("local")
    entry = library.find_local(model) if model else None
    if entry:
        if not entry["fits_local"]:
            raise RouteError(409, f"{entry['id']} demande {entry['ram_needed_bytes'] / 1024**3:.1f} Go de RAM : trop gros pour cette machine, choisir une cible cloud.")
        try:
            swap = await local_runtime.ensure_loaded(client, entry["path"])
        except RuntimeError as exc:
            raise RouteError(502, str(exc))
        return local, model, swap
    if not model:
        return local, model, 0.0
    raise RouteError(404, f"Modèle inconnu : {model}. Voir GET /v1/models.")


def _count_tokens(tail):
    found = re.findall(r'"completion_tokens"\s*:\s*(\d+)', tail)
    return int(found[-1]) if found else 0


async def _send(client, b, model, body, stream):
    payload = dict(body)
    if model:
        payload["model"] = model
    if stream and b["kind"] != "api":
        payload.setdefault("stream_options", {"include_usage": True})
    req = client.build_request("POST", f"{b['base_url']}/v1/chat/completions", json=payload, headers=backends.headers(b))
    # Always streamed: the body is read once, either relayed chunk by chunk or with aread().
    return await client.send(req, stream=True)


@app.post("/v1/chat/completions")
async def openai_chat_completions(request: Request):
    body = await request.json()
    stream = bool(body.get("stream", False))
    client = http(request)
    try:
        b, upstream_model, swap = await resolve_route(client, body.get("model") or "")
    except RouteError as exc:
        return JSONResponse({"error": {"message": str(exc), "type": "mazz_route_error"}}, status_code=exc.status)

    out_headers = {"X-Mazz-Backend": b["id"]}
    if swap:
        out_headers["X-Mazz-Swap-Seconds"] = str(swap)
    try:
        resp = await _send(client, b, upstream_model, body, stream)
        if resp.status_code >= 500 and b["kind"] != "local":
            await resp.aclose()
            raise httpx.HTTPStatusError(f"HTTP {resp.status_code}", request=resp.request, response=resp)
    except (httpx.TransportError, httpx.HTTPStatusError) as exc:
        if b["kind"] == "local":
            return JSONResponse({"error": {"message": f"llama-server local injoignable : {exc}", "type": "mazz_upstream_error"}}, status_code=502)
        local = backends.get("local")
        await backends.probe(client, local, force=True)
        if not local["healthy"]:
            return JSONResponse({"error": {"message": f"{b['id']} en échec ({exc}) et aucun modèle local chargé.", "type": "mazz_upstream_error"}}, status_code=502)
        out_headers.update({"X-Mazz-Backend": "local", "X-Mazz-Fallback": f"{b['id']}: {type(exc).__name__}"[:120]})
        print(f"[REPLI] {b['id']} en échec ({exc}) : requête servie par le modèle local", flush=True)
        b = local
        resp = await _send(client, b, "", body, stream)

    sess = get_active_session()
    track = sess if sess and sess.get("endpoint_url") and b["kind"] != "local" else None
    media = resp.headers.get("content-type", "application/json")
    if not stream or resp.status_code >= 400:
        content = await resp.aread()
        await resp.aclose()
        if track and resp.status_code < 400:
            update_session_activity(track["session_uuid"], tokens_added=_count_tokens(content[-4096:].decode("utf-8", "ignore")))
        return Response(content, status_code=resp.status_code, media_type=media, headers=out_headers)

    tail = {"text": ""}

    async def relay():
        async for chunk in resp.aiter_bytes():
            tail["text"] = (tail["text"] + chunk.decode("utf-8", "ignore"))[-4096:]
            yield chunk

    def finish():
        if track:
            update_session_activity(track["session_uuid"], tokens_added=_count_tokens(tail["text"]))

    async def close():
        await resp.aclose()
        finish()

    return StreamingResponse(relay(), status_code=resp.status_code, media_type=media, headers=out_headers, background=BackgroundTask(close))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT)
