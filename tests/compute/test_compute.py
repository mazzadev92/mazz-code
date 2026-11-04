import json
import subprocess
import time

import httpx
import pytest

from compute import providers as prov
from compute.jobs import JobStore
from compute.providers import ComputeError, DeploySpec, Colab, Kaggle, Modal, Provider, Saturn
from compute.serverscript import build_server_script, served_name_for
from compute.service import ComputeService


# ------------------------------------------------------------------ server script
def test_serverscript_build_producesValidPythonWithParametersAndOptionalToken():
    # Arrange / Act
    script = build_server_script(backend_id="kaggle-t4", engine="llama", model="m.gguf", served_name="m", hf_repo="u/r", hf_token="hf_x", saturn_stop=True)
    # Assert
    compile(script, "server.py", "exec")
    assert "MODEL = 'm.gguf'" in script and "HF_REPO = 'u/r'" in script and "os.environ['HF_TOKEN'] = 'hf_x'" in script
    assert "SATURN_RESOURCE_ID" in script and "hf_hub_download(HF_REPO, MODEL" in script


@pytest.mark.parametrize("kwargs", [dict(backend_id="Bad Id"), dict(engine="tensorrt"), dict(model="a b;rm"), dict(max_hours=99)])
def test_serverscript_build_invalidParameters_areRefused(kwargs):
    # Arrange
    base = dict(backend_id="ok-id", engine="llama", model="m.gguf", served_name="m", hf_repo="u/r")
    # Act / Assert
    with pytest.raises(ValueError):
        build_server_script(**{**base, **kwargs})


def test_serverscript_servedName_isLowercaseWithoutExtension():
    assert served_name_for("Mazz-Technos-Ultra-14B.Q4_K_M.gguf") == "mazz-technos-ultra-14b-q4-k-m"
    assert served_name_for("org/Qwen2.5-Coder-7B-Instruct") == "qwen2-5-coder-7b-instruct"


# ------------------------------------------------------------------ jobs
def test_jobs_failingWork_endsFailedWithMessage_andRestartMarksRunningJobsFailed(tmp_path):
    # Arrange
    path = str(tmp_path / "jobs.json")
    store = JobStore(path)
    job = store.create("t", ["a"])

    def boom(_s, _j):
        raise ComputeError("pas de GPU")

    # Act
    store.run(job, boom).join(5)
    pending = store.create("p", ["a"])
    store.update(pending, status="running")
    reborn = JobStore(path)
    # Assert
    assert store.get(job.id).status == "failed" and "pas de GPU" in store.get(job.id).message
    assert reborn.get(pending.id).status == "failed" and "redemarrage" in reborn.get(pending.id).message


# ------------------------------------------------------------------ Saturn
def saturn_transport(requests, workspaces=()):
    def handler(request):
        requests.append(request)
        path = request.url.path
        if path == "/api/user":
            return httpx.Response(200, json={"username": "u"})
        if path == "/api/orgs":
            return httpx.Response(200, json={"orgs": [{"limits": {"name": "free-org", "instance_sizes": ["g4dnxlarge"], "auto_shutoff": 3600}}]})
        if path == "/api/workspaces" and request.method == "GET":
            return httpx.Response(200, json={"workspaces": list(workspaces)})
        if path == "/api/workspaces" and request.method == "POST":
            return httpx.Response(201, json={"id": "ws1"})
        return httpx.Response(200, json={})
    return httpx.MockTransport(handler)


@pytest.fixture()
def keys(tmp_path, monkeypatch):
    monkeypatch.setattr(prov, "KEYS", tmp_path)
    (tmp_path / "saturn.key").write_text("x" * 50, encoding="utf-8")
    monkeypatch.setattr(prov, "read_secret", lambda path: "token-value" if path.endswith("saturn.key") else None)
    monkeypatch.setattr(prov, "get_hf_token", lambda: "hf_test")
    return tmp_path


