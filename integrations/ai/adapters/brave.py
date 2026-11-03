"""Brave Search: GET <base_url> (already the web search endpoint) with X-Subscription-Token."""
from __future__ import annotations

import time
from typing import Any

from .base import ProviderAdapter, ProviderError, SearchResult


class BraveAdapter(ProviderAdapter):
    name = "brave"
    implements = frozenset({"search"})

    async def search(self, query: str, limit: int = 5) -> SearchResult:
        started = time.perf_counter()
        data = self._json(await self._http("GET", self.base_url, params={"q": query, "count": limit}, headers={"Accept": "application/json"}))
        try:
            hits = [{"title": r.get("title", ""), "url": r["url"], "snippet": r.get("description", "")} for r in (data.get("web") or {}).get("results", [])]
        except (KeyError, TypeError, AttributeError):
            raise ProviderError("parse", "brave : forme de resultats inattendue") from None
        return SearchResult(provider=self.spec.id, model="search", latency=time.perf_counter() - started, results=hits)

    async def ping(self) -> dict[str, Any]:
        reply = await self.search("ping", 1)
        return {"ok": True, "detail": f"recherche OK ({len(reply.results)} resultat)", "models": []}
