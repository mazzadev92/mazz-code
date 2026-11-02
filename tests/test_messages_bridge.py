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



def test_bridge_system_messages_inside_messages_are_merged_first_and_tools_are_native(env, monkeypatch):
    # Arrange
    import app as gateway
    client, up, tmp = env
    (tmp / "models" / "local-model.gguf").write_bytes(b"GGUF")
    sent = {}
    real = gateway._send

    async def spy(c, b, model, body, stream):
        sent["body"] = body
        return await real(c, b, model, body, stream)
    monkeypatch.setattr(gateway, "_send", spy)
    tools = [{"name": f"mcp__srv__t{i}", "input_schema": {"type": "object"}} for i in range(20)] + [{"name": "Read", "input_schema": {"type": "object"}}]
    # Act
    r = client.post("/v1/messages", json={"model": "local-model", "max_tokens": 10, "system": "S1", "tools": tools, "messages": [
        {"role": "system", "content": [{"type": "text", "text": "S2"}]},
        {"role": "user", "content": "lis a.py"},
        {"role": "assistant", "content": [{"type": "text", "text": "je lis"}, {"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {"path": "a.py"}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": [{"type": "text", "text": "x = 1"}]}]},
    ]})
    # Assert
    assert r.status_code == 200
    msgs = sent["body"]["messages"]
    assert [m["role"] for m in msgs] == ["system", "user", "assistant", "tool"]
    assert msgs[0]["content"] == "S1\n\nS2"
    assert msgs[2]["tool_calls"][0]["function"] == {"name": "Read", "arguments": '{"path": "a.py"}'}
    assert msgs[3] == {"role": "tool", "tool_call_id": "toolu_1", "content": "x = 1"}
    names = [t["function"]["name"] for t in sent["body"]["tools"]]
    assert len(names) == 15 and names[0] == "Read"