def test_saturn_deploy_createsFreeT4WorkspaceWithAutoShutoffAndSelfDestruct(keys):
    # Arrange
    seen = []
    saturn = Saturn(saturn_transport(seen))
    # Act
    result = saturn.deploy(DeploySpec(repo="u/r", file="Mazz-14B.Q4_K_M.gguf"), lambda _t: None)
    # Assert
    created = next(r for r in seen if r.method == "POST" and r.url.path == "/api/workspaces")
    body = json.loads(created.content)
    assert body["instance_size"] == "g4dnxlarge" and body["auto_shutoff"] == "1 hour" and body["self_destruct"] is True
    assert body["environment_variables"] == {"HF_TOKEN": "hf_test"} and "mazz_gpu_server.py" in body["start_script"]
    assert created.headers["authorization"] == "token token-value"
    assert result["model"] == "saturn-t4/mazz-14b-q4-k-m" and any(r.url.path == "/api/workspaces/ws1/start" for r in seen)


def test_saturn_deploy_existingMazzWorkspace_isRefusedAndVllmIsNotServed(keys):
    # Arrange
    busy = Saturn(saturn_transport([], workspaces=[{"id": "w", "name": "mazz-gguf-x", "status": "running"}]))
    # Act / Assert
    with pytest.raises(ComputeError, match="deja"):
        busy.deploy(DeploySpec(repo="u/r", file="m.gguf"), lambda _t: None)
    with pytest.raises(ComputeError, match="GGUF"):
        Saturn(saturn_transport([])).deploy(DeploySpec(repo="u/r", file="", engine="vllm"), lambda _t: None)


def test_saturn_configure_rejectsMalformedTokenAndNeverEchoesIt(keys):
    # Arrange / Act / Assert
    with pytest.raises(ComputeError) as raised:
        Saturn(saturn_transport([])).configure("pas un jeton")
    assert "pas un jeton" not in str(raised.value)


# ------------------------------------------------------------------ Kaggle
class FakeRunner:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.calls, self.result = [], subprocess.CompletedProcess([], returncode, stdout, stderr)

    def __call__(self, argv, timeout):
        self.calls.append(argv)
        return self.result


@pytest.fixture()
def kaggle_home(tmp_path, monkeypatch):
    (tmp_path / ".kaggle").mkdir()
    (tmp_path / ".kaggle" / "kaggle.json").write_text(json.dumps({"username": "bob", "key": "k"}), encoding="utf-8")
    monkeypatch.setattr(prov.Path, "home", lambda: tmp_path)
    monkeypatch.setattr(prov, "get_hf_token", lambda: "hf_test")
    return tmp_path


def test_kaggle_deploy_pushesPrivateGpuScriptKernelWithTheServerScript(kaggle_home):
    # Arrange
    result_ok = subprocess.CompletedProcess([], 0, "Kernel version 1 successfully pushed.", "")
    captured = {}

    def capture(argv, timeout):
        folder = argv[argv.index("-p") + 1]
        captured["meta"] = json.loads(open(folder + "/kernel-metadata.json", encoding="utf-8").read())
        captured["code"] = open(folder + "/server.py", encoding="utf-8").read()
        return result_ok

    kaggle = Kaggle(capture)
    # Act
    result = kaggle.deploy(DeploySpec(repo="u/r", file="m.gguf"), lambda _t: None)
    # Assert
    assert captured["meta"]["id"] == "bob/mazz-gguf-m" and captured["meta"]["enable_gpu"] == "true" and captured["meta"]["is_private"] == "true"
    compile(captured["code"], "server.py", "exec")
    assert "hf_test" in captured["code"] and result["model"] == "kaggle-t4/m"


def test_kaggle_check_missingCredentialsAndCliFailure_areReportedWithoutSecrets(kaggle_home):
    # Arrange
    failing = Kaggle(FakeRunner(returncode=1, stderr="401 Unauthorized"))
    # Act
    state = failing.check()
    (kaggle_home / ".kaggle" / "kaggle.json").unlink()
    missing = Kaggle(FakeRunner()).check()
    # Assert
    assert state["ok"] is False and "401" in state["detail"] and missing["configured"] is False


def test_kaggle_deploy_cliError_becomesComputeError(kaggle_home):
    # Arrange
    kaggle = Kaggle(FakeRunner(returncode=1, stderr="Error: quota exceeded"))
    # Act / Assert
    with pytest.raises(ComputeError, match="quota"):
        kaggle.deploy(DeploySpec(repo="u/r", file="m.gguf"), lambda _t: None)


