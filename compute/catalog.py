"""Curated model catalogue: every repo, file and size below was checked against the Hugging Face API (2026-11-04).

`engine` says how MAZZ can serve it today: "gguf" (llama.cpp on Kaggle/Colab/Saturn), "vllm" (Modal), "diffusers" (images), "diffusers_video" (Wan 2.1), "triposr" (image to 3D) on Kaggle/Colab, None (image, video,
3D, audio: no serving engine yet; the router's API providers cover them in the meantime).
"""
from __future__ import annotations

from typing import Any

# Usable VRAM in GB of the free GPU of each provider (leave headroom for the context cache).
VRAM_GB = {"kaggle": 15.0, "colab": 15.0, "saturn": 15.0, "modal": 46.0}
# Colab GPU choices (options.gpu); usable VRAM in GB. t4 is the default, a100 needs options.confirm_cost.
COLAB_GPU_VRAM = {"t4": 15.0, "l4": 22.0, "a100": 40.0}
ACCEPTS = {"gguf": ("kaggle", "colab", "saturn"), "vllm": ("modal",), "diffusers": ("kaggle", "colab"),
           "diffusers_video": ("kaggle", "colab"), "triposr": ("kaggle", "colab"), "trellis": ("colab",)}


HUNYUAN_REGIONS = ("EU", "UK", "KR")
HUNYUAN_WARNING = "Licence Tencent Hunyuan : l'usage est exclu dans l'Union europeenne, au Royaume-Uni et en Coree du Sud ; ne pas utiliser dans ces territoires."


def _m(id: str, name: str, modality: str, repo: str, size_gb: float, license: str, engine: str | None, file: str = "",
       note: str = "", api: tuple[str, ...] = (), vram_gb: float | None = None, planned_engine: str = "",
       restricted_regions: tuple[str, ...] = (), license_warning: str = "") -> dict[str, Any]:
    """`vram_gb`: GPU memory needed when it is lower than the weights (CPU offload keeps one component on the GPU at a time)."""
    return {"id": id, "name": name, "modality": modality, "repo": repo, "file": file, "size_gb": size_gb, "license": license,
            "engine": engine, "note": note, "api_alternatives": list(api), "vram_gb": vram_gb or size_gb, "planned_engine": planned_engine,
            "restricted_regions": list(restricted_regions), "license_warning": license_warning}


