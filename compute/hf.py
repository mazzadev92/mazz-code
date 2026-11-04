"""Hugging Face side of a model transfer: list files, check a file exists, upload a local GGUF with progress."""
from __future__ import annotations

import os
from typing import Callable, Optional

from core.hf_sync import REPO_ID, get_hf_token


def default_repo() -> str:
    return os.environ.get("MAZZ_HF_REPO") or REPO_ID


def _api(token: Optional[str] = None):
    from huggingface_hub import HfApi
    return HfApi(token=token or get_hf_token())


def list_files(repo: Optional[str] = None, suffixes: tuple[str, ...] = (".gguf",)) -> list[dict]:
    """Files of `repo` ending in one of `suffixes`, with sizes. Raises on an unknown or inaccessible repo."""
    repo = repo or default_repo()
    out = []
    for entry in _api().list_repo_tree(repo_id=repo, recursive=True, repo_type="model"):
        path = getattr(entry, "path", "")
        if path.lower().endswith(suffixes):
            out.append({"file": path, "size_bytes": getattr(entry, "size", None) or 0})
    return sorted(out, key=lambda f: f["file"])


def file_size(repo: str, file: str) -> Optional[int]:
    """Size in bytes of `file` in `repo`, or None when it does not exist."""
    try:
        infos = _api().get_paths_info(repo_id=repo, paths=[file], repo_type="model")
    except Exception:
        return None
    return getattr(infos[0], "size", None) if infos else None


class _ProgressFile:
    """File object that reports how much has been read: huggingface_hub hashes the file, then uploads it."""

    def __init__(self, path: str, callback: Callable[[float], None]):
        self._file = open(path, "rb")
        self._size = os.path.getsize(path)
        self._read = 0
        self._callback = callback

    def read(self, n: int = -1) -> bytes:
        data = self._file.read(n)
        self._read += len(data)
        # Two passes over the file (hash, then upload): halve so the bar never reaches 100 % early.
        self._callback(min(0.99, self._read / (2 * self._size or 1)))
        return data

    def seek(self, offset: int, whence: int = 0) -> int:
        return self._file.seek(offset, whence)

    def tell(self) -> int:
        return self._file.tell()

    def __len__(self) -> int:
        return self._size

    def close(self) -> None:
        self._file.close()


def upload(path: str, remote_name: str, repo: Optional[str] = None, callback: Callable[[float], None] = lambda _p: None) -> dict:
    """Uploads a local file to `repo` (skipped when a file of the same size is already there)."""
    repo = repo or default_repo()
    size = os.path.getsize(path)
    if file_size(repo, remote_name) == size:
        callback(1.0)
        return {"status": "skipped", "repo": repo, "file": remote_name, "size_bytes": size}
    handle = _ProgressFile(path, callback)
    try:
        _api().upload_file(path_or_fileobj=handle, path_in_repo=remote_name, repo_id=repo, repo_type="model",
                           commit_message=f"MAZZ: {remote_name}")
    finally:
        handle.close()
    callback(1.0)
    return {"status": "uploaded", "repo": repo, "file": remote_name, "size_bytes": size}
