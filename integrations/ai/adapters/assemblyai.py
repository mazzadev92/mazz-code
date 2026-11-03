"""AssemblyAI: upload (bytes) or URL, submit, then poll. The router's timeout bounds the whole sequence."""
from __future__ import annotations

import asyncio
import time
from typing import Any, Optional

from .base import ProviderAdapter, ProviderError, TextResult


class AssemblyAIAdapter(ProviderAdapter):
    name = "assemblyai"
    implements = frozenset({"stt"})
    poll_interval = 1.5

    async def stt(self, audio: Optional[bytes] = None, url: Optional[str] = None, mime: str = "audio/wav", model: Optional[str] = None) -> TextResult:
        if audio is None and not url:
            raise ProviderError("request", "assemblyai : fournissez `audio` ou `url`")
        started = time.perf_counter()
        if audio is not None:
            uploaded = self._json(await self._http("POST", f"{self.base_url}/upload", content=audio))
            url = uploaded.get("upload_url") if isinstance(uploaded, dict) else None
            if not url:
                raise ProviderError("parse", "assemblyai : upload_url absent")
        job = self._json(await self._http("POST", f"{self.base_url}/transcript", json={"audio_url": url}))
        job_id = job.get("id") if isinstance(job, dict) else None
        if not job_id:
            raise ProviderError("parse", "assemblyai : identifiant de transcription absent")
        while True:
            state = self._json(await self._http("GET", f"{self.base_url}/transcript/{job_id}"))
            status = state.get("status") if isinstance(state, dict) else None
            if status == "completed":
                return TextResult(provider=self.spec.id, model="default", latency=time.perf_counter() - started, text=state.get("text") or "")
            if status == "error":
                raise ProviderError("upstream", f"assemblyai : {str(state.get('error'))[:200]}")
            await asyncio.sleep(self.poll_interval)

    async def ping(self) -> dict[str, Any]:
        await self._http("GET", f"{self.base_url}/transcript", params={"limit": 1})
        return {"ok": True, "detail": "cle valide (liste des transcriptions)", "models": []}
