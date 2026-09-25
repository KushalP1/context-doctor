// Replays real Claude Code sessions through the shipped AutoClearer, pricing each
// request as the prompt cache bills it (reads 0.1x, writes 1.25x), with real
// timestamps so an idle gap past the 1h TTL makes the cache cold in both arms.
// Usage: npm run build && node scripts/replay-autopilot.mjs [sessions] [variants-json]
import { listSessions, forEachLine } from "../dist/session.js";
import { estimateTokens } from "../dist/tokens.js";
import { AutoClearer } from "../dist/autoclear.js";
const FIXED = 54000;
const limit = Number(process.argv[2] ?? 60);
const variants = JSON.parse(process.argv[3] ?? '{"default":{}}');
const files = listSessions(limit).map((s) => s.path).filter((p) => p.includes("/.claude/"));
const tokOf = (m, model) => estimateTokens(JSON.stringify(m), model);
function arm(model, clearer) {
  const msgs = [], tok = []; let total = 0, prevLen = 0, w = 0, t = 0, removed = 0;
  return {
    push(m) { msgs.push(structuredClone(m)); const k = tokOf(m, model); tok.push(k); total += k; },
    extend(blocks) { const i = msgs.length - 1; msgs[i].content.push(...structuredClone(blocks)); total -= tok[i]; tok[i] = tokOf(msgs[i], model); total += tok[i]; },
    request(now, ttlMs, lastTs) {
      let first = -1;
      if (clearer) { const r = clearer.apply({ model, messages: msgs, system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }] }, now); first = r.firstChanged; }
      if (first >= 0) for (let i = first; i < msgs.length; i++) { total -= tok[i]; tok[i] = tokOf(msgs[i], model); total += tok[i]; }
      const cold = lastTs === null || now - lastTs > ttlMs;
      let k = cold ? 0 : Math.min(prevLen, first >= 0 ? first : prevLen);
      let read = 0; for (let i = 0; i < k; i++) read += tok[i];
      const write = total - read;
      w += (cold ? 0 : FIXED * 0.1) + (cold ? FIXED * 1.25 : 0) + read * 0.1 + write * 1.25; t += FIXED + total;
      prevLen = msgs.length;
    },
    get w() { return w; }, get t() { return t; },
  };
}
const res = {}; let used = 0;
for (const f of files) {
  let model; const lines = []; let reqs = 0;
  forEachLine(f, (l) => { lines.push(l); if (l.includes('"type":"assistant"')) reqs++; });
  if (reqs < 60) continue;
  used++;
  const arms = { base: arm(undefined, null) };
  for (const [n, o] of Object.entries(variants)) arms[n] = arm(undefined, new AutoClearer(o));
  let lastId, lastTs = null;
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.isSidechain) continue;
    if (e.type === "system" && e.subtype === "compact_boundary") { const m = model; for (const n in arms) arms[n] = Object.assign(arm(m, n === "base" ? null : new AutoClearer(variants[n])), { _w: arms[n].w + (arms[n]._w ?? 0), _t: arms[n].t + (arms[n]._t ?? 0) }); continue; }
    if (e.type === "assistant" && e.message) {
      const m = e.message; model = model ?? m.model;
      const blocks = (Array.isArray(m.content) ? m.content : []).filter((x) => x?.type !== "thinking" && x?.type !== "redacted_thinking");
      if (m.id !== lastId) {
        lastId = m.id;
        const u = m.usage; const tot = u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0;
        const now = Date.parse(e.timestamp);
        if (tot > 0) { for (const n in arms) arms[n].request(now, 3_600_000, lastTs); lastTs = now; }
        for (const n in arms) arms[n].push({ role: "assistant", content: blocks });
      } else for (const n in arms) arms[n].extend(blocks);
    } else if (e.type === "user" && e.message) {
      const c = e.message.content;
      for (const n in arms) arms[n].push({ role: "user", content: Array.isArray(c) ? c : [{ type: "text", text: String(c ?? "") }] });
    }
  }
  for (const n in arms) (res[n] ??= []).push({ w: arms[n].w + (arms[n]._w ?? 0), t: arms[n].t + (arms[n]._t ?? 0) });
}
const sum = (a, k) => a.reduce((x, y) => x + y[k], 0);
console.log("sessions replayed:", used);
for (const n of Object.keys(variants)) {
  const a = res[n], B = res.base; const per = a.map((x, i) => 1 - x.w / B[i].w).sort((x, y) => x - y);
  console.log(`${n}: cache-weighted ${((1 - sum(a, "w") / sum(B, "w")) * 100).toFixed(1)}% saved, raw input ${((1 - sum(a, "t") / sum(B, "t")) * 100).toFixed(1)}% | per session worst ${(per[0] * 100).toFixed(2)}%, median ${(per[per.length >> 1] * 100).toFixed(1)}%, best ${(per.at(-1) * 100).toFixed(1)}%, worse: ${per.filter((x) => x < -1e-9).length}`);
}
