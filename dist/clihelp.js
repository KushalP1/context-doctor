/**
 * Helpers for the CLI's argument errors and per-command help: a "did you
 * mean" suggestion for a mistyped flag or command, and one command's lines
 * cut out of the full help text. Kept apart from cli.ts, which runs on
 * import, so they can be tested directly.
 */
/** Edit distance (insert, delete, substitute; each 1). */
export function levenshtein(a, b) {
    if (a === b)
        return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}
/**
 * The closest candidate, when it is close enough to be a typo: within a
 * third of the word's length (at least 2 edits), or one the word is a
 * prefix of (`--strat` for `--strategy`).
 */
export function suggest(word, candidates) {
    let best;
    for (const c of candidates) {
        const d = levenshtein(word, c);
        if (!best || d < best.d)
            best = { c, d };
    }
    if (!best)
        return undefined;
    if (best.d <= Math.max(2, Math.floor(word.length / 3)))
        return best.c;
    const bare = word.replace(/^-+/, "");
    return bare.length >= 3 ? candidates.find((c) => c.replace(/^-+/, "").startsWith(bare)) : undefined;
}
/** "Did you mean …?" or nothing. */
export function didYouMean(word, candidates) {
    const s = suggest(word, candidates);
    return s ? ` Did you mean ${s}?` : "";
}
/** Split help text into entries: a line indented 2 spaces, plus the deeper-indented lines under it. */
function entries(help) {
    const out = [];
    let section = "";
    let cur;
    for (const line of help.split("\n")) {
        if (/^\S.*:\s*$/.test(line)) {
            section = line.trim().replace(/:$/, "");
            cur = undefined;
        }
        else if (/^\S/.test(line)) {
            section = "";
            cur = undefined;
        }
        else if (/^ {2}\S/.test(line)) {
            cur = { section, lines: [line] };
            out.push(cur);
        }
        else if (/^ {3,}\S/.test(line) && cur) {
            cur.lines.push(line);
        }
        else if (line.trim() === "") {
            cur = undefined;
        }
    }
    return out;
}
/** Commands a usage line documents: `  context-doctor <cmd> …`. */
function usageCommand(line) {
    return /^ {2}context-doctor\s+([a-z][\w-]*)/.exec(line)?.[1];
}
/** Does an option's text scope it to `cmd`, as in "(savings, compact-window)" or "(analyze/session)"? */
function optionScoped(text, cmd) {
    for (const m of text.matchAll(/\(([^)]*)\)/g)) {
        const names = m[1].split(/[,/]/).map((s) => s.trim().split(/\s+/)[0]);
        if (names.includes(cmd))
            return true;
    }
    return false;
}
/** Every command the help text documents, in order. */
export function documentedCommands(help) {
    const seen = new Set();
    for (const e of entries(help)) {
        if (e.section === "Options" || e.section === "Examples")
            continue;
        const c = usageCommand(e.lines[0]);
        if (c)
            seen.add(c);
    }
    return [...seen];
}
/**
 * One command's help, cut from the full text: its usage line(s), the options
 * scoped to it, and its examples. Undefined when the help has no usage line
 * for it.
 */
export function commandHelp(help, cmd) {
    const all = entries(help);
    const usage = all.filter((e) => e.section !== "Options" && e.section !== "Examples" && usageCommand(e.lines[0]) === cmd);
    if (usage.length === 0)
        return undefined;
    const options = all.filter((e) => e.section === "Options" && optionScoped(e.lines.join(" "), cmd));
    const examples = all.filter((e) => e.section === "Examples" && usageCommand(e.lines[0]) === cmd);
    const out = ["Usage:", ...usage.flatMap((e) => e.lines)];
    if (options.length)
        out.push("", "Options:", ...options.flatMap((e) => e.lines));
    if (examples.length)
        out.push("", "Examples:", ...examples.flatMap((e) => e.lines));
    out.push("", "All commands and options: context-doctor --help");
    return out.join("\n");
}
