import asyncio
import json

import httpx
import pytest

from conftest import Clock, make_client, make_router, ok_chat, run
from integrations.ai.adapters.base import ChatRequest
from integrations.ai.router import AllProvidersFailed, NoProviderAvailable
from integrations.ai.router.router import Router
from integrations.ai.router.store import StateStore

NIM, GROQ, ORACLE, DEEPINFRA = "integrate.api.nvidia.com", "api.groq.com", "oracle-vm", "api.deepinfra.com"
REQ = ChatRequest(messages=[{"role": "user", "content": "salut"}])


class Upstream:
    """Fake providers by host: behavior is "ok", an HTTP status, or a callable(request) -> response."""

    def __init__(self, **behaviors):
        self.hosts, self.behaviors, self.requests = [], behaviors, []

    def __call__(self, request):
        host = request.url.host
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "model-x"}]})
        self.hosts.append(host)
        self.requests.append(request)
        behavior = self.behaviors.get(host, "ok")
        if behavior == "ok":
            return httpx.Response(200, json=ok_chat(host))
        if callable(behavior):
            return behavior(request)
        return httpx.Response(behavior, json={"error": {"message": f"HTTP {behavior}"}}, headers={"retry-after": "30"} if behavior == 429 else {})


def chat_host(router):
    reply = run(router.chat(REQ))
    return reply.content


def test_router_zero_keys_returns_503_listing_the_missing_variables_without_any_network_call(registry):
    # Arrange
    upstream = Upstream()
    router = make_router(registry, upstream)
    # Act
    with pytest.raises(NoProviderAvailable) as raised:
        run(router.chat(REQ))
    status = router.status()
    # Assert
    assert raised.value.status == 503 and "NIM_KEY" in str(raised.value) and upstream.hosts == []
    assert set(status["summary"]) <= {"missing_key", "missing_url"} and status["configured"] == 0 and status["enabled"] is False


def test_router_lowest_priority_number_among_free_providers_is_tried_first(registry):
    # Arrange
    upstream = Upstream()
    router = make_router(registry, upstream, GROQ_KEY="gsk-aaaaaaaaaaaa", NIM_KEY="nvapi-bbbbbbbbbbbb")
    # Act
    served_by = chat_host(router)
    # Assert
    assert served_by == NIM and upstream.hosts == [NIM]


def test_router_selfhost_is_tried_before_free_and_credit_providers(registry):
    # Arrange
    upstream = Upstream()
    router = make_router(registry, upstream, LOCAL_ORACLE_KEY="anonymous", NIM_KEY="nvapi-bbbbbbbbbbbb", DEEPINFRA_KEY="di-cccccccccccc")
    # Act
    served_by = chat_host(router)
    # Assert
    assert served_by == ORACLE and upstream.requests[0].headers.get("authorization") is None


def test_router_credit_providers_come_after_free_ones_whatever_their_priority(registry):
    # Arrange
    upstream = Upstream()
    router = make_router(registry, upstream, DEEPINFRA_KEY="di-cccccccccccc", GROQ_KEY="gsk-aaaaaaaaaaaa")
    # Act
    served_by = chat_host(router)
    # Assert
    assert served_by == GROQ


def test_router_filters_by_capability_before_selecting(registry):
    # Arrange: groq has no embedding capability
    router = make_router(registry, Upstream(), GROQ_KEY="gsk-aaaaaaaaaaaa")
    # Act / Assert
    with pytest.raises(NoProviderAvailable) as raised:
        run(router.execute("embedding", {"texts": ["a"]}))
    assert raised.value.status == 503 and raised.value.capability == "embedding"


def test_router_a_failing_provider_falls_back_to_the_next_without_error(registry):
    # Arrange
    upstream = Upstream(**{NIM: 500})
    router = make_router(registry, upstream, GROQ_KEY="gsk-aaaaaaaaaaaa", NIM_KEY="nvapi-bbbbbbbbbbbb")
    # Act
    served_by = chat_host(router)
    # Assert
    assert served_by == GROQ and upstream.hosts == [NIM, GROQ]


