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
