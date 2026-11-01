import os
import json
import uuid
import time
import subprocess
from kaggle.api.kaggle_api_extended import KaggleApi

KERNEL_DIR = r"d:\Mazz Code\mazz_control\kaggle_serve"
os.makedirs(KERNEL_DIR, exist_ok=True)

def get_kaggle_api():
    api = KaggleApi()
    api.authenticate()
    return api

def generate_kernel_source(model_filename="Mazz-Technos-Code-3B.IQ4_XS.gguf", idle_timeout_minutes=30):
    """Genere le script python du kernel Kaggle GPU avec auto-extinction par inactivite."""
    code = f'''# MAZZ REMOTE GPU INFERENCE SERVER (Kaggle Tesla T4)
# Modele: {model_filename}
# Auto-stop inactivite: {idle_timeout_minutes} minutes

import subprocess, time, os, sys, re, secrets, urllib.request, threading
from datetime import datetime

print("=== MAZZ REMOTE GPU SERVER STARTING ===", flush=True)
IDLE_TIMEOUT_SEC = {idle_timeout_minutes} * 60
last_active_time = time.time()
stop_requested = False

# 1. Dependances : llama.cpp binaire Linux CUDA et cloudflared
sh = lambda *c: subprocess.run(list(c), check=True)
os.makedirs("/kaggle/working/bin", exist_ok=True)

print("Installation de cloudflared...", flush=True)
sh("wget", "-q", "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", "-O", "/kaggle/working/bin/cloudflared")
sh("chmod", "+x", "/kaggle/working/bin/cloudflared")

print("Recuperation du binaire llama-server CUDA...", flush=True)
# Telechargement binaire precompile llama.cpp CUDA pour Ubuntu
url_llama = "https://github.com/ggml-org/llama.cpp/releases/download/b4816/llama-b4816-bin-ubuntu-x64.zip"
try:
    sh("wget", "-q", url_llama, "-O", "/kaggle/working/llama.zip")
    sh("unzip", "-q", "-o", "/kaggle/working/llama.zip", "-d", "/kaggle/working/bin")
    sh("chmod", "+x", "/kaggle/working/bin/llama-server")
except Exception as e:
    print("Repli sur compilation ou asset alternatif:", e, flush=True)

# 2. Localisation du modele GGUF
# Recherche dans /kaggle/input (dataset monte instantanement) ou telechargement HF
target_model = "{model_filename}"
model_path = None
for root, _, files in os.walk("/kaggle/input"):
    for f in files:
        if f.lower() == target_model.lower() or f.endswith(".gguf"):
            model_path = os.path.join(root, f)
            print(f"Modele monte trouve dans /kaggle/input : {{model_path}}", flush=True)
            break
    if model_path: break

if not model_path:
    # Telechargement direct depuis Hugging Face prive si non present dans input
    from huggingface_hub import hf_hub_download
    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        try:
            from kaggle_secrets import UserSecretClient
            hf_token = UserSecretClient().get_secret("HF_TOKEN")
        except: pass
    print("Telechargement depuis Hugging Face mazz92/mazz-models...", flush=True)
    model_path = hf_hub_download("mazz92/mazz-models", target_model, local_dir="/kaggle/working", token=hf_token)

print(f"Modele pret a l'emploi : {{model_path}} ({{os.path.getsize(model_path)/(1024**3):.2f}} Go)", flush=True)

# 3. Cle d'API aleatoire securisee
API_KEY = "mazz_" + secrets.token_hex(24)
with open("/kaggle/working/api_key.txt", "w") as f:
    f.write(API_KEY)
print(f"API_KEY:{{API_KEY}}", flush=True)

# 4. Lancement de llama-server avec GPU T4
# -ngl 99 pour decharger 100% des couches sur la VRAM Tesla T4 (16 Go)
srv_log = open("/kaggle/working/srv.log", "w")
proc_srv = subprocess.Popen([
    "/kaggle/working/bin/llama-server",
    "-m", model_path,
    "--host", "127.0.0.1", "--port", "8080",
    "-ngl", "99",
    "-c", "16384",
    "-np", "2",
    "--api-key", API_KEY,
    "--jinja",
    "-t", "4"
], stdout=srv_log, stderr=subprocess.STDOUT)

# Attente active que le serveur reponde 200 sur /health
srv_ready = False
for _ in range(60):
    try:
        req = urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=2)
        if req.status == 200:
            srv_ready = True
            print("SERVEUR LLAMA GPU INITIALISE AVEC SUCCES", flush=True)
            break
    except:
        time.sleep(2)

if not srv_ready:
    print("ERREUR : llama-server n'a pas repondu /health dans les delais.", flush=True)
    sys.exit(1)

# 5. Lancement du tunnel Cloudflare
tun_log = open("/kaggle/working/tun.log", "w")
proc_tun = subprocess.Popen([
    "/kaggle/working/bin/cloudflared", "tunnel",
    "--url", "http://127.0.0.1:8080",
    "--no-autoupdate"
], stdout=tun_log, stderr=subprocess.STDOUT)

# Extraction de l'URL du tunnel
tunnel_url = None
for _ in range(25):
    time.sleep(1)
    if os.path.exists("/kaggle/working/tun.log"):
        txt = open("/kaggle/working/tun.log", "r", errors="ignore").read()
        m = re.search(r"https://[a-zA-Z0-9-]+\\.trycloudflare\\.com", txt)
        if m:
            tunnel_url = m.group(0)
            break

if tunnel_url:
    print("=" * 60, flush=True)
    print(f"TUNNEL_ENDPOINT:{{tunnel_url}}", flush=True)
    print(f"API_KEY:{{API_KEY}}", flush=True)
    print(f"MODEL_LOADED:{{target_model}}", flush=True)
    print("=" * 60, flush=True)
    with open("/kaggle/working/tunnel_info.json", "w") as f:
        f.write(json.dumps({{"url": tunnel_url, "key": API_KEY, "model": target_model}}))
else:
    print("ERREUR : Impossible de generer l'URL Cloudflare.", flush=True)
    sys.exit(1)

# 6. Boucle de surveillance avec AUTO-STOP par inactivite
print(f"Surveillance active : arret automatique apres {{IDLE_TIMEOUT_SEC // 60}} min d'inactivite.", flush=True)
start_ts = time.time()
MAX_SESSION_SEC = 11.5 * 3600  # Garde-fou 11h30 pour eviter le hard-kill Kaggle

while True:
    time.sleep(15)
    now = time.time()
    
    # Verification du drapeau d'arret cooperatif
    if os.path.exists("/kaggle/working/STOP"):
        print("[COMMANDE ARRET] Drapeau STOP detecte. Extinction propre.", flush=True)
        break
        
    # Verification du temps maximal
    if now - start_ts > MAX_SESSION_SEC:
        print("[GARDE-FOU] Limite de 11h30 atteinte. Extinction automatique.", flush=True)
        break
        
    # Sondage d'activite via /health de llama-server
    try:
        req = urllib.request.urlopen("http://127.0.0.1:8080/slots", timeout=2)
        slots_data = json.loads(req.read().decode())
        is_processing = any(s.get("is_processing", False) for s in slots_data)
        if is_processing:
            last_active_time = now
    except:
        pass
        
    idle_elapsed = now - last_active_time
    if idle_elapsed > IDLE_TIMEOUT_SEC:
        print(f"[AUTO-STOP] Aucun appel depuis {{idle_elapsed // 60}} min. Extinction automatique pour preserver le quota.", flush=True)
        break

# Extinction propre
proc_tun.terminate()
proc_srv.terminate()
print("=== MAZZ REMOTE GPU SERVER ARRETE PROPREMENT ===", flush=True)
os._exit(0)
'''
    return code
