# Fixes: `fix` and `cache-ttl`

[← README](../README.md)

Most of context-doctor measures. The commands here change something: a setting each, measured on your own history first, written only when you say yes, and undone with one command. Except autopilot (a local proxy, terminal and IDE only), each is a setting Claude Code reads itself, so it works in every Claude Code surface, the desktop app included.

## One plan: `context-doctor fix`

```bash
context-doctor fix                          # the plan; in a terminal it asks about each fix
context-doctor fix --apply cache-ttl        # apply named fixes without asking (or --apply all)
context-doctor fix undo                     # put back everything fix changed (or: fix undo cache-ttl)
context-doctor fix --share                  # the totals, no paths, to post
```

`fix` runs the same replays as `savings`, `compact-window` and `cache-ttl` on your last 30 days (`--days n`), and lists what to change, largest saving first. Each entry says how it was measured, what it costs in quality, and exactly what it writes:

| Fix | Writes | Quality |
|---|---|---|
| `compact-window`: compact earlier (400k unless you set one) | `autoCompactWindow` in `~/.claude/settings.json` | each compaction keeps a summary, not the full history: detail for money |
| `cache-ttl` / `cache-ttl-subagents`: the cache lifetime that was cheaper on your pauses | `promptCacheTtl` / `subagentPromptCacheTtl` | none: the same content is sent |
| `autopilot`: clear read tool output when the cache is cold (terminal and IDE sessions only) | the autopilot service and `env.ANTHROPIC_BASE_URL` | clears only what the model has read, never on a warm cache; `recall` finds it |
| `tool-search`: MCP tool search back on, when `ENABLE_TOOL_SEARCH` switches it off and MCP servers are configured | `env.ENABLE_TOOL_SEARCH = "auto"` | none expected: Anthropic measured better tool choice with search on ([advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)) |
| `prune`: MCP servers and skills this folder's project never used | its `.claude/settings.local.json` (as `overhead prune --write`) | none while they stay unused |

The `/compact` offer at cold returns is listed under "Advice you act on": it is the every-prompt hook's job, and `fix` says whether the hook is there to make it.

**Consent.** Nothing is written unless you answer `y` in a terminal or name the fix with `--apply` (`--json --apply` applies too, and exits 1 when there was nothing to apply or a fix failed); piped or in a script, `fix` only prints the plan.

**Edits, and undo.** A fix changes only its own key, in the text of `settings.json`: indentation, CRLF line ends, `"\u00e9"` escapes and `1.0` stay as you wrote them. Each write goes to a temporary file renamed over the target (through a symbolic link, which stays a link), under a lock file, so two runs at once lose nothing. `~/.claude/.context-doctor-fixes.json` records each fix with the value it replaced, raw (`"auto"` included), and the file as it was. `fix undo` puts the whole file back byte for byte when nothing touched it since; otherwise it restores just that key, and only if the key still holds what `fix` wrote: a value you changed since is left alone, and undo says so. A second `fix` of the same setting keeps the first record, so undo returns to the state before context-doctor. A `settings.json` that is not a JSON object (`[]`, a trailing comma, comments) or a damaged record file is refused with a message, and nothing is changed; `fix` never touches the `.context-doctor.backup` that `install` keeps.

**Where Claude Code reads it.** `fix` and `cache-ttl` write the user's `settings.json`, in `CLAUDE_CONFIG_DIR` when that is set. Claude Code merges managed (policy) settings, the project's `.claude/settings.local.json` and `.claude/settings.json`, then the user's file; environment variables (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL=5m`, from the shell or any settings file's `env`) and per-model windows (`modelSettings.<model>.autoCompactWindow`, what `/autocompact` writes) win over it. The plan marks a fix that one of these would override, and after applying, `fix`, `cache-ttl` and `compact-window` say what overrides it and exit 1 instead of reporting success. "Already applied" reads the merged value.

**Measured since.** Later runs list what `fix` applied and what each saved since, on the sessions after it:
- the cache lifetime: the requests since, priced as billed against the lifetime before (the share of 1-hour writes measured when it was set). An estimate: a cold re-write is told by over 60% of the context written again, as in `cache-ttl`;
- the compact window: each automatic compaction since that came before the old window, priced as the context it took off every later request until the session would have reached the old window, less the compaction's own request and a 20k-token summary. An estimate: what the summary dropped is not priced;
- autopilot: what the proxy recorded saving since.

**On the author's machine** (last 30 days, read-only, 2026-10-28): $2,781 of input; 1. compact earlier at 400k, $1,418 (51%); 2. the main conversation's cache at 1 hour, $197 (7%); autopilot is on but cannot reach the desktop app where all 34 sessions ran; advice: `/compact` at cold returns, $640 over 197 returns. The first had its own command since 0.25 and was still not applied: the reason `fix` exists. After the QA fixes `fix` takes 19 s there (was 35 s): with autopilot already on it skips autopilot's replay, with a window set it skips the compaction replay, and it reads every transcript for unused servers only when the project has servers or skills to prune.

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
