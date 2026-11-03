import json

import httpx
import pytest

from conftest import ok_chat
from test_gateway import KEY, env  # noqa: F401  (pytest fixture)
import app as gateway

REAL_CLIENT = httpx.AsyncClient  # the gateway fixture patches httpx.AsyncClient for the whole module
GROQ, NIM = "api.groq.com", "integrate.api.nvidia.com"
BODY = {"model": "auto", "max_tokens": 16, "messages": [{"role": "user", "content": "salut"}]}


@pytest.fixture()
def ai(tmp_path, monkeypatch):
    """Isolated .env and state file: the test never touches the user's real configuration. Returns a .env writer."""
    env_file = tmp_path / ".env"
    monkeypatch.setenv("AI_ENV_FILE", str(env_file))
    monkeypatch.setenv("AI_ROUTER_STATE", str(tmp_path / "state.json"))
    for name in ("AI_ROUTER_ENABLED", "GROQ_KEY", "NIM_KEY"):
        monkeypatch.delenv(name, raising=False)

    def write(**values):
        env_file.write_text("".join(f"{k}={v}\n" for k, v in values.items()), encoding="utf-8")

    return write


class Providers:
    def __init__(self, **statuses):
        self.hosts, self.statuses = [], statuses

    def __call__(self, request):
        host = request.url.host
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "m"}]})
        self.hosts.append(host)
        status = self.statuses.get(host, 200)
        if status != 200:
            return httpx.Response(status, json={"error": "x"})
        if json.loads(request.content).get("stream"):
            sse = "data: " + json.dumps({"choices": [{"delta": {"content": host}}]}) + "\n\ndata: [DONE]\n\n"
            return httpx.Response(200, content=sse.encode(), headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json=ok_chat(host))


def plug(providers):
    gateway.ai_router.client = REAL_CLIENT(transport=httpx.MockTransport(providers))


def test_gateway_router_disabled_keeps_the_previous_behavior_for_auto_models(ai, env):
    # Arrange
    client, _, _ = env
    ai(GROQ_KEY="gsk-aaaaaaaaaaaa")
    providers = Providers()
    plug(providers)
    # Act
    reply = client.post("/v1/chat/completions", json=BODY)
    models = client.get("/v1/models").json()["data"]
    # Assert: "auto" is an unknown model exactly as before, and no provider was called
    assert reply.status_code == 404 and providers.hosts == []
    assert not any(m["id"] == "auto" or m["id"].startswith("router/") for m in models)


def test_gateway_router_enabled_exposes_auto_and_aliases_via_the_existing_models_endpoint(ai, env):
    # Arrange
    client, _, _ = env
    ai(AI_ROUTER_ENABLED="true")
    # Act
    models = client.get("/v1/models").json()["data"]
    ids = {model["id"] for model in models}
    # Assert: these become selectable by the Studio's existing MAZZ Control provider.
    assert {"auto", "router/frontier", "router/fast"} <= ids


def test_gateway_router_enabled_with_zero_keys_answers_503_listing_the_missing_variables(ai, env):
    # Arrange
    client, _, _ = env
    ai(AI_ROUTER_ENABLED="true")
    # Act
    openai = client.post("/v1/chat/completions", json=BODY)
    anthropic = client.post("/v1/messages", json=BODY)
    # Assert
    assert openai.status_code == anthropic.status_code == 503
    assert "NIM_KEY" in openai.json()["error"]["message"] and "NIM_KEY" in anthropic.json()["error"]["message"]


def test_gateway_router_enabled_routes_openai_and_anthropic_requests_through_the_chosen_provider(ai, env):
    # Arrange
    client, _, _ = env
    ai(AI_ROUTER_ENABLED="true", GROQ_KEY="gsk-aaaaaaaaaaaa")
    plug(Providers())
    # Act
    openai = client.post("/v1/chat/completions", json=BODY)
    anthropic = client.post("/v1/messages", json={**BODY, "model": "router/frontier"})
    streamed = client.post("/v1/messages", json={**BODY, "stream": True})
    # Assert
    assert openai.status_code == 200 and openai.headers["x-mazz-backend"] == "router/groq" and openai.json()["choices"][0]["message"]["content"] == GROQ
    assert anthropic.json()["content"][0]["text"] == GROQ and anthropic.json()["stop_reason"] == "end_turn"
    assert "message_stop" in streamed.text and GROQ in streamed.text


