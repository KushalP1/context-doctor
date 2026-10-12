/**
 * `context-doctor tasks`: what a unit of finished work costs, per project.
 *
 * Tokens and dollars per session say little on their own; a session that
 * shipped five commits and one that shipped none can cost the same. This
 * prices each recent Claude Code session from the usage its transcript
 * records (input, cache writes by TTL, cache reads, output; each request at
 * its own model's price), counts the commits the session itself made
 * (successful `git commit` calls in its shell tool, in whichever
 * repository), and reports per project: sessions, cost, commits, cost per
 * commit, and how much went to sessions that committed nothing. Only
 * requests and commits inside the period count, and a forked session's
 * copy of its parent's history counts once.
 *
 * Counting from the transcript attributes each commit to exactly one session
 * and finds commits in nested repositories; a time window over `git log`
 * did neither (a parent folder's repo showed none, a busy repo's unrelated
 * history showed hundreds). Commits made by hand are not counted, nor is
 * subagent traffic.
 */
import { realModel } from "./tokens.js";
import { basename } from "node:path";
import { forEachLine, listSessions, outputSettler, replyCounter } from "./session.js";
import { formatUsd, pricingFor, usageCost } from "./pricing.js";
/**
 * One session's bill, priced as the prompt cache bills it, from the usage the
 * transcript records. `since` counts only requests and commits from then on,
 * each by its own timestamp: a month-old session touched today is not a
 * month of today's spend (`tasks --days 1` reported $760 where $244 fell in
 * the day). Rows without a timestamp count with their file.
 */
export function sessionCost(path, since = 0, counted = { rows: new Set(), commits: new Set() }) {
    let cwd, model;
    let start = Infinity, end = 0, usd = 0, requests = 0, commits = 0;
    const commitCalls = new Map();
    const sighting = replyCounter(counted.rows);
    const settle = outputSettler();
    const inWindow = (e) => { const at = Date.parse(e.timestamp); return !Number.isFinite(at) || at >= since; };
    forEachLine(path, (line) => {
        if (!line.includes('"usage"') && !line.includes('"tool_result"') && cwd !== undefined)
            return;
        let e;
        try {
            e = JSON.parse(line);
        }
        catch {
            return;
        }
        if (!e || e.isSidechain)
            return;
        if (!cwd && typeof e.cwd === "string")
            cwd = e.cwd;
        const content = Array.isArray(e.message?.content) ? e.message.content : [];
        if (e.type === "assistant") {
            for (const b of content) {
                const cmd = b?.type === "tool_use" && (b.name === "Bash" || b.name === "shell") ? String(b.input?.command ?? "") : "";
                const n = commitCount(cmd);
                if (n)
                    commitCalls.set(b.id, n);
            }
        }
        else if (e.type === "user") {
            for (const b of content) {
                if (b?.type !== "tool_result" || !commitCalls.has(b.tool_use_id))
                    continue;
                // A forked session copies its parent's commit calls too: count each once.
                if (!b.is_error && inWindow(e) && !counted.commits.has(b.tool_use_id)) {
                    commits += commitCalls.get(b.tool_use_id);
                    counted.commits.add(b.tool_use_id);
                }
                commitCalls.delete(b.tool_use_id);
            }
            return;
        }
        if (e.type !== "assistant" || !e.message?.usage)
            return;
        // "<synthetic>" rows are Claude Code's own placeholders, not requests.
        if (typeof e.message.model === "string" && !realModel(e.message.model))
            return;
        const seen = sighting(e);
        if (seen === "repeat") {
            // A later row of a counted reply: only its final output count is new.
            const more = settle(e, false);
            const price = more ? pricingFor(realModel(e.message.model) ?? model) : undefined;
            if (price)
                usd += (more * price.outputPerM) / 1e6;
            return;
        }
        if (seen !== "new" || !inWindow(e))
            return;
        const at = Date.parse(e.timestamp);
        if (Number.isFinite(at)) {
            start = Math.min(start, at);
            end = Math.max(end, at);
        }
        model = realModel(e.message.model) ?? model;
        // Each request at its own model's price: one session can switch models.
        const price = pricingFor(model);
        if (!price)
            return;
        usd += usageCost(e.message.usage, price).totalUsd;
        settle(e, true);
        requests++;
    });
    if (!requests || !Number.isFinite(start))
        return undefined;
    return { path, cwd, model, start, end, usd, requests, commits };
}
/** `git commit` invocations in a shell command (not --amend, --dry-run or commit-tree). */
export function commitCount(cmd) {
    let n = 0;
    for (const part of cmd.split(/&&|\|\||;|\n/)) {
        if (/^\s*git(\s+-[cC]\s+\S+)*\s+commit(\s|$)/.test(part) && !/--amend|--dry-run/.test(part))
            n++;
    }
    return n;
}
export function costPerTask(days = 30, paths) {
    const since = Date.now() - days * 86_400_000;
    const list = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
    const byProject = new Map();
    const counted = { rows: new Set(), commits: new Set() };
    for (const p of list) {
        const s = sessionCost(p, since, counted);
        if (!s)
            continue;
        const project = s.cwd ?? "?";
        const agg = byProject.get(project) ?? { sessions: 0, usd: 0, commits: 0, idle: 0, idleUsd: 0 };
        agg.sessions++;
        agg.usd += s.usd;
        agg.commits += s.commits;
        if (s.commits === 0) {
            agg.idle++;
            agg.idleUsd += s.usd;
        }
        byProject.set(project, agg);
    }
    const projects = [...byProject.entries()]
        .map(([project, a]) => ({
        project,
        sessions: a.sessions,
        usd: a.usd,
        commits: a.commits,
        idleSessions: a.idle,
        idleUsd: a.idleUsd,
        usdPerCommit: a.commits ? a.usd / a.commits : undefined,
    }))
        .sort((a, b) => b.usd - a.usd);
    return { days, projects, usd: projects.reduce((s, p) => s + p.usd, 0), commits: projects.reduce((s, p) => s + p.commits, 0) };
}
export function renderTasks(r, limit = 12) {
    const out = ["COST PER TASK (the sessions' own commits as the unit of finished work)", "═".repeat(56)];
    if (r.projects.length === 0)
        return [...out, `No Claude Code sessions in the last ${r.days} days.`].join("\n");
    out.push(`Last ${r.days} days at API list prices: ${formatUsd(r.usd)} across ${r.projects.reduce((s, p) => s + p.sessions, 0)} sessions, ${r.commits} commits.`, "");
    out.push("  project                      sessions     cost  commits  per commit   no-commit sessions");
    for (const p of r.projects.slice(0, limit)) {
        const name = (p.project === "?" ? "?" : basename(p.project)).slice(0, 26).padEnd(26);
        const per = p.usdPerCommit !== undefined ? formatUsd(p.usdPerCommit) : "—";
        const idle = `${p.idleSessions} (${formatUsd(p.idleUsd)})`;
        out.push(`  ${name} ${String(p.sessions).padStart(8)} ${formatUsd(p.usd).padStart(8)} ${String(p.commits).padStart(8)} ${per.padStart(11)}   ${idle}`);
    }
    if (r.projects.length > limit)
        out.push(`  … ${r.projects.length - limit} more (--json for all)`);
    out.push("", "Commits are the sessions' own successful `git commit` calls, in any repository; commits made by hand are not counted.", "Sessions with no commit are not waste by definition (research, reviews, deploys); a large share there is worth a look.");
    return out.join("\n");
}
