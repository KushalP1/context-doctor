---
name: pack
description: Answer a question from a large document, log, PDF or folder by reading only the chunks it needs, within a token budget. Use when the user asks about a big file or folder you would otherwise read whole, and you are not going to edit it.
---

Prefer the `pack_context` MCP tool when it is available. Otherwise run, with the user's question and paths:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" pack <files or folders> --query "<the question>" --max-tokens 4000
```

It returns the best-matching chunks, each with an id and line range, and names the next-best ids. Answer from those chunks. If they are not enough, fetch more by id (`--ids a.md#4,a.md#5`) or ask with different words; without `--query` it prints an outline to choose from. Add `--semantic` to also rank by meaning when the user runs Ollama with an embedding model.
