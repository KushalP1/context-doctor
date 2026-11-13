# In the Desktop app and VS Code: the plugin's mod

[← README](../README.md) · [status line](./editor-and-statusline.md) · [fix](./fix.md)

Claude Code's status line never runs in the Desktop app's Code tab or in the VS Code extension, so there the [status line](./editor-and-statusline.md#context-health-in-claude-codes-status-bar)'s cache clock never showed, and the limit ledger `context-doctor limits` reads stayed empty. The Claude Code plugin now carries a **mod**: code that Claude Code runs inside the session (in the terminal from 2.1.287, the Desktop app from 2.1.286, the VS Code extension from 2.1.299). It does three things.

**After each turn, it keeps the measurements.** Claude Code hands mods the rate-limit windows (Pro and Max) and its own cost of the session (`/cost`'s figure). The mod passes them to `context-doctor mod measure`, which:

- appends the 5-hour and weekly readings to `~/.claude/.context-doctor-limits.jsonl`, in the status line's format and with its rules (only changes, at most once a minute, never a lower figure of the same window from a parallel session), so `context-doctor limits` gets Claude readings from the Desktop app too;
- writes Claude Code's cost beside context-doctor's own price of the same session (the transcript and its subagents, priced as the every-prompt hook prices them) to `~/.claude/.context-doctor-session-cost.jsonl`, one line when either figure moves, capped at 512 KB. `context-doctor doctor` then says how close the two are: `Session price vs Claude Code: 11 of 12 sessions the mod measured in the last 30 days within 2% of Claude Code's own cost; the largest gap is +8% ($2.70 against $2.50, on claude-…)`. A model missing from context-doctor's price table, or contracted rates Claude Code gets from an MDM profile or server-managed settings (context-doctor reads `modelPricing` only from the managed settings files, [spend](./spend.md)), shows up as a gap; so does any error in context-doctor's estimate of a compaction's own request, which Claude Code's figure holds as billed and the transcript records no usage for ([spend](./spend.md)).

**A band above the prompt, only when it pays.** In the Desktop app (Claude Code draws a mod's band in the terminal and the Desktop app; the VS Code extension has no such band, so there the mod keeps the measurements and opens the fix pane, and draws nothing above the prompt):

```
context-doctor: cache warm for 3 min, then your next message re-writes 520k tokens (~$5.20) · session $42.10 (Claude Code: $41.90)   [ Hide ]
```

It shows before the cache goes cold on a context of 150k tokens or more (in the 1-hour cache's last five minutes; in the 5-minute cache's last minute, a fifth of its life, so it does not follow every turn), once the cache has expired, and when the session passes a price threshold ($25, $100, $500, or `CONTEXT_DOCTOR_SESSION_PRICE`). Otherwise it stays away. The cache's life is read from the transcript (the 5-minute or 1-hour entries the last reply wrote), because mods are not handed Claude Code's `prompt_cache`; so the miss causes the status line records stay status-line-only. `Hide` hides that state for the session; the next one shows again. `CONTEXT_DOCTOR_MOD_BAND=always` keeps the clock and the price up at all times. In the terminal the status line already shows both, so there the band appears only for the next case.

**On a cold return, a Compact first button.** Back at a session of 150k tokens or more after its cache expired (past the cache's life by five minutes, as the every-prompt hook's cold-resume notice decides), the band says what the next message will re-write and offers:

```
context-doctor: idle 1h 20m, the cache expired: your next message re-writes 520k tokens (~$5.20) · session $42.10
[ Compact first ]  Compact first: each later message re-reads ~$0.26 of context now, ~$0.02 after   [ Hide ]
```

The button calls Claude Code's own compaction (`/compact`), between turns only: while a turn runs there is no button, and a press that meets one is a toast, not a compaction. A compaction Claude Code refuses for another reason (nothing to compact, a failed summary) is a toast with Claude Code's own reason. It is not offered past the point where Claude Code compacts by itself. Each press is counted in the cost ledger, so how often it is taken can be compared with the text offer's 1 in 33.

**`/context-doctor-fix`: the plan as buttons.** The command opens a pane with [`fix`](./fix.md)'s plan: each lever with its dollars over your last 30 days, its quality note and what it changes, and an **Apply** button; a lever `fix` applied has **Undo**. Each press runs the CLI's own `context-doctor fix --apply <id>` or `fix undo <id>`: the same lock, the same record in `~/.claude/.context-doctor-fixes.json`, the same files byte for byte as in a terminal. The subagents' model is marked **Apply (model change)** with a line saying its quality cost is not measured. A press while another `fix` holds the settings lock changes nothing and says so. Measuring takes a while on a long history, so a press does not re-measure: **Refresh** does. The command itself runs no Claude turn and costs no tokens.

Nothing happens without a press: the mod never compacts and never applies a fix by itself. It writes no file of its own; the CLI it runs writes context-doctor's usual files. It needs `node` on the PATH Claude Code starts with, as the plugin's other hooks do; without it, the band falls back to Claude Code's own cost figure, at the thresholds `CONTEXT_DOCTOR_SESSION_PRICE` sets (none with `CONTEXT_DOCTOR_NO_SESSION_PRICE=1`), and the pane says why it has no plan.

## Turning it off

- **The mod alone:** `CONTEXT_DOCTOR_NO_MOD=1` in the environment Claude Code starts with (or in the `env` of `~/.claude/settings.json`). It then registers no command, draws nothing and runs nothing; the plugin's hooks, skills and MCP server stay.
- **Parts of what it keeps:** `CONTEXT_DOCTOR_NO_LIMITS_LOG=1` (the limit readings, as for the status line), `CONTEXT_DOCTOR_NO_COST_LOG=1` (the cost ledger).
- **Every mod at once:** Claude Code's own switches: `"disableAllHooks": true` (which also stops settings hooks and the status line), or `--safe-mode` for one session. Disabling the context-doctor plugin in `/plugin` removes the mod with the rest of the plugin.

An older Claude Code (before 2.1.286) does not run mods. The mod is named in `hooks/hooks.json`, beside only the model-switch hook, so a version that refused that file would lose that one hook and nothing else of the plugin.

## Checked every week on the newest Claude Code

A canary ([`scripts/canary.mjs`](../scripts/canary.mjs)) runs the plugin in a real Claude Code with no person and no network: `claude -p --plugin-dir` against a local mock of Anthropic's API, in a throwaway home with a made-up credential. It checks that the plugin loads, its hooks run (the every-prompt hook, the subagent and model-switch prices, the compaction instructions), that the mod's `session.measure` fires and writes the limits and cost ledgers above, and that `claude plugin validate --profile directory --strict` passes. It runs weekly on npm's newest Claude Code and in the release checks, and goes red on each planted fault (a broken hooks file, a mod that throws on load, a renamed event, a hook that fails or prints invalid JSON). The band and its buttons are drawn by the app, which a headless session does not show; the mods test harness checks those. Details in [CONTRIBUTING](../CONTRIBUTING.md#checks-beyond-npm-test).
