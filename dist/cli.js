#!/usr/bin/env node
/**
 * context-doctor CLI
 *
 *   context-doctor analyze <file|-> [--model claude-sonnet-5] [--json]
 *   context-doctor optimize <file|-> [--out file] [--strategy s]... [--keep-recent N] [--max-tool-tokens N]
 *
 * `-` reads from stdin, so you can pipe: `cat chat.json | context-doctor analyze -`
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseConversation } from "./parse.js";
import { profileConversation } from "./profile.js";
import { optimizeConversation, STRATEGY_IDS } from "./optimize.js";
import { commandHelp, didYouMean } from "./clihelp.js";
import { selfCommand, withInvocation } from "./invocation.js";
import { renderProfile } from "./report.js";
import { formatTokens } from "./tokens.js";
import { startProxy } from "./proxy.js";
import { claudeCodeInstallsFromEnv, claudePluginEnabled, runInstall, runUninstall } from "./install.js";
import { listSessions, parseSessionFile, pickCurrentSession, isClaudeSession } from "./session.js";
import { runHook } from "./hook.js";
import { abCommand } from "./ab.js";
import { buildImpactReport } from "./impact.js";
import { measureTokenizer, renderTokenizer } from "./tokenizer-measure.js";
import { autopilotOff, autopilotOn, autopilotPauseResult, autopilotPaths, autopilotStatus, DEFAULT_AUTOPILOT_PORT } from "./autopilot.js";
import { estimateSavings, renderSavings, renderShare } from "./savings.js";
import { currentCompactWindow, estimateCompactWindows, MAX_WINDOW, MIN_WINDOW, parseWindow, renderCompactWindows, setCompactWindow, settingsPath } from "./compactwindow.js";
import { tilde } from "./claudedir.js";
import { renderPreferences, copyToClipboard, CHAT_PREFERENCES } from "./preferences.js";
import { recordLedger } from "./ledger.js";
import { runDoctor } from "./doctor.js";
import { measureAccuracy, renderAccuracy } from "./accuracy.js";
import { renderDiff } from "./diff.js";
import { renderExperiment, runExperiment } from "./experiment.js";
import { runStatusLine } from "./statusline.js";
import { renderSubagents, subagentReport } from "./subagents.js";
import { findPreset, PRESETS, RC_FILENAME } from "./config.js";
import { runWatch } from "./watch.js";
import { exactTokenCount } from "./exact.js";
import { modelFamily, recordCalibration } from "./calibration.js";
import { checkBudget, loadConfig, sanitizeRoutes, validateRoutes } from "./config.js";
import { startDashboard } from "./dashboard.js";
import { listCursorChats, parseCursorChat } from "./cursor.js";
import { analyzeCacheUsage, renderCacheReport } from "./cache.js";
import { renderToolTimings } from "./timing.js";
import { packContextSemantic, readSources, renderPack } from "./pack.js";
import { measureBaselines, measureMcpSizes, overheadReport, renderOverhead } from "./overhead.js";
import { applySplit, planSplit, renderSplit } from "./split.js";
import { ciReport, renderCiMarkdown, renderCiText } from "./ci.js";
import { renderReads, repeatedReads } from "./reads.js";
import { costPerTask, renderTasks } from "./tasks.js";
import { planCache, renderCachePlan } from "./cacheplan.js";
import { cacheMisses, cacheMissesLine, cacheMissesSignificant, renderCacheMisses } from "./cachemisses.js";
import { renderPayback, subagentPayback } from "./subagentpay.js";
import { compactionQuality, renderCompactionQuality } from "./compactquality.js";
import { isHandoffId, listHandoffs, readHandoff, renderHandoffList, stripControls } from "./handoff.js";
import { claudeLimitFit, limitSavingsLines, limitsReport, renderLimits } from "./limits.js";
import { currentTranscript, findSession, recall, renderRecall } from "./recall.js";
import { measureSubagentCosts, renderCostMedians, saveSubagentCosts } from "./fanout.js";
import { applyPrune, canonical, installedSkills, planPrune, renderPrune, undoPrune } from "./prune.js";
import { lensOverSessions, renderLens, sessionLens } from "./lens.js";
import { applyFix, fixOverrides, loadFixRecords, parseFixIds, planFixes, readFixRecords, renderFixPlan, renderFixShare, savedSince, undoFixes } from "./fix.js";
import { claudeMcpConfigs } from "./mcpschema.js";
import { effectiveEnv, settingsSources } from "./effective.js";
import { SettingsError } from "./settingsedit.js";
import { currentTtl, estimateCacheTtl, renderCacheTtl, setCacheTtl, settingKey, ttlUnsupported, CACHE_TTL_SINCE } from "./cachettl.js";
import { claudeDir } from "./claudedir.js";
const HELP = `context-doctor — profile and optimize LLM context windows

Start here:
  context-doctor install [--statusline]         Wire everything it finds: the MCP server (Claude
                                                Desktop, Claude Code, Cursor, Codex, Gemini CLI,
                                                GitHub Copilot), the skill (Claude Code, Codex), the
                                                every-prompt hook (Claude Code, Codex, Gemini CLI's
                                                BeforeAgent, Cursor's postToolUse), Claude Code's
                                                PreCompact hook, which tells each compaction what to
                                                keep, and Copilot's sessionStart (the standing rules)
  context-doctor savings [--days n] [--share [--copy]]
                                                What your recent Claude Code sessions cost, and what
                                                /compact at cold resumes, autopilot and an earlier
                                                auto-compact window would save, replayed and priced
                                                as billed. --share: totals only, to paste. Also
                                                what a bare \`context-doctor\` shows
  context-doctor fix [--apply ids|all] [--share] What to change, ranked by dollars on your own
                                                sessions (compact earlier, the cache lifetime,
                                                autopilot, MCP tool search, unused servers): each
                                                applied only on a yes, \`fix undo\` reverts them,
                                                later runs show what each saved since
  context-doctor doctor                         Self-check the installation (configs, hook, skill,
                                                MCP handshake) with one pasteable diagnosis
  context-doctor uninstall                      Undo install
  context-doctor --version                      Print the installed version

Measure:
  context-doctor analyze  <file|->  [options]   Show what's eating your tokens
  context-doctor session [file]                 Profile a Claude Code session transcript or a
                                                ChatGPT export (default: this session; --list to browse)
  context-doctor cursor [--list]                Profile a Cursor chat from its local history
  context-doctor overhead [--days n] [--mcp]    What every request re-reads before your message:
                                                measured first-request size, each CLAUDE.md /
                                                AGENTS.md / rules file priced per month, findings
  context-doctor report                         Impact report: exact proxy savings, hook activity,
                                                and remaining recoverable waste in recent sessions
  context-doctor subagents [--days n]           Which subagents paid for themselves: their bill vs
                                                the same steps run in the parent session
  context-doctor tasks [--days n]               Cost per commit, per project: session cost at list
                                                price vs commits made during the sessions
  context-doctor reads [--days n] [--limit n]   Files read into session after session: reads, tokens,
                                                cost, and whether a CLAUDE.md summary or pack pays
  context-doctor compactions [--days n]         Do sessions work worse right after compacting? Re-reads,
                                                tool errors and your corrections, before vs after
  context-doctor limits [--days n]              Your plan's limits in their own unit: the 5-hour and
                                                weekly windows (Claude Pro/Max, via the status line)
                                                and Codex's, the pace, when each runs out, and what
                                                1M tokens of each kind cost in %, fitted on your own
                                                readings with the fit's error
  context-doctor cache-misses [--days n]        Requests that re-wrote the prompt cache while it was
                                                still warm: priced, by model and context size, with
                                                the cause where the transcript shows one
  context-doctor accuracy                       Measure the token heuristic against the API's own
                                                counts recorded in your transcripts (--limit n)
  context-doctor diff <before> <after>          Compare two profiles: what moved, which findings
                                                were resolved, and what it saves
  context-doctor watch [file]                   Live-monitor a growing session/agent trace: running
                                                token/cost line per change, new findings as they appear
                                                (--interval-ms n, default 2000)
  context-doctor dashboard                      Local savings dashboard on 127.0.0.1 (--port n,
                                                default 8790) — charts from your own machine only
  context-doctor experiment --task "<t>"         Run one task twice from the same commit, in a fresh
                                                session and forked from an --existing one; compare
                                                bill, cache, time, and whether --check passed
  context-doctor ab [--lever rules|autoclear|pack|compact|all] [--tasks a,b] [--repeat n] [--yes]
                                                Does a lever cost quality? 8 small coding tasks, each
                                                run with and without it through the Messages API and
                                                scored by a hidden check: passes, tokens, cost side by
                                                side. Bills ANTHROPIC_API_KEY: prints the estimate,
                                                sends nothing without --yes, never passes --budget usd.
                                                --list shows the tasks; --model (default claude-opus-5-5)

Fix automatically:
  context-doctor autopilot on|off|pause|resume|status
                                                Every new Claude Code session started in a terminal
                                                or IDE goes through the local proxy, which clears
                                                stale tool output only when the prompt cache is
                                                cold (never costs more). The desktop app's Code tab
                                                sets its own API address, so it is not reached
  context-doctor compact-window [status|off|<size>]
                                                Claude Code's own auto-compact window (e.g. 400k):
                                                what each size would have saved on your sessions,
                                                and set or remove it. Works in the desktop app too
  context-doctor cache-ttl [status|1h|5m|off] [--subagents]
                                                How long Claude Code's prompt cache lives (5 minutes
                                                or 1 hour), replayed on your own pauses: what each
                                                would have cost, then set or remove promptCacheTtl
                                                (--subagents: subagentPromptCacheTtl). Same content
                                                either way: price only. Desktop app too
  context-doctor proxy --autopilot  [options]   Local proxy for your own API apps (Anthropic, OpenAI,
                                                Gemini): clears stale tool output only when the
                                                prompt cache is cold, so it never costs more.
                                                Plain \`proxy\` is the optimizing mode (dedupe, trim,
                                                strip base64), which can cost more on cached traffic

Fix on request:
  context-doctor optimize <file|->  [options]   Apply safe fixes, print slimmed conversation
  context-doctor overhead prune [--days n] [--write] [--undo]
                                                MCP servers and skills each project has not used in
                                                n days (default 30), from its transcripts; --write
                                                switches them off for this folder's project in its
                                                .claude/settings.local.json (backup kept), --undo
                                                takes exactly those entries out. Never the app's
                                                connectors, plugins, or context-doctor itself
  context-doctor overhead split <file> [--min-tokens n] [--write]
                                                Move a memory file's big sections to a reference
                                                file, leaving pointers (plan first; --write backs up)
  context-doctor pack <files|dirs...|-> -q "<q>" [--max-tokens n]
                                                Only the parts of big docs/code a question needs:
                                                chunk along headings and declarations, rank, fit a
                                                token budget (default 4000). No --query: an outline
                                                to pick from (--ids a#2,b#5). Offline, no API key.
                                                --semantic: also rank by meaning with a local
                                                Ollama embedding model, when one is installed
                                                (--embed-model <name> picks it)
  context-doctor cache-plan <request.json> [--calls n] [--out file] [--explicit]
                                                Where an Anthropic request should carry cache_control,
                                                what it saves over n calls; --out writes it applied
                                                (top-level automatic caching unless --explicit)
  context-doctor recall "<query>" [--session <id|path>] [--max-tokens n]
                                                Search this session's own transcript on disk (turns
                                                before a compaction, tool output cleared from the
                                                context) and print the best excerpts with their time
                                                and position; secrets masked. Default session: this
                                                one (CLAUDE_CODE_SESSION_ID, else this folder's newest)
  context-doctor handoff [list|show <id>|latest] [--copy]
                                                Handoffs saved from chat apps (the \`handoff\` prompt or
                                                save_handoff): list them, print one, or --copy it to
                                                paste as the first message of a new chat

Integrations:
  context-doctor ci [--base <ref>] [--max-tokens n] [--max-increase n] [--markdown]
                                                For pull requests: memory files (CLAUDE.md, AGENTS.md,
                                                GEMINI.md, rules) at HEAD vs base; exit 1 over budget
  context-doctor instructions [--copy]          Standing context rules to paste into claude.ai or
                                                ChatGPT preferences (works on web and mobile too)
  context-doctor init [preset]                  Write a .contextdoctorrc from a preset
                                                (chat, agent, batch; no argument lists them)

Internal (Claude Code and MCP clients run these for you):
  context-doctor hook [copilot]                 The every-prompt and PreCompact hook; \`hook copilot\`
                                                is GitHub Copilot's sessionStart (installed by
                                                \`install\`; reads hook JSON on stdin)
  context-doctor statusline                     Claude Code status bar line: live context size, cache
                                                share, cost (wired by \`install --statusline\`; reads
                                                the status JSON on stdin)
  context-doctor mcp [--http]                   The MCP server (same as context-doctor-mcp), for clients
                                                that launch \`npx -y context-doctor mcp\`

Project config: an optional .contextdoctorrc (nearest, walking up from cwd, then
~/.contextdoctorrc) can set a context budget and default strategies:
  {"budget":{"maxTokens":120000,"maxCostPerMessageUsd":0.5,"maxWindowPct":60},
   "strategies":["dedupe","trim-tool-results"],"routes":[...]}

Input: a conversation JSON file (OpenAI or Anthropic message format, or a bare
message array). Use "-" to read from stdin.

Options:
  --model <name>          Model name for window-size math (e.g. claude-sonnet-5, gpt-4o)
  --exact                 (analyze) Add an exact token count: Anthropic count-tokens API for
                          Claude models (needs ANTHROPIC_API_KEY), tiktoken for GPT (if installed)
  --redact                Mask message previews and file paths in the report, so it can be
                          shared in a bug report without leaking conversation content
  --json                  Machine-readable output
  --fail-over-budget      (analyze/session) Exit 1 when the .contextdoctorrc budget is
                          exceeded — lets CI gate a pull request on context size
  --out <file>            (optimize) Write result to file instead of stdout
  --strategy <id>         (optimize) Strategy to run; repeatable.
                          Available: dedupe, trim-tool-results, trim-tool-calls, strip-base64,
                          prune-history
                          Default: dedupe, trim-tool-results, strip-base64 (lossless-ish set)
  --keep-recent <n>       (optimize) Messages at the tail to leave untouched (default 6)
  --max-tool-tokens <n>   (optimize) Token budget for trimmed tool results (default 300)
  --limit <n>             (accuracy, session --list, reads, tasks, subagents) How many to sample
                          or list
  --days <n>              (savings, compact-window, cache-ttl, overhead, reads, tasks, subagents,
                          compactions, cache-misses, limits)
                          Days of history to read (default 30; compactions 60)
  -q, --query <text>      (pack) The question to rank chunks against
  --max-tokens <n>        (pack) Token budget (default 4000); (recall) default 2000; (ci) fail over
                          this many tokens
  --session <id|path>     (recall) Search this session instead of the current one
  --chunk-tokens <n>      (pack) Largest chunk, in tokens (default 400)
  --ids <a#2,b#5>         (pack) Return these chunks by id
  --include-secrets       (pack) Also pack .env, .npmrc, private keys and other credential files,
                          and paths under ~/.ssh, ~/.aws and similar (skipped by default)
  --min-tokens <n>        (overhead split) Smallest section to move, in tokens (default 400)
  --requests-per-day <n>  (ci --markdown) Price the change at this many requests a day
  --check <cmd>           (experiment) Command whose exit code is the pass/fail for each arm
  --existing <id>         (experiment) Session id to fork the second arm from (never mutated)
  --budget <usd>          (experiment) Spend cap per arm (default 1)
  --dry-run               (experiment) Print the claude commands and stop
  --allow-dirty           (experiment) Skip the clean-tree check (uncommitted changes will be lost)
  --statusline            (install) Also set Claude Code's statusLine to context-doctor (never
                          overwrites a statusLine you already have)
  --autopilot             (proxy) Cold-cache clearing only, the mode \`autopilot on\` runs; never
                          costs more. Without it the proxy runs the optimizing strategies
  --port <n>              (proxy) Port to listen on (default 8787)
  --host <addr>           (proxy) Bind address (default 127.0.0.1; use 0.0.0.0 to expose)
  --token <secret>        (proxy) Require /t/<secret>/ in every request path; needed before
                          putting the proxy on a public URL (Cursor BYO-key, tunnels).
                          Also read from CONTEXT_DOCTOR_PROXY_TOKEN
  --config <file>         (proxy) Per-route overrides: {"routes":[{"modelPrefix":"gpt","strategies":[...],
                          "keepRecent":n,"maxToolResultTokens":n}]} — first prefix match wins
  --upstream-anthropic <url>  (proxy) Override Anthropic upstream (testing)
  --upstream-openai <url>     (proxy) Override OpenAI upstream (testing)
  --upstream-google <url>     (proxy) Override Gemini upstream (testing)
  -h, --help              Show this help

Examples:
  context-doctor analyze chat.json --model claude-sonnet-5
  context-doctor optimize chat.json --strategy dedupe --strategy prune-history --out slim.json
  context-doctor proxy --autopilot --port 8787
    then: export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
          export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
          export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8787
`;
/**
 * What a bare `context-doctor` prints when there is no Claude Code history
 * to measure, or when stdout is not a terminal: where to begin, in a dozen
 * lines, instead of the full reference above.
 */
