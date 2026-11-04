import base64
import json

import httpx
import pytest

from conftest import make_adapter, ok_chat, run
from integrations.ai.adapters.base import ChatRequest, ProviderError, mask_key, redact

CHAT = ChatRequest(messages=[{"role": "user", "content": "salut"}])
KEY = "secret-key-1234567890"


class Seen:
    """Records requests and answers with a canned response."""

    def __init__(self, *responses):
        self.requests, self.responses = [], list(responses)

    def __call__(self, request):
        self.requests.append(request)
        reply = self.responses[min(len(self.requests) - 1, len(self.responses) - 1)]
        return reply(request) if callable(reply) else reply

    @property
    def last(self):
        return self.requests[-1]


def j(data, status=200, **headers):
    return httpx.Response(status, json=data, headers=headers)


# ------------------------------------------------------------------ openai_compat + error mapping
def test_openai_compat_chat_sends_bearer_alias_model_and_returns_normalized_response(registry):
    # Arrange
    seen = Seen(j(ok_chat("bonjour")))
    adapter = make_adapter(registry, "groq", seen)
    # Act
    reply = run(adapter.chat(ChatRequest(messages=CHAT.messages, model="fast", max_tokens=5)))
    # Assert
    body = json.loads(seen.last.content)
    assert seen.last.url == "https://api.groq.com/openai/v1/chat/completions" and seen.last.headers["authorization"] == f"Bearer {KEY}"
    assert body["model"] == "openai/gpt-oss-20b" and body["max_tokens"] == 5 and body["stream"] is False
    assert reply.content == "bonjour" and reply.provider == "groq" and reply.usage.total_tokens == 5


def test_openai_compat_embed_orders_vectors_by_index_and_image_returns_url(registry):
    # Arrange
    embed = Seen(j({"data": [{"index": 1, "embedding": [2.0]}, {"index": 0, "embedding": [1.0]}], "usage": {"prompt_tokens": 2, "total_tokens": 2}}))
    image = Seen(j({"data": [{"url": "https://img/1.png"}]}))
    # Act
    vectors = run(make_adapter(registry, "nim", embed).embed(["a", "b"], model="frontier")).vectors
    pictures = run(make_adapter(registry, "recraft", image).image("un chat")).images
    # Assert
    assert vectors == [[1.0], [2.0]] and pictures == ["https://img/1.png"]


def test_openai_compat_discovers_models_by_pattern_once_when_no_id_is_pinned(registry):
    # Arrange
    seen = Seen(j({"data": [{"id": "text-embedding"}, {"id": "gemini-2.5-flash"}, {"id": "gemini-pro"}]}), j(ok_chat("ok")))
    adapter = make_adapter(registry, "aistudio", seen)
    # Act
    run(adapter.chat(CHAT))
    run(adapter.chat(CHAT))
    # Assert
    assert json.loads(seen.requests[1].content)["model"] == "gemini-2.5-flash"
    assert [r.url.path for r in seen.requests].count("/v1beta/openai/models") == 1


@pytest.mark.parametrize("status,kind", [(401, "auth"), (403, "auth"), (402, "quota"), (429, "rate_limit"), (500, "upstream"), (503, "upstream"), (404, "request")])
def test_adapter_http_status_is_mapped_to_a_provider_error_kind(registry, status, kind):
    # Arrange
    adapter = make_adapter(registry, "groq", Seen(httpx.Response(status, text="no", headers={"retry-after": "7"})))
    # Act
    with pytest.raises(ProviderError) as raised:
        run(adapter.chat(CHAT))
    # Assert
    assert raised.value.kind == kind and (raised.value.retry_after == 7 if kind == "rate_limit" else True)


def test_adapter_network_timeout_and_non_json_and_wrong_shape_are_provider_errors(registry):
    # Arrange
    def timeout(request):
        raise httpx.ReadTimeout("slow", request=request)

    cases = {"timeout": Seen(timeout), "parse": Seen(httpx.Response(200, text="<html>")), "parse2": Seen(j({"nope": 1}))}
    # Act / Assert
    for expected, seen in cases.items():
        with pytest.raises(ProviderError) as raised:
            run(make_adapter(registry, "groq", seen).chat(CHAT))
        assert raised.value.kind == expected.rstrip("2")


def test_adapter_error_messages_never_contain_the_key(registry):
    # Arrange
    adapter = make_adapter(registry, "groq", Seen(httpx.Response(401, text=f"bad key {KEY} Bearer {KEY}")))
    # Act
    with pytest.raises(ProviderError) as raised:
        run(adapter.chat(CHAT))
    # Assert
    assert KEY not in str(raised.value) and "gsk" not in str(raised.value)
    assert mask_key("sk-abcdefghijklmnop") == "sk-...mnop" and redact("Authorization: Bearer abcdefghijkl") == "Authorization: Bearer ***"


