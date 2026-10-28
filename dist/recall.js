/**
 * Recall: search this session's own transcript on disk.
 *
 * What leaves the context does not leave the disk. Claude Code writes every
 * turn to its transcript, the ones a compaction summarised away and the
 * tool output autopilot cleared in flight included (the transcript keeps the
 * original), and Codex writes its rollout the same way. So when the model
 * needs a detail from before a compaction (an error message, a path, a
 * decision), it can get the few lines that matter back instead of asking the
 * user or re-running a command.
 *
 * Ranking is pack's (BM25 over structural chunks); each excerpt comes back
 * with its time, its position in the session and whether it is still in the
 * context or was compacted away. Secret-looking strings are masked with the
 * handoff masker before anything is ranked or returned. Only the session
 * itself is read: by default the one named by CLAUDE_CODE_SESSION_ID, else the
 * newest transcript of the current folder's project (or Codex rollout started
 * in this folder), never another project's; any other session only when it
 * is named.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { claudeProjectDir, forEachLine } from "./session.js";
import { packContext } from "./pack.js";
import { maskSecrets, stripControls } from "./handoff.js";
import { formatTokens } from "./tokens.js";
import { claudeDir } from "./claudedir.js";
/** A tool output longer than this keeps its head and tail: the middle of a 5 MB log rarely answers a question. */
const ENTRY_MAX_CHARS = 200_000;
/** Beyond this much text the oldest entries are left out (and said to be): ~3M tokens, three full 1M windows. */
const TOTAL_MAX_CHARS = 8_000_000;
/** Past each cut, this much more is masked first, so a secret across the cut still matches whole. */
const MASK_MARGIN = 16_384;
function textOf(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : b?.type === "image" || b?.type === "input_image" ? "[image]" : ""))
        .filter(Boolean)
        .join("\n");
}
function clipRaw(text) {
    if (text.length <= ENTRY_MAX_CHARS)
        return { whole: text };
    const half = ENTRY_MAX_CHARS / 2;
    return { head: text.slice(0, half + MASK_MARGIN), tail: text.slice(-(half + MASK_MARGIN)), length: text.length };
}
const rawLength = (r) => ("whole" in r ? r.whole.length : ENTRY_MAX_CHARS);
/**
 * Mask, then clip: a secret cut by the clip would no longer match its
 * pattern (half a private key leaked that way). Head and tail are masked
 * with a margin past each cut before they are cut to size; a private key
 * that runs past the head's margin is masked to its end by its own pattern,
 * and a tail that starts inside a key (an END line with no BEGIN before it)
 * is masked up to that line. Masking waits until the entries to keep are
 * known: a 300 MB transcript masks only what it returns.
 */
function maskRaw(r) {
    if ("whole" in r) {
        const m = maskSecrets(stripControls(r.whole));
        return { text: m.text, masked: m.count };
    }
    const half = ENTRY_MAX_CHARS / 2;
    const head = maskSecrets(stripControls(r.head));
    let tailText = stripControls(r.tail);
    let extra = 0;
    const end = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.exec(tailText);
    if (end && !/-----BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(tailText.slice(0, end.index))) {
        tailText = `[private key masked by context-doctor]${tailText.slice(end.index + end[0].length)}`;
        extra = 1;
    }
    const tail = maskSecrets(tailText);
    return { text: `${head.text.slice(0, half)}\n[… ${r.length - ENTRY_MAX_CHARS} characters …]\n${tail.text.slice(-half)}`, masked: head.count + tail.count + extra };
}
/** A tool call in one line: its name and the input that says what it did (command, path, pattern). */
function callLine(name, input) {
    const i = (input ?? {});
    const key = ["command", "file_path", "path", "pattern", "url", "query", "cmd", "description", "prompt"].find((k) => typeof i[k] === "string");
    const detail = key ? String(i[key]) : typeof input === "string" ? input : JSON.stringify(input ?? "");
    return `${name}: ${detail.slice(0, 2000)}`;
}
/**
 * Claude Code transcript rows, or Codex rollout lines, as entries in order:
 * streamed, holding only the newest `maxChars` of text (a 300 MB transcript
 * is never in memory at once). A subagent's transcript (all its rows are
 * sidechain rows) is read as itself; in a main transcript sidechain rows
 * are skipped.
 */
