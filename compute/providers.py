"""Remote compute providers: where a model can be sent and served. Each one can report its state, deploy a model, list its
deployments and stop them. Deployed models announce themselves to MAZZ Control (compute/gpu_server_body.py) and then show
up in /v1/models as <backend>/<model>; nothing here touches the router or the gateway's request path."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

from core.hf_sync import get_hf_token
from core.secret_file import read_secret

from .serverscript import build_server_script, served_name_for

KEYS = Path(os.path.expandvars(r"%USERPROFILE%\.mazz"))
Runner = Callable[[list[str], int], "subprocess.CompletedProcess[str]"]


def run_command(argv: list[str], timeout: int = 120) -> "subprocess.CompletedProcess[str]":
    env = {**os.environ, "PYTHONWARNINGS": "ignore", "PYTHONIOENCODING": "utf-8"}
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env, encoding="utf-8", errors="replace")


class ComputeError(Exception):
    """A provider refused or could not do what was asked; the message is safe to show (no secret)."""


@dataclass
class DeploySpec:
    """What to serve. `file` is a GGUF inside `repo` (engine llama) or a Hugging Face repo id in `repo` with file="" (vllm)."""
    repo: str
    file: str
    served_name: str = ""
    backend_id: str = ""
    engine: str = "llama"
    max_model_len: int = 8192
    idle_minutes: int = 10
    max_hours: float = 0.9

    def model(self) -> str:
        return self.file or self.repo

    def name(self) -> str:
        return self.served_name or served_name_for(self.model())


@dataclass
class Provider:
    id: str
    label: str
    summary: str
    free_note: str
    accepts: tuple[str, ...] = ("gguf",)  # model formats this provider can serve: gguf, hf (vLLM repo)
    setup: list[str] = field(default_factory=list)
    needs_token: bool = False  # the UI shows a field to paste a token
    token_label: str = ""
    default_backend: str = ""  # backend id announced by this provider when the caller gives none

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "label": self.label, "summary": self.summary, "free_note": self.free_note, "accepts": list(self.accepts),
                "setup": self.setup, "needs_token": self.needs_token, "token_label": self.token_label}

    # -- to override -------------------------------------------------------------------------------------------------
    def check(self) -> dict[str, Any]:
        """{configured: bool, ok: bool|None, detail: str, ...}: cheap, read-only."""
        raise NotImplementedError

    def deploy(self, spec: DeploySpec, progress: Callable[[str], None]) -> dict[str, Any]:
        raise ComputeError(f"{self.label} : deploiement automatique indisponible")

    def deployments(self) -> list[dict[str, Any]]:
        return []

    def stop(self, deployment_id: str) -> dict[str, Any]:
        raise ComputeError(f"{self.label} : arret indisponible")

    def configure(self, token: str, extra: Optional[dict[str, str]] = None) -> dict[str, Any]:
        raise ComputeError(f"{self.label} : rien a saisir ici")

    def _script(self, spec: DeploySpec, *, embed_token: bool, saturn_stop: bool = False) -> str:
        return build_server_script(backend_id=spec.backend_id, engine=spec.engine, model=spec.model(), served_name=spec.name(),
                                   hf_repo=spec.repo if spec.engine == "llama" else "mazz92/mazz-models", max_model_len=spec.max_model_len,
                                   idle_minutes=spec.idle_minutes, max_hours=spec.max_hours,
                                   hf_token=(get_hf_token() if embed_token else None), saturn_stop=saturn_stop)


# =============================================================================================== Saturn Cloud
class Saturn(Provider):
    BASE = os.environ.get("SATURN_BASE_URL", "https://app.community.saturnenterprise.io")
    SIZE = "g4dnxlarge"  # NVIDIA T4, the GPU of the free organisation
    PREFIX = "mazz-gguf"

    def __init__(self, transport: Optional[httpx.BaseTransport] = None):
        super().__init__("saturn", "Saturn Cloud (T4)", "GPU NVIDIA T4 16 Go, plan gratuit, arret automatique 1 h.",
                         "Plan free-org : T4 uniquement, arret auto 1 h, machine supprimee a l'arret. Aucune carte requise.",
                         setup=["Cree un compte sur saturncloud.io", "Settings > API Tokens > New token", "Colle le jeton ici"],
                         needs_token=True, token_label="Jeton API Saturn", default_backend="saturn-t4")
        self._transport = transport

    def _client(self) -> httpx.Client:
        token = read_secret(str(KEYS / "saturn.key"))
        if not token:
            raise ComputeError("Jeton Saturn absent : colle-le dans la carte Saturn.")
        return httpx.Client(base_url=self.BASE, headers={"Authorization": f"token {token}"}, timeout=40, transport=self._transport)

    def configure(self, token: str, extra: Optional[dict[str, str]] = None) -> dict[str, Any]:
        token = token.strip()
        if not re.fullmatch(r"[A-Za-z0-9._-]{40,}", token):
            raise ComputeError("Jeton Saturn invalide (format).")
        path = KEYS / "saturn.key"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(token, encoding="utf-8")
        read_secret(str(path))  # migrates the file to DPAPI at once
        return self.check()

    def check(self) -> dict[str, Any]:
        if not (KEYS / "saturn.key").exists():
            return {"configured": False, "ok": None, "detail": "Jeton absent."}
        try:
            with self._client() as c:
                user = c.get("/api/user")
                if user.status_code in (401, 403):
                    return {"configured": True, "ok": False, "detail": "Jeton refuse par Saturn."}
                orgs = c.get("/api/orgs").json().get("orgs", [])
                limits = (orgs[0].get("limits") or {}) if orgs else {}
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            return {"configured": True, "ok": False, "detail": f"Saturn injoignable ({type(exc).__name__})."}
        gpu = self.SIZE in (limits.get("instance_sizes") or [])
        return {"configured": True, "ok": gpu, "detail": f"Compte {user.json().get('username')} - plan {limits.get('name')} - "
                f"{'GPU T4 autorise' if gpu else 'GPU non autorise par ce plan'} - arret auto {limits.get('auto_shutoff', 0) // 60} min",
                "plan": limits.get("name")}

    def _workspaces(self, c: httpx.Client) -> list[dict[str, Any]]:
        items = c.get("/api/workspaces").json().get("workspaces", [])
        return [w for w in items if str(w.get("name", "")).startswith(self.PREFIX)]

    def deployments(self) -> list[dict[str, Any]]:
        try:
            with self._client() as c:
                return [{"id": w["id"], "name": w["name"], "status": w.get("status")} for w in self._workspaces(c)]
        except (ComputeError, httpx.HTTPError, ValueError):
            return []

    def deploy(self, spec: DeploySpec, progress: Callable[[str], None]) -> dict[str, Any]:
        info = self.check()
        if not info.get("ok"):
            raise ComputeError(f"Saturn indisponible : {info.get('detail')}")
        if spec.engine != "llama":
            raise ComputeError("Saturn : modeles GGUF uniquement.")
        spec.backend_id = spec.backend_id or self.default_backend
        script = self._script(spec, embed_token=False, saturn_stop=True)
        start = ("mkdir -p $HOME/mazz && cat > $HOME/mazz/mazz_gpu_server.py <<'MAZZEOF'\n" + script + "\nMAZZEOF\n"
                 "cd $HOME/mazz && nohup python mazz_gpu_server.py > server.log 2>&1 &\n")
        body = {"name": f"{self.PREFIX}-{spec.name()}"[:48], "description": "MAZZ : serveur GGUF (arret auto 1 h)", "instance_size": self.SIZE,
                "auto_shutoff": "1 hour", "self_destruct": True, "disk_space": "40Gi", "start_script": start, "tags": {"project": "mazz"},
                "environment_variables": {"HF_TOKEN": get_hf_token() or ""}}
        with self._client() as c:
            if self._workspaces(c):
                raise ComputeError("Un serveur MAZZ tourne deja sur Saturn : arrete-le d'abord.")
            progress("Creation du workspace Saturn")
            created = c.post("/api/workspaces", json=body)
            if created.status_code >= 300:
                raise ComputeError(f"Saturn refuse la creation ({created.status_code}) : {created.text[:200]}")
            wid = created.json()["id"]
            progress("Demarrage de la machine GPU")
            started = c.post(f"/api/workspaces/{wid}/start", json={})
            if started.status_code >= 300:
                raise ComputeError(f"Saturn refuse le demarrage ({started.status_code}) : {started.text[:200]}")
        return {"deployment_id": wid, "backend_id": spec.backend_id, "model": f"{spec.backend_id}/{spec.name()}"}

    def stop(self, deployment_id: str) -> dict[str, Any]:
        with self._client() as c:
            c.post(f"/api/workspaces/{deployment_id}/stop", json={})
            deleted = c.delete(f"/api/workspaces/{deployment_id}")
        return {"stopped": True, "delete_status": deleted.status_code}


# =============================================================================================== Kaggle
class Kaggle(Provider):
    """Kaggle script kernels with a GPU. Credentials: ~/.kaggle/kaggle.json (or access_token) as the Kaggle CLI expects."""

    def __init__(self, runner: Runner = run_command):
        super().__init__("kaggle", "Kaggle (GPU gratuit)", "Notebook GPU T4/P100 gratuit, tourne tout seul puis s'arrete.",
                         "Quota GPU hebdomadaire gratuit (environ 30 h, a verifier), sessions de 9 a 12 h. Aucune carte.",
                         setup=["Cree un compte kaggle.com et verifie ton telephone", "Settings > API > Create New Token", "Le fichier kaggle.json se place dans %USERPROFILE%\\.kaggle"],
                         needs_token=True, token_label="Jeton API Kaggle (kaggle.json : {\"username\":..., \"key\":...})", default_backend="kaggle-t4")
        self._run = runner

    def _username(self) -> Optional[str]:
        try:
            return json.loads((Path.home() / ".kaggle" / "kaggle.json").read_text(encoding="utf-8")).get("username")
        except (OSError, ValueError):
            return None

    def _cli(self, *args: str, timeout: int = 120) -> "subprocess.CompletedProcess[str]":
        return self._run([sys.executable, "-m", "kaggle", *args], timeout)

    def configure(self, token: str, extra: Optional[dict[str, str]] = None) -> dict[str, Any]:
        try:
            data = json.loads(token)
            user, key = str(data["username"]), str(data["key"])
        except (ValueError, KeyError, TypeError):
            raise ComputeError('Colle le contenu de kaggle.json : {"username": "...", "key": "..."}') from None
        folder = Path.home() / ".kaggle"
        folder.mkdir(exist_ok=True)
        (folder / "kaggle.json").write_text(json.dumps({"username": user, "key": key}), encoding="utf-8")
        return self.check()

    def check(self) -> dict[str, Any]:
        user = self._username()
        if not user:
            return {"configured": False, "ok": None, "detail": "kaggle.json absent."}
        try:
            r = self._cli("kernels", "list", "--mine", "--page-size", "3", "--csv", timeout=60)
        except (subprocess.TimeoutExpired, OSError) as exc:
            return {"configured": True, "ok": False, "detail": f"CLI Kaggle injoignable ({type(exc).__name__})."}
        ok = r.returncode == 0
        return {"configured": True, "ok": ok, "detail": f"Compte {user} - API {'OK' if ok else 'refusee : ' + (r.stderr or r.stdout)[:120]}"}

    def deployments(self) -> list[dict[str, Any]]:
        user = self._username()
        if not user:
            return []
        try:
            r = self._cli("kernels", "list", "--mine", "-s", "mazz-gguf", "--csv", timeout=60)
        except (subprocess.TimeoutExpired, OSError):
            return []
        rows = [line.split(",") for line in r.stdout.splitlines()[1:] if line.strip()]
        return [{"id": row[0], "name": row[0], "status": "?"} for row in rows if row and row[0].startswith(f"{user}/mazz-gguf")]

    def deploy(self, spec: DeploySpec, progress: Callable[[str], None]) -> dict[str, Any]:
        user = self._username()
        if not user:
            raise ComputeError("kaggle.json absent : configure Kaggle d'abord.")
        spec.backend_id = spec.backend_id or self.default_backend
        # Kaggle derives the URL slug itself (dots become dashes): use the same form or status/stop miss the kernel.
        slug = re.sub(r"[^a-z0-9]+", "-", f"mazz-gguf-{spec.name()}".lower())[:50].strip("-")
        with tempfile.TemporaryDirectory(prefix="mazz-kaggle-") as folder:
            Path(folder, "server.py").write_text(self._script(spec, embed_token=True), encoding="utf-8")
            Path(folder, "kernel-metadata.json").write_text(json.dumps({
                "id": f"{user}/{slug}", "title": slug, "code_file": "server.py", "language": "python", "kernel_type": "script",
                "is_private": "true", "enable_gpu": "true", "enable_internet": "true",
                "dataset_sources": [], "competition_sources": [], "kernel_sources": []}), encoding="utf-8")
            progress("Envoi du noyau Kaggle (GPU)")
            r = self._cli("kernels", "push", "-p", folder, timeout=180)
        if r.returncode != 0 or "error" in (r.stdout + r.stderr).lower() and "successfully" not in (r.stdout + r.stderr).lower():
            raise ComputeError(f"Kaggle refuse le noyau : {(r.stderr or r.stdout).strip()[:250]}")
        return {"deployment_id": f"{user}/{slug}", "backend_id": spec.backend_id, "model": f"{spec.backend_id}/{spec.name()}"}

    def stop(self, deployment_id: str) -> dict[str, Any]:
        r = self._cli("kernels", "delete", deployment_id, "-y", timeout=60)
        return {"stopped": r.returncode == 0, "detail": (r.stdout or r.stderr).strip()[:160]}


# =============================================================================================== Google Colab (assisted)
class Colab(Provider):
    """Colab cannot be started from a script without the user's browser session: MAZZ writes a ready-to-run notebook and
    tells the user to open it. Once it runs, the model announces itself exactly like on Kaggle."""

    def __init__(self, folder: Optional[Path] = None):
        super().__init__("colab", "Google Colab (assisté)", "Notebook pret a lancer dans ton navigateur (GPU T4 gratuit, A100 avec Colab Pro).",
                         "Colab gratuit : GPU T4, sessions de 12 h au plus. Colab Pro est un abonnement payant a part : ne l'active pas si tu veux zero depense.",
                         setup=["Ouvre colab.research.google.com", "Fichier > Importer le notebook genere par MAZZ", "Execution > Tout executer"], default_backend="colab-t4")
        self.folder = folder or Path(r"D:\Google Colab\notebooks\generated")

    def check(self) -> dict[str, Any]:
        return {"configured": True, "ok": True, "detail": "Aucun jeton : MAZZ genere un notebook a ouvrir dans Colab."}

    def deploy(self, spec: DeploySpec, progress: Callable[[str], None]) -> dict[str, Any]:
        spec.backend_id = spec.backend_id or self.default_backend
        script = self._script(spec, embed_token=False)
        cells = [
            {"cell_type": "markdown", "metadata": {}, "source": [f"# MAZZ : {spec.backend_id}/{spec.name()}\n", "Ajoute le secret `HF_TOKEN` (icone cle a gauche), active un GPU (Execution > Modifier le type d'execution), puis Execution > Tout executer."]},
            {"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": (script).splitlines(keepends=True)},
        ]
        self.folder.mkdir(parents=True, exist_ok=True)
        path = self.folder / f"{spec.backend_id}-{spec.name()}.ipynb"
        path.write_text(json.dumps({"cells": cells, "metadata": {"accelerator": "GPU", "colab": {"provenance": []}}, "nbformat": 4, "nbformat_minor": 5}, ensure_ascii=False), encoding="utf-8")
        return {"deployment_id": str(path), "backend_id": spec.backend_id, "model": f"{spec.backend_id}/{spec.name()}", "manual": True,
                "instructions": f"Ouvre {path} dans Colab (colab.research.google.com > Importer), ajoute le secret HF_TOKEN, active le GPU, puis Tout executer."}


# =============================================================================================== Modal
class Modal(Provider):
    """Modal serves Hugging Face repos with vLLM (selfhost/modal/modal_app.py), scale-to-zero. Credentials: ~/.modal.toml."""

    def __init__(self, runner: Runner = run_command):
        super().__init__("modal", "Modal (vLLM, 30 $/mois)", "GPU L40S a la demande avec un credit mensuel Modal ; modeles Hugging Face.",
                         "Credit gratuit mensuel (30 $). Garde la limite de depense a 0 dans la console Modal pour ne jamais depasser.",
                         accepts=("hf",), setup=["Cree un compte modal.com", "Dans un terminal : python -m modal setup", "Console Modal > Settings > Usage : limite de depense a 0"])
        self._run = runner

    def check(self) -> dict[str, Any]:
        if not (Path.home() / ".modal.toml").exists():
            return {"configured": False, "ok": None, "detail": "~/.modal.toml absent (python -m modal setup)."}
        try:
            r = self._run([sys.executable, "-m", "modal", "profile", "current"], 60)
        except (subprocess.TimeoutExpired, OSError) as exc:
            return {"configured": True, "ok": False, "detail": f"CLI Modal injoignable ({type(exc).__name__})."}
        profile = (r.stdout or "").strip().splitlines()[-1:] or ["?"]
        return {"configured": True, "ok": r.returncode == 0, "detail": f"Profil Modal : {profile[0]}"}

    def deploy(self, spec: DeploySpec, progress: Callable[[str], None]) -> dict[str, Any]:
        script = Path(__file__).resolve().parent.parent / "integrations" / "ai" / "selfhost" / "modal" / "modal_app.py"
        if spec.engine != "vllm":
            raise ComputeError("Modal : modeles Hugging Face (vLLM) uniquement, pas de GGUF.")
        progress("Deploiement Modal (peut prendre quelques minutes)")
        env = {"MODEL_REPO": spec.repo, "SERVED_MODEL_NAME": spec.name()}
        r = subprocess.run([sys.executable, "-m", "modal", "deploy", str(script)], capture_output=True, text=True, timeout=900,
                           env={**os.environ, **env, "PYTHONWARNINGS": "ignore"}, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            raise ComputeError(f"Modal refuse le deploiement : {(r.stderr or r.stdout).strip()[-250:]}")
        url = next((m for m in re.findall(r"https://\S+\.modal\.run", r.stdout + r.stderr)), "")
        return {"deployment_id": "mazz-router-model", "backend_id": spec.backend_id or "modal-vllm", "model": spec.name(), "url": url,
                "instructions": "Enregistre l'URL comme backend (Fournisseurs > Ajouter) avec la cle du secret mazz-vllm-key."}


def all_providers() -> dict[str, Provider]:
    providers = [Saturn(), Kaggle(), Colab(), Modal()]
    return {p.id: p for p in providers}
