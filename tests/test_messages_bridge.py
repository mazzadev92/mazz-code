import pytest
from test_gateway import env, Upstreams, sse

def test_v1_messages_endpoint(env):
    client, up, tmp_path = env
    resp = client.post("/v1/messages", json={
        "model": "claude-3-5-sonnet-20241022",
        "messages": [
            {"role": "user", "content": "Ping"}
        ],
        "max_tokens": 10
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["type"] == "message"
    assert data["role"] == "assistant"
    assert len(data["content"]) > 0
    assert data["content"][0]["type"] == "text"
    assert data["content"][0]["text"] == "local"

def test_v1_messages_streaming(env):
    client, up, tmp_path = env
    resp = client.post("/v1/messages", json={
        "model": "claude-3-5-sonnet-20241022",
        "messages": [
            {"role": "user", "content": "Ping streaming"}
        ],
        "stream": True,
        "max_tokens": 10
    })
    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers.get("content-type", "")
    lines = resp.text.split("\n")
    events = [l for l in lines if l.startswith("event:")]
    assert any("message_start" in e for e in events)
    assert any("content_block_delta" in e for e in events)
    assert any("message_stop" in e for e in events)

def test_v1_messages_count_tokens(env):
    client, up, tmp_path = env
    resp = client.post("/v1/messages/count_tokens", json={
        "model": "claude-3-5-sonnet-20241022",
        "system": [{"type": "text", "text": "You are a test harness."}],
        "messages": [
            {"role": "user", "content": "How many tokens is this prompt?"}
        ],
        "tools": [
            {
                "name": "Read",
                "description": "Read a file",
                "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}}}
            }
        ]
    })
    assert resp.status_code == 200
    data = resp.json()
    assert "input_tokens" in data
    assert data["input_tokens"] > 0

