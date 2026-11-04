"""Registry of inference backends: the local llama-server plus any remote GPU runtime (Kaggle, Colab)
or external API the user adds. A backend is only routed to while its health probe succeeds.

Remote runtimes announce themselves (URL + key) through POST /api/backends, either pasted in the Studio
or written by the notebook. Entries persist in backends.json (MAZZ data folder) and expire at `expires_at`
so a stopped Colab tunnel is not retried forever. API keys are stored encrypted with Windows DPAPI (spec 05 §4,
bound to the Windows user); plain-text keys from older files are re-encrypted on load. Outside Windows the key
stays in clear in that user-only file.
"""
import base64
import ctypes
import hashlib
import hmac
import json
import os
import re
import sys
import time
import threading

import httpx

from .paths import mazz_path

STORE = mazz_path("backends.json")
KINDS = ("local", "kaggle", "colab", "modal", "api")
HEALTH_TTL = 15.0

_lock = threading.Lock()
_backends = {}

DPAPI = sys.platform == "win32"
if DPAPI:
    from ctypes import wintypes

    class _Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    _crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    _CRYPTPROTECT_UI_FORBIDDEN = 0x1


def _dpapi(data, protect):
    """CryptProtectData / CryptUnprotectData for the current Windows user. Raises OSError on failure."""
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = _Blob()
    fn = _crypt32.CryptProtectData if protect else _crypt32.CryptUnprotectData
    if not fn(ctypes.byref(blob_in), None, None, None, None, _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        _kernel32.LocalFree(ctypes.cast(blob_out.pbData, ctypes.c_void_p))


def _encrypt_key(key):
    return base64.b64encode(_dpapi(key.encode("utf-8"), True)).decode("ascii")


def _decrypt_key(blob):
    if not DPAPI:
        raise OSError("DPAPI indisponible hors Windows")
    return _dpapi(base64.b64decode(blob), False).decode("utf-8")


def _load():
    """Reads the store, decrypting keys. Returns True when plain-text keys must be re-saved encrypted."""
    try:
        with open(STORE, "r", encoding="utf-8") as f:
            entries = json.load(f)
    except (FileNotFoundError, ValueError):
        return False
    migrate = False
    for b in entries:
        blob = b.pop("api_key_dpapi", None)
        if blob is not None:
            try:
                b["api_key"] = _decrypt_key(blob)
            except (OSError, ValueError) as exc:  # other Windows user or damaged blob: the key must be re-entered
                b["api_key"] = None
                b["error"] = f"clé illisible ({type(exc).__name__}), à ressaisir"
        elif b.get("api_key") and DPAPI:
            migrate = True
        _backends[b["id"]] = b
    return migrate


def _stored(b):
    out = dict(b)
    key = out.pop("api_key", None)
    if key and DPAPI:
        out["api_key_dpapi"] = _encrypt_key(key)
    elif key:
        out["api_key"] = key
    return out


def _save():
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    remote = [_stored(b) for b in _backends.values() if b["kind"] != "local" and not b.get("builtin")]
    tmp = STORE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(remote, f, indent=1)
    os.replace(tmp, STORE)


def init(local_url, draft_url=None, api_key=None):
    with _lock:
        if _load():
            _save()
        _backends["local"] = {
            "id": "local", "kind": "local", "label": "llama-server local", "base_url": local_url.rstrip("/"),
            "api_key": api_key, "models": [], "healthy": None, "checked_at": 0.0, "expires_at": None, "error": None,
        }
        # Dedicated 0.6B server (spec 00, port 8081): its own process, so fast requests never reload port 8080.
        # A backend registered as "draft" by the user keeps precedence; builtin entries are never persisted.
        # Both local servers share the MAZZ data folder's llama.key, so the gateway authenticates with the same token.
        if draft_url and "draft" not in _backends:
            _backends["draft"] = {
                "id": "draft", "kind": "api", "label": "llama-server draft 0.6B", "base_url": draft_url.rstrip("/"),
                "api_key": api_key, "models": [], "healthy": None, "checked_at": 0.0, "expires_at": None, "error": None,
                "passive": False, "builtin": True,
            }


def register(backend_id, kind, base_url, api_key=None, label=None, ttl_minutes=None, models=None, passive=False):
    """passive: scale-to-zero backends (Modal) are never probed, since a probe would wake and bill them;
    their models are declared here and their health is learned from real requests."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", backend_id or "") or backend_id == "local":
        raise ValueError("id invalide : minuscules, chiffres, - et _, 32 caractères max, pas 'local'")
    if kind not in KINDS or kind == "local":
        raise ValueError(f"kind invalide : {', '.join(k for k in KINDS if k != 'local')}")
    if not re.match(r"^https?://", base_url or ""):
        raise ValueError("base_url doit commencer par http:// ou https://")
    base = base_url.rstrip("/")
    base = base[:-3] if base.endswith("/v1") else base
    with _lock:
        _backends[backend_id] = {
            "id": backend_id, "kind": kind, "label": label or backend_id, "base_url": base, "api_key": api_key,
            "models": list(models or []), "healthy": None, "checked_at": 0.0, "error": None, "passive": bool(passive),
            "expires_at": time.time() + ttl_minutes * 60 if ttl_minutes else None,
        }
        _save()
    return public(_backends[backend_id])


def remove(backend_id):
    with _lock:
        if backend_id == "local" or _backends.pop(backend_id, None) is None:
            return False
        _save()
        return True


def get(backend_id):
    with _lock:
        b = _backends.get(backend_id)
        return dict(b) if b else None


def all_backends():
    now = time.time()
    with _lock:
        expired = [k for k, b in _backends.items() if b.get("expires_at") and b["expires_at"] < now]
        for k in expired:
            del _backends[k]
        if expired:
            _save()
        return [dict(b) for b in _backends.values()]


def public(b):
    """Backend as shown to clients: never the API key."""
    out = {k: v for k, v in b.items() if k != "api_key"}
    out["has_key"] = bool(b.get("api_key"))
    return out


def headers(b):
    h = {"Content-Type": "application/json"}
    if b.get("api_key"):
        h["Authorization"] = f"Bearer {b['api_key']}"
    return h


async def probe(client, b, force=False):
    """Refreshes health and served model ids (cached HEALTH_TTL seconds)."""
    if b.get("passive"):
        b.setdefault("latency_ms", None)
        if b.get("healthy") is None:
            b["healthy"] = bool(b.get("models"))
        return b
    if not force and time.time() - b.get("checked_at", 0) < HEALTH_TTL and b.get("healthy") is not None:
        return b
    started = time.perf_counter()
    try:
        r = await client.get(f"{b['base_url']}/v1/models", headers=headers(b), timeout=6.0)
        r.raise_for_status()
        body = r.json()
        items = body.get("data") or body.get("models") or []
        ids = [m.get("id") or m.get("name") or m.get("model") for m in items if isinstance(m, dict)]
        update = {"healthy": True, "models": [i for i in ids if i], "error": None, "latency_ms": round((time.perf_counter() - started) * 1000)}
    except Exception as exc:
        update = {"healthy": False, "error": f"{type(exc).__name__}: {exc}"[:300], "latency_ms": None}
    update["checked_at"] = time.time()
    with _lock:
        if b["id"] in _backends:
            _backends[b["id"]].update(update)
    b.update(update)
    return b


ANNOUNCE_DIR = "_backends"


def _fetch_announcements(repo_id, token):
    """Reads _backends/*.json written by the GPU notebooks in the private repo (blocking, run in a thread)."""
    from huggingface_hub import HfApi, hf_hub_download
    api = HfApi(token=token)
    found = []
    try:
        entries = list(api.list_repo_tree(repo_id=repo_id, path_in_repo=ANNOUNCE_DIR, repo_type="model"))
    except Exception:
        return found  # folder absent: no runtime announced
    for entry in entries:
        path = getattr(entry, "path", "")
        if not path.endswith(".json"):
            continue
        local = hf_hub_download(repo_id, path, token=token, force_download=True)
        with open(local, "r", encoding="utf-8") as f:
            a = json.load(f)
        # Current notebooks publish only a nonce; the key is derived from the HF token both sides already hold.
        if a.get("nonce") and not a.get("api_key"):
            a["api_key"] = announced_key(token, a["nonce"])
        found.append(a)
    return found


def announced_key(hf_token, nonce):
    """Backend API key of a GPU notebook: HMAC-SHA256(HF_TOKEN, "mazz-backend:" + nonce), never written to the repo."""
    return hmac.new(hf_token.encode("utf-8"), f"mazz-backend:{nonce}".encode("utf-8"), hashlib.sha256).hexdigest()


def sync_announcements(announcements):
    """Registers announced runtimes and drops the ones whose announcement was withdrawn."""
    now = time.time()
    seen = set()
    for a in announcements:
        try:
            if a.get("expires_at") and a["expires_at"] < now:
                continue
            ttl = (a["expires_at"] - now) / 60 if a.get("expires_at") else None
            current = get(a["id"])
            if not current or current.get("base_url") != a["base_url"].rstrip("/") or current.get("api_key") != a.get("api_key"):
                register(a["id"], a["kind"], a["base_url"], api_key=a.get("api_key"), label=a.get("label"), ttl_minutes=ttl)
            with _lock:
                _backends[a["id"]]["source"] = "announce"
            seen.add(a["id"])
        except (KeyError, ValueError):
            continue
    with _lock:
        stale = [k for k, b in _backends.items() if b.get("source") == "announce" and k not in seen]
        for k in stale:
            del _backends[k]
        if stale:
            _save()
    return sorted(seen)