export function transcriptEntries(path, maxChars = TOTAL_MAX_CHARS) {
    const entries = [];
    let start = 0, chars = 0, total = 0, compactions = 0;
    let sidechainFile = /[\\/]subagents[\\/]agent-[^\\/]*\.jsonl$/.test(path) || undefined;
    const toolNames = new Map();
    const push = (at, kind, raw) => {
        const trimmed = raw.trim();
        if (!trimmed)
            return;
        total++;
        const clipped = clipRaw(trimmed);
        entries.push({ n: total, at: typeof at === "string" ? at : undefined, kind, raw: clipped, compactedBy: 0, c: compactions });
        chars += rawLength(clipped);
        // Older entries past the budget are let go at once (their text could be
        // hundreds of megabytes in all), and the array itself trimmed now and then.
        while (chars > maxChars && start < entries.length - 1) {
            chars -= rawLength(entries[start].raw);
            entries[start].raw = { whole: "" };
            start++;
        }
        if (start > 1024) {
            entries.splice(0, start);
            start = 0;
        }
        if (toolNames.size > 100_000)
            toolNames.clear();
    };
    forEachLine(path, (line) => {
        let e;
        try {
            e = JSON.parse(line);
        }
        catch {
            return;
        }
        if (!e || typeof e !== "object")
            return;
        // Codex rollouts: {timestamp, type, payload}.
        if (e.payload && typeof e.payload === "object" && typeof e.type === "string" && !e.message) {
            const p = e.payload;
            if (e.type === "compacted" || p.type === "context_compacted") {
                compactions++;
                return;
            }
            if (e.type !== "response_item")
                return;
            if (p.type === "message" && (p.role === "user" || p.role === "assistant"))
                return push(e.timestamp, p.role, textOf(p.content));
            if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
                const name = String(p.name ?? (p.type === "local_shell_call" ? "shell" : p.type));
                if (typeof p.call_id === "string")
                    toolNames.set(p.call_id, name);
                let input = p.arguments ?? p.input ?? p.action;
                if (typeof input === "string") {
                    try {
                        input = JSON.parse(input);
                    }
                    catch { /* keep the string */ }
                }
                return push(e.timestamp, "tool call", callLine(name, input));
            }
            if (/_call_output$/.test(String(p.type)))
                return push(e.timestamp, `tool output (${toolNames.get(p.call_id) ?? "tool"})`, textOf(p.output));
            return;
        }
        // Claude Code transcripts.
        if (e.type === "system" && e.subtype === "compact_boundary") {
            compactions++;
            return;
        }
        if (e.isCompactSummary)
            return; // the summary is what the context holds now
        const m = e.message;
        if (!m)
            return;
        // The first message row says whose file this is: a subagent's rows are all sidechain.
        if (sidechainFile === undefined)
            sidechainFile = e.isSidechain === true;
        if (e.isSidechain && !sidechainFile)
            return;
        const content = m.content;
        if (e.type === "user") {
            if (typeof content === "string")
                return push(e.timestamp, "user", content);
            if (!Array.isArray(content))
                return;
            for (const b of content) {
                if (b?.type === "tool_result")
                    push(e.timestamp, `tool output (${toolNames.get(b.tool_use_id) ?? "tool"})`, textOf(b.content));
                else if (typeof b?.text === "string")
                    push(e.timestamp, "user", b.text);
            }
            return;
        }
        if (e.type === "assistant" && Array.isArray(content)) {
            for (const b of content) {
                if (b?.type === "text")
                    push(e.timestamp, "assistant", String(b.text ?? ""));
                else if (b?.type === "tool_use") {
                    if (typeof b.id === "string")
                        toolNames.set(b.id, String(b.name ?? "tool"));
                    push(e.timestamp, "tool call", callLine(String(b.name ?? "tool"), b.input));
                }
            }
        }
    });
    let masked = 0;
    const kept = entries.slice(start).map(({ c, raw, ...e }) => {
        const m = maskRaw(raw);
        masked += m.masked;
        return { ...e, text: m.text, compactedBy: compactions - c };
    });
    return { entries: kept, total, compactions, masked };
}
/** The first line of a Codex rollout names the folder it started in. */
function codexCwd(path) {
    try {
        const fd = openSync(path, "r");
        try {
            const buf = Buffer.alloc(64 * 1024);
            const n = readSync(fd, buf, 0, buf.length, 0);
            const first = buf.subarray(0, n).toString("utf8").split("\n")[0];
            const cwd = JSON.parse(first)?.payload?.cwd;
            return typeof cwd === "string" ? cwd : undefined;
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return undefined;
    }
}
/** The newest `.jsonl` directly in a folder, with its time. */
function newestIn(dir) {
    let newest;
    try {
        for (const f of readdirSync(dir)) {
            if (!f.endsWith(".jsonl"))
                continue;
            const p = join(dir, f);
            const at = statSync(p).mtimeMs;
            if (!newest || at > newest.at)
                newest = { path: p, at };
        }
    }
    catch {
        /* no such folder */
    }
    return newest;
}
/** The newest Codex rollout of the last week that started in `cwd`. */
function newestCodexFor(cwd, home) {
    const codexRoot = join(home, ".codex", "sessions");
    if (!existsSync(codexRoot))
        return undefined;
    const since = Date.now() - 7 * 86_400_000;
    const candidates = [];
    const walk = (dir, depth) => {
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of names) {
            const p = join(dir, name);
            let st;
            try {
                st = statSync(p);
            }
            catch {
                continue;
            }
            if (st.isDirectory()) {
                if (depth < 3)
                    walk(p, depth + 1);
            }
            else if (name.endsWith(".jsonl") && st.mtimeMs >= since)
                candidates.push({ path: p, at: st.mtimeMs });
        }
    };
    walk(codexRoot, 0);
    return candidates.sort((a, b) => b.at - a.at).find((c) => codexCwd(c.path) === resolve(cwd));
}
/**
 * This session's transcript, never another project's.
 *  - CLAUDE_CODE_SESSION_ID names it. In a shell Claude Code starts, it is
 *    current. In the MCP server (`envMayBeStale`) it is the session the
 *    server started with: after /clear, Claude Code 2.1.308 keeps the old id
 *    there while writing a new transcript, so a newer transcript in the same
 *    project wins, and the answer says so.
 *  - Otherwise the newest of: this folder's Claude Code transcripts, and the
 *    Codex rollouts of the last week started in this folder (a Codex session
 *    today beats a Claude Code chat from last month).
 */
