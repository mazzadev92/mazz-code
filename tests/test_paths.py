"""MAZZ_HOME: single data root (portable mode).

Run: C:\\Python314\\python.exe -m pytest tests -q
"""
import os

from core import hf_sync
from core.paths import mazz_home, mazz_path
from core.secret_file import read_secret


def test_paths_unset_env_returns_user_profile_default(monkeypatch):
    monkeypatch.delenv("MAZZ_HOME", raising=False)
    assert mazz_home() == os.path.expanduser(os.path.join("~", ".mazz"))


def test_paths_blank_env_returns_default(monkeypatch):
    monkeypatch.setenv("MAZZ_HOME", "  ")
    assert mazz_home() == os.path.expanduser(os.path.join("~", ".mazz"))


def test_paths_env_override_joins_without_creating_dirs(monkeypatch, tmp_path):
    monkeypatch.setenv("MAZZ_HOME", str(tmp_path))
    assert mazz_home() == str(tmp_path)
    assert mazz_path("a", "b.txt") == os.path.join(str(tmp_path), "a", "b.txt")
    assert not (tmp_path / "a").exists()  # no side effect


def test_paths_relative_env_returns_absolute_path(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("MAZZ_HOME", "data")
    assert os.path.isabs(mazz_home())
    assert mazz_home() == str(tmp_path / "data")


def test_paths_hf_token_reads_env_file_under_mazz_home(monkeypatch, tmp_path):
    monkeypatch.setenv("MAZZ_HOME", str(tmp_path))
    monkeypatch.delenv("HF_TOKEN", raising=False)
    (tmp_path / "env").write_text("HF_TOKEN=hf_portable\n", encoding="utf-8")
    assert read_secret(mazz_path("env")).strip() == "HF_TOKEN=hf_portable"
    assert hf_sync.get_hf_token() == "hf_portable"
