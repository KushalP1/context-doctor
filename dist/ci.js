/**
 * `context-doctor ci`: the memory-file check for pull requests.
 *
 * CLAUDE.md, AGENTS.md, GEMINI.md and always-applied rules are re-read on
 * every request of every session by everyone who works in the repository, so
 * a PR that grows them by 2k tokens is a standing cost nobody reviews. This
 * compares those files (and what they @import) at HEAD against a base commit,
 * prints a table, and exits 1 over a budget, so CI can comment and gate.
 *
 * Base contents come from `git show <base>:<path>`; nothing is checked out.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { estimateTokens, formatTokens } from "./tokens.js";
import { formatUsd, pricingFor } from "./pricing.js";
const CLAUDE = "claude-opus-5";
/** Repo-relative paths (posix) that agents load on every request. */
const MEMORY_PATTERNS = [
    [/(^|\/)CLAUDE(\.local)?\.md$/, "Claude Code"],
    [/(^|\/)\.claude\/CLAUDE\.md$/, "Claude Code"],
    [/(^|\/)\.claude\/rules\/.+\.md$/, "Claude Code"],
    [/(^|\/)AGENTS(\.override)?\.md$/, "Codex"],
    [/(^|\/)GEMINI\.md$/, "Gemini CLI"],
    [/(^|\/)\.cursorrules$/, "Cursor"],
    [/(^|\/)\.cursor\/rules\/.+\.mdc?$/, "Cursor"],
];
function git(args, cwd) {
    try {
        return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    }
    catch {
        return undefined;
    }
}
function agentFor(path) {
    return MEMORY_PATTERNS.find(([re]) => re.test(path))?.[1];
}
/** Cursor rules count only when always applied; the rest load on demand. */
function counts(path, text) {
    return !/\.mdc?$/.test(path) || !path.includes(".cursor/rules/") || /^alwaysApply:\s*true/m.test(text);
}
/** `@path` imports (Claude Code), resolved relative to the importing file, repo-relative. */
function importsOf(text, from) {
    const out = [];
    let fence = false;
    for (const line of text.split("\n")) {
        if (/^\s*(```|~~~)/.test(line))
            fence = !fence;
        if (fence)
            continue;
        for (const m of line.replace(/`[^`]*`/g, "").matchAll(/(?:^|\s)@((?:\.{0,2}\/|[\w.-]+\/)[^\s)]+|[\w.-]+\.\w+)/g)) {
            if (m[1].startsWith("/") || m[1].startsWith("~"))
                continue; // outside the repo
            out.push(posix.normalize(posix.join(posix.dirname(from), m[1])));
        }
    }
    return out.filter((p) => !p.startsWith(".."));
}
/** Token totals per memory file, with a reader for one side (HEAD from disk, base from git). */
function measure(paths, read) {
    const out = new Map();
    const visit = (p, imported, depth) => {
        if (out.has(p))
            return;
        const text = read(p);
        if (text === undefined || !counts(p, text))
            return;
        out.set(p, { tokens: estimateTokens(text, CLAUDE), imported });
        // Only Claude Code resolves @imports; an imported file can import further.
        if (depth < 4 && (imported || agentFor(p) === "Claude Code"))
            for (const i of importsOf(text, p))
                visit(i, true, depth + 1);
    };
    for (const p of paths)
        visit(p, false, 0);
    return out;
}
/** `-z` output: without it git quotes non-ASCII paths ("caf\303\251/CLAUDE.md") and they match nothing. */
const paths0 = (out) => (out ?? "").split("\0").filter(Boolean);
/** A file on disk, not a directory: `@src/components` names a folder, which Claude Code does not load. */
function isFile(p) {
    try {
        return statSync(p).isFile();
    }
    catch {
        return false;
    }
}
export function ciReport(opts = {}) {
    const cwd = opts.cwd ?? process.cwd();
    // Outside a repository `git ls-files` lists nothing, which used to read as
    // "No agent memory files" with exit 0: a CI step in the wrong directory
    // passed every pull request. It is an error, said as one.
    const root = git(["rev-parse", "--show-toplevel"], cwd)?.trim();
    if (!root) {
        throw new Error(git(["--version"], cwd) === undefined
            ? "ci needs git, and git is not installed or not on PATH."
            : `ci compares memory files in a git repository, and ${cwd} is not inside one. Run it from the repository's checkout.`);
    }
    // A base git cannot resolve (a typo, or a shallow clone that never fetched
    // it) would read as an empty tree: every file "new", and a failure that
    // blames the PR for the whole memory set. Stop and say so instead.
    if (opts.base && git(["rev-parse", "--verify", "--quiet", `${opts.base}^{commit}`], root) === undefined) {
        throw new Error(`--base ${opts.base} is not a commit in ${root}: check the name, or fetch it first (a shallow clone: git fetch --depth=1 origin ${opts.base})`);
    }
    const headList = paths0(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root));
    const baseList = opts.base ? paths0(git(["ls-tree", "-r", "-z", "--name-only", opts.base], root)) : [];
    // ls-tree -r lists blobs only, so a path outside it (a folder, a missing file) has no base content;
    // `git show base:folder` would print the folder's listing and count it as an imported file.
    const baseFiles = new Set(baseList);
    const head = measure(headList.filter((p) => agentFor(p)), (p) => (isFile(join(root, p)) ? readFileSync(join(root, p), "utf8") : undefined));
    const base = opts.base ? measure(baseList.filter((p) => agentFor(p)), (p) => (baseFiles.has(p) ? git(["show", `${opts.base}:${p}`], root) : undefined)) : new Map();
    const files = [...new Set([...head.keys(), ...base.keys()])].sort().map((p) => ({
        path: p,
        agent: agentFor(p) ?? "Claude Code",
        base: base.get(p)?.tokens ?? 0,
        head: head.get(p)?.tokens ?? 0,
        imported: (head.get(p) ?? base.get(p))?.imported || undefined,
    }));
    const baseTotal = files.reduce((s, f) => s + f.base, 0);
    const headTotal = files.reduce((s, f) => s + f.head, 0);
    const breaches = [];
    if (opts.maxTokens !== undefined && headTotal > opts.maxTokens)
        breaches.push(`memory files total ~${formatTokens(headTotal)} tokens, over the ${formatTokens(opts.maxTokens)} budget`);
    if (opts.base && opts.maxIncrease !== undefined && headTotal - baseTotal > opts.maxIncrease) {
        breaches.push(`this change adds ~${formatTokens(headTotal - baseTotal)} tokens, over the ${formatTokens(opts.maxIncrease)} allowed increase`);
    }
    return { base: opts.base, files, baseTotal, headTotal, breaches };
}
const signed = (n) => (n > 0 ? `+${formatTokens(n)}` : n < 0 ? `−${formatTokens(-n)}` : "0");
/** Markdown for a PR comment or a job summary. */
export function renderCiMarkdown(r, opts = {}) {
    // The marker lets the GitHub Action find and update its own comment.
    const out = ["<!-- context-doctor -->", "### context-doctor: what every agent request re-reads", ""];
    if (r.files.length === 0) {
        out.push("No agent memory files (CLAUDE.md, AGENTS.md, GEMINI.md, rules) in this repository.");
        return out.join("\n");
    }
    const changed = r.base ? r.files.filter((f) => f.base !== f.head) : r.files;
    const delta = r.headTotal - r.baseTotal;
    out.push(r.base
        ? `Memory files: **~${formatTokens(r.baseTotal)} → ~${formatTokens(r.headTotal)} tokens (${signed(delta)})**, loaded into every request of every session in this repo.`
        : `Memory files: **~${formatTokens(r.headTotal)} tokens**, loaded into every request of every session in this repo.`);
    const price = pricingFor(opts.model ?? "claude-sonnet-5");
    if (price && opts.requestsPerDay && r.base && delta !== 0) {
        // Cache reads on warm requests; this is the floor of the cost, cold starts add to it.
        const usd = ((delta * price.cacheReadPerM) / 1e6) * opts.requestsPerDay * 30;
        out.push(`At ${opts.requestsPerDay.toLocaleString("en-US")} requests a day on ${opts.model ?? "claude-sonnet-5"} (cached reads), that is ${usd >= 0 ? "+" : "−"}${formatUsd(Math.abs(usd))} a month.`);
    }
    out.push("");
    if (changed.length) {
        out.push(r.base ? "| File | Agent | Base | This PR | Change |" : "| File | Agent | Tokens |", r.base ? "|---|---|---:|---:|---:|" : "|---|---|---:|");
        for (const f of changed) {
            const name = `\`${f.path}\`${f.imported ? " (imported)" : ""}`;
            out.push(r.base ? `| ${name} | ${f.agent} | ${f.base ? "~" + formatTokens(f.base) : "—"} | ${f.head ? "~" + formatTokens(f.head) : "—"} | ${signed(f.head - f.base)} |` : `| ${name} | ${f.agent} | ~${formatTokens(f.head)} |`);
        }
    }
    else {
        out.push("No memory file changed in this PR.");
    }
    if (r.breaches.length)
        out.push("", ...r.breaches.map((b) => `**Over budget:** ${b}.`));
    const big = r.files.filter((f) => f.head >= 2000);
    if (big.length)
        out.push("", `Large files: ${big.map((f) => `\`${f.path}\``).join(", ")}. \`npx context-doctor overhead split <file>\` moves reference sections out, word for word.`);
    return out.join("\n");
}
/** Plain-text rendering for a terminal. */
export function renderCiText(r) {
    return renderCiMarkdown(r).replace("<!-- context-doctor -->\n", "").replace(/^### /m, "").replace(/\*\*/g, "").replace(/`/g, "");
}
