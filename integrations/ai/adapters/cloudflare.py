"""Cloudflare Workers AI native shape: POST <base>/<model> -> {"result": {...}, "success": bool}."""
from __future__ import annotations

import time
from typing import Any, Optional

from .base import (ChatRequest, ChatResponse, EmbedResult, ProviderAdapter, ProviderError, Usage, flatten_messages)


class CloudflareAdapter(ProviderAdapter):
    name = "cloudflare"
    implements = frozenset({"chat", "embedding"})

    async def _run(self, model_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        data = self._json(await self._http("POST", f"{self.base_url}/{model_id}", json=payload))
        if not isinstance(data, dict) or not data.get("success", False) or "result" not in data:
            errors = data.get("errors") if isinstance(data, dict) else None
            raise ProviderError("upstream", f"{self.spec.id} : echec Workers AI {str(errors)[:200]}")
        return data["result"]

    async def chat(self, req: ChatRequest) -> ChatResponse:
        model_id = await self.resolve_model(req.model, "frontier")
        started = time.perf_counter()
        payload: dict[str, Any] = {"messages": flatten_messages(req.messages)}
        if req.max_tokens:
            payload["max_tokens"] = req.max_tokens
        if req.temperature is not None:
            payload["temperature"] = req.temperature
        result = await self._run(model_id, payload)
        text = result.get("response") if isinstance(result, dict) else None
        if not isinstance(text, str):
            raise ProviderError("parse", f"{self.spec.id} : champ result.response absent")
        usage = result.get("usage") or {}
        return ChatResponse(provider=self.spec.id, model=model_id, latency=time.perf_counter() - started, content=text, finish_reason="stop",
                            usage=Usage(prompt_tokens=usage.get("prompt_tokens", 0), completion_tokens=usage.get("completion_tokens", 0),
                                        total_tokens=usage.get("total_tokens", 0)))

    async def embed(self, texts: list[str], model: Optional[str] = None) -> EmbedResult:
        model_id = await self.resolve_model(model, "embed")
        started = time.perf_counter()
        result = await self._run(model_id, {"text": texts})
        try:
            vectors = result["data"]
        except (KeyError, TypeError):
            raise ProviderError("parse", f"{self.spec.id} : champ result.data absent") from None
        return EmbedResult(provider=self.spec.id, model=model_id, latency=time.perf_counter() - started, vectors=vectors)

    async def ping(self) -> dict[str, Any]:
        reply = await self.chat(ChatRequest(messages=[{"role": "user", "content": "ping"}], max_tokens=1))
        return {"ok": True, "detail": f"chat OK ({reply.model}, {reply.latency * 1000:.0f} ms)", "models": []}
