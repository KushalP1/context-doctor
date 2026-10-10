"""Use pack with the document objects RAG frameworks already return.

Duck-typed, so neither LangChain nor LlamaIndex is a dependency:
  - LangChain `Document`: `.page_content`, `.metadata["source"]`
  - LlamaIndex `Document` / `TextNode` / `NodeWithScore`: `.get_content()` or `.text`, `.metadata` (file_name, file_path), `.node`
  - plain strings, `(name, text)` tuples, `{"name", "text"}` dicts

    docs = retriever.invoke(question)          # 40 chunks, 30k tokens
    packed = pack_documents(docs, question, budget=4000)
    prompt = packed.render()                   # the best ~4k tokens, with ids and line ranges
"""

from __future__ import annotations

from typing import Iterable, Optional

from .pack import PackResult, PackSource, pack_context


def _to_source(doc, i: int) -> PackSource:
    if isinstance(doc, PackSource):
        return doc
    if isinstance(doc, str):
        return PackSource(f"doc{i + 1}", doc)
    if isinstance(doc, tuple) and len(doc) == 2:
        return PackSource(str(doc[0]), str(doc[1]))
    if isinstance(doc, dict) and "text" in doc:
        return PackSource(str(doc.get("name", f"doc{i + 1}")), str(doc["text"]))
    node = getattr(doc, "node", None)  # LlamaIndex NodeWithScore wraps a node
    if node is not None and not hasattr(doc, "page_content"):
        doc = node
    if hasattr(doc, "page_content"):
        text = doc.page_content
    elif callable(getattr(doc, "get_content", None)):
        text = doc.get_content()
    elif hasattr(doc, "text"):
        text = doc.text
    else:
        raise TypeError(f"cannot read text from {type(doc).__name__}")
    meta = getattr(doc, "metadata", None) or {}
    name = meta.get("source") or meta.get("file_path") or meta.get("file_name") or getattr(doc, "id_", None) or f"doc{i + 1}"
    return PackSource(str(name), str(text))


def pack_documents(
    docs: Iterable,
    query: Optional[str] = None,
    budget: Optional[int] = None,
    max_chunk_tokens: Optional[int] = None,
    model: Optional[str] = None,
) -> PackResult:
    """Rank and trim retrieved documents (LangChain, LlamaIndex, strings) to a token budget.

    Documents with the same source name are numbered apart, so chunk ids stay unique.
    """
    sources = [_to_source(d, i) for i, d in enumerate(docs)]
    seen: dict = {}
    for s in sources:
        n = seen.get(s.name, 0)
        seen[s.name] = n + 1
        if n:
            s.name = f"{s.name}~{n + 1}"
    return pack_context(sources, query=query, budget=budget, max_chunk_tokens=max_chunk_tokens, model=model)
