/**
 * `spend --export` and `spend merge`: a team's spend without a dashboard.
 *
 * Each developer runs `spend --export` and puts the file in a folder the
 * team already shares (a drive, a repository); `spend merge <folder>` adds
 * the files up. Nothing is sent anywhere: the files go where people put them.
 *
 * An export holds totals only: per local day, tool, model and repository
 * (and branch, with `--by branch`), the requests, tokens and dollars. No
 * prompt, no path, no project or session name: a repository is its folder's
 * base name, or with `--anonymize` a hash of it (the same name hashes the
 * same on every machine, so merged files still line up). The developer is a
 * label the person chooses (`--as`), by default their OS user name.
 *
 * Merging: a developer's files that cover the same day (an export run twice)
 * count that day once, from the newest file. Developers are listed in
 * alphabetical order, not by spend: the per-repository and per-tool views
 * are the ones meant for decisions.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { localDay, TOOL_NAME, TOOLS, usd } from "./spend.js";
import { formatTokens } from "./tokens.js";
export const EXPORT_KIND = "context-doctor spend export";
export const EXPORT_VERSION = 1;
/** The OS user name, the default developer label. */
export function defaultDeveloper() {
    try {
        const n = userInfo().username.trim();
        if (n)
            return n;
    }
    catch { /* none */ }
    return process.env.USER || process.env.USERNAME || "me";
}
/** "repo-" or "branch-" and 10 hex: the same name, the same hash, on every machine. */
export function anonymize(kind, name) {
    return `${kind}-${createHash("sha256").update(`context-doctor ${kind}\u0000${name}`).digest("hex").slice(0, 10)}`;
}
/** Names that say there is none, kept as they are under --anonymize. */
const NO_NAME = new Set(["(no folder)", "(home)"]);
/**
 * An export of `items` (collectSpend's, with `by: "repo"` or `"branch"`).
 * A request's repository is its folder's (spendplace.ts); Gemini CLI, which
 * records no folder, keeps its project's name (a folder's base name or a
 * hash Gemini made); anything else with no folder is "(no folder)".
 */
export function buildExport(items, o) {
    const rows = new Map();
    for (const it of items) {
        let repo = it.root || it.cwd ? it.repo ?? "(no folder)" : it.tool === "gemini" ? it.project : "(no folder)";
        let branch = o.branches ? it.branch : undefined;
        if (o.anonymize) {
            if (!NO_NAME.has(repo))
                repo = anonymize("repo", repo);
            if (branch)
                branch = anonymize("branch", branch);
        }
        const model = it.model ?? "unknown";
        const day = localDay(it.ts);
        const k = [day, it.tool, model, repo, branch ?? ""].join("\u0000");
        const r = rows.get(k) ?? rows.set(k, { day, tool: it.tool, model, repo, ...(branch ? { branch } : {}), requests: 0, usd: 0, unpriced: 0, tokens: { input: 0, read: 0, write: 0, output: 0 } }).get(k);
        if (!it.iteration)
            r.requests++; // an iteration a request's usage left out is billed, not a request of its own
        r.usd += it.usd;
        if (!it.priced)
            r.unpriced++;
        r.tokens.input += it.input;
        r.tokens.read += it.read;
        r.tokens.write += it.write;
        r.tokens.output += it.output;
        if (it.credits !== undefined)
            r.credits = (r.credits ?? 0) + it.credits;
        if (it.premium !== undefined)
            r.premium = (r.premium ?? 0) + it.premium;
    }
    return {
        kind: EXPORT_KIND, version: EXPORT_VERSION, developer: o.developer, exportedAt: new Date(o.now ?? Date.now()).toISOString(),
        days: o.days, from: localDay(o.since), to: localDay(o.until), basis: o.basis, anonymized: Boolean(o.anonymize), byBranch: Boolean(o.branches),
        rows: [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || a.tool.localeCompare(b.tool) || b.usd - a.usd),
    };
}
/** A file name for an export: the developer's label made safe, and its last day. */
export function exportFileName(e) {
    return `context-doctor-spend-${e.developer.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "me"}-${e.to}.json`;
}
/** What `spend --export` says after writing the file. */
export function renderExportDone(e, file) {
    const total = e.rows.reduce((n, r) => n + r.usd, 0), requests = e.rows.reduce((n, r) => n + r.requests, 0);
    return [
        `Wrote ${file}: ${usd(total)} over ${requests.toLocaleString("en-US")} requests, ${e.from} to ${e.to}, as ${e.developer}.`,
        `It holds totals by day, tool, model and ${e.anonymized ? "hashed " : ""}repository${e.byBranch ? ` and ${e.anonymized ? "hashed " : ""}branch` : ""}: no prompt, path, project or session.`,
        "Put it in a folder your team shares; context-doctor spend merge <folder> adds them up.",
    ].join("\n");
}
const isRow = (r) => r && typeof r === "object" && typeof r.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && TOOLS.includes(r.tool) && typeof r.model === "string" && typeof r.repo === "string" &&
    typeof r.requests === "number" && typeof r.usd === "number" && Number.isFinite(r.usd) && typeof r.unpriced === "number" && r.tokens && typeof r.tokens === "object";
