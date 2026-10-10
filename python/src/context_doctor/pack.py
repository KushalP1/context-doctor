"""Pack: put only the parts of a document that matter into the context.

A port of the TypeScript `pack` (same chunking, same BM25, same budget rules,
same output), so a RAG pipeline in Python gets exactly what `npx context-doctor
pack` gives. Files are split along their own structure (markdown headings,
top-level code declarations, paragraphs), ranked against a question and the
best chunks that fit a token budget are returned, each with an id and a line
range. No embeddings, no model calls, no dependencies.
"""

from __future__ import annotations

import math
import posixpath
import re
from dataclasses import dataclass, field
from typing import Iterable, List, Optional, Sequence

from .tokens import estimate_tokens, format_tokens, js_len, js_round

DEFAULT_BUDGET = 4000
DEFAULT_CHUNK_TOKENS = 400
DEFAULT_MODEL = "claude"

CODE_EXT = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h",
    ".cc", ".cpp", ".hpp", ".cs", ".php", ".scala", ".sh", ".bash", ".zsh", ".sql", ".lua", ".dart", ".vue", ".svelte",
}
MARKDOWN_EXT = {".md", ".mdx", ".markdown", ".rst", ".adoc"}

# JavaScript's whitespace (String.prototype.trim and \s), which differs from Python's in a few control characters.
_WS_CHARS = "\t\n\v\f\r                  　﻿"
_WS = "[" + re.escape(_WS_CHARS) + "]"

_CODE_BOUNDARY = re.compile(r"(?!" + _WS + r"|[})\]]|$)")
_COMMENT_LINE = re.compile(r"^(/\*\*?|\*/?|//|#(?!include|define|!)|\"\"\"|'''|--|@[A-Za-z0-9_]+)")
_FENCE = re.compile(r"^" + _WS + r"*(```|~~~)")
_HEADING = re.compile(r"^(#{1,6})" + _WS + r"+(.+?)" + _WS + r"*#*" + _WS + r"*$")
_MD_SNIFF = re.compile(r"^#{1,6}" + _WS + r"+[^" + re.escape(_WS_CHARS) + r"]", re.M)

STOPWORDS = set(
    (
        "a an and are as at be but by can do does for from has have how i if in into is it its of on or our so that the their "
        "them then there these they this to was we were what when where which who why will with you your about should would could "
        "not no yes all any my me get set use using used"
    ).split(" ")
)


def _trim(s: str) -> str:
    return s.strip(_WS_CHARS)


def _units16(s: str) -> List[int]:
    b = s.encode("utf-16-le", "surrogatepass")
    return [b[i] | (b[i + 1] << 8) for i in range(0, len(b), 2)]


def _from16(u: Sequence[int]) -> str:
    return b"".join(x.to_bytes(2, "little") for x in u).decode("utf-16-le", "surrogatepass")


def _slice16(s: str, start: int, end: Optional[int] = None) -> str:
    """String.prototype.slice in UTF-16 units (only differs from Python slicing for astral characters)."""
    if all(ord(c) < 0x10000 for c in s):
        return s[start:end]
    return _from16(_units16(s)[start:end])


@dataclass
class PackSource:
    name: str
    text: str


@dataclass(eq=False)
class Chunk:
    id: str
    source: str
    start_line: int
    end_line: int
    heading: str
    text: str
    tokens: int
    score: float = 0.0


@dataclass
class PackResult:
    mode: str
    query: Optional[str]
    budget: int
    total_tokens: int
    packed_tokens: int
    selected: List[Chunk]
    chunks: List[Chunk]
    missing_ids: List[str]
    sources: List[dict] = field(default_factory=list)

    def render(self, outline_limit: int = 60) -> str:
        return render_pack(self, outline_limit)

    def __str__(self) -> str:
        return self.render()


