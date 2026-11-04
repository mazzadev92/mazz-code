"""The router: picks a provider (capability, cost class, priority), reserves quota, calls it with a timeout and
falls back to another provider on failure. Pure Python, no web framework: routes and the gateway sit on top of it."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

import httpx

from core.paths import mazz_path
from ..adapters import ADAPTERS
from ..adapters.base import (ChatRequest, ChatResponse, ProviderAdapter, ProviderError, mask_key, redact, to_openai_json)
from ..adapters.openai_compat import OpenAICompatAdapter
from ..loader import REGISTRY_PATH, USER_PROVIDERS_PATH, EnvStore, Registry, expand, load_registry, provider_key, router_enabled
from ..userconfig import user_provider_ids
from .breaker import Breaker
from .quota import Quota, QuotaExceeded
from .select import Candidate, provider_status, select_candidates, serves
from .store import StateStore

log = logging.getLogger("mazz.ai.router")


class NoProviderAvailable(Exception):
    """No provider can serve now: 503 when none is configured, 429 + Retry-After when the configured ones are waiting."""

    def __init__(self, capability: str, missing: list[dict[str, Any]], waiting: list[dict[str, Any]]):
        self.capability, self.missing, self.waiting = capability, missing, waiting
        delays = [w["retry_after_s"] for w in waiting if w["retry_after_s"] is not None]
        self.retry_after: Optional[int] = int(min(delays)) + 1 if delays else None
        self.status = 429 if waiting else 503
        if waiting:
            message = f"Tous les fournisseurs '{capability}' configures sont epuises ou en pause" + (
                f" : reessayez dans {self.retry_after} s." if self.retry_after is not None else ".")
        else:
            names = ", ".join(m["env"] for m in missing[:12] if m.get("env"))
            message = f"Aucun fournisseur actif pour '{capability}'. Variables a definir dans .env : {names or 'voir /integrations/status'}" + (
                f" (+{len(missing) - 12} autres)" if len(missing) > 12 else "")
        super().__init__(message)


class AllProvidersFailed(Exception):
    """Every attempt failed (status 502). `errors` holds redacted messages only."""

    status = 502

    def __init__(self, capability: str, errors: list[dict[str, str]]):
        self.capability, self.errors = capability, errors
        super().__init__(f"Echec de tous les fournisseurs '{capability}' essayes : " + "; ".join(f"{e['provider']} ({e['kind']})" for e in errors))


def synthetic_response(reply: ChatResponse, stream: bool) -> httpx.Response:
    """A native provider's normalized answer as an OpenAI-shaped httpx.Response (JSON or SSE), so the gateway's
    existing translators work on it unchanged."""
    body = to_openai_json(reply)
    if not stream:
        return httpx.Response(200, json=body)
    choice = body["choices"][0]
    delta: dict[str, Any] = {"role": "assistant", "content": choice["message"]["content"]}
    if choice["message"].get("tool_calls"):
        delta["tool_calls"] = [{**call, "index": i} for i, call in enumerate(choice["message"]["tool_calls"])]
    base = {"id": body["id"], "object": "chat.completion.chunk", "created": body["created"], "model": body["model"]}
    chunks = [{**base, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
              {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": choice["finish_reason"]}], "usage": body["usage"]}]
    text = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    return httpx.Response(200, content=text.encode("utf-8"), headers={"content-type": "text/event-stream"})


class Router:
    def __init__(self, registry: Registry, env: EnvStore, store: StateStore, client: httpx.AsyncClient, clock: Callable[[], float] = time.time,
                 adapters: Optional[dict[str, type[ProviderAdapter]]] = None):
        self.registry, self.env, self.store, self.client, self.clock = registry, env, store, client, clock
        self.adapters = adapters or ADAPTERS
        self.breaker = Breaker(registry.router.breaker, store, clock)
        self.quota = Quota(store, clock)

    @classmethod
    def build(cls, client: httpx.AsyncClient, env: Optional[EnvStore] = None, registry_path: Optional[Path | str] = None,
              state_path: Optional[Path | str] = None, clock: Callable[[], float] = time.time) -> "Router":
        """Parses the registry and reads .env. No network access."""
        env = env or EnvStore()
        router_registry_path = registry_path or REGISTRY_PATH
        user_path = Path(env.get("AI_USER_PROVIDERS") or USER_PROVIDERS_PATH)
        registry = load_registry(router_registry_path, known_adapters=set(ADAPTERS), user_path=user_path)
        state = state_path or env.get("AI_ROUTER_STATE") or mazz_path("router_state.json")
        router = cls(registry, env, StateStore(state), client, clock)
        router._registry_path, router._user_path = router_registry_path, user_path
        return router

    def reload(self) -> None:
        """Re-reads registry.yaml and the user's providers (after one was added or removed). Counters and breaker state are kept."""
        self.registry = load_registry(getattr(self, "_registry_path", REGISTRY_PATH), known_adapters=set(self.adapters),
                                      user_path=getattr(self, "_user_path", None))

    @property
    def user_provider_ids(self) -> set[str]:
        return user_provider_ids(Path(getattr(self, "_user_path", None) or USER_PROVIDERS_PATH))

    @property
    def enabled(self) -> bool:
        return router_enabled(self.env)

    def _adapter(self, cand: Candidate) -> ProviderAdapter:
        return self.adapters[cand.spec.adapter](cand.spec, cand.key, self.client, self.env, timeout=self.registry.router.timeout_s)

    # ------------------------------------------------------------------ core loop
    async def run(self, capability: str, call: Callable[[ProviderAdapter], Awaitable[Any]], *, tokens: int = 0, units: int = 0) -> tuple[Any, Candidate]:
        """Calls `call(adapter)` on the best provider, then on up to max_retries other ones. Returns (result, provider)."""
        settings = self.registry.router
        errors: list[dict[str, str]] = []
        exclude: set[str] = set()
        attempts = 0
        while attempts < 1 + settings.max_retries:
            cand = self._reserve_first(capability, exclude, tokens, units)
            if cand is None:
                break
            attempts += 1
            started = time.perf_counter()
            error: Optional[ProviderError] = None
            try:
                async with asyncio.timeout(settings.timeout_s):
                    result = await call(self._adapter(cand))
            except TimeoutError:
                error = ProviderError("timeout", f"{cand.spec.id} : delai de {settings.timeout_s:g} s depasse")
            except ProviderError as exc:
                error = exc
            except Exception as exc:  # an adapter bug must fall back, never surface as a 500
                error = ProviderError("upstream", f"{cand.spec.id} : {type(exc).__name__}")
            latency = time.perf_counter() - started
            if error is None:
                usage = getattr(result, "usage", None)
                self.quota.adjust(cand.spec, tokens, getattr(usage, "total_tokens", 0) or None, units, getattr(usage, "units", 0) or None)
                self.breaker.record_success(cand.spec.id)
                self.store.section("status")[cand.spec.id] = {"last_ok": self.clock()}
                self.store.save()
                log.info("ai-router capability=%s provider=%s reason=ok latency_ms=%d cost_class=%s", capability, cand.spec.id,
                         latency * 1000, cand.spec.cost_class)
                return result, cand
            message = redact(str(error), (cand.key,))
            self._on_error(cand, error, message, tokens, units)
            errors.append({"provider": cand.spec.id, "kind": error.kind, "message": message})
            exclude.add(cand.spec.id)
            log.warning("ai-router capability=%s provider=%s reason=%s latency_ms=%d fallback=%s", capability, cand.spec.id, error.kind,
                        latency * 1000, "next")
        if errors and not all(e["kind"] in ("rate_limit", "quota") for e in errors):
            raise AllProvidersFailed(capability, errors)
        # Nothing configured (503), or every provider is out of quota / rate limited (429 + Retry-After).
        raise self._no_provider(capability)

    def _reserve_first(self, capability: str, exclude: set[str], tokens: int, units: int) -> Optional[Candidate]:
        for cand in select_candidates(self.registry, self.env, self.breaker, self.quota, self.store, self.adapters, capability, exclude):
            try:
                self.quota.check(cand.spec, tokens, units, reserve=True)
            except QuotaExceeded as exc:
                exclude.add(cand.spec.id)
                log.info("ai-router capability=%s provider=%s reason=quota(%s)", capability, cand.spec.id, exc.reason)
                continue
            return cand
        return None

    def _on_error(self, cand: Candidate, error: ProviderError, message: str, tokens: int, units: int) -> None:
        spec, settings = cand.spec, self.registry.router
        if error.kind == "auth":
            self.breaker.record_failure(spec.id, message, hard=True, invalid_key=True)
            self.quota.release(spec, tokens, units)
        elif error.kind == "rate_limit":
            wait = min(error.retry_after or settings.breaker.cooldown_s, settings.retry_after_cap_s)
            self.quota.mark_exhausted(spec, wait)
        elif error.kind == "quota":
            self.quota.mark_exhausted(spec, settings.retry_after_cap_s if spec.limits.reset in ("never", "continuous") else None)
        elif error.kind in ("config", "unsupported"):
            self.quota.release(spec, tokens, units)
        else:
            self.breaker.record_failure(spec.id, message)

    def _no_provider(self, capability: str) -> NoProviderAvailable:
        missing, waiting = [], []
        for spec in self.registry.providers:
            if not serves(spec, self.adapters, capability):
                continue
            status = provider_status(spec, self.env, self.breaker, self.quota, self.store)
            if status in ("missing_key", "missing_url"):
                missing.append({"id": spec.id, "status": status, "env": spec.auth.env})
            elif status in ("cooldown", "exhausted"):
                delay = self.breaker.cooldown_remaining(spec.id) if status == "cooldown" else self.quota.blocked_for(spec)
                waiting.append({"id": spec.id, "status": status, "retry_after_s": delay})
        return NoProviderAvailable(capability, missing, waiting)

    # ------------------------------------------------------------------ capabilities
    async def open_chat(self, req: ChatRequest) -> tuple[httpx.Response, Candidate]:
        """For the gateway: an OpenAI-shaped httpx.Response (streamed when req.stream) and the provider that serves it."""
        async def call(adapter: ProviderAdapter) -> httpx.Response:
            if isinstance(adapter, OpenAICompatAdapter):
                return await adapter.open_chat(req)
            return synthetic_response(await adapter.chat(req), req.stream)

        return await self.run("vision" if req.needs_vision() else "chat", call, tokens=req.estimated_tokens())

    async def chat(self, req: ChatRequest) -> ChatResponse:
        reply, _ = await self.run("vision" if req.needs_vision() else "chat", lambda a: a.chat(req), tokens=req.estimated_tokens())
        return reply

    async def execute(self, capability: str, payload: dict[str, Any]) -> Any:
        """embedding | rerank | tts | stt | image | search | scrape, with the arguments of the matching adapter method."""
        model = payload.get("model")
        if capability == "embedding":
            texts = list(payload["texts"])
            call, tokens, units = (lambda a: a.embed(texts, model)), sum(len(t) for t in texts) // 3 + 1, 0
        elif capability == "rerank":
            call, tokens, units = (lambda a: a.rerank(payload["query"], list(payload["documents"]), model, payload.get("top_n"))), 0, 0
        elif capability == "tts":
            text = payload["text"]
            call, tokens, units = (lambda a: a.tts(text, payload.get("voice"), model)), 0, len(text)
        elif capability == "stt":
            call, tokens, units = (lambda a: a.stt(payload.get("audio"), payload.get("url"), payload.get("mime", "audio/wav"), model)), 0, 0
        elif capability == "image":
            call, tokens, units = (lambda a: a.image(payload["prompt"], model)), 0, 0
        elif capability == "search":
            call, tokens, units = (lambda a: a.search(payload["query"], int(payload.get("limit", 5)))), 0, 0
        elif capability == "scrape":
            call, tokens, units = (lambda a: a.scrape(payload["url"])), 0, 0
        else:
            raise ProviderError("request", f"capability inconnue : {capability}")
        result, _ = await self.run(capability, call, tokens=tokens, units=units)
        return result

    # ------------------------------------------------------------------ status, quota, test
    def status(self) -> dict[str, Any]:
        rows: list[dict[str, Any]] = []
        custom = self.user_provider_ids
        for spec in self.registry.providers:
            status = provider_status(spec, self.env, self.breaker, self.quota, self.store)
            key = provider_key(spec, self.env)
            rows.append({
                "id": spec.id, "label": spec.label, "custom": spec.id in custom, "adapter": spec.adapter, "routed": spec.adapter != "registry_only",
                "capabilities": spec.capabilities, "cost_class": spec.cost_class, "priority": spec.priority, "status": status,
                "env": spec.auth.env, "key_hint": mask_key(key) if key else None, "base_url_ok": expand(spec.base_url, self.env) is not None,
                "requires_card": spec.requires_card, "requires_phone": spec.requires_phone, "signup_url": spec.signup_url,
                "notes": spec.notes, "budget_note": spec.budget_note, "quota": self.quota.snapshot(spec),
                "breaker": self.breaker.info(spec.id), "last_ok": self.store.section("status").get(spec.id, {}).get("last_ok"),
            })
        counts: dict[str, int] = {}
        for row in rows:
            counts[row["status"]] = counts.get(row["status"], 0) + 1
        configured = sum(1 for r in rows if r["status"] not in ("missing_key", "missing_url", "disabled"))
        return {"enabled": self.enabled, "configured": configured, "total": len(rows), "summary": counts, "providers": rows}

    def quota_report(self) -> dict[str, Any]:
        rows, daily = [], 0
        for spec in self.registry.providers:
            status = provider_status(spec, self.env, self.breaker, self.quota, self.store)
            snapshot = self.quota.snapshot(spec)
            if status in ("untested", "active", "cooldown", "exhausted") and spec.limits.rpd:
                daily += spec.limits.rpd
            rows.append({"id": spec.id, "status": status, **snapshot})
        return {"daily_requests_capacity": daily, "providers": rows}

    async def test(self, provider_id: str, key: Optional[str] = None) -> dict[str, Any]:
        """The Test button. A key passed here is used once, never stored or logged. Never raises."""
        spec = self.registry.get(provider_id)
        if spec is None:
            return {"ok": False, "kind": "request", "detail": "fournisseur inconnu"}
        if expand(spec.base_url, self.env) is None:
            return {"ok": False, "kind": "config", "detail": "base_url non configuree (voir registry.yaml / .env)"}
        from_env = not key
        effective = key.strip() if key else provider_key(spec, self.env)
        if effective is None:
            return {"ok": False, "kind": "config", "detail": f"cle absente : definissez {spec.auth.env} dans .env"}
        adapter = self.adapters[spec.adapter](spec, effective, self.client, self.env, timeout=self.registry.router.timeout_s)
        started = time.perf_counter()
        try:
            async with asyncio.timeout(self.registry.router.timeout_s):
                outcome = await adapter.ping()
        except TimeoutError:
            outcome, error = None, ProviderError("timeout", f"{spec.id} : delai depasse")
        except ProviderError as exc:
            outcome, error = None, exc
        if outcome is not None:
            if from_env:
                self.breaker.sync_key(spec.id, effective)
                self.breaker.record_success(spec.id)
                self.store.section("status")[spec.id] = {"last_ok": self.clock()}
                self.store.save()
            return {**outcome, "latency_ms": round((time.perf_counter() - started) * 1000)}
        message = redact(str(error), (effective,))
        if from_env and error.kind == "auth":
            self.breaker.sync_key(spec.id, effective)
            self.breaker.record_failure(spec.id, message, hard=True, invalid_key=True)
        return {"ok": False, "kind": error.kind, "detail": message}
