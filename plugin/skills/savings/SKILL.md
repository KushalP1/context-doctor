---
name: savings
description: Show what context-doctor's levers (compacting at cold resumes, autopilot, an earlier auto-compact window) save, or would have saved, on the user's own recent Claude Code sessions. Use when the user asks how much context-doctor saves, what they spend on input tokens, or whether autopilot is worth turning on.
---

Run this and show the user its output as it is (it is already formatted), then add one sentence on what it means for them:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" savings
```

Pass `--days <n>` if the user asked about a different period. The numbers come from replaying their own transcripts through the shipped autopilot code, priced as the prompt cache bills, against the input their transcripts show they were actually billed. Do not round them up or restate them as guarantees. If the autopilot item says "Turn it on", offer `/context-doctor:autopilot`. If it shows "3. Compact earlier" with "Set it with", offer `/context-doctor:compact-window` to compare sizes; do not set one yourself.
