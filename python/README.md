# context-doctor (Python)

**Put only the parts of your documents that a question needs into the prompt, within a token budget.** No dependencies, no API key, no embeddings required.

The Python port of [`context-doctor`](https://github.com/KushalP1/context-doctor)'s `pack`: the same chunking, ranking and output as `npx context-doctor pack`, checked by parity tests against the TypeScript package.

```bash
pip install context-doctor
```

## Trim retrieved documents to a budget (LangChain, LlamaIndex, plain text)

A retriever that returns 40 chunks and 30k tokens sends all of them on every call. `pack_documents` re-chunks them along their structure, ranks the chunks against the question (BM25) and keeps the best that fit:

```python
from context_doctor import pack_documents

docs = retriever.invoke(question)                     # LangChain Documents, LlamaIndex nodes, or strings
packed = pack_documents(docs, question, budget=4000)  # tokens, counted with Claude's ratios (the most conservative)

prompt = f"Answer from this context:\n\n{packed.render()}\n\nQuestion: {question}"
print(packed.packed_tokens, "of", packed.total_tokens)
```

`render()` lists each chunk with an id and line range (`handbook.md#4 · L120-138`), then names the next-best ids, so an agent can ask for more with `pack_documents(docs, ids=[...])`.

## Pack files directly

```python
from context_doctor import pack_context, PackSource

r = pack_context([PackSource("manual.md", open("manual.md").read())], query="how do I rotate the signing key", budget=3000)
for chunk in r.selected:
    print(chunk.id, chunk.start_line, chunk.end_line, chunk.heading, chunk.tokens)
```

Without a `query` you get an outline (`r.render()`), one line per chunk, to pick from by id.

```bash
python -m context_doctor pack docs/ README.md -q "how do I rotate the signing key" --max-tokens 3000
```

## Where a conversation's tokens go

```python
from context_doctor import profile_messages

p = profile_messages({"model": "claude-sonnet-5", "system": "...", "messages": messages})
print(p.render())   # breakdown by system / user / assistant / tool calls / tool results, plus the biggest waste
```

This is a subset of the npm package's profiler (oversized tool results, duplicated content, inline base64). For the full profile, the every-prompt hook, autopilot and the MCP server, use the npm package: `npx context-doctor`.

## Token estimates

`estimate_tokens(text, model)` uses ratios measured from the APIs' own counts: Claude 2.75 characters per token for prose and 2.4 for code; OpenAI, Gemini and others 4.0 / 3.2. Pass the model: Claude counts about 40% more tokens than the usual 4-characters rule.

MIT licensed. Built by [gAI Ventures](https://gai.ventures).
