import os
import hashlib
from huggingface_hub import HfApi

from .secret_file import read_secret

REPO_ID = "mazz92/mazz-models"

def get_hf_token():
    env_text = read_secret(os.path.expandvars(r"%USERPROFILE%\.mazz\env")) or ""
    for line in env_text.splitlines():
        if line.startswith("HF_TOKEN="):
            return line.strip().split("=", 1)[1]
    return os.environ.get("HF_TOKEN")

def compute_sha256(filepath, chunk_size=8*1024*1024):
    sha = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(chunk_size):
            sha.update(chunk)
    return sha.hexdigest()

def upload_model_to_hf(local_filepath, remote_filename=None, force=False):
    token = get_hf_token()
    if not token:
        raise ValueError("HF_TOKEN non trouve dans %USERPROFILE%\\.mazz\\env")
        
    api = HfApi(token=token)
    if not os.path.exists(local_filepath):
        raise FileNotFoundError(f"Fichier introuvable: {local_filepath}")
        
    fname = remote_filename or os.path.basename(local_filepath)
    sz_mb = os.path.getsize(local_filepath) / (1024**2)
    
    # Check if already present on repo
    try:
        files = api.list_repo_files(repo_id=REPO_ID, repo_type="model")
        if fname in files and not force:
            return {
                "status": "skipped",
                "message": f"Le fichier {fname} existe deja sur {REPO_ID}. Utilisez force=True pour ecraser.",
                "repo_id": REPO_ID,
                "filename": fname
            }
    except Exception as e:
        # Repo might be newly created
        pass
        
    print(f"Calcul de l'empreinte SHA-256 pour {fname} ({sz_mb:.1f} Mo)...", flush=True)
    sha_local = compute_sha256(local_filepath)
    
    print(f"Televersement LFS vers https://huggingface.co/{REPO_ID}...", flush=True)
    url = api.upload_file(
        path_or_fileobj=local_filepath,
        path_in_repo=fname,
        repo_id=REPO_ID,
        repo_type="model"
    )
    
    return {
        "status": "uploaded",
        "repo_id": REPO_ID,
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
        files = api.list_repo_files(repo_id=REPO_ID, repo_type="model")
        return [f for f in files if f.endswith(".gguf")]
    except Exception:
        return []
