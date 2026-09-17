/**
 * `context-doctor experiment` — the fresh-vs-existing session harness.
 *
 * Everything else in this tool measures what is IN the context. None of it can
 * say whether the task succeeded, so a smaller transcript can be a cheaper
 * failure. This runs the same task twice against the same starting commit —
 * once in a fresh session, once forked from an existing one — with the same
 * model and tools, records what each was billed and how long it took, runs the
 * same check command against each result, and puts the two side by side.
 *
 * It spends the user's Claude budget, so it refuses to start on a dirty tree,
 * caps spend per arm, forks the existing session rather than mutating it, and
 * resets the tree between arms only because it verified the tree was clean.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSessionFile } from "./session.js";
import { formatTokens } from "./tokens.js";
import { formatUsd } from "./pricing.js";
/** Where a test can point at a stub instead of the real CLI. */
function claudeBinary() {
    return process.env.CONTEXT_DOCTOR_CLAUDE_BIN ?? "claude";
}
function git(cwd, ...args) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function num(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
/** Build the argv for one arm — exported so the dry run and the tests see exactly what runs. */
export function claudeArgs(opts, arm) {
    const args = ["-p", opts.task, "--output-format", "json", "--permission-mode", "acceptEdits"];
    if (opts.model)
        args.push("--model", opts.model);
    args.push("--max-budget-usd", String(opts.budgetUsd ?? 1));
    if (arm === "existing" && opts.existing)
        args.push("--resume", opts.existing, "--fork-session");
    return args;
}
function findTranscript(sessionId, cwd) {
    // Claude Code keys project dirs by the cwd with separators replaced.
    const projectDir = join(homedir(), ".claude", "projects", cwd.replace(/[\\/:]/g, "-"));
    const candidate = join(projectDir, `${sessionId}.jsonl`);
    return existsSync(candidate) ? candidate : undefined;
}
function runArm(opts, arm, cwd) {
    const started = Date.now();
    const proc = spawnSync(claudeBinary(), claudeArgs(opts, arm), {
        cwd,
        encoding: "utf8",
        env: { ...process.env, CLAUDECODE: undefined },
        maxBuffer: 64 * 1024 * 1024,
    });
    const base = {
        arm, costUsd: 0, durationMs: Date.now() - started, turns: 0,
        inputTokens: 0, cacheRead: 0, cacheWrite: 0, outputTokens: 0,
    };
    if (proc.error)
        return { ...base, error: `could not run ${claudeBinary()}: ${proc.error.message}` };
    let parsed;
    try {
        parsed = JSON.parse(proc.stdout);
    }
    catch {
        return { ...base, error: `claude did not return JSON (exit ${proc.status}): ${(proc.stderr || proc.stdout).slice(0, 300)}` };
    }
    const usage = parsed.usage ?? {};
    const result = {
        ...base,
        sessionId: parsed.session_id,
        costUsd: num(parsed.total_cost_usd),
        durationMs: num(parsed.duration_ms) || base.durationMs,
        turns: num(parsed.num_turns),
        inputTokens: num(usage.input_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens),
        outputTokens: num(usage.output_tokens),
        error: parsed.is_error ? `claude reported an error: ${String(parsed.result ?? "").slice(0, 300)}` : undefined,
    };
    if (parsed.session_id) {
        const transcript = findTranscript(parsed.session_id, cwd);
        if (transcript) {
            try {
                result.liveContextTokens = parseSessionFile(transcript).reportedInputTokens;
            }
            catch {
                /* the numbers above stand on their own */
            }
        }
    }
    if (opts.check) {
        const check = spawnSync(opts.check, { cwd, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        result.check = { command: opts.check, passed: check.status === 0, exitCode: check.status ?? -1 };
    }
    try {
        result.diffStat = git(cwd, "diff", "--stat") || "(no changes)";
    }
    catch {
        /* not a git repo after all; the arm still ran */
    }
    return result;
}
export function runExperiment(opts) {
    const cwd = opts.cwd ?? process.cwd();
    if (process.env.CLAUDECODE && !opts.dryRun) {
        return { arms: [], refused: "This runs the claude CLI, which refuses to start inside another Claude Code session. Run the experiment from a regular terminal." };
    }
    let startCommit;
    let clean = false;
    try {
        startCommit = git(cwd, "rev-parse", "HEAD");
        clean = git(cwd, "status", "--porcelain") === "";
    }
    catch {
        return { arms: [], refused: `${cwd} is not a git repository. The experiment needs a commit to reset to between arms.` };
    }
    // A dry run touches nothing, so a dirty tree only needs mentioning.
    if (opts.dryRun)
        return { arms: [], startCommit, treeClean: clean };
    if (!clean && !opts.allowDirty) {
        return { arms: [], refused: "Working tree has uncommitted changes. Both arms must start from the same commit, and the tree is reset between them — commit or stash first (or pass --allow-dirty to accept losing those changes)." };
    }
    const arms = [];
    const reset = () => {
        // Safe only because the tree was verified clean (or the user opted in).
        git(cwd, "reset", "--hard", startCommit);
        git(cwd, "clean", "-fd");
    };
    arms.push(runArm(opts, "fresh", cwd));
    reset();
    if (opts.existing) {
        arms.push(runArm(opts, "existing", cwd));
        reset();
    }
    return { arms, startCommit };
}
export function renderExperiment(result, opts) {
    const lines = [];
    lines.push("CONTEXT DOCTOR — fresh vs existing session");
    lines.push("═".repeat(56));
    if (result.refused) {
        lines.push(`Refused: ${result.refused}`);
        return lines.join("\n");
    }
    lines.push(`task:    ${opts.task}`);
    if (result.startCommit)
        lines.push(`commit:  ${result.startCommit.slice(0, 12)} (both arms start here)`);
    if (opts.model)
        lines.push(`model:   ${opts.model}`);
    if (opts.check)
        lines.push(`check:   ${opts.check}`);
    lines.push(`budget:  ${formatUsd(opts.budgetUsd ?? 1)} per arm`);
    if (opts.dryRun) {
        lines.push("");
        lines.push("Dry run. Commands that would execute:");
        lines.push(`  fresh:    claude ${claudeArgs(opts, "fresh").map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
        if (opts.existing)
            lines.push(`  existing: claude ${claudeArgs(opts, "existing").map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
        lines.push("  (tree is reset to the start commit after each arm)");
        if (result.treeClean === false)
            lines.push("  NOTE: the tree is dirty right now; a real run would refuse unless you commit, stash, or pass --allow-dirty.");
        return lines.join("\n");
    }
    lines.push("");
    const col = (s, w = 14) => s.padStart(w);
    const header = `${"".padEnd(22)}${col("fresh")}${opts.existing ? col("existing") : ""}`;
    lines.push(header);
    lines.push("─".repeat(header.length));
    const row = (label, pick) => {
        lines.push(`${label.padEnd(22)}${result.arms.map((a) => col(pick(a))).join("")}`);
    };
    row("billed input", (a) => formatTokens(a.inputTokens + a.cacheRead + a.cacheWrite));
    row("  of which cache read", (a) => formatTokens(a.cacheRead));
    row("  of which cache write", (a) => formatTokens(a.cacheWrite));
    row("output tokens", (a) => formatTokens(a.outputTokens));
    row("cost", (a) => formatUsd(a.costUsd));
    row("wall clock", (a) => `${(a.durationMs / 1000).toFixed(0)}s`);
    row("turns", (a) => String(a.turns));
    if (result.arms.some((a) => a.liveContextTokens))
        row("live context (last)", (a) => (a.liveContextTokens ? formatTokens(a.liveContextTokens) : "—"));
    if (opts.check)
        row("check", (a) => (a.check ? (a.check.passed ? "PASS" : `FAIL (${a.check.exitCode})`) : "—"));
    lines.push("");
    for (const a of result.arms) {
        if (a.error)
            lines.push(`${a.arm}: ${a.error}`);
        if (a.diffStat && a.diffStat !== "(no changes)")
            lines.push(`${a.arm} changed:\n${a.diffStat.split("\n").map((l) => "  " + l).join("\n")}`);
    }
    // The verdict is the whole point: cheaper is only better if it also passed.
    if (opts.existing && result.arms.length === 2 && opts.check) {
        const [fresh, existing] = result.arms;
        const cheaper = fresh.costUsd <= existing.costUsd ? fresh : existing;
        const other = cheaper === fresh ? existing : fresh;
        if (cheaper.check?.passed && !other.check?.passed) {
            lines.push(`Verdict: ${cheaper.arm} was cheaper AND passed; ${other.arm} failed the check. Clear win for ${cheaper.arm}.`);
        }
        else if (cheaper.check?.passed && other.check?.passed) {
            lines.push(`Verdict: both passed; ${cheaper.arm} was cheaper by ${formatUsd(Math.abs(fresh.costUsd - existing.costUsd))}.`);
        }
        else if (!cheaper.check?.passed && other.check?.passed) {
            lines.push(`Verdict: ${cheaper.arm} was cheaper but FAILED the check. A smaller bill for a wrong answer is not a saving; ${other.arm} wins.`);
        }
        else {
            lines.push("Verdict: neither arm passed the check. Cost comparison is moot until one does.");
        }
    }
    else if (opts.check) {
        lines.push("One arm only. Pass --existing <session-id> to compare against a forked existing session.");
    }
    return lines.join("\n");
}
