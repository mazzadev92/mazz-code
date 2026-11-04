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
import os
import re
import secrets
import sys
import time
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from jinja2 import Environment, FileSystemLoader, select_autoescape
from starlette.background import BackgroundTask

sys.path.insert(0, os.path.dirname(__file__))
sys.modules.setdefault("app", sys.modules[__name__])  # `python app.py` runs as __main__: sub-modules import it as "app"
import hashlib
from rag.bib1 import get_bib1_rag  # noqa: E402
from core import backends, breaker, library, local_runtime, quotas  # noqa: E402
from core.secret_file import restrict_acl  # noqa: E402
try:  # multi-provider AI layer (docs: integrations/ai/INTEGRATION.md); inert unless AI_ROUTER_ENABLED=true
    from integrations.ai import AllProvidersFailed, NoProviderAvailable, Router as AiRouter, load_registry  # noqa: E402
    from integrations.ai.adapters.base import ChatRequest as AiChatRequest  # noqa: E402
    from integrations.ai.routes import router as ai_routes  # noqa: E402
except Exception as _ai_exc:  # noqa: BLE001
    AiRouter = ai_routes = None
    print(f"[IA] couche d'integration indisponible : {type(_ai_exc).__name__}", flush=True)
try:  # remote compute hub (send a model to Saturn / Kaggle / Colab / Modal); docs: docs/INSCRIPTIONS_ET_GARDE_FOUS.md
    from compute.routes import router as compute_routes  # noqa: E402
except Exception as _compute_exc:  # noqa: BLE001
    compute_routes = None
    print(f"[Calcul] hub indisponible : {type(_compute_exc).__name__}", flush=True)
from core.hf_sync import REPO_ID, get_hf_token  # noqa: E402
from core.quota_db import (  # noqa: E402
    check_inactivity_timeouts, get_active_session, get_quota_status, init_db,
    update_session_activity,
)

PORT = int(os.environ.get("MAZZ_PORT", "7070"))
KEY_FILE = os.path.expandvars(r"%USERPROFILE%\.mazz\control.key")
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}", "testserver"}
ALLOWED_ORIGINS = [f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}", "http://127.0.0.1:3333", "http://127.0.0.1:5173", "http://localhost:5173"]
GGUF_NAME = re.compile(r"^[A-Za-z0-9._-]+\.gguf$")
# Long generations on CPU: no read timeout shorter than ten minutes.
UPSTREAM_TIMEOUT = httpx.Timeout(connect=45.0, read=600.0, write=60.0, pool=45.0)
REMOTE_PRIORITY = {"colab": 0, "kaggle": 1, "modal": 2, "api": 3}
ANNOUNCE_PERIOD = 30
LOCAL_MAX_TOKENS = int(os.environ.get("MAZZ_LOCAL_MAX_TOKENS", "4096"))
DRAFT_ID = "draft"  # backend id of the dedicated 0.6B server (spec 00: port 8081, compaction and fast model)
DRAFT_PORT = 8081
# llama-server answers one request at a time: at most LOCAL_QUEUE_MAX wait, each for LOCAL_QUEUE_WAIT_S,
# the next one gets 503 + Retry-After (spec 05).
LOCAL_QUEUE_MAX = 3
LOCAL_QUEUE_WAIT_S = 30
_local_slot = asyncio.Semaphore(1)  # recreated in lifespan, bound to the server's event loop
_local_waiting = 0
class LocalBusy(Exception):
    """The local server is busy and its queue is full, or the wait timed out."""


class CircuitOpen(Exception):
    """The remote backend's circuit breaker is open: it is skipped without being called."""


def load_control_key():
    try:
        with open(KEY_FILE, "r", encoding="utf-8") as f:
            key = f.read().strip()
            if key:
                restrict_acl(KEY_FILE)
                return key
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(KEY_FILE), exist_ok=True)
    key = secrets.token_urlsafe(32)
    with open(KEY_FILE, "w", encoding="utf-8") as f:
        f.write(key)
    try:
        os.chmod(KEY_FILE, 0o600)
    except OSError:
        pass
    restrict_acl(KEY_FILE)
    return key


CONTROL_KEY = load_control_key()
# Opaque browser session for the local dashboard. It is never the master key: the page could be
# inspected by another local app, and the key must stay in %USERPROFILE%\.mazz\control.key.
SESSION_TOKEN = secrets.token_urlsafe(32)


