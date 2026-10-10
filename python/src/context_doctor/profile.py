"""Where a conversation's tokens go, for OpenAI- and Anthropic-format message lists.

A small subset of the TypeScript profiler: the breakdown by category and the
three findings that recover the most (oversized tool results, duplicated
content, inline base64). For the full profile, `npx context-doctor analyze`.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .tokens import estimate_tokens, format_tokens

MESSAGE_OVERHEAD_TOKENS = 4
_BASE64 = re.compile(r"[A-Za-z0-9+/]{400,}={0,2}")


@dataclass
class Finding:
    id: str
    message: str
    suggestion: str
    est_savings: int


@dataclass
class Profile:
    total_tokens: int
    by_category: Dict[str, int]
    findings: List[Finding] = field(default_factory=list)
    model: Optional[str] = None

    def render(self) -> str:
        lines = [f"~{format_tokens(self.total_tokens)} tokens" + (f" ({self.model})" if self.model else "")]
        for cat, n in sorted(self.by_category.items(), key=lambda kv: -kv[1]):
            if n:
                pct = round(100 * n / self.total_tokens) if self.total_tokens else 0
                lines.append(f"  {cat:<18} ~{format_tokens(n):>6}  {pct}%")
        for f in self.findings:
            lines.append(f"- {f.message} [save ~{format_tokens(f.est_savings)}] → {f.suggestion}")
        return "\n".join(lines)


def _text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, str):
                parts.append(b)
            elif isinstance(b, dict):
                if isinstance(b.get("text"), str):
                    parts.append(b["text"])
                elif "content" in b:
                    parts.append(_text(b["content"]))
                elif b.get("type") in ("tool_use", "function_call"):
                    parts.append(json.dumps(b.get("input", b.get("arguments", {}))))
        return "\n".join(parts)
    return json.dumps(content)


def _items(messages: List[dict], system: Any):
    """(category, text) for every block: system, user, assistant, tool_call, tool_result."""
    if system:
        yield "system", _text(system)
    for m in messages:
        role = m.get("role")
        c = m.get("content")
        if role in ("system", "developer"):
            yield "system", _text(c)
        elif role == "tool":
            yield "tool_result", _text(c)
        elif isinstance(c, list):
            for b in c:
                t = b.get("type") if isinstance(b, dict) else None
                if t == "tool_result":
                    yield "tool_result", _text(b.get("content"))
                elif t == "tool_use":
                    yield "tool_call", json.dumps(b.get("input", {}))
                else:
                    yield ("assistant" if role == "assistant" else "user"), _text([b])
        else:
            yield ("assistant" if role == "assistant" else "user"), _text(c)
        for call in m.get("tool_calls") or []:
            yield "tool_call", json.dumps(call.get("function", call))


def profile_messages(conversation: Any, model: Optional[str] = None, large_tool_result: int = 2000) -> Profile:
    """Profile `[{role, content}, ...]` or `{"system", "messages"}` (Anthropic) or `{"messages"}` (OpenAI)."""
    if isinstance(conversation, str):
        conversation = json.loads(conversation)
    if isinstance(conversation, dict):
        messages, system = conversation.get("messages", []), conversation.get("system")
        model = model or conversation.get("model")
    else:
        messages, system = list(conversation), None
    by_cat: Dict[str, int] = {}
    findings: List[Finding] = []
    seen: Dict[str, int] = {}
    total = 0
    for i, (cat, text) in enumerate(_items(messages, system)):
        n = estimate_tokens(text, model) + MESSAGE_OVERHEAD_TOKENS
        by_cat[cat] = by_cat.get(cat, 0) + n
        total += n
        if cat == "tool_result" and n > large_tool_result:
            findings.append(Finding("large_tool_result", f"A tool result is ~{format_tokens(n)} tokens.", "Keep only the fields the model used; summarize the rest.", n - 300))
        b64 = sum(len(m.group(0)) for m in _BASE64.finditer(text))
        if b64:
            saved = estimate_tokens("x" * b64, model)
            findings.append(Finding("base64_blob", f"Inline base64 (~{format_tokens(saved)} tokens).", "Send files and images through the provider's file or image API.", saved))
        if len(text) >= 400:
            h = hashlib.sha1(text.strip().encode()).hexdigest()
            if h in seen:
                findings.append(Finding("duplicate_content", f"Content repeated (~{format_tokens(n)} tokens).", "Refer to the first copy instead of repeating it.", n))
            seen[h] = i
    findings.sort(key=lambda f: -f.est_savings)
    return Profile(total_tokens=total, by_category=by_cat, findings=findings, model=model)
