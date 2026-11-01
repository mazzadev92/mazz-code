import os
import sys
import time
import json
import uuid
import requests
import subprocess
from fastapi import FastAPI, Request, Response, BackgroundTasks, UploadFile, File
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from jinja2 import Environment, FileSystemLoader

# Import local modules
sys.path.insert(0, os.path.dirname(__file__))
from core.quota_db import (
    init_db, get_quota_status, register_session_start, register_session_stop,
    update_session_activity, get_active_session, check_inactivity_timeouts
)
from core.models_manager import list_local_models, get_model_by_alias, MODELS_DIR
from core.hf_sync import upload_model_to_hf, list_remote_models

app = FastAPI(title="MAZZ CONTROL API Gateway")

# Enable CORS for local frontends and tools
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), "templates")
jinja_env = Environment(loader=FileSystemLoader(TEMPLATES_DIR))

# Local llama-server endpoint fallback
LOCAL_LLAMA_URL = "http://127.0.0.1:8080"
ACTIVE_LOCAL_MODEL = "Mazz-Technos-Code-3B.IQ4_XS.gguf"

@app.on_event("startup")
def startup_event():
    init_db()

@app.get("/", response_class=HTMLResponse)
def index_page():
    template = jinja_env.get_template("index.html")
    return template.render()

@app.get("/api/quota")
def api_quota():
    check_inactivity_timeouts()
    return get_quota_status()

@app.get("/api/session/status")
def api_session_status():
    global ACTIVE_LOCAL_MODEL
    check_inactivity_timeouts()
    sess = get_active_session()
    
    if sess and sess["status"] == "running":
        uptime = round((time.time() - sess["start_time"]) / 60.0, 1)
        return {
            "active_target": sess["target_type"],
            "current_model": sess["model_name"],
            "active_endpoint": sess["endpoint_url"] or LOCAL_LLAMA_URL,
            "uptime_minutes": uptime,
            "idle_timeout_minutes": sess["idle_timeout_minutes"],
            "tokens_count": sess["tokens_count"],
            "latency_ms": 45 if sess["target_type"] == "kaggle_t4" else 8
        }
    else:
        return {
            "active_target": "local",
            "current_model": ACTIVE_LOCAL_MODEL,
            "active_endpoint": LOCAL_LLAMA_URL,
            "uptime_minutes": 0,
            "idle_timeout_minutes": 30,
            "tokens_count": 0,
            "latency_ms": 5
        }

@app.get("/api/models")
def api_models():
    models = list_local_models()
    for m in models:
        m["is_active"] = (m["filename"].lower() == ACTIVE_LOCAL_MODEL.lower())
    return models

@app.post("/api/models/select-active")
def api_select_active_model(payload: dict):
    global ACTIVE_LOCAL_MODEL
    filename = payload.get("filename", "")
    filename = os.path.basename(filename)
    target_path = os.path.join(MODELS_DIR, filename)
    if not os.path.exists(target_path):
        return JSONResponse({"success": False, "error": f"Fichier introuvable: {filename}"}, status_code=404)
    
    ACTIVE_LOCAL_MODEL = filename
    return {"success": True, "active_model": ACTIVE_LOCAL_MODEL}

@app.post("/api/models/upload-local")
async def api_upload_local(file: UploadFile = File(...)):
    filename = os.path.basename(file.filename)
    if not filename.lower().endswith(".gguf"):
        return JSONResponse({"success": False, "error": "Seuls les fichiers de poids .gguf sont acceptes."}, status_code=400)
    
    os.makedirs(MODELS_DIR, exist_ok=True)
    dest_path = os.path.join(MODELS_DIR, filename)
    bytes_written = 0
    try:
        with open(dest_path, "wb") as f_out:
            while chunk := await file.read(1024 * 1024):  # 1 Mo chunks
                f_out.write(chunk)
                bytes_written += len(chunk)
                
        return {
            "success": True,
            "filename": filename,
            "size_mb": round(bytes_written / (1024**2), 1),
            "size_gb": round(bytes_written / (1024**3), 2),
            "message": f"Modele {filename} importe avec succes dans le catalogue MAZZ."
        }
    except Exception as e:
        if os.path.exists(dest_path):
            try:
                os.remove(dest_path)
            except:
                pass
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)

