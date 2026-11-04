"""Library, model, backend and session routes of the dashboard/Studio API.
Gateway state (HTTP client, local slot) is read from the app module at call time so tests can patch it there."""
import os
import uuid

from fastapi import APIRouter, BackgroundTasks, File, Request, UploadFile
from fastapi.responses import JSONResponse

import app as _app
from core import backends, library, local_runtime
from core.hf_sync import upload_model_to_hf
from core.quota_db import get_active_session, get_quota_status, register_session_start, register_session_stop

router = APIRouter()


@router.get("/api/library")
def api_library():
    return library.library()


@router.get("/api/models")
def api_models():
    """Legacy dashboard list: local GGUF files with what the runtime currently holds."""
    loaded = local_runtime.state.get("model_path")
    out = []
    for m in library.list_local():
        out.append({**m, "is_active": bool(loaded) and os.path.normcase(m["path"]) == os.path.normcase(loaded)})
    return out


@router.get("/api/backends")
async def api_backends(request: Request):
    items = backends.all_backends()
    for b in items:
        await backends.probe(_app.http(request), b)
    return [backends.public(b) for b in items]


@router.post("/api/backends")
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
    await backends.probe(_app.http(request), full, force=True)
    return {"success": True, "backend": backends.public(full)}


@router.delete("/api/backends/{backend_id}")
def api_backends_delete(backend_id: str):
    return {"success": backends.remove(backend_id)}


@router.post("/api/run")
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
    # Same rule as /api/models/swap: never reload llama-server under a running generation.
    if _app._local_slot.locked():
        return JSONResponse({"success": False, "error": "Inference in flight, cannot swap"}, status_code=409)
    async with _app._local_slot:
        try:
            seconds = await local_runtime.ensure_loaded(_app.http(request), entry["path"])
        except RuntimeError as exc:
            return JSONResponse({"success": False, "error": str(exc)}, status_code=502)
    return {"success": True, "model": entry["id"], "load_seconds": seconds}


@router.post("/api/models/swap")
async def api_models_swap(request: Request, payload: dict):
    """Swaps the local model, refused while an inference holds the local server (spec 05)."""
    if _app._local_slot.locked():
        return JSONResponse({"success": False, "error": "Inference in flight, cannot swap"}, status_code=409)
    return await api_run(request, {"target": "local", "model": payload.get("model", "")})


@router.post("/api/runtime/stop")
async def api_runtime_stop():
    return {"success": True, "stopped": await local_runtime.stop()}


@router.post("/api/models/select-active")
async def api_select_active_model(request: Request, payload: dict):
    return await api_run(request, {"target": "local", "model": library.model_id(os.path.basename(payload.get("filename", "")))})


@router.post("/api/models/upload-local")
async def api_upload_local(file: UploadFile = File(...)):
    filename = os.path.basename(file.filename or "")
    if not _app.GGUF_NAME.match(filename):
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
    if not _app.GGUF_NAME.match(name):
        return None
    for directory in library.MODEL_DIRS:
        path = os.path.realpath(os.path.join(directory, name))
        if path.startswith(os.path.realpath(directory) + os.sep) and os.path.isfile(path):
            return path
    return None


@router.post("/api/models/delete")
def api_delete_model(payload: dict):
    path = _local_file(payload.get("filename", ""))
    if not path:
        return JSONResponse({"success": False, "error": "Fichier introuvable dans la bibliothèque locale."}, status_code=404)
    loaded = local_runtime.state.get("model_path")
    if loaded and os.path.normcase(loaded) == os.path.normcase(path):
        return JSONResponse({"success": False, "error": "Modèle chargé dans llama-server : l'arrêter avant suppression."}, status_code=409)
    os.remove(path)
    return {"success": True}


@router.post("/api/models/upload-hf")
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


@router.post("/api/session/start")
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


@router.post("/api/session/stop")
def api_session_stop():
    sess = get_active_session()
    if sess:
        return {"success": True, "duration_minutes": register_session_stop(sess["session_uuid"], status="completed")}
    return {"success": True, "duration_minutes": 0}
