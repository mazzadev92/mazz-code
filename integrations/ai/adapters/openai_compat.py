"""Generic OpenAI-compatible adapter: /chat/completions, /embeddings, /images/generations, /models."""
from __future__ import annotations

import time
from typing import Any, Optional

import httpx

from .base import (ChatRequest, ChatResponse, EmbedResult, ImageResult, ProviderAdapter, ProviderError, Usage)


class OpenAICompatAdapter(ProviderAdapter):
    name = "openai_compat"
    implements = frozenset({"chat", "vision", "embedding", "image"})

    def _chat_payload(self, req: ChatRequest, model_id: str, stream: bool) -> dict[str, Any]:
        payload: dict[str, Any] = {"model": model_id, "messages": req.messages, "stream": stream}
        for field in ("temperature", "max_tokens", "tools", "tool_choice"):
            value = getattr(req, field)
            if value is not None:
                payload[field] = value
        return payload

    async def chat(self, req: ChatRequest) -> ChatResponse:
        model_id = await self.resolve_model(req.model, "frontier")
        started = time.perf_counter()
        response = await self._http("POST", f"{self.base_url}/chat/completions", json=self._chat_payload(req, model_id, False))
        data = self._json(response)
        try:
            choice = data["choices"][0]
            message = choice["message"]
            usage = data.get("usage") or {}
            return ChatResponse(
                provider=self.spec.id, model=data.get("model") or model_id, latency=time.perf_counter() - started,
                content=message.get("content") or "", finish_reason=choice.get("finish_reason"),
                tool_calls=message.get("tool_calls") or None,
                usage=Usage(prompt_tokens=usage.get("prompt_tokens", 0), completion_tokens=usage.get("completion_tokens", 0),
                            total_tokens=usage.get("total_tokens", 0)),
            )
        except (KeyError, IndexError, TypeError, AttributeError):
            raise ProviderError("parse", f"{self.spec.id} : forme de reponse inattendue") from None

    async def open_chat(self, req: ChatRequest) -> httpx.Response:
        """The upstream response as is (streamed when req.stream): the gateway reuses its own translators on it."""
        model_id = await self.resolve_model(req.model, "frontier")
        return await self._http("POST", f"{self.base_url}/chat/completions", stream=req.stream,
                                json=self._chat_payload(req, model_id, req.stream))

    async def embed(self, texts: list[str], model: Optional[str] = None) -> EmbedResult:
        model_id = await self.resolve_model(model, "embed")
        started = time.perf_counter()
        data = self._json(await self._http("POST", f"{self.base_url}/embeddings", json={"model": model_id, "input": texts}))
        try:
            vectors = [item["embedding"] for item in sorted(data["data"], key=lambda i: i.get("index", 0))]
        except (KeyError, TypeError):
            raise ProviderError("parse", f"{self.spec.id} : forme d'embedding inattendue") from None
        usage = data.get("usage") or {}
        return EmbedResult(provider=self.spec.id, model=model_id, latency=time.perf_counter() - started, vectors=vectors,
                           usage=Usage(prompt_tokens=usage.get("prompt_tokens", 0), total_tokens=usage.get("total_tokens", 0)))

    async def image(self, prompt: str, model: Optional[str] = None) -> ImageResult:
        model_id = await self.resolve_model(model, "image")
        started = time.perf_counter()
        data = self._json(await self._http("POST", f"{self.base_url}/images/generations", json={"model": model_id, "prompt": prompt, "n": 1}))
        try:
            images = [item.get("url") or item["b64_json"] for item in data["data"]]
        except (KeyError, TypeError):
            raise ProviderError("parse", f"{self.spec.id} : forme d'image inattendue") from None
        return ImageResult(provider=self.spec.id, model=model_id, latency=time.perf_counter() - started, images=images)

    async def discover_models(self) -> list[str]:
        async def fetch() -> list[str]:
            data = self._json(await self._http("GET", f"{self.base_url}/models"))
            try:
                return [m["id"] for m in data["data"]]
            except (KeyError, TypeError):
                raise ProviderError("parse", f"{self.spec.id} : liste /models inattendue") from None

        return await self._cached_models(fetch)

    async def ping(self) -> dict[str, Any]:
        models: list[str] = []
        try:
            models = (await self.discover_models())[:30]
        except ProviderError as exc:
            if exc.kind == "auth":
                raise
        if self.supports("chat"):
            reply = await self.chat(ChatRequest(messages=[{"role": "user", "content": "ping"}], max_tokens=1))
            return {"ok": True, "detail": f"chat OK ({reply.model}, {reply.latency * 1000:.0f} ms)", "models": models}
        return {"ok": True, "detail": f"{len(models)} modeles listes", "models": models}
