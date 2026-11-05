"""Server logs of remote GPU machines, kept on disk before the machine is deleted (a stopped Kaggle kernel or Colab VM
takes its log with it). Files: <MAZZ_HOME>/logs/compute/<provider>-<id>-<UTC timestamp>.log, secrets redacted."""
from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Optional

from core.paths import mazz_path

KEEP_FILES = 20
KEEP_BYTES = 200_000
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.log$")
# Tokens and key-like values. Every hex run of 32-64 is redacted (nonce, derived key, also git SHAs: accepted loss).
_SECRETS = [
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}"), r"\1[REDACTED]"),
    (re.compile(r"(?i)((?:token|key|secret|password|api[_-]?key)['\"]?\s*[=:]\s*['\"]?)[^\s'\"]+"), r"\1[REDACTED]"),
    (re.compile(r"\b(?:hf_|ghp_|gho_|ghs_|gsk_|sk-|nvapi-|AIza)[A-Za-z0-9_-]{10,}"), "[REDACTED]"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{10,}"), "[REDACTED]"),
    (re.compile(r"\bxox[abp]-[A-Za-z0-9-]{10,}"), "[REDACTED]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}"), "[REDACTED]"),
    (re.compile(r"\b[0-9a-fA-F]{32,64}\b"), "[REDACTED]"),
]


def logs_dir() -> Path:
    return Path(mazz_path("logs", "compute"))


def redact(text: str) -> str:
    for pattern, repl in _SECRETS:
        text = pattern.sub(repl, text)
    return text


def tail_bytes(raw: bytes) -> str:
    return redact(raw[-KEEP_BYTES:].decode("utf-8", errors="replace"))


def save(provider: str, deployment_id: str, text: str) -> str:
    """Writes the (redacted, last KEEP_BYTES) log and prunes to the KEEP_FILES newest; returns the file name."""
    folder = logs_dir()
    folder.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^a-z0-9]+", "-", deployment_id.lower()).strip("-")[:60] or "x"
    name = f"{provider}-{slug}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.log"
    (folder / name).write_bytes(tail_bytes(text.encode("utf-8", errors="replace")).encode("utf-8"))
    for old in sorted(folder.glob("*.log"), key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True)[KEEP_FILES:]:
        old.unlink(missing_ok=True)
    return name


def list_logs() -> list[dict]:
    folder = logs_dir()
    files = sorted(folder.glob("*.log"), key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True) if folder.is_dir() else []
    return [{"name": p.name, "size_bytes": p.stat().st_size, "modified": p.stat().st_mtime} for p in files if NAME_RE.match(p.name)]


def read(name: str) -> Optional[str]:
    """None when the name is not a plain log file name or does not exist (no path ever leaves logs_dir)."""
    if not NAME_RE.match(name):
        return None
    path = logs_dir() / name
    return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else None