def _kind_of(name: str, text: str) -> str:
    ext = posixpath.splitext(posixpath.basename(name.replace("\\", "/")))[1].lower()
    if ext in MARKDOWN_EXT:
        return "markdown"
    if ext in CODE_EXT:
        return "code"
    if _MD_SNIFF.search(text) and not text.startswith("#!"):
        return "markdown"
    return "prose"


def _units(lines: List[str], kind: str) -> List[dict]:
    out: List[dict] = []
    path: List[Optional[str]] = []
    st = {"heading": "", "start": 0, "hard": False}

    def close(end: int, next_hard: bool) -> None:
        if end > st["start"] and any(_trim(l) for l in lines[st["start"]:end]):
            out.append({"start": st["start"], "end": end, "heading": st["heading"], "hard": st["hard"]})
        st["start"] = end
        st["hard"] = next_hard

    in_fence = False
    for i, line in enumerate(lines):
        if kind == "markdown":
            if _FENCE.match(line):
                in_fence = not in_fence
            h = None if in_fence else _HEADING.match(line)
            if h:
                close(i, True)
                level = len(h.group(1))
                del path[level - 1:]
                while len(path) < level - 1:
                    path.append(None)
                path.append(h.group(2))
                st["heading"] = " > ".join(p for p in path if p)
                continue
            if not in_fence and not _trim(line) and i + 1 < len(lines) and _trim(lines[i + 1]):
                close(i + 1, False)
        elif kind == "code":
            if i > 0 and not _trim(lines[i - 1]) and _trim(line) and _CODE_BOUNDARY.match(line):
                close(i, False)
        elif not _trim(line) and i + 1 < len(lines) and _trim(lines[i + 1]):
            close(i + 1, False)
    close(len(lines), False)
    if kind != "markdown":
        for u in out:
            body = [t for t in (_trim(l) for l in lines[u["start"]:u["end"]]) if t]
            prose = next((p for p in (_trim(_COMMENT_LINE.sub("", l, count=1)) for l in body) if p), "")
            decl = next((l for l in body if not _COMMENT_LINE.match(l)), "")
            label = ((decl or prose) if kind == "code" else "") or (body[0] if body else "")
            u["heading"] = _slice16(label, 0, 80)
    return out


def chunk_source(source: PackSource, max_chunk_tokens: Optional[int] = None, model: Optional[str] = None) -> List[Chunk]:
    """Split one source into chunks of at most `max_chunk_tokens`, along its own structure."""
    max_tokens = max(50, max_chunk_tokens if max_chunk_tokens is not None else DEFAULT_CHUNK_TOKENS)
    model = model or DEFAULT_MODEL
    kind = _kind_of(source.name, source.text)
    lines: List[str] = []
    line_no: List[int] = []
    max_chars = math.floor(max_tokens * 2.4)
    for n, line in enumerate(re.sub(r"\r\n?", "\n", source.text).split("\n")):
        if js_len(line) > max_chars:
            u = _units16(line)
            while len(u) > max_chars:
                cut = max((k for k in range(min(max_chars, len(u) - 1), -1, -1) if u[k] == 0x20), default=-1)
                at = cut + 1 if cut > max_chars / 2 else max_chars
                lines.append(_from16(u[:at]))
                line_no.append(n + 1)
                u = u[at:]
            line = _from16(u)
        lines.append(line)
        line_no.append(n + 1)

    prefix = [0]
    for l in lines:
        prefix.append(prefix[-1] + estimate_tokens(l + "\n", model))

    def tok(a: int, b: int) -> int:
        return prefix[b] - prefix[a]

    pieces: List[dict] = []
    for u in _units(lines, kind):
        if tok(u["start"], u["end"]) <= max_tokens:
            pieces.append(u)
            continue
        s = u["start"]
        for i in range(u["start"] + 1, u["end"] + 1):
            if i == u["end"] or tok(s, i + 1) > max_tokens:
                first = s == u["start"]
                pieces.append({"start": s, "end": i, "heading": u["heading"] if first else f"{u['heading']} (cont.)", "hard": first and u["hard"]})
                s = i

    merged: List[dict] = []
    for p in pieces:
        last = merged[-1] if merged else None
        if last and not p["hard"] and last["heading"] == p["heading"] and tok(last["start"], p["end"]) <= max_tokens:
            last["end"] = p["end"]
        elif last and not p["hard"] and kind != "markdown" and tok(last["start"], p["end"]) <= max_tokens:
            last["end"] = p["end"]
        else:
            merged.append(dict(p))

    chunks: List[Chunk] = []
    for n, u in enumerate(merged):
        a, b = u["start"], u["end"]
        while a < b and not _trim(lines[a]):
            a += 1
        while b > a and not _trim(lines[b - 1]):
            b -= 1
        text = "\n".join(lines[a:b])
        chunks.append(Chunk(
            id=f"{source.name}#{n + 1}",
            source=source.name,
            start_line=line_no[a] if a < len(line_no) else a + 1,
            end_line=line_no[b - 1] if 0 <= b - 1 < len(line_no) else b,
            heading=u["heading"],
            text=text,
            tokens=estimate_tokens(text, model),
        ))
    return chunks


