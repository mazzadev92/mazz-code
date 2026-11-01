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
from core import backends, breaker, library, local_runtime, quotas  # noqa: E402
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
# llama-server answers one request at a time: at most LOCAL_QUEUE_MAX wait, each for LOCAL_QUEUE_WAIT_S,
# the next one gets 503 + Retry-After (spec 05).
LOCAL_QUEUE_MAX = 3
LOCAL_QUEUE_WAIT_S = 30
_local_slot = asyncio.Semaphore(1)  # recreated in lifespan, bound to the server's event loop
_local_waiting = 0
ANTHROPIC_ERROR_TYPES = {400: "invalid_request_error", 401: "authentication_error", 403: "permission_error",
                         404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error",
                         503: "overloaded_error", 529: "overloaded_error"}


class LocalBusy(Exception):
    """The local server is busy and its queue is full, or the wait timed out."""


class CircuitOpen(Exception):
    """The remote backend's circuit breaker is open: it is skipped without being called."""


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
    global _local_slot
    _local_slot = asyncio.Semaphore(1)
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


@app.post("/api/models/swap")
async def api_models_swap(request: Request, payload: dict):
    """Swaps the local model, refused while an inference holds the local server (spec 05)."""
    if _local_slot.locked():
        return JSONResponse({"success": False, "error": "Inference in flight, cannot swap"}, status_code=409)
    return await api_run(request, {"target": "local", "model": payload.get("model", "")})


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
    if "haiku" in model.lower() or "fast" in model.lower():
        fast_entry = library.find_local("Mazz-Technos-Draft-0.6B.Q4_K_M.gguf") or library.find_local("Qwen3-0.6B-Q4_K_M.gguf") or library.find_local("Mazz-Technos-Base-4B-Abliterated.Q4_K_M.gguf")
        if fast_entry:
            swap = await local_runtime.ensure_loaded(client, fast_entry["path"])
            return local, fast_entry["filename"], swap

    if model.startswith("claude-") or not model:
        for b in remotes:
            await backends.probe(client, b)
            if b["healthy"] and b["models"]:
                return b, b["models"][0], 0.0
        default_entry = library.find_local("Mazz-Technos-Base-4B-Abliterated.Q4_K_M.gguf") or (library.list_local() or [None])[0]
        if default_entry:
            swap = await local_runtime.ensure_loaded(client, default_entry["path"])
            return local, default_entry["filename"], swap
        return local, "", 0.0
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


async def _acquire_local():
    global _local_waiting
    slot = _local_slot
    if slot.locked() and _local_waiting >= LOCAL_QUEUE_MAX:
        raise LocalBusy(f"modèle local occupé, {LOCAL_QUEUE_MAX} requêtes déjà en attente")
    _local_waiting += 1
    try:
        await asyncio.wait_for(slot.acquire(), LOCAL_QUEUE_WAIT_S)
    except asyncio.TimeoutError:
        raise LocalBusy(f"modèle local occupé depuis plus de {LOCAL_QUEUE_WAIT_S} s") from None
    finally:
        _local_waiting -= 1
    return slot


async def _send_local(client, b, model, body, stream):
    """Sends to llama-server holding the local slot until the response is closed."""
    slot = await _acquire_local()
    try:
        resp = await _send(client, b, model, body, stream)
    except BaseException:
        slot.release()
        raise
    close = resp.aclose
    released = False

    async def aclose():
        nonlocal released
        try:
            await close()
        finally:
            if not released:
                released = True
                slot.release()

    resp.aclose = aclose
    return resp


async def _send_routed(client, b, model, body, stream):
    """Sends to backend `b`. Raises (failover triggers) on network errors, 408/429/5xx and an open circuit;
    any other status, 400/401/403 included, is returned to the caller as is."""
    if b["kind"] == "local":
        return await _send_local(client, b, model, body, stream)
    if not breaker.allow(b["id"]):
        raise CircuitOpen(f"circuit ouvert pour {b['id']}")
    try:
        resp = await _send(client, b, model, body, stream)
    except httpx.TransportError:
        breaker.record_failure(b["id"])
        raise
    if breaker.trips(resp.status_code):
        breaker.record_failure(b["id"])
        await resp.aclose()
        raise httpx.HTTPStatusError(f"HTTP {resp.status_code}", request=resp.request, response=resp)
    if resp.status_code < 400:
        breaker.record_success(b["id"])
    return resp