export function currentTranscript(env = process.env, cwd = process.cwd(), home = homedir(), opts = {}) {
    const id = env.CLAUDE_CODE_SESSION_ID?.trim();
    if (id && /^[\w.-]+$/.test(id)) {
        const found = findSession(id, home);
        if (found && found.endsWith(`${id}.jsonl`)) {
            if (opts.envMayBeStale) {
                const newest = newestIn(dirname(found));
                if (newest && newest.path !== found && newest.at > statSync(found).mtimeMs) {
                    return { path: newest.path, how: `the newest Claude Code session in this project (${basename(newest.path, ".jsonl")}; CLAUDE_CODE_SESSION_ID still names ${id}, as after /clear)` };
                }
            }
            return { path: found, how: `this Claude Code session (${id})` };
        }
    }
    const claude = newestIn(claudeProjectDir(cwd, home));
    const codex = newestCodexFor(cwd, home);
    if (codex && (!claude || codex.at > claude.at))
        return { path: codex.path, how: "the newest Codex session started in this folder" };
    return claude ? { path: claude.path, how: "the newest Claude Code session in this folder" } : undefined;
}
/** A session named by id (Claude Code `<id>.jsonl` in any project, or a Codex rollout whose name holds it) or by path. */
export function findSession(idOrPath, home = homedir()) {
    if ((isAbsolute(idOrPath) || idOrPath.includes("/") || idOrPath.includes("\\")) && existsSync(idOrPath))
        return resolve(idOrPath);
    if (!/^[\w.-]+$/.test(idOrPath))
        return undefined;
    const root = join(claudeDir(home), "projects");
    let dirs = [];
    try {
        dirs = readdirSync(root);
    }
    catch { /* none */ }
    for (const d of dirs) {
        const p = join(root, d, `${idOrPath}.jsonl`);
        if (existsSync(p))
            return p;
    }
    const codexRoot = join(home, ".codex", "sessions");
    let hit;
    const walk = (dir, depth) => {
        if (hit)
            return;
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of names) {
            const p = join(dir, name);
            if (name.endsWith(".jsonl") && name.includes(idOrPath)) {
                hit = p;
                return;
            }
            if (depth < 3 && !name.includes("."))
                walk(p, depth + 1);
        }
    };
    if (existsSync(codexRoot))
        walk(codexRoot, 0);
    return hit;
}
/**
 * The excerpts of a transcript that best answer `query`, within `budget`
 * tokens, best first. Masked before ranking, so a secret is never returned.
 */
