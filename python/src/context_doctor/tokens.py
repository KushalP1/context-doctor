"""Token estimates without a tokenizer, identical to the TypeScript package.

Lengths are counted in UTF-16 code units, as JavaScript counts them, so the
same text gives the same number in both packages (tests/test_parity.py holds
them to it). Claude's ratios were measured from the API's own counts: 2.75
characters per token for prose, 2.4 for code; OpenAI, Google and unknown models
use 4.0 / 3.2.
"""

from __future__ import annotations

import math
import re
from typing import Optional

CHARS_PER_TOKEN = {
    "anthropic": {"prose": 2.75, "code": 2.4},
    "openai": {"prose": 4.0, "code": 3.2},
    "google": {"prose": 4.0, "code": 3.2},
    "generic": {"prose": 4.0, "code": 3.2},
}

_SYMBOLS = re.compile(r"[{}\[\]()<>;:=_/\\|\"'`#$%&*+^~-]")


def js_len(text: str) -> int:
    """Length in UTF-16 code units (JavaScript's String.length)."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def provider_for(model: Optional[str]) -> str:
    if not model:
        return "generic"
    if re.search(r"claude", model, re.I):
        return "anthropic"
    if re.search(r"gpt|^o\d", model, re.I):
        return "openai"
    if re.search(r"gemini", model, re.I):
        return "google"
    return "generic"


def _symbol_density(text: str) -> float:
    n = js_len(text)
    return len(_SYMBOLS.findall(text)) / n if n else 0.0


def is_code_like(text: str) -> bool:
    """True when text is dense with code/JSON symbols and tokenizes more finely."""
    return _symbol_density(text) > 0.08


def chars_per_token_for(text: str, model: Optional[str] = None) -> float:
    ratios = CHARS_PER_TOKEN[provider_for(model)]
    return ratios["code"] if is_code_like(text) else ratios["prose"]


def estimate_tokens(text: str, model: Optional[str] = None) -> int:
    """Estimated tokens for `text`; pass the model when you know it (Claude counts ~40% more)."""
    if not isinstance(text, str):
        text = "" if text is None else str(text)
    if not text:
        return 0
    return math.ceil(js_len(text) / chars_per_token_for(text, model))


def js_round(x: float) -> int:
    """JavaScript's Math.round: halves round up."""
    return math.floor(x + 0.5)


def format_tokens(n: float) -> str:
    if not isinstance(n, (int, float)) or n != n or n in (float("inf"), float("-inf")):
        return "0"
    if n < 0:
        return "-" + format_tokens(-n)
    # Round to what is shown before choosing the unit (999,999.9 is "1.0M", not "1000k").
    r = js_round(n)
    if r < 1_000:
        return str(r)
    tenths_k = js_round(r / 100)
    if tenths_k < 100:
        return f"{tenths_k // 10}.{tenths_k % 10}k"
    k = js_round(r / 1_000)
    if k < 1_000:
        return f"{k}k"
    tenths_m = js_round(r / 100_000)
    if tenths_m < 10_000:
        return f"{tenths_m // 10}.{tenths_m % 10}M"
    tenths_b = js_round(r / 100_000_000)
    return f"{tenths_b // 10}.{tenths_b % 10}B"
