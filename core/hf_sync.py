import os
import hashlib
import time

import httpx
from huggingface_hub import HfApi

from .paths import mazz_path
from .secret_file import read_secret

WHOAMI_URL = "https://huggingface.co/api/whoami-v2"
_WHOAMI_TTL = 600.0
_whoami_cache = {}   # token -> (username, fetched_at)
_ensured = set()     # repos already created or confirmed this process

def get_hf_token():
    env_text = read_secret(mazz_path("env")) or ""
    for line in env_text.splitlines():
        if line.startswith("HF_TOKEN="):
            return line.strip().split("=", 1)[1]
    return os.environ.get("HF_TOKEN")

def default_repo():
    """Transport repo: MAZZ_HF_REPO, else <HF username>/mazz-cloud (username from the validated token, cached 10 min)."""
    env = os.environ.get("MAZZ_HF_REPO", "").strip()
    if env:
        return env
    from compute.providers import ComputeError  # lazy: compute.providers imports this module
    token = get_hf_token()
    if not token:
        raise ComputeError(_NO_ACCOUNT)
    hit = _whoami_cache.get(token)
    if hit and time.time() - hit[1] < _WHOAMI_TTL:
        return f"{hit[0]}/mazz-cloud"
    try:
        r = httpx.get(WHOAMI_URL, headers={"Authorization": f"Bearer {token}"}, timeout=20)
    except httpx.HTTPError:
        raise ComputeError("Hugging Face injoignable : verifie ta connexion.") from None
    name = r.json().get("name") if r.status_code == 200 else None
    if not name:
        raise ComputeError(_NO_ACCOUNT)
    _whoami_cache[token] = (name, time.time())
    return f"{name}/mazz-cloud"


_NO_ACCOUNT = "Connectez votre compte Hugging Face (Services > Hugging Face) : le depot de transport est cree dans votre compte."


def ensure_repo(api, repo):
    """Creates `repo` PRIVATE if it does not exist (once per process)."""
    if repo not in _ensured:
        api.create_repo(repo_id=repo, repo_type="model", private=True, exist_ok=True)
        _ensured.add(repo)


def compute_sha256(filepath, chunk_size=8*1024*1024):
    sha = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(chunk_size):
            sha.update(chunk)
    return sha.hexdigest()

def upload_model_to_hf(local_filepath, remote_filename=None, force=False):
    token = get_hf_token()
    if not token:
        raise ValueError(f"HF_TOKEN non trouve dans {mazz_path('env')}")
        
    api = HfApi(token=token)
    if not os.path.exists(local_filepath):
        raise FileNotFoundError(f"Fichier introuvable: {local_filepath}")
        
    fname = remote_filename or os.path.basename(local_filepath)
    sz_mb = os.path.getsize(local_filepath) / (1024**2)
    
    repo_id = default_repo()
    ensure_repo(api, repo_id)
    # Check if already present on repo
    try:
        files = api.list_repo_files(repo_id=repo_id, repo_type="model")
        if fname in files and not force:
            return {
                "status": "skipped",
                "message": f"Le fichier {fname} existe deja sur {repo_id}. Utilisez force=True pour ecraser.",
                "repo_id": repo_id,
                "filename": fname
            }
    except Exception as e:
        # Repo might be newly created
        pass
        
    print(f"Calcul de l'empreinte SHA-256 pour {fname} ({sz_mb:.1f} Mo)...", flush=True)
    sha_local = compute_sha256(local_filepath)
    
    print(f"Televersement LFS vers https://huggingface.co/{repo_id}...", flush=True)
    url = api.upload_file(
        path_or_fileobj=local_filepath,
        path_in_repo=fname,
        repo_id=repo_id,
        repo_type="model"
    )
    
    return {
        "status": "uploaded",
        "repo_id": repo_id,
        "filename": fname,
        "sha256": sha_local,
        "size_mb": round(sz_mb, 1),
        "url": str(url)
    }

def list_remote_models():
    token = get_hf_token()
    if not token:
        return []
    api = HfApi(token=token)
    try:
        files = api.list_repo_files(repo_id=default_repo(), repo_type="model")
        return [f for f in files if f.endswith(".gguf")]
    except Exception:
        return []
