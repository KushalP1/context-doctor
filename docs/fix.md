# Fixes: `fix` and `cache-ttl`

[← README](../README.md)

Most of context-doctor measures. The commands here change something: a setting each, measured on your own history first, written only when you say yes, and undone with one command. Except autopilot (a local proxy, terminal and IDE only), each is a setting Claude Code (or Codex) reads itself, so it works in every surface, the desktop app included.

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
| `subagent-model`: subagents on Sonnet 5.5 when they ran on a pricier model ([below](#the-subagents-model-subagent-model)) | `env.CLAUDE_CODE_SUBAGENT_MODEL = "claude-sonnet-5-5"` | **it changes the model your subagents run on**; not measured here, `context-doctor ab` can. Applied only when named: `--apply all` leaves it out |
| `tool-output`: long Bash output to a file sooner ([below](#long-bash-output-tool-output)) | `bashOutputMaxChars` (8,000-20,000, from your history) | long output goes to a file the model can still open; it sees the first 2,000 characters and the path. In `--apply all`: nothing is lost, only moved |
| `codex-compact`: Codex compacts earlier, at 150k tokens ([below](#codexs-auto-compact-limit-codex-compact)) | `model_auto_compact_token_limit` in `~/.codex/config.toml` | as `compact-window`: each compaction keeps a summary, not the full history |

The `/compact` offer at cold returns is listed under "Advice you act on": it is the every-prompt hook's job, and `fix` says whether the hook is there to make it.

**Consent.** Nothing is written unless you answer `y` in a terminal or name the fix with `--apply` (`--json --apply` applies too, and exits 1 when there was nothing to apply or a fix failed); piped or in a script, `fix` only prints the plan.

**Edits, and undo.** A fix changes only its own key, in the text of `settings.json`: indentation, CRLF line ends, `"\u00e9"` escapes and `1.0` stay as you wrote them. Each write goes to a temporary file renamed over the target (through a symbolic link, which stays a link), under a lock file, so two runs at once lose nothing. `~/.claude/.context-doctor-fixes.json` records each fix with the value it replaced, raw (`"auto"` included), and the file as it was. `fix undo` puts the whole file back byte for byte when nothing touched it since; otherwise it restores just that key, and only if the key still holds what `fix` wrote: a value you changed since is left alone, and undo says so. A second `fix` of the same setting keeps the first record, so undo returns to the state before context-doctor. A `settings.json` that is not a JSON object (`[]`, a trailing comma, comments) or a damaged record file is refused with a message, and nothing is changed; `fix` never touches the `.context-doctor.backup` that `install` keeps.

**Where Claude Code reads it.** `fix` and `cache-ttl` write the user's `settings.json`, in `CLAUDE_CONFIG_DIR` when that is set. Claude Code merges managed (policy) settings, the project's `.claude/settings.local.json` and `.claude/settings.json`, then the user's file; environment variables (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL=5m`, from the shell or any settings file's `env`) and per-model windows (`modelSettings.<model>.autoCompactWindow`, what `/autocompact` writes) win over it. The plan marks a fix that one of these would override, and after applying, `fix`, `cache-ttl` and `compact-window` say what overrides it and exit 1 instead of reporting success. "Already applied" reads the merged value.

**Measured since.** Later runs list what `fix` applied and what each saved since, on the sessions after it:
- the cache lifetime: the requests since, priced as billed against the lifetime before (the share of 1-hour writes measured when it was set). An estimate: a cold re-write is told by over 60% of the context written again, as in `cache-ttl`;
- the compact window: each automatic compaction since that came before the old window, priced as the context it took off every later request until the session would have reached the old window, less the compaction's own request and a 20k-token summary. An estimate: what the summary dropped is not priced;
- autopilot: what the proxy recorded saving since;
- the subagents' model: the subagent requests it moved, priced at the models they ran on before (the mix measured when it was set, by tokens, those already on Sonnet or cheaper included) against as billed. An estimate: the same token counts either way;
- long Bash output: the results Claude Code moved to a file since that the cap before (30,000 characters, or yours) left inline, priced at the requests that re-read them no more. An estimate: a file the model opened again is not counted;
- Codex's limit: each Codex compaction since that came before Codex's own trigger, priced as the context it took off every later request until the session would have reached that trigger, less the compaction's request and a 5k-token summary.

**On the author's machine** (last 30 days, read-only, 2026-10-28): $2,781 of input; 1. compact earlier at 400k, $1,418 (51%); 2. the main conversation's cache at 1 hour, $197 (7%); autopilot is on but cannot reach the desktop app where all 34 sessions ran; advice: `/compact` at cold returns, $640 over 197 returns. The first had its own command since 0.25 and was still not applied: the reason `fix` exists. After the QA fixes `fix` takes 19 s there (was 35 s): with autopilot already on it skips autopilot's replay, with a window set it skips the compaction replay, and it reads every transcript for unused servers only when the project has servers or skills to prune.

## The subagents' model: `subagent-model`

Every subagent runs on the main conversation's model unless something says otherwise, so a session on Opus 5.5 ($4/$20 per million tokens in/out) or Fable 5.1 ($10/$50) runs its general-purpose subagents there too. Claude Code reads `CLAUDE_CODE_SUBAGENT_MODEL` (default `inherit`); `fix` offers `claude-sonnet-5-5` ($2/$10; cache reads $0.10, against $0.20 on Opus 5.5 and $0.25 on Fable 5.1) when your subagents ran on a pricier model, and says nothing when they already run on Sonnet or Haiku.

**What it moves.** Read from the 2.1.309 binary, a subagent's model is, highest first: the Agent call's own `model`; the agent definition's `model` (an agent file's frontmatter; the built-in Explore, Plan and forks say `inherit`, claude-code-guide `haiku`, statusline-setup `sonnet`); `CLAUDE_CODE_SUBAGENT_MODEL`, unless it is empty or exactly `inherit` (`default` is passed on as a model name); the main conversation's model. So the variable moves general-purpose, `claude`, and agents of your own whose file names no model; Explore and Plan stay on the main conversation's model. Agent files are read the way Claude Code merges them, for each subagent's own folder: `~/.claude/agents`, then the project's `.claude/agents` from the git root down to that folder (the closer one wins, subfolders included), then managed; a file with no `name` or `description` is not an agent. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` puts the variable above the definitions and the call's `model` too (forks still inherit); the replay counts it when it is set, `fix` does not write it. (2.1.62 also read the variable, ahead of everything.) Claude Code applies every settings file's `env` to its own process at start, so the value lives in `~/.claude/settings.json`.

**How it is measured.** Every subagent request of the period, read once with the other replays: as billed (its usage at its model's list price, cache writes at 1.25x or 2x input by TTL, output as settled on the reply's last row), and, for the types the variable moves that ran on a pricier model, the same usage at Sonnet 5.5. The token counts stay as they were: an estimate, since another model tokenizes differently and may take more or fewer steps for the same task. The plan lists each agent type: runs, as billed, at Sonnet 5.5 or why it is unchanged.

**Quality.** Not measured here: this changes the model your subagents run on. `context-doctor ab` measures a model on a suite of small coding tasks (run it with `--model claude-sonnet-5-5` and without); a subagent's own work may differ.

**Where the estimate leans high.** A subagent started with its own `model` (the Agent call's parameter) keeps that model whatever the variable says, but the replay cannot tell those calls apart and counts them as moved. Subagents that inherited Haiku from a Haiku main conversation would get pricier on Sonnet 5.5; they are left as billed, not counted against the saving. Agent types from a plugin whose agent file is not found are listed as unchanged.

**Haiku 5.5 for read-only work.** The plan prices Explore and Plan at Haiku 5.5 ($0.10/$0.50) too, but Haiku's rates hold only to 100k-token prompts and it bills a higher tier above that, which the price table does not hold: the figure is shown when few prompts are past 100k, and "not priced" otherwise. The built-ins cannot be moved one by one; an agent of your own with `model: haiku` in its file runs on Haiku.

**Yours stays yours.** `fix` never overwrites a `CLAUDE_CODE_SUBAGENT_MODEL` you set, in `settings.json` or in the environment (a settings value would override the shell's), `inherit` included: the plan names it. A project or managed settings `env` that sets it wins over the user's file, and the plan says so. Run inside a Claude Code session (the plugin's `/context-doctor:fix`), the process carries each settings file's `env` as the session started: a value a settings file holds is that file's, and `fix`'s own value still there after `fix undo` is not taken for yours; any other is named as this session's environment.

**On the author's machine** (last 30 days, read-only, 2026-11-02): 253 subagents, 17,051 requests, $1,658 as billed. The variable would move general-purpose ($1,573 → $953 at Sonnet 5.5) and `claude` ($24 → $12): **$632 less, 38% of the subagents' bill** (the plan shows it as "(38% of subagents)", not as a share of input); the requests it moves ran on Fable 5.1 ($899) and Opus 5.5 ($604). Explore ($36), forks ($25) and claude-code-guide stay where they are. Not half: cache reads, most of a subagent's input, were priced at $0.20 per million on Opus 5.5 and Sonnet 5.5 alike. Explore at Haiku 5.5 is not priced there: 402 of its 645 prompts were over 100k tokens. At the list prices read 2026-11-06 (Sonnet 5.5's cache reads $0.10) the same lever measured **$900 less, 58% of the subagents' bill** on the author's last 30 days (222 subagents, $1,563 as billed).

## Long Bash output: `tool-output`

A tool's result stays in the conversation, and every later message re-reads it until a compaction. A 20,000-character build log is ~8k tokens on every request after it. Claude Code already moves long output to a file; `fix` measures whether moving it sooner would have paid on your history, and offers the setting that does it.

**What Claude Code does** (read from the 2.1.309 binary, and the same in its docs: [tools reference](https://code.claude.com/docs/en/tools-reference#output-limits), [settings](https://code.claude.com/docs/en/settings-reference#bashoutputmaxchars), [MCP](https://code.claude.com/docs/en/mcp#mcp-output-limits-and-warnings)):

| Knob | Default | Past it, the model gets |
|---|---|---|
| `bashOutputMaxChars` (settings, any file; Claude Code 2.1.261+; clamped to 4,000-128,000) | 30,000 characters | for a successful Bash or PowerShell command: the file's path and a preview of the first 2,000 characters (`<persisted-output>`); the file holds it all. A failed command gets a ~10,000-character head-and-tail excerpt instead, whatever the setting |
| `BASH_MAX_OUTPUT_LENGTH` (environment) | 30,000 | nothing changes inline: it sizes how much Claude Code reads back from the command's output file. `bashOutputMaxChars`, when set, replaces it |
| `MAX_MCP_OUTPUT_TOKENS` (environment) | 25,000 tokens | for an MCP text result: a message naming the file it was saved to, with no preview. A text result over 50,000 characters goes to a file (with the 2,000-character preview) whatever the variable says, unless the tool declares its own limit; images are cut instead |

Anthropic can also set a tool's threshold server-side (the binary reads a remote flag per tool name); that is not visible here.

`fix` writes `bashOutputMaxChars`: a setting rather than an environment variable, so the desktop app reads it too, and the output stays reachable (the model opens the file, or greps it, when the preview is not enough). `MAX_MCP_OUTPUT_TOKENS` is measured and not offered: past it the model sees only a path.

**How it is measured.** Every Claude Code transcript of the period, main conversations and subagents, read once with the other replays: each request with its usage, each Bash and MCP result with its length, each compaction. At each candidate cap (8k, 12k, 16k and 20k characters), a successful text result longer than the cap would have been the preview: the tokens past it are priced at the first request after it (the cache write, at the session's own write price) and at every later request until a compaction (a cache read at that request's model's rate, or a write when the request found the cache cold: over 60% of its context written again). A context that fell to under 70% of the request before without a compaction (a rewind, cleared output) drops what it held. Tokens are estimated from the length at the ratio measured on the growth of the billed prompt between consecutive calls (2.4 characters a token for code and tool output, 2.75 for prose; [tokenizer](tokenizer.md)). The share is of the input billed over the same requests, subagents included, since the setting applies to both.

**What it does not count.** When the preview is not enough, the model opens the file or runs the command again: one more request, re-reading the context it has then, and the output back in it. The replay prices that request for each moved result and says how many of them the saving covers ("pays unless the model opens over 83% of them"). The offered cap is the one that saves the most among those that still pay with the model opening half the files; under 8,000 characters the 2,000-character preview is most of the output, so smaller caps are not tried. The preview is the start of the output, so a test run whose failures are at its end is the case where the model opens the file.

**Yours stays yours.** A `bashOutputMaxChars` in your `settings.json` is named and never overwritten (at 30,000 or less it shows as applied; larger, as your choice); so is a `BASH_MAX_OUTPUT_LENGTH` you set, which the setting would replace. A project's or managed `bashOutputMaxChars` wins over the user's file, and the plan says so.

**On the author's machine** (last 30 days, read-only, 2026-11-04): 343 transcripts, 26,003 requests, $3,732 of input with subagents. Of 19,337 successful Bash results, 1,978 were over 8,000 characters: **$321 less, 9%**, paying unless the model opens over 83% of them (each opening ~$0.03). 12k: $210 (1,058 results); 16k: $132; 20k: $76. MCP: 33 of 2,478 text results over 10k tokens, $10 (not offered). `fix` with this replay takes 1.2 s warm. Workflow agents' transcripts (`subagents/workflows/`) are not read by any report yet.

## Codex's auto-compact limit: `codex-compact`

Codex re-sends the whole conversation on every request too, and compacts it only near the model's window. Its own setting moves that point, the same lever as Claude Code's auto-compact window.

**What Codex does** (verified 2026-11-04 in codex-cli 0.153.4, the ChatGPT app's binary, and on openai/codex main: `config.schema.json`, `protocol/src/openai_models.rs`, `models-manager/src/model_info.rs`; the [config reference](https://developers.openai.com/codex/config-reference)): `model_auto_compact_token_limit`, a top-level integer in `~/.codex/config.toml` (`CODEX_HOME` honoured), is the token count at which Codex compacts the history on its own. Unset, it is 90% of the model's context window (244,800 on the 272k windows of gpt-5.5 and gpt-6); set, Codex takes the smaller of the two, so it only ever brings compaction earlier. `model_auto_compact_token_limit_scope` (`total`, the default, or `body_after_prefix`) says what it counts; `fix` leaves it alone.

**What a rollout records.** Every request is a `token_count` event: the last request's input, cached input and output, and `model_context_window` (95% of the window). A compaction is a `compacted` item (the history it put in place) followed by a `context_compacted` event; the compaction's own request is not recorded. On the author's one compaction the next request's input fell from 243,893 tokens to 22,507.

**How it is measured.** Every rollout of the period (live and archived; a forked rollout's copy of its parent's requests counted once, as `spend` does), replayed request by request at 100k, 150k and 200k: as billed, and compacting when a turn's input and output reach the limit. After a simulated compaction the context restarts at the size the user's own compactions left (the median; 25k when there are none), the request after it pays the input rate on all of it (nothing cached yet), and each later request is charged less the removed tokens at the rate it billed them (cached tokens at the cached rate, 10% of input; the rest at the input rate). Each simulated compaction pays a request reading the context and a 5,000-token summary at the output rate: an estimate, since Codex records neither. Prices are `pricing.ts`'s OpenAI rows; a model without one (gpt-6 for now) counts as unpriced. `fix` offers 150k when it saves at least $1 and 2% of Codex's input, and lists the others.

**Quality.** As with `compact-window`: more compactions, each replacing history with a summary. What the summary dropped, and the files Codex reads again because of it, is not priced.

**Edits, and undo.** Only the one line changes: put after your last top-level key (above the first `[table]`, so a comment above a table stays with it; after the whole of a multi-line array or string, never inside it), with your file's own line ends; comments, tables and the rest stay byte for byte. Written atomically under the record's lock and a lock beside `config.toml`. `fix undo` puts the whole file back when nothing touched it since, removes the file if `fix` created it, and otherwise removes just the line if it still holds `fix`'s value. A value already at the top of `config.toml` is yours and never overwritten; a profile that sets its own (`[profiles.<name>]`, or a dotted `profiles.<name>.model_auto_compact_token_limit`; Codex may use it when run with `--profile`) and a project's `.codex/config.toml` that sets it are named as overrides.

**With no Claude Code.** `fix` plans and applies this on a machine with only Codex: it makes no `~/.claude`, and keeps its record of what it applied in the state folder the ledger uses there (`$XDG_STATE_HOME/context-doctor`, else `~/.local/state/context-doctor`; `%LOCALAPPDATA%\context-doctor` on Windows).

**On the author's machine** (2026-11-04, read-only): 4 rollouts, 6 requests and $0.05 of Codex input in the last 30 days, no compaction: nothing to save, so `fix` does not offer it there. Over the last year (123 rollouts, $7.63): 150k would have saved $1.24 (16%), 4 compactions instead of 1. At the list prices read 2026-11-06 (gpt-5.5 $5 in, $0.50 cached, until then priced as gpt-5 at $1.25): $22.90 of input, 150k $4.24 (19%). The tests run the replay on synthetic rollouts.

**Gemini CLI.** Its documented setting is `model.compressionThreshold` in `settings.json` (the share of the context window at which it compresses the history; default `0.5`, restart required; [configuration reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)). Not measured and not offered: there is no Gemini CLI history on the author's machine to replay.

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
