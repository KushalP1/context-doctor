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

const HELP = `context-doctor — profile and optimize LLM context windows

Usage:
  context-doctor analyze  <file|->  [options]   Show what's eating your tokens
  context-doctor optimize <file|->  [options]   Apply safe fixes, print slimmed conversation

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
  -h, --help              Show this help

Examples:
  context-doctor analyze chat.json --model claude-sonnet-5
  context-doctor optimize chat.json --strategy dedupe --strategy prune-history --out slim.json
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
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, strategies: [] };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h": case "--help": console.log(HELP); process.exit(0);
      case "--json": args.json = true; break;
      case "--model": args.model = argv[++i]; break;
      case "--out": args.out = argv[++i]; break;
      case "--strategy": args.strategies.push(argv[++i] as StrategyId); break;
      case "--keep-recent": args.keepRecent = Number(argv[++i]); break;
      case "--max-tool-tokens": args.maxToolTokens = Number(argv[++i]); break;
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
