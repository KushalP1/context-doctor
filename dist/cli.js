#!/usr/bin/env node
/**
 * context-doctor CLI
 *
 *   context-doctor analyze <file|-> [--model claude-sonnet-5] [--json]
 *   context-doctor optimize <file|-> [--out file] [--strategy s]... [--keep-recent N] [--max-tool-tokens N]
 *
 * `-` reads from stdin, so you can pipe: `cat chat.json | context-doctor analyze -`
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { parseConversation } from "./parse.js";
import { profileConversation } from "./profile.js";
import { optimizeConversation } from "./optimize.js";
import { renderProfile } from "./report.js";
import { formatTokens } from "./tokens.js";
import { startProxy } from "./proxy.js";
import { runInstall, runUninstall } from "./install.js";
import { listSessions, parseSessionFile } from "./session.js";
import { runHook } from "./hook.js";
import { buildImpactReport } from "./impact.js";
import { recordLedger } from "./ledger.js";
import { runDoctor } from "./doctor.js";
import { runWatch } from "./watch.js";
import { exactTokenCount } from "./exact.js";
import { checkBudget, loadConfig } from "./config.js";
import { startDashboard } from "./dashboard.js";
import { listCursorChats, parseCursorChat } from "./cursor.js";
import { analyzeCacheUsage, renderCacheReport } from "./cache.js";
const HELP = `context-doctor — profile and optimize LLM context windows

Usage:
  context-doctor analyze  <file|->  [options]   Show what's eating your tokens
  context-doctor optimize <file|->  [options]   Apply safe fixes, print slimmed conversation
  context-doctor proxy              [options]   Always-on: local proxy that optimizes every
                                                Anthropic/OpenAI API request in flight
  context-doctor install                        Wire the MCP server + skill into Claude Desktop,
                                                Claude Code, and Cursor automatically
  context-doctor uninstall                      Undo install
  context-doctor session [file]                 Profile a Claude Code session transcript or a
                                                ChatGPT export (default: most recent; --list to browse)
  context-doctor cursor [--list]                Profile a Cursor chat from its local history
  context-doctor hook                           Claude Code UserPromptSubmit hook (installed
                                                automatically by \`install\`; reads hook JSON on stdin)
  context-doctor report                         Impact report: exact proxy savings, hook activity,
                                                and remaining recoverable waste in recent sessions
  context-doctor doctor                         Self-check the installation (configs, hook, skill,
                                                MCP handshake) with one pasteable diagnosis
  context-doctor dashboard                      Local savings dashboard on 127.0.0.1 (--port n,
                                                default 8790) — charts from your own machine only
  context-doctor watch [file]                   Live-monitor a growing session/agent trace: running
                                                token/cost line per change, new findings as they appear
                                                (--interval-ms n, default 2000)

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
  --port <n>              (proxy) Port to listen on (default 8787)
  --host <addr>           (proxy) Bind address (default 127.0.0.1; use 0.0.0.0 to expose)
  --config <file>         (proxy) Per-route overrides: {"routes":[{"modelPrefix":"gpt","strategies":[...],
                          "keepRecent":n,"maxToolResultTokens":n}]} — first prefix match wins
  --upstream-anthropic <url>  (proxy) Override Anthropic upstream (testing)
  --upstream-openai <url>     (proxy) Override OpenAI upstream (testing)
  -h, --help              Show this help

Examples:
  context-doctor analyze chat.json --model claude-sonnet-5
  context-doctor optimize chat.json --strategy dedupe --strategy prune-history --out slim.json
  context-doctor proxy --port 8787
    then: export ANTHROPIC_BASE_URL=http://localhost:8787
          export OPENAI_BASE_URL=http://localhost:8787/v1
`;
function parseArgs(argv) {
    const args = { json: false, strategies: [], list: false, exact: false, redact: false, failOverBudget: false };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case "-h":
            case "--help":
                console.log(HELP);
                process.exit(0);
            case "--json":
                args.json = true;
                break;
            case "--list":
                args.list = true;
                break;
            case "--exact":
                args.exact = true;
                break;
            case "--redact":
                args.redact = true;
                break;
            case "--fail-over-budget":
                args.failOverBudget = true;
                break;
            case "--model":
                args.model = argv[++i];
                break;
            case "--out":
                args.out = argv[++i];
                break;
            case "--strategy":
                args.strategies.push(argv[++i]);
                break;
            case "--keep-recent":
                args.keepRecent = Number(argv[++i]);
                break;
            case "--max-tool-tokens":
                args.maxToolTokens = Number(argv[++i]);
                break;
            case "--port":
                args.port = Number(argv[++i]);
                break;
            case "--interval-ms":
                args.intervalMs = Number(argv[++i]);
                break;
            case "--host":
                args.host = argv[++i];
                break;
            case "--config":
                args.config = argv[++i];
                break;
            case "--upstream-anthropic":
                args.upstreamAnthropic = argv[++i];
                break;
            case "--upstream-openai":
                args.upstreamOpenai = argv[++i];
                break;
            default: positional.push(a);
        }
    }
    args.command = positional[0];
    args.file = positional[1];
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
    if (file === "-")
        return readFileSync(0, "utf8");
    return readFileSync(file, "utf8");
}
function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === "hook") {
        void runHook();
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
    if (args.command === "report") {
        void buildImpactReport(args.port).then((r) => console.log(r));
        return;
    }
    if (args.command === "cursor") {
        let chats;
        try {
            chats = listCursorChats();
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
        const chat = args.file ? chats.find((c) => c.composerId === args.file) ?? chats[0] : chats[0];
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
            const sessions = listSessions();
            if (sessions.length === 0) {
                console.log("No Claude Code sessions found under ~/.claude/projects.");
                return;
            }
            for (const s of sessions) {
                console.log(`${s.modifiedAt.toISOString().slice(0, 16)}  ${(s.sizeBytes / 1024).toFixed(0).padStart(6)}KB  ${s.path}`);
            }
            return;
        }
        const path = args.file ?? listSessions(1)[0]?.path;
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
        const profile = profileConversation(parseConversation(parsed.conversationJson), args.model ?? parsed.model);
        if (args.json) {
            console.log(JSON.stringify({ session: { path: parsed.path, title: parsed.title }, profile }, null, 2));
        }
        else {
            console.log(`Session: ${parsed.title ?? "(untitled)"}\nFile:    ${parsed.path}`);
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
            const cache = renderCacheReport(analyzeCacheUsage(path));
            if (cache) {
                console.log("");
                console.log(cache);
            }
            applyBudgetGate(printBudgetStatus(profile, loadConfig(process.cwd(), (m) => console.error(`context-doctor: ${m}`))), args.failOverBudget);
        }
        return;
    }
    if (args.command === "install") {
        runInstall();
        return;
    }
    if (args.command === "uninstall") {
        runUninstall();
        return;
    }
    if (args.command === "proxy") {
        const loadedRc = loadConfig(process.cwd(), (m) => console.error(`context-doctor: ${m}`));
        let routes = loadedRc.config.routes;
        if (args.config) {
            try {
                routes = JSON.parse(readFileSync(args.config, "utf8")).routes;
            }
            catch (e) {
                console.error(`Could not read --config ${args.config}: ${e.message}`);
                process.exit(1);
            }
        }
        startProxy({
            routes: routes,
            port: args.port,
            host: args.host,
            anthropicUpstream: args.upstreamAnthropic,
            openaiUpstream: args.upstreamOpenai,
            strategies: args.strategies.length > 0 ? args.strategies : loadedRc.config.strategies,
            keepRecent: args.keepRecent ?? loadedRc.config.keepRecent,
            maxToolResultTokens: args.maxToolTokens ?? loadedRc.config.maxToolResultTokens,
        });
        return; // server keeps the process alive
    }
    if (!args.command || !args.file) {
        console.log(HELP);
        process.exit(args.command ? 1 : 0);
    }
    let input;
    try {
        input = readInput(args.file);
    }
    catch (e) {
        console.error(`Could not read ${args.file}: ${e.message}`);
        process.exit(1);
    }
    if (args.command === "analyze") {
        const loaded = loadConfig(process.cwd(), (m) => console.error(`context-doctor: ${m}`));
        const profile = profileConversation(parseConversation(input), args.model ?? loaded.config.model);
        console.log(args.json ? JSON.stringify(profile, null, 2) : renderProfile(profile, { redact: args.redact }));
        if (!args.json)
            applyBudgetGate(printBudgetStatus(profile, loaded), args.failOverBudget);
        else
            applyBudgetGate(checkBudget(loaded.config.budget, profile).overBudget, args.failOverBudget);
        if (args.exact) {
            void exactTokenCount(input, args.model).then((exact) => {
                if (exact.tokens !== undefined) {
                    const drift = profile.totalTokens > 0 ? Math.round(((exact.tokens - profile.totalTokens) / exact.tokens) * 100) : 0;
                    console.log(`\nExact input tokens: ${exact.tokens} (${exact.source}) — heuristic was off by ${drift}%`);
                }
                else {
                    console.log(`\nExact count unavailable: ${exact.note}`);
                }
            });
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
main();
