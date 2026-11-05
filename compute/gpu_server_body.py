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
elif ENGINE == "diffusers":  # torch is preinstalled on the Kaggle/Colab GPU images
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "diffusers", "transformers", "accelerate", "safetensors", "fastapi", "uvicorn"], check=True)
elif ENGINE == "diffusers_video":  # Wan 2.1 : WanPipeline needs a recent diffusers, ftfy and an mp4 writer
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "diffusers>=0.33", "transformers", "accelerate", "safetensors", "sentencepiece", "ftfy",
                    "imageio", "imageio-ffmpeg", "fastapi", "uvicorn"], check=True)
elif ENGINE == "triposr":  # official TripoSR code (VAST-AI-Research), pinned to a commit that was read
    TSR_DIR = os.path.join(WORK, "TripoSR")
    if not os.path.isdir(TSR_DIR):
        subprocess.run(["git", "clone", "-q", "https://github.com/VAST-AI-Research/TripoSR.git", TSR_DIR], check=True)
        subprocess.run(["git", "-C", TSR_DIR, "checkout", "-q", "107cefdc244c39106fa830359024f6a2f1c78871"], check=True)
    # requirements.txt minus gradio/xatlas/moderngl (UI and texture baking, unused) and the transformers==4.35.0 pin (no wheels for recent Python)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "omegaconf==2.3.0", "einops", "trimesh", "rembg", "onnxruntime", "imageio", "transformers",
                    "fastapi", "uvicorn", "git+https://github.com/tatsy/torchmcubes.git"], check=True)
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


# Serveur d'images (engine diffusers), lance dans un sous-processus comme llama.cpp et vLLM.
DIFFUSERS_SERVER = r"""
import os, io, time, base64, asyncio
import torch
from diffusers import AutoPipelineForText2Image
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

REPO, NAME, KEY, PORT, TOKEN = os.environ["MODEL_REPO"], os.environ["SERVED_NAME"], os.environ["API_KEY"], int(os.environ["PORT"]), os.environ.get("HF_TOKEN")
kw = dict(torch_dtype=torch.float16, token=TOKEN)
try:
    pipe = AutoPipelineForText2Image.from_pretrained(REPO, variant="fp16", **kw)
except OSError:  # no fp16 variant in this repo
    pipe = AutoPipelineForText2Image.from_pretrained(REPO, **kw)
pipe = pipe.to("cuda")
pipe.enable_attention_slicing()
FAST = any(w in REPO.lower() for w in ("turbo", "schnell"))
lock = asyncio.Lock()
app = FastAPI()

@app.middleware("http")
async def bearer(request: Request, call_next):
    if request.headers.get("authorization", "") != "Bearer " + KEY:
        return JSONResponse({"error": {"message": "Bearer invalide"}}, status_code=401)
    return await call_next(request)

@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": NAME, "object": "model", "capabilities": ["image"]}]}

def render(prompt, n, w, h, seed, steps):
    gen = torch.Generator("cuda").manual_seed(seed) if seed is not None else None
    out = pipe(prompt=prompt, num_images_per_prompt=n, width=w, height=h, num_inference_steps=steps,
               guidance_scale=0.0 if FAST else 7.0, generator=gen).images
    res = []
    for im in out:
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        res.append({"b64_json": base64.b64encode(buf.getvalue()).decode()})
    return res

@app.post("/v1/images/generations")
async def generations(request: Request):
    try:
        body = await request.json()
        prompt = str(body["prompt"]).strip()
        n = int(body.get("n") or 1)
        w, h = (int(v) for v in str(body.get("size") or "512x512").lower().split("x"))
        seed = None if body.get("seed") is None else int(body["seed"])
        steps = int(body.get("steps") or (4 if FAST else 25))
        assert prompt and 1 <= n <= 2 and 64 <= w <= 1024 and 64 <= h <= 1024 and w % 8 == 0 and h % 8 == 0 and 1 <= steps <= 60
    except Exception:
        return JSONResponse({"error": {"message": "prompt requis ; n 1-2 ; size WxH multiple de 8, 1024 max ; steps 1-60"}}, status_code=400)
    async with lock:  # one request at a time: the T4 holds one batch
        try:
            data = await asyncio.to_thread(render, prompt, n, w, h, seed, steps)
        except Exception as exc:
            return JSONResponse({"error": {"message": "generation impossible : " + type(exc).__name__}}, status_code=500)
    return {"created": int(time.time()), "data": data}

uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
"""