# ------------------------------------------------------------------ Colab / Modal
def test_colab_deploy_writesAnImportableNotebookAndFlagsManualStep(tmp_path, monkeypatch):
    # Arrange
    monkeypatch.setattr(prov, "get_hf_token", lambda: None)
    colab = Colab(tmp_path)
    # Act
    result = colab.deploy(DeploySpec(repo="u/r", file="m.gguf"), lambda _t: None)
    # Assert
    nb = json.loads((tmp_path / "colab-t4-m.ipynb").read_text(encoding="utf-8"))
    assert result["manual"] is True and nb["nbformat"] == 4 and any("MODEL = 'm.gguf'" in "".join(c["source"]) for c in nb["cells"])


def test_modal_deploy_ggufIsRefusedBecauseModalServesHuggingFaceRepos():
    with pytest.raises(ComputeError, match="vLLM"):
        Modal(FakeRunner()).deploy(DeploySpec(repo="u/r", file="m.gguf", engine="llama"), lambda _t: None)


# ------------------------------------------------------------------ service
class FakeProvider(Provider):
    def __init__(self, accepts=("gguf",), manual=False):
        super().__init__("fake", "Fake GPU", "s", "f", accepts=accepts)
        self.manual, self.deployed = manual, []

    def check(self):
        return {"configured": True, "ok": True, "detail": "ok"}

    def deploy(self, spec, progress):
        progress("go")
        self.deployed.append(spec)
        out = {"deployment_id": "d1", "backend_id": "fake-gpu", "model": "fake-gpu/" + spec.name()}
        return {**out, "manual": True, "instructions": "ouvre le notebook"} if self.manual else out


class FakeHf:
    def __init__(self, sizes=None):
        self.uploads, self.sizes = [], sizes or {}

    def default_repo(self):
        return "u/models"

    def upload(self, path, name, repo, callback):
        callback(0.5)
        callback(1.0)
        self.uploads.append((path, name, repo))
        return {"status": "uploaded"}

    def file_size(self, repo, file):
        return self.sizes.get((repo, file))

    def list_files(self, repo):
        return []

    def withdraw(self, backend_id, repo=None):
        self.withdrawn = getattr(self, "withdrawn", []) + [backend_id]
        return True


def service_with(provider, hf=None):
    return ComputeService({"fake": provider}, JobStore(None), announce_timeout=2, announce_poll=0.01, hf_module=hf or FakeHf())


def wait_for(job_store, job_id, seconds=5):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if job_store.get(job_id).status in ("done", "failed"):
            break
        time.sleep(0.02)
    return job_store.get(job_id)


def test_service_send_localModel_uploadsToHuggingFaceThenDeploysAndWaitsForAnnouncement(monkeypatch):
    # Arrange
    hf, provider = FakeHf(), FakeProvider()
    svc = service_with(provider, hf)
    monkeypatch.setattr("compute.service.library.find_local", lambda name: {"filename": "m.gguf", "path": "D:/models/m.gguf"})
    monkeypatch.setattr("compute.service.backends.get", lambda bid: {"healthy": True, "source": "announce"} if bid == "fake-gpu" else None)
    # Act
    job = svc.send({"type": "local", "filename": "m.gguf"}, "fake")
    done = wait_for(svc.jobs, job.id)
    # Assert
    assert hf.uploads == [("D:/models/m.gguf", "m.gguf", "u/models")]
    assert done.status == "done" and done.result["served_model"] == "fake-gpu/m" and [s["status"] for s in done.steps] == ["done"] * 3


def test_service_send_hfFileMissing_failsTheJobWithAClearMessage():
    # Arrange
    svc = service_with(FakeProvider(), FakeHf(sizes={}))
    # Act
    job = svc.send({"type": "hf", "repo": "u/models", "file": "absent.gguf"}, "fake")
    done = wait_for(svc.jobs, job.id)
    # Assert
    assert done.status == "failed" and "introuvable" in done.message


def test_service_send_formatNotAcceptedByProvider_isRefusedBeforeAnyWork():
    # Arrange
    svc = service_with(FakeProvider(accepts=("hf",)))
    # Act / Assert
    with pytest.raises(ComputeError, match="GGUF"):
        svc.send({"type": "hf", "repo": "u/models", "file": "m.gguf"}, "fake")
    with pytest.raises(ComputeError, match="inconnu"):
        svc.send({"type": "hf", "repo": "u/models", "file": "m.gguf"}, "nope")


