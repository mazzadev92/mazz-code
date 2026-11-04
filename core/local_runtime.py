"""Local llama-server supervisor: one model in RAM at a time (i5-6500, 15 GB), swapped on demand.

A request for a local model that is not loaded stops the llama-server listening on LOCAL_PORT and starts
it again with the requested GGUF. Swaps are serialized; requests wait for the new model instead of
hitting a half-started server. The server already running when MAZZ Control starts is adopted as is.
"""
import asyncio
import os
import re
import subprocess
import time

import httpx
import psutil

from . import job_object
from .gguf_meta import read_gguf_metadata
from .secret_file import ensure_secret_file

LLAMA_SERVER = r"D:\MAZZ GPU ACX\build\llama-avx2\bin\Release\llama-server.exe"
LOCAL_HOST = "127.0.0.1"
LOCAL_PORT = 8080
LOG_FILE = os.path.expandvars(r"%USERPROFILE%\.mazz\llama-server.log")
SLOT_DIR = os.path.expandvars(r"%USERPROFILE%\.mazz\slots")
# Shared with Studio (packages/shared/src/llama-key.ts). The gateway passes the path, never the value,
# so neither `ps` nor the gateway log ever shows the key; every local client sends it as a Bearer token.
LLAMA_KEY_FILE = os.path.expandvars(r"%USERPROFILE%\.mazz\llama.key")
# Same flags as the hand-started server, plus a q8_0 KV cache so the context costs half the RAM.
# Prefix reuse (spec 06 §3): --cache-reuse and --slot-save-path cost no RAM. A single slot on purpose: the
# gateway serializes local requests, and --parallel 8 would split the context in 8 (or grow the KV cache).
BASE_ARGS = ["--host", LOCAL_HOST, "--port", str(LOCAL_PORT), "-t", "4", "--jinja", "--reasoning", "off",
             "-ctk", "q8_0", "-ctv", "q8_0", "--metrics", "--parallel", "1", "--cache-reuse", "256",
             "--slot-save-path", SLOT_DIR, "--api-key-file", LLAMA_KEY_FILE]
START_TIMEOUT_S = 240
REPACK_MAX_BYTES = 4 * 1024**3
# Context per model size (spec 05 §2.1): 16k for the <= 4B daily driver, 4k for the 14B one-shot reviewer.
# Without a size label, file size stands in (a 4B is <= 4.5 GB up to Q8_0).
SMALL_MODEL_BYTES = int(4.5 * 1024**3)


def _params_billions(size_label):
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([BM])\s*", size_label or "", re.IGNORECASE)
    if not m:
        return None
    return float(m.group(1)) / (1000 if m.group(2).upper() == "M" else 1)


def context_size(size_bytes, size_label=None):
    params = _params_billions(size_label)
    if params is None:
        return 16384 if size_bytes <= SMALL_MODEL_BYTES else 8192
    if params <= 4.5:
        return 16384
    return 8192 if params <= 9 else 4096


def build_args(model_path, size_bytes, size_label=None):
    """llama-server command line for `model_path` (pure: no file access)."""
    # Weight repacking copies the whole model into RAM (6.4 GB for the 14B) on top of the mmap:
    # above REPACK_MAX_BYTES the weights are served straight from the mapped file instead.
    extra = ["--no-repack"] if size_bytes > REPACK_MAX_BYTES else []
    return [LLAMA_SERVER, "-m", model_path, "-c", str(context_size(size_bytes, size_label)), *BASE_ARGS, *extra]

_swap_lock = asyncio.Lock()
state = {"phase": "unknown", "model_path": None, "pid": None, "job": None, "error": None, "since": time.time()}


def base_url():
    return f"http://{LOCAL_HOST}:{LOCAL_PORT}"


def api_key():
    """Shared llama-server key, created on first use with a user-only ACL."""
    return ensure_secret_file(LLAMA_KEY_FILE)


def headers():
    """Authorization header for the local llama-server (harmless when it runs without a key)."""
    return {"Content-Type": "application/json", "Authorization": f"Bearer {api_key()}"}


async def loaded_model(client):
    """Path of the GGUF the running server holds, or None when nothing answers."""
    try:
        r = await client.get(f"{base_url()}/props", headers=headers(), timeout=3.0)
        r.raise_for_status()
        return r.json().get("model_path")
    except Exception:
        return None


def listener_pid(port):
    """PID listening on `port` (loopback or wildcard), or None when the port is free.

    psutil can only see other users' sockets when elevated; an inaccessible table is treated as
    "unknown" and the caller keeps its safe fallback instead of guessing an owner.
    """
    try:
        for conn in psutil.net_connections(kind="inet"):
            if conn.status != psutil.CONN_LISTEN or not conn.laddr:
                continue
            if conn.laddr.port != port or conn.laddr.ip not in (LOCAL_HOST, "0.0.0.0", "::1", "::"):
                continue
            if conn.pid:
                return conn.pid
    except (psutil.Error, OSError):
        return None
    return None


