---
name: spend
description: Show what the user's AI coding cost across every tool on this machine (Claude Code with its subagents, Codex, Gemini CLI, Cursor), by tool, project, model and day, and set or lift a daily or weekly spend budget. Use when the user asks what they spend, which tool or project costs the most, where their dollars go, or to cap or limit their spending.
---

Run this and show the user its output as it is (it is already formatted), then add one sentence on what drives their bill:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" spend
```

Pass `--days <n>` if the user asked about a different period. Prices are list prices; Cursor's figure is an estimate (its history has no cache split) and replies on Cursor's Auto are counted, not priced. Do not round the numbers up or restate them as an invoice. If subagents are a large share, offer `/context-doctor:fix`, which prices running them on a cheaper model.

To set a budget, only with an amount the user gave:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" budget 50/day
```

`/week` works too. The every-prompt hook then says when the period's spend passes 50%, 80% and 100%. Add `--block` only if the user asked for prompts over the budget to be held. `budget` alone shows where it stands; `budget off` removes it.
