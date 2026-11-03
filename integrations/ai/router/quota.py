"""Quota counters and reset windows.

reset: continuous (sliding 60 s rpm/tpm only), daily (reset_hour in reset_tz), weekly (Sunday 00:00 UTC),
monthly (the 1st at reset_hour in reset_tz), never. A request is counted BEFORE the call and refused at the cap.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional
from zoneinfo import ZoneInfo

from ..loader import Provider
from .store import StateStore

MINUTE = 60.0


def window_start(now: float, reset: str, tz: str, hour: int) -> Optional[float]:
    """Start (epoch seconds) of the window containing `now`; None for continuous, 0.0 for never."""
    if reset == "continuous":
        return None
    if reset == "never":
        return 0.0
    if reset == "weekly":
        midnight = datetime.fromtimestamp(now, timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        return (midnight - timedelta(days=(midnight.weekday() + 1) % 7)).timestamp()
    local = datetime.fromtimestamp(now, ZoneInfo(tz))
    if reset == "daily":
        start = local.replace(hour=hour, minute=0, second=0, microsecond=0)
        if start > local:
            start -= timedelta(days=1)
        return start.timestamp()
    start = local.replace(day=1, hour=hour, minute=0, second=0, microsecond=0)  # monthly
    if start > local:
        start = (start - timedelta(days=1)).replace(day=1, hour=hour)
    return start.timestamp()


def next_reset(now: float, reset: str, tz: str, hour: int) -> Optional[float]:
    """Instant the current window ends; None when it never does."""
    start = window_start(now, reset, tz, hour)
    if start is None or reset == "never":
        return None
    if reset == "weekly":
        return start + 7 * 86400
    local = datetime.fromtimestamp(start, ZoneInfo(tz))
    if reset == "daily":
        return (local + timedelta(days=1)).timestamp()
    year, month = (local.year + 1, 1) if local.month == 12 else (local.year, local.month + 1)
    return local.replace(year=year, month=month, day=1).timestamp()


class QuotaExceeded(Exception):
    """`reset_in` seconds until the provider can serve again (None: never within this configuration)."""

    def __init__(self, reason: str, reset_in: Optional[float]):
        super().__init__(reason)
        self.reason, self.reset_in = reason, reset_in


class Quota:
    def __init__(self, store: StateStore, clock: Callable[[], float] = time.time):
        self.store, self.clock = store, clock

    def _state(self, spec: Provider) -> dict[str, Any]:
        now = self.clock()
        limits = spec.limits
        state = self.store.section("quota").setdefault(spec.id, {"window": None, "requests": 0, "tokens": 0, "units": 0, "minute": [], "exhausted_until": 0.0})
        window = window_start(now, limits.reset, limits.reset_tz, limits.reset_hour)
        if state["window"] != window:
            state.update(window=window, requests=0, tokens=0, units=0)
        state["minute"] = [m for m in state["minute"] if now - m[0] < MINUTE]
        return state

    def _reset_in(self, spec: Provider) -> Optional[float]:
        limits = spec.limits
        end = next_reset(self.clock(), limits.reset, limits.reset_tz, limits.reset_hour)
        return None if end is None else max(0.0, end - self.clock())

    def check(self, spec: Provider, tokens: int = 0, units: int = 0, reserve: bool = False) -> None:
        """Raises QuotaExceeded when one more request (with these tokens and units) would pass a cap; reserves it when asked."""
        now, state, limits = self.clock(), self._state(spec), spec.limits
        if state["exhausted_until"] > now:
            raise QuotaExceeded("plafond signale par le fournisseur", state["exhausted_until"] - now)
        minute = state["minute"]
        if limits.rpm is not None and len(minute) + 1 > limits.rpm:
            raise QuotaExceeded("rpm atteint", max(0.0, minute[0][0] + MINUTE - now))
        if limits.tpm is not None and sum(m[1] for m in minute) + tokens > limits.tpm:
            raise QuotaExceeded("tpm atteint", max(0.0, minute[0][0] + MINUTE - now) if minute else MINUTE)
        for cap in (limits.rpd, limits.rpmonth):
            if cap is not None and state["requests"] + 1 > cap:
                raise QuotaExceeded("requetes de la fenetre epuisees", self._reset_in(spec))
        for cap in (limits.tpd, limits.tpmonth):
            if cap is not None and state["tokens"] + tokens > cap:
                raise QuotaExceeded("tokens de la fenetre epuises", self._reset_in(spec))
        if limits.unit_cap is not None and state["units"] + units > limits.unit_cap:
            raise QuotaExceeded(f"{limits.units or 'unites'} de la fenetre epuisees", self._reset_in(spec))
        if reserve:
            state["requests"] += 1
            state["tokens"] += tokens
            state["units"] += units
            minute.append([now, tokens])
            self.store.save()

    def adjust(self, spec: Provider, reserved_tokens: int, actual_tokens: Optional[int], reserved_units: int = 0, actual_units: Optional[int] = None) -> None:
        """After a successful call: replace the reserved estimate by the measured usage."""
        state = self._state(spec)
        if actual_tokens:
            state["tokens"] = max(0, state["tokens"] + actual_tokens - reserved_tokens)
        if actual_units:
            state["units"] = max(0, state["units"] + actual_units - reserved_units)
        self.store.save()

    def release(self, spec: Provider, tokens: int = 0, units: int = 0) -> None:
        """The call never reached the provider (config or key error): give the reservation back."""
        state = self._state(spec)
        state["requests"] = max(0, state["requests"] - 1)
        state["tokens"] = max(0, state["tokens"] - tokens)
        state["units"] = max(0, state["units"] - units)
        if state["minute"]:
            state["minute"].pop()
        self.store.save()

    def mark_exhausted(self, spec: Provider, seconds: Optional[float]) -> None:
        """The provider itself refused (429/402): exclude it for `seconds`, or until the window resets when unknown."""
        wait = seconds if seconds is not None else (self._reset_in(spec) or 0.0)
        self._state(spec)["exhausted_until"] = self.clock() + wait
        self.store.save()

    def blocked_for(self, spec: Provider) -> Optional[float]:
        """Seconds until this provider can serve again, 0 when it can now, None when blocked for good."""
        try:
            self.check(spec)
        except QuotaExceeded as exc:
            return exc.reset_in
        return 0.0

    def exhausted(self, spec: Provider) -> bool:
        try:
            self.check(spec)
        except QuotaExceeded:
            return True
        return False

    def snapshot(self, spec: Provider) -> dict[str, Any]:
        state, limits = self._state(spec), spec.limits
        remaining: dict[str, Any] = {}
        for name, cap, used in (("requests", min((c for c in (limits.rpd, limits.rpmonth) if c is not None), default=None), state["requests"]),
                                ("tokens", min((c for c in (limits.tpd, limits.tpmonth) if c is not None), default=None), state["tokens"]),
                                (limits.units or "units", limits.unit_cap, state["units"])):
            if cap is not None:
                remaining[name] = {"used": used, "limit": cap, "remaining": max(0, cap - used)}
        if limits.rpm is not None:
            remaining["rpm"] = {"used": len(state["minute"]), "limit": limits.rpm, "remaining": max(0, limits.rpm - len(state["minute"]))}
        reset_in = self._reset_in(spec)
        return {"limits": remaining, "reset_in_s": None if reset_in is None else round(reset_in), "reset": limits.reset,
                "exhausted_for_s": round(max(0.0, state["exhausted_until"] - self.clock()))}
