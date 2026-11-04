import pytest

from test_gateway import KEY, env  # noqa: F401  (pytest fixture)


@pytest.fixture()
def ai(tmp_path, monkeypatch):
    """Isolated .env, state file and user-providers file: nothing touches the real configuration."""
    env_file = tmp_path / ".env"
    env_file.write_text("AI_ROUTER_ENABLED=false\nKEEP_ME=1\n", encoding="utf-8")
    monkeypatch.setenv("AI_ENV_FILE", str(env_file))
    monkeypatch.setenv("AI_ROUTER_STATE", str(tmp_path / "state.json"))
    monkeypatch.setenv("AI_USER_PROVIDERS", str(tmp_path / "user_providers.yaml"))
    for name in ("AI_ROUTER_ENABLED", "GROQ_KEY", "NIM_KEY", "MYLLM_KEY"):
        monkeypatch.delenv(name, raising=False)
    return env_file


def status_of(client, provider_id):
    rows = client.get("/integrations/status").json()["providers"]
    return next((p for p in rows if p["id"] == provider_id), None)


def test_manage_saveKey_writesTheEnvLineKeepsOthersAndActivatesTheProvider(ai, env):
    # Arrange
    client, _, _ = env
    # Act
    reply = client.put("/integrations/groq/key", json={"key": "gsk_abcdefghijkl"}, headers=KEY)
    # Assert
    text = ai.read_text(encoding="utf-8")
    assert reply.status_code == 200 and reply.json()["status"] == "untested" and reply.json()["key_hint"] == "gsk...ijkl"
    assert "GROQ_KEY=gsk_abcdefghijkl" in text and "KEEP_ME=1" in text and "AI_ROUTER_ENABLED=false" in text
    assert "gsk_abcdefghijkl" not in reply.text


def test_manage_saveKey_invalidOrAnonymousOrUnknown_isRefused(ai, env):
    # Arrange
    client, _, _ = env
    # Act
    anonymous = client.put("/integrations/groq/key", json={"key": "gsk_abcdefghijkl"})
    short = client.put("/integrations/groq/key", json={"key": "abc"}, headers=KEY)
    spaced = client.put("/integrations/groq/key", json={"key": "with space inside"}, headers=KEY)
    unknown = client.put("/integrations/nope/key", json={"key": "gsk_abcdefghijkl"}, headers=KEY)
    # Assert
    assert (anonymous.status_code, short.status_code, spaced.status_code, unknown.status_code) == (401, 400, 400, 404)


def test_manage_removeKey_deletesTheLineAndReturnsToMissingKey(ai, env):
    # Arrange
    client, _, _ = env
    client.put("/integrations/groq/key", json={"key": "gsk_abcdefghijkl"}, headers=KEY)
    # Act
    reply = client.delete("/integrations/groq/key", headers=KEY)
    # Assert
    assert reply.json()["status"] == "missing_key" and "GROQ_KEY" not in ai.read_text(encoding="utf-8")


def test_manage_addProvider_customOpenAiCompatibleIsStoredKeyedAndListed(ai, env, tmp_path):
    # Arrange
    client, _, _ = env
    payload = {"id": "myllm", "label": "Mon LLM", "base_url": "https://llm.example.com/v1/", "key": "sk-custom-123456", "models": [{"alias": "frontier", "id": "big"}]}
    # Act
    created = client.post("/integrations/providers", json=payload, headers=KEY)
    row = status_of(client, "myllm")
    # Assert
    assert created.status_code == 201 and row["status"] == "untested" and row["label"] == "Mon LLM"
    assert "MYLLM_KEY=sk-custom-123456" in ai.read_text(encoding="utf-8") and "https://llm.example.com/v1" in (tmp_path / "user_providers.yaml").read_text(encoding="utf-8")


@pytest.mark.parametrize("payload", [{"id": "groq", "base_url": "https://x.io/v1"}, {"id": "ok_id", "base_url": "ftp://x"}, {"id": "Bad Id", "base_url": "https://x.io"}, {"id": "ok_id"}])
def test_manage_addProvider_invalidOrDuplicateEntries_areRefused(ai, env, payload):
    # Arrange
    client, _, _ = env
    # Act
    reply = client.post("/integrations/providers", json=payload, headers=KEY)
    # Assert
    assert reply.status_code == 400


def test_manage_removeProvider_customIsRemovedWithItsKey_builtinIsRefused(ai, env):
    # Arrange
    client, _, _ = env
    client.post("/integrations/providers", json={"id": "myllm", "base_url": "https://llm.example.com/v1", "key": "sk-custom-123456"}, headers=KEY)
    # Act
    removed = client.delete("/integrations/providers/myllm", headers=KEY)
    builtin = client.delete("/integrations/providers/groq", headers=KEY)
    # Assert
    assert removed.status_code == 200 and status_of(client, "myllm") is None and "MYLLM_KEY" not in ai.read_text(encoding="utf-8")
    assert builtin.status_code == 409


def test_manage_setEnabled_offWritesDisabledFlagAndOnRemovesIt(ai, env):
    # Arrange
    client, _, _ = env
    client.put("/integrations/groq/key", json={"key": "gsk_abcdefghijkl"}, headers=KEY)
    # Act
    off = client.put("/integrations/groq/enabled", json={"enabled": False}, headers=KEY)
    on = client.put("/integrations/groq/enabled", json={"enabled": True}, headers=KEY)
    # Assert
    assert off.json()["status"] == "disabled" and on.json()["status"] == "untested" and "AI_GROQ_DISABLED" not in ai.read_text(encoding="utf-8")
