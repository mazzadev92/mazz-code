"""Resilience (spec 05/06): circuit breaker, failover triggers, local queue, swap guard, Anthropic errors.

Run: C:\\Python314\\python.exe -m pytest tests -q
"""
import asyncio

import pytest

import app as gateway
from core import breaker
from test_gateway import KEY, env  # noqa: F401  (pytest fixture)

REMOTE = {"id": "colab-a100", "kind": "colab", "base_url": "https://x.trycloudflare.com"}


@pytest.fixture(autouse=True)
def fresh_breaker():
    breaker.reset()
    yield
    breaker.reset()


def with_local_model(tmp):
    (tmp / "models" / "local-model.gguf").write_bytes(b"GGUF")


def remote_chat_calls(up):
    return sum(1 for host, _, path, _ in up.calls if host != "127.0.0.1" and path.endswith("/chat/completions"))


def test_breaker_three_failures_opens_then_half_opens_after_cooldown(monkeypatch):
    # Arrange
    now = {"t": 1000.0}
    monkeypatch.setattr(breaker, "_clock", lambda: now["t"])
    # Act
    for _ in range(breaker.FAIL_THRESHOLD):
        breaker.record_failure("b")
    opened = breaker.state("b")
    now["t"] += breaker.OPEN_SECONDS + 1
    half = breaker.state("b")
    breaker.record_success("b")
    # Assert
    assert opened == "open"
    assert half == "half_open"
    assert breaker.state("b") == "closed"


def test_breaker_half_open_failure_reopens_immediately(monkeypatch):
    # Arrange
    now = {"t": 0.0}
    monkeypatch.setattr(breaker, "_clock", lambda: now["t"])
    for _ in range(breaker.FAIL_THRESHOLD):
        breaker.record_failure("b")
    now["t"] += breaker.OPEN_SECONDS + 1
    # Act
    breaker.record_failure("b")
    # Assert
    assert breaker.state("b") == "open" and breaker.allow("b") is False


def test_breaker_trips_only_on_missing_endpoint_timeout_rate_limit_and_server_errors():
    assert [s for s in (400, 401, 403, 404, 408, 422, 429, 500, 502, 503, 529) if breaker.trips(s)] == [404, 408, 429, 500, 502, 503, 529]


def test_gateway_remote_400_is_returned_without_fallback(env):
    # Arrange
    client, up, _ = env
    client.post("/api/backends", headers=KEY, json=REMOTE)
    up.remote_status = 400
    # Act
    r = client.post("/v1/chat/completions", json={"model": "colab-a100/big-32b", "messages": []})
    # Assert
    assert r.status_code == 400
    assert r.headers["x-mazz-backend"] == "colab-a100"
    assert "x-mazz-fallback" not in r.headers
    assert breaker.state("colab-a100") == "closed"


def test_gateway_remote_503_falls_back_to_local(env):
    # Arrange
    client, up, _ = env
    client.post("/api/backends", headers=KEY, json=REMOTE)
    up.remote_status = 503
    # Act
    r = client.post("/v1/chat/completions", json={"model": "colab-a100/big-32b", "messages": []})
    # Assert
    assert r.status_code == 200
    assert r.headers["x-mazz-backend"] == "local"
    assert r.headers["x-mazz-fallback"].startswith("colab-a100")


def test_gateway_open_breaker_skips_remote_entirely(env):
    # Arrange
    client, up, _ = env
    client.post("/api/backends", headers=KEY, json=REMOTE)
    up.remote_down = True
    for _ in range(breaker.FAIL_THRESHOLD):
        client.post("/v1/chat/completions", json={"model": "colab-a100/big-32b", "messages": []})
    before = remote_chat_calls(up)
    # Act
    r = client.post("/v1/chat/completions", json={"model": "colab-a100/big-32b", "messages": []})
    # Assert
    assert before == breaker.FAIL_THRESHOLD
    assert remote_chat_calls(up) == before
    assert r.status_code == 200 and r.headers["x-mazz-backend"] == "local"
    assert r.headers["x-mazz-fallback"] == "colab-a100: CircuitOpen"


def test_gateway_local_queue_full_returns_503_with_retry_after(env, monkeypatch):
    # Arrange
    client, _, tmp = env
    with_local_model(tmp)
    monkeypatch.setattr(gateway, "_local_slot", asyncio.Semaphore(0))
    monkeypatch.setattr(gateway, "LOCAL_QUEUE_MAX", 0)
    # Act
    r = client.post("/v1/chat/completions", json={"model": "local-model", "messages": []})
    m = client.post("/v1/messages", json={"model": "local-model", "max_tokens": 5, "messages": [{"role": "user", "content": "x"}]})
    # Assert
    assert r.status_code == 503 and r.headers["retry-after"] == "5"
    assert m.status_code == 503 and m.json()["error"]["type"] == "overloaded_error"


