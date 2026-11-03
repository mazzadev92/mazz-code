import os
import re
import textwrap

import pytest
import yaml

from conftest import FakeEnv
from integrations.ai.adapters import ADAPTERS
from integrations.ai.loader import (ANONYMOUS, REGISTRY_PATH, EnvStore, RegistryError, expand, load_registry, provider_key, router_enabled)

REQUIRED = {"id", "label", "base_url", "auth", "adapter", "capabilities", "limits", "priority", "cost_class", "requires_card",
            "requires_phone", "signup_url", "enabled", "notes"}


def test_registry_is_valid_complete_and_in_waiting_state(registry):
    raw = yaml.safe_load(REGISTRY_PATH.read_text(encoding="utf-8"))["providers"]
    assert len(registry.providers) == len(raw) >= 35
    for entry in raw:
        assert REQUIRED <= set(entry), entry["id"]
        assert entry["enabled"] is False, entry["id"]
    assert registry.get("nim").limits.rpm == 40
    assert {p.priority for p in registry.providers if p.cost_class == "selfhost"} == {1, 2, 3}


def test_unverified_urls_are_null_with_a_todo_not_invented(registry):
    assert registry.get("amd_radeon").base_url is None and registry.get("apinex").base_url is None
    assert "TODO: verifier" in REGISTRY_PATH.read_text(encoding="utf-8")


def test_unknown_field_duplicate_id_and_unknown_adapter_are_rejected(tmp_path):
    base = yaml.safe_load(REGISTRY_PATH.read_text(encoding="utf-8"))
    typo = {**base, "providers": [{**base["providers"][0], "priorty": 1}]}
    path = tmp_path / "r.yaml"
    path.write_text(yaml.safe_dump(typo), encoding="utf-8")
    with pytest.raises(RegistryError):
        load_registry(path)
    dup = {**base, "providers": [base["providers"][0], base["providers"][0]]}
    path.write_text(yaml.safe_dump(dup), encoding="utf-8")
    with pytest.raises(RegistryError, match="dupliques"):
        load_registry(path)
    bad = {**base, "providers": [{**base["providers"][0], "adapter": "nope"}]}
    path.write_text(yaml.safe_dump(bad), encoding="utf-8")
    with pytest.raises(RegistryError, match="adapter inconnu"):
        load_registry(path, known_adapters=set(ADAPTERS))


def test_env_store_reads_process_env_first_and_reloads_a_pasted_key(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("# comment\nGROQ_KEY=\nNIM_KEY='nv-abc'\nexport OTHER=1 # trailing\n", encoding="utf-8")
    store = EnvStore(env_file)
    assert store.get("GROQ_KEY") is None and store.get("NIM_KEY") == "nv-abc" and store.get("OTHER") == "1"
    env_file.write_text("GROQ_KEY=gsk_new_value\n", encoding="utf-8")
    os.utime(env_file, ns=(1, 1))  # a different mtime, whatever the filesystem granularity
    assert store.get("GROQ_KEY") == "gsk_new_value"  # picked up without restart
    monkeypatch.setenv("GROQ_KEY", "from-process")
    assert store.get("GROQ_KEY") == "from-process"
    assert EnvStore(tmp_path / "absent.env").get("X") is None


def test_expand_defaults_and_missing_variables():
    env = FakeEnv(HOST="h")
    assert expand("http://${HOST}/v1", env) == "http://h/v1"
    assert expand("${MISSING:-http://d/v1}", env) == "http://d/v1"
    assert expand("${MISSING}", env) is None and expand(None, env) is None


def test_anonymous_sentinel_only_for_optional_keys(registry):
    llm7, nim = registry.get("llm7"), registry.get("nim")
    assert provider_key(llm7, FakeEnv()) is None
    assert provider_key(llm7, FakeEnv(LLM7_KEY=ANONYMOUS)) == ""
    assert provider_key(nim, FakeEnv(NIM_KEY=ANONYMOUS)) is None
    assert provider_key(nim, FakeEnv(NIM_KEY="nvapi-123")) == "nvapi-123"


def test_router_flag_is_false_by_default():
    assert router_enabled(FakeEnv()) is False and router_enabled(FakeEnv(AI_ROUTER_ENABLED="true")) is True


def test_no_secret_is_committed_in_the_integration_files():
    root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    pattern = re.compile(r"\b(?:sk-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{30,}|AIza[A-Za-z0-9_-]{30,})")
    for folder in ("integrations", os.path.join("tests", "ai")):
        for base, _dirs, files in os.walk(os.path.join(root, folder)):
            for name in files:
                if name.endswith((".py", ".yaml", ".md", ".example", ".yml", ".txt")) or name == ".env.example":
                    text = open(os.path.join(base, name), encoding="utf-8", errors="ignore").read()
                    assert not pattern.search(text), os.path.join(base, name)


def test_env_example_has_every_variable_with_an_empty_value(registry):
    path = os.path.join(os.path.dirname(REGISTRY_PATH), ".env.example")
    lines = {l.split("=", 1)[0]: l.split("=", 1)[1] for l in open(path, encoding="utf-8").read().splitlines() if "=" in l and not l.startswith("#")}
    for spec in registry.providers:
        assert spec.auth.env in lines, spec.id
    assert lines["AI_ROUTER_ENABLED"] == "false"
    assert all(v in ("", "false") for k, v in lines.items() if k.endswith("_KEY") or k == "AI_ROUTER_ENABLED")


def test_setup_document_covers_every_registry_provider(registry):
    path = os.path.join(os.path.dirname(REGISTRY_PATH), "SETUP.md")
    setup = open(path, encoding="utf-8").read()
    for spec in registry.providers:
        assert f"(`{spec.id}`)" in setup, spec.id
    assert "Fournisseurs > Routeur MAZZ Control" in setup