const START_HERE = `context-doctor: see where your Claude Code tokens go, and cut them.

Start here
  In Claude Code, as a plugin:
    /plugin marketplace add KushalP1/context-doctor
    /plugin install context-doctor@context-doctor
    then /context-doctor:fix, :savings, :checkup, :overhead, :compact-window, :autopilot, :pack
  In a terminal:
    context-doctor fix         what to change, ranked by what it saves you; applied only on a yes
    context-doctor install     wire the MCP server, skill and hooks into the apps it finds
    context-doctor savings     what your recent sessions cost, and what each fix would save
    context-doctor doctor      check the installation

All commands: context-doctor --help
Guide: https://github.com/KushalP1/context-doctor#readme`;
/**
 * Everything `fix` ranks, measured on this machine's history (read-only):
 * the same replays `savings`, `compact-window` and `cache-ttl` run.
 */
async function measureFixInputs(days) {
    const cwd = process.cwd();
    const autopilotOnNow = existsSync(autopilotPaths().config);
    // With autopilot already on, its replay (most of the time) answers nothing `fix` asks.
    const replaying = progressLine(autopilotOnNow ? "Reading your Claude Code sessions" : "Replaying your Claude Code sessions");
    const report = estimateSavings(days, {}, undefined, replaying.tick, !autopilotOnNow);
    replaying.clear();
    const setWindow = currentCompactWindow();
    let compactWindow;
    if (setWindow !== undefined) {
        compactWindow = { window: setWindow, savedUsd: 0, savedShare: 0, compactionsPerWeek: 0, nowPerWeek: 0, current: setWindow };
    }
    else {
        const measuring = progressLine("Measuring your compactions");
        const reread = compactionQuality(60, undefined, measuring.tick).extraRereadTokensPerCompaction;
        measuring.clear();
        const windowing = progressLine("Replaying an earlier auto-compact window");
        const cw = estimateCompactWindows([400_000], days, undefined, reread, windowing.tick);
        windowing.clear();
        const est = cw.estimates[0];
        if (cw.sessions > 0 && est)
            compactWindow = { window: est.window, savedUsd: est.savedUsd, savedShare: est.savedPct, compactionsPerWeek: (est.compactions / cw.days) * 7, nowPerWeek: (cw.actualCompactions / cw.days) * 7 };
    }
    const ttling = progressLine("Replaying both cache lifetimes");
    const ttl = estimateCacheTtl(days, { onProgress: ttling.tick });
    ttling.clear();
    const sources = settingsSources({ cwd });
    const ts = effectiveEnv("ENABLE_TOOL_SEARCH", sources);
    const toolSearchOff = ts && /^(false|0|no|off)$/i.test(ts.value.trim()) ? ts.value : undefined;
    const servers = claudeMcpConfigs(cwd).filter((c) => !/context-doctor/i.test(c.name));
    // Prune reads every transcript for MCP and skill use: only when this project has something to prune.
    let prunePlan;
    if (servers.length > 0 || installedSkills(cwd).some((k) => !/context-doctor/i.test(k.name))) {
        try {
            prunePlan = planPrune(days, { cwds: [cwd] }).plans[0];
        }
        catch { /* no project here */ }
    }
    let userSettings = {};
    try {
        userSettings = JSON.parse(readFileSync(join(claudeDir(), "settings.json"), "utf8")) ?? {};
    }
    catch { /* none */ }
    let recordProblem;
    try {
        loadFixRecords();
    }
    catch (e) {
        recordProblem = e.message;
    }
    const sessions = report.sessions.length;
    const ids = ["compact-window", "cache-ttl", "cache-ttl-subagents", "tool-search"];
    return {
        prunePlan,
        inputs: {
            days,
            billedUsd: report.billedUsd,
            compactWindow,
            ttl,
            currentTtl: currentTtl(),
            autopilot: { on: autopilotOnNow, reachableUsd: report.reachableUsd, reachableShare: report.billedUsd > 0 ? report.reachableUsd / report.billedUsd : 0, unreachableSessions: report.unreachableSessions, sessions },
            toolSearchOff,
            mcpServers: toolSearchOff ? servers.length : 0,
            prune: prunePlan,
            overrides: Object.fromEntries(ids.map((id) => [id, fixOverrides(id, { cwd })])),
            recordProblem,
            coldResume: { netUsd: Math.max(0, report.coldResumeNetUsd), returns: report.coldResumes, hooked: claudePluginEnabled() || /context-doctor|cli\.js"?\s+hook/.test(JSON.stringify(userSettings.hooks?.UserPromptSubmit ?? [])) },
        },
    };
}
/** Exit 1 with a usage message: wrong arguments are the caller's to fix, not a crash. */
function usageError(message) {
    console.error(message);
    process.exit(1);
}
/**
 * Every command main() handles. An unknown one is an error with a
 * suggestion, never a silent fall-through to the help text.
 */
const COMMANDS = [
    "analyze", "optimize", "proxy", "install", "uninstall", "savings", "compact-window", "autopilot", "mcp",
    "instructions", "session", "cursor", "statusline", "hook", "report", "doctor", "dashboard", "init",
    "experiment", "diff", "accuracy", "overhead", "ci", "cache-plan", "compactions", "cache-misses", "cache-ttl", "fix", "limits", "subagents", "tasks",
    "reads", "pack", "watch", "ab", "handoff", "recall", "help", "version",
];
/** --strategy takes one of the optimizer's ids; a typo used to run nothing and report success. */
function strategyArg(v) {
    if (STRATEGY_IDS.includes(v))
        return v;
    return usageError(`--strategy "${v}" is not a strategy.${didYouMean(v, STRATEGY_IDS)} Available: ${STRATEGY_IDS.join(", ")}.`);
}
const FLAGS = [
    { names: ["--json"], set: (a) => { a.json = true; } },
    { names: ["--list"], set: (a) => { a.list = true; } },
    { names: ["--exact"], set: (a) => { a.exact = true; } },
    { names: ["--redact"], set: (a) => { a.redact = true; } },
    { names: ["--fail-over-budget"], set: (a) => { a.failOverBudget = true; } },
    { names: ["--model"], value: "text", set: (a, v) => { a.model = v; } },
    { names: ["--out"], value: "text", set: (a, v) => { a.out = v; } },
    { names: ["--strategy"], value: "text", set: (a, v) => { a.strategies.push(strategyArg(v)); } },
    { names: ["--keep-recent"], value: "number", num: { min: 0, integer: true }, set: (a, v) => { a.keepRecent = v; } },
    { names: ["--max-tool-tokens"], value: "number", num: { min: 1, integer: true }, set: (a, v) => { a.maxToolTokens = v; } },
    { names: ["--port"], value: "number", num: { min: 0, max: 65535, integer: true }, set: (a, v) => { a.port = v; } },
    { names: ["--interval-ms"], value: "number", num: { min: 100, integer: true }, set: (a, v) => { a.intervalMs = v; } },
    { names: ["--limit"], value: "number", num: { min: 1, integer: true }, set: (a, v) => { a.limit = v; } },
    { names: ["--task"], value: "text", set: (a, v) => { a.task = v; } },
    { names: ["--check"], value: "text", set: (a, v) => { a.check = v; } },
    { names: ["--existing"], value: "text", set: (a, v) => { a.existing = v; } },
    { names: ["--budget"], value: "number", num: { min: 0 }, set: (a, v) => { a.budgetUsd = v; } },
    { names: ["--lever"], value: "text", set: (a, v) => { (a.levers ??= []).push(v); } },
    { names: ["--tasks"], value: "text", set: (a, v) => { (a.abTasks ??= []).push(v); } },
    { names: ["--repeat"], value: "number", num: { min: 1, integer: true }, set: (a, v) => { a.repeat = v; } },
    { names: ["--max-turns"], value: "number", num: { min: 1, integer: true }, set: (a, v) => { a.maxTurns = v; } },
    { names: ["--concurrency"], value: "number", num: { min: 1, integer: true }, set: (a, v) => { a.concurrency = v; } },
    { names: ["--yes"], set: (a) => { a.yes = true; } },
    { names: ["--dry-run"], set: (a) => { a.dryRun = true; } },
    { names: ["--copy"], set: (a) => { a.copy = true; } },
    { names: ["--share"], set: (a) => { a.share = true; } },
    { names: ["--allow-dirty"], set: (a) => { a.allowDirty = true; } },
    { names: ["--statusline"], set: (a) => { a.statusLine = true; } },
    { names: ["--host"], value: "text", set: (a, v) => { a.host = v; } },
    { names: ["--token"], value: "text", set: (a, v) => { a.token = v; } },
    { names: ["--days"], value: "number", num: { min: 1 }, set: (a, v) => { a.days = v; } },
    { names: ["--autopilot"], set: (a) => { a.autopilot = true; } },
    { names: ["--autopilot-state"], value: "text", set: (a, v) => { a.autopilotState = v; } },
    { names: ["--autopilot-pause-file"], value: "text", set: (a, v) => { a.autopilotPauseFile = v; } },
    { names: ["--config"], value: "text", set: (a, v) => { a.config = v; } },
    { names: ["-q", "--query"], value: "text", set: (a, v) => { a.query = v; } },
    { names: ["--max-tokens"], value: "number", num: { min: 1, integer: true }, set: (a, v) => { a.maxTokens = v; } },
    { names: ["--chunk-tokens"], value: "number", num: { min: 50, integer: true }, set: (a, v) => { a.chunkTokens = v; } },
    { names: ["--mcp"], set: (a) => { a.mcp = true; } },
    { names: ["--write"], set: (a) => { a.write = true; } },
    { names: ["--undo"], set: (a) => { a.undo = true; } },
    { names: ["--subagents"], set: (a) => { a.subagentsTtl = true; } },
    { names: ["--apply"], value: "text", set: (a, v) => { a.apply = v; } },
    { names: ["--calls"], value: "number", num: { min: 1, integer: true }, set: (a, v) => { a.calls = v; } },
    { names: ["--explicit"], set: (a) => { a.explicit = true; } },
    { names: ["--semantic"], set: (a) => { a.semantic = a.semantic || true; } },
    { names: ["--embed-model"], value: "text", set: (a, v) => { a.semantic = v; } },
    { names: ["--include-secrets"], set: (a) => { a.includeSecrets = true; } },
    { names: ["--base"], value: "text", set: (a, v) => { a.base = v; } },
    { names: ["--markdown"], set: (a) => { a.markdown = true; } },
    { names: ["--max-increase"], value: "number", num: { min: 0, integer: true }, set: (a, v) => { a.maxIncrease = v; } },
    { names: ["--requests-per-day"], value: "number", num: { min: 1 }, set: (a, v) => { a.requestsPerDay = v; } },
    { names: ["--min-tokens"], value: "number", num: { min: 50, integer: true }, set: (a, v) => { a.minTokens = v; } },
    { names: ["--session"], value: "text", set: (a, v) => { a.session = v; } },
    { names: ["--ids"], value: "text", set: (a, v) => { a.ids = v.split(",").map((x) => x.trim()).filter(Boolean); } },
    { names: ["--upstream-anthropic"], value: "text", set: (a, v) => { a.upstreamAnthropic = v; } },
    { names: ["--upstream-openai"], value: "text", set: (a, v) => { a.upstreamOpenai = v; } },
    { names: ["--upstream-google"], value: "text", set: (a, v) => { a.upstreamGoogle = v; } },
    // Read by the MCP server itself: `mcp --http [--port n] [--host h]`.
    { names: ["--http"], set: () => { } },
    { names: ["--store-handoffs"], set: () => { } },
    { names: ["--allowed-hosts"], value: "text", set: () => { } },
    { names: ["--allowed-origins"], value: "text", set: () => { } },
];
const FLAG_BY_NAME = new Map(FLAGS.flatMap((f) => f.names.map((n) => [n, f])));
const FLAG_NAMES = [...FLAG_BY_NAME.keys(), "--help", "--version"];
/** An option, not a value: "-q", "--days". "-" (stdin) and "-1" are values. */
function looksLikeFlag(s) {
    return /^-[A-Za-z-]/.test(s) && s !== "--";
}
function parseArgs(argv) {
    const args = { json: false, strategies: [], list: false, exact: false, redact: false, failOverBudget: false, dryRun: false, allowDirty: false, statusLine: false, help: false };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const raw = argv[i];
        if (raw === "--") {
            positional.push(...argv.slice(i + 1));
            break;
        }
        if (!looksLikeFlag(raw)) {
            positional.push(raw);
            continue;
        }
        const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
        const name = eq > 0 ? raw.slice(0, eq) : raw;
        const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
        if (name === "-h" || name === "--help") {
            args.help = true;
            continue;
        }
        if (name === "-v" || name === "--version") {
            console.log(packageVersion());
            process.exit(0);
        }
        const spec = FLAG_BY_NAME.get(name);
        if (!spec)
            return usageError(`Unknown option ${name}.${didYouMean(name, FLAG_NAMES)} Run \`context-doctor --help\` for the list.`);
        if (!spec.value) {
            if (inline !== undefined)
                usageError(`${name} takes no value; got "${inline}".`);
            spec.set(args);
            continue;
        }
        let value = inline;
        if (value === undefined) {
            const next = argv[i + 1];
            if (next !== undefined && looksLikeFlag(next)) {
                usageError(`${name} needs a value; got the option ${next}. For a value that starts with "-", write ${name}=<value>.`);
            }
            if (next !== undefined) {
                value = next;
                i++;
            }
        }
        if (spec.value === "number")
            spec.set(args, numArg(name, value, spec.num));
        else if (value === undefined)
            usageError(`${name} needs a value; got nothing.`);
        else
            spec.set(args, value);
    }
    args.command = positional[0];
    args.file = positional[1];
    args.positionals = positional.slice(1);
    return args;
}
/** Print budget status under a profile when a .contextdoctorrc defines one. */
function printBudgetStatus(profile, loaded) {
    const budget = loaded.config.budget;
    if (!budget || !loaded.path)
        return false;
    const verdict = checkBudget(budget, profile);
    console.log("");
    if (verdict.overBudget) {
        console.log(`OVER BUDGET (${loaded.path}):`);
        for (const b of verdict.breaches)
            console.log(`  x ${b}`);
    }
    else {
        console.log(`Within budget (${loaded.path}).`);
    }
    return verdict.overBudget;
}
/** Exit 1 when the caller asked CI to fail on a breach. */
function applyBudgetGate(overBudget, failOverBudget) {
    if (overBudget && failOverBudget) {
        console.error("context-doctor: over budget (--fail-over-budget)");
        process.exitCode = 1;
    }
}
function readInput(file) {
    return stripBom(readFileSync(file === "-" ? 0 : file, "utf8"));
}
/**
 * A UTF-8 byte-order mark (Windows editors, PowerShell's Out-File) is not
 * part of the text: left in, JSON.parse rejects the file and a valid
 * conversation was reported as not being one.
 */
