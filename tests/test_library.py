r"""Model library: global RAM budget (spec 00/09) and registry lifecycle (spec 04).

Run: C:\Python314\python.exe -m pytest tests -q
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from core import library, local_runtime  # noqa: E402

GB = 1024**3


def test_library_fit_counts_compactor_ram():
    # Arrange: 9.5 GB of model needs 10.9 GB, alone under 11.5 GB but not with a 1 GB compactor
    size = int(9.5 * GB)
    # Act
    alone = library.fit_for_local(size, total_ram=32 * GB, compactor_bytes=0)
    with_compactor = library.fit_for_local(size, total_ram=32 * GB, compactor_bytes=1 * GB)
    # Assert
    assert alone["fits_local"] is True
    assert with_compactor["fits_local"] is False


def test_library_fit_budget_capped_at_11_5_gb_and_by_machine_ram():
    # Arrange / Act
    big_machine = library.fit_for_local(GB, total_ram=64 * GB, compactor_bytes=0)
    small_machine = library.fit_for_local(GB, total_ram=8 * GB, compactor_bytes=0)
    # Assert
    assert big_machine["ram_budget_bytes"] == library.RAM_CEILING_BYTES
    assert small_machine["ram_budget_bytes"] == 8 * GB - library.RESERVED_RAM_BYTES


def test_library_compactor_ram_read_from_its_gguf_or_zero(tmp_path, monkeypatch):
    # Arrange
    monkeypatch.setattr(library, "MODEL_DIRS", [str(tmp_path)])
    absent = library.compactor_ram_bytes()
    (tmp_path / library.COMPACTOR_FILE).write_bytes(b"G" * 1000)
    # Act
    present = library.compactor_ram_bytes()
    # Assert
    assert absent == 0
    assert present == int(1000 * library.RUNTIME_OVERHEAD)


def test_library_lifecycle_running_for_loaded_model_available_otherwise(tmp_path, monkeypatch):
    # Arrange
    monkeypatch.setattr(library, "MODEL_DIRS", [str(tmp_path)])
    loaded = tmp_path / "loaded.gguf"
    idle = tmp_path / "idle.gguf"
    for f in (loaded, idle):
        f.write_bytes(b"GGUF")
    monkeypatch.setattr(library, "_metadata", lambda path: {})
    monkeypatch.setattr(local_runtime, "state", {"phase": "ready", "model_path": str(loaded)})
    # Act
    states = {m["id"]: m["lifecycle_state"] for m in library.list_local()}
    # Assert
    assert states == {"idle": library.LOCAL_AVAILABLE, "loaded": library.RUNNING}


def test_library_lifecycle_unreadable_gguf_is_only_discovered(tmp_path, monkeypatch):
    # Arrange
    monkeypatch.setattr(library, "MODEL_DIRS", [str(tmp_path)])
    (tmp_path / "partial.gguf").write_bytes(b"xx")
    monkeypatch.setattr(local_runtime, "state", {"phase": "unknown", "model_path": None})
    # Act
    entry = library.list_local()[0]
    # Assert
    assert entry["readable"] is False and entry["lifecycle_state"] == library.DISCOVERED
