
def _repair_tool_args(raw: str) -> dict:
    if not raw or not raw.strip():
        return {}
    s = raw.strip()
    try:
        return json.loads(s)
    except Exception:
        pass
    if s.startswith("```"):
        s = re.sub(r"^```[a-z]*\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
        try:
            return json.loads(s)
        except Exception:
            pass
    s_cleaned = re.sub(r",\s*([\]}])", r"\1", s)
    try:
        return json.loads(s_cleaned)
    except Exception:
        pass
    opens = s_cleaned.count("{") - s_cleaned.count("}")
    if opens > 0:
        try:
            return json.loads(s_cleaned + ("}" * opens))
        except Exception:
            pass
    return {}

"""Anthropic Messages API bridge: /v1/messages and /v1/messages/count_tokens.
Gateway state (routing, Bib1, HTTP client) is read from the app module at call time so tests can patch it there."""
import asyncio
import hashlib
import json
import logging
import uuid

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

import app as _app
from anthropic_compat import (
    ANTHROPIC_VERSION, _anthropic_error, _anthropic_usage, _block_text, _cap_tools, _openai_messages,
    _system_text, _text_chars,
)
from core import backends, library

router = APIRouter()


@router.post("/v1/messages/count_tokens")
async def count_tokens_endpoint(request: Request):
    """Accurate token counter for Anthropic clients and context compactor."""
    body = await request.json()
    # Every string of system, messages (tool_result lists and tool_use inputs included) and tools counts.
    # ponytail: 3.0 chars/token (spec 06) over-estimates prose a little; llama-server /tokenize if exactness matters.
    chars = _text_chars(body.get("system", "")) + _text_chars(body.get("messages", [])) + len(json.dumps(body.get("tools", [])))
    tokens = max(1, int(chars / 3.0))
    return JSONResponse({"input_tokens": tokens})


@router.post("/v1/messages")
async def anthropic_messages(request: Request):
    """Native Anthropic Messages API bridge for Claude Desktop and Claude Code CLI.
    Translates Anthropic Messages protocol into MAZZ sovereign backends (Modal 32B or local GGUF)."""
    body = await request.json()
    stream = bool(body.get("stream", False))
    client = _app.http(request)
    # anthropic-beta flags (prompt caching, fine-grained tool streaming) need no switch here: those behaviours are always on.
    version_header = {"anthropic-version": request.headers.get("anthropic-version") or ANTHROPIC_VERSION}

    try:
        system_prompt = _system_text(body.get("system"))
    except ValueError as exc:
        return JSONResponse({"type": "error", "error": {"type": "invalid_request_error", "message": str(exc)}}, status_code=400, headers=version_header)

    rag_count = 0
    try:
        user_msgs = [m for m in body.get("messages", []) if m.get("role") == "user"]
        last_user = _block_text(user_msgs[-1]["content"]) if user_msgs else ""
        rag_context, rag_count = await asyncio.to_thread(_app.get_bib1_rag, last_user, dict(request.headers))
    except Exception:
        rag_context, rag_count = "", 0

    openai_messages = _openai_messages(system_prompt, body.get("messages", []))
    last_user_msg = next((m for m in reversed(openai_messages) if m.get("role") == "user"), None)
    if rag_context and last_user_msg:
        _app._append_to_user(last_user_msg, rag_context)

    openai_body = {
        "model": body.get("model") or "",
        "messages": openai_messages,
        "temperature": body.get("temperature", 0.7),
        "stream": stream
    }
    if "max_tokens" in body:
        openai_body["max_tokens"] = body["max_tokens"]

    if "tools" in body and isinstance(body["tools"], list):
        openai_body["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": t.get("name", ""),
                    "description": t.get("description", ""),
                    "parameters": t.get("input_schema", {})
                }
            }
            for t in body["tools"] if isinstance(t, dict) and "name" in t
        ]

    if "tool_choice" in body:
        tc = body["tool_choice"]
        if isinstance(tc, dict):
            t_type = tc.get("type")
            if t_type == "auto":
                openai_body["tool_choice"] = "auto"
            elif t_type == "any":
                openai_body["tool_choice"] = "required"
            elif t_type == "tool":
                openai_body["tool_choice"] = {"type": "function", "function": {"name": tc.get("name", "")}}
            elif t_type == "none":
                openai_body["tool_choice"] = "none"

    try:
        b, upstream_model, load_path = await _app.resolve_route(client, openai_body["model"])
    except _app.RouteError as exc:
        return JSONResponse({"type": "error", "error": {"type": "invalid_request_error", "message": str(exc)}}, status_code=exc.status, headers={**version_header, **exc.headers})

    # Local cap: a Write of a whole file needs thousands of tokens; when reached, stop_reason says max_tokens
    # so the client knows the tool input is truncated instead of receiving broken JSON as a finished call.
    if b["kind"] == "local":
        openai_body["max_tokens"] = min(openai_body.get("max_tokens", _app.LOCAL_MAX_TOKENS), _app.LOCAL_MAX_TOKENS)
        if "tools" in openai_body:
            openai_body["tools"] = _cap_tools(openai_body["tools"])
    else:
        openai_body["max_tokens"] = min(openai_body.get("max_tokens", 8192), 8192)

    if "tools" in openai_body:
        openai_body["parallel_tool_calls"] = False
    out_headers = {"X-Mazz-Backend": b["id"], "X-Mazz-Bib1": str(rag_count), **version_header}
    session_id = request.headers.get("x-mazz-session") or (body.get("metadata") or {}).get("user_id") or ""
    if session_id:
        out_headers["X-Mazz-Session-Slot"] = str(int(hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:8], 16) % 1)

    try:
        try:
            resp = await _app._send_routed(client, b, upstream_model, openai_body, stream, load_path)
        except (httpx.TransportError, httpx.HTTPStatusError, _app.CircuitOpen) as exc:
            if b["kind"] == "local":
                return JSONResponse({"type": "error", "error": {"type": "api_error", "message": f"llama-server local injoignable : {exc}"}}, status_code=502, headers=version_header)
            local = backends.get("local")
            await backends.probe(client, local, force=True)
            fallback_load = None
            if not local["healthy"]:
                # The default model is loaded under the local slot by _send_routed, never beside a running generation.
                default_entry = library.find_local("Mazz-Technos-Base-4B-Abliterated.Q4_K_M.gguf") or (library.list_local() or [None])[0]
                if not default_entry:
                    return JSONResponse({"type": "error", "error": {"type": "api_error", "message": f"{b['id']} failed and no local model."}}, status_code=502, headers=version_header)
                fallback_load = default_entry["path"]
            out_headers.update({"X-Mazz-Backend": "local", "X-Mazz-Fallback": f"{b['id']}: {type(exc).__name__}"[:120]})
            b = local
            # Local cap applies to the fallback too.
            openai_body["max_tokens"] = min(openai_body.get("max_tokens", _app.LOCAL_MAX_TOKENS), _app.LOCAL_MAX_TOKENS)
            if "tools" in openai_body:
                openai_body["tools"] = _cap_tools(openai_body["tools"])
            resp = await _app._send_routed(client, b, "", openai_body, stream, fallback_load)
    except _app.LocalBusy as exc:
        return JSONResponse({"type": "error", "error": {"type": "overloaded_error", "message": str(exc)}}, status_code=503, headers={"Retry-After": "5", **version_header})
    except _app.RouteError as exc:
        return JSONResponse({"type": "error", "error": {"type": "api_error", "message": str(exc)}}, status_code=exc.status, headers={**version_header, **exc.headers})
    if getattr(resp, "mazz_swap_seconds", 0):
        out_headers["X-Mazz-Swap-Seconds"] = str(resp.mazz_swap_seconds)
    if getattr(resp, "mazz_provider", None):
        out_headers["X-Mazz-Backend"] = f"router/{resp.mazz_provider}"

    msg_id = f"msg_{uuid.uuid4().hex[:20]}"
    model_name = body.get("model") or b.get("id", "mazz-model")

    if not stream or resp.status_code >= 400:
        try:
            raw_content = await resp.aread()
        finally:
            await resp.aclose()
        if resp.status_code >= 400:
            return JSONResponse(_anthropic_error(resp.status_code, raw_content), status_code=resp.status_code, headers=out_headers)
        content_blocks = []
        stop_reason = "end_turn"
        try:
            o_resp = json.loads(raw_content)
            choice = o_resp.get("choices", [{}])[0]
            msg = choice.get("message", {})
            truncated = choice.get("finish_reason") == "length"
            reply_text = msg.get("content", "")
            if reply_text:
                content_blocks.append({"type": "text", "text": reply_text})
            tool_calls = msg.get("tool_calls", [])
            if tool_calls:
                stop_reason = "tool_use"
                for tc in tool_calls:
                    fn = tc.get("function", {})
                    args = _repair_tool_args(fn.get("arguments", "{}"))
                    content_blocks.append({
                        "type": "tool_use",
                        "id": tc.get("id") or f"toolu_{uuid.uuid4().hex[:12]}",
                        "name": fn.get("name", ""),
                        "input": args
                    })
            if not content_blocks:
                content_blocks.append({"type": "text", "text": reply_text or ""})
            if truncated:
                stop_reason = "max_tokens"
            usage = o_resp.get("usage")
        except Exception:
            content_blocks = [{"type": "text", "text": raw_content.decode("utf-8", "ignore")}]
            usage = {}

        anthropic_resp = {
            "id": msg_id,
            "type": "message",
            "role": "assistant",
            "content": content_blocks,
            "model": model_name,
            "stop_reason": stop_reason,
            "stop_sequence": None,
            "usage": _anthropic_usage(usage),
        }
        return JSONResponse(anthropic_resp, headers=out_headers)

    async def sse_relay():
        try:
            async for event in _app._until_disconnect(request, _sse_events()):
                yield event
        finally:
            await resp.aclose()  # idempotent; frees the local slot even if the background task never runs

    async def _sse_events():
        yield f"event: message_start\ndata: {json.dumps({'type': 'message_start', 'message': {'id': msg_id, 'type': 'message', 'role': 'assistant', 'content': [], 'model': model_name, 'stop_reason': None, 'stop_sequence': None, 'usage': _anthropic_usage(None)}})}\n\n".encode("utf-8")
        
        block_index = 0
        text_block_active = False
        tool_block_active = False
        saw_tool_use = False
        finish_reason = None
        current_tool_id = ""
        current_tool_name = ""
        # OpenAI streams send usage in a last chunk (choices: []), after message_start: it is reported in message_delta.
        usage = None

        lines = resp.aiter_lines()
        while True:
            try:
                line = await lines.__anext__()
            except StopAsyncIteration:
                break
            except httpx.HTTPError as exc:
                err = {"type": "error", "error": {"type": "api_error", "message": f"flux amont interrompu : {exc}"}}
                yield f"event: error\ndata: {json.dumps(err)}\n\n".encode("utf-8")
                return
            line = line.strip()
            if not line or not line.startswith("data:"):
                continue
            payload_str = line[5:].strip()
            if payload_str == "[DONE]":
                break
            try:
                chunk = json.loads(payload_str)
                usage = chunk.get("usage") or usage
                choice = (chunk.get("choices") or [{}])[0]
                finish_reason = choice.get("finish_reason") or finish_reason
                delta = choice.get("delta") or {}
                token = delta.get("content", "")
                tool_calls = delta.get("tool_calls", [])

                if token:
                    if not text_block_active and not tool_block_active:
                        yield f"event: content_block_start\ndata: {json.dumps({'type': 'content_block_start', 'index': block_index, 'content_block': {'type': 'text', 'text': ''}})}\n\n".encode("utf-8")
                        text_block_active = True
                    ev = {
                        "type": "content_block_delta",
                        "index": block_index,
                        "delta": {"type": "text_delta", "text": token}
                    }
                    yield f"event: content_block_delta\ndata: {json.dumps(ev)}\n\n".encode("utf-8")

                if tool_calls:
                    saw_tool_use = True
                    for tc in tool_calls:
                        fn = tc.get("function", {})
                        fn_name = fn.get("name", "")
                        fn_args = fn.get("arguments", "")
                        tc_id = tc.get("id") or f"toolu_{uuid.uuid4().hex[:12]}"

                        if fn_name:
                            if text_block_active:
                                yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': block_index})}\n\n".encode("utf-8")
                                text_block_active = False
                                block_index += 1
                            elif tool_block_active:
                                yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': block_index})}\n\n".encode("utf-8")
                                block_index += 1

                            current_tool_id = tc_id
                            current_tool_name = fn_name
                            tool_block_active = True
                            tool_start = {
                                "type": "content_block_start",
                                "index": block_index,
                                "content_block": {
                                    "type": "tool_use",
                                    "id": current_tool_id,
                                    "name": current_tool_name,
                                    "input": {}
                                }
                            }
                            yield f"event: content_block_start\ndata: {json.dumps(tool_start)}\n\n".encode("utf-8")

                        if fn_args:
                            if not tool_block_active:
                                if text_block_active:
                                    yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': block_index})}\n\n".encode("utf-8")
                                    text_block_active = False
                                    block_index += 1
                                tool_block_active = True
                                current_tool_id = tc_id
                                current_tool_name = fn_name or "tool"
                                yield f"event: content_block_start\ndata: {json.dumps({'type': 'content_block_start', 'index': block_index, 'content_block': {'type': 'tool_use', 'id': current_tool_id, 'name': current_tool_name, 'input': {}}})}\n\n".encode("utf-8")

                            tool_delta = {
                                "type": "content_block_delta",
                                "index": block_index,
                                "delta": {
                                    "type": "input_json_delta",
                                    "partial_json": fn_args
                                }
                            }
                            yield f"event: content_block_delta\ndata: {json.dumps(tool_delta)}\n\n".encode("utf-8")
            except Exception as exc:  # a malformed upstream chunk must not kill the stream: skip it, keep a trace
                logging.getLogger(__name__).warning("chunk amont ignore : %s", type(exc).__name__)

        if text_block_active or tool_block_active:
            yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': block_index})}\n\n".encode("utf-8")

        final_stop_reason = "max_tokens" if finish_reason == "length" else "tool_use" if saw_tool_use else "end_turn"
        yield f"event: message_delta\ndata: {json.dumps({'type': 'message_delta', 'delta': {'stop_reason': final_stop_reason, 'stop_sequence': None}, 'usage': _anthropic_usage(usage)})}\n\n".encode("utf-8")
        yield f"event: message_stop\ndata: {json.dumps({'type': 'message_stop'})}\n\n".encode("utf-8")

    async def on_finish():
        await resp.aclose()

    return StreamingResponse(
        sse_relay(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", **out_headers},
        background=BackgroundTask(on_finish)
    )
