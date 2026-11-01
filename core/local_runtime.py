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

from .gguf_meta import read_gguf_metadata

LLAMA_SERVER = r"D:\MAZZ GPU ACX\build\llama-avx2\bin\Release\llama-server.exe"
LOCAL_HOST = "127.0.0.1"
LOCAL_PORT = 8080
LOG_FILE = os.path.expandvars(r"%USERPROFILE%\.mazz\llama-server.log")
SLOT_DIR = os.path.expandvars(r"%USERPROFILE%\.mazz\slots")
# Same flags as the hand-started server, plus a q8_0 KV cache so the context costs half the RAM.
# Prefix reuse (spec 06 §3): --cache-reuse and --slot-save-path cost no RAM. A single slot on purpose: the
# gateway serializes local requests, and --parallel 8 would split the context in 8 (or grow the KV cache).
BASE_ARGS = ["--host", LOCAL_HOST, "--port", str(LOCAL_PORT), "-t", "4", "--jinja", "--reasoning", "off",
             "-ctk", "q8_0", "-ctv", "q8_0", "--metrics", "--parallel", "1", "--cache-reuse", "256",
             "--slot-save-path", SLOT_DIR]
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
state = {"phase": "unknown", "model_path": None, "pid": None, "error": None, "since": time.time()}


def base_url():
    return f"http://{LOCAL_HOST}:{LOCAL_PORT}"


async def loaded_model(client):
    """Path of the GGUF the running server holds, or None when nothing answers."""
    try:
        r = await client.get(f"{base_url()}/props", timeout=3.0)
        r.raise_for_status()
        return r.json().get("model_path")
    except Exception:
        return None


def _servers_on_port():
    """llama-server processes to stop before a swap: the one this gateway started (state["pid"]) and any other
    started with an explicit `--port LOCAL_PORT`, which would keep the port busy. A llama-server launched by
    another tool on another port (or with no --port) is left alone. Returns [(process, owned_by_gateway)]."""
    found = []
    for p in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            if (p.info["name"] or "").lower() != "llama-server.exe":
                continue
            ours = state.get("pid") is not None and p.info["pid"] == state["pid"]
            cmd = p.info["cmdline"] or []
            on_port = "--port" in cmd and cmd[cmd.index("--port") + 1] == str(LOCAL_PORT)
            if ours or on_port:
                found.append((p, ours))
        except (psutil.Error, ValueError, IndexError):
            continue
    return found


def _stop_servers():
    procs = []
    for p, ours in _servers_on_port():
        origin = "lancé par la passerelle" if ours else f"externe, --port {LOCAL_PORT}"
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
            state.update(phase="ready", model_path=current, error=None)
            return 0.0
        started = time.time()
        state.update(phase="switching", model_path=model_path, error=None, since=started)
        await asyncio.to_thread(_stop_servers)
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        os.makedirs(SLOT_DIR, exist_ok=True)
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
