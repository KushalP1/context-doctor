# Reddit drafts — 2026-09-19 (Reddit unreachable from the session; paste by hand)

## 1. Top-level UPDATE comment on our own r/ClaudeCode post
https://www.reddit.com/r/ClaudeCode/comments/1wf1mha/

> Update, since a few of you asked what runs automatically and where. I went through the app bundles rather than the docs.
>
> Cursor runs your Claude Code hooks. Its Hooks Service loads ~/.claude/settings.json (its own log says "Claude user config path: ~/.claude/settings.json"), maps UserPromptSubmit onto beforeSubmitPrompt, passes a transcript_path, and accepts Claude's hookSpecificOutput.additionalContext. So if you have a Claude Code UserPromptSubmit hook, it is already firing inside Cursor's agent on every prompt. Mine was, and returning nothing, because Cursor's transcript is {role, message:{content}} per line and my parser skipped it. One shape added; against a real Cursor transcript the hook now names a 283k token context and its largest waste.
>
> Codex does the same. The binary bundled in ChatGPT.app (0.153.4) has hooks.json in the same shape, the same additionalContext response, MCP servers in config.toml, and SKILL.md skills. Its rollouts carry the API's real usage figures, which Cursor's do not. Only difference: Codex makes you trust a new hook once with /hooks.
>
> Claude Desktop chat is the one that cannot be made automatic. No hook, and the ANTHROPIC_BASE_URL and Bedrock strings in the bundle belong to the embedded Claude Code, not the chat. The MCP instructions string is the only channel that reaches the model unprompted, so I rewrote it from "offer to run" to "past ~30 turns or any cost question, call profile_context before answering". A nudge, not enforcement, and I say so in the README now.
>
> 0.16.0. Disclosure as before: I built it. https://github.com/KushalP1/context-doctor

## 2. New post in r/cursor (flair: Discussion or Showcase; rule 6 wants relevance + context; ≤10% promo)
Title: Cursor runs your Claude Code hooks from ~/.claude/settings.json. Here is what I found and what it let me do.
Body: the Cursor paragraph above expanded (Hooks Service log line, beforeSubmitPrompt mapping, transcript_path location under ~/.cursor/projects/<ws>/agent-transcripts/, the 10k additional_context cap), then the transcript format, then one paragraph on what a per-prompt context hook can do for an agent, then disclosure + link.

## 3. New post in r/ChatGPTCoding (rule 6: problem, comparison, numbers; flair Resource)
Title: Codex hooks and MCP: the context profiler I built for Claude Code now runs inside Codex, with measured token usage
Body: problem (agents carry tool output forever; Codex rollouts record last_token_usage so it can be measured, not estimated), comparison (Claude Code hook: estimate-only from transcript; Cursor: no usage at all; Codex: cached_input_tokens and input_tokens per turn), what I did (install writes config.toml/hooks.json/skill; 40 of 40 local rollouts parse; example output), disclosure + link.

## 4. r/mcp — the filtered showcase post still needs the modmail (drafted 2026-09-12, unsent).

## 5. r/ClaudeAI consumer post — still gated on karma > 100 (was 81).

Order: 1 today (it is our own thread, zero risk), 2 tomorrow, 3 the day after. Same account, one sub per day, disclose every time.