def test_gateway_local_queue_wait_timeout_returns_503(env, monkeypatch):
    # Arrange
    client, _, tmp = env
    with_local_model(tmp)
    monkeypatch.setattr(gateway, "_local_slot", asyncio.Semaphore(0))
    monkeypatch.setattr(gateway, "LOCAL_QUEUE_WAIT_S", 0.05)
    # Act
    r = client.post("/v1/chat/completions", json={"model": "local-model", "messages": []})
    # Assert
    assert r.status_code == 503 and r.headers["retry-after"] == "5"


def test_gateway_local_slot_is_released_after_each_request(env):
    # Arrange
    client, _, tmp = env
    with_local_model(tmp)
    # Act
    for stream in (False, True, False):
        r = client.post("/v1/chat/completions", json={"model": "local-model", "stream": stream, "messages": []})
        assert r.status_code == 200
    m = client.post("/v1/messages", json={"model": "local-model", "max_tokens": 5, "stream": True, "messages": [{"role": "user", "content": "x"}]})
    # Assert
    assert m.status_code == 200
    assert gateway._local_slot.locked() is False


def test_gateway_swap_during_inference_is_409(env, monkeypatch):
    # Arrange
    client, _, tmp = env
    (tmp / "models" / "other.gguf").write_bytes(b"GGUF")
    monkeypatch.setattr(gateway, "_local_slot", asyncio.Semaphore(0))
    # Act
    busy = client.post("/api/models/swap", headers=KEY, json={"model": "other"})
    monkeypatch.setattr(gateway, "_local_slot", asyncio.Semaphore(1))
    free = client.post("/api/models/swap", headers=KEY, json={"model": "other"})
    # Assert
    assert busy.status_code == 409 and busy.json()["error"] == "Inference in flight, cannot swap"
    assert free.status_code == 200 and free.json()["success"] is True


def test_messages_remote_401_is_normalized_anthropic_error(env):
    # Arrange
    client, up, _ = env
    client.post("/api/backends", headers=KEY, json=REMOTE)
    up.remote_status = 401
    # Act
    r = client.post("/v1/messages", json={"model": "colab-a100/big-32b", "max_tokens": 5, "messages": [{"role": "user", "content": "x"}]})
    # Assert
    assert r.status_code == 401
    assert r.json() == {"type": "error", "error": {"type": "authentication_error", "message": "HTTP 401"}}
    assert "x-mazz-fallback" not in r.headers


def test_messages_stream_cut_emits_sse_error_event(env):
    # Arrange
    client, up, tmp = env
    with_local_model(tmp)
    up.local_stream_break = True
    # Act
    r = client.post("/v1/messages", json={"model": "local-model", "max_tokens": 5, "stream": True, "messages": [{"role": "user", "content": "x"}]})
    # Assert
    assert "event: error" in r.text and '"api_error"' in r.text
    assert "event: message_stop" not in r.text
    assert gateway._local_slot.locked() is False


def test_gateway_local_slot_released_when_upstream_body_read_fails(env):
    # Arrange
    client, up, tmp = env
    with_local_model(tmp)
    up.local_stream_break = True
    # Act
    with pytest.raises(Exception):
        client.post("/v1/chat/completions", json={"model": "local-model", "messages": []})
    # Assert
    assert gateway._local_slot.locked() is False


def test_gateway_haiku_goes_to_draft_server_and_draft_never_serves_generic_claude(env):
    # Arrange
    client, up, _ = env
    client.post("/api/backends", headers=KEY, json={"id": "draft", "kind": "api", "base_url": "https://draft.example"})
    # Act
    fast = client.post("/v1/chat/completions", json={"model": "claude-haiku-4-5", "messages": []})
    generic = client.post("/v1/chat/completions", json={"model": "claude-opus-5-5", "messages": []})
    # Assert
    assert fast.headers["x-mazz-backend"] == "draft"
    assert generic.headers["x-mazz-backend"] == "local"


def test_gateway_remote_404_falls_back_to_local(env):
    # Arrange
    client, up, _ = env
    client.post("/api/backends", headers=KEY, json=REMOTE)
    up.remote_status = 404
    # Act
    r = client.post("/v1/chat/completions", json={"model": "colab-a100/big-32b", "messages": []})
    # Assert
    assert r.status_code == 200 and r.headers["x-mazz-backend"] == "local"
