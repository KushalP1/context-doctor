# context-doctor for Claude Code

Cut your Claude Code bill, measured on your own sessions. context-doctor reads the usage Claude Code already records on your machine, prices every request, and shows what each change would have saved you over the last 30 days. You choose which changes to apply; each one can be undone. Everything runs locally: no account, no API key, no telemetry.

## What you get

- **`/context-doctor:fix`**: every way to spend fewer tokens (the prompt cache's lifetime, the auto-compact window, long Bash output to a file, unused MCP servers and skills, the subagents' model), ranked by what it would have saved on your sessions, with what each costs in quality. It applies only the ones you pick, and `fix undo` takes them out again.
- **`/context-doctor:spend`** and **`/context-doctor:savings`**: what your sessions cost, by project, model and subagent, and what each lever saves.
- **`/context-doctor:checkup`**, **`:overhead`**, **`:compact-window`**, **`:pack`**, **`:autopilot`**: profile the current session, price what every request re-reads, compare auto-compact windows, answer a question from a large file by reading only the chunks it needs, and turn autopilot on or off.
- **An every-prompt check**: a short line when a session gets heavy, crosses a price you set, or comes back after the prompt cache expired, with a `/compact` offer. Silent otherwise.
- **A price before it is paid**: before a subagent starts and before a model switch, what it will cost at your own median.
- **Better compactions**: instructions for each compaction that keep what the session still needs.
- **MCP tools**: `profile_context`, `optimize_context`, `pack_context`, `save_handoff`, `recall`, `context_best_practices`.
- **In the Desktop app, VS Code and the terminal (Claude Code 2.1.286+)**: a band above the prompt when the cache is about to go cold on a large context (with **Compact first**), Claude Code's own cost of the session beside context-doctor's, and `/context-doctor-fix`, the plan as Apply and Undo buttons.

## How to use it

Run `/context-doctor:fix` and answer which fixes to apply. Ask "what is eating my context?" or "what did I spend this week?" and Claude uses the skills and tools above. Example prompts:

1. "What would have cut my Claude Code bill last month? Apply the ones that cost no quality."
2. "Why is this session so expensive? Check it and fix the top problem."
3. "What does every request re-read before my message, and what does it cost?"

## What it runs, reads, writes and sends

Every hook, skill and the MCP server run `node` on files inside this plugin (`dist/cli.js`, `dist/mcp.bundle.js`); Node 20 or later must be on your PATH.

- **Hooks** (`SessionStart`, `UserPromptSubmit`, `PreToolUse` on the Agent tool, `PreModelSwitch`, `PreCompact`): read the current session's transcript, which Claude Code hands the hook, and print at most one line or the compaction instructions.
- **The mod** (a hooks module, `dist/mod/register.js`): after each turn it runs `node dist/cli.js mod measure` with the rate-limit windows and session cost Claude Code gives it; it draws the band and the `/context-doctor-fix` pane; a press of Apply or Undo runs `node dist/cli.js fix --apply <id>` or `fix undo <id>`; a press of Compact first asks Claude Code to compact. It makes no network request and writes no file itself. `CONTEXT_DOCTOR_NO_MOD=1` turns it off.
- **Reads**: Claude Code's transcripts and settings under `~/.claude` (or `CLAUDE_CONFIG_DIR`), to measure usage; `spend` also reads the local history of Codex, Gemini CLI and Cursor when they are installed.
- **Writes**: only its own files under `~/.claude` (`.context-doctor-*`: ledgers, hook state, the record of applied fixes), a cache under `~/.cache/context-doctor`, handoffs you ask for under `~/.context-doctor/handoffs`, and, when you apply a fix, the setting it names in Claude Code's `settings.json` (a backup is kept; `fix undo` restores it byte for byte).
- **Sends**: nothing. No telemetry, no analytics. Four opt-in commands use the network, each only when you run it: `autopilot on` runs a local proxy on 127.0.0.1 that forwards Claude Code's own requests to the same Anthropic endpoint they were going to; `analyze --exact` asks Anthropic's token-counting API, with the `ANTHROPIC_API_KEY` you set; `ab --yes` runs a small test suite on the Messages API with that key, or through your own Claude Code with `--via claude-code`; `pack --semantic` asks the Ollama you run (`OLLAMA_HOST`, by default 127.0.0.1) for embeddings. The autopilot skill asks before running `npm install -g context-doctor`.

Privacy: [docs/privacy.md](https://github.com/KushalP1/context-doctor/blob/main/docs/privacy.md). Source, issues and full documentation: [github.com/KushalP1/context-doctor](https://github.com/KushalP1/context-doctor). MIT licensed, by gAI Ventures.