CATALOG: list[dict[str, Any]] = [
    _m("qwen3-14b", "Qwen3 14B (Q4_K_M)", "text", "unsloth/Qwen3-14B-GGUF", 9.0, "apache-2.0", "gguf", "Qwen3-14B-Q4_K_M.gguf", "Generaliste avec raisonnement."),
    _m("qwen25-coder-14b", "Qwen2.5 Coder 14B (Q4_K_M)", "text", "bartowski/Qwen2.5-Coder-14B-Instruct-GGUF", 8.99, "apache-2.0", "gguf", "Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf", "Code."),
    _m("gpt-oss-20b", "gpt-oss 20B (Q4_K_M)", "text", "unsloth/gpt-oss-20b-GGUF", 11.62, "apache-2.0", "gguf", "gpt-oss-20b-Q4_K_M.gguf", "Raisonnement, appels d'outils."),
    _m("qwen3-30b-a3b", "Qwen3 30B-A3B (Q4_K_M)", "text", "unsloth/Qwen3-30B-A3B-GGUF", 18.56, "apache-2.0", "gguf", "Qwen3-30B-A3B-Q4_K_M.gguf", "MoE rapide, trop gros pour un GPU de 16 Go."),
    _m("qwen25-14b-awq", "Qwen2.5 14B Instruct (AWQ)", "text", "Qwen/Qwen2.5-14B-Instruct-AWQ", 10.0, "apache-2.0", "vllm", note="Teste sur Modal."),
    _m("qwen3-14b-awq", "Qwen3 14B (AWQ)", "text", "Qwen/Qwen3-14B-AWQ", 10.0, "apache-2.0", "vllm"),
    _m("qwen25-coder-32b-awq", "Qwen2.5 Coder 32B (AWQ)", "text", "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ", 19.3, "apache-2.0", "vllm", note="Code, qualite maximale."),
    _m("flux-schnell", "FLUX.1 schnell", "image", "black-forest-labs/FLUX.1-schnell", 57.8, "apache-2.0", None, note="Acces Hugging Face a accepter (gated).", api=("fal", "cloudflare")),
    _m("qwen-image", "Qwen-Image", "image", "Qwen/Qwen-Image", 57.7, "apache-2.0", None, api=("fal",)),
    _m("sdxl-turbo", "SDXL Turbo", "image", "stabilityai/sdxl-turbo", 6.94, "other", "diffusers", note="Poids fp16 (unet, vae, 2 encodeurs texte) ; licence non commerciale. Sert POST /v1/images/generations.", api=("stability", "cloudflare")),
    _m("wan21-1b", "Wan 2.1 T2V 1.3B", "video", "Wan-AI/Wan2.1-T2V-1.3B-Diffusers", 14.5, "apache-2.0", None, note="Pas encore disponible : le serveur existe (engine diffusers_video) mais le test reel sur Kaggle T4 a echoue (memoire GPU epuisee a 832x480) ; utilisez les API fal/Replicate.", api=("fal", "replicate"), vram_gb=11.4),
    _m("cogvideox-2b", "CogVideoX 2B", "video", "THUDM/CogVideoX-2b", 13.8, "apache-2.0", None, api=("fal",)),
    _m("triposr", "TripoSR", "3d", "stabilityai/TripoSR", 1.7, "mit", None, note="Pas encore disponible : le serveur existe (engine triposr, code officiel VAST-AI-Research, licence MIT) mais le test reel sur Kaggle a echoue (le serveur ne s'est pas annonce) ; utilisez les API tripo/meshy.", api=("tripo", "meshy")),
    _m("hunyuan3d-2mini", "Hunyuan3D-2 mini", "3d", "tencent/Hunyuan3D-2mini", 25.3, "other", None, api=("tripo", "meshy"),
       restricted_regions=HUNYUAN_REGIONS, license_warning=HUNYUAN_WARNING),
    _m("trellis-image-large", "TRELLIS image large (GLB texture)", "3d", "microsoft/TRELLIS-image-large", 3.3, "mit", None, vram_gb=16.0, planned_engine="trellis",
       note="Pas encore disponible : le serveur (engine trellis, depot officiel microsoft/TRELLIS fige au commit 193e0502) est ecrit mais son installation n'est pas reproductible de facon verifiee (pile torch 2.4 / CUDA, 3 extensions compilees), donc jamais teste en reel. Exige un GPU >= 16 Go : Colab L4 ou A100 (option gpu).", api=("tripo", "meshy")),
    _m("hunyuan3d-21", "Hunyuan3D-2.1", "3d", "tencent/Hunyuan3D-2.1", 14.9, "other", None, api=("tripo", "meshy"), restricted_regions=HUNYUAN_REGIONS,
       license_warning=HUNYUAN_WARNING, note="Pas de moteur de service. Masque par defaut (licence)."),
    _m("whisper-turbo", "Whisper large-v3 turbo", "audio", "openai/whisper-large-v3-turbo", 1.6, "mit", None, note="Transcription.", api=("deepgram", "cloudflare")),
    _m("kokoro", "Kokoro 82M", "audio", "hexgrad/Kokoro-82M", 0.4, "apache-2.0", None, note="Synthese vocale.", api=("elevenlabs", "cartesia")),
    _m("bge-m3", "BGE-M3", "embed", "BAAI/bge-m3", 4.6, "mit", None, note="Embeddings multilingues.", api=("nim", "jina", "voyage")),
]


def catalog(include_restricted: bool = False) -> list[dict[str, Any]]:
    """Catalogue with, per model, the providers whose GPU can hold it (size + 15 % headroom). On Colab `fits` is true when any
    of the GPUs does and `colab_gpus` gives the answer per GPU. Models with restricted_regions are hidden unless asked for."""
    out = []
    for m in CATALOG:
        if m["restricted_regions"] and not include_restricted:
            continue
        need = m["vram_gb"] * 1.15
        fits = {p: need <= VRAM_GB[p] for p in ACCEPTS.get(m["engine"] or m["planned_engine"], ())}
        extra = {}
        if "colab" in fits:
            extra["colab_gpus"] = {g: need <= v for g, v in COLAB_GPU_VRAM.items()}
            fits["colab"] = any(extra["colab_gpus"].values())
        out.append({**m, "fits": fits, **extra})
    return out
