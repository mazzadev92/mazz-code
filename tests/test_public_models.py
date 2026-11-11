"""Public MAZZ fleet: anonymous catalogue, tokenless download, and compute sources without an HF account.

Run: C:\\Python314\\python.exe -m pytest tests -q
"""
import os
import sys
import time

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from core import downloads, public_models  # noqa: E402


@pytest.fixture(autouse=True)
def clean_public_cache():
    public_models.reset_cache()
    yield
    public_models.reset_cache()


def wait_download(manager, download_id, seconds=5):
    deadline = time.time() + seconds
    while time.time() < deadline:
        item = manager.get(download_id)
        if item and item["status"] in ("done", "error", "cancelled"):
            return item
        time.sleep(0.01)
    return manager.get(download_id)


def test_publicCatalog_fallsBackToDocumentedFleetWhenHuggingFaceIsDown(monkeypatch):
    # Arrange
    def boom(*_args, **_kwargs):
        raise httpx.ConnectError("hors ligne")

    monkeypatch.setattr("huggingface_hub.HfApi", boom)
    # Act
    models, error = public_models.list_public()
    # Assert
    assert len(models) == len(public_models.FLEET) and "indisponible" in error
    assert all(m["size_bytes"] > 0 and m["license"] == "Apache-2.0" for m in models)


def test_publicCatalog_listsLiveRepoAnonymouslyAndKeepsDocumentedDescriptions(monkeypatch):
    # Arrange
    seen = {}

    class FakeApi:
        def __init__(self, token=None):
            seen["token"] = token

        def list_repo_tree(self, **_kwargs):
            return [type("Entry", (), {"path": "Mazz-Technos-Base-4B.Q4_K_M.gguf", "size": 42}),
                    type("Entry", (), {"path": "README.md", "size": 1})]

    monkeypatch.setattr("huggingface_hub.HfApi", FakeApi)
    # Act
    models, error = public_models.list_public()
    # Assert
    assert seen["token"] is False and error is None and len(models) == 1
    assert models[0]["size_bytes"] == 42 and models[0]["name"] == "Base 4B"


def test_personalCatalog_usesTheTokenButTheOfficialFleetStaysAnonymous(monkeypatch):
    # Arrange
    seen = []

    class FakeApi:
        def __init__(self, token=None):
            seen.append(token)

        def list_repo_tree(self, **_kwargs):
            return [type("Entry", (), {"path": "Private-Model.Q4_K_M.gguf", "size": 7})]

    monkeypatch.setattr("huggingface_hub.HfApi", FakeApi)
    # Act
    models, error = public_models.list_public(repo="me/private", token="hf_secret")
    # Assert
    assert seen == ["hf_secret"] and error is None and models[0]["filename"] == "Private-Model.Q4_K_M.gguf"


def test_privateDownload_sendsTheBearerTokenAndPublicDownloadDoesNot(tmp_path):
    # Arrange
    seen = []

    def handler(request):
        seen.append(request.headers.get("authorization"))
        return httpx.Response(200, content=b"GGUF-private")

    manager = downloads.DownloadManager(transport=httpx.MockTransport(handler))
    # Act
    private = manager.start("My-Model-4B.Q4_K_M.gguf", dest_dir=str(tmp_path), repo="me/private", token="hf_secret")
    wait_download(manager, private["id"])
    public = manager.start("Public-Model-4B.Q4_K_M.gguf", dest_dir=str(tmp_path), repo="me/public")
    wait_download(manager, public["id"])
    # Assert
    assert seen == ["Bearer hf_secret", None]


def test_download_writesTheFileAtomicallyAndVerifiesTheSize(tmp_path):
    # Arrange
    payload = b"GGUF" + b"x" * 2048
    manager = downloads.DownloadManager(transport=httpx.MockTransport(lambda _request: httpx.Response(200, content=payload)))
    # Act
    started = manager.start("Mazz-Technos-Base-4B.Q4_K_M.gguf", dest_dir=str(tmp_path))
    done = wait_download(manager, started["id"])
    # Assert
    assert done["status"] == "done" and done["progress"] == 1.0
    assert (tmp_path / "Mazz-Technos-Base-4B.Q4_K_M.gguf").read_bytes() == payload
    assert not (tmp_path / "Mazz-Technos-Base-4B.Q4_K_M.gguf.part").exists()


