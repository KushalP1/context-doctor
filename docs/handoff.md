# Handoff: the one real cut in a chat app

[← README](../README.md) · [Chat apps](./chat-apps.md)

In Claude Desktop, claude.ai and ChatGPT nothing can edit a chat's history. When a model "summarizes" a 30k-token paste, it stops quoting it, but the paste is still in the chat and is re-read on every later turn. The only way a long chat gets cheaper is a **new chat** that starts from a short brief. That is a handoff.

context-doctor never calls a model itself (no API key). The model you are already talking to writes the brief in its own turn; context-doctor stores it, sizes it, and gives it back to the next chat.

## In Claude Desktop (and other clients that show MCP prompts)

1. In a long chat, open the **+** menu, pick **Hand off to a new chat** (the `handoff` prompt from context-doctor). Optionally say what the next chat should work on.
2. The model writes a dense brief of at most **400 tokens** (goal, decisions with a short reason, current state, open items and the next step, key identifiers such as names, paths, IDs, versions and numbers) and lists, separately, only the blocks that must stay exact (code, config, commands, figures). It saves them with the `save_handoff` tool.
3. If your client can show forms (MCP elicitation), it asks you first: save the handoff, with or without the verbatim blocks. Elsewhere the click on the prompt was your consent.
4. The reply tells you how to continue and what it saves. For a 52k-token chat on Claude Sonnet the tool reports: *Now: ~52k tokens re-read on every turn ($0.104 at list price, $0.010 cached). After: ~600 in a new chat ($0.0012 at list price), plus the app's own system prompt, which every chat carries. Saves ~51k tokens per further turn (99%).* The chat's size comes from `profile_context` when the model has that figure, or is estimated from the turn count.
5. Open a new chat and attach **`handoff://latest`** from the **+** menu (context-doctor's resources), or paste the handoff. The new chat starts from it.

The standing rules ask the model to **offer a handoff once** when a chat grows long, and `profile_context`'s chat-app findings say plainly that recoverable tokens come back only in a new chat.

## In ChatGPT and other clients without prompts

Ask for a handoff ("hand this off to a new chat"). The model writes the brief and calls `save_handoff` the same way, then prints the brief and the verbatim blocks in one block for you to paste into a new chat. ChatGPT reaches the server over a URL (`--http`), and there it **stores nothing** by default (see below), so the printed block is the handoff. On the web and on phones, where no MCP server runs, the pasted preferences (`context-doctor instructions --copy`) ask for the same 400-token brief.

## From the terminal

```
context-doctor handoff                 # list saved handoffs, newest first
context-doctor handoff latest          # print the newest
context-doctor handoff latest --copy   # copy it, to paste as a new chat's first message
context-doctor handoff show <id>       # print one (or just: context-doctor handoff <id>)
context-doctor handoff list --json     # metadata as JSON
```

The CLI only reads; handoffs are written by `save_handoff`.

## What is stored, where

- One folder per handoff: `~/.context-doctor/handoffs/<yyyymmdd-hhmmss>-<slug>/` (UTC time), holding `handoff.md` (what a new chat starts from) and `meta.json` (title, time, sizes). The home directory is whatever `HOME` (or `USERPROFILE` on Windows) says, so a sandboxed home is respected.
- Folders are created `0700` and files `0600`; a handoff holds chat content. Files are created exclusively, so nothing already at that path is written through, and a second save in the same second gets its own folder.
- The newest **100** are kept; older handoff folders (ours only: named like one, with a `meta.json`) are removed when a new one is saved.
- **Secret-looking strings are masked before anything is written**: provider keys by their published prefixes (Anthropic, OpenAI, AWS, GitHub, GitLab, Slack, Google, npm, Stripe), private keys, JWTs, and `password = …` style assignments whose value looks like a token. The tool result says how many were masked and of what kind, so the user can re-add one by hand if the next chat really needs it.
- Limits, checked by the server whatever the client sends: brief up to 6,000 characters (the target is ≤400 tokens; a longer one is saved with a note), up to 20 verbatim blocks of up to 20,000 characters each, 60,000 characters in all, titles up to 80 characters.

## Resources

On the local (stdio) server, saved handoffs are MCP resources: `handoff://latest` (always listed; it says so when there is none yet) and `handoff://<id>` for the newest 20. Ids are checked against a strict pattern before any file is touched, so a resource URI can never become a path (`handoff://..%2F..` is refused). Claude Desktop, Cursor, VS Code (Add Context) and Claude Code (`@`) can attach resources.

## Over HTTP (ChatGPT developer mode, remote clients)

A server reachable over a URL may be reachable by anyone who has the URL (a tunnel, a shared host). There:

- `save_handoff` stores nothing and is annotated read-only (so ChatGPT does not ask for a confirmation it does not need); it returns the token math and asks the model to print the handoff for pasting;
- no handoff resources exist at all;
- `context-doctor mcp --http --store-handoffs` stores handoffs on the machine running the server (for a server on your own machine behind your own tunnel). The tool is then annotated as a write, and resources are still not exposed over the network; read them with `context-doctor handoff latest --copy` on that machine.

## Why not summarize in place

Because a chat app has no place to put the summary. `optimize_context` with `prune-history` does replace old turns with a model-written summary, but only in a conversation file you control (an API app, an exported chat). In a chat app the history is the app's, and the cut is a new chat.
