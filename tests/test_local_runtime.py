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