def test_gateway_router_falls_back_to_the_next_provider_without_a_client_visible_error(ai, env):
    # Arrange
    client, _, _ = env
    ai(AI_ROUTER_ENABLED="true", NIM_KEY="nvapi-bbbbbbbbbbbb", GROQ_KEY="gsk-aaaaaaaaaaaa")
    providers = Providers(**{NIM: 500})
    plug(providers)
    # Act
    reply = client.post("/v1/chat/completions", json=BODY)
    # Assert
    assert reply.status_code == 200 and providers.hosts == [NIM, GROQ] and reply.headers["x-mazz-backend"] == "router/groq"


def test_gateway_router_all_rate_limited_answers_429_with_retry_after(ai, env):
    # Arrange
    client, _, _ = env
    ai(AI_ROUTER_ENABLED="true", GROQ_KEY="gsk-aaaaaaaaaaaa")
    plug(Providers(**{GROQ: 429}))
    # Act
    reply = client.post("/v1/chat/completions", json=BODY)
    # Assert
    assert reply.status_code == 429 and int(reply.headers["retry-after"]) > 0


def test_gateway_a_pasted_key_is_seen_immediately_without_restart(ai, env):
    # Arrange
    client, _, _ = env
    ai()
    before = {p["id"]: p["status"] for p in client.get("/integrations/status").json()["providers"]}
    # Act
    ai(GROQ_KEY="gsk-aaaaaaaaaaaa")
    after = {p["id"]: p["status"] for p in client.get("/integrations/status").json()["providers"]}
    # Assert
    assert before["groq"] == "missing_key" and after["groq"] == "untested"


def test_gateway_status_and_quota_routes_report_every_provider_and_mask_keys(ai, env):
    # Arrange
    client, _, _ = env
    ai(GROQ_KEY="gsk-abcdefghijklmnop")
    # Act
    status = client.get("/integrations/status")
    quota = client.get("/integrations/quota")
    # Assert
    assert status.status_code == 200 and status.json()["total"] >= 35 and status.json()["enabled"] is False
    assert "abcdefghij" not in status.text and next(p for p in status.json()["providers"] if p["id"] == "groq")["key_hint"] == "gsk...mnop"
    assert quota.status_code == 200 and len(quota.json()["providers"]) == status.json()["total"]


def test_gateway_integration_posts_require_the_control_key(ai, env):
    # Arrange
    client, _, _ = env
    # Act
    anonymous = client.post("/integrations/groq/test", json={})
    keyed = client.post("/integrations/groq/test", json={}, headers=KEY)
    # Assert
    assert anonymous.status_code == 401 and keyed.status_code == 200 and keyed.json()["kind"] == "config"


def test_gateway_test_button_with_a_typed_key_reports_the_result_without_echoing_the_key(ai, env):
    # Arrange
    client, _, _ = env
    ai()
    plug(Providers(**{GROQ: 401}))
    # Act
    reply = client.post("/integrations/groq/test", json={"key": "gsk-typed-key-12345"}, headers=KEY)
    # Assert
    assert reply.json()["ok"] is False and reply.json()["kind"] == "auth" and "typed-key" not in reply.text


def test_gateway_call_route_needs_the_flag_and_reports_missing_providers_when_enabled(ai, env):
    # Arrange
    client, _, _ = env
    ai()
    # Act
    disabled = client.post("/integrations/call/search", json={"query": "q"}, headers=KEY)
    ai(AI_ROUTER_ENABLED="true")
    enabled = client.post("/integrations/call/search", json={"query": "q"}, headers=KEY)
    unknown = client.post("/integrations/call/nope", json={}, headers=KEY)
    # Assert
    assert disabled.status_code == 409 and enabled.status_code == 503 and "TAVILY_KEY" in enabled.json()["error"]["message"]
    assert unknown.status_code == 404