ai_router = None  # set by lifespan; None when the AI layer failed to load


def _build_ai_router(client):
    """Parses registry.yaml and .env only: no network access, never raises."""
    if AiRouter is None:
        return None
    try:
        return AiRouter.build(client)
    except Exception as exc:  # noqa: BLE001 - an invalid registry must not stop the gateway
        print(f"[IA] registre invalide : {exc}", flush=True)
        return None


@asynccontextmanager
async def lifespan(app):
    global _local_slot
    _local_slot = asyncio.Semaphore(1)
    init_db()
    backends.init(local_runtime.base_url(), os.environ.get("MAZZ_DRAFT_URL", f"http://127.0.0.1:{DRAFT_PORT}"),
                  api_key=local_runtime.api_key())
    # follow_redirects: Modal answers a request still running after 150 s with 303 to its result URL.
    app.state.http = httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT, follow_redirects=True)
    global ai_router
    ai_router = app.state.ai_router = _build_ai_router(app.state.http)
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
if ai_routes is not None:
    app.include_router(ai_routes)
if compute_routes is not None:
    app.include_router(compute_routes)
jinja_env = Environment(loader=FileSystemLoader(os.path.join(os.path.dirname(__file__), "templates")), autoescape=select_autoescape(["html"]))


def _browser_session(request: Request) -> bool:
    """True for the dashboard's HttpOnly cookie, never for a cross-origin request."""
    token = request.cookies.get("mazz_session", "")
    if not token or not secrets.compare_digest(token, SESSION_TOKEN):
        return False
    origin = request.headers.get("origin")
    if origin:
        return origin in ALLOWED_ORIGINS
    referer = request.headers.get("referer", "")
    return not referer or any(referer == o or referer.startswith(o + "/") for o in ALLOWED_ORIGINS)