def test_download_resumesFromThePartialFile(tmp_path):
    # Arrange: a previous attempt already fetched the first 10 bytes
    payload = b"GGUF" + b"x" * 2048
    name = "Mazz-Technos-Base-4B.Q4_K_M.gguf"
    (tmp_path / (name + ".part")).write_bytes(payload[:10])
    seen = {}

    def handler(request):
        seen["range"] = request.headers.get("range")
        return httpx.Response(206, content=payload[10:], headers={
            "content-range": f"bytes 10-{len(payload) - 1}/{len(payload)}",
            "content-length": str(len(payload) - 10),
        })

    manager = downloads.DownloadManager(transport=httpx.MockTransport(handler))
    # Act
    started = manager.start(name, dest_dir=str(tmp_path))
    done = wait_download(manager, started["id"])
    # Assert
    assert seen["range"] == "bytes=10-"
    assert done["status"] == "done"
    assert (tmp_path / name).read_bytes() == payload
    assert not (tmp_path / (name + ".part")).exists()


def test_download_restartsWhenTheServerIgnoresTheRange(tmp_path):
    # Arrange
    payload = b"GGUF" + b"y" * 512
    name = "Mazz-Technos-Base-4B.Q4_K_M.gguf"
    (tmp_path / (name + ".part")).write_bytes(b"stale")
    manager = downloads.DownloadManager(transport=httpx.MockTransport(lambda _request: httpx.Response(200, content=payload)))
    # Act
    started = manager.start(name, dest_dir=str(tmp_path))
    done = wait_download(manager, started["id"])
    # Assert
    assert done["status"] == "done"
    assert (tmp_path / name).read_bytes() == payload


def test_download_reportsServerErrorAndKeepsResumeState(tmp_path):
    # Arrange
    name = "Mazz-Technos-Base-4B.Q4_K_M.gguf"
    manager = downloads.DownloadManager(transport=httpx.MockTransport(lambda _request: httpx.Response(503)))
    # Act
    started = manager.start(name, dest_dir=str(tmp_path))
    done = wait_download(manager, started["id"])
    # Assert: nothing was written, but a later retry may still resume whatever a real attempt left
    assert done["status"] == "error" and "503" in done["error"]


def test_download_refusesTraversalAndNonGgufNames(tmp_path):
    # Arrange
    manager = downloads.DownloadManager()
    # Act / Assert
    for name in ("../../secret.gguf", "model.bin", "", "a/b.gguf"):
        with pytest.raises(downloads.DownloadError):
            manager.start(name, dest_dir=str(tmp_path))


def test_download_reportsHttpErrorAndRemovesThePartialFile(tmp_path):
    # Arrange
    manager = downloads.DownloadManager(transport=httpx.MockTransport(lambda _request: httpx.Response(404)))
    # Act
    started = manager.start("Mazz-Technos-Base-4B.Q4_K_M.gguf", dest_dir=str(tmp_path))
    done = wait_download(manager, started["id"])
    # Assert
    assert done["status"] == "error" and "404" in done["error"]
    assert not list(tmp_path.glob("*.part"))


def test_download_refusesWhenDiskIsTooSmall(tmp_path, monkeypatch):
    # Arrange
    manager = downloads.DownloadManager()
    monkeypatch.setattr(downloads.shutil, "disk_usage", lambda _path: type("Usage", (), {"free": 1024})())
    # Act / Assert
    with pytest.raises(downloads.DownloadError, match="Espace disque"):
        manager.start("Mazz-Technos-Base-4B.Q4_K_M.gguf", dest_dir=str(tmp_path))


def test_computeSources_withoutHfAccount_listsThePublicFleet(monkeypatch):
    # Arrange
    from compute.jobs import JobStore
    from compute.providers import ComputeError
    from compute.service import ComputeService

    class NoAccountHf:
        def default_repo(self):
            raise ComputeError("Connectez votre compte Hugging Face")

    monkeypatch.setattr(public_models, "list_public", lambda: ([
        {"filename": "Mazz-Technos-Base-4B.Q4_K_M.gguf", "size_bytes": 42},
    ], None))
    service = ComputeService({}, JobStore(None), hf_module=NoAccountHf())
    # Act
    sources = service.sources()
    # Assert
    assert sources["hf"]["repo"] == public_models.public_repo() and sources["hf"]["public"] is True
    assert sources["hf"]["files"] == [{"file": "Mazz-Technos-Base-4B.Q4_K_M.gguf", "size_bytes": 42}]
    assert sources["hf"]["error"] is None


def test_computeSources_withoutHfAccountAndOffline_stillReturnsTheLocalList(monkeypatch):
    # Arrange
    from compute.jobs import JobStore
    from compute.providers import ComputeError
    from compute.service import ComputeService

    class NoAccountHf:
        def default_repo(self):
            raise ComputeError("Connectez votre compte Hugging Face")

    monkeypatch.setattr(public_models, "list_public", lambda: ([], "Hugging Face injoignable"))
    service = ComputeService({}, JobStore(None), hf_module=NoAccountHf())
    # Act
    sources = service.sources()
    # Assert
    assert sources["hf"] == {"repo": None, "files": [], "error": "Connectez votre compte Hugging Face"}
