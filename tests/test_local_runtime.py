r"""Local llama-server supervisor: command line per model and process ownership.

Run: C:\Python314\python.exe -m pytest tests -q
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from core import local_runtime  # noqa: E402

GB = 1024**3


def arg(args, flag):
    return args[args.index(flag) + 1]


def test_runtime_build_args_small_model_gets_16k_context():
    # Arrange / Act
    args = local_runtime.build_args(r"D:\m\Base-4B.gguf", int(2.5 * GB), "4B")
    # Assert
    assert arg(args, "-c") == "16384"
    assert arg(args, "-m") == r"D:\m\Base-4B.gguf"
    assert "--no-repack" not in args


def test_runtime_build_args_14b_gets_4k_context_and_no_repack():
    # Arrange / Act
    args = local_runtime.build_args(r"D:\m\Ultra-14B.gguf", 9 * GB, "14B")
    # Assert
    assert arg(args, "-c") == "4096"
    assert "--no-repack" in args


def test_runtime_build_args_without_label_uses_file_size():
    # Arrange / Act
    small = local_runtime.build_args("a.gguf", 4 * GB)
    large = local_runtime.build_args("b.gguf", 6 * GB)
    # Assert
    assert arg(small, "-c") == "16384"
    assert arg(large, "-c") == "8192"


def test_runtime_build_args_prefix_cache_flags_single_slot_q8_kv():
    # Arrange / Act
    args = local_runtime.build_args("a.gguf", 2 * GB, "0.6B")
    # Assert
    assert arg(args, "--cache-reuse") == "256"
    assert arg(args, "--slot-save-path") == local_runtime.SLOT_DIR
    assert arg(args, "--parallel") == "1"
    assert arg(args, "-ctk") == "q8_0" and arg(args, "-ctv") == "q8_0"
    assert args.count("-c") == 1


class FakeProc:
    def __init__(self, pid, name, cmdline):
        self.pid = pid
        self.info = {"pid": pid, "name": name, "cmdline": cmdline}
        self.terminated = False

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.terminated = True


def test_runtime_stop_servers_kills_own_pid_and_explicit_port_only(monkeypatch, capsys):
    # Arrange
    ours = FakeProc(100, "llama-server.exe", ["llama-server.exe", "-m", "a.gguf"])
    squatter = FakeProc(200, "llama-server.exe", ["llama-server.exe", "--port", "8080"])
    other_port = FakeProc(300, "llama-server.exe", ["llama-server.exe", "--port", "8081"])
    no_port = FakeProc(400, "llama-server.exe", ["llama-server.exe", "-m", "b.gguf"])
    not_llama = FakeProc(500, "python.exe", ["python.exe", "--port", "8080"])
    procs = [ours, squatter, other_port, no_port, not_llama]
    monkeypatch.setattr(local_runtime.psutil, "process_iter", lambda attrs: iter(procs))
    monkeypatch.setattr(local_runtime.psutil, "wait_procs", lambda ps, timeout: (ps, []))
    monkeypatch.setitem(local_runtime.state, "pid", 100)
    # Act
    stopped = local_runtime._stop_servers()
    # Assert
    assert stopped == 2
    assert [p.pid for p in procs if p.terminated] == [100, 200]
    log = capsys.readouterr().out
    assert "PID 100 (lancé par la passerelle)" in log and "PID 200 (externe, --port 8080)" in log
