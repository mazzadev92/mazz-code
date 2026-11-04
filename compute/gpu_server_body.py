# Body of the remote GPU server (from notebook 03). compute/serverscript.py prepends the parameter block.
# Runs on Kaggle, Colab, Saturn or any GPU box: llama.cpp (GGUF) or vLLM, Cloudflare tunnel, announcement, automatic stop.
import os, sys, time, json, secrets, subprocess, threading, re, shutil, urllib.request

def load_hf_token():
    try:
        from google.colab import userdata
        return userdata.get("HF_TOKEN")
    except Exception:  # not on Colab: try the next source
        pass
    try:
        from kaggle_secrets import UserSecretClient
        return UserSecretClient().get_secret("HF_TOKEN")
    except Exception:  # not on Kaggle: fall back to the environment variable
        pass
    return os.environ.get("HF_TOKEN")

HF_TOKEN = load_hf_token()
assert HF_TOKEN, "HF_TOKEN absent : ajoute-le dans les secrets Colab ou Kaggle"
ON_COLAB = "google.colab" in sys.modules or os.path.exists("/content")
ON_KAGGLE = os.path.exists("/kaggle")
WORK = "/content" if ON_COLAB else "/kaggle/working" if ON_KAGGLE else os.getcwd()
# Only NONCE is announced: MAZZ Control derives the same key from the HF token it already holds.
import hmac, hashlib
NONCE = secrets.token_hex(16)
API_KEY = hmac.new(HF_TOKEN.encode(), f"mazz-backend:{NONCE}".encode(), hashlib.sha256).hexdigest()
PORT = 8000
GPU = shutil.which("nvidia-smi") and subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip()
assert GPU, "Aucun GPU : Colab > Exécution > Modifier le type d'exécution > A100 ou L4 (Kaggle : Accelerator GPU T4 x2)"
print("GPU :", GPU)


# Installation (vLLM ou llama.cpp CUDA) et cloudflared
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "huggingface_hub>=0.28"], check=True)
if ENGINE == "vllm":
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "vllm"], check=True)
else:
    # Roue CUDA précompilée de llama-cpp-python : serveur OpenAI compatible, toutes couches sur le GPU.
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "llama-cpp-python[server]",
                    "--extra-index-url", "https://abetlen.github.io/llama-cpp-python/whl/cu124"], check=True)
    # La roue cu124 veut libcudart.so.12 : absente des images CUDA 13 (Kaggle). On l'apporte par pip.
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "nvidia-cuda-runtime-cu12", "nvidia-cublas-cu12"], check=True)
CF = os.path.join(WORK, "cloudflared")
if not os.path.exists(CF):
    urllib.request.urlretrieve("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", CF)
    os.chmod(CF, 0o755)


# Démarrage du serveur d'inférence
from huggingface_hub import hf_hub_download, HfApi
os.environ["HF_TOKEN"] = HF_TOKEN
log = open(os.path.join(WORK, "server.log"), "w")
if ENGINE == "vllm":
    cmd = [sys.executable, "-m", "vllm.entrypoints.openai.api_server", "--model", MODEL,
           "--served-model-name", SERVED_NAME, "--port", str(PORT), "--api-key", API_KEY,
           "--max-model-len", str(MAX_MODEL_LEN), "--gpu-memory-utilization", "0.90",
           "--enable-auto-tool-choice", "--tool-call-parser", "hermes"]
else:
    gguf = hf_hub_download(HF_REPO, MODEL, token=HF_TOKEN, local_dir=WORK)
    cmd = [sys.executable, "-m", "llama_cpp.server", "--model", gguf, "--model_alias", SERVED_NAME,
           "--n_gpu_layers", "-1", "--n_ctx", str(MAX_MODEL_LEN), "--port", str(PORT), "--api_key", API_KEY,
           "--chat_format", "chatml-function-calling"]
import glob, site
_libs = [d for sp in site.getsitepackages() for d in glob.glob(os.path.join(sp, "nvidia", "*", "lib"))]
_env = dict(os.environ, LD_LIBRARY_PATH=":".join(_libs + [os.environ.get("LD_LIBRARY_PATH", "")]))
server = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, env=_env)