@app.post("/api/models/delete")
def api_delete_model(payload: dict):
    filename = payload.get("filename", "")
    filename = os.path.basename(filename)
    if not filename.lower().endswith(".gguf"):
        return JSONResponse({"success": False, "error": "Nom de fichier invalide."}, status_code=400)
        
    target_path = os.path.join(MODELS_DIR, filename)
    if not os.path.exists(target_path):
        return JSONResponse({"success": False, "error": "Fichier introuvable sur le disque local."}, status_code=404)
        
    try:
        os.remove(target_path)
        return {"success": True, "message": f"Modele {filename} supprime du disque local."}
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)

@app.post("/api/session/start")
def api_session_start(payload: dict):
    model_name = payload.get("model_name", "Mazz-Technos-Code-3B.IQ4_XS.gguf")
    idle_timeout = payload.get("idle_timeout_minutes", 30)
    
    quota = get_quota_status()
    if quota["alert_level"] == "blocked":
        return {"success": False, "error": "Quota hebdomadaire Kaggle epuise (> 29h). Fallback local actif."}
        
    session_id = str(uuid.uuid4())[:8]
    register_session_start(
        session_uuid=session_id,
        model_name=model_name,
        target_type="kaggle_t4",
        idle_timeout_minutes=idle_timeout,
        endpoint_url=None
    )
    return {"success": True, "session_uuid": session_id, "model": model_name}

@app.post("/api/session/stop")
def api_session_stop():
    sess = get_active_session()
    if sess:
        dur = register_session_stop(sess["session_uuid"], status="completed")
        return {"success": True, "duration_minutes": dur}
    return {"success": True, "duration_minutes": 0}

@app.post("/api/models/upload-hf")
def api_upload_hf(payload: dict, background_tasks: BackgroundTasks):
    filepath = payload.get("filepath")
    filename = payload.get("filename")
    
    if not filepath or not os.path.exists(filepath):
        return {"status": "error", "message": f"Fichier non trouve: {filepath}"}
        
    def do_upload():
        try:
            upload_model_to_hf(filepath, remote_filename=filename)
        except Exception as e:
            print("Erreur upload HF:", e)
            
    background_tasks.add_task(do_upload)
    return {"status": "started", "message": f"Televersement lance en arriere-plan pour {filename}"}

# ==========================================
# OPENAI COMPATIBLE INFERENCE API (/v1/...)
# ==========================================

@app.get("/v1/models")
def openai_models():
    local_m = list_local_models()
    data = []
    for m in local_m:
        data.append({
            "id": m["id"],
            "object": "model",
            "created": int(time.time()),
            "owned_by": "mazz-technos"
        })
    return {"object": "list", "data": data}

@app.post("/v1/chat/completions")
async def openai_chat_completions(request: Request):
    body = await request.json()
    stream = body.get("stream", False)
    
    # Check if active remote GPU session is present and ready
    sess = get_active_session()
    target_url = LOCAL_LLAMA_URL
    api_key = None
    target_type = "local"
    
    if sess and sess["target_type"] == "kaggle_t4" and sess.get("endpoint_url"):
        target_url = sess["endpoint_url"]
        api_key = sess.get("api_key")
        target_type = "kaggle_t4"
        
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
        
    dest_endpoint = f"{target_url.rstrip('/')}/v1/chat/completions"
    
    try:
        if stream:
            r = requests.post(dest_endpoint, json=body, headers=headers, stream=True, timeout=120)
            if sess:
                update_session_activity(sess["session_uuid"], tokens_added=50)
            return StreamingResponse(r.iter_content(chunk_size=1024), media_type="text/event-stream")
        else:
            r = requests.post(dest_endpoint, json=body, headers=headers, timeout=120)
            res_data = r.json()
            comp_tokens = res_data.get("usage", {}).get("completion_tokens", 0)
            if sess:
                update_session_activity(sess["session_uuid"], tokens_added=comp_tokens)
            return JSONResponse(res_data)
            
    except Exception as e:
        # Transparent fallback to local if remote failed
        if target_type == "kaggle_t4":
            print(f"[FALLBACK] Echec remote {target_url}: {e}. Bascule atomique sur local {LOCAL_LLAMA_URL}...")
            fallback_dest = f"{LOCAL_LLAMA_URL}/v1/chat/completions"
            r = requests.post(fallback_dest, json=body, headers={"Content-Type": "application/json"}, timeout=120)
            return JSONResponse(r.json())
        else:
            return JSONResponse({"error": str(e)}, status_code=500)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=7070)
