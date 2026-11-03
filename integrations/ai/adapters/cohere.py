"""Cohere v2 native shape: /chat, /embed, /rerank."""
from __future__ import annotations

import time
from typing import Any, Optional

from .base import (ChatRequest, ChatResponse, EmbedResult, ProviderAdapter, ProviderError, RerankResult, Usage)

_FINISH = {"COMPLETE": "stop", "MAX_TOKENS": "length", "TOOL_CALL": "tool_calls", "STOP_SEQUENCE": "stop"}


class CohereAdapter(ProviderAdapter):
    name = "cohere"
    implements = frozenset({"chat", "embedding", "rerank"})

    async def chat(self, req: ChatRequest) -> ChatResponse:
        model_id = await self.resolve_model(req.model, "frontier")
        started = time.perf_counter()
        payload: dict[str, Any] = {"model": model_id, "messages": req.messages, "stream": False}
        for src, dst in (("max_tokens", "max_tokens"), ("temperature", "temperature"), ("tools", "tools")):
            value = getattr(req, src)
            if value is not None:
                payload[dst] = value
        data = self._json(await self._http("POST", f"{self.base_url}/chat", json=payload))
        try:
            message = data["message"]
            parts = message.get("content") or []
            text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("type") == "text")
            tokens = (data.get("usage") or {}).get("tokens") or {}
            prompt, completion = int(tokens.get("input_tokens", 0)), int(tokens.get("output_tokens", 0))
            return ChatResponse(provider=self.spec.id, model=model_id, latency=time.perf_counter() - started, content=text,
                                tool_calls=message.get("tool_calls") or None, finish_reason=_FINISH.get(data.get("finish_reason", ""), "stop"),
                                usage=Usage(prompt_tokens=prompt, completion_tokens=completion, total_tokens=prompt + completion))
        except (KeyError, TypeError, AttributeError, ValueError):
            raise ProviderError("parse", f"{self.spec.id} : forme de reponse inattendue") from None

    async def embed(self, texts: list[str], model: Optional[str] = None) -> EmbedResult:
        model_id = await self.resolve_model(model, "embed")
        started = time.perf_counter()
        data = self._json(await self._http("POST", f"{self.base_url}/embed", json={
            "model": model_id, "texts": texts, "input_type": "search_document", "embedding_types": ["float"]}))
        try:
            vectors = data["embeddings"]["float"]
        except (KeyError, TypeError):
            raise ProviderError("parse", f"{self.spec.id} : forme d'embedding inattendue") from None
        return EmbedResult(provider=self.spec.id, model=model_id, latency=time.perf_counter() - started, vectors=vectors)

    async def rerank(self, query: str, documents: list[str], model: Optional[str] = None, top_n: Optional[int] = None) -> RerankResult:
        model_id = await self.resolve_model(model, "rerank")
        started = time.perf_counter()
        payload: dict[str, Any] = {"model": model_id, "query": query, "documents": documents}
        if top_n:
            payload["top_n"] = top_n
        data = self._json(await self._http("POST", f"{self.base_url}/rerank", json=payload))
        try:
            ranking = [{"index": r["index"], "score": r["relevance_score"]} for r in data["results"]]
        except (KeyError, TypeError):
            raise ProviderError("parse", f"{self.spec.id} : forme de rerank inattendue") from None
        return RerankResult(provider=self.spec.id, model=model_id, latency=time.perf_counter() - started, ranking=ranking)

    async def ping(self) -> dict[str, Any]:
        reply = await self.chat(ChatRequest(messages=[{"role": "user", "content": "ping"}], max_tokens=1))
        return {"ok": True, "detail": f"chat OK ({reply.model}, {reply.latency * 1000:.0f} ms)", "models": []}
