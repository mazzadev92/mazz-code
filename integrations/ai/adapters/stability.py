"""Stability AI v2beta: multipart request, JSON answer holding a base64 image."""
from __future__ import annotations

import time
from typing import Any, Optional

from .base import ImageResult, ProviderAdapter, ProviderError


class StabilityAdapter(ProviderAdapter):
    name = "stability"
    implements = frozenset({"image"})

    async def image(self, prompt: str, model: Optional[str] = None) -> ImageResult:
        endpoint = await self.resolve_model(model, "image")  # an endpoint path such as stable-image/generate/core
        started = time.perf_counter()
        response = await self._http("POST", f"{self.base_url}/{endpoint}", headers={"Accept": "application/json"},
                                    files={"none": ("", "")}, data={"prompt": prompt, "output_format": "png"})
        data = self._json(response)
        encoded = data.get("image") if isinstance(data, dict) else None
        if not encoded:
            raise ProviderError("parse", "stability : champ image absent")
        return ImageResult(provider=self.spec.id, model=endpoint, latency=time.perf_counter() - started, images=[encoded])

    async def ping(self) -> dict[str, Any]:
        # Balance endpoint (v1) proves the key without spending credits.
        data = self._json(await self._http("GET", self.base_url.replace("/v2beta", "/v1") + "/user/balance"))
        return {"ok": True, "detail": f"cle valide (credits : {data.get('credits', 'N/D') if isinstance(data, dict) else 'N/D'})", "models": []}