export function recall(path, query, opts = {}) {
    const read = transcriptEntries(path);
    const { entries, compactions } = read;
    const byName = new Map();
    const sources = entries.map((e) => {
        const name = `#${e.n}`;
        byName.set(name, e);
        return { name, text: e.text };
    });
    const budget = Math.max(200, opts.budget ?? 2000);
    const r = packContext(sources, { query, budget, maxChunkTokens: 300 });
    const where = (e) => (e.compactedBy === 0 ? "in context" : `before compaction ${compactions - e.compactedBy + 1} of ${compactions}`);
    const hits = [...r.selected]
        .sort((a, b) => b.score - a.score)
        .map((c) => {
        const e = byName.get(c.source);
        return { id: c.id, n: e.n, at: e.at, kind: e.kind, where: where(e), tokens: c.tokens, score: c.score, text: c.text };
    });
    const more = r.chunks.filter((c) => c.score > 0 && !r.selected.includes(c)).length;
    return { path, how: opts.how ?? "the session named", query, entries: read.total, compactions, totalTokens: r.totalTokens, hits, masked: read.masked, more, leftOut: read.total - entries.length };
}
export function renderRecall(r, home = homedir()) {
    const name = basename(r.path).replace(/\.jsonl$/, "").slice(0, 48);
    const out = [`RECALL from ${r.how}${r.how.includes(name) ? "" : ` (${name})`}: ${r.entries} entries, ~${formatTokens(r.totalTokens)} tokens, ${r.compactions} compaction${r.compactions === 1 ? "" : "s"}.`];
    if (!r.hits.length) {
        out.push(`Nothing in it matches "${r.query}". Try the words the output itself would use (a file name, an error, a command).`);
        return out.join("\n");
    }
    out.push(`Best ${r.hits.length} excerpt${r.hits.length === 1 ? "" : "s"} for "${r.query}", best first${r.more ? ` (${r.more} more matched; a narrower query or a larger max_tokens gets them)` : ""}:`);
    if (r.masked)
        out.push(`${r.masked} secret-looking string${r.masked === 1 ? "" : "s"} masked.`);
    if (r.leftOut)
        out.push(`The oldest ${r.leftOut} entries were not searched: the transcript is that large.`);
    for (const h of r.hits) {
        const when = h.at ? h.at.slice(0, 16).replace("T", " ") + " UTC" : "time not recorded";
        out.push("", `── entry ${h.n} of ${r.entries} · ${when} · ${h.kind} · ${h.where} · ~${formatTokens(h.tokens)}`, h.text);
    }
    return out.join("\n").replaceAll(home, "~");
}