def test_router_malformed_answer_is_a_provider_error_that_triggers_fallback_not_a_500(registry):
    # Arrange
    upstream = Upstream(**{NIM: lambda r: httpx.Response(200, json={"unexpected": True})})
    router = make_router(registry, upstream, GROQ_KEY="gsk-aaaaaaaaaaaa", NIM_KEY="nvapi-bbbbbbbbbbbb")
    # Act / Assert
    assert chat_host(router) == GROQ


def test_router_breaker_opens_after_three_consecutive_failures_and_skips_the_provider(registry):
    # Arrange
    upstream = Upstream(**{NIM: 500})
    router = make_router(registry, upstream, GROQ_KEY="gsk-aaaaaaaaaaaa", NIM_KEY="nvapi-bbbbbbbbbbbb")
    # Act
    for _ in range(4):
        chat_host(router)
    # Assert: nim was tried three times, the fourth call went straight to groq
    assert upstream.hosts.count(NIM) == 3 and upstream.hosts[-1] == GROQ
    assert next(p for p in router.status()["providers"] if p["id"] == "nim")["status"] == "cooldown"


def test_router_rejected_key_falls_back_silently_and_a_new_key_reactivates_the_provider(registry):
    # Arrange
    upstream, clock = Upstream(**{NIM: 401}), Clock()
    router = make_router(registry, upstream, clock, GROQ_KEY="gsk-aaaaaaaaaaaa", NIM_KEY="nvapi-wrong-key-1")
    # Act
    first = chat_host(router)
    status_after = {p["id"]: p for p in router.status()["providers"]}["nim"]
    router.env.values["NIM_KEY"] = "nvapi-right-key-22"
    upstream.behaviors[NIM] = "ok"
    reactivated = {p["id"]: p for p in router.status()["providers"]}["nim"]["status"]
    # Assert
    assert first == GROQ and status_after["status"] == "cooldown" and status_after["breaker"]["invalid_key"]
    assert reactivated == "untested" and chat_host(router) == NIM


def test_router_all_providers_rate_limited_returns_429_with_retry_after_then_stops_calling_them(registry):
    # Arrange
    upstream = Upstream(**{NIM: 429, GROQ: 429})
    router = make_router(registry, upstream, GROQ_KEY="gsk-aaaaaaaaaaaa", NIM_KEY="nvapi-bbbbbbbbbbbb")
    # Act
    with pytest.raises(NoProviderAvailable) as first:
        run(router.chat(REQ))
    calls = len(upstream.hosts)
    with pytest.raises(NoProviderAvailable) as second:
        run(router.chat(REQ))
    # Assert
    assert first.value.status == 429 and 30 <= first.value.retry_after <= 32 and len(upstream.hosts) == calls
    assert second.value.status == 429


def test_router_daily_cap_excludes_the_provider_until_its_reset(registry):
    # Arrange
    clock, upstream = Clock(1_800_000_000.0), Upstream()
    registry = registry.model_copy(deep=True)
    registry.get("groq").limits.rpd = 1
    router = make_router(registry, upstream, clock, GROQ_KEY="gsk-aaaaaaaaaaaa")
    chat_host(router)
    # Act
    with pytest.raises(NoProviderAvailable) as refused:
        run(router.chat(REQ))
    clock.advance(86400)
    # Assert
    assert refused.value.status == 429 and refused.value.retry_after > 0 and chat_host(router) == GROQ
    assert upstream.hosts == [GROQ, GROQ]


def test_router_at_most_two_retries_on_other_providers_then_a_502_with_redacted_errors(registry):
    # Arrange
    keys = dict(NIM_KEY="nvapi-secretsecret-1", GROQ_KEY="gsk-secretsecret-22", CEREBRAS_KEY="csk-secretsecret-333", MISTRAL_KEY="mst-secretsecret-4444")
    upstream = Upstream(**{h: (lambda r: httpx.Response(500, text="boom " + r.headers["authorization"])) for h in
                           (NIM, GROQ, "api.cerebras.ai", "api.mistral.ai")})
    router = make_router(registry, upstream, **keys)
    # Act
    with pytest.raises(AllProvidersFailed) as failed:
        run(router.chat(REQ))
    # Assert
    assert len(upstream.hosts) == 3 and failed.value.status == 502
    assert not any(secret in json.dumps(failed.value.errors) + str(failed.value) for secret in keys.values())


