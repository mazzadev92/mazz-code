"""Download a GGUF from the public MAZZ Hugging Face repo into the local model folder.

No token, no account, no private repo: the URL is fixed to the public catalogue repo and the file
name is validated. One download runs at a time; the file is written to `<name>.gguf.part` then
renamed atomically so the library never sees a truncated GGUF.
"""
from __future__ import annotations

import os
import re
import shutil
import threading
import time
import uuid
from typing import Any, Optional

import httpx

from . import library, public_models

SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$")
CHUNK_BYTES = 1024 * 1024
DISK_MARGIN_BYTES = 512 * 1024 * 1024


class DownloadError(Exception):
    """A download that cannot start or that Hugging Face refused."""


class _Cancelled(Exception):
    pass


class DownloadManager:
    def __init__(self, transport: Optional[httpx.BaseTransport] = None):
        self._items: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._transport = transport
        self._slots = threading.Semaphore(1)

    # ------------------------------------------------------------------ read side
    @staticmethod
    def _public(item: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in item.items() if key != "cancel"}

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            items = [self._public(item) for item in self._items.values()]
        return sorted(items, key=lambda item: item["started_at"], reverse=True)

    def get(self, download_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            item = self._items.get(download_id)
            return self._public(item) if item else None

    # ------------------------------------------------------------------ write side
    def start(self, filename: str, dest_dir: Optional[str] = None, repo: Optional[str] = None,
              token: Optional[str] = None) -> dict[str, Any]:
        raw = str(filename or "")
        if "/" in raw or "\\" in raw or not SAFE_NAME.match(raw):
            raise DownloadError("Nom de fichier invalide : un nom de fichier .gguf simple est attendu.")
        filename = raw
        target_repo = (repo or "").strip() or public_models.public_repo()
        if not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", target_repo):
            raise DownloadError("Nom de dépôt Hugging Face invalide (format attendu: utilisateur/depot).")
        with self._lock:
            for item in self._items.values():
                if item["filename"] == filename and item["status"] in ("queued", "downloading"):
                    return self._public(item)
                if item["filename"] == filename and item["status"] == "done" and os.path.isfile(item.get("path") or ""):
                    return self._public(item)
        dest = os.path.abspath(dest_dir or library.MODEL_DIRS[0])
        os.makedirs(dest, exist_ok=True)
        final = os.path.join(dest, filename)
        expected = public_models.expected_size(filename)
        if os.path.isfile(final):
            item = self._new_item(filename, expected, final)
            item.update(status="done", downloaded_bytes=os.path.getsize(final), progress=1.0)
            with self._lock:
                self._items[item["id"]] = item
            return self._public(item)
        free = shutil.disk_usage(dest).free
        if expected and free < expected + DISK_MARGIN_BYTES:
            raise DownloadError(
                f"Espace disque insuffisant dans {dest} : {expected / 1024**3:.1f} Go requis, "
                f"{free / 1024**3:.1f} Go libres."
            )
        item = self._new_item(filename, expected, final)
        item["status"] = "queued"
        with self._lock:
            self._items[item["id"]] = item
        threading.Thread(target=self._run, args=(item, target_repo, token), daemon=True,
                         name=f"mazz-download-{item['id']}").start()
        return self._public(item)

    def cancel(self, download_id: str) -> dict[str, Any]:
        with self._lock:
            item = self._items.get(download_id)
            if not item:
                raise DownloadError("Téléchargement inconnu.")
            item["cancel"].set()
            if item["status"] == "queued":
                item["status"] = "cancelled"
                item["updated_at"] = time.time()
            return self._public(item)

    @staticmethod
    def _new_item(filename: str, expected: int, final: str) -> dict[str, Any]:
        now = time.time()
        return {
            "id": uuid.uuid4().hex[:12],
            "filename": filename,
            "status": "queued",
            "downloaded_bytes": 0,
            "size_bytes": expected,
            "progress": 0.0,
            "speed_bps": 0,
            "error": None,
            "path": final,
            "started_at": now,
            "updated_at": now,
            "cancel": threading.Event(),
        }

    def _run(self, item: dict[str, Any], repo: str, token: Optional[str] = None) -> None:
        with self._slots:
            if item["cancel"].is_set():
                self._finish(item, "cancelled")
                return
            item["status"] = "downloading"
            item["updated_at"] = time.time()
            part = item["path"] + ".part"
            url = public_models.download_url(item["filename"], repo)
            headers = {"Authorization": f"Bearer {token}"} if token else {}
            # A previous attempt that failed mid-way leaves a .part file: ask only for the missing bytes
            # instead of downloading a 20 GB model from scratch.
            resume_from = os.path.getsize(part) if os.path.exists(part) else 0
            if resume_from:
                headers["Range"] = f"bytes={resume_from}-"
            written = 0
            started = time.time()
            try:
                timeout = httpx.Timeout(30.0, connect=30.0, read=120.0, write=30.0)
                with httpx.Client(transport=self._transport, follow_redirects=True, timeout=timeout) as client:
                    with client.stream("GET", url, headers=headers) as response:
                        if response.status_code == 416 and resume_from:
                            # Nothing left to fetch: the partial file already holds the whole model.
                            os.replace(part, item["path"])
                            item.update(downloaded_bytes=resume_from, size_bytes=resume_from, progress=1.0, updated_at=time.time())
                            self._finish(item, "done")
                            return
                        if response.status_code not in (200, 206):
                            raise DownloadError(f"Hugging Face a répondu HTTP {response.status_code} pour {item['filename']}.")
                        resumed = response.status_code == 206 and resume_from > 0
                        if resumed:
                            match = re.match(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("content-range", ""))
                            total = int(match.group(3)) if match else item["size_bytes"]
                        else:  # the server ignored Range: start over rather than append to a stale file
                            resume_from = 0
                            total = int(response.headers.get("content-length") or 0) or item["size_bytes"]
                        item["size_bytes"] = total
                        written = resume_from
                        session_bytes = 0
                        with open(part, "ab" if resumed else "wb") as out:
                            for chunk in response.iter_bytes(CHUNK_BYTES):
                                if item["cancel"].is_set():
                                    raise _Cancelled()
                                out.write(chunk)
                                written += len(chunk)
                                session_bytes += len(chunk)
                                elapsed = max(0.001, time.time() - started)
                                item.update(
                                    downloaded_bytes=written,
                                    progress=round(written / total, 4) if total else 0.0,
                                    speed_bps=int(session_bytes / elapsed),
                                    updated_at=time.time(),
                                )
                if written == 0:
                    raise DownloadError("Hugging Face a renvoyé un fichier vide.")
                if total and written != total:
                    raise DownloadError(f"Téléchargement incomplet : {written} octets reçus sur {total} attendus.")
                os.replace(part, item["path"])
                item.update(downloaded_bytes=written, progress=1.0, updated_at=time.time())
                self._finish(item, "done")
            except _Cancelled:
                self._remove(part)
                self._finish(item, "cancelled")
            except Exception as exc:  # noqa: BLE001 - the UI shows the reason; the .part file stays for a resume
                item["error"] = str(exc) or type(exc).__name__
                self._finish(item, "error")

    @staticmethod
    def _remove(path: str) -> None:
        try:
            os.remove(path)
        except OSError:
            pass

    @staticmethod
    def _finish(item: dict[str, Any], status: str) -> None:
        item["status"] = status
        item["updated_at"] = time.time()
        if status != "done":
            item["speed_bps"] = 0
