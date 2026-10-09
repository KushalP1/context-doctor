---
name: overhead
description: Measure what every request re-reads before the user's message (system prompt, tools, MCP schemas, CLAUDE.md, rules, auto memory) and price each memory file per month; offer to split a heavy one. Use when the user asks why sessions start large, what CLAUDE.md or MCP servers cost, or how to trim memory files.
---

Run this and show the user its output as it is (it is already formatted):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" overhead --mcp
```

`--mcp` launches each configured MCP server once to size its tool definitions; drop it if the user does not want their servers started. Then say in one or two sentences which item costs the most and what to do about it.

If a memory file is flagged as large, offer to split it. Show the plan first, which changes nothing:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" overhead split <file>
```

Only when the user agrees, add `--write`: it moves the large sections word for word to `<name>.reference.md`, leaves a pointer to each, and backs up the original first.
