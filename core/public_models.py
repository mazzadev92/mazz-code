"""Public MAZZ model fleet: what the files of the public Hugging Face repo are.

The repo is public (Apache-2.0): anyone can list and download these GGUF without an HF account or
token. This module never reads the user's token and never touches the private transport repo.
"""
from __future__ import annotations

import os
import time

PUBLIC_REPO_DEFAULT = "mazz92/mazz-models"
PUBLIC_LICENSE = "Apache-2.0"

# Filename -> what the model is. Sizes are the README figures (indicative); the live repo listing wins.
FLEET = {
    "Mazz-Technos-Draft-0.8B-Surgical.Q8_0.gguf": {
        "name": "Draft 0.8B Chirurgical",
        "params": "0.8B",
        "quant": "Q8_0",
        "kind": "draft",
        "tier": 1,
        "size_bytes": 811843680,
        "disk_gb": 0.81,
        "local_ram_gb": 8,
        "kaggle_compatible": True,
        "hardware_badge": "Local CPU/RAM dès 8 Go & Cloud",
        "description": "Brouillon ultra-rapide (weight-space programming MIT CSAIL) : raisonnement aiguisé, boucles réduites. Idéal comme modèle brouillon ou sur petit PC.",
    },
    "Mazz-Technos-Draft-0.8B.Q8_0.gguf": {
        "name": "Draft 0.8B",
        "params": "0.8B",
        "quant": "Q8_0",
        "kind": "draft",
        "tier": 1,
        "size_bytes": 811844000,
        "disk_gb": 0.81,
        "local_ram_gb": 8,
        "kaggle_compatible": True,
        "hardware_badge": "Local CPU/RAM dès 8 Go & Cloud",
        "description": "Petit modèle de brouillon (Qwen3.5-0.8B) pour le décodage spéculatif et les machines modestes.",
    },
    "Mazz-Technos-Base-4B.Q4_K_M.gguf": {
        "name": "Base 4B",
        "params": "4B",
        "quant": "Q4_K_M",
        "kind": "text",
        "tier": 1,
        "size_bytes": 2707514688,
        "disk_gb": 2.71,
        "local_ram_gb": 16,
        "kaggle_compatible": True,
        "hardware_badge": "Local CPU/RAM dès 16 Go & Cloud",
        "description": "Polyvalent grand public pour PC portable et CPU standard : discussion, rédaction, code simple. Le meilleur point de départ sur 16 Go de RAM.",
    },
    "Mazz-Technos-TitanCoder-32B-Surgical.Q4_K_M.gguf": {
        "name": "TitanCoder 32B Chirurgical",
        "params": "32B",
        "quant": "Q4_K_M",
        "kind": "text",
        "tier": 2,
        "size_bytes": 19851336672,
        "disk_gb": 19.85,
        "local_ram_gb": 32,
        "kaggle_compatible": True,
        "hardware_badge": "Station 32 Go RAM local ou Cloud (Colab/Modal, Kaggle limite ~20 Go)",
        "description": "Fusion 90/10 DeepSeek-R1 + Qwen2.5-Coder : raisonnement déductif et ingénierie logicielle chirurgicale. Station de travail 32 Go et plus.",
    },
    "Mazz-Technos-Coder-32B.Q4_K_M.gguf": {
        "name": "Coder 32B",
        "params": "32B",
        "quant": "Q4_K_M",
        "kind": "text",
        "tier": 2,
        "size_bytes": 19851336800,
        "disk_gb": 19.85,
        "local_ram_gb": 32,
        "kaggle_compatible": True,
        "hardware_badge": "Station 32 Go RAM local ou Cloud (Colab/Modal, Kaggle limite ~20 Go)",
        "description": "Champion du code : refactoring, complétion et appels d'outils. Station de travail 32 Go et plus.",
    },
    "Mazz-Technos-Titan-32B-CoT.Q4_K_M.gguf": {
        "name": "Titan 32B CoT",
        "params": "32B",
        "quant": "Q4_K_M",
        "kind": "text",
        "tier": 2,
        "size_bytes": 19851336288,
        "disk_gb": 19.85,
        "local_ram_gb": 32,
        "kaggle_compatible": True,
        "hardware_badge": "Station 32 Go RAM local ou Cloud (Colab/Modal, Kaggle limite ~20 Go)",
        "description": "Raisonnement scientifique profond avec blocs <thought> (chaîne de pensée). Station de travail 32 Go et plus.",
    },
    "Mazz-Technos-Vision-Flux.Q4_0.gguf": {
        "name": "Vision Flux",
        "params": "12B",
        "quant": "Q4_0",
        "kind": "image",
        "tier": 3,
        "size_bytes": 6770707360,
        "disk_gb": 6.77,
        "local_ram_gb": 16,
        "kaggle_compatible": True,
        "hardware_badge": "Calcul GPU (Kaggle, Colab ou Modal)",
        "description": "Génération d'images photoréalistes en 4 étapes (FLUX.1-schnell). Se lance depuis la page Calcul GPU, pas comme un modèle de chat local.",
    },
    "Mazz-Technos-Motion-Wan.Q8_0.gguf": {
        "name": "Motion Wan",
        "params": "1.3B",
        "quant": "Q8_0",
        "kind": "video",
        "tier": 3,
        "size_bytes": 1535768800,
        "disk_gb": 1.54,
        "local_ram_gb": 12,
        "kaggle_compatible": True,
        "hardware_badge": "Calcul GPU (Kaggle, Colab ou Modal)",
        "description": "Génération vidéo cinématique (Wan 2.1 1.3B). Se lance depuis la page Calcul GPU, pas comme un modèle de chat local.",
    },
    "Mazz-Technos-ApexCoder-70B-Surgical.Q4_K_M.gguf": {
        "name": "ApexCoder 70B Chirurgical",
        "params": "70B",
        "quant": "Q4_K_M",
        "kind": "text",
        "tier": 4,
        "size_bytes": 42520399008,
        "disk_gb": 42.52,
        "local_ram_gb": 64,
        "kaggle_compatible": False,
        "hardware_badge": "Colab ou Modal requis (disque > 45 Go, incompatible Kaggle 20 Go)",
        "description": "Sommet de la flotte : fusion Nemotron-70B + Llama-3.3-70B, analyse de dépôts volumineux et audits. Nécessite un GPU distant (Calcul GPU).",
    },
    "Mazz-Technos-ApexCoder-70B.Q4_K_M.gguf": {
        "name": "ApexCoder 70B",
        "params": "70B",
        "quant": "Q4_K_M",
        "kind": "text",
        "tier": 4,
        "size_bytes": 42520398912,
        "disk_gb": 42.52,
        "local_ram_gb": 64,
        "kaggle_compatible": False,
        "hardware_badge": "Colab ou Modal requis (disque > 45 Go, incompatible Kaggle 20 Go)",
        "description": "Version 70B grand format pour l'analyse contextuelle massive. Nécessite un GPU distant (Calcul GPU).",
    },
}