def test_router_slow_provider_hits_the_timeout_and_falls_back(registry):
    # Arrange
    async def slow(request):
        await asyncio.sleep(1)
        return httpx.Response(200, json=ok_chat("late"))

    registry = registry.model_copy(deep=True)
    registry.router.timeout_s = 0.05
    upstream = Upstream(**{NIM: slow})
    router = make_router(registry, upstream, GROQ_KEY="gsk-aaaaaaaaaaaa", NIM_KEY="nvapi-bbbbbbbbbbbb")
    # Act / Assert
    assert chat_host(router) == GROQ
    assert router.breaker.info("nim")["last_error"].startswith("nim : delai")


def test_router_open_chat_streams_openai_providers_and_synthesizes_sse_for_native_ones(registry):
    # Arrange
    sse = "data: " + json.dumps({"choices": [{"delta": {"content": "hi"}}]}) + "\n\ndata: [DONE]\n\n"
    upstream = Upstream(**{GROQ: lambda r: httpx.Response(200, content=sse.encode(), headers={"content-type": "text/event-stream"})})
    stream_req = ChatRequest(messages=REQ.messages, stream=True)

    async def read(router):
        response, cand = await router.open_chat(stream_req)
        return cand.spec.id, await response.aread()

    # Act
    openai_id, openai_body = run(read(make_router(registry, upstream, GROQ_KEY="gsk-aaaaaaaaaaaa")))
    cohere_upstream = Upstream(**{"api.cohere.com": lambda r: httpx.Response(200, json={
        "message": {"content": [{"type": "text", "text": "salut"}]}, "finish_reason": "COMPLETE", "usage": {"tokens": {"input_tokens": 1, "output_tokens": 1}}})})
    native_id, native_body = run(read(make_router(registry, cohere_upstream, COHERE_KEY="co-aaaaaaaaaaaa")))
    # Assert
    assert openai_id == "groq" and b"[DONE]" in openai_body
    assert native_id == "cohere" and b'"content": "salut"' in native_body and native_body.endswith(b"data: [DONE]\n\n")


def test_router_status_masks_keys_and_reports_quota_and_reset(registry):
    # Arrange
    router = make_router(registry, Upstream(), NIM_KEY="nvapi-abcdefghijklmnop")
    # Act
    status = router.status()
    nim = next(p for p in status["providers"] if p["id"] == "nim")
    # Assert
    assert nim["key_hint"] == "nva...mnop" and "abcdefghij" not in json.dumps(status)
    assert nim["status"] == "untested" and nim["quota"]["limits"]["rpm"]["limit"] == 40 and status["configured"] == 1


def test_router_test_button_marks_active_on_success_and_reports_auth_errors_without_the_key(registry):
    # Arrange
    upstream = Upstream()
    router = make_router(registry, upstream, NIM_KEY="nvapi-abcdefghijklmnop")
    # Act
    good = run(router.test("nim"))
    active = next(p for p in router.status()["providers"] if p["id"] == "nim")["status"]
    bad_upstream = Upstream(**{GROQ: lambda r: httpx.Response(401, text="invalid key " + r.headers["authorization"])})
    bad = run(make_router(registry, bad_upstream).test("groq", key="gsk-typed-in-the-field"))
    # Assert
    assert good["ok"] and active == "active"
    assert not bad["ok"] and bad["kind"] == "auth" and "typed-in-the-field" not in json.dumps(bad)


def test_router_test_button_without_key_names_the_missing_variable(registry):
    # Arrange / Act
    result = run(make_router(registry, Upstream()).test("groq"))
    # Assert
    assert result == {"ok": False, "kind": "config", "detail": "cle absente : definissez GROQ_KEY dans .env"}


def test_router_state_survives_a_restart(registry, tmp_path):
    # Arrange
    path, clock = tmp_path / "s.json", Clock()
    first = Router(registry, make_router(registry, Upstream(), clock, NIM_KEY="nvapi-bbbbbbbbbbbb").env, StateStore(path), make_client(Upstream(**{NIM: 500})), clock)
    first.env.values["GROQ_KEY"] = "gsk-aaaaaaaaaaaa"
    for _ in range(3):
        chat_host(first)
    # Act
    reborn = Router(registry, first.env, StateStore(path), make_client(Upstream()), clock)
    # Assert
    assert next(p for p in reborn.status()["providers"] if p["id"] == "nim")["status"] == "cooldown"
