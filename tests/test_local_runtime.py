r"""Local llama-server supervisor: command line per model and process ownership.

Run: C:\Python314\python.exe -m pytest tests -q
"""
import asyncio
import os
import sys

import pytest

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
    # The key is passed by file, never by value, so it cannot leak through ps or the log.
    assert arg(args, "--api-key-file") == local_runtime.LLAMA_KEY_FILE
    assert not any(str(part).startswith("Bearer ") for part in args)


class FakeProc:
    def __init__(self, pid, name, cmdline):
        self.pid = pid
        self.info = {"pid": pid, "name": name, "cmdline": cmdline}
        self.terminated = False

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.terminated = True


def test_runtime_stop_servers_never_kills_an_external_llama_server(monkeypatch, capsys):
    # Arrange: the gateway owns PID 100; a hand-started server holds 8080.
    ours = FakeProc(100, "llama-server.exe", ["llama-server.exe", "-m", "a.gguf"])
    squatter = FakeProc(200, "llama-server.exe", ["llama-server.exe", "--port", "8080"])

    class Proc:
        def __init__(self, fake):
            self.fake = fake
            self.pid = fake.pid

        def terminate(self):
            self.fake.terminate()

        def kill(self):
            self.fake.kill()

    monkeypatch.setattr(local_runtime, "is_llama_server", lambda pid: pid == 100)
    monkeypatch.setattr(local_runtime.psutil, "Process", lambda pid: Proc(ours))
    monkeypatch.setattr(local_runtime.psutil, "wait_procs", lambda ps, timeout: (ps, []))
    monkeypatch.setitem(local_runtime.state, "pid", 100)
    monkeypatch.setitem(local_runtime.state, "job", None)
    # Act
    stopped = local_runtime._stop_servers()
    # Assert: only the gateway's own process is stopped; the squatter is left alone.
    assert stopped == 1
    assert ours.terminated and not squatter.terminated
    assert "PID 100 (lancé par la passerelle)" in capsys.readouterr().out


def test_runtime_refuses_a_foreign_process_on_the_local_port(monkeypatch):
    async def nothing_loaded(_client):
        return None

    monkeypatch.setattr(local_runtime, "loaded_model", nothing_loaded)
    monkeypatch.setattr(local_runtime, "listener_pid", lambda _port: 200)
    monkeypatch.setattr(local_runtime, "is_llama_server", lambda _pid: False)
    monkeypatch.setattr(local_runtime, "_process_name", lambda _pid: "python.exe")
    monkeypatch.setitem(local_runtime.state, "pid", None)
    with pytest.raises(RuntimeError, match="processus étranger"):
        asyncio.run(local_runtime.ensure_loaded(None, "a.gguf"))


def test_runtime_refuses_to_kill_an_external_llama_server_with_another_model(monkeypatch):
    async def other_model(_client):
        return r"D:\m\other.gguf"

    monkeypatch.setattr(local_runtime, "loaded_model", other_model)
    monkeypatch.setattr(local_runtime, "listener_pid", lambda _port: 200)
    monkeypatch.setattr(local_runtime, "is_llama_server", lambda _pid: True)
    monkeypatch.setitem(local_runtime.state, "pid", None)
    with pytest.raises(RuntimeError, match="llama-server externe"):
        asyncio.run(local_runtime.ensure_loaded(None, "a.gguf"))
