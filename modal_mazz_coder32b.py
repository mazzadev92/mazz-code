"""MAZZ on Modal: vLLM OpenAI-compatible server for a 32B coder, scale-to-zero after 5 idle minutes.

Deploy:   python -m modal deploy modal_mazz_coder32b.py
Key:      Modal secret "mazz-vllm-key" holding VLLM_API_KEY (created by deploy_modal.ps1).
Cost:     billed per second only while a container runs (cold start included); MAZZ_MODAL_GPU picks the
          card (default L40S 48 GB: the AWQ 32B fits, half the hourly price of an H100).
Weights:  cached in the Modal volume "mazz-hf-cache", so only the first cold start downloads them.
"""
import os
import subprocess

import modal

MODEL = os.environ.get("MAZZ_MODAL_MODEL", "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ")
SERVED_NAME = os.environ.get("MAZZ_MODAL_SERVED", "mazz-coder-32b")
GPU = os.environ.get("MAZZ_MODAL_GPU", "L40S")
PORT = 8000

app = modal.App("mazz-coder-32b")
image = modal.Image.debian_slim(python_version="3.12").pip_install("vllm==0.11.0", "transformers==4.57.1").env({"HF_HOME": "/cache/hf"})
cache = modal.Volume.from_name("mazz-hf-cache", create_if_missing=True)


@app.function(
    gpu=GPU,
    image=image,
    volumes={"/cache": cache},
    secrets=[modal.Secret.from_name("mazz-vllm-key")],
    scaledown_window=300,  # container stops 5 min after the last request
    timeout=3600,
)
@modal.concurrent(max_inputs=16)
@modal.web_server(port=PORT, startup_timeout=1200)
def serve():
    # web_server needs the process started, not waited on: Modal routes traffic once the port answers.
    subprocess.Popen([
        "vllm", "serve", MODEL,
        "--served-model-name", SERVED_NAME,
        "--host", "0.0.0.0", "--port", str(PORT),
        # No --api-key argument: vLLM reads VLLM_API_KEY from the Modal secret and would otherwise
        # print the key among its "non-default args" in the container logs.
        "--max-model-len", "32768",
        "--gpu-memory-utilization", "0.92",
        "--enable-auto-tool-choice", "--tool-call-parser", "hermes",
    ])
