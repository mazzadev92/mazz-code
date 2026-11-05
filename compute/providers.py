"""Remote compute providers: where a model can be sent and served. Each one can report its state, deploy a model, list its
deployments and stop them. Deployed models announce themselves to MAZZ Control (compute/gpu_server_body.py) and then show
up in /v1/models as <backend>/<model>; nothing here touches the router or the gateway's request path."""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

from core import backends
from core.hf_sync import default_repo, get_hf_token
from core.paths import mazz_home, mazz_path
from core.secret_file import read_secret

from . import logs as keptlogs
from .serverscript import build_server_script, served_name_for

KEYS = Path(mazz_home())
Runner = Callable[[list[str], int], "subprocess.CompletedProcess[str]"]


def kaggle_dir() -> Path:
    """Kaggle credentials folder: KAGGLE_CONFIG_DIR, else inside MAZZ_HOME in portable mode, else ~/.kaggle."""
    if os.environ.get("KAGGLE_CONFIG_DIR"):
        return Path(os.environ["KAGGLE_CONFIG_DIR"])
    return Path(mazz_path("kaggle")) if os.environ.get("MAZZ_HOME", "").strip() else Path.home() / ".kaggle"


def run_command(argv: list[str], timeout: int = 120) -> "subprocess.CompletedProcess[str]":
    env = {**os.environ, "PYTHONWARNINGS": "ignore", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "KAGGLE_CONFIG_DIR": str(kaggle_dir())}
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
                                   hf_repo=spec.repo if spec.engine == "llama" else default_repo(), announce_repo=default_repo(), max_model_len=spec.max_model_len,
                                   idle_minutes=spec.idle_minutes, max_hours=spec.max_hours,
                                   hf_token=(get_hf_token() if embed_token else None), saturn_stop=saturn_stop)