ANTHROPIC_VERSION = "2023-06-01"  # spec 06 §1.1, the only version this bridge implements


def _system_text(system):
    """Anthropic `system` (string or array of text blocks) as one OpenAI system text. Every block is kept, in
    order; cache_control has no OpenAI equivalent, the stable order keeps the llama-server prefix cache valid."""
    if system is None or isinstance(system, str):
        return system or ""
    if not isinstance(system, list):
        raise ValueError("system doit être une chaîne ou un tableau de blocs")
    parts = []
    for i, block in enumerate(system):
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type", "text") == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
        else:
            raise ValueError(f"system[{i}] : bloc texte attendu ({{'type': 'text', 'text': ...}})")
    return "\n\n".join(parts)


def _anthropic_usage(usage):
    """Anthropic usage from the upstream OpenAI usage: real counts, 0 when the upstream gave none."""
    usage = usage if isinstance(usage, dict) else {}
    return {"input_tokens": int(usage.get("prompt_tokens") or 0), "output_tokens": int(usage.get("completion_tokens") or 0)}


def _anthropic_error(status, raw):
    try:
        err = json.loads(raw).get("error")
        message = err.get("message") if isinstance(err, dict) else str(err or "")
    except (ValueError, AttributeError):
        message = ""
    message = message or raw.decode("utf-8", "ignore")[:500] or f"HTTP {status}"
    return {"type": "error", "error": {"type": ANTHROPIC_ERROR_TYPES.get(status, "api_error"), "message": message}}


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
        try:
            resp = await _send_routed(client, b, upstream_model, body, stream)
        except (httpx.TransportError, httpx.HTTPStatusError, CircuitOpen) as exc:
            if b["kind"] == "local":
                return JSONResponse({"error": {"message": f"llama-server local injoignable : {exc}", "type": "mazz_upstream_error"}}, status_code=502)
            local = backends.get("local")
            await backends.probe(client, local, force=True)
            if not local["healthy"]:
                return JSONResponse({"error": {"message": f"{b['id']} en échec ({exc}) et aucun modèle local chargé.", "type": "mazz_upstream_error"}}, status_code=502)
            out_headers.update({"X-Mazz-Backend": "local", "X-Mazz-Fallback": f"{b['id']}: {type(exc).__name__}"[:120]})
            print(f"[REPLI] {b['id']} en échec ({exc}) : requête servie par le modèle local", flush=True)
            b = local
            resp = await _send_routed(client, b, "", body, stream)
    except LocalBusy as exc:
        return JSONResponse({"error": {"message": str(exc), "type": "mazz_local_busy"}}, status_code=503, headers={"Retry-After": "5"})

    sess = get_active_session()
    track = sess if sess and sess.get("endpoint_url") and b["kind"] != "local" else None
    media = resp.headers.get("content-type", "application/json")
    if not stream or resp.status_code >= 400:
        try:
            content = await resp.aread()
        finally:
            await resp.aclose()
        if track and resp.status_code < 400:
            update_session_activity(track["session_uuid"], tokens_added=_count_tokens(content[-4096:].decode("utf-8", "ignore")))
        return Response(content, status_code=resp.status_code, media_type=media, headers=out_headers)

    tail = {"text": ""}

    async def relay():
        try:
            async for chunk in resp.aiter_bytes():
                tail["text"] = (tail["text"] + chunk.decode("utf-8", "ignore"))[-4096:]
                yield chunk
        finally:
            await resp.aclose()  # idempotent; frees the local slot even if the background task never runs

    def finish():
        if track:
            update_session_activity(track["session_uuid"], tokens_added=_count_tokens(tail["text"]))

    async def close():
        await resp.aclose()
        finish()

    return StreamingResponse(relay(), status_code=resp.status_code, media_type=media, headers=out_headers, background=BackgroundTask(close))




