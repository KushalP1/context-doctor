/**
 * `context-doctor overhead prune`: MCP servers and skills a project has not
 * used in N days, switched off for that project only.
 *
 * Every MCP server's tool definitions (or, with tool search, their names)
 * and every skill's name and description ride in each request of every
 * session, used or not ("33k tokens before reading the prompt"). The
 * transcripts say what each project actually calls: MCP tools are
 * `mcp__<server>__<tool>`, skills are the `Skill` tool (`{skill}`) or a
 * typed `/<name>`. The plan lists, per project with enough sessions, the
 * configured servers and installed skills with no use in the period; with
 * `--write` they are switched off for the current folder's project, in its
 * own `.claude/settings.local.json` (a backup kept, each entry recorded so
 * `--undo` takes exactly those out again):
 *
 *  - a server from the project's `.mcp.json`: `disabledMcpjsonServers`;
 *  - a server from ~/.claude.json (user or local scope): `deniedMcpServers`
 *    `{serverName}` (settings-reference: entries from every settings file
 *    merge; it shows as blocked in /mcp until the entry is removed);
 *  - a personal or project skill: `skillOverrides` `"off"` (Claude Code
 *    2.1.129+; older versions ignore the key).
 *
 * Never touched: anything the app provides (claude.ai connectors, the
 * desktop app's own servers, plugin servers and skills), which no config
 * file here lists, and context-doctor's own server, whose standing rules
 * work without a single call. Verified against the settings reference and
 * the 2.1.308 binary (disabledMcpjsonServers, deniedMcpServers merged from
 * every settings file, skillOverrides).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { statePath } from "./ledger.js";
import { forEachLine, listSessions } from "./session.js";
import { subagentDir } from "./subagents.js";
import { claudeMcpConfigs, countMcpRow, serverUses } from "./mcpschema.js";
import { estimateTokens, formatTokens } from "./tokens.js";
import { formatUsd } from "./pricing.js";
const DAY = 86_400_000;
/** A folder as one spelling: /var and /private/var (macOS) or a symlinked checkout are the same project. */
export function canonical(p) {
    try {
        return realpathSync(p);
    }
    catch {
        return resolve(p);
    }
}
/** Fewer sessions than this in the period say too little about what a project uses. */
export const MIN_SESSIONS = 3;
/** What each project (by the `cwd` its sessions record) used in the last `days`, subagents included. */
export function projectUsage(days = 30, paths, now = Date.now()) {
    const since = now - days * DAY;
    const files = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
    const out = new Map();
    for (const path of files) {
        let cwd;
        const names = new Map();
        const resources = new Map();
        const skills = new Map();
        let active = false;
        const scan = (file) => forEachLine(file, (line) => {
            if (!cwd && line.includes('"cwd"')) {
                try {
                    const e = JSON.parse(line);
                    if (typeof e?.cwd === "string")
                        cwd = e.cwd;
                }
                catch { /* not a row */ }
            }
            const tool = line.includes('"tool_use"') && (line.includes('"name":"mcp__') || line.includes('"name":"Skill"') || line.includes("McpResource"));
            const slash = line.includes("<command-name>/");
            if (!tool && !slash) {
                if (!active && line.includes('"timestamp"')) {
                    try {
                        if (Date.parse(JSON.parse(line)?.timestamp) >= since)
                            active = true;
                    }
                    catch { /* skip */ }
                }
                return;
            }
            let e;
            try {
                e = JSON.parse(line);
            }
            catch {
                return;
            }
            if (Date.parse(e?.timestamp) < since)
                return;
            active = true;
            // Tools, prompts run as /mcp__server__prompt, and resource reads by server.
            countMcpRow(e, names, resources);
            const content = e?.message?.content;
            if (slash) {
                const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => b?.text ?? "").join("\n") : "";
                for (const m of text.matchAll(/<command-name>\/([\w:.-]+)<\/command-name>/g))
                    if (!m[1].startsWith("mcp__"))
                        bump(skills, m[1]);
            }
            if (!Array.isArray(content))
                return;
            for (const b of content) {
                if (b?.type === "tool_use" && b.name === "Skill" && typeof b.input?.skill === "string")
                    bump(skills, b.input.skill);
            }
        });
        try {
            scan(path);
            let agents = [];
            try {
                agents = readdirSync(subagentDir(path)).filter((f) => f.endsWith(".jsonl"));
            }
            catch { /* none */ }
            for (const a of agents)
                scan(join(subagentDir(path), a));
        }
        catch {
            continue;
        }
        if (!cwd || !active)
            continue;
        const key = canonical(cwd);
        const p = out.get(key) ?? { cwd: key, sessions: 0, mcpNames: new Map(), mcpResources: new Map(), skillUses: new Map() };
        p.sessions++;
        for (const [k, n] of names)
            p.mcpNames.set(k, (p.mcpNames.get(k) ?? 0) + n);
        for (const [k, n] of resources)
            p.mcpResources.set(k, (p.mcpResources.get(k) ?? 0) + n);
        for (const [k, n] of skills)
            p.skillUses.set(k, (p.skillUses.get(k) ?? 0) + n);
        out.set(key, p);
    }
    return out;
}
function bump(m, name) {
    // "plugin:skill" counts for both spellings: the plugin's own and the bare name.
    m.set(name, (m.get(name) ?? 0) + 1);
    const bare = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : undefined;
    if (bare)
        m.set(bare, (m.get(bare) ?? 0) + 1);
}
/** Skills Claude Code lists in `cwd`: ~/.claude/skills and <cwd>/.claude/skills (not plugins'). */
export function installedSkills(cwd, home = homedir()) {
    const out = [];
    const dirs = [[join(home, ".claude", "skills"), "personal"], [join(cwd, ".claude", "skills"), "project"]];
    for (const [dir, scope] of dirs) {
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const folder of names) {
            let md;
            try {
                md = readFileSync(join(dir, folder, "SKILL.md"), "utf8");
            }
            catch {
                continue;
            }
            const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? "";
            const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim().replace(/^["']|["']$/g, "") || folder;
            const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? "";
            if (out.some((s) => s.name === name))
                continue;
            out.push({ name, scope, tokens: estimateTokens(`${name}: ${description}`, "claude") });
        }
    }
    return out;
}
/** The project's own settings file, where prune writes. */
export function localSettingsPath(cwd) {
    return join(cwd, ".claude", "settings.local.json");
}
function readObject(path) {
    if (!existsSync(path))
        return {};
    const v = JSON.parse(readFileSync(path, "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v))
        throw new Error(`${path} is not a JSON object`);
    return v;
}
const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []);
/**
 * What this project already has off, from every file Claude Code reads for
 * it: the user's and the project's settings (shared and local), and the
 * `/mcp` toggles in ~/.claude.json. A project `.mcp.json` server is off too
 * when an `enabledMcpjsonServers` list exists and leaves it out (and
 * `enableAllProjectMcpServers` is not on): Claude Code does not start it.
 */
function offFor(cwd, home) {
    const off = new Set();
    let allow;
    let all = false;
    const read = (path) => {
        try {
            return readObject(path);
        }
        catch {
            return {};
        }
    };
    for (const settings of [read(join(home, ".claude", "settings.json")), read(join(cwd, ".claude", "settings.json")), read(localSettingsPath(cwd))]) {
        for (const n of list(settings.disabledMcpjsonServers))
            if (typeof n === "string")
                off.add(`mcp:${n}`);
        for (const d of list(settings.deniedMcpServers))
            if (typeof d?.serverName === "string")
                off.add(`mcp:${d.serverName}`);
        for (const [k, v] of Object.entries(settings.skillOverrides && typeof settings.skillOverrides === "object" ? settings.skillOverrides : {}))
            if (v === "off")
                off.add(`skill:${k}`);
        if (Array.isArray(settings.enabledMcpjsonServers) || typeof settings.enabledMcpjsonServers === "string") {
            allow ??= new Set();
            for (const n of list(settings.enabledMcpjsonServers))
                if (typeof n === "string")
                    allow.add(n);
        }
        if (settings.enableAllProjectMcpServers === true)
            all = true;
    }
    const project = read(join(home, ".claude.json")).projects;
    for (const key of new Set([cwd, resolve(cwd)])) {
        const entry = project && typeof project === "object" ? project[key] : undefined;
        for (const n of list(entry?.disabledMcpServers))
            if (typeof n === "string")
                off.add(`mcp:${n}`);
        for (const n of list(entry?.disabledMcpjsonServers))
            if (typeof n === "string")
                off.add(`mcp:${n}`);
        if (Array.isArray(entry?.enabledMcpjsonServers)) {
            allow ??= new Set();
            for (const n of entry.enabledMcpjsonServers)
                if (typeof n === "string")
                    allow.add(n);
        }
        if (entry?.enableAllProjectMcpServers === true)
            all = true;
    }
    return { off, mcpjsonAllowlist: all ? undefined : allow };
}
/** context-doctor's own server: its standing rules work with no calls at all. */
const OURS = /^context-doctor$/;
export function planPrune(days = 30, opts = {}) {
    const home = opts.home ?? homedir();
    const usage = opts.usage ?? projectUsage(days);
    const cwds = opts.cwds ?? [...usage.keys()];
    const plans = [];
    for (const cwd of cwds) {
        const use = usage.get(canonical(cwd)) ?? { cwd: canonical(cwd), sessions: 0, mcpNames: new Map(), mcpResources: new Map(), skillUses: new Map() };
        const { off, mcpjsonAllowlist } = offFor(cwd, home);
        const plan = { cwd: use.cwd, sessions: use.sessions, unused: [], used: [], thin: use.sessions < (opts.minSessions ?? MIN_SESSIONS), alreadyOff: [] };
        const configs = claudeMcpConfigs(cwd, home);
        const usesBy = serverUses(configs.map((c) => c.name), { names: use.mcpNames, resources: use.mcpResources });
        for (const s of configs) {
            if (OURS.test(s.name))
                continue;
            const uses = usesBy.get(s.name) ?? 0;
            const notEnabled = s.scope === ".mcp.json" && mcpjsonAllowlist !== undefined && !mcpjsonAllowlist.has(s.name);
            if (off.has(`mcp:${s.name}`) || notEnabled) {
                plan.alreadyOff.push(s.name);
                continue;
            }
            if (uses > 0)
                plan.used.push({ kind: "mcp", name: s.name, uses });
            else
                plan.unused.push({ kind: "mcp", name: s.name, scope: s.scope, entry: s.scope === ".mcp.json" ? "disabledMcpjsonServers" : "deniedMcpServers" });
        }
        for (const k of installedSkills(cwd, home)) {
            if (OURS.test(k.name))
                continue;
            const uses = use.skillUses.get(k.name) ?? 0;
            if (off.has(`skill:${k.name}`)) {
                plan.alreadyOff.push(k.name);
                continue;
            }
            if (uses > 0)
                plan.used.push({ kind: "skill", name: k.name, uses });
            else
                plan.unused.push({ kind: "skill", name: k.name, scope: k.scope, entry: "skillOverrides", tokens: k.tokens });
        }
        plans.push(plan);
    }
    plans.sort((a, b) => b.sessions - a.sessions);
    return { days, plans };
}
/** Where `--write` records what it added, for `--undo`. */
export function pruneRecordPath() {
    return join(dirname(statePath()), ".context-doctor-pruned.json");
}
function readRecord() {
    try {
        const v = JSON.parse(readFileSync(pruneRecordPath(), "utf8"));
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    }
    catch {
        return {};
    }
}
/**
 * Switch the plan's unused servers and skills off in the project's
 * `.claude/settings.local.json`. The file's original is kept once as
 * `.context-doctor.backup`; every entry added is recorded for `--undo`.
 */
export function applyPrune(plan) {
    const file = localSettingsPath(plan.cwd);
    const settings = readObject(file);
    const added = { disabledMcpjsonServers: [], deniedMcpServers: [], skillOverrides: [] };
    for (const item of plan.unused) {
        if (item.entry === "disabledMcpjsonServers") {
            // Always an array: a single name as a string made Claude Code ignore the file before 2.1.299.
            const cur = list(settings.disabledMcpjsonServers).filter((x) => typeof x === "string");
            if (!cur.includes(item.name)) {
                settings.disabledMcpjsonServers = [...cur, item.name];
                added.disabledMcpjsonServers.push(item.name);
            }
        }
        else if (item.entry === "deniedMcpServers") {
            const cur = list(settings.deniedMcpServers);
            if (!cur.some((d) => d?.serverName === item.name)) {
                settings.deniedMcpServers = [...cur, { serverName: item.name }];
                added.deniedMcpServers.push(item.name);
            }
        }
        else {
            const cur = settings.skillOverrides && typeof settings.skillOverrides === "object" && !Array.isArray(settings.skillOverrides) ? settings.skillOverrides : {};
            // A choice the user already made for this skill ("on", "name-only") stands.
            if (cur[item.name] === undefined) {
                settings.skillOverrides = { ...cur, [item.name]: "off" };
                added.skillOverrides.push(item.name);
            }
        }
    }
    const any = added.disabledMcpjsonServers.length + added.deniedMcpServers.length + added.skillOverrides.length > 0;
    if (!any)
        return { file, added };
    mkdirSync(dirname(file), { recursive: true });
    let backup;
    if (existsSync(file) && !existsSync(file + ".context-doctor.backup")) {
        copyFileSync(file, file + ".context-doctor.backup");
        backup = file + ".context-doctor.backup";
    }
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    const record = readRecord();
    const prev = record[plan.cwd]?.added ?? { disabledMcpjsonServers: [], deniedMcpServers: [], skillOverrides: [] };
    record[plan.cwd] = {
        file,
        at: Date.now(),
        added: {
            disabledMcpjsonServers: [...new Set([...prev.disabledMcpjsonServers, ...added.disabledMcpjsonServers])],
            deniedMcpServers: [...new Set([...prev.deniedMcpServers, ...added.deniedMcpServers])],
            skillOverrides: [...new Set([...prev.skillOverrides, ...added.skillOverrides])],
        },
    };
    mkdirSync(dirname(pruneRecordPath()), { recursive: true });
    writeFileSync(pruneRecordPath(), JSON.stringify(record, null, 2));
    return { file, backup, added };
}
/** Take out exactly what `--write` added for this project (entries changed since by hand stay). */
export function undoPrune(cwd) {
    const key = canonical(cwd);
    const record = readRecord();
    const r = record[key];
    if (!r)
        return undefined;
    const file = localSettingsPath(key);
    const removed = [];
    if (existsSync(file)) {
        const settings = readObject(file);
        const keepNames = (v, drop) => list(v).filter((x) => !(typeof x === "string" && drop.includes(x) && removed.push(x)));
        if (r.added.disabledMcpjsonServers.length) {
            settings.disabledMcpjsonServers = keepNames(settings.disabledMcpjsonServers, r.added.disabledMcpjsonServers);
            if (!settings.disabledMcpjsonServers.length)
                delete settings.disabledMcpjsonServers;
        }
        if (r.added.deniedMcpServers.length) {
            settings.deniedMcpServers = list(settings.deniedMcpServers).filter((d) => !(r.added.deniedMcpServers.includes(d?.serverName) && removed.push(d.serverName)));
            if (!settings.deniedMcpServers.length)
                delete settings.deniedMcpServers;
        }
        if (r.added.skillOverrides.length && settings.skillOverrides && typeof settings.skillOverrides === "object") {
            for (const n of r.added.skillOverrides)
                if (settings.skillOverrides[n] === "off") {
                    delete settings.skillOverrides[n];
                    removed.push(n);
                }
            if (!Object.keys(settings.skillOverrides).length)
                delete settings.skillOverrides;
        }
        writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    }
    delete record[key];
    writeFileSync(pruneRecordPath(), JSON.stringify(record, null, 2));
    return { file, removed };
}
const tilde = (p, home = homedir()) => (p.startsWith(home) ? "~" + p.slice(home.length) : p);
export function renderPrune(r, current, opts = {}) {
    const out = ["UNUSED MCP SERVERS AND SKILLS, BY PROJECT", "═".repeat(60), `Last ${r.days} days of Claude Code sessions (subagents included).`];
    const here = r.plans.find((p) => p.cwd === canonical(current));
    const shown = r.plans.filter((p) => p.unused.length || p.used.length || p.alreadyOff.length || p === here);
    if (!shown.length) {
        out.push("", "No project here has MCP servers or skills of its own configured (context-doctor's own, the app's connectors and plugins are left out).");
        return out.join("\n");
    }
    for (const p of shown.slice(0, 15)) {
        out.push("", `${tilde(p.cwd, opts.home)}${p.cwd === canonical(current) ? "  (this folder)" : ""}: ${p.sessions} session${p.sessions === 1 ? "" : "s"}`);
        if (p.thin)
            out.push(`  Too few sessions to judge (under ${MIN_SESSIONS}); nothing proposed.`);
        for (const u of p.used)
            out.push(`  used    ${u.kind === "mcp" ? "server" : "skill "} ${u.name} (${u.uses})`);
        for (const n of p.alreadyOff)
            out.push(`  off     ${n} (already off here)`);
        if (!p.thin) {
            for (const u of p.unused) {
                const cost = u.tokens !== undefined ? ` ~${formatTokens(u.tokens)} tokens a request${opts.usdPerKPerMonth ? `, ~${formatUsd((u.tokens / 1000) * opts.usdPerKPerMonth)}/month` : ""}` : "";
                out.push(`  unused  ${u.kind === "mcp" ? "server" : "skill "} ${u.name} (${u.scope}): ${u.entry}${cost}`);
            }
        }
    }
    const mine = here && !here.thin ? here.unused.length : 0;
    out.push("", mine
        ? `Switch off the ${mine} unused here, for this project only: context-doctor overhead prune --write`
        : "Nothing to switch off in this folder's project.", "It writes .claude/settings.local.json (a backup kept, every entry recorded);", "--undo takes exactly those entries out again. For another project, run it there.", "A server's size: context-doctor overhead --mcp. Never touched: the app's connectors,", "plugin servers and skills, and context-doctor's own server.");
    return out.join("\n");
}
