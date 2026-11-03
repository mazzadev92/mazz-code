"""Provider adapter interface, normalized result models and shared HTTP error mapping.

Nothing raw leaves this layer: every parsing problem becomes a ProviderError, which the router turns into a fallback.
"""
from __future__ import annotations

import re
import time
from typing import Any, Optional

import httpx
from pydantic import BaseModel, Field

from ..loader import EnvStore, Provider, expand

_DISCOVERY: dict[tuple[str, str], tuple[float, list[str]]] = {}
DISCOVERY_TTL_S = 3600.0


class ProviderError(Exception):
    """kind: auth | rate_limit | quota | upstream | request | parse | timeout | unsupported | config."""

    def __init__(self, kind: str, message: str, status: Optional[int] = None, retry_after: Optional[float] = None):
        super().__init__(message)
        self.kind = kind
        self.status = status
        self.retry_after = retry_after


def mask_key(key: str) -> str:
    """sk-...abcd : first three and last four characters, never the whole secret."""
    if not key:
        return ""
    return f"{key[:3]}...{key[-4:]}" if len(key) >= 12 else "***"


_BEARER = re.compile(r"(?i)\b(bearer|token|key)\s+[A-Za-z0-9._~+/=-]{8,}")
_PREFIXED = re.compile(r"\b(?:sk|gsk|nvapi|hf|csk|xi|key)[-_][A-Za-z0-9_-]{8,}")


def redact(text: str, secrets: tuple[str, ...] = ()) -> str:
    """Masks known secrets and anything shaped like one, for error messages and logs."""
    for secret in secrets:
        if secret and len(secret) >= 6:
            text = text.replace(secret, mask_key(secret))
    text = _BEARER.sub(lambda m: f"{m.group(1)} ***", text)
    return _PREFIXED.sub(lambda m: mask_key(m.group(0)), text)


class Usage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    units: int = 0  # provider-specific measurable unit (characters, credits...)


