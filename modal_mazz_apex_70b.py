# MAZZ ÆNGENIUM — DÉPLOIEMENT MODAL LABS (H100 / A100)
# Ce script déploie un serveur vLLM souverain sur GPU NVIDIA H100 (80 Go)
# Compatible OpenAI API, avec arrêt automatique après 5 minutes d'inactivité.

import modal

app = modal.App("mazz-apex-engine")

# Image système optimisée avec vLLM et Hugging Face Hub
vllm_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "vllm>=0.7.0",
    "huggingface_hub>=0.28.0"
)

MODEL_REPO = "bartowski/huihui-ai_DeepSeek-R1-Distill-Llama-70B-abliterated-GGUF"
MODEL_FILE = "huihui-ai_DeepSeek-R1-Distill-Llama-70B-abliterated-Q4_K_M.gguf"
# Cle API lue dans le secret Modal "mazz-vllm-key" (modal secret create mazz-vllm-key VLLM_API_KEY=...).

@app.function(
    gpu="H100",  # ou "A100" selon vos crédits
    image=vllm_image,
    secrets=[modal.Secret.from_name("mazz-vllm-key")],
    scaledown_window=300,  # Se met en veille après 5 minutes sans requête (0€ dépensé)
    timeout=600
)
@modal.web_server(port=8000, startup_timeout=600)
def serve():
    import subprocess, os
    print("Démarrage du moteur vLLM souverain sur NVIDIA H100 80 Go...", flush=True)
    
    # Commande vLLM compatible OpenAI API
    cmd = [
        "python3", "-m", "vllm.entrypoints.openai.api_server",
        "--model", MODEL_REPO,
        "--port", "8000",
        "--api-key", os.environ["VLLM_API_KEY"],
        "--max-model-len", "32768",
        "--trust-remote-code"
    ]
    subprocess.Popen(cmd).wait()