# ------------------------------------------------------------------ native chat
def test_cloudflare_chat_and_embed_use_the_account_id_and_native_shape(registry):
    # Arrange
    chat = Seen(j({"success": True, "result": {"response": "salut", "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}}))
    embed = Seen(j({"success": True, "result": {"data": [[0.1, 0.2]]}}))
    failed = Seen(j({"success": False, "errors": [{"message": "nope"}]}))
    # Act
    reply = run(make_adapter(registry, "cloudflare", chat, CLOUDFLARE_ACCOUNT_ID="ACC").chat(CHAT))
    vectors = run(make_adapter(registry, "cloudflare", embed, CLOUDFLARE_ACCOUNT_ID="ACC").embed(["a"])).vectors
    # Assert
    assert chat.last.url == "https://api.cloudflare.com/client/v4/accounts/ACC/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    assert reply.content == "salut" and vectors == [[0.1, 0.2]]
    with pytest.raises(ProviderError) as raised:
        run(make_adapter(registry, "cloudflare", failed, CLOUDFLARE_ACCOUNT_ID="ACC").chat(CHAT))
    assert raised.value.kind == "upstream"


def test_cohere_chat_embed_and_rerank_use_v2_shapes(registry):
    # Arrange
    chat = Seen(j({"message": {"content": [{"type": "text", "text": "ok"}]}, "finish_reason": "MAX_TOKENS", "usage": {"tokens": {"input_tokens": 2, "output_tokens": 3}}}))
    embed = Seen(j({"embeddings": {"float": [[1.0, 2.0]]}}))
    rerank = Seen(j({"results": [{"index": 1, "relevance_score": 0.9}]}))
    # Act
    reply = run(make_adapter(registry, "cohere", chat).chat(CHAT))
    vectors = run(make_adapter(registry, "cohere", embed).embed(["a"])).vectors
    ranking = run(make_adapter(registry, "cohere", rerank).rerank("q", ["a", "b"], top_n=1)).ranking
    # Assert
    assert reply.content == "ok" and reply.finish_reason == "length" and reply.usage.total_tokens == 5
    assert vectors == [[1.0, 2.0]] and ranking == [{"index": 1, "score": 0.9}] and rerank.last.url.path == "/v2/rerank"


# ------------------------------------------------------------------ embeddings / rerank
def test_voyage_and_jina_embed_and_rerank_parse_their_shapes(registry):
    # Arrange
    voyage_embed = Seen(j({"data": [{"index": 0, "embedding": [1.0]}], "usage": {"total_tokens": 4}}))
    voyage_rerank = Seen(j({"data": [{"index": 0, "relevance_score": 0.5}]}))
    jina_embed = Seen(j({"data": [{"index": 0, "embedding": [3.0]}], "usage": {"total_tokens": 1}}))
    jina_rerank = Seen(j({"results": [{"index": 2, "relevance_score": 0.7}]}))
    # Act / Assert
    assert run(make_adapter(registry, "voyage", voyage_embed).embed(["a"])).usage.total_tokens == 4
    assert run(make_adapter(registry, "voyage", voyage_rerank).rerank("q", ["a"])).ranking == [{"index": 0, "score": 0.5}]
    assert run(make_adapter(registry, "jina", jina_embed).embed(["a"])).vectors == [[3.0]]
    assert run(make_adapter(registry, "jina", jina_rerank).rerank("q", ["a"])).ranking == [{"index": 2, "score": 0.7}]


# ------------------------------------------------------------------ audio
def test_elevenlabs_tts_sends_xi_api_key_and_the_voice_and_counts_characters(registry):
    # Arrange
    seen = Seen(httpx.Response(200, content=b"MP3DATA"))
    adapter = make_adapter(registry, "elevenlabs", seen, ELEVENLABS_VOICE_ID="voice1")
    # Act
    reply = run(adapter.tts("bonjour"))
    # Assert
    assert seen.last.url.path == "/v1/text-to-speech/voice1" and seen.last.headers["xi-api-key"] == KEY
    assert base64.b64decode(reply.audio_b64) == b"MP3DATA" and reply.usage.units == 7
    with pytest.raises(ProviderError) as raised:
        run(make_adapter(registry, "elevenlabs", seen).tts("x"))
    assert raised.value.kind == "config"


def test_cartesia_tts_uses_bearer_and_the_documented_version_header(registry):
    # Arrange
    seen = Seen(httpx.Response(200, content=b"AUDIO"))
    # Act
    reply = run(make_adapter(registry, "cartesia", seen, CARTESIA_VOICE_ID="v").tts("salut"))
    # Assert
    assert seen.last.headers["authorization"] == f"Bearer {KEY}" and seen.last.headers["cartesia-version"] == "2026-08-14"
    assert seen.last.url == "https://api.cartesia.ai/tts/bytes" and reply.usage.units == 5


def test_deepgram_stt_uses_the_token_scheme_for_bytes_and_urls_and_pings_without_spending(registry):
    # Arrange
    answer = {"results": {"channels": [{"alternatives": [{"transcript": "bonjour"}]}]}}
    seen = Seen(j(answer), j(answer), j({"projects": []}))
    adapter = make_adapter(registry, "deepgram", seen)
    # Act
    from_bytes = run(adapter.stt(audio=b"RIFF", mime="audio/wav"))
    from_url = run(adapter.stt(url="https://x/a.wav"))
    ping = run(adapter.ping())
    # Assert
    assert seen.requests[0].headers["authorization"] == f"Token {KEY}" and seen.requests[0].headers["content-type"] == "audio/wav"
    assert json.loads(seen.requests[1].content) == {"url": "https://x/a.wav"} and seen.requests[2].url.path == "/v1/projects"
    assert from_bytes.text == from_url.text == "bonjour" and ping["ok"]


def test_assemblyai_stt_uploads_submits_and_polls_until_completed(registry):
    # Arrange
    seen = Seen(j({"upload_url": "https://cdn/u"}), j({"id": "t1"}), j({"status": "processing"}), j({"status": "completed", "text": "salut"}))
    adapter = make_adapter(registry, "assemblyai", seen)
    adapter.poll_interval = 0
    # Act
    reply = run(adapter.stt(audio=b"RIFF"))
    # Assert
    assert reply.text == "salut" and seen.requests[0].headers["authorization"] == KEY
    assert json.loads(seen.requests[1].content) == {"audio_url": "https://cdn/u"} and len(seen.requests) == 4


def test_assemblyai_error_status_becomes_a_provider_error(registry):
    # Arrange
    adapter = make_adapter(registry, "assemblyai", Seen(j({"id": "t1"}), j({"status": "error", "error": "bad audio"})))
    adapter.poll_interval = 0
    # Act / Assert
    with pytest.raises(ProviderError) as raised:
        run(adapter.stt(url="https://x/a.wav"))
    assert raised.value.kind == "upstream"


# ------------------------------------------------------------------ image
def test_stability_and_fal_images_parse_base64_and_urls(registry):
    # Arrange
    stability = Seen(j({"image": "QkFTRTY0"}))
    fal = Seen(j({"images": [{"url": "https://fal/1.png"}]}))
    # Act
    pic = run(make_adapter(registry, "stability", stability).image("un chat"))
    fal_pic = run(make_adapter(registry, "fal", fal).image("un chat"))
    # Assert
    assert stability.last.url.path == "/v2beta/stable-image/generate/core" and stability.last.headers["accept"] == "application/json"
    assert pic.images == ["QkFTRTY0"] and fal.last.headers["authorization"] == f"Key {KEY}" and fal_pic.images == ["https://fal/1.png"]


# ------------------------------------------------------------------ search
def test_tavily_sends_the_key_in_the_body_and_brave_in_its_header(registry):
    # Arrange
    tavily = Seen(j({"results": [{"title": "t", "url": "https://a", "content": "c", "score": 0.9}]}))
    brave = Seen(j({"web": {"results": [{"title": "b", "url": "https://b", "description": "d"}]}}))
    # Act
    t_hits = run(make_adapter(registry, "tavily", tavily).search("q", 3)).results
    b_hits = run(make_adapter(registry, "brave", brave).search("q", 3)).results
    # Assert
    assert json.loads(tavily.last.content)["api_key"] == KEY and "authorization" not in tavily.last.headers
    assert brave.last.headers["x-subscription-token"] == KEY and brave.last.url.params["count"] == "3"
    assert t_hits[0]["snippet"] == "c" and b_hits[0]["snippet"] == "d"


def test_exa_and_firecrawl_search_and_scrape_parse_their_shapes(registry):
    # Arrange
    exa = Seen(j({"results": [{"title": "e", "url": "https://e", "text": "body"}]}))
    crawl = Seen(j({"data": {"markdown": "# Titre", "metadata": {"title": "T"}}}), j({"data": [{"title": "f", "url": "https://f", "description": "d"}]}))
    adapter = make_adapter(registry, "firecrawl", crawl)
    # Act
    exa_hits = run(make_adapter(registry, "exa", exa).search("q")).results
    page = run(adapter.scrape("https://x")).results[0]
    found = run(adapter.search("q")).results
    # Assert
    assert exa.last.headers["x-api-key"] == KEY and exa_hits[0]["snippet"] == "body"
    assert page["snippet"] == "# Titre" and found[0]["url"] == "https://f" and crawl.requests[0].headers["authorization"] == f"Bearer {KEY}"


def test_registry_only_providers_are_never_routed_and_say_so_when_tested(registry):
    # Arrange
    adapter = make_adapter(registry, "meshy", Seen(j({})))
    # Act / Assert
    assert not adapter.supports("3d")
    with pytest.raises(ProviderError) as raised:
        run(adapter.ping())
    assert raised.value.kind == "unsupported"


def test_openai_compat_embed_extra_fields_from_the_registry_are_sent_to_the_provider(registry):
    # Arrange: NVIDIA NIM embedding models refuse a request without input_type
    seen = Seen(j({"data": [{"index": 0, "embedding": [0.5]}]}))
    adapter = make_adapter(registry, "nim", seen)
    # Act
    run(adapter.embed(["bonjour"]))
    # Assert
    body = json.loads(seen.last.content)
    assert body["input_type"] == "passage" and body["encoding_format"] == "float" and body["model"] == "nvidia/nemotron-3.5-embed-1b"
