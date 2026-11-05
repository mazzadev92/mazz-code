"""Send a model to a compute provider: prepare it on Hugging Face (upload when it is local), deploy it, wait until the
remote server has announced itself to MAZZ Control. Every step is reported on a Job the Studio polls."""
from __future__ import annotations

import os
import time
from typing import Any, Callable, Optional

from core import backends, library

from . import hf
from .catalog import CATALOG
from .jobs import Job, JobStore
from .providers import COLAB_GPUS, ComputeError, DeploySpec, Provider, all_providers
from .serverscript import served_name_for

ANNOUNCE_TIMEOUT_S = 20 * 60
ANNOUNCE_POLL_S = 10
MEDIA_ENGINES = ("diffusers", "diffusers_video", "triposr", "trellis")  # image, video, 3D: a repo without file, served by our own script


class ComputeService:
    def __init__(self, providers: Optional[dict[str, Provider]] = None, jobs: Optional[JobStore] = None,
                 announce_timeout: float = ANNOUNCE_TIMEOUT_S, announce_poll: float = ANNOUNCE_POLL_S, hf_module=hf):
        self.providers = providers or all_providers()
        self.jobs = jobs or JobStore()
        self.announce_timeout, self.announce_poll, self.hf = announce_timeout, announce_poll, hf_module

    # ------------------------------------------------------------------ read side
    def provider(self, provider_id: str) -> Provider:
        found = self.providers.get(provider_id)
        if not found:
            raise ComputeError(f"Fournisseur de calcul inconnu : {provider_id}")
        return found

    def sources(self) -> dict[str, Any]:
        local = [{"filename": m["filename"], "id": m["id"], "size_bytes": m["size_bytes"], "quant": m.get("quant"),
                  "size_label": m.get("size_label"), "fits_local": m.get("fits_local")} for m in library.list_local()]
        repo = self.hf.default_repo()
        try:
            remote, error = self.hf.list_files(repo), None
        except Exception as exc:  # noqa: BLE001 - HF unreachable or token missing: the local list still works
            remote, error = [], f"{type(exc).__name__}"
        return {"local": local, "hf": {"repo": repo, "files": remote, "error": error}}

    def forget(self, backend_id: str) -> None:
        """Drops a previous announcement and its registered backend: only a fresh start may report 'ready'."""
        self.hf.withdraw(backend_id)
        current = backends.get(backend_id)
        if current and current.get("source") == "announce":
            backends.remove(backend_id)

    def serving(self) -> list[dict[str, Any]]:
        return [backends.public(b) for b in backends.all_backends() if b["kind"] not in ("local",)]

    # ------------------------------------------------------------------ send
    def send(self, source: dict[str, Any], target: str, options: Optional[dict[str, Any]] = None) -> Job:
        options = options or {}
        provider = self.provider(target)
        kind = source.get("type")
        if kind == "local":
            entry = library.find_local(str(source.get("filename", "")))
            if not entry:
                raise ComputeError("Modele local introuvable dans la bibliotheque.")
            repo, file, local_path = self.hf.default_repo(), entry["filename"], entry["path"]
        elif kind == "hf":
            repo, file, local_path = str(source.get("repo") or self.hf.default_repo()), str(source.get("file") or ""), None
        else:
            raise ComputeError("source.type : local ou hf")
        is_gguf = file.lower().endswith(".gguf")
        engine = str(options.get("engine") or "")
        if engine and engine not in MEDIA_ENGINES:
            raise ComputeError("options.engine : diffusers, diffusers_video, triposr ou trellis (les autres moteurs se deduisent du fichier)")
        if not engine and kind == "hf" and not file:  # image/video/3D repo known to the catalogue
            engine = next((m["engine"] or m["planned_engine"] for m in CATALOG if m["repo"] == repo and (m["engine"] or m["planned_engine"]) in MEDIA_ENGINES), "")
        if engine == "trellis" and provider.id != "colab":
            raise ComputeError("TRELLIS : Colab uniquement (GPU 16 Go ou plus).")
        gpu = str(options.get("gpu") or "t4").lower()
        if gpu not in COLAB_GPUS:
            raise ComputeError(f"options.gpu : {', '.join(COLAB_GPUS)}")
        if gpu == "a100" and options.get("confirm_cost") is not True:
            raise ComputeError("GPU A100 : consomme beaucoup plus d'unites de calcul Colab par heure ; ajoute options.confirm_cost = true pour confirmer.")
        if engine == "trellis" and gpu == "t4":
            raise ComputeError("TRELLIS exige un GPU de 16 Go ou plus : options.gpu = l4 (ou a100 avec confirm_cost).")
        if engine:
            if file or engine not in provider.accepts:
                raise ComputeError(f"{provider.label} ne sert pas les modeles d'image, de video ou 3D (Kaggle ou Colab, depot sans fichier).")
            spec = DeploySpec(repo=repo, file="", engine=engine, served_name=str(options.get("served_name") or ""),
                              backend_id=str(options.get("backend_id") or ""), idle_minutes=int(options.get("idle_minutes") or 10),
                              max_hours=float(options.get("max_hours") or 0.9), gpu=gpu)
            job = self.jobs.create(f"{spec.name()} -> {provider.label}", ["Preparer le modele", f"Deployer sur {provider.label}", "Attendre le serveur"])
            self.jobs.run(job, lambda store, j: self._work(store, j, provider, spec, None))
            return job
        if is_gguf and "gguf" not in provider.accepts:
            raise ComputeError(f"{provider.label} ne sert pas les GGUF : choisis un depot Hugging Face (vLLM).")
        if not is_gguf and "hf" not in provider.accepts:
            raise ComputeError(f"{provider.label} ne sert que des GGUF : choisis un fichier .gguf.")
        if kind == "hf" and not file and "hf" not in provider.accepts:
            raise ComputeError("Choisis un fichier .gguf du depot.")
        spec = DeploySpec(repo=repo, file=file if is_gguf else "", engine="llama" if is_gguf else "vllm",
                          served_name=str(options.get("served_name") or ""), backend_id=str(options.get("backend_id") or ""),
                          max_model_len=int(options.get("max_model_len") or 8192), idle_minutes=int(options.get("idle_minutes") or 10),
                          max_hours=float(options.get("max_hours") or 0.9), gpu=gpu)
        job = self.jobs.create(f"{spec.name() or served_name_for(file or repo)} -> {provider.label}",
                               ["Preparer le modele", f"Deployer sur {provider.label}", "Attendre le serveur"])
        self.jobs.run(job, lambda store, j: self._work(store, j, provider, spec, local_path))
        return job

    def _work(self, store: JobStore, job: Job, provider: Provider, spec: DeploySpec, local_path: Optional[str]) -> None:
        # 1. the model must be reachable by the remote machine: Hugging Face
        store.update(job, step=0, step_status="running", message="Verification du modele sur Hugging Face")
        if local_path:
            store.update(job, message="Televersement vers Hugging Face")
            report: Callable[[float], None] = lambda p: store.update(job, progress=0.02 + 0.5 * p, message=f"Televersement vers Hugging Face : {int(p * 100)} %")
            done = self.hf.upload(local_path, spec.file, spec.repo, report)
            store.update(job, step=0, step_status="done", detail=("deja present" if done["status"] == "skipped" else "televerse"))
        elif spec.file:
            if self.hf.file_size(spec.repo, spec.file) is None:
                raise ComputeError(f"{spec.file} introuvable dans {spec.repo} (depot prive : verifie le jeton Hugging Face).")
            store.update(job, step=0, step_status="done", detail="present sur Hugging Face")
        else:
            store.update(job, step=0, step_status="done", detail=spec.repo)
        # 2. deploy
        store.update(job, step=1, step_status="running", progress=0.55, message=f"Deploiement sur {provider.label}")
        if spec.backend_id or provider.default_backend:
            self.forget(spec.backend_id or provider.default_backend)
        result = provider.deploy(spec, lambda text: store.update(job, message=text))
        store.update(job, step=1, step_status="done", progress=0.7, detail=result.get("deployment_id", ""))
        job.result = {**result}
        if result.get("manual"):
            store.update(job, step=2, step_status="done", detail="action manuelle", message=result.get("instructions", ""), progress=1.0)
            return
        if result.get("registered"):  # scale-to-zero backend (Modal): registered at once, the GPU starts on the first request
            store.update(job, step=2, step_status="done", detail=result["model"], message=f"Pret : modele {result['model']} (demarre a la premiere requete)", progress=1.0)
            return
        # 3. wait for the announcement (the gateway polls the announcement repo every 30 s)
        store.update(job, step=2, step_status="running", message="Demarrage du serveur distant (installation, tunnel, chargement du modele)")
        deadline = time.time() + self.announce_timeout
        while time.time() < deadline:
            backend = backends.get(result["backend_id"])
            if backend and backend.get("healthy") is not False and backend.get("source") == "announce":
                job.result["served_model"] = result["model"]
                store.update(job, step=2, step_status="done", detail=result["model"], message=f"Pret : modele {result['model']}", progress=1.0)
                return
            time.sleep(self.announce_poll)
            store.update(job, progress=min(0.95, 0.7 + 0.25 * (1 - (deadline - time.time()) / self.announce_timeout)))
        raise ComputeError("Le serveur distant ne s'est pas annonce dans le delai (20 min) : consulte les logs du fournisseur.")