def terms(text: str) -> List[str]:
    """Lowercased terms: camelCase and snake_case split, stopwords dropped, plural -s folded."""
    out: List[str] = []
    for w in re.split(r"[\W_]+", re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text).lower()):
        if js_len(w) < 2 or w in STOPWORDS:
            continue
        if js_len(w) > 4 and w.endswith("ies"):
            w = w[:-3] + "y"
        elif js_len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        out.append(w)
    return out


def score_chunks(chunks: List[Chunk], query: str) -> None:
    """BM25 (k1 1.2, b 0.75); heading terms count twice."""
    q = list(dict.fromkeys(terms(query)))
    if not q or not chunks:
        return
    docs = []
    for c in chunks:
        t = terms(c.text) + terms(c.heading) + terms(c.heading)
        tf: dict = {}
        for w in t:
            tf[w] = tf.get(w, 0) + 1
        docs.append((len(t), tf))
    avg = (sum(d[0] for d in docs) / len(docs)) or 1
    n = len(docs)
    for term in q:
        df = sum(1 for d in docs if term in d[1])
        if df == 0:
            continue
        idf = math.log(1 + (n - df + 0.5) / (df + 0.5))
        for i, (length, tf) in enumerate(docs):
            f = tf.get(term, 0)
            if f:
                chunks[i].score += idf * ((f * 2.2) / (f + 1.2 * (1 - 0.75 + (0.75 * length) / avg)))


def _as_sources(sources: Iterable) -> List[PackSource]:
    out: List[PackSource] = []
    for i, s in enumerate(sources):
        if isinstance(s, PackSource):
            out.append(s)
        elif isinstance(s, str):
            out.append(PackSource(name=f"doc{i + 1}", text=s))
        elif isinstance(s, tuple) and len(s) == 2:
            out.append(PackSource(name=str(s[0]), text=str(s[1])))
        elif isinstance(s, dict):
            out.append(PackSource(name=str(s.get("name", f"doc{i + 1}")), text=str(s.get("text", ""))))
        else:
            raise TypeError(f"pack sources are PackSource, str, (name, text) or {{'name', 'text'}}; got {type(s).__name__}")
    return out


