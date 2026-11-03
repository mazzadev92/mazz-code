"""Jina AI: /embeddings and /rerank."""
from __future__ import annotations

import time
from typing import Any, Optional

from .base import EmbedResult, ProviderAdapter, ProviderError, RerankResult, Usage


class JinaAdapter(ProviderAdapter):
    name = "jina"
    implements = frozenset({"embedding", "rerank"})

    async def embed(self, texts: list[str], model: Optional[str] = None) -> EmbedResult:
        model_id = await self.resolve_model(model, "embed")
        started = time.perf_counter()
        data = self._json(await self._http("POST", f"{self.base_url}/embeddings", json={"model": model_id, "input": texts}))
        try:
            vectors = [d["embedding"] for d in sorted(data["data"], key=lambda d: d.get("index", 0))]
        except (KeyError, TypeError):
            raise ProviderError("parse", f"{self.spec.id} : forme d'embedding inattendue") from None
        total = int((data.get("usage") or {}).get("total_tokens", 0))
        return EmbedResult(provider=self.spec.id, model=model_id, latency=time.perf_counter() - started, vectors=vectors,
                           usage=Usage(prompt_tokens=total, total_tokens=total))

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
        reply = await self.embed(["ping"])
        return {"ok": True, "detail": f"embedding OK ({len(reply.vectors[0])} dimensions)", "models": []}