# Base commune des serveurs video et 3D : Bearer, /v1/models, une requete a la fois, battement dans server.log
# (la surveillance d'inactivite lit la taille du journal : sans battement, une generation de 10 min passerait pour de l'inactivite).
MEDIA_COMMON = r"""
import os, io, time, base64, asyncio, threading, tempfile
import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

REPO, NAME, KEY, PORT, TOKEN = os.environ["MODEL_REPO"], os.environ["SERVED_NAME"], os.environ["API_KEY"], int(os.environ["PORT"]), os.environ.get("HF_TOKEN")
lock = asyncio.Lock()
app = FastAPI()

@app.middleware("http")
async def bearer(request: Request, call_next):
    if request.headers.get("authorization", "") != "Bearer " + KEY:
        return JSONResponse({"error": {"message": "Bearer invalide"}}, status_code=401)
    return await call_next(request)

@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": NAME, "object": "model", "capabilities": [CAP]}]}

async def exclusive(fn, *args):
    async with lock:  # one request at a time: the T4 holds one job
        done = threading.Event()
        def beat():
            while not done.wait(20):
                print("busy", flush=True)
        threading.Thread(target=beat, daemon=True).start()
        try:
            return await asyncio.to_thread(fn, *args)
        finally:
            done.set()
"""

# Serveur video (engine diffusers_video : Wan 2.1 T2V 1.3B, bf16, offload CPU pour tenir dans 16 Go)
VIDEO_SERVER = r"""
CAP = "video"
from diffusers import AutoencoderKLWan, WanPipeline, UniPCMultistepScheduler
from diffusers.utils import export_to_video

vae = AutoencoderKLWan.from_pretrained(REPO, subfolder="vae", torch_dtype=torch.float32, token=TOKEN)
pipe = WanPipeline.from_pretrained(REPO, vae=vae, torch_dtype=torch.bfloat16, token=TOKEN)
pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config, flow_shift=3.0)  # 3.0 for 480p
pipe.enable_model_cpu_offload()
NEG = "blurry, low quality, distorted, static, overexposed, worst quality, jpeg artifacts, deformed, watermark, text"

def render(prompt, seconds, w, h, seed, steps):
    gen = torch.Generator("cuda").manual_seed(seed) if seed is not None else None
    frames = pipe(prompt=prompt, negative_prompt=NEG, height=h, width=w, num_frames=16 * seconds + 1, num_inference_steps=steps,
                  guidance_scale=5.0, generator=gen).frames[0]
    fd, path = tempfile.mkstemp(suffix=".mp4")
    os.close(fd)
    try:
        export_to_video(frames, path, fps=16)
        with open(path, "rb") as f:
            return base64.b64encode(f.read()).decode()
    finally:
        os.remove(path)

@app.post("/v1/videos/generations")
async def generations(request: Request):
    try:
        body = await request.json()
        prompt = str(body["prompt"]).strip()
        seconds = int(body.get("seconds") or 2)
        w, h = (int(v) for v in str(body.get("size") or "832x480").lower().split("x"))
        seed = None if body.get("seed") is None else int(body["seed"])
        steps = int(body.get("steps") or 20)
        assert prompt and 1 <= seconds <= 4 and 64 <= w and 64 <= h and w % 16 == 0 and h % 16 == 0 and w * h <= 832 * 480 and 1 <= steps <= 50
    except Exception:
        return JSONResponse({"error": {"message": "prompt requis ; seconds 1-4 ; size WxH multiple de 16, 832x480 max ; steps 1-50"}}, status_code=400)
    try:
        b64 = await exclusive(render, prompt, seconds, w, h, seed, steps)
    except Exception as exc:
        return JSONResponse({"error": {"message": "generation impossible : " + type(exc).__name__}}, status_code=500)
    return {"created": int(time.time()), "data": [{"b64_mp4": b64}]}

uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
"""

