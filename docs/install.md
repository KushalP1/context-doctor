# What `install` does

[← README](../README.md)

```bash
npm install -g context-doctor && context-doctor install
```

`install` configures every app it detects and does not stop at the first problem: a corrupt Claude Desktop config still gets you Claude Code and Cursor. It does not pretend either. Any target that failed is named with a ✗ line, the summary reads "Done with N problem(s)" instead of "Done.", and the **exit code is 1**, so dotfiles and onboarding scripts can react. A broken config file is never overwritten; fix it and re-run. `context-doctor doctor` checks the result; `context-doctor uninstall` reverses all of it.

`npx context-doctor install` works too, but autopilot needs the global install: a background service cannot point into npx's cache, which npm deletes at will.

## What it writes

Each config edit makes a `.backup` first:

1. **Claude Desktop config** (`claude_desktop_config.json`) — registers the MCP server
2. **Claude Code config** (`~/.claude.json`) — registers the MCP server
3. **Cursor config** (`~/.cursor/mcp.json`) — registers the MCP server
4. **Agent Skill** → `~/.claude/skills/context-doctor/` — context-hygiene playbook for Claude Code
5. **Every-prompt hook** → `~/.claude/settings.json` (`UserPromptSubmit`) — the per-query context check for Claude Code
6. **Compaction hook** → `~/.claude/settings.json` (`PreCompact`) — tells each compaction what the session cannot lose (files changed, open tasks, your instructions, failing commands)
   **Model-switch warning** → `~/.claude/settings.json` (`PreModelSwitch`), only when every Claude Code on the machine is 2.1.251 or later — shows what a `/model` switch costs (the context re-written into the new model's cache) before it happens; never blocks the switch. An older Claude Code skips the whole settings file over an event it does not know, so with one present install leaves this out and says which one to update
   **Session-start hook** → `~/.claude/settings.json` (`SessionStart`) — on a resumed session, keeps Claude Code's own verdict on whether the prompt cache expired and what re-caching costs, for the cold-resume offer on your first prompt; prints nothing
7. **Cursor hooks**, when Cursor is present → `~/.cursor/hooks.json` (`postToolUse`, `postToolUseFailure`, `sessionStart`) — the same check for Cursor's agent, after each tool call (failed ones included) and at the start of a resumed chat. Cursor 3.17 and later deliver the text to the model; earlier versions dropped it, and `doctor` says which you have
8. **Codex**, when present: MCP server in `~/.codex/config.toml`, the hook in `~/.codex/hooks.json`, the skill in `~/.codex/skills/`. Codex runs a new hook only after you trust it once: type `/hooks` in Codex
9. **Gemini CLI**, when present: MCP server and the every-prompt hook (`BeforeAgent`) in `~/.gemini/settings.json`
10. **GitHub Copilot**, when present (the Copilot CLI, the GitHub Copilot app, or VS Code, which ships Copilot): the MCP server in `~/.copilot/mcp-config.json` (`$COPILOT_HOME` when set), which Copilot's sessions read in the CLI, the app and VS Code alike, and a hook file of its own, `~/.copilot/hooks/context-doctor.json`, whose `sessionStart` gives each new session the five standing rules. That is all Copilot allows: the Copilot CLI includes an MCP server's instructions only for some servers (all of them with `--allow-all-mcp-server-instructions`), and of its hooks that can add context (`sessionStart`, `postToolUse`, `postToolUseFailure`) none is given a transcript, so there is no size check to run ([hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)). VS Code's user-profile `mcp.json` is left alone: VS Code labels it deprecated and forwards it into the same Copilot sessions
11. With `--statusline`: live context size, cache share and cost in Claude Code's status bar ([details](./editor-and-statusline.md))

`context-doctor autopilot on` is separate and opt-in: it adds the background proxy service and, after the proxy has answered a health check, `env.ANTHROPIC_BASE_URL` to `~/.claude/settings.json`, plus `env.ENABLE_TOOL_SEARCH=auto` unless you set that yourself ([details](./autopilot.md)).

Other ways in, without `install`: the Claude Code plugin, the one-click `.mcpb` for Claude Desktop (from the [latest release](https://github.com/KushalP1/context-doctor/releases/latest); it runs on Desktop's own Node, no npm needed), or the MCP server entry in any client's config. All three are in the README's [Quick start](../README.md#quick-start). ChatGPT needs a URL instead of a local command: see [chat apps](./chat-apps.md#chatgpt).

## What happens in every session after

**In every chat (Claude Desktop, Cursor):** when the conversation starts, the app launches the MCP server, which hands the model its [five standing rules](../README.md#where-it-works) for the whole chat.

**In every Claude Code / Cowork session:** the same rules via MCP, plus two more layers:

- the **skill** loads whenever context work is relevant: summarize big tool results after using them, never re-paste duplicated content, keep stable content cache-friendly, offer compaction when a session gets heavy. The hook enforces the heavy-session part; the skill covers the habits in between. (`skills/context-doctor/SKILL.md` can also be uploaded to claude.ai under Settings > Capabilities > Skills.)
- the **hook runs on every single prompt you send**: ~80ms per prompt, nearly all of it Node startup, because on a lean session its own work is one `stat()` (~1ms); once a session is heavy it profiles on growth events and injects a note the model sees with your message — actual token count, cost per message, the single largest recoverable waste — with instructions to work leaner and offer you compaction. It re-fires only after ~40% further growth, can never break a prompt (any failure exits silently), and logs each deep check to a small local ledger that feeds `context-doctor report`. Its warning threshold is tunable with `CONTEXT_DOCTOR_WARN_TOKENS` (default 80000) or a [`.contextdoctorrc` budget](./ci.md#context-budgets-contextdoctorrc).

Without autopilot nothing runs in the background: the hook, skill, MCP server and its instructions are delivered by the apps themselves at the right moment. With autopilot, one small proxy runs as a login service (launchd / systemd user service / logon task) and is restarted by the service or by the next prompt's hook if it ever stops.

## Do you need MCP?

Only for the in-chat tools: MCP is how the model inside Claude Desktop, Cursor's chat or a ChatGPT developer-mode connector calls `profile_context`, `optimize_context`, `pack_context` and `context_best_practices` itself. Everything else works without it: the CLI on files and transcripts (nothing but `npx`, so any terminal, script or CI), autopilot and the proxy, the hooks (the apps invoke them directly), the skill (a markdown file) and the [library](./library.md). A developer who only wants cheaper API calls never touches MCP; a Claude Code user gets the hooks and the skill without it, and the MCP server adds the in-chat tools on top. `install` sets up all of it at once so you do not have to think about which mechanism is which.

## What it never does

Delete or rewrite your history without asking (pruning is consent-only, and the model writes the replacement summary so nothing is lost silently), send data anywhere (everything runs on your machine), or touch an API key.

**No API keys, ever.** Everything is deterministic local code; when an LLM is needed (summarizing pruned history), the model already running in your app does it. The proxy forwards *your app's* credentials untouched — context-doctor itself holds nothing.
