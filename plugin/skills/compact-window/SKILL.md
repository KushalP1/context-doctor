---
name: compact-window
description: Compare Claude Code auto-compact window sizes on the user's own recent sessions, and set one if they choose. Use when the user asks about compaction, long or expensive sessions, why sessions get so large, or how to spend fewer tokens automatically (including in the desktop app, where autopilot cannot reach).
---

Run this and show the user its output as it is (it is already formatted):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" compact-window
```

It replays their last 30 days at windows from 200k to 800k and shows input cost, saving and compactions a week for each. Then say in one or two sentences what the trade-off is for them: a smaller window costs less but compacts more often, and each compaction replaces the session's history with a summary.

Do not set a window unless the user picks one. When they do, run (with their size, e.g. `400k`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" compact-window 400k
```

It writes `autoCompactWindow` to `~/.claude/settings.json` and keeps a backup; it applies to sessions started afterwards. `compact-window off` undoes it.
