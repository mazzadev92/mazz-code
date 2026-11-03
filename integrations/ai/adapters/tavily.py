"""Tavily search: the API key travels in the JSON body (registry: auth.type body)."""
from __future__ import annotations

import time
from typing import Any

from .base import ProviderAdapter, ProviderError, SearchResult


class TavilyAdapter(ProviderAdapter):
    name = "tavily"
    implements = frozenset({"search"})

    async def search(self, query: str, limit: int = 5) -> SearchResult:
        started = time.perf_counter()
        body = {self.spec.auth.field or "api_key": self.key, "query": query, "max_results": limit}
        data = self._json(await self._http("POST", f"{self.base_url}/search", json=body))
        try:
            hits = [{"title": r.get("title", ""), "url": r["url"], "snippet": r.get("content", ""), "score": r.get("score")} for r in data["results"]]
        except (KeyError, TypeError):
            raise ProviderError("parse", "tavily : forme de resultats inattendue") from None
        return SearchResult(provider=self.spec.id, model="search", latency=time.perf_counter() - started, results=hits)

    async def ping(self) -> dict[str, Any]:
        reply = await self.search("ping", 1)
        return {"ok": True, "detail": f"recherche OK ({len(reply.results)} resultat)", "models": []}
