"""Adapter classes by the name used in registry.yaml (`adapter:`)."""
from __future__ import annotations

from typing import Any

from .assemblyai import AssemblyAIAdapter
from .base import ProviderAdapter, ProviderError
from .brave import BraveAdapter
from .cloudflare import CloudflareAdapter
from .cohere import CohereAdapter
from .deepgram import DeepgramAdapter
from .elevenlabs import ElevenLabsAdapter
from .extra import CartesiaAdapter, ExaAdapter, FalAdapter, FirecrawlAdapter
from .jina import JinaAdapter
from .openai_compat import OpenAICompatAdapter
from .stability import StabilityAdapter
from .tavily import TavilyAdapter
from .voyage import VoyageAdapter


class RegistryOnlyAdapter(ProviderAdapter):
    """Providers whose API is asynchronous by task (speechmatics, gladia, meshy, tripo): the key is stored and its
    status shown, but nothing is routed to them (supports() is always False)."""

    name = "registry_only"
    implements = frozenset()

    async def ping(self) -> dict[str, Any]:
        raise ProviderError("unsupported", f"{self.spec.id} : API par taches, cle enregistree mais non routee")


ADAPTERS: dict[str, type[ProviderAdapter]] = {
    cls.name: cls
    for cls in (OpenAICompatAdapter, CloudflareAdapter, CohereAdapter, VoyageAdapter, JinaAdapter, ElevenLabsAdapter, CartesiaAdapter,
                DeepgramAdapter, AssemblyAIAdapter, StabilityAdapter, FalAdapter, TavilyAdapter, ExaAdapter, BraveAdapter,
                FirecrawlAdapter, RegistryOnlyAdapter)
}

__all__ = ["ADAPTERS", "ProviderAdapter", "ProviderError", "RegistryOnlyAdapter"]
