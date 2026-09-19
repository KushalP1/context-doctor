# context-doctor for VS Code and Cursor

Live Claude Code context health in the editor's status bar:

```
⌁ ctx 801k · 80% · cache 98% ⚠
```

It reads the newest Claude Code transcript for the open workspace folder (from `~/.claude/projects/`), and shows the live context size, its share of the model's window, and the share served from prompt cache. The item turns to the warning colour past 70% (configurable). Clicking it opens a terminal running `npx -y context-doctor session` on that transcript for the full profile.

Nothing leaves the machine and nothing is installed globally; the extension only reads files Claude Code already writes. If the folder has no Claude Code session yet, the item says so instead of guessing.

Settings: `contextDoctor.refreshSeconds` (default 5), `contextDoctor.warnAtPercent` (default 70).

Part of [context-doctor](https://github.com/KushalP1/context-doctor) (MIT).
