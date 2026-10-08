/**
 * `context-doctor overhead split <file>`: turn a heavy memory file into a lean
 * one plus a reference file the agent opens when a task needs it.
 *
 * A memory file (CLAUDE.md, AGENTS.md, an auto-memory index) is re-read on
 * every request. Rules belong there; reference material (architecture notes,
 * long examples, field lists) is needed on few requests. Sections over a size
 * threshold, or made mostly of code, move to `<name>.reference.md` next to the
 * file, and each leaves a one-line pointer naming the file and section: a
 * plain path, not an @import, so it is read on demand instead of loaded.
 *
 * Shown as a plan first; written only with --write, after a backup. Nothing
 * is summarized or dropped: every moved line is in the reference file.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { estimateTokens, formatTokens } from "./tokens.js";
import { formatUsd } from "./pricing.js";
const CLAUDE = "claude-opus-5";
/** Sections at the file's top heading level below the title (## in most memory files). */
function sections(text) {
    const lines = text.split("\n");
    const headingLevels = [];
    let fence = false;
    for (const l of lines) {
        if (/^\s*(```|~~~)/.test(l))
            fence = !fence;
        const m = !fence && /^(#{1,6})\s+\S/.exec(l);
        if (m)
            headingLevels.push(m[1].length);
    }
    // Split at the shallowest level that occurs more than once (a lone H1 is the title).
    const counts = new Map();
    for (const h of headingLevels)
        counts.set(h, (counts.get(h) ?? 0) + 1);
    const level = [...counts.keys()].sort((a, b) => a - b).find((h) => counts.get(h) > 1) ?? 2;
    const preamble = [];
    const list = [];
    fence = false;
    for (const l of lines) {
        if (/^\s*(```|~~~)/.test(l))
            fence = !fence;
        const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
        if (m && m[1].length === level)
            list.push({ heading: m[2], level, lines: [l] });
        else if (list.length)
            list[list.length - 1].lines.push(l);
        else
            preamble.push(l);
    }
    return { preamble, list, level };
}
function codeShare(text) {
    let code = 0;
    for (const m of text.matchAll(/```[\s\S]*?```/g))
        code += m[0].length;
    return text.length ? code / text.length : 0;
}
export function referencePathFor(path) {
    const ext = extname(path) || ".md";
    return join(dirname(path), `${basename(path, ext)}.reference${ext}`);
}
/** A section made mostly of link lines is an index: it is what lets the agent find everything else. */
function isIndex(lines) {
    const items = lines.slice(1).filter((l) => l.trim());
    return items.length > 0 && items.filter((l) => /\]\([^)]+\)/.test(l)).length / items.length >= 0.5;
}
/**
 * Plan the split; pure apart from reading the file. An auto-memory MEMORY.md
 * is meant to be an index (Claude Code loads it on every request and reads
 * topic files on demand), so everything in it that is not an index moves,
 * whatever its size.
 */
export function planSplit(path, { minTokens = 400 } = {}) {
    const text = readFileSync(path, "utf8");
    const referencePath = referencePathFor(path);
    const refName = basename(referencePath);
    const memoryIndex = basename(path) === "MEMORY.md";
    const { preamble, list } = sections(text);
    const kept = [...preamble];
    const moved = [];
    const out = [];
    let group = [];
    // Consecutive moved sections share one pointer, so the lean file does not fill up with them.
    const flush = () => {
        if (group.length === 0)
            return;
        const names = group.map((g) => g.heading);
        const tokens = group.reduce((t, g) => t + g.tokens, 0);
        if (memoryIndex) {
            kept.push(`- [${names.join("; ")}](${refName}) — moved out of the index (~${formatTokens(tokens)} tokens); read when a task involves them`, "");
        }
        else if (group.length === 1) {
            kept.push(`## ${names[0]}`, `Moved to ${refName} § "${names[0]}" (~${formatTokens(tokens)} tokens). Read that section when a task involves it.`, "");
        }
        else {
            kept.push(`Sections moved to ${refName} (~${formatTokens(tokens)} tokens): ${names.map((n) => `"${n}"`).join(", ")}. Read the one a task involves.`, "");
        }
        group = [];
    };
    for (const s of list) {
        const body = s.lines.join("\n");
        const tokens = estimateTokens(body, CLAUDE);
        const reason = isIndex(s.lines)
            ? undefined
            : memoryIndex
                ? "not index"
                : tokens >= minTokens
                    ? "large"
                    : tokens >= 150 && codeShare(body) > 0.5
                        ? "code"
                        : undefined;
        const section = { heading: s.heading, tokens, moved: !!reason, reason };
        out.push(section);
        if (!reason) {
            flush();
            kept.push(...s.lines);
            continue;
        }
        moved.push(body.replace(/\n\s*$/, ""), "");
        group.push(section);
    }
    flush();
    const keptText = kept.join("\n").replace(/\n{3,}/g, "\n\n");
    const header = `# Reference moved out of ${basename(path)}\n\nRead a section when a task needs it; ${basename(path)} points here by section name.\n\n`;
    const movedText = moved.length ? header + moved.join("\n") : "";
    return {
        path,
        referencePath,
        sections: out,
        keptText,
        movedText,
        tokensBefore: estimateTokens(text, CLAUDE),
        tokensAfter: estimateTokens(keptText, CLAUDE),
    };
}
/** Write the plan: back up the original, write the lean file, append to (or create) the reference file. */
export function applySplit(plan, now = Date.now()) {
    const backup = `${plan.path}.context-doctor-backup-${now}`;
    copyFileSync(plan.path, backup);
    if (existsSync(plan.referencePath)) {
        const prev = readFileSync(plan.referencePath, "utf8");
        writeFileSync(plan.referencePath, prev.trimEnd() + "\n\n" + plan.movedText.replace(/^# Reference moved out of[^\n]*\n\n[^\n]*\n\n/, ""));
    }
    else {
        writeFileSync(plan.referencePath, plan.movedText);
    }
    writeFileSync(plan.path, plan.keptText);
    return { backup };
}
export function renderSplit(plan, usdPerKPerMonth) {
    const out = [];
    const saved = plan.tokensBefore - plan.tokensAfter;
    out.push(`SPLIT PLAN for ${plan.path}`, "═".repeat(56));
    if (!plan.sections.some((s) => s.moved)) {
        out.push(`Nothing to move: no section reaches the threshold. ~${formatTokens(plan.tokensBefore)} tokens stay as they are.`);
        return out.join("\n");
    }
    for (const s of plan.sections) {
        out.push(`  ${s.moved ? "→ move" : "  keep"}  ~${formatTokens(s.tokens).padStart(5)}  ${s.heading}${s.reason === "code" ? "  (mostly code)" : s.reason === "not index" ? "  (not an index entry)" : ""}`);
    }
    const usd = usdPerKPerMonth ? `, ~${formatUsd((saved / 1000) * usdPerKPerMonth)}/month at your usage` : "";
    out.push("", `Every request: ~${formatTokens(plan.tokensBefore)} → ~${formatTokens(plan.tokensAfter)} tokens (−${formatTokens(saved)}${usd}).`, `Moved sections go to ${plan.referencePath}, word for word; each leaves a pointer the agent follows when a task needs it.`, "Nothing is written yet. Add --write to apply (the original is backed up first).");
    return out.join("\n");
}