# =============================================================================================== Saturn Cloud
class Saturn(Provider):
    BASE = os.environ.get("SATURN_BASE_URL", "https://app.community.saturnenterprise.io")
    SIZE = "g4dnxlarge"  # NVIDIA T4, the GPU of the free organisation
    PREFIX = "mazz-gguf"

    def __init__(self, transport: Optional[httpx.BaseTransport] = None):
        super().__init__("saturn", "Saturn Cloud (T4)", "GPU NVIDIA T4 16 Go, plan gratuit, arret automatique 1 h.",
                         "ATTENTION : le plan free-org affiche 0 heure de calcul (demarrage refuse, verifie le 2026-11-04) et 15 Gio de disque. Il faut un abonnement Saturn pour demarrer : utilise Kaggle en gratuit.",
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
                "auto_shutoff": "1 hour", "self_destruct": True, "disk_space": "15Gi", "start_script": start, "tags": {"project": "mazz"},
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
    """Kaggle script kernels with a GPU. Credentials: kaggle.json in kaggle_dir() (the Kaggle CLI is pointed there with KAGGLE_CONFIG_DIR)."""

    def __init__(self, runner: Runner = run_command):
        super().__init__("kaggle", "Kaggle (GPU gratuit)", "Notebook GPU T4/P100 gratuit, tourne tout seul puis s'arrete.",
                         "Quota GPU hebdomadaire gratuit (environ 30 h, a verifier), sessions de 9 a 12 h. Aucune carte.",
                         accepts=("gguf", "diffusers", "diffusers_video", "triposr"),
                         setup=["Cree un compte kaggle.com et verifie ton telephone", "Settings > API > Create New Token", "Le fichier kaggle.json se place dans %USERPROFILE%\\.kaggle"],
                         needs_token=True, token_label="Jeton API Kaggle (kaggle.json : {\"username\":..., \"key\":...})", default_backend="kaggle-t4")
        self._run = runner

    def _username(self) -> Optional[str]:
        try:
            return json.loads((kaggle_dir() / "kaggle.json").read_text(encoding="utf-8")).get("username")
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
        folder = kaggle_dir()
        folder.mkdir(parents=True, exist_ok=True)
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

    def _keep_log(self, deployment_id: str) -> str:
        """Saves the kernel log before the kernel is deleted; never raises (a lost log must not block the stop)."""
        try:
            with tempfile.TemporaryDirectory(prefix="mazz-kaggle-log-") as folder:
                self._cli("kernels", "output", deployment_id, "-p", folder, timeout=120)
                raw = b"".join(p.read_bytes() for p in sorted(Path(folder).glob("*.log")))
            return keptlogs.save(self.id, deployment_id, keptlogs.tail_bytes(raw)) if raw else ""
        except Exception:  # noqa: BLE001
            return ""

    def stop(self, deployment_id: str) -> dict[str, Any]:
        log = self._keep_log(deployment_id)
        r = self._cli("kernels", "delete", deployment_id, "-y", timeout=60)
        return {"stopped": r.returncode == 0, "detail": (r.stdout or r.stderr).strip()[:160], "log": log}


# =============================================================================================== Google Colab (CLI in WSL)
class Colab(Provider):
    """Colab driven through Google's `colab` CLI installed in WSL Debian (login done once by the owner with
    D:\\Google Colab\\cli\\login_colab.bat). deploy: new T4 VM -> upload the server script -> start it detached -> the model announces
    itself like on Kaggle. When WSL, the CLI or the login is missing, MAZZ falls back to a notebook to open by hand."""
    CLI = "~/.local/bin/colab"
    DISTRO = "Debian"
    PREFIX = "mazz-"
    REMOTE = "/content/mazz_gpu_server.py"
    LOG = "/content/server.log"
    LAUNCHER = ("import subprocess\n"
                f"subprocess.Popen(['python', '{REMOTE}'], stdout=open('{LOG}', 'w'), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)\n"
                "print('lance')\n")

    def __init__(self, folder: Optional[Path] = None, runner: Runner = run_command):
        super().__init__("colab", "Google Colab (CLI)", "VM Colab GPU T4 pilotee par la CLI Google (WSL), arretee a la fin ; notebook manuel si la CLI est indisponible.",
                         "Consomme des unites de calcul Colab Pro (T4 : environ 1,8 unite/h) ; le serveur s'arrete seul (inactivite ou duree max).",
                         setup=["Installe la CLI : D:\\Google Colab\\cli\\install_cli_wsl.sh (WSL Debian)", "Connecte-toi une fois : D:\\Google Colab\\cli\\login_colab.bat",
                                "Envoie un modele vers Colab : MAZZ cree la VM, lance le serveur, puis l'arrete", "Sans CLI : MAZZ genere un notebook a ouvrir dans Colab"],
                         default_backend="colab-t4", accepts=("gguf", "diffusers", "diffusers_video", "triposr"))
        self.folder = folder or Path(mazz_path("notebooks"))
        self._run = runner

    # -- plumbing ------------------------------------------------------------------------------------------------------
    @staticmethod
    def _clean(text: str) -> str:
        """`wsl` prints some messages in UTF-16 (NULs once decoded as UTF-8); the CLI adds an update banner: drop both."""
        lines = text.replace("\x00", "").replace("\r", "").splitlines()
        return "\n".join(line for line in lines if line.strip() and (not line.startswith("[colab] ") or "No active" in line))

    def _wsl(self, command: str, timeout: int = 60) -> "subprocess.CompletedProcess[str]":
        """Run a shell command in WSL with stdin closed (a login prompt must never hang) and a hard timeout."""
        r = self._run(["wsl", "-d", self.DISTRO, "--", "bash", "-lc", f"timeout {max(timeout - 5, 5)} {command} </dev/null"], timeout)
        return subprocess.CompletedProcess(r.args, r.returncode, self._clean(r.stdout or ""), self._clean(r.stderr or ""))

    def _cli(self, *args: str, timeout: int = 60) -> "subprocess.CompletedProcess[str]":
        return self._wsl(" ".join([self.CLI, *map(shlex.quote, args)]), timeout)

    def _state(self) -> tuple[str, str, str]:
        """(state, detail, sessions_output), state in wsl_missing | cli_missing | not_logged_in | ready. Never starts a VM."""
        login = "Connexion Google Colab absente ou expiree : lance D:\\Google Colab\\cli\\login_colab.bat."
        try:
            probe = self._wsl(f"bash -c 'test -x {self.CLI} && echo MAZZ_CLI || echo MAZZ_NOCLI'", 30)
        except FileNotFoundError:
            return "wsl_missing", "WSL absent : installe WSL puis la distribution Debian (wsl --install -d Debian).", ""
        except (subprocess.TimeoutExpired, OSError) as exc:
            return "wsl_missing", f"WSL ne repond pas ({type(exc).__name__}).", ""
        if "MAZZ_NOCLI" in probe.stdout:
            return "cli_missing", "CLI Colab absente de WSL Debian : lance D:\\Google Colab\\cli\\install_cli_wsl.sh.", ""
        if "MAZZ_CLI" not in probe.stdout:
            return "wsl_missing", f"Distribution WSL '{self.DISTRO}' introuvable ou arretee : {(probe.stdout or probe.stderr)[:120]}", ""
        try:
            sessions = self._cli("sessions", timeout=60)
        except (subprocess.TimeoutExpired, OSError):
            return "not_logged_in", login, ""
        if sessions.returncode != 0:
            return "not_logged_in", login, ""
        return "ready", "", sessions.stdout

    @staticmethod
    def _names(sessions_output: str) -> list[str]:
        return list(dict.fromkeys(re.findall(r"\bmazz-[a-z0-9][a-z0-9-]*", sessions_output)))

    # -- Provider API --------------------------------------------------------------------------------------------------
    def check(self) -> dict[str, Any]:
        state, detail, sessions = self._state()
        if state != "ready":
            return {"configured": state == "not_logged_in", "ok": False, "state": state, "detail": detail}
        count = len(self._names(sessions))
        return {"configured": True, "ok": True, "state": state, "sessions": count, "detail": f"CLI Colab prete - {count} session(s) MAZZ active(s)."}

    def deployments(self) -> list[dict[str, Any]]:
        state, _detail, sessions = self._state()
        return [{"id": n, "name": n, "status": "active"} for n in self._names(sessions)] if state == "ready" else []

    def deploy(self, spec: DeploySpec, progress: Callable[[str], None]) -> dict[str, Any]:
        spec.backend_id = spec.backend_id or self.default_backend
        state, detail, sessions = self._state()
        if state != "ready":
            return self._notebook(spec, f"{detail} Repli sur le notebook a ouvrir a la main.")
        if self._names(sessions):
            raise ComputeError(f"Une session Colab MAZZ tourne deja ({', '.join(self._names(sessions))}) : arrete-la d'abord.")
        name = (self.PREFIX + re.sub(r"[^a-z0-9]+", "-", spec.name().lower()).strip("-"))[:40].rstrip("-")
        script = self._script(spec, embed_token=True)  # private VM destroyed at stop: same trade-off as Kaggle
        created = False
        try:
            with tempfile.TemporaryDirectory(prefix="mazz-colab-") as folder:
                server, launcher = Path(folder, "mazz_gpu_server.py"), Path(folder, "launch.py")
                server.write_text(script, encoding="utf-8")
                launcher.write_text(self.LAUNCHER, encoding="utf-8")
                progress("Creation de la VM Colab (GPU T4)")
                self._must(self._cli("new", "--gpu", "T4", "-s", name, timeout=300), "creation de la VM")
                created = True
                progress("Envoi du serveur sur la VM")
                self._must(self._cli("upload", self._wsl_path(server), self.REMOTE, "-s", name, timeout=180), "envoi du script")
                progress("Lancement du serveur (detache)")
                self._must(self._cli("exec", "-s", name, "-f", self._wsl_path(launcher), "--timeout", "60", timeout=120), "lancement du serveur")
        except (ComputeError, subprocess.TimeoutExpired, OSError) as exc:
            if created:
                try:
                    self._cli("stop", "-s", name, timeout=120)
                except (subprocess.TimeoutExpired, OSError):
                    pass
            if isinstance(exc, ComputeError):
                raise
            raise ComputeError(f"Colab : {type(exc).__name__} pendant le deploiement (VM arretee si elle existait).") from exc
        return {"deployment_id": name, "backend_id": spec.backend_id, "model": f"{spec.backend_id}/{spec.name()}"}

    def stop(self, deployment_id: str) -> dict[str, Any]:
        try:  # keep the server log before the VM (and its log) disappears; never blocks the stop
            text = self.logs(deployment_id, 4000)
            log = keptlogs.save(self.id, deployment_id, text) if text else ""
        except Exception:  # noqa: BLE001
            log = ""
        r = self._cli("stop", "-s", deployment_id, timeout=120)
        return {"stopped": r.returncode == 0, "detail": (r.stdout or r.stderr).strip()[:160], "log": log}

    def logs(self, deployment_id: str, lines: int = 40) -> str:
        """Tail of the server log on the VM (diagnostic)."""
        with tempfile.TemporaryDirectory(prefix="mazz-colab-") as folder:
            code = Path(folder, "tail.py")
            code.write_text(f"print(''.join(open('{self.LOG}').readlines()[-{int(lines)}:]))\n", encoding="utf-8")
            r = self._cli("exec", "-s", deployment_id, "-f", self._wsl_path(code), "--timeout", "30", timeout=60)
        return (r.stdout or r.stderr).strip()

    # -- helpers -------------------------------------------------------------------------------------------------------
    @staticmethod
    def _must(r: "subprocess.CompletedProcess[str]", what: str) -> None:
        if r.returncode != 0:
            raise ComputeError(f"Colab : echec de {what} : {((r.stderr or r.stdout).strip() or 'code ' + str(r.returncode))[:250]}")

    @staticmethod
    def _wsl_path(path: Path) -> str:
        p = path.resolve()
        return f"/mnt/{p.drive[0].lower()}{p.as_posix()[2:]}" if p.drive else p.as_posix()

    def _notebook(self, spec: DeploySpec, why: str) -> dict[str, Any]:
        script = self._script(spec, embed_token=False)
        cells = [
            {"cell_type": "markdown", "metadata": {}, "source": [f"# MAZZ : {spec.backend_id}/{spec.name()}\n", "Ajoute le secret `HF_TOKEN` (icone cle a gauche), active un GPU (Execution > Modifier le type d'execution), puis Execution > Tout executer."]},
            {"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": (script).splitlines(keepends=True)},
        ]
        self.folder.mkdir(parents=True, exist_ok=True)
        path = self.folder / f"{spec.backend_id}-{spec.name()}.ipynb"
        path.write_text(json.dumps({"cells": cells, "metadata": {"accelerator": "GPU", "colab": {"provenance": []}}, "nbformat": 4, "nbformat_minor": 5}, ensure_ascii=False), encoding="utf-8")
        return {"deployment_id": str(path), "backend_id": spec.backend_id, "model": f"{spec.backend_id}/{spec.name()}", "manual": True,
                "instructions": f"{why} Ouvre {path} dans Colab (colab.research.google.com > Importer), ajoute le secret HF_TOKEN, active le GPU, puis Tout executer."}


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
                           env={**os.environ, **env, "PYTHONWARNINGS": "ignore", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            raise ComputeError(f"Modal refuse le deploiement : {(r.stderr or r.stdout).strip()[-250:]}")
        url = next((m for m in re.findall(r"https://\S+\.modal\.run", r.stdout + r.stderr)), "")
        backend_id = spec.backend_id or "modal-vllm"
        out = {"deployment_id": "mazz-router-model", "backend_id": backend_id, "model": spec.name(), "url": url}
        try:  # passive backend: never probed (a probe would wake and bill the GPU), health is learned from real requests
            key = Path(mazz_path("modal-vllm.key")).read_text(encoding="utf-8").strip()
            if url and key:
                backends.register(backend_id, "modal", url, api_key=key, label=f"{spec.name()} (Modal)", models=[spec.name()], passive=True)
                return {**out, "model": f"{backend_id}/{spec.name()}", "registered": True}
        except (OSError, ValueError):
            pass
        return {**out, "instructions": "Enregistre l'URL comme backend (Fournisseurs > Ajouter) avec la cle du secret mazz-vllm-key."}

    def stop(self, deployment_id: str) -> dict[str, Any]:
        r = subprocess.run([sys.executable, "-m", "modal", "app", "stop", "-y", "mazz-router-model"], capture_output=True, text=True,
                           timeout=120, env={**os.environ, "PYTHONWARNINGS": "ignore", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}, encoding="utf-8", errors="replace")
        backends.remove("modal-vllm")
        return {"stopped": r.returncode == 0, "detail": (r.stdout or r.stderr).strip()[-160:]}


# =============================================================================================== Hugging Face (account)
class HuggingFace(Provider):
    """Not a GPU: the user's Hugging Face token. It lets the app download models without storing them and upload a model
    to the user's own repository. Stored as a HF_TOKEN line in <MAZZ_HOME>/env (the file core.hf_sync reads, DPAPI-protected)."""

    API = "https://huggingface.co/api/whoami-v2"

    def __init__(self, transport: Optional[httpx.BaseTransport] = None):
        super().__init__("huggingface", "Hugging Face (jeton)", "Bibliotheque de modeles : telechargement a la demande et envoi de vos modeles.",
                         "Compte gratuit. Jeton Read pour telecharger, Write seulement pour envoyer vos propres modeles.",
                         accepts=(), setup=["Cree un compte sur huggingface.co", "Settings > Access Tokens > Create new token (Read, ou Write pour envoyer)", "Colle le jeton ici"],
                         needs_token=True, token_label="Jeton d'acces Hugging Face (hf_...)")
        self._transport = transport

    def configure(self, token: str, extra: Optional[dict[str, str]] = None) -> dict[str, Any]:
        token = token.strip()
        if not re.fullmatch(r"hf_[A-Za-z0-9]{20,}", token):
            raise ComputeError("Jeton Hugging Face invalide : il commence par hf_ (Settings > Access Tokens).")
        info = self._whoami(token)
        if info is None:
            raise ComputeError("Hugging Face refuse ce jeton (expire, revoque ou mal copie).")
        env_file = Path(mazz_path("env"))
        env_file.parent.mkdir(parents=True, exist_ok=True)
        lines = [ln for ln in (read_secret(str(env_file)) or "").splitlines() if ln.strip() and not ln.startswith("HF_TOKEN=")]
        env_file.write_text("\n".join([*lines, f"HF_TOKEN={token}"]) + "\n", encoding="utf-8")
        read_secret(str(env_file))  # migrates the file to DPAPI at once
        return self.check()

    def _whoami(self, token: str) -> Optional[dict[str, Any]]:
        try:
            with httpx.Client(timeout=20, transport=self._transport) as client:
                r = client.get(self.API, headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError:
            raise ComputeError("Hugging Face injoignable : verifie ta connexion.") from None
        return r.json() if r.status_code == 200 else None

    def check(self) -> dict[str, Any]:
        token = get_hf_token()
        if not token:
            return {"configured": False, "ok": None, "detail": "Jeton absent."}
        try:
            info = self._whoami(token)
        except ComputeError as exc:
            return {"configured": True, "ok": None, "detail": str(exc)}
        if info is None:
            return {"configured": True, "ok": False, "detail": "Jeton refuse par Hugging Face."}
        role = ((info.get("auth") or {}).get("accessToken") or {}).get("role", "?")
        return {"configured": True, "ok": True, "detail": f"Compte {info.get('name', '?')}, droits : {role}", "role": role}


def all_providers() -> dict[str, Provider]:
    providers = [HuggingFace(), Saturn(), Kaggle(), Colab(), Modal()]
    return {p.id: p for p in providers}
