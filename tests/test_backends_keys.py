r"""Backend API keys at rest (spec 05 §4): DPAPI-encrypted on Windows, plain-text files migrated on load.

Run: C:\Python314\python.exe -m pytest tests -q
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from core import backends, secret_file  # noqa: E402

SECRET = "sk-test-0123456789abcdef"
windows_only = pytest.mark.skipif(sys.platform != "win32", reason="DPAPI is a Windows API")


@pytest.fixture()
def store(tmp_path, monkeypatch):
    path = tmp_path / "backends.json"
    monkeypatch.setattr(backends, "STORE", str(path))
    backends._backends.clear()
    yield path
    backends._backends.clear()


@windows_only
def test_backends_register_key_file_has_no_clear_key_and_reload_decrypts(store):
    # Arrange
    backends.register("modal-l40s", "modal", "https://m.modal.run", api_key=SECRET)
    # Act
    raw = store.read_text(encoding="utf-8")
    backends._backends.clear()
    backends.init("http://127.0.0.1:8080")
    # Assert
    assert SECRET not in raw and "api_key_dpapi" in raw
    assert backends.get("modal-l40s")["api_key"] == SECRET


@windows_only
def test_backends_clear_key_file_is_migrated_to_dpapi_on_load(store):
    # Arrange
    store.write_text(json.dumps([{"id": "colab-a100", "kind": "colab", "base_url": "https://x.trycloudflare.com",
                                  "api_key": SECRET, "models": []}]), encoding="utf-8")
    # Act
    backends.init("http://127.0.0.1:8080")
    # Assert
    assert SECRET not in store.read_text(encoding="utf-8")
    assert backends.get("colab-a100")["api_key"] == SECRET


def test_backends_unreadable_blob_drops_key_and_reports_error(store):
    # Arrange
    store.write_text(json.dumps([{"id": "colab-a100", "kind": "colab", "base_url": "https://x.trycloudflare.com",
                                  "api_key_dpapi": "AAAA", "models": []}]), encoding="utf-8")
    # Act
    backends.init("http://127.0.0.1:8080")
    # Assert
    b = backends.get("colab-a100")
    assert b["api_key"] is None and "à ressaisir" in b["error"]


def test_shared_llama_key_is_stable_and_sent_to_local_backends(store, tmp_path):
    # Arrange
    key_file = tmp_path / "llama.key"
    first = secret_file.ensure_secret_file(str(key_file))
    # Act
    second = secret_file.ensure_secret_file(str(key_file))
    backends.init("http://127.0.0.1:8080", "http://127.0.0.1:8081", api_key=first)
    # Assert
    assert first and first == second == key_file.read_text(encoding="utf-8")
    assert backends.headers(backends.get("local"))["Authorization"] == f"Bearer {first}"
    assert backends.headers(backends.get("draft"))["Authorization"] == f"Bearer {first}"


def test_backends_without_dpapi_keeps_clear_key(store, monkeypatch):
    # Arrange
    monkeypatch.setattr(backends, "DPAPI", False)
    # Act
    backends.register("kaggle-t4", "kaggle", "https://k.trycloudflare.com", api_key=SECRET)
    backends._backends.clear()
    backends.init("http://127.0.0.1:8080")
    # Assert
    assert SECRET in store.read_text(encoding="utf-8")
    assert backends.get("kaggle-t4")["api_key"] == SECRET
