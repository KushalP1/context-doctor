import { listSessions, parseSessionFile } from "./dist/session.js";
import { parseConversation } from "./dist/parse.js";
import { profileConversation } from "./dist/profile.js";
import { renderProfile } from "./dist/report.js";
import { tailUsage, renderStatusLine } from "./dist/statusline.js";
import { detectColdResume, coldResumeEvents } from "./dist/coldresume.js";
const res = { ok: 0, fail: 0, kinds: {} };
const all = listSessions(100000);
for (const s of all) {
  const kind = s.path.includes(".codex") ? "codex" : "claude";
  try {
    const p = parseSessionFile(s.path);
    const prof = profileConversation(parseConversation(p.conversationJson), p.model);
    renderProfile(prof);
    if (kind === "claude") { tailUsage(s.path); detectColdResume(s.path); coldResumeEvents(s.path); renderStatusLine({ transcript_path: s.path, model: { id: p.model ?? "" } }); }
    if (!Number.isFinite(prof.totalTokens)) throw new Error("non-finite total");
    res.ok++;
  } catch (e) { res.fail++; res.kinds[e.message.slice(0, 80)] = (res.kinds[e.message.slice(0, 80)] ?? 0) + 1; if (res.fail < 4) console.log("FAIL", s.path.slice(-60), e.stack.split("\n").slice(0, 3).join(" | ")); }
}
console.log("sessions:", all.length, "ok:", res.ok, "failed:", res.fail, res.kinds);