def _process_name(pid):
    try:
        return (psutil.Process(pid).name() or "").lower()
    except psutil.Error:
        return ""


def is_llama_server(pid):
    """The process is OUR llama-server binary: the name alone could be a renamed foreign executable."""
    if not pid or _process_name(pid) != "llama-server.exe":
        return False
    try:
        return os.path.normcase(psutil.Process(pid).exe()) == os.path.normcase(LLAMA_SERVER)
    except psutil.Error:
        return False


def port_owned_by_llama(port):
    """None when nothing listens, True for llama-server, False for any other process."""
    pid = listener_pid(port)
    return None if pid is None else is_llama_server(pid)


def _servers_on_port():
    """The single llama-server this gateway started, if it is still alive.

    An external llama-server is never returned: killing a process the gateway did not create would
    break another tool's runtime. Swaps refuse that case in `ensure_loaded` instead.
    """
    pid = state.get("pid")
    if not pid or not is_llama_server(pid):
        return []
    try:
        return [(psutil.Process(pid), True)]
    except psutil.Error:
        return []


def _stop_servers():
    job = state.pop("job", None)
    if job:
        job_object.close(job)
    procs = []
    for p, ours in _servers_on_port():
        origin = "lancé par la passerelle" if ours else "externe"
        print(f"[LLAMA] arrêt de llama-server PID {p.pid} ({origin})", flush=True)
        procs.append(p)
    for p in procs:
        try:
            p.terminate()
        except psutil.Error:
            pass
    _gone, alive = psutil.wait_procs(procs, timeout=15)
    for p in alive:
        try:
            p.kill()
        except psutil.Error:
            pass
    return len(procs)


def _same_file(a, b):
    try:
        return os.path.samefile(a, b)
    except OSError:
        return os.path.normcase(os.path.abspath(a or "")) == os.path.normcase(os.path.abspath(b or ""))


async def ensure_loaded(client, model_path):
    """Makes the local server hold `model_path`. Returns the swap duration in seconds (0 when already loaded)."""
    async with _swap_lock:
        current = await loaded_model(client)
        if current and _same_file(current, model_path):
            # Adopt the live listener only if it really is llama-server: a random process answering
            # /props must never be recorded as ours (a later swap would then kill it).
            owner = listener_pid(LOCAL_PORT)
            if owner and is_llama_server(owner):
                state.update(phase="ready", model_path=current, pid=owner, error=None)
                return 0.0
        owner = listener_pid(LOCAL_PORT)
        if owner and owner != state.get("pid"):
            if not is_llama_server(owner):
                raise RuntimeError(
                    f"port {LOCAL_PORT} occupé par un processus étranger (PID {owner}, "
                    f"{_process_name(owner) or 'inconnu'}) : arrêtez-le ou changez son port"
                )
            raise RuntimeError(
                f"port {LOCAL_PORT} déjà utilisé par un llama-server externe (PID {owner}) : "
                "arrêtez-le ou laissez la passerelle démarrer le sien"
            )
        started = time.time()
        state.update(phase="switching", model_path=model_path, error=None, since=started)
        await asyncio.to_thread(_stop_servers)
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        os.makedirs(SLOT_DIR, exist_ok=True)
        api_key()  # create the key file before llama-server reads it
        log = open(LOG_FILE, "ab")
        try:
            size_label = read_gguf_metadata(model_path).get("general.size_label")
        except Exception:  # unreadable header: the file size decides the context
            size_label = None
        proc = subprocess.Popen(
            build_args(model_path, os.path.getsize(model_path), size_label),
            stdout=log, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        state["pid"] = proc.pid
        state["job"] = job_object.attach(proc.pid)
        # Load time grows with size on this disk (14B: several minutes while Windows pages the file in).
        timeout = START_TIMEOUT_S + 45 * os.path.getsize(model_path) / 1024**3
        while time.time() - started < timeout:
            if proc.poll() is not None:
                state.update(phase="error", error=f"llama-server s'est arrêté (code {proc.returncode}), voir {LOG_FILE}")
                raise RuntimeError(state["error"])
            try:
                r = await client.get(f"{base_url()}/health", timeout=2.0)
                if r.status_code == 200:
                    state.update(phase="ready", since=time.time())
                    return round(time.time() - started, 1)
            except Exception:
                pass
            await asyncio.sleep(1.0)
        state.update(phase="error", error=f"llama-server non prêt après {START_TIMEOUT_S} s")
        raise RuntimeError(state["error"])


async def stop():
    async with _swap_lock:
        n = await asyncio.to_thread(_stop_servers)
        state.update(phase="stopped", model_path=None, pid=None, since=time.time())
        return n
