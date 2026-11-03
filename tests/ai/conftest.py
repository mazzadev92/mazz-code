"""Shared helpers for the AI layer tests: fake env, mock HTTP client, adapter and router factories."""
import asyncio
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from integrations.ai.adapters import ADAPTERS  # noqa: E402
from integrations.ai.loader import load_registry  # noqa: E402
from integrations.ai.router import Router  # noqa: E402
from integrations.ai.router.store import StateStore  # noqa: E402


class FakeEnv:
    """Same interface as EnvStore.get, without reading the real environment or any .env file."""

    def __init__(self, **values):
        self.values = values

    def get(self, name):
        value = self.values.get(name)
        return value.strip() if value and value.strip() else None


class Clock:
    def __init__(self, now=1_800_000_000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def run(coro):
    return asyncio.run(coro)


@pytest.fixture()
def registry():
    return load_registry(known_adapters=set(ADAPTERS))


def make_client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def make_adapter(registry, provider_id, handler, key="secret-key-1234567890", **env):
    spec = registry.get(provider_id)
    return ADAPTERS[spec.adapter](spec, key, make_client(handler), FakeEnv(**env), timeout=5.0)


def make_router(registry, handler, clock=None, **env):
    return Router(registry, FakeEnv(**env), StateStore(None), make_client(handler), clock or Clock())


def ok_chat(text="bonjour"):
    return {"choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}], "model": "m",
            "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}}
