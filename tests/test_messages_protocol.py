r"""Anthropic /v1/messages protocol details (spec 06): real usage, system blocks, headers, cancellation.

Run: C:\Python314\python.exe -m pytest tests -q
"""
import json

from test_gateway import env  # noqa: F401  (pytest fixture)


def sse_events(text):
    return [json.loads(line[5:]) for line in text.splitlines() if line.startswith("data:")]


def test_messages_non_stream_usage_comes_from_upstream(env):
    # Arrange
    client, _, _ = env
    # Act
    r = client.post("/v1/messages", json={"model": "claude-x", "messages": [{"role": "user", "content": "Ping"}]})
    # Assert
    assert r.json()["usage"] == {"input_tokens": 11, "output_tokens": 3}


def test_messages_stream_usage_reported_in_message_delta_not_invented(env):
    # Arrange
    client, _, _ = env
    # Act
    r = client.post("/v1/messages", json={"model": "claude-x", "stream": True, "messages": [{"role": "user", "content": "Ping"}]})
    # Assert
    events = sse_events(r.text)
    start = next(e for e in events if e["type"] == "message_start")
    delta = next(e for e in events if e["type"] == "message_delta")
    assert start["message"]["usage"] == {"input_tokens": 0, "output_tokens": 0}
    assert delta["usage"] == {"input_tokens": 11, "output_tokens": 7}


def test_messages_upstream_without_usage_reports_zero(env):
    # Arrange
    client, up, _ = env
    up.usage = None
    # Act
    plain = client.post("/v1/messages", json={"model": "claude-x", "messages": [{"role": "user", "content": "Ping"}]})
    streamed = client.post("/v1/messages", json={"model": "claude-x", "stream": True, "messages": [{"role": "user", "content": "Ping"}]})
    # Assert
    zero = {"input_tokens": 0, "output_tokens": 0}
    assert plain.json()["usage"] == zero
    assert next(e for e in sse_events(streamed.text) if e["type"] == "message_delta")["usage"] == zero


def test_messages_system_blocks_all_kept_in_order(env):
    # Arrange
    client, up, _ = env
    system = [{"type": "text", "text": "A-invariant", "cache_control": {"type": "ephemeral"}},
              {"type": "text", "text": "B-regles"}, {"type": "text", "text": "C-outils"}]
    # Act
    r = client.post("/v1/messages", json={"model": "claude-x", "system": system, "messages": [{"role": "user", "content": "Ping"}]})
    # Assert
    sent = up.payloads[-1]["messages"][0]
    assert r.status_code == 200
    assert sent["role"] == "system"
    assert sent["content"].index("A-invariant") < sent["content"].index("B-regles") < sent["content"].index("C-outils")


def test_messages_system_block_without_text_is_400_invalid_request(env):
    # Arrange
    client, up, _ = env
    # Act
    r = client.post("/v1/messages", json={"model": "claude-x", "system": [{"type": "image"}], "messages": []})
    # Assert
    assert r.status_code == 400 and r.json()["error"]["type"] == "invalid_request_error"
    assert up.payloads == []


def test_messages_version_header_echoed_and_defaulted_when_missing(env):
    # Arrange
    client, _, _ = env
    msg = {"model": "claude-x", "messages": [{"role": "user", "content": "Ping"}]}
    # Act
    with_header = client.post("/v1/messages", json=msg, headers={"anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31"})
    without = client.post("/v1/messages", json=msg)
    # Assert
    assert with_header.status_code == 200 and with_header.headers["anthropic-version"] == "2023-06-01"
    assert without.status_code == 200 and without.headers["anthropic-version"] == "2023-06-01"