def test_service_send_manualProvider_endsDoneWithInstructionsWithoutWaiting():
    # Arrange
    svc = service_with(FakeProvider(manual=True), FakeHf(sizes={("u/models", "m.gguf"): 1}))
    # Act
    job = svc.send({"type": "hf", "repo": "u/models", "file": "m.gguf"}, "fake")
    done = wait_for(svc.jobs, job.id)
    # Assert
    assert done.status == "done" and "notebook" in done.message


def test_service_send_serverNeverAnnounces_failsAfterTheTimeout(monkeypatch):
    # Arrange
    svc = service_with(FakeProvider(), FakeHf(sizes={("u/models", "m.gguf"): 1}))
    monkeypatch.setattr("compute.service.backends.get", lambda bid: None)
    # Act
    job = svc.send({"type": "hf", "repo": "u/models", "file": "m.gguf"}, "fake")
    done = wait_for(svc.jobs, job.id, seconds=6)
    # Assert
    assert done.status == "failed" and "annonce" in done.message


def test_hf_progressFile_isBinaryBufferedIoAndReportsProgress(tmp_path):
    # Arrange: huggingface_hub refuses anything that is not an io.BufferedIOBase (regression of the first real upload)
    import io
    from compute.hf import _ProgressFile
    path = tmp_path / "m.gguf"
    path.write_bytes(b"x" * 1000)
    seen = []
    # Act
    handle = _ProgressFile(str(path), seen.append)
    data = handle.read()
    handle.close()
    # Assert
    assert isinstance(handle, io.BufferedIOBase) and len(data) == 1000 and len(handle) == 1000 and seen and seen[-1] <= 0.99


def test_service_send_staleAnnouncementOfTheSameBackend_isWithdrawnBeforeDeploying(monkeypatch):
    # Arrange: an old announcement (previous run) must not make the new deployment look ready at once
    hf, provider = FakeHf(), FakeProvider()
    provider.default_backend = "fake-gpu"
    svc = service_with(provider, hf)
    removed, order = [], []
    monkeypatch.setattr("compute.service.library.find_local", lambda name: {"filename": "m.gguf", "path": "D:/m.gguf"})
    monkeypatch.setattr("compute.service.backends.get", lambda bid: {"healthy": True, "source": "announce"})
    monkeypatch.setattr("compute.service.backends.remove", lambda bid: removed.append(bid) or True)
    # Act
    done = wait_for(svc.jobs, svc.send({"type": "local", "filename": "m.gguf"}, "fake").id)
    # Assert
    assert hf.withdrawn == ["fake-gpu"] and removed == ["fake-gpu"] and done.status == "done"


def test_service_send_registeredBackend_endsDoneWithoutWaitingForAnnouncement():
    # Arrange
    class Registered(FakeProvider):
        def deploy(self, spec, progress):
            return {"deployment_id": "d", "backend_id": "modal-x", "model": "modal-x/m", "registered": True}
    svc = service_with(Registered(accepts=("gguf", "hf")), FakeHf(sizes={("u/models", "m.gguf"): 1}))
    # Act
    done = wait_for(svc.jobs, svc.send({"type": "hf", "repo": "u/models", "file": "m.gguf"}, "fake").id, seconds=1)
    # Assert
    assert done.status == "done" and "premiere requete" in done.message


def test_catalog_fits_followsVramAndEngine_andNonLlmHasNoServingEngine():
    # Arrange
    from compute.catalog import catalog
    by_id = {m["id"]: m for m in catalog()}
    # Act / Assert
    assert by_id["qwen3-14b"]["fits"] == {"kaggle": True, "colab": True, "saturn": True}
    assert by_id["qwen3-30b-a3b"]["fits"]["kaggle"] is False
    assert by_id["qwen25-coder-32b-awq"]["fits"] == {"modal": True}
    assert by_id["flux-schnell"]["engine"] is None and by_id["flux-schnell"]["fits"] == {} and by_id["flux-schnell"]["api_alternatives"]
    assert all(m["file"].endswith(".gguf") for m in by_id.values() if m["engine"] == "gguf")


def test_catalog_route_returnsTheModels(env=None):
    # Arrange
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from compute.routes import router
    app = FastAPI()
    app.include_router(router)
    # Act
    data = TestClient(app).get("/compute/catalog").json()
    # Assert
    assert len(data["models"]) >= 15 and {"text", "image", "video", "3d"} <= {m["modality"] for m in data["models"]}