@app.middleware("http")
async def guard(request: Request, call_next):
    # DNS rebinding: a page on another domain resolving to 127.0.0.1 still sends its own Host.
    if request.headers.get("host", "") not in ALLOWED_HOSTS:
        return JSONResponse({"error": "Hôte refusé"}, status_code=403)
    if request.url.path.startswith(("/api/", "/integrations/", "/compute/")) and request.method not in ("GET", "HEAD", "OPTIONS"):
        header_ok = secrets.compare_digest(request.headers.get("x-mazz-key", ""), CONTROL_KEY)
        if not (header_ok or _browser_session(request)):
            return JSONResponse({"error": "Clé X-Mazz-Key absente ou invalide (voir %USERPROFILE%\\.mazz\\control.key)"}, status_code=401)
    # Inference spends local CPU and paid GPU credit: any page could otherwise POST text/plain to /v1/*.
    if request.url.path.startswith("/v1/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        if not secrets.compare_digest(_presented_key(request), CONTROL_KEY):
            return JSONResponse({"type": "error", "error": {"type": "authentication_error", "message":
                                 "Clé absente ou invalide : x-api-key ou Authorization: Bearer = %USERPROFILE%\\.mazz\\control.key"}},
                                status_code=401)
    return await call_next(request)


def _presented_key(request: Request) -> str:
    """Anthropic clients send x-api-key, OpenAI clients Authorization: Bearer, the dashboard X-Mazz-Key."""
    auth = request.headers.get("authorization", "")
    return (request.headers.get("x-api-key") or (auth[7:] if auth.lower().startswith("bearer ") else "")
            or request.headers.get("x-mazz-key", ""))


def _is_forwarded(request: Request) -> bool:
    """A request relayed by a tunnel or proxy (cloudflared adds Cf-Connecting-Ip) is not the local user."""
    return any(h in request.headers for h in ("cf-connecting-ip", "x-forwarded-for", "forwarded", "x-real-ip"))


def http(request: Request) -> httpx.AsyncClient:
    return request.app.state.http


# ------------------------------------------------------------------ dashboard

@app.get("/", response_class=HTMLResponse)
def index_page(request: Request):
    # The master key is never written into the page. The local browser gets an opaque HttpOnly
    # session cookie instead; a tunnel or proxy gets nothing, so a forwarded page cannot mutate.
    response = HTMLResponse(jinja_env.get_template("index.html").render())
    if not _is_forwarded(request):
        response.set_cookie("mazz_session", SESSION_TOKEN, httponly=True, samesite="strict", path="/")
    return response


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


from routes_library import router as library_router  # noqa: E402 (needs this module's names at call time)
app.include_router(library_router)


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
    # Surface router selections only when the explicit opt-in is active. This lets the Studio select
    # the router through its existing MAZZ Control provider without adding a duplicate provider/menu.
    if ai_router is not None and ai_router.enabled:
        data.append({"id": "auto", "object": "model", "created": now, "owned_by": "mazz-ai-router"})
        aliases = sorted({model.alias for provider in ai_router.registry.providers if "chat" in provider.capabilities
                          and provider.adapter != "registry_only" for model in provider.models})
        data.extend({"id": f"router/{alias}", "object": "model", "created": now, "owned_by": "mazz-ai-router"}
                    for alias in aliases)
    return {"object": "list", "data": data}


class RouteError(Exception):
    def __init__(self, status, message, headers=None):
        super().__init__(message)
        self.status = status
        self.headers = headers or {}


async def resolve_route(client, model):
    """Returns (backend dict, upstream model name, GGUF path to load or None).
    The load itself happens in _send_local once the local slot is held: swapping here would kill
    the generation another request is streaming from llama-server."""
    if ai_router is not None and ai_router.enabled and (model == "auto" or model.startswith("router/")):
        return {"id": "router", "kind": "router", "base_url": ""}, model, None
    if "/" in model:
        prefix, rest = model.split("/", 1)
        b = backends.get(prefix)
        if b:
            await backends.probe(client, b)
            if not b["healthy"]:
                raise RouteError(503, f"Backend {prefix} injoignable : {b.get('error')}")
            return b, rest, None
    # The draft server (0.6B, port 8081) only serves fast/haiku requests, never the working model's traffic.
    remotes = sorted((b for b in backends.all_backends() if b["kind"] != "local" and b["id"] != DRAFT_ID), key=lambda b: REMOTE_PRIORITY.get(b["kind"], 9))
    for b in remotes:
        await backends.probe(client, b)
        if b["healthy"] and model in b["models"]:
            return b, model, None
    local = backends.get("local")
    entry = library.find_local(model) if model else None
    if entry:
        if not entry["fits_local"]:
            raise RouteError(409, f"{entry['id']} demande {entry['ram_needed_bytes'] / 1024**3:.1f} Go de RAM : trop gros pour cette machine, choisir une cible cloud.")
        return local, model, entry["path"]
    if "haiku" in model.lower() or "fast" in model.lower() or "draft" in model.lower():
        draft = backends.get(DRAFT_ID)
        # Fail closed: the llama key is only sent to a verified llama-server on 8081 (owner unknown or foreign = no draft).
        if draft and local_runtime.port_owned_by_llama(DRAFT_PORT) is True:
            await backends.probe(client, draft)
            if draft["healthy"]:
                return draft, (draft["models"] or [""])[0], None
        # No draft server: answer with whatever 8080 holds. Reloading 8080 to a 0.6B for every fast
        # request (Claude Code sends many) would evict the working model each time.
        return local, "", None

    if model.startswith("claude-") or not model:
        for b in remotes:
            await backends.probe(client, b)
            if b["healthy"] and b["models"]:
                return b, b["models"][0], None
        default_entry = library.find_local("Mazz-Technos-Base-4B-Abliterated.Q4_K_M.gguf") or (library.list_local() or [None])[0]
        if default_entry:
            return local, default_entry["filename"], default_entry["path"]
        return local, "", None
    raise RouteError(404, f"Modèle inconnu : {model}. Voir GET /v1/models.")


def _append_to_user(message, text):
    """Bib1 context goes after the last user turn, never in the system prompt: a system prompt that
    changes every turn invalidates llama-server's prefix cache for the whole conversation."""
    content = message.get("content")
    if isinstance(content, list):
        message["content"] = [*content, {"type": "text", "text": text}]
    else:
        message["content"] = f"{content or ''}\n\n{text}"


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


async def _send_local(client, b, model, body, stream, load_path=None):
    """Sends to llama-server holding the local slot until the response is closed. `load_path` is
    loaded first, under the slot, so a swap never cuts another request's generation."""
    slot = await _acquire_local()
    try:
        swap = 0.0
        if load_path:
            try:
                swap = await local_runtime.ensure_loaded(client, load_path)
            except RuntimeError as exc:
                raise RouteError(502, str(exc))
        resp = await _send(client, b, model, body, stream)
        resp.mazz_swap_seconds = swap
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


async def _send_via_ai_router(model, body, stream):
    """model is "auto" or "router/<alias>". The reply is an OpenAI-shaped httpx.Response, so the translators below apply."""
    alias = model.split("/", 1)[1] if "/" in model else None
    request = AiChatRequest(messages=body.get("messages", []), model=alias, temperature=body.get("temperature"),
                            max_tokens=body.get("max_tokens"), tools=body.get("tools"), tool_choice=body.get("tool_choice"), stream=stream)
    try:
        response, chosen = await ai_router.open_chat(request)
    except NoProviderAvailable as exc:
        raise RouteError(exc.status, str(exc), {"Retry-After": str(exc.retry_after)} if exc.retry_after is not None else None)
    except AllProvidersFailed as exc:
        raise RouteError(exc.status, str(exc))
    response.mazz_provider = chosen.spec.id
    return response


async def _send_routed(client, b, model, body, stream, load_path=None):
    """Sends to backend `b`. Raises (failover triggers) on network errors, 408/429/5xx and an open circuit;
    any other status, 400/401/403 included, is returned to the caller as is."""
    if b["kind"] == "router":
        return await _send_via_ai_router(model, body, stream)
    if b["kind"] == "local":
        return await _send_local(client, b, model, body, stream, load_path)
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


async def _until_disconnect(request, chunks):
    """Relays `chunks` while the client is connected. On disconnect (Ctrl+C) it stops reading, so the caller's
    finally closes the upstream socket: llama-server aborts the generation and the local slot is freed."""
    try:
        async for chunk in chunks:
            if await request.is_disconnected():
                print("[ANNULATION] client déconnecté : flux amont fermé", flush=True)
                return
            yield chunk
    finally:
        await chunks.aclose()


@app.post("/v1/chat/completions")
async def openai_chat_completions(request: Request):
    body = await request.json()
    stream = bool(body.get("stream", False))
    client = http(request)
    try:
        b, upstream_model, load_path = await resolve_route(client, body.get("model") or "")
    except RouteError as exc:
        return JSONResponse({"error": {"message": str(exc), "type": "mazz_route_error"}}, status_code=exc.status, headers=exc.headers)

    rag_count = 0
    try:
        user_msgs = [m for m in body.get("messages", []) if m.get("role") == "user"]
        last_user = user_msgs[-1].get("content", "") if user_msgs else ""
        if isinstance(last_user, list):
            last_user = "\n".join(b.get("text", "") for b in last_user if isinstance(b, dict))
        rag_context, rag_count = await asyncio.to_thread(get_bib1_rag, str(last_user), dict(request.headers))
        if rag_context and user_msgs:
            _append_to_user(user_msgs[-1], rag_context)
    except Exception:
        rag_count = 0

    if "tools" in body:
        body["parallel_tool_calls"] = False

    out_headers = {"X-Mazz-Backend": b["id"], "X-Mazz-Bib1": str(rag_count)}
    session_id = request.headers.get("x-mazz-session", "")
    if session_id:
        out_headers["X-Mazz-Session-Slot"] = str(int(hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:8], 16) % 1)
    try:
        try:
            resp = await _send_routed(client, b, upstream_model, body, stream, load_path)
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
    except RouteError as exc:
        return JSONResponse({"error": {"message": str(exc), "type": "mazz_route_error"}}, status_code=exc.status, headers=exc.headers)
    if getattr(resp, "mazz_swap_seconds", 0):
        out_headers["X-Mazz-Swap-Seconds"] = str(resp.mazz_swap_seconds)
    if getattr(resp, "mazz_provider", None):
        out_headers["X-Mazz-Backend"] = f"router/{resp.mazz_provider}"

    sess = await asyncio.to_thread(get_active_session)
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
            async for chunk in _until_disconnect(request, resp.aiter_bytes()):
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




if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT)


from routes_anthropic import anthropic_messages, count_tokens_endpoint, router as anthropic_router  # noqa: E402,F401
from anthropic_compat import (  # noqa: E402,F401
    ANTHROPIC_ERROR_TYPES, ANTHROPIC_VERSION, LOCAL_MAX_TOOLS, _anthropic_error, _anthropic_usage, _block_text,
    _cap_tools, _openai_messages, _system_text, _text_chars,
)
app.include_router(anthropic_router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT)