function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
/** The installed package's version, read from its package.json so it cannot drift. */
function packageVersion() {
    try {
        return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    }
    catch {
        return "unknown";
    }
}
/**
 * A numeric flag's value, or exit 1 with a message naming the flag. Number()
 * alone turned `--days abc` into "the last NaN days" and a bad --port into a
 * random port.
 */
function numArg(flag, raw, { min, max, integer } = {}) {
    const n = Number(raw);
    const ok = raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && (!integer || Number.isInteger(n)) && (min === undefined || n >= min) && (max === undefined || n <= max);
    if (!ok) {
        const range = min !== undefined && max !== undefined ? ` between ${min} and ${max}` : min !== undefined ? ` of at least ${min}` : "";
        console.error(`${flag} needs ${integer ? "a whole number" : "a number"}${range}; got ${raw === undefined ? "nothing" : JSON.stringify(raw)}.`);
        process.exit(1);
    }
    return n;
}
/**
 * A one-line "n/N transcripts" counter on stderr while a report reads the
 * history (tens of seconds on a busy machine), in a terminal only: piped or
 * captured output gets none of it. `clear()` erases the line before the
 * report prints.
 */
function progressLine(label) {
    if (!process.stderr.isTTY)
        return { clear() { } };
    let shown = false;
    return {
        tick(done, total) {
            shown = true;
            process.stderr.write(`\r${label}… ${done}/${total} transcripts\x1b[K`);
        },
        clear() {
            if (shown)
                process.stderr.write("\r\x1b[K");
        },
    };
}
/** Any Claude Code transcript on this machine? One directory listing, no parsing. */
function hasClaudeSessions() {
    try {
        return listSessions(1).some((s) => isClaudeSession(s));
    }
    catch {
        return false;
    }
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.command && !COMMANDS.includes(args.command)) {
        usageError(`Unknown command "${args.command}".${didYouMean(args.command, COMMANDS)} Run \`context-doctor --help\` for the list.`);
    }
    if (args.command === "version") {
        console.log(packageVersion());
        return;
    }
    // `<command> --help` and `help <command>`: that command's lines, not all of them.
    if (args.help || args.command === "help") {
        const topic = args.command === "help" ? args.file : args.command;
        if (topic && !COMMANDS.includes(topic)) {
            usageError(`Unknown command "${topic}".${didYouMean(topic, COMMANDS)} Run \`context-doctor --help\` for the list.`);
        }
        console.log((topic && commandHelp(HELP, topic)) || HELP);
        return;
    }
    // Run by hand in a terminal, these waited forever for JSON that only
    // Claude Code sends.
    if ((args.command === "hook" || args.command === "statusline") && process.stdin.isTTY) {
        const setup = args.command === "hook" ? "`context-doctor install` registers it" : "`context-doctor install --statusline` sets it up";
        console.log(`context-doctor ${args.command} is called by Claude Code with JSON on stdin; there is nothing for it to do in a terminal (${setup}).`);
        return;
    }
    if (args.command === "hook") {
        // `hook copilot` is GitHub Copilot's sessionStart; a bare `hook` serves the rest.
        if (args.file !== undefined && args.file !== "copilot")
            usageError(`hook takes no argument, or \`copilot\` (GitHub Copilot's session-start hook); got "${args.file}".`);
        void runHook(args.file === "copilot" ? "copilot" : undefined);
        return;
    }
    if (args.command === "dashboard") {
        startDashboard({ port: args.port, proxyPort: 8787 });
        return; // server keeps the process alive
    }
    if (args.command === "watch") {
        runWatch({ file: args.file, intervalMs: args.intervalMs, model: args.model });
        return; // interval keeps the process alive
    }
    if (args.command === "doctor") {
        void runDoctor();
        return;
    }
    if (args.command === "init") {
        const requested = args.positionals?.[0];
        if (!requested || args.list) {
            console.log("Presets for .contextdoctorrc — pick the one that matches your workload:\n");
            for (const p of PRESETS)
                console.log(`  ${p.id.padEnd(7)} ${p.summary}`);
            console.log(`\nThen: ${selfCommand("init <preset>")}`);
            return;
        }
        const preset = findPreset(requested);
        if (!preset) {
            console.error(`Unknown preset "${requested}". Available: ${PRESETS.map((p) => p.id).join(", ")}`);
            process.exit(1);
        }
        const target = join(process.cwd(), RC_FILENAME);
        if (existsSync(target)) {
            console.error(`${target} already exists — edit it, or delete it first.`);
            process.exit(1);
        }
        writeFileSync(target, JSON.stringify(preset.config, null, 2) + "\n");
        console.log(`✓ Wrote ${target} (${preset.id}: ${preset.summary})`);
        console.log("  Budgets are enforced by the every-prompt hook and reported by analyze/session.");
        console.log("  Gate a pull request on it with: context-doctor analyze <file> --fail-over-budget");
        return;
    }
    if (args.command === "statusline") {
        void runStatusLine();
        return;
    }
    if (args.command === "ab") {
        process.exitCode = await abCommand({
            levers: args.levers, tasks: args.abTasks, model: args.model, repeat: args.repeat, maxTurns: args.maxTurns,
            concurrency: args.concurrency, budgetUsd: args.budgetUsd, yes: args.yes === true, json: args.json, out: args.out, list: args.list,
        });
        return;
    }
    if (args.command === "experiment") {
        if (!args.task) {
            console.error('Usage: context-doctor experiment --task "<what to do>" [--check "<cmd>"] [--existing <session-id>] [--model m] [--budget usd] [--dry-run]');
            process.exit(1);
        }
        const opts = { task: args.task, check: args.check, existing: args.existing, model: args.model, budgetUsd: args.budgetUsd, dryRun: args.dryRun, allowDirty: args.allowDirty };
        const result = runExperiment(opts);
        console.log(args.json ? JSON.stringify(result, null, 2) : renderExperiment(result, opts));
        // No arm completed (claude missing, or every run errored): nothing was
        // compared, and a script must not read exit 0 as a result.
        if (result.refused || (result.arms.length > 0 && result.arms.every((a) => a.error)))
            process.exitCode = 1;
        return;
    }
    if (args.command === "diff") {
        const [before, after] = args.positionals ?? [];
        if (!before || !after) {
            console.error("Usage: context-doctor diff <before> <after>");
            process.exit(1);
        }
        try {
            console.log(renderDiff(before, after, args.model));
        }
        catch (e) {
            console.error(`Could not diff: ${e.message}`);
            process.exit(1);
        }
        return;
    }
    if (args.command === "accuracy") {
        const report = measureAccuracy(args.limit ?? 20);
        const tokenizer = measureTokenizer(Math.max(args.limit ?? 20, 60));
        console.log(args.json ? JSON.stringify({ ...report, tokenizer }, null, 2) : `${renderAccuracy(report)}\n\n${renderTokenizer(tokenizer)}`);
        return;
    }
    if (args.command === "report") {
        void buildImpactReport(args.port).then((r) => console.log(r));
        return;
    }
    if (args.command === "cursor") {
        let chats;
        try {
            // An id is looked up among ALL chats: the default list keeps the 20
            // largest, so a smaller chat's id used to fall through to the biggest one.
            chats = listCursorChats(args.file && !args.list ? Infinity : undefined);
        }
        catch (e) {
            console.error(`Could not read Cursor history: ${e.message}`);
            process.exit(1);
        }
        if (chats.length === 0) {
            console.error("No Cursor chats found (looked in Cursor's global and workspace storage).");
            process.exit(1);
        }
        if (args.list) {
            for (const c of chats) {
                console.log(`${String(c.messageCount).padStart(5)} msgs  ${(c.title ?? "(untitled)").slice(0, 48).padEnd(50)} ${c.composerId}`);
            }
            return;
        }
        // A named chat that does not exist is an error, never a silent profile of another one.
        const chat = args.file ? chats.find((c) => c.composerId === args.file) : chats[0];
        if (!chat) {
            console.error(`No Cursor chat with id "${args.file}" (context-doctor cursor --list shows the ids).`);
            process.exit(1);
        }
        const parsed = parseCursorChat(chat);
        const profile = profileConversation(parseConversation(parsed.conversationJson), args.model ?? parsed.model);
        if (args.json) {
            console.log(JSON.stringify({ chat: { id: chat.composerId, title: chat.title }, profile }, null, 2));
        }
        else {
            console.log(`Cursor chat: ${chat.title ?? "(untitled)"}\nId:          ${chat.composerId}\n`);
            console.log(renderProfile(profile, { redact: args.redact }));
            if (parsed.reportedInputTokens) {
                console.log("");
                console.log(`Measured context (reported by the API on the last request): ${parsed.reportedInputTokens} tokens.\n` +
                    "That figure includes the harness's system prompt, tool schemas and skills, which the\n" +
                    "transcript does not record — so it is larger than the breakdown above, which covers\n" +
                    "conversation messages only. Findings and savings apply to the messages.");
            }
            printBudgetStatus(profile, loadConfig(process.cwd(), (m) => console.error(`context-doctor: ${m}`)));
        }
        return;
    }
    if (args.command === "session") {
        if (args.list) {
            const sessions = listSessions(args.limit ?? 20);
            if (sessions.length === 0) {
                console.log("No sessions found under ~/.claude/projects or ~/.codex/sessions.");
                return;
            }
            for (const s of sessions) {
                console.log(`${s.modifiedAt.toISOString().slice(0, 16)}  ${(s.sizeBytes / 1024).toFixed(0).padStart(6)}KB  ${s.path}`);
            }
            return;
        }
        // No file: the session this runs in (the plugin's checkup runs it from
        // inside one), then this folder's newest, then the machine's newest.
        const picked = args.file ? undefined : pickCurrentSession();
        const path = args.file ?? picked?.path;
        if (!path) {
            console.error("No session transcript found. Pass a .jsonl path or run inside a machine with Claude Code sessions.");
            process.exit(1);
        }
        let parsed;
        try {
            parsed = parseSessionFile(path);
        }
        catch (e) {
            console.error(`Could not read session: ${e.message}`);
            process.exit(1);
        }
        const sessionConversation = parseConversation(parsed.conversationJson);
        // A file that is not a transcript parses to no messages. It used to print
        // the warning inside a normal report and exit 0; analyze exits 1 for the
        // same thing, and a script cannot tell a profile from a non-file otherwise.
        if (sessionConversation.parseWarning) {
            usageError(`Could not profile ${path} as a session: no conversation messages in it. ` +
                "session reads Claude Code, Codex and Gemini CLI transcripts and ChatGPT exports; for a conversation JSON or a prompt, use analyze.");
        }
        const profile = profileConversation(sessionConversation, args.model ?? parsed.model);
        if (args.json) {
            console.log(JSON.stringify({ session: { path: parsed.path, title: parsed.title, ...(picked ? { picked: picked.how } : {}), toolTimings: parsed.toolTimings ?? [], subagents: subagentReport(path) }, profile }, null, 2));
            // --json is what CI pipes, so the gate must hold here too (as it does for
            // analyze); it used to run only after the text report and never failed.
            applyBudgetGate(checkBudget(loadConfig(process.cwd(), (m) => console.error(`context-doctor: ${m}`)).config.budget, profile).overBudget, args.failOverBudget);
        }
        else {
            // Under --redact the title (the user's first prompt) and the path (which
            // names the project) are content too.
            console.log(args.redact
                ? "Session: [redacted]\nFile:    [redacted]"
                : `Session: ${parsed.title ?? "(untitled)"}\nFile:    ${parsed.path}`);
            if (picked)
                console.log(`Picked:  ${picked.how} (pass a file to profile another; --list shows them)`);
            if (parsed.compactedAway) {
                console.log(`Note:    ${parsed.compactedAway} earlier message(s) were compacted away and are NOT counted below — this is the live context the model still sees.`);
            }
            console.log("");
            console.log(renderProfile(profile, { redact: args.redact }));
            if (parsed.reportedInputTokens) {
                console.log("");
                console.log(`Measured context (reported by the API on the last request): ${parsed.reportedInputTokens} tokens.\n` +
                    "That figure includes the harness's system prompt, tool schemas and skills, which the\n" +
                    "transcript does not record — so it is larger than the breakdown above, which covers\n" +
                    "conversation messages only. Findings and savings apply to the messages.");
            }
            const cacheUsage = analyzeCacheUsage(path);
            const cache = renderCacheReport(cacheUsage);
            if (cache) {
                console.log("");
                console.log(cache);
            }
            const timing = renderToolTimings(parsed.toolTimings ?? []);
            if (timing) {
                console.log("");
                console.log(timing);
            }
            const lens = renderLens(sessionLens(path));
            if (lens.length) {
                console.log("");
                console.log(lens.join("\n"));
            }
            const subs = renderSubagents(subagentReport(path), cacheUsage?.paidUsd, 5, { redact: args.redact });
            if (subs) {
                console.log("");
                console.log(subs);
            }
            applyBudgetGate(printBudgetStatus(profile, loadConfig(process.cwd(), (m) => console.error(`context-doctor: ${m}`))), args.failOverBudget);
        }
        return;
    }
    if (args.command === "install") {
        // Partial success is still installed, but not silent: any failed target
        // makes the exit code non-zero so automation can react.
        if (runInstall({ statusLine: args.statusLine }).failures.length > 0)
            process.exitCode = 1;
        return;
    }
    if (args.command === "savings" || (!args.command && process.stdout.isTTY && hasClaudeSessions())) {
        // A bare `context-doctor` in a terminal, with Claude Code history on the
        // machine, answers the question people install this for: what would it
        // save me? Scripts and pipes still get the help text.
        const replaying = progressLine("Replaying your Claude Code sessions through autopilot");
        const report = estimateSavings(args.days ?? 30, {}, undefined, replaying.tick);
        replaying.clear();
        const setWindow = currentCompactWindow();
        const measuring = progressLine("Measuring your compactions");
        const reread = compactionQuality(60, undefined, measuring.tick).extraRereadTokensPerCompaction;
        measuring.clear();
        const windowing = progressLine("Replaying an earlier auto-compact window");
        const cwReport = estimateCompactWindows([setWindow ?? 400_000], args.days ?? 30, undefined, reread, windowing.tick);
        windowing.clear();
        const est = cwReport.estimates[0];
        const cwLine = cwReport.sessions > 0 && est
            ? { window: est.window, savedUsd: est.savedUsd, compactionsPerWeek: (est.compactions / cwReport.days) * 7, nowPerWeek: (cwReport.actualCompactions / cwReport.days) * 7, isCurrent: setWindow !== undefined }
            : undefined;
        const checking = progressLine("Checking for cache misses");
        const misses = cacheMisses(args.days ?? 30, undefined, checking.tick);
        checking.clear();
        const looking = progressLine("Pricing output and polling");
        const lens = lensOverSessions(args.days ?? 30, { claudeOnly: true });
        looking.clear();
        const on = existsSync(autopilotPaths().config);
        // Savings in the plan's own unit, only when a fit on the user's limit readings is good enough.
        const limitFit = claudeLimitFit(limitsReport(args.days ?? 30, { claudeOnly: true }));
        const limitLines = limitSavingsLines(limitFit, [
            ["1. Compact when you come back", Math.max(0, report.coldResumeNetUsd)],
            ["2. Autopilot", report.reachableUsd],
            ...(cwLine ? [["3. Compact earlier", Math.max(0, cwLine.savedUsd)]] : []),
        ], report.days);
        if (args.json) {
            const { largest: _largest, ...missSummary } = misses;
            console.log(JSON.stringify({ ...report, cacheMisses: missSummary, limitFit: limitFit ?? null, outputAndPolling: lens }, null, 2));
        }
        else if (args.share) {
            const text = renderShare(report);
            console.log(text);
            if (args.copy)
                console.log(copyToClipboard(text) ? "\n(copied to the clipboard)" : "\n(no clipboard tool found; copy the lines above)");
        }
        else {
            console.log(renderSavings(report, on, cwLine, cacheMissesSignificant(misses) ? cacheMissesLine(misses) : undefined, limitLines, renderLens(lens)));
            console.log(`\nNext: ${selfCommand("fix")} ranks every fix by what it saves you and applies only the ones you say yes to (${selfCommand("fix undo")} reverts them).`);
            if (!args.command)
                console.log(`All commands: ${selfCommand("--help")}`);
        }
        return;
    }
    if (args.command === "mcp") {
        // `context-doctor mcp [--http ...]` is the MCP server, the same program as
        // the context-doctor-mcp binary. Registries and clients that launch a
        // package with `npx -y context-doctor <args>` can only reach the package's
        // main binary, so the server has to be a subcommand of it too.
        process.argv.splice(2, 1);
        await import("./mcp.js");
        return;
    }
    if (args.command === "compact-window") {
        const sub = args.file ?? "status";
        if (sub === "off") {
            let r;
            try {
                r = setCompactWindow(undefined);
            }
            catch (e) {
                if (!(e instanceof SettingsError))
                    throw e;
                console.error(e.message);
                process.exitCode = 1;
                return;
            }
            console.log(r.changed
                ? `✓ autoCompactWindow removed from ${tilde(settingsPath())}: Claude Code compacts near the model's full window again (new sessions).`
                : "No auto-compact window was set. Nothing changed.");
            return;
        }
        if (sub !== "status") {
            const w = parseWindow(sub);
            if (w === undefined || w < MIN_WINDOW || w > MAX_WINDOW) {
                console.error(`Usage: context-doctor compact-window [status | off | <size>], size between 100k and 1m (e.g. 400k); got "${sub}".`);
                process.exitCode = 1;
                return;
            }
            let r;
            try {
                r = setCompactWindow(w);
            }
            catch (e) {
                if (!(e instanceof SettingsError))
                    throw e;
                console.error(e.message);
                process.exitCode = 1;
                return;
            }
            if (!r.changed) {
                console.log(`autoCompactWindow is already ${w} in ${tilde(settingsPath())}. Nothing changed.`);
                return;
            }
            // Only claim a backup that exists: a new settings.json had nothing to back up.
            const note = r.created ? "a new file" : r.backup ? `the previous file is kept as ${r.backup.replace(homedir(), "~")}` : "";
            console.log(`✓ autoCompactWindow = ${w} in ${tilde(settingsPath())}${note ? ` (${note})` : ""}.`);
            console.log("  Claude Code sessions started from now on compact as if the window were that size,");
            console.log("  in the terminal, IDEs and the desktop app. Check in a session with /context.");
            const over = fixOverrides("compact-window");
            if (over.length) {
                console.log(`  ⚠ It will not take effect while ${over.join("; ")} ${over.length === 1 ? "overrides" : "override"} it.`);
                process.exitCode = 1;
            }
            console.log(`  Undo: ${selfCommand("compact-window off")}`);
            return;
        }
        const current = currentCompactWindow();
        const windows = [200_000, 300_000, 400_000, 600_000, 800_000];
        if (current && !windows.includes(current))
            windows.push(current);
        const measuring = progressLine("Measuring your compactions");
        const reread = compactionQuality(60, undefined, measuring.tick).extraRereadTokensPerCompaction;
        measuring.clear();
        const replaying = progressLine("Replaying your sessions at each window");
        const cw = estimateCompactWindows(windows.sort((a, b) => a - b), args.days ?? 30, undefined, reread, replaying.tick);
        replaying.clear();
        const limitFit = claudeLimitFit(limitsReport(cw.days, { claudeOnly: true }));
        console.log(renderCompactWindows(cw, current, (estimates) => limitSavingsLines(limitFit, estimates.map((e) => [`${Math.round(e.window / 1000)}k window`, Math.max(0, e.savedUsd)]), cw.days)));
        return;
    }
    if (args.command === "autopilot") {
        const sub = args.file ?? "status";
        const port = args.port ?? DEFAULT_AUTOPILOT_PORT;
        if (sub === "on") {
            const r = await autopilotOn(port);
            console.log(r.lines.join("\n"));
            if (!r.ok)
                process.exitCode = 1;
        }
        else if (sub === "off") {
            console.log((await autopilotOff()).join("\n"));
        }
        else if (sub === "pause" || sub === "resume") {
            const r = autopilotPauseResult(sub === "pause");
            console.log(r.message);
            if (!r.ok)
                process.exitCode = 1;
        }
        else if (sub === "status") {
            console.log((await autopilotStatus()).join("\n"));
        }
        else {
            console.error("Usage: context-doctor autopilot on|off|pause|resume|status [--port n]");
            process.exitCode = 1;
        }
        return;
    }
    if (args.command === "handoff") {
        // Read-only: handoffs are written by the MCP server's save_handoff.
        const sub = args.file ?? "list";
        if (sub === "list") {
            const metas = listHandoffs();
            console.log(args.json ? JSON.stringify(metas, null, 2) : renderHandoffList(metas));
            return;
        }
        const id = sub === "show" ? args.positionals?.[1] : sub === "latest" || isHandoffId(sub) ? sub : undefined;
        if (!id) {
            console.error(sub === "show"
                ? "Usage: context-doctor handoff show <id> (the ids are in `context-doctor handoff list`)."
                : `Usage: context-doctor handoff [list | show <id> | latest] [--copy] [--json]; got "${sub}".`);
            process.exitCode = 1;
            return;
        }
        const h = readHandoff(id);
        if (!h) {
            console.error(id === "latest"
                ? "No handoffs saved yet. In a long chat, pick the `handoff` prompt (Claude Desktop's + menu) or ask for a handoff."
                : `No saved handoff "${id}". List them: ${selfCommand("handoff list")}`);
            process.exitCode = 1;
            return;
        }
        if (args.json) {
            console.log(JSON.stringify({ ...h.meta, markdown: h.markdown }, null, 2));
            return;
        }
        // Control characters out before anything reaches a terminal or the
        // clipboard: a hand-edited or older file could carry escape sequences.
        const markdown = stripControls(h.markdown);
        if (args.copy) {
            const copied = copyToClipboard(markdown);
            console.log(copied
                ? `Copied handoff ${h.meta.id} (~${formatTokens(h.meta.tokens)} tokens). Paste it as the first message of a new chat.`
                : `No clipboard tool found; copy the handoff below by hand.\n\n${markdown}`);
            return;
        }
        process.stdout.write(markdown);
        return;
    }
    if (args.command === "instructions") {
        console.log(renderPreferences(args.copy ? copyToClipboard(CHAT_PREFERENCES) : undefined));
        return;
    }
    if (args.command === "uninstall") {
        await runUninstall();
        return;
    }
    if (args.command === "proxy") {
        const loadedRc = loadConfig(process.cwd(), (m) => console.error(`context-doctor: ${m}`));
        let routes = loadedRc.config.routes;
        if (args.config) {
            try {
                const raw = JSON.parse(readFileSync(args.config, "utf8")).routes;
                // The same rule as the rc file: a value the warning calls ignored is not applied.
                if (raw !== undefined && !Array.isArray(raw))
                    console.error(`context-doctor: ${args.config}: routes must be an array — ignored`);
                else if (Array.isArray(raw))
                    for (const w of validateRoutes(raw, args.config))
                        console.error(`context-doctor: ${w}`);
                routes = sanitizeRoutes(raw);
            }
            catch (e) {
                console.error(`Could not read --config ${args.config}: ${e.message}`);
                process.exit(1);
            }
        }
        startProxy({
            routes,
            port: args.port,
            host: args.host,
            token: args.token ?? process.env.CONTEXT_DOCTOR_PROXY_TOKEN,
            autopilot: args.autopilot,
            autopilotStatePath: args.autopilotState,
            autopilotPauseFile: args.autopilotPauseFile,
            anthropicUpstream: args.upstreamAnthropic,
            openaiUpstream: args.upstreamOpenai,
            googleUpstream: args.upstreamGoogle,
            strategies: args.strategies.length > 0 ? args.strategies : loadedRc.config.strategies,
            keepRecent: args.keepRecent ?? loadedRc.config.keepRecent,
            maxToolResultTokens: args.maxToolTokens ?? loadedRc.config.maxToolResultTokens,
            trimBoundaryStep: loadedRc.config.trimBoundaryStep,
        });
        return; // server keeps the process alive
    }
    if (args.command === "fix") {
        const sub = args.file;
        if (sub === "undo") {
            const named = (args.positionals ?? []).slice(1).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
            const lines = await undoFixes(named.length ? named : undefined, { autopilotOff: () => autopilotOff() });
            console.log(lines.join("\n"));
            if (lines.some((l) => l.startsWith("✗")))
                process.exitCode = 1;
            return;
        }
        if (sub !== undefined && sub !== "plan")
            usageError(`Usage: context-doctor fix [--apply <ids|all>] [--share] [--json] | fix undo [ids]; got "${sub}".`);
        if (args.apply !== undefined && args.share)
            usageError("--apply and --share do not go together: --share only prints totals.");
        const { inputs, prunePlan } = await measureFixInputs(args.days ?? 30);
        const fixes = planFixes(inputs);
        const since = savedSince(readFixRecords());
        if (args.share) {
            const text = renderFixShare(inputs.days, inputs.billedUsd, fixes);
            console.log(text);
            if (args.copy)
                console.log(copyToClipboard(text) ? "\n(copied to the clipboard)" : "\n(no clipboard tool found; copy the lines above)");
            return;
        }
        const available = fixes.filter((f) => f.state === "available");
        let chosen = [];
        if (args.apply !== undefined) {
            const { ids, unknown } = parseFixIds(args.apply, fixes);
            if (unknown.length)
                usageError(`--apply: unknown fix ${unknown.join(", ")}. Fixes: ${available.map((f) => f.id).join(", ") || "none available"}.`);
            chosen = ids;
        }
        if (!args.json)
            console.log(renderFixPlan(inputs.days, inputs.billedUsd, fixes, since, selfCommand, inputs.coldResume, inputs.recordProblem));
        if (args.apply === undefined && !args.json && process.stdin.isTTY && process.stdout.isTTY && available.length && !inputs.recordProblem) {
            const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
            console.log("");
            for (const [n, f] of available.entries()) {
                const a = (await rl.question(`Apply ${n + 1}. ${f.title}? [y/N] `)).trim().toLowerCase();
                if (a === "y" || a === "yes")
                    chosen.push(f.id);
            }
            rl.close();
        }
        const results = [];
        for (const id of chosen) {
            const f = fixes.find((x) => x.id === id);
            if (!f || f.state !== "available") {
                results.push({ id, ok: false, lines: [`${id}: ${f?.note ?? "not available here"}; skipped.`] });
                continue;
            }
            const kind = id === "cache-ttl" ? "main" : id === "cache-ttl-subagents" ? "subagents" : undefined;
            const r = await applyFix(f, { autopilotOn: () => autopilotOn(args.port ?? DEFAULT_AUTOPILOT_PORT) }, { oneHourShare: kind ? inputs.ttl?.[kind].oneHourShare : undefined, prune: prunePlan });
            results.push({ id, ...r });
        }
        // Naming fixes that are not there (or nothing at all, with "all") is not a silent success.
        if (args.apply !== undefined && (chosen.length === 0 || results.some((r) => !r.ok)))
            process.exitCode = 1;
        if (args.json) {
            console.log(JSON.stringify({ days: inputs.days, billedUsd: inputs.billedUsd, fixes, since, ...(args.apply !== undefined ? { applied: results } : {}), ...(inputs.recordProblem ? { recordProblem: inputs.recordProblem } : {}) }, null, 2));
            if (args.apply !== undefined && chosen.length === 0)
                console.error("--apply: no fix available to apply.");
            return;
        }
        if (args.apply !== undefined && chosen.length === 0)
            console.error("\n--apply: no fix available to apply.");
        if (!results.length)
            return;
        console.log("");
        for (const r of results)
            console.log(r.lines.join("\n"));
        if (results.some((r) => r.ok))
            console.log(`\nNew Claude Code sessions pick these up. Undo: ${selfCommand("fix undo")}; ${selfCommand("fix")} later shows what each saved since.`);
        return;
    }
    if (args.command === "cache-ttl") {
        const sub = args.file ?? "status";
        const kind = args.subagentsTtl ? "subagents" : "main";
        const key = settingKey(kind);
        if (sub === "1h" || sub === "5m" || sub === "off") {
            let r;
            try {
                r = setCacheTtl(kind, sub === "off" ? undefined : sub);
            }
            catch (e) {
                if (!(e instanceof SettingsError))
                    throw e;
                console.error(e.message);
                process.exitCode = 1;
                return;
            }
            if (!r.changed) {
                console.log(sub === "off" ? `${key} was not set. Nothing changed.` : `${key} is already "${sub}" in ${tilde(settingsPath())}. Nothing changed.`);
                return;
            }
            const note = r.created ? " (a new file)" : r.backup ? ` (the previous file is kept as ${r.backup.replace(homedir(), "~")})` : "";
            console.log(sub === "off"
                ? `✓ ${key} removed from ${tilde(settingsPath())}${note}: Claude Code picks the lifetime itself again (new sessions).`
                : `✓ ${key} = "${sub}" in ${tilde(settingsPath())}${note}.`);
            if (sub !== "off") {
                console.log(`  New ${kind === "main" ? "sessions write the main conversation's" : "subagents write their"} cache at ${sub === "1h" ? "1 hour (2x input per written token)" : "5 minutes (1.25x)"}, in every Claude Code surface.`);
                const old = ttlUnsupported(claudeCodeInstallsFromEnv());
                if (old.length)
                    console.log(`  ${old.map((i) => "Claude Code " + i.version).join(", ")} predates the setting (${CACHE_TTL_SINCE}) and ignores it.`);
                const over = fixOverrides(kind === "main" ? "cache-ttl" : "cache-ttl-subagents");
                if (over.length) {
                    console.log(`  ⚠ It will not take effect while ${over.join("; ")} ${over.length === 1 ? "overrides" : "override"} it.`);
                    process.exitCode = 1;
                }
                console.log(`  Undo: ${selfCommand(`cache-ttl off${kind === "subagents" ? " --subagents" : ""}`)}`);
            }
            return;
        }
        if (sub !== "status")
            usageError(`Usage: context-doctor cache-ttl [status | 1h | 5m | off] [--subagents]; got "${sub}".`);
        const reading = progressLine("Replaying your sessions at both cache lifetimes");
        const report = estimateCacheTtl(args.days ?? 30, { onProgress: reading.tick });
        reading.clear();
        const current = currentTtl();
        console.log(args.json ? JSON.stringify({ ...report, current }, null, 2) : renderCacheTtl(report, current, claudeCodeInstallsFromEnv(), selfCommand));
        return;
    }
    if (args.command === "cache-misses") {
        const reading = progressLine("Reading your Claude Code transcripts");
        const report = cacheMisses(args.days ?? 30, undefined, reading.tick);
        reading.clear();
        const limitLines = limitSavingsLines(claudeLimitFit(limitsReport(report.days, { claudeOnly: true })), [["Misses above cache-read price", report.extraUsd]], report.days);
        console.log(args.json ? JSON.stringify(report, null, 2) : renderCacheMisses(report, limitLines));
        return;
    }
    if (args.command === "recall") {
        const query = (args.positionals ?? []).join(" ").trim() || args.query;
        if (!query)
            usageError('Usage: context-doctor recall "<query>" [--session <id|path>] [--max-tokens n]');
        const session = args.session ? (() => { const p = findSession(args.session); return p ? { path: p, how: `session ${args.session}` } : undefined; })() : currentTranscript();
        if (!session) {
            console.error(args.session
                ? `No session "${args.session}": pass a Claude Code session id, a Codex rollout id, or a transcript path.`
                : "No transcript for this folder: run it inside a Claude Code or Codex session, or name one with --session <id|path>.");
            process.exitCode = 1;
            return;
        }
        const r = recall(session.path, query, { budget: args.maxTokens ?? 2000, how: session.how });
        console.log(args.json ? JSON.stringify(r, null, 2) : renderRecall(r));
        return;
    }
    if (args.command === "limits") {
        const reading = progressLine("Reading your limits and usage");
        const report = limitsReport(args.days ?? 30);
        reading.clear();
        console.log(args.json ? JSON.stringify(report, null, 2) : renderLimits(report));
        return;
    }
    if (args.command === "compactions") {
        const days = args.days ?? 60;
        const q = compactionQuality(days);
        console.log(args.json ? JSON.stringify(q, null, 2) : renderCompactionQuality(q, days));
        return;
    }
    if (args.command === "subagents") {
        const reading = progressLine("Reading your sessions' subagents");
        const report = subagentPayback(args.days ?? 30, undefined, reading.tick);
        reading.clear();
        // The medians the subagent price (PreToolUse) quotes, refreshed here.
        const costs = measureSubagentCosts(args.days ?? 30);
        if (costs.n > 0)
            saveSubagentCosts(costs);
        console.log(args.json ? JSON.stringify({ ...report, medians: costs }, null, 2) : [renderPayback(report, args.limit ?? 8), ...renderCostMedians(costs)].join("\n"));
        return;
    }
    if (args.command === "cache-plan") {
        const file = args.positionals?.[0];
        if (!file) {
            console.error("usage: context-doctor cache-plan <request.json|-> [--calls 10] [--out planned.json] [--explicit]");
            process.exit(1);
        }
        let result;
        try {
            result = planCache(readInput(file), args.calls ?? 10, args.model, { explicit: args.explicit });
        }
        catch (e) {
            console.error(`Could not read a request from ${file}: ${e.message}`);
            process.exit(1);
        }
        console.log(args.json ? JSON.stringify(result.plan, null, 2) : renderCachePlan(result.plan));
        if (args.out) {
            writeFileSync(args.out, JSON.stringify(result.apply(), null, 2));
            console.error(result.plan.plan.length
                ? `context-doctor: request with the planned breakpoints written to ${args.out}`
                : `context-doctor: nothing to place; the request was written unchanged to ${args.out}`);
        }
        return;
    }
    if (args.command === "tasks") {
        const report = costPerTask(args.days ?? 30);
        console.log(args.json ? JSON.stringify(report, null, 2) : renderTasks(report, args.limit ?? 12));
        return;
    }
    if (args.command === "reads") {
        const report = repeatedReads(args.days ?? 30);
        console.log(args.json ? JSON.stringify(report, null, 2) : renderReads(report, args.limit ?? 15));
        return;
    }
    if (args.command === "ci") {
        let report;
        try {
            report = ciReport({ base: args.base, maxTokens: args.maxTokens, maxIncrease: args.maxIncrease });
        }
        catch (e) {
            // A base git cannot resolve (a typo, a shallow clone) is a usage error, not a crash.
            console.error(`context-doctor: ${e.message}`);
            process.exit(1);
        }
        console.log(args.json ? JSON.stringify(report, null, 2) : args.markdown ? renderCiMarkdown(report, { model: args.model, requestsPerDay: args.requestsPerDay }) : renderCiText(report));
        if (report.breaches.length)
            process.exitCode = 1;
        return;
    }
    if (args.command === "overhead" && args.positionals?.[0] === "prune") {
        const cwd = canonical(process.cwd());
        if (args.undo) {
            const r = undoPrune(cwd);
            console.log(r
                ? `Removed ${r.removed.length} entr${r.removed.length === 1 ? "y" : "ies"} prune had added to ${r.file.replace(homedir(), "~")}${r.removed.length ? `: ${r.removed.join(", ")}` : ""}.`
                : "Nothing to undo: prune has not written to this folder's project.");
            return;
        }
        const reading = progressLine("Reading which servers and skills each project used");
        const plan = planPrune(args.days ?? 30);
        reading.clear();
        // This folder's project is planned even with no sessions in the period (it then has too few to judge).
        if (!plan.plans.some((p) => p.cwd === cwd))
            plan.plans.push(...planPrune(args.days ?? 30, { cwds: [cwd], usage: new Map() }).plans);
        const usdPerK = measureBaselines(args.days ?? 30).find((b) => b.agent === "Claude Code")?.usdPerKPerMonth;
        if (args.json) {
            console.log(JSON.stringify(plan, null, 2));
        }
        else {
            console.log(withInvocation(renderPrune(plan, cwd, { usdPerKPerMonth: usdPerK })));
        }
        if (args.write) {
            const here = plan.plans.find((p) => p.cwd === cwd);
            if (!here || here.thin || here.unused.length === 0) {
                console.log("\nNothing written: nothing unused to switch off in this folder's project.");
                return;
            }
            try {
                const r = applyPrune(here);
                const n = r.added.disabledMcpjsonServers.length + r.added.deniedMcpServers.length + r.added.skillOverrides.length;
                console.log(`\nWritten: ${n} entr${n === 1 ? "y" : "ies"} in ${r.file.replace(homedir(), "~")}${r.backup ? ` (its original kept as ${r.backup.replace(homedir(), "~")})` : ""}. New sessions here start without them. Undo: ${selfCommand("overhead prune --undo")}`);
            }
            catch (e) {
                console.error(`Not written: ${e.message}`);
                process.exitCode = 1;
            }
        }
        return;
    }
    if (args.command === "overhead" && args.positionals?.[0] === "split") {
        const file = args.positionals[1];
        if (!file) {
            console.error("usage: context-doctor overhead split <memory file> [--min-tokens 400] [--write]");
            process.exit(1);
        }
        let plan;
        try {
            plan = planSplit(file, { minTokens: args.minTokens });
        }
        catch (e) {
            console.error(`Could not read ${file}: ${e.message}`);
            process.exit(1);
        }
        // Price the file at the rate of the agent that loads it.
        const agent = /AGENTS(\.override)?\.md$/i.test(file) ? "Codex" : /GEMINI\.md$/i.test(file) ? "Gemini CLI" : "Claude Code";
        console.log(renderSplit(plan, measureBaselines(args.days ?? 30).find((b) => b.agent === agent)?.usdPerKPerMonth));
        if (args.write && plan.sections.some((s) => s.moved)) {
            const { backup } = applySplit(plan);
            console.log(`\nWritten. Backup: ${backup}\nUndo: mv "${backup}" "${file}" (and delete or trim ${plan.referencePath}).`);
        }
        return;
    }
    if (args.command === "overhead") {
        const sessions = progressLine("Measuring each session's first request");
        const tools = progressLine("Counting MCP tool calls");
        const report = overheadReport({
            days: args.days,
            onProgress: (done, total, stage) => (stage === "sessions" ? sessions : tools).tick?.(done, total),
        });
        sessions.clear();
        tools.clear();
        if (args.mcp)
            await measureMcpSizes(report);
        console.log(args.json ? JSON.stringify(report, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v), 2) : renderOverhead(report));
        return;
    }
    if (args.command === "pack") {
        const paths = args.positionals ?? [];
        if (paths.length === 0) {
            console.error('usage: context-doctor pack <files|dirs...> --query "<question>" [--max-tokens 4000] [--ids a#2,b#5] [--json]');
            process.exit(1);
        }
        // "-" is stdin, read once beside any other paths (it used to drop them silently).
        const files = paths.filter((p) => p !== "-");
        const { sources, skipped } = files.length
            ? readSources(files, { includeSecrets: args.includeSecrets, secretsHint: " (--include-secrets packs it)" })
            : { sources: [], skipped: [] };
        if (paths.includes("-"))
            sources.unshift({ name: "stdin", text: stripBom(readFileSync(0, "utf8")) });
        for (const s of skipped)
            console.error(`context-doctor: skipped ${s}`);
        if (sources.length === 0)
            process.exit(1);
        const result = await packContextSemantic(sources, { query: args.query, budget: args.maxTokens, ids: args.ids, maxChunkTokens: args.chunkTokens, model: args.model, semantic: args.semantic });
        console.log(args.json ? JSON.stringify({ ...result, chunks: undefined, outline: result.chunks.map(({ text, ...c }) => c) }, null, 2) : renderPack(result));
        return;
    }
    if (!args.command) {
        // Bare, with no history to measure or not in a terminal: where to begin.
        console.log(withInvocation(START_HERE));
        return;
    }
    if (!args.file) {
        // analyze/optimize without a file: say what is missing, then how to call it.
        usageError(`${args.command} needs a conversation file (or - to read stdin).\n\n${commandHelp(HELP, args.command) ?? ""}`);
    }
    let input;
    try {
        input = readInput(args.file);
    }
    catch (e) {
        console.error(`Could not read ${args.file}: ${e.message}`);
        process.exit(1);
    }
    // Broken JSON, or JSON that is not a conversation, used to profile as a
    // few tokens (or none) and report the context "in good shape". Raw text
    // stays a supported input: it parses without a warning.
    const conversation = parseConversation(input);
    if (conversation.parseWarning) {
        usageError(`Could not ${args.command} ${args.file === "-" ? "stdin" : args.file}: ${conversation.parseWarning}`);
    }
    if (args.command === "analyze") {
        const loaded = loadConfig(process.cwd(), (m) => console.error(`context-doctor: ${m}`));
        const profile = profileConversation(conversation, args.model ?? loaded.config.model);
        // The exact count is awaited before anything prints: with --json it goes
        // inside the one JSON object. Printed after it, as it once was, the extra
        // lines made stdout invalid JSON for every script that parsed it.
        const exact = args.exact ? await exactTokenCount(input, args.model) : undefined;
        let drift;
        let remembered = false;
        if (exact?.tokens !== undefined) {
            drift = profile.totalTokens > 0 ? Math.round(((exact.tokens - profile.totalTokens) / exact.tokens) * 100) : 0;
            // Remember the comparison so the next estimate for this model family
            // starts from the user's own ground truth instead of a constant.
            const raw = profile.calibration ? profile.totalTokens / profile.calibration.factor : profile.totalTokens;
            remembered = recordCalibration(args.model ?? profile.model, exact.tokens, raw);
        }
        if (args.json) {
            const out = exact ? { ...profile, exact: { ...exact, driftPct: drift, calibrationRecorded: remembered } } : profile;
            console.log(JSON.stringify(out, null, 2));
            applyBudgetGate(checkBudget(loaded.config.budget, profile).overBudget, args.failOverBudget);
            return;
        }
        console.log(renderProfile(profile, { redact: args.redact }));
        applyBudgetGate(printBudgetStatus(profile, loaded), args.failOverBudget);
        if (exact?.tokens !== undefined) {
            console.log(`\nExact input tokens: ${exact.tokens} (${exact.source}) — heuristic was off by ${drift}%`);
            // Only claim it when it happened: a sample outside 0.5-2x is rejected,
            // and CONTEXT_DOCTOR_NO_CALIBRATION=1 stores nothing.
            if (remembered) {
                console.log(`Remembered: future ${modelFamily(args.model ?? profile.model)} estimates on this machine are calibrated from this (CONTEXT_DOCTOR_NO_CALIBRATION=1 to disable).`);
            }
        }
        else if (exact) {
            console.log(`\nExact count unavailable: ${exact.note}`);
        }
        return;
    }
    if (args.command === "optimize") {
        let result;
        try {
            const loaded = loadConfig(process.cwd(), (m) => console.error(`context-doctor: ${m}`));
            result = optimizeConversation(input, {
                strategies: args.strategies.length > 0 ? args.strategies : loaded.config.strategies,
                keepRecent: args.keepRecent ?? loaded.config.keepRecent,
                maxToolResultTokens: args.maxToolTokens ?? loaded.config.maxToolResultTokens,
                trimBoundaryStep: loaded.config.trimBoundaryStep,
            });
        }
        catch (e) {
            console.error(e.message);
            process.exit(1);
        }
        const output = JSON.stringify(result.conversation, null, 2);
        if (args.out) {
            writeFileSync(args.out, output);
        }
        else if (args.json) {
            console.log(JSON.stringify(result, null, 2));
        }
        else {
            console.log(output);
        }
        const saved = result.tokensBefore - result.tokensAfter;
        if (saved > 0) {
            recordLedger({ ev: "optimize", src: "cli", saved, model: result.conversation?.model });
        }
        const pct = result.tokensBefore > 0 ? Math.round((saved / result.tokensBefore) * 100) : 0;
        console.error(`\ncontext-doctor: ${formatTokens(result.tokensBefore)} → ${formatTokens(result.tokensAfter)} tokens ` +
            `(saved ~${formatTokens(saved)}, ${pct}%) via ${result.applied.length} change(s)` +
            (args.out ? ` — written to ${args.out}` : ""));
        return;
    }
    console.error(`Unknown command: ${args.command}\n`);
    console.log(HELP);
    process.exit(1);
}
void main();
