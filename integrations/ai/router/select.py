"""Provider status and candidate selection: capability filter, then cost class, then priority."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from ..adapters.base import ProviderAdapter
from ..loader import EnvStore, Provider, Registry, expand, provider_disabled, provider_key
from .breaker import Breaker
from .quota import Quota
from .store import StateStore

ELIGIBLE = ("untested", "active")


@dataclass
class Candidate:
    spec: Provider
    key: str


def provider_status(spec: Provider, env: EnvStore, breaker: Breaker, quota: Quota, store: StateStore) -> str:
    """missing_url | missing_key | disabled | cooldown | exhausted | untested | active."""
    if provider_disabled(spec, env):
        return "disabled"
    if expand(spec.base_url, env) is None:
        return "missing_url"
    key = provider_key(spec, env)
    if key is None:
        return "missing_key"
    breaker.sync_key(spec.id, key)
    if not breaker.allow(spec.id):
        return "cooldown"
    if quota.exhausted(spec):
        return "exhausted"
    return "active" if store.section("status").get(spec.id, {}).get("last_ok") else "untested"


def serves(spec: Provider, adapters: dict[str, type[ProviderAdapter]], capability: str) -> bool:
    """The registry declares the capability and the adapter implements it."""
    cls = adapters.get(spec.adapter)
    if cls is None or capability not in cls.implements:
        return False
    required = {"chat", "vision"} if capability == "vision" else {capability}
    return required <= set(spec.capabilities)


def select_candidates(registry: Registry, env: EnvStore, breaker: Breaker, quota: Quota, store: StateStore,
                      adapters: dict[str, type[ProviderAdapter]], capability: str, exclude: Optional[set[str]] = None) -> list[Candidate]:
    rank = {name: i for i, name in enumerate(registry.router.cost_order)}
    found: list[Candidate] = []
    for spec in registry.providers:
        if spec.id in (exclude or set()) or not serves(spec, adapters, capability):
            continue
        if provider_status(spec, env, breaker, quota, store) in ELIGIBLE:
            found.append(Candidate(spec, provider_key(spec, env) or ""))
    found.sort(key=lambda c: (rank.get(c.spec.cost_class, len(rank)), c.spec.priority))
    return found
