"""Circuit breaker per provider: N consecutive failures open it for a cooldown that doubles up to a cap.

State is persisted. A new API key resets the state at once, so pasting a valid key reactivates a provider that was
cooling down on the old one.
"""
from __future__ import annotations

import hashlib
import time
from typing import Any, Callable, Optional

from ..loader import BreakerSettings
from .store import StateStore


def key_fingerprint(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


class Breaker:
    def __init__(self, settings: BreakerSettings, store: StateStore, clock: Callable[[], float] = time.time):
        self.settings, self.store, self.clock = settings, store, clock

    def _state(self, provider_id: str) -> dict[str, Any]:
        return self.store.section("breaker").setdefault(
            provider_id, {"failures": 0, "open_until": 0.0, "level": 0, "last_error": None, "invalid_key": False, "key_fp": None})

    def sync_key(self, provider_id: str, key: str) -> None:
        state = self._state(provider_id)
        fingerprint = key_fingerprint(key)
        if state["key_fp"] != fingerprint:
            state.update(failures=0, open_until=0.0, level=0, last_error=None, invalid_key=False, key_fp=fingerprint)
            self.store.save()

    def allow(self, provider_id: str) -> bool:
        return self.clock() >= self._state(provider_id)["open_until"]

    def cooldown_remaining(self, provider_id: str) -> float:
        return max(0.0, self._state(provider_id)["open_until"] - self.clock())

    def info(self, provider_id: str) -> dict[str, Any]:
        state = self._state(provider_id)
        return {"open": not self.allow(provider_id), "cooldown_s": round(self.cooldown_remaining(provider_id)), "failures": state["failures"],
                "last_error": state["last_error"], "invalid_key": state["invalid_key"]}

    def record_failure(self, provider_id: str, error: Optional[str] = None, hard: bool = False, invalid_key: bool = False) -> None:
        """`hard` opens at once (rejected key); otherwise the failure counts toward the threshold. `error` is already redacted."""
        state = self._state(provider_id)
        state["failures"] += 1
        state["last_error"] = (error or "")[:200] or None
        if invalid_key:
            state["invalid_key"] = True
        if hard or state["failures"] >= self.settings.failures:
            state["level"] += 1
            cooldown = self.settings.max_backoff_s if hard else min(self.settings.cooldown_s * 2 ** (state["level"] - 1), self.settings.max_backoff_s)
            state["open_until"] = self.clock() + cooldown
        self.store.save()

    def record_success(self, provider_id: str) -> None:
        state = self._state(provider_id)
        state.update(failures=0, open_until=0.0, level=0, last_error=None, invalid_key=False)
        self.store.save()
