---
name: fix
description: Rank every way to spend fewer tokens by what it would have saved on the user's own Claude Code sessions, and apply the ones the user chooses (reversibly). Use when the user asks how to cut their Claude Code bill or usage, what to change, to "fix" their token waste, or to undo a change context-doctor made.
---

Run this and show the user its output as it is (it is already formatted):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" fix
```

It replays their last 30 days and lists the fixes that pay, largest saving first, each with how it was measured, what it costs in quality and what it writes. Run here, it only prints the plan: nothing is changed.

Then ask which ones they want. Apply only the ones the user names, by the id shown in brackets on each fix's `changes:` line (comma-separated):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" fix --apply cache-ttl,compact-window
```

Never pass `--apply all` unless the user asked for all of them. New sessions pick the changes up. To revert everything `fix` applied (or one fix, by id):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" fix undo
```

Running `fix` again later also shows what each applied fix saved since.
