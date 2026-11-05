import os
import pytest
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
sys.path.insert(0, os.path.dirname(__file__))


@pytest.fixture(autouse=True)
def no_real_cloud_cli(monkeypatch):
    """Safety net: a test must never start a real Colab/Kaggle/Modal session through WSL or a CLI (it spends quota)."""
    import subprocess

    real_run = subprocess.run

    def guarded(argv, *args, **kwargs):
        text = " ".join(map(str, argv)) if isinstance(argv, (list, tuple)) else str(argv)
        if any(word in text.lower() for word in ("wsl", "colab", "kaggle", "modal")):
            raise AssertionError(f"test tried to run a real cloud CLI: {text[:80]}")
        return real_run(argv, *args, **kwargs)

    monkeypatch.setattr("compute.providers.subprocess.run", guarded)


@pytest.fixture(autouse=True)
def isolated_logs(tmp_path, monkeypatch):
    """Kept GPU logs go to a temp folder, never to the owner's MAZZ_HOME."""
    monkeypatch.setattr("compute.logs.logs_dir", lambda: tmp_path / "kept-logs")
