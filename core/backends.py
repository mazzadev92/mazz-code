"""Registry of inference backends: the local llama-server plus any remote GPU runtime (Kaggle, Colab)
or external API the user adds. A backend is only routed to while its health probe succeeds.

Remote runtimes announce themselves (URL + key) through POST /api/backends, either pasted in the Studio
or written by the notebook. Entries persist in %USERPROFILE%\\.mazz\\backends.json (keys included, user-only
file) and expire at `expires_at` so a stopped Colab tunnel is not retried forever.
"""
import json
import os
import re
import time
import threading

import httpx

STORE = os.path.expandvars(r"%USERPROFILE%\.mazz\backends.json")
KINDS = ("local", "kaggle", "colab", "modal", "api")
HEALTH_TTL = 15.0

_lock = threading.Lock()
_backends = {}


def _load():
    try:
        with open(STORE, "r", encoding="utf-8") as f:
            for b in json.load(f):
                _backends[b["id"]] = b
    except (FileNotFoundError, ValueError):
        pass


def _save():
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    remote = [b for b in _backends.values() if b["kind"] != "local"]
    tmp = STORE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(remote, f, indent=1)
    os.replace(tmp, STORE)


def init(local_url):
    with _lock:
        _load()
        _backends["local"] = {
            "id": "local", "kind": "local", "label": "llama-server local", "base_url": local_url.rstrip("/"),
            "api_key": None, "models": [], "healthy": None, "checked_at": 0.0, "expires_at": None, "error": None,
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
            found.append(json.load(f))
    return found


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
