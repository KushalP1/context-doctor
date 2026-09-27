---
name: checkup
description: Profile this Claude Code session's context with context-doctor and apply the top fix. Use when the user asks what is eating the context, why the session is slow or expensive, or for a context checkup.
---

Run this for the current session's measured context, cost per message and findings:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" session
```

Report the total, the share of the window, and the top three findings in under 120 words. If the top finding is recoverable (a large stale tool result, a repeated file read), act on it: summarize the content into the points still needed and say what you dropped. Offer `/compact` if the session is past about 60% of its window.
