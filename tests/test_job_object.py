"""Windows job object: closing the gateway's handle must terminate the spawned tree."""
import subprocess
import sys

import pytest

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.dirname(__file__)))

from core import job_object  # noqa: E402

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="Job Objects are a Windows API")


@windows_only
def test_closing_the_job_terminates_the_child_tree():
    # Arrange
    child = subprocess.Popen(
        ["cmd", "/c", "ping", "-n", "30", "127.0.0.1"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    job = job_object.attach(child.pid)
    # Act
    assert job, "Windows a refusé l'assignation au job"
    job_object.close(job)
    child.wait(timeout=10)
    # Assert
    assert child.poll() is not None
