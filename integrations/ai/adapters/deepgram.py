"""Deepgram pre-recorded transcription (POST <base>?model=...)."""
from __future__ import annotations

import time
from typing import Any, Optional

from .base import ProviderAdapter, ProviderError, TextResult


class DeepgramAdapter(ProviderAdapter):
    name = "deepgram"
    implements = frozenset({"stt"})

    async def stt(self, audio: Optional[bytes] = None, url: Optional[str] = None, mime: str = "audio/wav", model: Optional[str] = None) -> TextResult:
        if audio is None and not url:
            raise ProviderError("request", "deepgram : fournissez `audio` ou `url`")
        model_id = await self.resolve_model(model, "stt")
        started = time.perf_counter()
        kwargs: dict[str, Any] = {"json": {"url": url}} if url else {"content": audio, "headers": {"Content-Type": mime}}
        data = self._json(await self._http("POST", self.base_url, params={"model": model_id, "smart_format": "true"}, **kwargs))
        try:
            text = data["results"]["channels"][0]["alternatives"][0]["transcript"]
        except (KeyError, IndexError, TypeError):
            raise ProviderError("parse", "deepgram : transcription absente de la reponse") from None
        return TextResult(provider=self.spec.id, model=model_id, latency=time.perf_counter() - started, text=text)

    async def ping(self) -> dict[str, Any]:
        # The key listing endpoint lives next to /listen: it proves the key without spending credit.
        await self._http("GET", self.base_url.rsplit("/listen", 1)[0] + "/projects")
        return {"ok": True, "detail": "cle valide (liste des projets)", "models": []}