class ChatRequest(BaseModel):
    messages: list[dict[str, Any]]
    model: Optional[str] = None  # an alias (frontier, fast...) or None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    tools: Optional[list[dict[str, Any]]] = None
    tool_choice: Optional[Any] = None
    stream: bool = False

    def needs_vision(self) -> bool:
        for message in self.messages:
            content = message.get("content")
            if isinstance(content, list) and any(isinstance(p, dict) and p.get("type") in ("image_url", "image") for p in content):
                return True
        return False

    def estimated_tokens(self) -> int:
        chars = sum(len(str(m.get("content", ""))) for m in self.messages)
        return max(1, chars // 3)  # prompt only: the completion is added once the real usage is known


class Result(BaseModel):
    provider: str = ""
    model: str = ""
    latency: float = 0.0
    usage: Usage = Field(default_factory=Usage)


class ChatResponse(Result):
    content: str = ""
    finish_reason: Optional[str] = None
    tool_calls: Optional[list[dict[str, Any]]] = None


class EmbedResult(Result):
    vectors: list[list[float]] = Field(default_factory=list)


class RerankResult(Result):
    ranking: list[dict[str, Any]] = Field(default_factory=list)  # [{index, score}]


class AudioResult(Result):
    audio_b64: str = ""
    mime: str = ""


class TextResult(Result):
    text: str = ""


class ImageResult(Result):
    images: list[str] = Field(default_factory=list)  # URLs or base64 payloads


class SearchResult(Result):
    results: list[dict[str, Any]] = Field(default_factory=list)


def to_openai_json(resp: ChatResponse) -> dict[str, Any]:
    """Normalized response as an OpenAI chat.completion object (what the gateway's translators consume)."""
    message: dict[str, Any] = {"role": "assistant", "content": resp.content}
    if resp.tool_calls:
        message["tool_calls"] = resp.tool_calls
    return {
        "id": f"chatcmpl-{resp.provider}-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": resp.model,
        "choices": [{"index": 0, "message": message, "finish_reason": resp.finish_reason or ("tool_calls" if resp.tool_calls else "stop")}],
        "usage": {"prompt_tokens": resp.usage.prompt_tokens, "completion_tokens": resp.usage.completion_tokens, "total_tokens": resp.usage.total_tokens},
    }


def flatten_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Messages whose content is a list of parts, as plain-text messages (for providers without multimodal parts)."""
    flat = []
    for message in messages:
        content = message.get("content")
        if isinstance(content, list):
            content = "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
        flat.append({"role": message.get("role", "user"), "content": content or ""})
    return flat


def retry_after_seconds(headers: httpx.Headers) -> Optional[float]:
    raw = headers.get("retry-after")
    try:
        return float(raw) if raw else None
    except ValueError:
        return None


class ProviderAdapter:
    """One provider: `spec` from the registry, `key` already resolved ("" = anonymous), a shared httpx client."""

    name = "base"
    implements: frozenset[str] = frozenset()

    def __init__(self, spec: Provider, key: str, client: httpx.AsyncClient, env: EnvStore, timeout: float = 30.0):
        self.spec, self.key, self.client, self.env, self.timeout = spec, key, client, env, timeout

    # ------------------------------------------------------------------ configuration
    @property
    def base_url(self) -> str:
        url = expand(self.spec.base_url, self.env)
        if not url:
            raise ProviderError("config", f"{self.spec.id} : base_url non configuree")
        return url.rstrip("/")

    def supports(self, capability: str) -> bool:
        return capability in self.spec.capabilities and capability in self.implements

    def _headers(self, extra: Optional[dict[str, str]] = None) -> dict[str, str]:
        auth, headers = self.spec.auth, dict(self.spec.auth.headers)
        if self.key:
            if auth.type == "bearer":
                headers["Authorization"] = f"Bearer {self.key}"
            elif auth.type == "header" and auth.header:
                headers[auth.header] = f"{auth.scheme} {self.key}" if auth.scheme else self.key
        headers.update(extra or {})
        return headers

    def model_for(self, hint: Optional[str], default_alias: str) -> Optional[str]:
        for alias in (hint, default_alias):
            if alias and (found := self.spec.model_id(alias)):
                return found
        return self.spec.models[0].id if self.spec.models else None

    async def resolve_model(self, hint: Optional[str], default_alias: str) -> str:
        found = self.model_for(hint, default_alias)
        if found:
            return found
        ids = await self.discover_models()
        pattern = re.compile(self.spec.model_pattern or ".*")
        match = next((i for i in ids if pattern.search(i)), None)
        if not match:
            raise ProviderError("config", f"{self.spec.id} : aucun modele (renseignez models: dans registry.yaml)")
        return match

    async def discover_models(self) -> list[str]:
        raise ProviderError("unsupported", f"{self.spec.id} : liste de modeles indisponible")

    async def _cached_models(self, fetch) -> list[str]:
        cache_key = (self.spec.id, self.base_url)
        hit = _DISCOVERY.get(cache_key)
        if hit and time.time() - hit[0] < DISCOVERY_TTL_S:
            return hit[1]
        ids = await fetch()
        _DISCOVERY[cache_key] = (time.time(), ids)
        return ids

    # ------------------------------------------------------------------ HTTP
    async def _http(self, method: str, url: str, *, stream: bool = False, headers: Optional[dict[str, str]] = None, **kwargs: Any) -> httpx.Response:
        """One request with the registry timeout; HTTP and network failures become ProviderError (keys redacted)."""
        try:
            request = self.client.build_request(method, url, headers=self._headers(headers), timeout=self.timeout, **kwargs)
            response = await self.client.send(request, stream=stream)
        except httpx.TimeoutException as exc:
            raise ProviderError("timeout", f"{self.spec.id} : delai depasse ({type(exc).__name__})") from None
        except httpx.HTTPError as exc:
            raise ProviderError("upstream", redact(f"{self.spec.id} : {type(exc).__name__} {exc}", (self.key,))) from None
        if response.status_code >= 400:
            body = (await response.aread()).decode("utf-8", "replace")[:300]
            await response.aclose()
            raise self._status_error(response.status_code, body, response.headers)
        return response

    def _status_error(self, status: int, body: str, headers: httpx.Headers) -> ProviderError:
        message = redact(f"{self.spec.id} : HTTP {status} {body}", (self.key,))
        if status in (401, 403):
            return ProviderError("auth", message, status)
        if status == 402:
            return ProviderError("quota", message, status)
        if status == 429:
            return ProviderError("rate_limit", message, status, retry_after_seconds(headers))
        if status == 408 or status >= 500:
            return ProviderError("upstream", message, status)
        return ProviderError("request", message, status)

    def _json(self, response: httpx.Response) -> Any:
        try:
            return response.json()
        except ValueError:
            raise ProviderError("parse", f"{self.spec.id} : reponse non JSON") from None

    # ------------------------------------------------------------------ capabilities (override what is implemented)
    async def chat(self, req: ChatRequest) -> ChatResponse:
        raise ProviderError("unsupported", f"{self.spec.id} : chat non supporte")

    async def embed(self, texts: list[str], model: Optional[str] = None) -> EmbedResult:
        raise ProviderError("unsupported", f"{self.spec.id} : embedding non supporte")

    async def rerank(self, query: str, documents: list[str], model: Optional[str] = None, top_n: Optional[int] = None) -> RerankResult:
        raise ProviderError("unsupported", f"{self.spec.id} : rerank non supporte")

    async def tts(self, text: str, voice: Optional[str] = None, model: Optional[str] = None) -> AudioResult:
        raise ProviderError("unsupported", f"{self.spec.id} : tts non supporte")

    async def stt(self, audio: Optional[bytes] = None, url: Optional[str] = None, mime: str = "audio/wav", model: Optional[str] = None) -> TextResult:
        raise ProviderError("unsupported", f"{self.spec.id} : stt non supporte")

    async def image(self, prompt: str, model: Optional[str] = None) -> ImageResult:
        raise ProviderError("unsupported", f"{self.spec.id} : image non supportee")

    async def search(self, query: str, limit: int = 5) -> SearchResult:
        raise ProviderError("unsupported", f"{self.spec.id} : search non supporte")

    async def scrape(self, url: str) -> SearchResult:
        raise ProviderError("unsupported", f"{self.spec.id} : scrape non supporte")

    async def ping(self) -> dict[str, Any]:
        """Smallest real call that proves the key works. Returns {ok, detail, models}."""
        raise ProviderError("unsupported", f"{self.spec.id} : test indisponible")
