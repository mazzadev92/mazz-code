"""Small synchronous adapters: Cartesia (tts), fal (image), Exa (search), Firecrawl (scrape + search)."""
from __future__ import annotations

import base64
import time
from typing import Any, Optional

from .base import AudioResult, ImageResult, ProviderAdapter, ProviderError, SearchResult, Usage


class CartesiaAdapter(ProviderAdapter):
    name = "cartesia"
    implements = frozenset({"tts"})

    async def tts(self, text: str, voice: Optional[str] = None, model: Optional[str] = None) -> AudioResult:
        voice_id = voice or self.env.get("CARTESIA_VOICE_ID")
        if not voice_id:
            raise ProviderError("config", "cartesia : definissez CARTESIA_VOICE_ID ou passez `voice`")
        model_id = await self.resolve_model(model, "tts")
        started = time.perf_counter()
        response = await self._http("POST", f"{self.base_url}/tts/bytes", json={
            "model_id": model_id, "transcript": text, "voice": {"mode": "id", "id": voice_id},
            "output_format": {"container": "mp3", "sample_rate": 44100, "bit_rate": 128000}})
        if not response.content:
            raise ProviderError("parse", "cartesia : audio vide")
        return AudioResult(provider=self.spec.id, model=model_id, latency=time.perf_counter() - started, mime="audio/mpeg",
                           audio_b64=base64.b64encode(response.content).decode("ascii"), usage=Usage(units=len(text)))

    async def ping(self) -> dict[str, Any]:
        reply = await self.tts("ok")
        return {"ok": True, "detail": f"tts OK ({reply.latency * 1000:.0f} ms)", "models": []}


class FalAdapter(ProviderAdapter):
    name = "fal"
    implements = frozenset({"image"})

    async def image(self, prompt: str, model: Optional[str] = None) -> ImageResult:
        model_id = await self.resolve_model(model, "image")
        started = time.perf_counter()
        data = self._json(await self._http("POST", f"{self.base_url}/{model_id}", json={"prompt": prompt}))
        try:
            images = [i["url"] for i in data["images"]]
        except (KeyError, TypeError):
            raise ProviderError("parse", "fal : champ images absent") from None
        return ImageResult(provider=self.spec.id, model=model_id, latency=time.perf_counter() - started, images=images)

    async def ping(self) -> dict[str, Any]:
        reply = await self.image("ping")
        return {"ok": True, "detail": f"image OK ({len(reply.images)} image, {reply.latency * 1000:.0f} ms)", "models": []}


class ExaAdapter(ProviderAdapter):
    name = "exa"
    implements = frozenset({"search"})

    async def search(self, query: str, limit: int = 5) -> SearchResult:
        started = time.perf_counter()
        data = self._json(await self._http("POST", f"{self.base_url}/search", json={"query": query, "numResults": limit}))
        try:
            hits = [{"title": r.get("title", ""), "url": r["url"], "snippet": (r.get("text") or r.get("summary") or "")[:500]} for r in data["results"]]
        except (KeyError, TypeError):
            raise ProviderError("parse", "exa : forme de resultats inattendue") from None
        return SearchResult(provider=self.spec.id, model="search", latency=time.perf_counter() - started, results=hits)

    async def ping(self) -> dict[str, Any]:
        reply = await self.search("ping", 1)
        return {"ok": True, "detail": f"recherche OK ({len(reply.results)} resultat)", "models": []}


class FirecrawlAdapter(ProviderAdapter):
    name = "firecrawl"
    implements = frozenset({"scrape", "search"})

    async def scrape(self, url: str) -> SearchResult:
        started = time.perf_counter()
        data = self._json(await self._http("POST", f"{self.base_url}/scrape", json={"url": url, "formats": ["markdown"]}))
        try:
            page = data["data"]
            hits = [{"title": (page.get("metadata") or {}).get("title", ""), "url": url, "snippet": page["markdown"]}]
        except (KeyError, TypeError, AttributeError):
            raise ProviderError("parse", "firecrawl : markdown absent") from None
        return SearchResult(provider=self.spec.id, model="scrape", latency=time.perf_counter() - started, results=hits)

    async def search(self, query: str, limit: int = 5) -> SearchResult:
        started = time.perf_counter()
        data = self._json(await self._http("POST", f"{self.base_url}/search", json={"query": query, "limit": limit}))
        try:
            hits = [{"title": r.get("title", ""), "url": r["url"], "snippet": r.get("description", "")} for r in data["data"]]
        except (KeyError, TypeError):
            raise ProviderError("parse", "firecrawl : forme de resultats inattendue") from None
        return SearchResult(provider=self.spec.id, model="search", latency=time.perf_counter() - started, results=hits)

    async def ping(self) -> dict[str, Any]:
        reply = await self.search("ping", 1)
        return {"ok": True, "detail": f"recherche OK ({len(reply.results)} resultat)", "models": []}