# Serveur 3D (engine triposr : TripoSR image -> maillage .glb)
TRIPOSR_SERVER = r"""
CAP = "3d"
import sys
import numpy as np
import rembg
from PIL import Image
sys.path.insert(0, os.environ["TSR_DIR"])
from tsr.system import TSR
from tsr.utils import remove_background, resize_foreground

model = TSR.from_pretrained(REPO, config_name="config.yaml", weight_name="model.ckpt")
model.renderer.set_chunk_size(8192)
model.to("cuda")
session = rembg.new_session()

def build(raw, ratio, resolution):
    image = remove_background(Image.open(io.BytesIO(raw)).convert("RGB"), session)
    image = np.array(resize_foreground(image, ratio)).astype(np.float32) / 255.0
    image = image[:, :, :3] * image[:, :, 3:4] + (1 - image[:, :, 3:4]) * 0.5
    with torch.no_grad():
        codes = model([Image.fromarray((image * 255.0).astype(np.uint8))], device="cuda")
    return model.extract_mesh(codes, True, resolution=resolution)[0].export(file_type="glb")

@app.post("/v1/3d/generations")
async def generations(request: Request):
    try:
        body = await request.json()
        raw = base64.b64decode(str(body["image_b64"]), validate=True)
        ratio = float(body.get("foreground_ratio") or 0.85)
        resolution = int(body.get("mc_resolution") or 256)
        assert 0 < len(raw) <= 4 * 1024 * 1024 and 0.5 <= ratio <= 1.0 and 32 <= resolution <= 320
        Image.open(io.BytesIO(raw)).verify()
    except Exception:
        return JSONResponse({"error": {"message": "image_b64 requis (PNG/JPEG, 4 Mo max) ; foreground_ratio 0.5-1 ; mc_resolution 32-320"}}, status_code=400)
    try:
        glb = await exclusive(build, raw, ratio, resolution)
    except Exception as exc:
        return JSONResponse({"error": {"message": "generation impossible : " + type(exc).__name__}}, status_code=500)
    return {"created": int(time.time()), "data": [{"b64_glb": base64.b64encode(glb).decode()}]}

uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
"""
SERVERS = {"diffusers": DIFFUSERS_SERVER, "diffusers_video": MEDIA_COMMON + VIDEO_SERVER, "triposr": MEDIA_COMMON + TRIPOSR_SERVER}
CAPABILITIES = {"diffusers": ["image"], "diffusers_video": ["video"], "triposr": ["3d"]}


# Démarrage du serveur d'inférence
from huggingface_hub import hf_hub_download, HfApi
os.environ["HF_TOKEN"] = HF_TOKEN
log = open(os.path.join(WORK, "server.log"), "w")
if ENGINE in SERVERS:
    _srv = os.path.join(WORK, ENGINE + "_server.py")
    open(_srv, "w", encoding="utf-8").write(SERVERS[ENGINE])
    cmd = [sys.executable, _srv]
elif ENGINE == "vllm":
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
os.environ.update(MODEL_REPO=MODEL, SERVED_NAME=SERVED_NAME, API_KEY=API_KEY, PORT=str(PORT))
if ENGINE == "triposr":
    os.environ["TSR_DIR"] = TSR_DIR
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
    if ENGINE in CAPABILITIES:
        body["capabilities"] = CAPABILITIES[ENGINE]
    api.upload_file(path_or_fileobj=json.dumps(body).encode(), path_in_repo=ANNOUNCE, repo_id=ANNOUNCE_REPO,
                    commit_message=f"backend {BACKEND_ID} up")

def withdraw():
    try:
        api.delete_file(ANNOUNCE, repo_id=ANNOUNCE_REPO, commit_message=f"backend {BACKEND_ID} down")
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
