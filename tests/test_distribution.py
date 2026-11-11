import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import build_dist  # noqa: E402
from core import hf_sync  # noqa: E402


def test_manifest_references_existing_paths():
    manifest = build_dist.load_manifest()
    for entry in manifest["include"]:
        assert os.path.exists(os.path.join(build_dist.ROOT, entry)), entry
    files = build_dist.shipped_files(manifest)
    assert "app.py" in files and not any(f.endswith((".pyc", ".db")) or os.path.basename(f) == ".env" for f in files)


def test_build_refuses_non_empty_destination(tmp_path):
    (tmp_path / "x").write_text("1")
    with pytest.raises(FileExistsError):
        build_dist.build(str(tmp_path))


def test_default_repo_env_wins(monkeypatch):
    monkeypatch.setenv("MAZZ_HF_REPO", "me/repo")
    assert hf_sync.default_repo() == "me/repo"


def test_default_repo_without_token_is_clear_error(monkeypatch):
    from compute.providers import ComputeError
    monkeypatch.delenv("MAZZ_HF_REPO", raising=False)
    monkeypatch.setattr(hf_sync, "get_hf_token", lambda: None)
    with pytest.raises(ComputeError, match="Connectez votre compte Hugging Face"):
        hf_sync.default_repo()


def test_default_repo_from_whoami_is_cached(monkeypatch):
    calls = []

    class R:
        status_code = 200
        def json(self): return {"name": "alice"}

    monkeypatch.delenv("MAZZ_HF_REPO", raising=False)
    monkeypatch.setattr(hf_sync, "get_hf_token", lambda: "hf_t")
    monkeypatch.setattr(hf_sync, "_whoami_cache", {})
    monkeypatch.setattr(hf_sync.httpx, "get", lambda *a, **k: calls.append(1) or R())
    assert hf_sync.default_repo() == "alice/mazz-cloud"
    assert hf_sync.default_repo() == "alice/mazz-cloud"
    assert len(calls) == 1


def test_ensure_repo_creates_private_once(monkeypatch):
    made = []

    class Api:
        def create_repo(self, **kw): made.append(kw)

    monkeypatch.setattr(hf_sync, "_ensured", set())
    hf_sync.ensure_repo(Api(), "a/b")
    hf_sync.ensure_repo(Api(), "a/b")
    assert len(made) == 1 and made[0]["private"] is True and made[0]["exist_ok"] is True


def test_ensure_announce_repo_creates_transport_repo_before_deploy(monkeypatch):
    from compute import hf as compute_hf

    made = []

    class Api:
        def create_repo(self, **kw): made.append(kw)

    monkeypatch.setattr(hf_sync, "_ensured", set())
    monkeypatch.setattr(compute_hf, "_api", lambda: Api())
    assert compute_hf.ensure_announce_repo("bob/mazz-cloud") == "bob/mazz-cloud"
    assert made == [{"repo_id": "bob/mazz-cloud", "repo_type": "model", "private": True, "exist_ok": True}]
