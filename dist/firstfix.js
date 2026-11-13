/**
 * What a bare `context-doctor` shows in a terminal with Claude Code history:
 * the plan, not the report, and one question.
 *
 * `fix` lists every lever with how it was measured, what it costs in quality
 * and what it writes: 30 to 50 lines and a question per lever. The author,
 * who wrote every lever, applied none of them that way. So the first screen
 * splits `fix`'s own plan (the same replays, one scan) in two:
 *  - the fixes whose quality line is "none" (`Fix.qualityFree`: the model
 *    sees the same content, or the same content moved where it can open it,
 *    on the same model), one line each with one total and ONE y/N question
 *    that applies them all through `applyFix`, as `fix --apply <ids>` does;
 *  - the ones that trade something (compacting earlier, autopilot clearing
 *    output, the subagents' model, Codex's limit), one line each with their
 *    dollars and the command that applies each, after reading it in `fix`.
 * Nothing is written without a `y` typed in a terminal.
 */
import { money, overlaps } from "./fix.js";
import { priceBasis } from "./orgrates.js";
export function splitFirstFixes(fixes) {
    const avail = fixes.filter((f) => f.state === "available");
    return {
        free: avail.filter((f) => f.qualityFree === true),
        other: avail.filter((f) => f.qualityFree !== true),
        applied: fixes.filter((f) => f.state === "applied"),
    };
}
const fixes = (n) => `${n} fix${n === 1 ? "" : "es"}`;
const amount = (f) => (f.savedUsd !== undefined ? money(f.savedUsd) : "not priced").padStart(10);
/** The screen, everything but the question itself (under 25 lines whatever the plan). */
export function renderFirstScreen(s) {
    const { free, other, applied } = splitFirstFixes(s.fixes);
    const codex = s.codexBilledUsd ?? 0;
    const out = [];
    if (s.recordProblem)
        out.push(`⚠ ${s.recordProblem}`);
    if (codex > 0 && s.billedUsd > 0)
        out.push(`context-doctor: your last ${s.days} days, Claude Code ${money(s.billedUsd)} of input and Codex ${money(codex)}, ${priceBasis()}`);
    else if (codex > 0)
        out.push(`context-doctor: your last ${s.days} days of Codex, ${money(codex)} of input ${priceBasis()}`);
    else
        out.push(`context-doctor: your last ${s.days} days of Claude Code, ${money(s.billedUsd)} of input ${priceBasis()}`);
    if (s.billedUsd + codex <= 0) {
        out.push(`No Claude Code sessions in the last ${s.days} days to measure yet, so no fix can be priced; ${s.command("fix")} once there are.`);
        return out.join("\n");
    }
    const per = s.days === 30 ? "a month" : `in ${s.days} days`;
    if (free.length) {
        const priced = free.filter((f) => f.savedUsd !== undefined);
        const total = priced.reduce((t, f) => t + f.savedUsd, 0);
        const sum = priced.length ? `${money(total)} ${per}${priced.length < free.length ? ` (${free.length - priced.length} more not priced)` : ""}` : `${fixes(free.length)}, not priced`;
        out.push("");
        out.push(`Free of any quality cost: ${sum}`);
        for (const f of free)
            out.push(`  ${amount(f)}  ${f.title}${f.overriddenBy?.length ? " (⚠ overridden here: see fix)" : ""}`);
        // Each lever is replayed alone; two that save part of the same dollars do not add up.
        if (overlaps(priced).length)
            out.push("              each measured alone; they overlap, so together a little less");
    }
    if (other.length) {
        out.push("");
        out.push(`These trade something for money; read each in ${s.command("fix")} first:`);
        const width = Math.min(60, Math.max(...other.map((f) => f.title.length)));
        for (const f of other)
            out.push(`  ${amount(f)}  ${f.title.padEnd(width)}   ${s.command(`fix --apply ${f.id}`)}`);
    }
    out.push("");
    if (applied.length)
        out.push(`Applied before: ${applied.map((f) => f.id).join(", ")}; ${s.command("fix")} shows what each saved since.`);
    out.push(`The full report: ${s.command("savings")}. All commands: ${s.command("--help")}`);
    if (!free.length)
        out.push(`Nothing to apply without a quality cost here; ${s.command("fix")} shows every lever, measured.`);
    else if (!s.ask && !s.recordProblem)
        out.push(`Apply ${free.length === 1 ? "it" : "them"}: ${s.command(`fix --apply ${free.map((f) => f.id).join(",")}`)} (undo any time: ${s.command("fix undo")})`);
    return out.join("\n");
}
/** The one question, for the quality-free fixes together. */
export function firstQuestion(n, command) {
    return `Apply ${n === 1 ? "this fix" : `these ${n} fixes`}? (undo any time: ${command("fix undo")}) [y/N] `;
}
