"""Pure Anthropic Messages <-> OpenAI chat translation helpers (spec 06). No gateway state."""
import json
import uuid

ANTHROPIC_ERROR_TYPES = {400: "invalid_request_error", 401: "authentication_error", 403: "permission_error",
                         404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error",
                         503: "overloaded_error", 529: "overloaded_error"}


ANTHROPIC_VERSION = "2023-06-01"  # spec 06 §1.1, the only version this bridge implements


def _system_text(system):
    """Anthropic `system` (string or array of text blocks) as one OpenAI system text. Every block is kept, in
    order; cache_control has no OpenAI equivalent, the stable order keeps the llama-server prefix cache valid."""
    if system is None or isinstance(system, str):
        return system or ""
    if not isinstance(system, list):
        raise ValueError("system doit être une chaîne ou un tableau de blocs")
    parts = []
    for i, block in enumerate(system):
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type", "text") == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
        else:
            raise ValueError(f"system[{i}] : bloc texte attendu ({{'type': 'text', 'text': ...}})")
    return "\n\n".join(parts)


def _block_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _openai_messages(system_prompt, messages):
    """Anthropic messages as OpenAI chat messages the chat templates accept:
    - one system message, first: role "system" entries inside `messages` (Claude Code sends some) are
      appended to it, since templates such as Qwen's reject a system message anywhere else;
    - assistant tool_use blocks become `tool_calls`, user tool_result blocks become role "tool" messages,
      so the model sees its native tool-call format instead of a prose imitation."""
    system_parts = [system_prompt] if system_prompt else []
    out = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content", "")
        if role == "system":
            text = _block_text(content)
            if text:
                system_parts.append(text)
            continue
        if isinstance(content, str):
            out.append({"role": role, "content": content})
            continue
        texts, calls = [], []
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind == "text":
                texts.append(block.get("text", ""))
            elif kind == "tool_use":
                calls.append({"id": block.get("id") or f"toolu_{uuid.uuid4().hex[:12]}", "type": "function", "function": {
                    "name": block.get("name", ""), "arguments": json.dumps(block.get("input", {}), ensure_ascii=False)}})
            elif kind == "tool_result":
                result = _block_text(block.get("content", ""))
                if block.get("is_error"):
                    result = f"Erreur : {result}"
                out.append({"role": "tool", "tool_call_id": block.get("tool_use_id", ""), "content": result})
        if calls:
            out.append({"role": "assistant", "content": "\n".join(texts) or None, "tool_calls": calls})
        elif texts:
            out.append({"role": role, "content": "\n".join(texts)})
    return ([{"role": "system", "content": "\n\n".join(system_parts)}] if system_parts else []) + out


# Spec 07: at most 15 tools offered to a local model; the client's own tools first, MCP tools after.
LOCAL_MAX_TOOLS = 15


def _cap_tools(tools):
    if len(tools) <= LOCAL_MAX_TOOLS:
        return tools
    core = [t for t in tools if not t["function"]["name"].startswith("mcp__")]
    mcp = [t for t in tools if t["function"]["name"].startswith("mcp__")]
    return (core + mcp)[:LOCAL_MAX_TOOLS]


def _anthropic_usage(usage):
    """Anthropic usage from the upstream OpenAI usage: real counts, 0 when the upstream gave none."""
    usage = usage if isinstance(usage, dict) else {}
    return {"input_tokens": int(usage.get("prompt_tokens") or 0), "output_tokens": int(usage.get("completion_tokens") or 0)}


def _anthropic_error(status, raw):
    try:
        err = json.loads(raw).get("error")
        message = err.get("message") if isinstance(err, dict) else str(err or "")
    except (ValueError, AttributeError):
        message = ""
    message = message or raw.decode("utf-8", "ignore")[:500] or f"HTTP {status}"
    return {"type": "error", "error": {"type": ANTHROPIC_ERROR_TYPES.get(status, "api_error"), "message": message}}


def _text_chars(value):
    if isinstance(value, str):
        return len(value)
    if isinstance(value, list):
        return sum(_text_chars(v) for v in value)
    if isinstance(value, dict):
        return sum(len(json.dumps(v)) if k == "input" else _text_chars(v)
                   for k, v in value.items() if k not in ("type", "id", "tool_use_id", "role", "cache_control"))
    return 0
