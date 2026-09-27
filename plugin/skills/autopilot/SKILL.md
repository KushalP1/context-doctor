---
name: autopilot
description: Turn context-doctor's autopilot on, off, or report its status. Autopilot clears stale tool output from every new Claude Code session's requests, only when the prompt cache is cold, so it never costs more. Use when the user asks to enable, disable, pause or check autopilot.
---

Autopilot runs as a small background service, so it needs the globally installed CLI (the plugin's own copy moves on every plugin update, and a service cannot point at it).

1. Check for the global CLI: `context-doctor --version` (or `command -v context-doctor`).
2. If it is missing, ask the user before running: `npm install -g context-doctor`.
3. Then run what the user asked for:
   - on: `context-doctor autopilot on`
   - status: `context-doctor autopilot status`
   - pause (instant passthrough, nothing restarts): `context-doctor autopilot pause`, and `resume`
   - off: `context-doctor autopilot off`
4. Show the output. After `on`, tell the user it applies to Claude Code sessions started from now on, and that `context-doctor savings` shows what it saves.
