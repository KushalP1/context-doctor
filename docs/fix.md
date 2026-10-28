# Fixes that change a setting

[← README](../README.md)

Most of context-doctor measures. The commands here change something: one Claude Code setting each, measured on your own history first, written only when you ask, and undone with one command. They work in every Claude Code surface, the desktop app included, because they are settings Claude Code reads itself; no proxy or hook is involved.

## The prompt cache's lifetime: `context-doctor cache-ttl`

Every message re-sends the whole conversation. The part the previous message cached is read at 5-10% of the input price, if the cache is still alive. Claude Code writes the cache with a lifetime of **5 minutes** (each written token at 1.25x input) or **1 hour** (2x). A pause longer than the lifetime makes the next message write the whole context again, so the right lifetime depends on how you work: quick turns favour 5 minutes, pauses of 5-60 minutes favour an hour.

Claude Code 2.1.243 and later let you choose ([environment variables](https://code.claude.com/docs/en/env-vars)):

| Setting in `~/.claude/settings.json` | For | Unset |
|---|---|---|
| `promptCacheTtl`: `"5m"` or `"1h"` | the main conversation | 1 hour on a Claude subscription within its usage limits; 5 minutes on an API key, Bedrock, Vertex or Foundry |
| `subagentPromptCacheTtl` | subagents, workflows, background work | 5 minutes |

`CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` take precedence over the settings, and `FORCE_PROMPT_CACHING_5M=1` over everything; `cache-ttl` and `doctor` say when one of them is set.

```bash
context-doctor cache-ttl                 # replay your last 30 days at both lifetimes
context-doctor cache-ttl 1h              # promptCacheTtl = "1h" (backup of settings.json kept)
context-doctor cache-ttl 5m --subagents  # subagentPromptCacheTtl = "5m"
context-doctor cache-ttl off             # remove it: Claude Code chooses again
```

**How it is measured.** Each transcript's requests, in order, priced three ways at their own model's list prices: as billed (the recorded usage), with every write at 5 minutes, and with every write at 1 hour. A request that found the cache cold (its gap from the previous request longer than that entry's lifetime, and over 60% of the previous context written again) would have read it at a lifetime that covered the gap; a request that read a warm cache would have written it all again at a lifetime its gap exceeded. A compaction or a model switch starts a new cache in every arm. The main conversation (sessions with 10+ requests, the same ones `savings` counts) and subagents are replayed apart, since each has its own setting. A lifetime is recommended only when it saves at least $1 and 2% of the input as billed.

**Quality.** None at stake: the same content is sent either way; only the price of keeping it cached changes.

**On the author's machine** (last 30 days, read-only, 2026-10-28): main conversation $2,789 as billed with 70% of writes at 1 hour; all at 1 hour $2,593, **$197 (7%) less**, 57 cold re-writes kept warm; all at 5 minutes, Claude Code's default on an API key, $3,411 (22% more). Subagents: $1,632 at 5 minutes; an hour would cost $238 more, so they are left alone.

An older Claude Code ignores the keys and still reads the rest of the file (checked on 2.1.62: its hooks still ran), so writing them is safe everywhere; `cache-ttl` names any install that predates them. On a subscription the same tokens come out of your usage limit instead of a bill.