def healthy():
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/models", headers={"Authorization": f"Bearer {API_KEY}"})
        return urllib.request.urlopen(req, timeout=3).status == 200
    except Exception:
        return False

t0 = time.time()
while not healthy():
    if server.poll() is not None:
        raise RuntimeError("Le serveur s'est arrêté : voir server.log\n" + open(os.path.join(WORK, "server.log")).read()[-3000:])
    if time.time() - t0 > 1800:
        raise RuntimeError("Serveur non prêt après 30 min")
    time.sleep(5)
print(f"Serveur prêt en {time.time() - t0:.0f} s")


# Tunnel Cloudflare (stderr drainé en continu pour ne jamais bloquer cloudflared)
tunnel = subprocess.Popen([CF, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{PORT}"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
TUNNEL_URL = None
found = threading.Event()
def drain():
    global TUNNEL_URL
    for line in tunnel.stderr:
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
        if m and not TUNNEL_URL:
            TUNNEL_URL = m.group(0)
            found.set()
threading.Thread(target=drain, daemon=True).start()
if not found.wait(120):
    raise RuntimeError("URL du tunnel introuvable après 120 s")
print("Tunnel :", TUNNEL_URL)


# Annonce à MAZZ Control (dépôt privé), surveillance d'inactivité, arrêt garanti
api = HfApi(token=HF_TOKEN)
ANNOUNCE = f"_backends/{BACKEND_ID}.json"
kind = "colab" if ON_COLAB else "kaggle" if ON_KAGGLE else "api"
started = time.time()

def announce():
    body = {"id": BACKEND_ID, "kind": kind, "base_url": TUNNEL_URL, "nonce": NONCE, "label": f"{SERVED_NAME} ({kind})",
            "expires_at": started + MAX_HOURS * 3600}
    api.upload_file(path_or_fileobj=json.dumps(body).encode(), path_in_repo=ANNOUNCE, repo_id="mazz92/mazz-models",
                    commit_message=f"backend {BACKEND_ID} up")

def withdraw():
    try:
        api.delete_file(ANNOUNCE, repo_id="mazz92/mazz-models", commit_message=f"backend {BACKEND_ID} down")
    except Exception as exc:
        print("Retrait de l'annonce impossible :", exc)

def requests_done():
    # vLLM : compteur Prometheus ; llama-cpp-python : taille du journal (une ligne par requête).
    if ENGINE == "vllm":
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{PORT}/metrics", headers={"Authorization": f"Bearer {API_KEY}"})
            text = urllib.request.urlopen(req, timeout=3).read().decode()
            running = sum(float(v) for v in re.findall(r"^vllm:num_requests_running\{[^}]*\} ([0-9.e+]+)", text, re.M))
            done = sum(float(v) for v in re.findall(r"^vllm:request_success_total\{[^}]*\} ([0-9.e+]+)", text, re.M))
            return done + running * 1e6
        except Exception:
            return None
    return os.path.getsize(os.path.join(WORK, "server.log"))

announce()
print(f"Annoncé. Dans le Studio : modèle {BACKEND_ID}/{SERVED_NAME}. Arrêt après {IDLE_MINUTES} min d'inactivité ou {MAX_HOURS} h.")
last_value, last_active = requests_done(), time.time()
reason = "?"
try:
    while True:
        time.sleep(30)
        value = requests_done()
        if value is not None and value != last_value:
            last_value, last_active = value, time.time()
        if server.poll() is not None:
            reason = "serveur arrêté"; break
        if time.time() - last_active > IDLE_MINUTES * 60:
            reason = f"{IDLE_MINUTES} min sans requête"; break
        if time.time() - started > MAX_HOURS * 3600:
            reason = f"durée max {MAX_HOURS} h"; break
except KeyboardInterrupt:
    reason = "interruption manuelle"
finally:
    print("Arrêt :", reason)
    withdraw()
    for p in (tunnel, server):
        p.terminate()
    if ON_COLAB:
        from google.colab import runtime
        runtime.unassign()   # libère le GPU : plus aucune unité de calcul consommée
    elif ON_KAGGLE:
        os._exit(0)