_cache = {"at": 0.0, "models": None, "error": None}


def public_repo() -> str:
    """Public catalogue repo. MAZZ_PUBLIC_REPO allows a fork or a self-hosted mirror."""
    return os.environ.get("MAZZ_PUBLIC_REPO", "").strip() or PUBLIC_REPO_DEFAULT


def describe(filename: str) -> dict | None:
    return FLEET.get(os.path.basename(filename or ""))


def expected_size(filename: str) -> int:
    meta = describe(filename) or {}
    return int(meta.get("size_bytes") or 0)


def download_url(filename: str, repo: str | None = None) -> str:
    return f"https://huggingface.co/{repo or public_repo()}/resolve/main/{filename}"


def _entry(filename: str, size_bytes: int, repo: str) -> dict:
    meta = describe(filename) or {}
    return {
        "filename": filename,
        "repo_path": filename,
        "name": meta.get("name") or filename[:-5],
        "description": meta.get("description") or "",
        "params": meta.get("params"),
        "quant": meta.get("quant"),
        "kind": meta.get("kind") or "text",
        "tier": int(meta.get("tier") or 9),
        "license": PUBLIC_LICENSE,
        "size_bytes": int(size_bytes or meta.get("size_bytes") or 0),
        "download_url": download_url(filename, repo),
        "disk_gb": meta.get("disk_gb"),
        "local_ram_gb": meta.get("local_ram_gb"),
        "kaggle_compatible": meta.get("kaggle_compatible", True),
        "hardware_badge": meta.get("hardware_badge", ""),
    }


def static_fleet(repo: str | None = None) -> list[dict]:
    """The documented fleet, usable when Hugging Face is unreachable (sizes are indicative)."""
    repo = repo or public_repo()
    return sorted((_entry(name, int(meta["size_bytes"]), repo) for name, meta in FLEET.items()),
                  key=lambda m: (m["tier"], m["size_bytes"], m["filename"]))


def list_public(repo: str | None = None, max_age: float = 600.0, token: str | None = None) -> tuple[list[dict], str | None]:
    """Files of a Hugging Face repo.

    The official MAZZ fleet is always listed anonymously (token=False): downloading it never needs an
    account. `token` is only used for the user's own repo, which may be private.
    """
    now = time.time()
    target_repo = (repo or "").strip() or public_repo()
    is_default = target_repo == public_repo()
    if is_default and token is None and _cache["models"] is not None and now - _cache["at"] < max_age:
        return _cache["models"], _cache["error"]
    try:
        from huggingface_hub import HfApi
        api = HfApi(token=False if is_default else (token or False))
        models = []
        for item in api.list_repo_tree(repo_id=target_repo, repo_type="model", recursive=True):
            path = getattr(item, "path", "")
            if not path.lower().endswith(".gguf") or "/" in path:
                continue
            models.append(_entry(path, getattr(item, "size", None) or 0, target_repo))
        if not models:
            raise RuntimeError(f"le dépôt {target_repo} ne contient aucun fichier .gguf")
        models.sort(key=lambda m: (m["tier"], m["size_bytes"], m["filename"]))
        if is_default and token is None:
            _cache.update(at=now, models=models, error=None)
        return models, None
    except Exception as exc:  # noqa: BLE001 - offline: the documented fleet still explains what exists
        err = f"Catalogue Hugging Face indisponible ({type(exc).__name__}: {exc})."
        if is_default and token is None:
            _cache.update(at=now, models=static_fleet(target_repo), error=err)
            return _cache["models"], _cache["error"]
        return [], err


def reset_cache() -> None:
    _cache.update(at=0.0, models=None, error=None)