def pack_context(
    sources: Iterable,
    query: Optional[str] = None,
    budget: Optional[int] = None,
    ids: Optional[Sequence[str]] = None,
    max_chunk_tokens: Optional[int] = None,
    model: Optional[str] = None,
) -> PackResult:
    """Chunk, rank and select. `sources`: PackSource, str, (name, text) or {'name', 'text'}."""
    srcs = _as_sources(sources)
    per_source = [chunk_source(s, max_chunk_tokens, model) for s in srcs]
    chunks = [c for cs in per_source for c in cs]
    q = (query or "").strip(_WS_CHARS) or None
    if q:
        score_chunks(chunks, q)
    budget = max(1, budget if budget is not None else DEFAULT_BUDGET)
    pick: List[Chunk] = []
    picked = set()
    missing: List[str] = []
    used = 0

    def take(c: Chunk) -> None:
        nonlocal used
        if id(c) in picked or used + c.tokens > budget:
            return
        pick.append(c)
        picked.add(id(c))
        used += c.tokens

    mode = "outline"
    if ids:
        mode = "ids"
        by_id = {}
        for c in chunks:
            by_id[c.id] = c
        for i in ids:
            if i in by_id:
                take(by_id[i])
            else:
                missing.append(i)
    if q:
        if mode == "outline":
            mode = "query"
        for c in sorted((c for c in chunks if c.score > 0), key=lambda c: -c.score):
            take(c)
    order = {id(c): i for i, c in enumerate(chunks)}
    pick.sort(key=lambda c: order[id(c)])
    return PackResult(
        mode=mode,
        query=q,
        budget=budget,
        total_tokens=sum(c.tokens for c in chunks),
        packed_tokens=used,
        selected=pick,
        chunks=chunks,
        missing_ids=missing,
        sources=[
            {"name": s.name, "tokens": sum(c.tokens for c in cs), "chunks": len(cs), "selected": sum(1 for c in cs if id(c) in picked)}
            for s, cs in zip(srcs, per_source)
        ],
    )


def _outline(chunks: List[Chunk], limit: int) -> List[str]:
    shown = [f"  {c.id}  L{c.start_line}-{c.end_line}  ~{format_tokens(c.tokens)}  {c.heading}" for c in chunks[:limit]]
    if len(chunks) > limit:
        shown.append(f"  … {len(chunks) - limit} more")
    return shown


def render_pack(r: PackResult, outline_limit: int = 60) -> str:
    """Plain-text rendering for a model or a terminal, identical to the TypeScript package."""
    out: List[str] = []
    pct = js_round((r.packed_tokens / r.total_tokens) * 100) if r.total_tokens > 0 else 0
    names = r.sources[0]["name"] if len(r.sources) == 1 else f"{len(r.sources)} files"
    if r.mode == "outline":
        out.append(f"OUTLINE of {names}: ~{format_tokens(r.total_tokens)} tokens in {len(r.chunks)} chunks. Nothing packed: pass a query, or chunk ids from this list.")
        out.extend(_outline(r.chunks, outline_limit))
        return "\n".join(out)
    out.append(
        f"PACKED ~{format_tokens(r.packed_tokens)} of ~{format_tokens(r.total_tokens)} tokens ({pct}%) from {names}: "
        f"{len(r.selected)} of {len(r.chunks)} chunks" + (f' for "{r.query}"' if r.query else "") + f", budget {format_tokens(r.budget)}."
    )
    if r.missing_ids:
        out.append(f"Unknown ids: {', '.join(r.missing_ids)}.")
    if not r.selected:
        out.append("No chunk matched. Choose from the outline by id, or rephrase with words the document would use.")
        out.extend(_outline(r.chunks, outline_limit))
        return "\n".join(out)
    for c in r.selected:
        out.extend(["", f"── {c.id} · L{c.start_line}-{c.end_line}{f' · {c.heading}' if c.heading else ''} · ~{format_tokens(c.tokens)}", c.text])
    left = len(r.chunks) - len(r.selected)
    if left > 0:
        chosen = {id(c) for c in r.selected}
        nxt = sorted((c for c in r.chunks if c.score > 0 and id(c) not in chosen), key=lambda c: -c.score)[:5]
        out.extend(["", f"Not included: {left} chunk(s). " + (
            "Next best: " + "; ".join(f"{c.id} ({c.heading or f'L{c.start_line}'})" for c in nxt) + "." if nxt else "Ask for the outline to see them."
        )])
    return "\n".join(out)
