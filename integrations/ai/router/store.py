"""Persistent router state (breaker, quota counters, last successes) in one atomically written JSON file."""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("mazz.ai.state")


class StateStore:
    """path=None keeps everything in memory (tests)."""

    def __init__(self, path: Optional[Path | str] = None):
        self.path = Path(path) if path else None
        self.lock = threading.RLock()
        self.data: dict[str, dict[str, Any]] = {"breaker": {}, "quota": {}, "status": {}}
        if self.path:
            self._load()

    def _load(self) -> None:
        try:
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
            for name in self.data:
                if isinstance(loaded.get(name), dict):
                    self.data[name] = loaded[name]
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as exc:
            log.warning("etat du routeur illisible (%s) : demarrage a vide", type(exc).__name__)

    def section(self, name: str) -> dict[str, Any]:
        return self.data[name]

    def save(self) -> None:
        if not self.path:
            return
        with self.lock:
            tmp = self.path.with_suffix(".tmp")
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp.write_text(json.dumps(self.data), encoding="utf-8")
                os.replace(tmp, self.path)
            except OSError as exc:
                log.warning("etat du routeur non ecrit (%s)", type(exc).__name__)
