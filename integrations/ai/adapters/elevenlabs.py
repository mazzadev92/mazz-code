"""ElevenLabs text-to-speech. Voice: argument, else ELEVENLABS_VOICE_ID."""
from __future__ import annotations

import base64
import time
from typing import Any, Optional

from .base import AudioResult, ProviderAdapter, ProviderError, Usage


class ElevenLabsAdapter(ProviderAdapter):
    name = "elevenlabs"
    implements = frozenset({"tts"})

    async def tts(self, text: str, voice: Optional[str] = None, model: Optional[str] = None) -> AudioResult:
        voice_id = voice or self.env.get("ELEVENLABS_VOICE_ID")
        if not voice_id:
            raise ProviderError("config", "elevenlabs : definissez ELEVENLABS_VOICE_ID ou passez `voice`")
        model_id = await self.resolve_model(model, "tts")
        started = time.perf_counter()
        response = await self._http("POST", f"{self.base_url}/text-to-speech/{voice_id}", params={"output_format": "mp3_44100_128"},
                                    json={"text": text, "model_id": model_id}, headers={"Accept": "audio/mpeg"})
        if not response.content:
            raise ProviderError("parse", "elevenlabs : audio vide")
        return AudioResult(provider=self.spec.id, model=model_id, latency=time.perf_counter() - started, mime="audio/mpeg",
                           audio_b64=base64.b64encode(response.content).decode("ascii"), usage=Usage(units=len(text)))

    async def ping(self) -> dict[str, Any]:
        reply = await self.tts("ok")
        return {"ok": True, "detail": f"tts OK ({len(reply.audio_b64) * 3 // 4} octets, {reply.latency * 1000:.0f} ms)", "models": []}