/** An export file's content, or why it is not one. */
export function parseExport(text) {
    let e;
    try {
        e = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    }
    catch {
        return "not JSON";
    }
    if (e?.kind !== EXPORT_KIND)
        return "not a context-doctor spend export";
    if (e.version !== EXPORT_VERSION)
        return `export version ${JSON.stringify(e.version)}, this context-doctor reads ${EXPORT_VERSION}`;
    if (typeof e.developer !== "string" || !e.developer || typeof e.from !== "string" || typeof e.to !== "string" || !Array.isArray(e.rows))
        return "missing its developer, days or rows";
    if (!e.rows.every(isRow))
        return "a row is not a spend total";
    return e;
}
/** Every export in `folder` (its own files, not its subfolders), and the files that are not. */
export function readExports(folder) {
    const exports = [], skipped = [];
    for (const name of readdirSync(folder).sort()) {
        if (!name.toLowerCase().endsWith(".json"))
            continue;
        let text;
        try {
            text = readFileSync(join(folder, name), "utf8");
        }
        catch (e) {
            skipped.push({ file: name, reason: e.code === "EISDIR" ? "a folder" : "unreadable" });
            continue;
        }
        const r = parseExport(text);
        if (typeof r === "string")
            skipped.push({ file: name, reason: r });
        else
            exports.push({ file: name, data: r });
    }
    return { exports, skipped };
}
/** "YYYY-MM-DD" days from `a` to `b`, both included. */
function daysBetween(a, b) {
    const out = [];
    const end = Date.parse(`${b}T00:00:00Z`);
    for (let t = Date.parse(`${a}T00:00:00Z`); Number.isFinite(t) && t <= end && out.length < 4000; t += 86_400_000)
        out.push(new Date(t).toISOString().slice(0, 10));
    return out;
}
/** Add up exports: each developer's day once (their newest file that covers it), then by developer, repository, tool, model and day. */
export function mergeExports(exports, skipped = []) {
    const byDev = new Map();
    for (const e of exports)
        (byDev.get(e.data.developer) ?? byDev.set(e.data.developer, []).get(e.data.developer)).push(e);
    const rows = [];
    const developers = [];
    let overlaps = 0;
    for (const [developer, files] of byDev) {
        files.sort((a, b) => b.data.exportedAt.localeCompare(a.data.exportedAt) || b.data.to.localeCompare(a.data.to));
        const claimed = new Map();
        for (const f of files)
            for (const d of daysBetween(f.data.from, f.data.to)) {
                if (claimed.has(d))
                    overlaps++;
                else
                    claimed.set(d, f.data);
            }
        for (const f of files)
            for (const r of f.data.rows)
                if (claimed.get(r.day) === f.data)
                    rows.push({ ...r, developer });
        const days = [...claimed.keys()].sort();
        developers.push({ name: developer, usd: 0, requests: 0, unpriced: 0, from: days[0] ?? "", to: days[days.length - 1] ?? "", files: files.length });
    }
    const group = (key) => {
        const m = new Map();
        for (const r of rows) {
            const k = key(r);
            if (k === undefined)
                continue;
            const g = m.get(k) ?? m.set(k, { name: k, usd: 0, requests: 0, unpriced: 0, tools: [] }).get(k);
            g.usd += r.usd;
            g.requests += r.requests;
            g.unpriced += r.unpriced;
            if (!g.tools.includes(r.tool))
                g.tools.push(r.tool);
        }
        return [...m.values()].map((g) => ({ ...g, tools: TOOLS.filter((t) => g.tools.includes(t)) })).sort((a, b) => b.usd - a.usd || b.requests - a.requests || a.name.localeCompare(b.name));
    };
    const devTotals = new Map(group((r) => r.developer).map((g) => [g.name, g]));
    for (const d of developers)
        Object.assign(d, { usd: devTotals.get(d.name)?.usd ?? 0, requests: devTotals.get(d.name)?.requests ?? 0, unpriced: devTotals.get(d.name)?.unpriced ?? 0, tools: devTotals.get(d.name)?.tools ?? [] });
    developers.sort((a, b) => a.name.localeCompare(b.name));
    const from = developers.map((d) => d.from).filter(Boolean).sort()[0] ?? "";
    const to = developers.map((d) => d.to).filter(Boolean).sort().pop() ?? "";
    const perDay = new Map();
    for (const r of rows)
        perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.usd);
    const daily = from ? daysBetween(from, to).map((day) => ({ day, usd: perDay.get(day) ?? 0 })) : [];
    const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
    const report = {
        files: exports.length, developers, from, to,
        usd: sum((r) => r.usd), requests: sum((r) => r.requests), unpriced: sum((r) => r.unpriced),
        tokens: { input: sum((r) => r.tokens.input ?? 0), read: sum((r) => r.tokens.read ?? 0), write: sum((r) => r.tokens.write ?? 0), output: sum((r) => r.tokens.output ?? 0) },
        repos: group((r) => r.repo), tools: group((r) => r.tool), models: group((r) => r.model),
        daily,
        endsEarly: developers.filter((d) => d.to && d.to < to).map((d) => ({ developer: d.name, to: d.to })),
        overlaps,
        bases: [...new Set(exports.map((e) => e.data.basis))],
        anonymized: exports.some((e) => e.data.anonymized),
        skipped,
    };
    if (rows.some((r) => r.branch))
        report.branches = group((r) => (r.branch ? `${r.repo} ${r.branch}` : undefined));
    if (rows.some((r) => r.credits !== undefined))
        report.credits = sum((r) => r.credits ?? 0);
    if (rows.some((r) => r.premium !== undefined))
        report.premium = sum((r) => r.premium ?? 0);
    // The month of the last day: so far, and the rest at the pace of the last 14 days (fewer when the files hold fewer).
    if (to) {
        const month = to.slice(0, 7);
        const soFar = daily.filter((d) => d.day.startsWith(month)).reduce((n, d) => n + d.usd, 0);
        const recent = daily.slice(-14);
        const pace = recent.reduce((n, d) => n + d.usd, 0) / Math.max(1, recent.length);
        const [y, m] = month.split("-").map(Number);
        const daysLeft = new Date(Date.UTC(y, m, 0)).getUTCDate() - Number(to.slice(8, 10));
        report.forecast = { month, soFar, perDay: pace, paceDays: recent.length, daysLeft, usd: soFar + pace * daysLeft };
    }
    return report;
}
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const share = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "");
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** `spend merge`'s text, within 80 columns. `top`: rows per list. */
export function renderMerge(r, folder, top = 8) {
    const lines = [];
    if (!r.files) {
        lines.push(`No spend exports in ${folder}. Each person runs \`context-doctor spend --export\` and puts the file there.`);
        for (const s of r.skipped)
            lines.push(`  ${s.file}: ${s.reason}`);
        return lines.join("\n");
    }
    const devs = r.developers.length;
    lines.push(`Team spend: ${r.files} ${r.files === 1 ? "export" : "exports"}, ${devs} ${devs === 1 ? "developer" : "developers"}, ${r.from} to ${r.to}`);
    lines.push(`Each request ${r.bases.length === 1 ? r.bases[0] : `priced as its export says (${r.bases.join("; ")})`}${r.anonymized ? "; repository and branch names hashed" : ""}`);
    lines.push("─".repeat(60));
    lines.push(`${"Total".padEnd(14)}${usd(r.usd).padStart(11)}  ${r.requests.toLocaleString("en-US")} requests`);
    const f = r.forecast;
    if (f) {
        const name = `${MONTH_NAMES[Number(f.month.slice(5, 7)) - 1]} ${f.month.slice(0, 4)}`;
        lines.push(f.daysLeft > 0
            ? `${name}: ${usd(f.soFar)} so far; ~${usd(f.usd)} by month-end at the last ${f.paceDays} ${f.paceDays === 1 ? "day's" : "days'"} ${usd(f.perDay)}/day (an estimate)`
            : `${name}: ${usd(f.soFar)}, the whole month`);
    }
    const list = (title, rows, tail) => {
        lines.push("", title);
        for (const x of rows.slice(0, top))
            lines.push(`  ${clip(x.name, 34).padEnd(34)}${usd(x.usd).padStart(10)}  ${share(x.usd, r.usd).padStart(4)}${tail ? `  ${tail(x)}` : ""}`);
        if (rows.length > top)
            lines.push(`  … and ${rows.length - top} more`);
    };
    const toolsOf = (x) => (r.tools.length > 1 ? (x.tools ?? []).map((t) => TOOL_NAME[t]).join(", ") : "");
    list("By developer (alphabetical)", r.developers, (x) => {
        const d = x;
        return d.from === r.from && d.to === r.to ? "" : `${d.from} to ${d.to}`;
    });
    list("By repository", r.repos, toolsOf);
    if (r.branches)
        list("By branch", r.branches, toolsOf);
    list("By tool", r.tools.map((t) => ({ ...t, name: TOOL_NAME[t.name] ?? t.name })), (x) => `${x.requests.toLocaleString("en-US")} requests`);
    list("By model", r.models, (x) => (x.usd === 0 && x.unpriced ? "not priced" : ""));
    const notes = [];
    if (r.unpriced)
        notes.push(`${r.unpriced.toLocaleString("en-US")} requests on models with no list price are counted, not in the dollars.`);
    if (r.credits !== undefined || r.premium !== undefined)
        notes.push(`Copilot CLI counted ${[r.credits !== undefined ? `${Math.round(r.credits).toLocaleString("en-US")} AI credits (${usd(r.credits / 100)} at $0.01)` : "", r.premium !== undefined ? `${Math.round(r.premium).toLocaleString("en-US")} premium requests` : ""].filter(Boolean).join(" and ")}, beside its tokens at list price.`);
    for (const e of r.endsEarly)
        notes.push(`${e.developer}'s export ends ${e.to}: the days after count nothing for them; a newer export fixes it.`);
    if (r.overlaps)
        notes.push(`${r.overlaps} ${r.overlaps === 1 ? "day" : "days"} in more than one file of the same developer: counted once, from the newer file.`);
    for (const s of r.skipped)
        notes.push(`Skipped ${s.file}: ${s.reason}.`);
    if (notes.length)
        lines.push("", ...notes);
    lines.push("", `Tokens: ${formatTokens(r.tokens.input)} uncached in, ${formatTokens(r.tokens.read)} cache reads, ${formatTokens(r.tokens.write)} cache writes, ${formatTokens(r.tokens.output)} out.`);
    return lines.map((l) => l.trimEnd()).join("\n");
}
