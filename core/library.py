"""Model library: every GGUF the user owns, on disk and on the private Hugging Face repo (Mazz Cloud).

Each entry says what the model really is (read from its GGUF header, not guessed from the file name) and
whether it fits in this machine's RAM. Nothing here is estimated speed: speeds come from measurements.
"""
import os
import glob
import time
import threading

import psutil

from . import local_runtime
from .gguf_meta import read_gguf_metadata
from .hf_sync import REPO_ID, get_hf_token
from .paths import mazz_path

def _model_dirs():
    """MAZZ_MODEL_DIRS (os.pathsep-separated), else <MAZZ_HOME>/models plus the owner's legacy folders when present."""
    env = os.environ.get("MAZZ_MODEL_DIRS", "")
    if env.strip():
        return [d for d in env.split(os.pathsep) if d.strip()]
    legacy = [os.path.join("D:" + os.sep, "Models Locaux", n) for n in ("Mazz models", "Models non censure")]
    return [mazz_path("models")] + [d for d in legacy if os.path.isdir(d)]


MODEL_DIRS = _model_dirs()
# RAM kept free for Windows, the Studio and the browser when deciding whether a model fits locally.
RESERVED_RAM_BYTES = int(3.0 * 1024**3)
# llama.cpp needs the weights plus KV cache and compute buffers; 15 % covers an 8k context at q8 KV.
RUNTIME_OVERHEAD = 1.15
# Spec 00 / 09: working model + 0.6B compaction server stay under 11.5 GB, whatever the machine.
RAM_CEILING_BYTES = int(11.5 * 1024**3)
COMPACTOR_FILE = "Mazz-Technos-Draft-0.6B.Q4_K_M.gguf"
# Model registry lifecycle (spec 04 §1).
DISCOVERED, LOCAL_AVAILABLE, RUNNING = "DISCOVERED", "LOCAL_AVAILABLE", "RUNNING"

_meta_cache = {}
_cloud_cache = {"at": 0.0, "files": None, "error": None}
_lock = threading.Lock()


def model_id(filename):
    return filename[:-5] if filename.lower().endswith(".gguf") else filename


def _metadata(path):
    stat = os.stat(path)
    key = (path, stat.st_size, int(stat.st_mtime))
    with _lock:
        if key in _meta_cache:
            return _meta_cache[key]
    try:
        meta = read_gguf_metadata(path)
        meta.pop("gguf_version", None)
    except Exception as exc:  # incomplete download, not a GGUF
        meta = {"error": str(exc)}
    with _lock:
        _meta_cache[key] = meta
    return meta


def compactor_ram_bytes():
    """RAM of the 0.6B compaction server that runs beside the working model; 0 when its GGUF is absent."""
    for directory in MODEL_DIRS:
        path = os.path.join(directory, COMPACTOR_FILE)
        if os.path.isfile(path):
            return int(os.path.getsize(path) * RUNTIME_OVERHEAD)
    return 0


def fit_for_local(size_bytes, total_ram=None, compactor_bytes=None):
    total = total_ram if total_ram is not None else psutil.virtual_memory().total
    compactor = compactor_bytes if compactor_bytes is not None else compactor_ram_bytes()
    need = int(size_bytes * RUNTIME_OVERHEAD)
    budget = min(RAM_CEILING_BYTES, total - RESERVED_RAM_BYTES)
    return {"ram_needed_bytes": need, "ram_budget_bytes": budget, "fits_local": need + compactor <= budget}


def _lifecycle(path, readable):
    rt = local_runtime.state
    if rt.get("phase") == "ready" and rt.get("model_path") and local_runtime._same_file(rt["model_path"], path):
        return RUNNING
    return LOCAL_AVAILABLE if readable else DISCOVERED


def list_local():
    models = []
    seen = set()
    compactor = compactor_ram_bytes()
    for directory in MODEL_DIRS:
        for path in sorted(glob.glob(os.path.join(directory, "*.gguf"))):
            filename = os.path.basename(path)
            mid = model_id(filename)
            if mid.lower() in seen:
                continue
            seen.add(mid.lower())
            size = os.path.getsize(path)
            meta = _metadata(path)
            arch = meta.get("general.architecture")
            models.append({
                "id": mid,
                "filename": filename,
                "path": path,
                "folder": os.path.basename(directory),
                "size_bytes": size,
                "name": meta.get("general.name"),
                "architecture": arch,
                "size_label": meta.get("general.size_label"),
                "quant": meta.get("quant"),
                "context_length": meta.get(f"{arch}.context_length") if arch else None,
                "readable": "error" not in meta,
                "error": meta.get("error"),
                "lifecycle_state": _lifecycle(path, "error" not in meta),
                **fit_for_local(size, compactor_bytes=compactor),
            })
    return models


def find_local(mid):
    wanted = mid.lower().removesuffix(".gguf")
    for m in list_local():
        if m["id"].lower() == wanted:
            return m
    return None


def list_cloud(max_age=60.0):
    """GGUF files on the private repo, cached for `max_age` seconds. Returns (files, error)."""
    now = time.time()
    if _cloud_cache["files"] is not None and now - _cloud_cache["at"] < max_age:
        return _cloud_cache["files"], _cloud_cache["error"]
    token = get_hf_token()
    if not token:
        return [], f"HF_TOKEN absent ({mazz_path('env')})"
    try:
        from huggingface_hub import HfApi
        api = HfApi(token=token)
        files = []
        for entry in api.list_repo_tree(repo_id=REPO_ID, repo_type="model", recursive=True):
            path = getattr(entry, "path", "")
            if not path.lower().endswith(".gguf"):
                continue
            size = getattr(entry, "size", None) or 0
            files.append({"id": model_id(os.path.basename(path)), "repo_path": path, "size_bytes": size,
                          "lifecycle_state": DISCOVERED, **fit_for_local(size)})
        _cloud_cache.update(at=now, files=files, error=None)
    except Exception as exc:
        _cloud_cache.update(at=now, files=_cloud_cache["files"] or [], error=str(exc))
    return _cloud_cache["files"], _cloud_cache["error"]


def library():
    local = list_local()
    cloud, cloud_error = list_cloud()
    local_ids = {m["id"].lower() for m in local}
    for c in cloud:
        c["downloaded"] = c["id"].lower() in local_ids
        c["lifecycle_state"] = LOCAL_AVAILABLE if c["downloaded"] else DISCOVERED
    vm = psutil.virtual_memory()
    return {
        "machine": {"ram_total_bytes": vm.total, "ram_available_bytes": vm.available, "reserved_bytes": RESERVED_RAM_BYTES},
        "local": local,
        "cloud": cloud,
        "cloud_repo": REPO_ID,
        "cloud_error": cloud_error,
    }
