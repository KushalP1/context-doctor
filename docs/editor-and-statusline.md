# Context health in the editor and the status bar

[← README](../README.md)

## The same number inside VS Code and Cursor

An extension in [`vscode/`](../vscode/) puts context health in the editor's own status bar:

```
⌁ ctx 848k · 85% · cache 100% ⚠
```

It reads the newest Claude Code transcript for the open workspace folder, shows live context, share of window and cache share, turns to the warning colour past 70% (configurable), and opens a terminal running `context-doctor session` when clicked. Nothing leaves the machine; it only reads files Claude Code already writes. Until it is on the marketplace, build and install it locally:

```bash
cd vscode && npm ci && npm run package
code --install-extension context-doctor-vscode-0.2.1.vsix     # or: cursor --install-extension …
```

## Context health in Claude Code's status bar

```bash
context-doctor install --statusline
```

Claude Code shows the first line a `statusLine` command prints, on every refresh, while you type. With this on, that line is the number that matters:

```
ctx 801k/1.0M ▮▮▮▮▮▮▮▮░░ 80% ⚠ · cache 100% · $12.34
```

Live context against the model's window, a warning mark from 70%, the share served from cache, and the session's cost. It reads the size from the status payload when Claude Code provides it, and otherwise from the last 256KB of the transcript (about 1ms on a 20MB file; 80ms end to end including Node startup). It is opt-in and polite: there is only one status line, so it never overwrites one you already have, and `uninstall` removes only its own. Any failure prints nothing rather than an error.
