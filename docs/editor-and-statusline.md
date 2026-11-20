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

Live context against the model's window, a warning mark from 70%, the share served from cache, and the session's cost. With a spend budget set (`context-doctor budget 50/day`, [spend](./spend.md#a-budget-the-hook-applies-context-doctor-budget)) the cost gives way to the period's across tools: `$12/$50 today`.

On Claude Code 2.1.251 and later it also says until when the prompt cache is warm, and what letting it go cold costs:

```
ctx 412k/1.0M ▮▮▮▮░░░░░░ 41% · cache 100% · warm till 14:32 (1h), then +$3.21 · $12.34
cold: next turn +$1.98
```

Claude Code passes `prompt_cache` (`warm`, `ttl`, `expires_at`, `recache_tokens_if_cold`) and re-runs the status line itself when `expires_at` passes, so the line flips to `cold` without a refresh timer. The time is a clock time, not a countdown, because the line is only redrawn on events. The price is the extra of re-writing the context at the TTL's write rate (1.25x input at 5 minutes, 2x at an hour) instead of reading it (0.1x), for the session's model; a model with no known price shows the tokens instead. Come back before that time, or `/compact` before you leave, and you do not pay it. Older Claude Code versions send no `prompt_cache`, and the line is as before. It reads the size from the status payload when Claude Code provides it, and otherwise from the last 256KB of the transcript (about 1ms on a 20MB file; 80ms end to end including Node startup). On Pro, Max and Ultra it also keeps the limit ledger: each new weekly and 5-hour reading (Ultra has no 5-hour window) Claude Code passes it goes to `~/.claude/.context-doctor-limits.jsonl` for `context-doctor limits` ([limits](./profiling.md#your-plans-limits-context-doctor-limits)). It is opt-in and polite: there is only one status line, so it never overwrites one you already have, and `uninstall` removes only its own. Any failure prints nothing rather than an error.

## Codex's footer (Codex 0.171+)

Codex 0.171 lets an MCP server draw its footer, behind an experiment. context-doctor's MCP server (wired into `~/.codex/config.toml` by `context-doctor install`, or `codex mcp add context-doctor -- npx -y context-doctor mcp`) offers one:

```
context 412k of 1.0M (41%)   $3.21 this session   limits: 5h 23%, weekly 41%
```

Nothing changes until you turn it on, in Codex itself:

1. `/experimental`, turn on **Custom status line**, and restart Codex.
2. `/statusline`, **Choose a status line provider**, pick **context-doctor: context, cost, limits**.

To go back, pick another provider (or Codex's own items) in `/statusline`, or turn the experiment off. context-doctor never edits Codex's settings for this.

What it shows, each part only when known: the context Codex reports for the thread, against its window (a ⚠ from 70%); what the session has cost so far at list prices, the agents it spawned included, counted as `spend` and the every-prompt hook count it; and your plan's 5-hour and weekly windows as Codex last read them, with when a window resets once it is past 80%. With nothing to show (a new thread, a model with no price, an API key without plan windows) the footer is empty rather than wrong.

How it stays inside Codex's one second per read: the context and the windows come with each read (Codex passes the thread's state); the price is read from the thread's rollout in a background thread, kept per thread and refreshed when the thread's totals move (at most every 3 s, and every 30 s for spawned agents), and a read waits for it at most 200 ms, so a cold read of a 70 MB rollout (about 0.8 s) never holds the footer: until then it shows the thread's own totals priced at the model's rates, and afterwards the last price it had. A read never fails (Codex stops reading after a failure until you pick the provider again): at worst it repeats the last line it drew.

The tool and its resource (`ui://context-doctor/statusline`) are listed only to Codex; other apps never see them in their tool lists.

## Where the status line never runs: the Desktop app and VS Code

Claude Code runs no status line in the Desktop app's Code tab or the VS Code extension. There the Claude Code plugin's mod takes its place: after each turn it keeps the limit readings (the same ledger, for `context-doctor limits`) and Claude Code's own session cost beside context-doctor's price (`doctor` compares them), and it draws a band above the prompt when the cache is about to expire or has expired on a big context, or the session passes a price threshold, with a **Compact first** button on a cold return. `/context-doctor-fix` opens `fix`'s plan with Apply and Undo buttons. Nothing happens without a press; `CONTEXT_DOCTOR_NO_MOD=1` turns it off. Details: [the Desktop app and VS Code](./desktop.md).
