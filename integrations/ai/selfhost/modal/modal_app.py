"""Modal-hosted vLLM endpoint using a user-selected Hugging Face model."""
import os
import subprocess

import modal

MODEL_REPO = os.environ.get("MODEL_REPO", "Qwen/Qwen2.5-Coder-7B-Instruct")
SERVED_NAME = os.environ.get("SERVED_MODEL_NAME", MODEL_REPO.rsplit("/", 1)[-1])
GPU = os.environ.get("MODAL_GPU", "L40S")
PORT = 8000

app = modal.App("mazz-router-model")
image = modal.Image.debian_slim(python_version="3.12").pip_install("vllm==0.11.0").env({"HF_HOME": "/cache/hf"})
cache = modal.Volume.from_name("mazz-router-hf-cache", create_if_missing=True)


@app.function(gpu=GPU, image=image, volumes={"/cache": cache}, secrets=[modal.Secret.from_name("mazz-vllm-key")], scaledown_window=300, timeout=3600)
@modal.concurrent(max_inputs=8)
@modal.web_server(port=PORT, startup_timeout=1200)
def serve():
    subprocess.Popen([
        "vllm", "serve", MODEL_REPO, "--served-model-name", SERVED_NAME,
        "--host", "0.0.0.0", "--port", str(PORT), "--max-model-len", "8192",
    ])
