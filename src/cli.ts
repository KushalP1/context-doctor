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
import { optimizeConversation, StrategyId } from "./optimize.js";
import { renderProfile } from "./report.js";
import { formatTokens } from "./tokens.js";
import { startProxy } from "./proxy.js";
import { runInstall, runUninstall } from "./install.js";
import { listSessions, parseSessionFile } from "./session.js";
import { runHook } from "./hook.js";

const HELP = `context-doctor — profile and optimize LLM context windows

Usage:
  context-doctor analyze  <file|->  [options]   Show what's eating your tokens
  context-doctor optimize <file|->  [options]   Apply safe fixes, print slimmed conversation
  context-doctor proxy              [options]   Always-on: local proxy that optimizes every
                                                Anthropic/OpenAI API request in flight
  context-doctor install                        Wire the MCP server + skill into Claude Desktop,
                                                Claude Code, and Cursor automatically
  context-doctor uninstall                      Undo install
  context-doctor session [file]                 Profile a Claude Code session transcript
                                                (default: the most recent session; --list to browse)
  context-doctor hook                           Claude Code UserPromptSubmit hook (installed
                                                automatically by \`install\`; reads hook JSON on stdin)

Input: a conversation JSON file (OpenAI or Anthropic message format, or a bare
message array). Use "-" to read from stdin.

Options:
  --model <name>          Model name for window-size math (e.g. claude-sonnet-5, gpt-4o)
  --json                  Machine-readable output
  --out <file>            (optimize) Write result to file instead of stdout
  --strategy <id>         (optimize) Strategy to run; repeatable.
                          Available: dedupe, trim-tool-results, strip-base64, prune-history
                          Default: dedupe, trim-tool-results, strip-base64 (lossless-ish set)
  --keep-recent <n>       (optimize) Messages at the tail to leave untouched (default 6)
  --max-tool-tokens <n>   (optimize) Token budget for trimmed tool results (default 300)
  --port <n>              (proxy) Port to listen on (default 8787)
  --host <addr>           (proxy) Bind address (default 127.0.0.1; use 0.0.0.0 to expose)
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

interface Args {
  command?: string;
  file?: string;
  model?: string;
  json: boolean;
  out?: string;
  strategies: StrategyId[];
  keepRecent?: number;
  maxToolTokens?: number;
  port?: number;
  host?: string;
  upstreamAnthropic?: string;
  upstreamOpenai?: string;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, strategies: [], list: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h": case "--help": console.log(HELP); process.exit(0);
      case "--json": args.json = true; break;
      case "--list": args.list = true; break;
      case "--model": args.model = argv[++i]; break;
      case "--out": args.out = argv[++i]; break;
      case "--strategy": args.strategies.push(argv[++i] as StrategyId); break;
      case "--keep-recent": args.keepRecent = Number(argv[++i]); break;
      case "--max-tool-tokens": args.maxToolTokens = Number(argv[++i]); break;
      case "--port": args.port = Number(argv[++i]); break;
      case "--host": args.host = argv[++i]; break;
      case "--upstream-anthropic": args.upstreamAnthropic = argv[++i]; break;
      case "--upstream-openai": args.upstreamOpenai = argv[++i]; break;
      default: positional.push(a);
    }
  }
  args.command = positional[0];
  args.file = positional[1];
  return args;
}

function readInput(file: string): string {
  if (file === "-") return readFileSync(0, "utf8");
  return readFileSync(file, "utf8");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "hook") {
    void runHook();
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
    } catch (e) {
      console.error(`Could not read session: ${(e as Error).message}`);
      process.exit(1);
    }
    const profile = profileConversation(parseConversation(parsed.conversationJson), args.model ?? parsed.model);
    if (args.json) {
      console.log(JSON.stringify({ session: { path: parsed.path, title: parsed.title }, profile }, null, 2));
    } else {
      console.log(`Session: ${parsed.title ?? "(untitled)"}\nFile:    ${parsed.path}\n`);
      console.log(renderProfile(profile));
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
    startProxy({
      port: args.port,
      host: args.host,
      anthropicUpstream: args.upstreamAnthropic,
      openaiUpstream: args.upstreamOpenai,
      strategies: args.strategies.length > 0 ? args.strategies : undefined,
      keepRecent: args.keepRecent,
      maxToolResultTokens: args.maxToolTokens,
    });
    return; // server keeps the process alive
  }

  if (!args.command || !args.file) {
    console.log(HELP);
    process.exit(args.command ? 1 : 0);
  }

  let input: string;
  try {
    input = readInput(args.file!);
  } catch (e) {
    console.error(`Could not read ${args.file}: ${(e as Error).message}`);
    process.exit(1);
  }

  if (args.command === "analyze") {
    const profile = profileConversation(parseConversation(input), args.model);
    console.log(args.json ? JSON.stringify(profile, null, 2) : renderProfile(profile));
    return;
  }

  if (args.command === "optimize") {
    let result;
    try {
      result = optimizeConversation(input, {
        strategies: args.strategies.length > 0 ? args.strategies : undefined,
        keepRecent: args.keepRecent,
        maxToolResultTokens: args.maxToolTokens,
      });
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }

    const output = JSON.stringify(result.conversation, null, 2);
    if (args.out) {
      writeFileSync(args.out, output);
    } else if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(output);
    }

    const saved = result.tokensBefore - result.tokensAfter;
    const pct = result.tokensBefore > 0 ? Math.round((saved / result.tokensBefore) * 100) : 0;
    console.error(
      `\ncontext-doctor: ${formatTokens(result.tokensBefore)} → ${formatTokens(result.tokensAfter)} tokens ` +
      `(saved ~${formatTokens(saved)}, ${pct}%) via ${result.applied.length} change(s)` +
      (args.out ? ` — written to ${args.out}` : "")
    );
    return;
  }

  console.error(`Unknown command: ${args.command}\n`);
  console.log(HELP);
  process.exit(1);
}

main();
