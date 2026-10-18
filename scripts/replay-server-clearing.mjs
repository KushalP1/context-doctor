// Would Anthropic's server-side context editing (clear_tool_uses_20250919)
// have paid on YOUR recent Claude Code sessions? Replays each session as it
// was sent, as autopilot would have sent it, and as the API's clearing rule
// would have edited it (simulated below), all priced the way the prompt
// cache bills (savings.ts). Read-only: it only reads ~/.claude/projects.
//   node scripts/replay-server-clearing.mjs [days]      (after npm run build)
//
// The rule, from the context-editing docs (checked 2026-10-18): once a
// request's input exceeds `trigger`, the API replaces the results of all but
// the last `keep` tool uses with a placeholder, if that clears at least
// `clear_at_least`. It is applied on every request from the full history the
// client sends, so the cleared set only grows, and each newly cleared result
// changes the prompt from that point on ("invalidates cached prompt
// prefixes when content is cleared"). Only re-runnable tools are cleared, as
// autopilot does (the rest would go in exclude_tools).
import { replaySession } from "../dist/savings.js";
import { listSessions } from "../dist/session.js";
import { CLEARABLE_TOOLS } from "../dist/autoclear.js";
import { estimateTokens } from "../dist/tokens.js";

const PLACEHOLDER = "[cleared by context management]";
const FIXED = 54_000; // system prompt and tools, as savings.ts assumes

class ServerClearSim {
  constructor(cfg, model) { this.cfg = cfg; this.model = model; this.size = new WeakMap(); this.original = new Map(); this.cleared = new Set(); this.removed = 0; }
  tokens(m) { let t = this.size.get(m); if (t === undefined) { t = estimateTokens(JSON.stringify(m), this.model); this.size.set(m, t); } return t; }
  apply(body) {
    const msgs = body.messages ?? [];
    const names = new Map(), uses = [];
    let total = FIXED;
    for (const m of msgs) {
      total += this.tokens(m);
      for (const b of m.content ?? []) if (b?.type === "tool_use" && typeof b.id === "string") { names.set(b.id, String(b.name ?? "")); uses.push(b.id); }
    }
    if (total + this.removed < this.cfg.trigger) return { firstChanged: -1 };
    const keep = new Set(uses.slice(-this.cfg.keep));
    const candidates = [];
    msgs.forEach((m, i) => {
      for (const b of m.content ?? []) {
        if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string" || keep.has(b.tool_use_id)) continue;
        if (!CLEARABLE_TOOLS.has(names.get(b.tool_use_id) ?? "")) continue;
        if (!this.original.has(b.tool_use_id)) this.original.set(b.tool_use_id, estimateTokens(JSON.stringify(b.content ?? ""), this.model));
        candidates.push({ i, m, b, id: b.tool_use_id });
      }
    });
    const clearable = candidates.reduce((n, c) => n + this.original.get(c.id), 0);
    if (clearable < this.cfg.atLeast) return { firstChanged: -1 };
    let first = -1;
    for (const c of candidates) {
      if (this.cleared.has(c.id)) continue;
      this.cleared.add(c.id);
      this.removed += Math.max(0, this.original.get(c.id) - 8);
      c.b.content = PLACEHOLDER;
      this.size.delete(c.m);
      if (first === -1 || c.i < first) first = c.i;
    }
    return { firstChanged: first };
  }
}

const days = Number(process.argv[2] ?? 30), since = Date.now() - days * 86_400_000;
const paths = listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
const arms = {
  "autopilot (shipped)": null,
  "server: API defaults (100k, keep 3)": { trigger: 100_000, keep: 3, atLeast: 0 },
  "server: 100k, keep 3, at least 20k": { trigger: 100_000, keep: 3, atLeast: 20_000 },
  "server: 200k, keep 5, at least 50k": { trigger: 200_000, keep: 5, atLeast: 50_000 },
};
console.log(`Last ${days} days, ${paths.length} Claude Code transcripts; sessions with 10+ requests replayed.`);
for (const [name, cfg] of Object.entries(arms)) {
  const runRows = new Set(), coldRows = new Set();
  let billed = 0, saved = 0, worse = 0, n = 0, worst = 0, worstPct = 0;
  for (const p of paths) {
    let s;
    try { s = cfg ? replaySession(p, {}, since, runRows, coldRows, (model) => new ServerClearSim(cfg, model)) : replaySession(p, {}, since, runRows, coldRows); } catch { continue; }
    if (!s) continue;
    n++; billed += s.billedUsd; saved += s.savedUsd;
    if (s.savedUsd < -0.005) { worse++; if (s.savedUsd < worst) { worst = s.savedUsd; worstPct = s.savedPct; } }
  }
  console.log(`${name.padEnd(38)} ${n} sessions  billed $${billed.toFixed(0)}  saved $${saved.toFixed(0)} (${((saved / billed) * 100).toFixed(1)}%)  more expensive: ${worse}${worse ? ` (worst $${(-worst).toFixed(2)}, ${(-worstPct * 100).toFixed(0)}% more)` : ""}`);
}
