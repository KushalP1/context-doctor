# Privacy

[← README](../README.md)

context-doctor (the npm package, the Claude Code plugin, its MCP server and the editor extension) runs on your machine and keeps what it learns there. gAI Ventures, which makes it, receives nothing from it.

**What it collects.** Nothing is collected by us. There is no account, no telemetry, no analytics, no crash reporting and no update check of its own.

**What it reads, on your machine.** The usage your AI coding tools already record locally: Claude Code's transcripts and settings under `~/.claude` (or `CLAUDE_CONFIG_DIR`), and, for `spend`, the local history of Codex, Gemini CLI and Cursor when they are installed. It reads them to count tokens and price requests. A hook reads the transcript of the session it runs in, which Claude Code hands it.

**What it stores, on your machine.** Its own files under `~/.claude` (named `.context-doctor-*`: usage and cost ledgers, rate-limit readings, hook state, a record of the fixes you applied), a cache of the measurements it took from your transcripts under `~/.cache/context-doctor` (or `CONTEXT_DOCTOR_CACHE_DIR`; `CONTEXT_DOCTOR_NO_CACHE=1` keeps none), and the handoffs you ask it to save under `~/.context-doctor/handoffs` (the newest 100; secret-looking strings are masked before they are written). The ledgers hold token counts, prices, model names, the start of session ids and timestamps, not conversation text. A handoff holds the summary of a chat that you asked to carry into a new one. Deleting these files removes everything it kept; `context-doctor uninstall` removes its wiring and ledgers.

**What it changes.** Only what you approve: a fix you apply writes the setting it names in Claude Code's `settings.json`, with a backup, and `context-doctor fix undo` restores the file.

**What it sends.** Nothing, unless you run one of these, each of which says so first:

- `context-doctor autopilot on`: a proxy on 127.0.0.1 that forwards Claude Code's own API requests, edited only when the prompt cache is cold, to the same Anthropic endpoint they were going to. It stores no request content.
- `context-doctor analyze --exact`: sends the conversation you name to Anthropic's token-counting API with the `ANTHROPIC_API_KEY` you set.
- `context-doctor ab --yes`: runs its own test tasks on Anthropic's Messages API, billed to your `ANTHROPIC_API_KEY`.
- `pack --semantic`: sends the chunks of the files you name to the Ollama you run (`OLLAMA_HOST`, by default on this machine) for embeddings.
- The MCP server over HTTP (`context-doctor mcp --http`) answers on the address you start it on, and stores no handoff there unless you pass `--store-handoffs`.

Those requests go to Anthropic or to your own Ollama under their terms, never to us.

**Retention.** Each ledger is capped in size and drops its oldest entries first; the cache drops entries for transcripts that are gone; handoffs past the newest 100 are removed. Nothing is kept anywhere but your machine.

**Children.** It is a developer tool, not directed at people under 18.

**Contact.** Questions or a security concern: open an issue at [github.com/KushalP1/context-doctor/issues](https://github.com/KushalP1/context-doctor/issues), or a private security advisory on the repository.
