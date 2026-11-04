"""Background jobs (model transfer, remote deployment) with step-by-step progress, kept in memory and mirrored to disk."""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from typing import Any, Callable, Optional

STORE_FILE = os.path.expandvars(r"%USERPROFILE%\.mazz\compute_jobs.json")
KEEP = 40


class Job:
    def __init__(self, title: str, steps: list[str]):
        self.id = uuid.uuid4().hex[:12]
        self.title = title
        self.status = "queued"  # queued | running | done | failed
        self.steps = [{"name": s, "status": "pending", "detail": ""} for s in steps]
        self.progress = 0.0
        self.message = ""
        self.result: dict[str, Any] = {}
        self.created = self.updated = time.time()

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "title": self.title, "status": self.status, "steps": self.steps, "progress": round(self.progress, 3),
                "message": self.message, "result": self.result, "created": self.created, "updated": self.updated}


class JobStore:
    def __init__(self, path: Optional[str] = STORE_FILE):
        self.path, self.lock, self.jobs = path, threading.RLock(), {}
        self._load()

    def _load(self) -> None:
        try:
            for data in json.load(open(self.path, encoding="utf-8")):
                job = Job(data["title"], [])
                job.__dict__.update({k: data[k] for k in ("id", "status", "steps", "progress", "message", "result", "created", "updated")})
                if job.status in ("queued", "running"):  # the process that ran it is gone
                    job.status, job.message = "failed", "Interrompu par un redemarrage de la passerelle."
                self.jobs[job.id] = job
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def _save(self) -> None:
        if not self.path:
            return
        recent = sorted(self.jobs.values(), key=lambda j: j.created)[-KEEP:]
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            json.dump([j.to_dict() for j in recent], open(tmp, "w", encoding="utf-8"))
            os.replace(tmp, self.path)
        except OSError:
            pass

    def create(self, title: str, steps: list[str]) -> Job:
        with self.lock:
            job = Job(title, steps)
            self.jobs[job.id] = job
            self._save()
            return job

    def get(self, job_id: str) -> Optional[Job]:
        return self.jobs.get(job_id)

    def list(self) -> list[dict[str, Any]]:
        with self.lock:
            return [j.to_dict() for j in sorted(self.jobs.values(), key=lambda j: -j.created)]

    def update(self, job: Job, *, step: Optional[int] = None, step_status: Optional[str] = None, detail: str = "",
               progress: Optional[float] = None, message: Optional[str] = None, status: Optional[str] = None) -> None:
        with self.lock:
            if step is not None and step_status:
                job.steps[step]["status"] = step_status
                job.steps[step]["detail"] = detail
            if progress is not None:
                job.progress = max(0.0, min(1.0, progress))
            if message is not None:
                job.message = message
            if status:
                job.status = status
            job.updated = time.time()
            self._save()

    def run(self, job: Job, work: Callable[["JobStore", Job], None]) -> threading.Thread:
        """Runs `work(store, job)` on a daemon thread; an exception becomes status failed with its message."""
        def target() -> None:
            self.update(job, status="running")
            try:
                work(self, job)
                self.update(job, status="done", progress=1.0)
            except Exception as exc:  # noqa: BLE001 - every failure is reported on the job, never lost
                self.update(job, status="failed", message=str(exc)[:400])
        thread = threading.Thread(target=target, daemon=True, name=f"compute-{job.id}")
        thread.start()
        return thread