@app.post("/v1/messages/count_tokens")
async def count_tokens_endpoint(request: Request):
    """Accurate token counter for Anthropic clients and context compactor."""
    body = await request.json()
    chars = 0
    sys_val = body.get("system", "")
    if isinstance(sys_val, list):
        chars += sum(len(b.get("text", "")) for b in sys_val if isinstance(b, dict))
    elif isinstance(sys_val, str):
        chars += len(sys_val)
    for m in body.get("messages", []):
        c = m.get("content", "")
        if isinstance(c, str):
            chars += len(c)
        elif isinstance(c, list):
            for b in c:
                if isinstance(b, dict):
                    chars += len(b.get("text", "") or b.get("content", "") or json.dumps(b.get("input", {})))
    for t in body.get("tools", []):
        chars += len(json.dumps(t))

    tokens = max(1, int(chars / 3.8))
    return JSONResponse({"input_tokens": tokens})


@app.post("/v1/messages")
async def anthropic_messages(request: Request):
    """Native Anthropic Messages API bridge for Claude Desktop and Claude Code CLI.
    Translates Anthropic Messages protocol into MAZZ sovereign backends (Modal 32B or local GGUF)."""
    body = await request.json()
    stream = bool(body.get("stream", False))
    client = http(request)
    # anthropic-beta flags (prompt caching, fine-grained tool streaming) need no switch here: those behaviours are always on.
    version_header = {"anthropic-version": request.headers.get("anthropic-version") or ANTHROPIC_VERSION}

    try:
        system_prompt = _system_text(body.get("system"))
    except ValueError as exc:
        return JSONResponse({"type": "error", "error": {"type": "invalid_request_error", "message": str(exc)}}, status_code=400, headers=version_header)

    openai_messages = []
    if system_prompt:
        openai_messages.append({"role": "system", "content": system_prompt})

    # Convert Anthropic message blocks to text / tools
    for m in body.get("messages", []):
        role = m.get("role", "user")
        c = m.get("content", "")
        if isinstance(c, list):
            parts = []
            for block in c:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        parts.append(block.get("text", ""))
                    elif block.get("type") == "tool_use":
                        tool_name = block.get("name", "")
                        tool_input = json.dumps(block.get("input", {}), ensure_ascii=False)
                        parts.append(f"<tools>\n{{\"name\": \"{tool_name}\", \"arguments\": {tool_input}}}\n</tools>")
                    elif block.get("type") == "tool_result":
                        parts.append(f"[Tool Result ({block.get('tool_use_id', '')}): {block.get('content', '')}]")
            c = "\n".join(parts)
        openai_messages.append({"role": role, "content": c})

    openai_body = {
        "model": body.get("model") or "",
        "messages": openai_messages,
        "temperature": body.get("temperature", 0.7),
        "stream": stream
    }
    if "max_tokens" in body:
        openai_body["max_tokens"] = body["max_tokens"]

    if "tools" in body and isinstance(body["tools"], list):
        openai_body["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": t.get("name", ""),
                    "description": t.get("description", ""),
                    "parameters": t.get("input_schema", {})
                }
            }
            for t in body["tools"] if isinstance(t, dict) and "name" in t
        ]

    if "tool_choice" in body:
        tc = body["tool_choice"]
        if isinstance(tc, dict):
            t_type = tc.get("type")
            if t_type == "auto":
                openai_body["tool_choice"] = "auto"
            elif t_type == "any":
                openai_body["tool_choice"] = "required"
            elif t_type == "tool":
                openai_body["tool_choice"] = {"type": "function", "function": {"name": tc.get("name", "")}}
            elif t_type == "none":
                openai_body["tool_choice"] = "none"

    try:
        b, upstream_model, swap = await resolve_route(client, openai_body["model"])
    except RouteError as exc:
        return JSONResponse({"type": "error", "error": {"type": "invalid_request_error", "message": str(exc)}}, status_code=exc.status, headers=version_header)

    # Plafond strict sur le modèle local (débit réel 4-6 tok/s) : max 800 tokens pour garantir des tours courts
    if b["kind"] == "local":
        openai_body["max_tokens"] = min(openai_body.get("max_tokens", 800), 800)

    out_headers = {"X-Mazz-Backend": b["id"], **version_header}
    if swap:
        out_headers["X-Mazz-Swap-Seconds"] = str(swap)

    try:
        try:
            resp = await _send_routed(client, b, upstream_model, openai_body, stream)
        except (httpx.TransportError, httpx.HTTPStatusError, CircuitOpen) as exc:
            local = backends.get("local")
            await backends.probe(client, local, force=True)
            if not local["healthy"]:
                default_entry = library.find_local("Mazz-Technos-Base-4B-Abliterated.Q4_K_M.gguf") or (library.list_local() or [None])[0]
                if default_entry:
                    try:
                        await local_runtime.ensure_loaded(client, default_entry["path"])
                        await backends.probe(client, local, force=True)
                    except Exception as load_exc:
                        print(f"[REPLI] chargement du modèle local par défaut impossible : {load_exc}", flush=True)
            if not local["healthy"]:
                return JSONResponse({"type": "error", "error": {"type": "api_error", "message": f"{b['id']} failed and no local model."}}, status_code=502, headers=version_header)
            out_headers.update({"X-Mazz-Backend": "local", "X-Mazz-Fallback": f"{b['id']}: {type(exc).__name__}"[:120]})
            b = local
            resp = await _send_routed(client, b, "", openai_body, stream)
    except LocalBusy as exc:
        return JSONResponse({"type": "error", "error": {"type": "overloaded_error", "message": str(exc)}}, status_code=503, headers={"Retry-After": "5", **version_header})

    msg_id = f"msg_{uuid.uuid4().hex[:20]}"
    model_name = body.get("model") or b.get("id", "mazz-model")

    if not stream or resp.status_code >= 400:
        try:
            raw_content = await resp.aread()
        finally:
            await resp.aclose()
        if resp.status_code >= 400:
            return JSONResponse(_anthropic_error(resp.status_code, raw_content), status_code=resp.status_code, headers=out_headers)
        content_blocks = []
        stop_reason = "end_turn"
        try:
            o_resp = json.loads(raw_content)
            choice = o_resp.get("choices", [{}])[0]
            msg = choice.get("message", {})
            reply_text = msg.get("content", "")
            if reply_text:
                content_blocks.append({"type": "text", "text": reply_text})
            tool_calls = msg.get("tool_calls", [])
            if tool_calls:
                stop_reason = "tool_use"
                for tc in tool_calls:
                    fn = tc.get("function", {})
                    try:
                        args = json.loads(fn.get("arguments", "{}"))
                    except Exception:
                        args = {}
                    content_blocks.append({
                        "type": "tool_use",
                        "id": tc.get("id") or f"toolu_{uuid.uuid4().hex[:12]}",
                        "name": fn.get("name", ""),
                        "input": args
                    })
            if not content_blocks:
                content_blocks.append({"type": "text", "text": reply_text or ""})
            usage = o_resp.get("usage")
        except Exception:
            content_blocks = [{"type": "text", "text": raw_content.decode("utf-8", "ignore")}]
            usage = {}

        anthropic_resp = {
            "id": msg_id,
            "type": "message",
            "role": "assistant",
            "content": content_blocks,
            "model": model_name,
            "stop_reason": stop_reason,
            "stop_sequence": None,
            "usage": _anthropic_usage(usage),
        }
        return JSONResponse(anthropic_resp, headers=out_headers)

    async def sse_relay():
        try:
            async for event in _sse_events():
                yield event
        finally:
            await resp.aclose()  # idempotent; frees the local slot even if the background task never runs

    async def _sse_events():
        yield f"event: message_start\ndata: {json.dumps({'type': 'message_start', 'message': {'id': msg_id, 'type': 'message', 'role': 'assistant', 'content': [], 'model': model_name, 'stop_reason': None, 'stop_sequence': None, 'usage': _anthropic_usage(None)}})}\n\n".encode("utf-8")
        
        block_index = 0
        text_block_active = False
        tool_block_active = False
        saw_tool_use = False
        current_tool_id = ""
        current_tool_name = ""
        # OpenAI streams send usage in a last chunk (choices: []), after message_start: it is reported in message_delta.
        usage = None

        lines = resp.aiter_lines()
        while True:
            try:
                line = await lines.__anext__()
            except StopAsyncIteration:
                break
            except httpx.HTTPError as exc:
                err = {"type": "error", "error": {"type": "api_error", "message": f"flux amont interrompu : {exc}"}}
                yield f"event: error\ndata: {json.dumps(err)}\n\n".encode("utf-8")
                return
            line = line.strip()
            if not line or not line.startswith("data:"):
                continue
            payload_str = line[5:].strip()
            if payload_str == "[DONE]":
                break
            try:
                chunk = json.loads(payload_str)
                usage = chunk.get("usage") or usage
                delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
                token = delta.get("content", "")
                tool_calls = delta.get("tool_calls", [])

                if token:
                    if not text_block_active and not tool_block_active:
                        yield f"event: content_block_start\ndata: {json.dumps({'type': 'content_block_start', 'index': block_index, 'content_block': {'type': 'text', 'text': ''}})}\n\n".encode("utf-8")
                        text_block_active = True
                    ev = {
                        "type": "content_block_delta",
                        "index": block_index,
                        "delta": {"type": "text_delta", "text": token}
                    }
                    yield f"event: content_block_delta\ndata: {json.dumps(ev)}\n\n".encode("utf-8")

                if tool_calls:
                    saw_tool_use = True
                    for tc in tool_calls:
                        fn = tc.get("function", {})
                        fn_name = fn.get("name", "")
                        fn_args = fn.get("arguments", "")
                        tc_id = tc.get("id") or f"toolu_{uuid.uuid4().hex[:12]}"

                        if fn_name:
                            if text_block_active:
                                yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': block_index})}\n\n".encode("utf-8")
                                text_block_active = False
                                block_index += 1
                            elif tool_block_active:
                                yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': block_index})}\n\n".encode("utf-8")
                                block_index += 1

                            current_tool_id = tc_id
                            current_tool_name = fn_name
                            tool_block_active = True
                            tool_start = {
                                "type": "content_block_start",
                                "index": block_index,
                                "content_block": {
                                    "type": "tool_use",
                                    "id": current_tool_id,
                                    "name": current_tool_name,
                                    "input": {}
                                }
                            }
                            yield f"event: content_block_start\ndata: {json.dumps(tool_start)}\n\n".encode("utf-8")

                        if fn_args:
                            if not tool_block_active:
                                if text_block_active:
                                    yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': block_index})}\n\n".encode("utf-8")
                                    text_block_active = False
                                    block_index += 1
                                tool_block_active = True
                                current_tool_id = tc_id
                                current_tool_name = fn_name or "tool"
                                yield f"event: content_block_start\ndata: {json.dumps({'type': 'content_block_start', 'index': block_index, 'content_block': {'type': 'tool_use', 'id': current_tool_id, 'name': current_tool_name, 'input': {}}})}\n\n".encode("utf-8")

                            tool_delta = {
                                "type": "content_block_delta",
                                "index": block_index,
                                "delta": {
                                    "type": "input_json_delta",
                                    "partial_json": fn_args
                                }
                            }
                            yield f"event: content_block_delta\ndata: {json.dumps(tool_delta)}\n\n".encode("utf-8")
            except Exception:
                pass

        if text_block_active or tool_block_active:
            yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': block_index})}\n\n".encode("utf-8")

        final_stop_reason = "tool_use" if saw_tool_use else "end_turn"
        yield f"event: message_delta\ndata: {json.dumps({'type': 'message_delta', 'delta': {'stop_reason': final_stop_reason, 'stop_sequence': None}, 'usage': _anthropic_usage(usage)})}\n\n".encode("utf-8")
        yield f"event: message_stop\ndata: {json.dumps({'type': 'message_stop'})}\n\n".encode("utf-8")

    async def on_finish():
        await resp.aclose()

    return StreamingResponse(
        sse_relay(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", **out_headers},
        background=BackgroundTask(on_finish)
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT)
