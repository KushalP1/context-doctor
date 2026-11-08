/**
 * A Claude Code session whose requests carry each billing modifier the
 * transcripts record (Anthropic's price page, read 2026-11-08): a fast-mode
 * Opus 5.5 reply (written as two rows, its output settled on the second), a
 * US-only Sonnet 5.5 one, a 150k-token Haiku 5.5 prompt, and an Opus 5.5
 * reply that ran two web searches, among eight plain Opus 5.5 requests
 * recorded as Claude Code records them (speed "standard", inference_geo
 * "global", no searches). Each modifier's dollars are worked out by hand.
 */

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MIN = 60_000;
/** The session's id: its transcript's name. */
export const MODIFIER_SESSION = "5e55a0f1-0000-4000-8000-00000000f00d";

/** What each modifier adds, by hand (USD per 1M; 1-hour writes at 2x input). */
export const MODIFIER_USD = {
  // Fast mode, Opus 5.5 ($8 / $40, reads $0.40): 10 in, 4k written, 100k read, 800 out, against the list row ($4 / $20 / $0.20).
  fast: (10 * 8 + 4_000 * 16 + 100_000 * 0.4 + 800 * 40) / 1e6,
  fastList: (10 * 4 + 4_000 * 8 + 100_000 * 0.2 + 800 * 20) / 1e6,
  // US-only, Sonnet 5.5 ($2 / $10 / $0.10) at 1.1x: 10 in, 4k written, 100k read, 500 out.
  geoList: (10 * 2 + 4_000 * 4 + 100_000 * 0.1 + 500 * 10) / 1e6,
  // Haiku 5.5, a 150,000-token prompt (10 in, 9,990 written, 140k read), 400 out: $0.50 / $2.50 / $0.05 against $0.10 / $0.50 / $0.01.
  long: (10 * 0.5 + 9_990 * 1 + 140_000 * 0.05 + 400 * 2.5) / 1e6,
  longList: (10 * 0.1 + 9_990 * 0.2 + 140_000 * 0.01 + 400 * 0.5) / 1e6,
  // Two web searches at $10 per 1,000, on an Opus 5.5 reply (10 in, 4k written, 100k read, 600 out).
  searchTokens: (10 * 4 + 4_000 * 8 + 100_000 * 0.2 + 600 * 20) / 1e6,
  searches: 2 * 0.01,
};

/** The eight plain requests: Opus 5.5, a growing context, 1-hour writes. */
const plain = (i: number) => ({ input_tokens: 5, cache_read_input_tokens: 60_000 + i * 5_000, cache_creation_input_tokens: 5_000, output_tokens: 300 });
export const PLAIN_USD = Array.from({ length: 8 }, (_, i) => { const u = plain(i); return (u.input_tokens * 4 + u.cache_creation_input_tokens * 8 + u.cache_read_input_tokens * 0.2 + u.output_tokens * 20) / 1e6; }).reduce((a, b) => a + b, 0);
/** Everything the session cost. */
export const MODIFIER_SESSION_USD = PLAIN_USD + MODIFIER_USD.fast + MODIFIER_USD.geoList * 1.1 + MODIFIER_USD.long + MODIFIER_USD.searchTokens + MODIFIER_USD.searches;

/** Writes the session under `home`'s Claude Code projects, its replies a minute apart from `start`. Returns its path. */
export function writeModifierSession(home: string, start: number, project = "-Users-me-tech-billing"): string {
  const dir = join(home, ".claude", "projects", project);
  mkdirSync(dir, { recursive: true });
  const rows: unknown[] = [];
  let t = start;
  const row = (id: string, k: number, model: string, usage: Record<string, unknown>, at: number) => ({
    type: "assistant", uuid: `${id}-${k}`, sessionId: MODIFIER_SESSION, cwd: "/Users/me/tech/billing", timestamp: new Date(at).toISOString(),
    message: { id, model, role: "assistant", content: [{ type: "text", text: "ok" }], usage },
  });
  const recorded = (u: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    ...u, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: u.cache_creation_input_tokens },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: "standard", inference_geo: "global", speed: "standard", ...extra,
  });
  rows.push({ type: "user", uuid: "mod-u0", sessionId: MODIFIER_SESSION, timestamp: new Date(t - MIN).toISOString(), message: { role: "user", content: "go" } });
  for (let i = 0; i < 8; i++) rows.push(row(`msg_mod_${i}`, 0, "claude-opus-5-5", recorded(plain(i)), (t += MIN)));
  // Fast mode, streamed: the first row's output is not the reply's.
  const fast = { input_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 4_000 };
  rows.push(row("msg_mod_fast", 0, "claude-opus-5-5", recorded({ ...fast, output_tokens: 100 }, { speed: "fast" }), (t += MIN)));
  rows.push(row("msg_mod_fast", 1, "claude-opus-5-5", recorded({ ...fast, output_tokens: 800 }, { speed: "fast" }), t + 1_000));
  rows.push(row("msg_mod_us", 0, "claude-sonnet-5-5", recorded({ input_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 4_000, output_tokens: 500 }, { inference_geo: "us" }), (t += MIN)));
  rows.push(row("msg_mod_long", 0, "claude-haiku-5-5", recorded({ input_tokens: 10, cache_read_input_tokens: 140_000, cache_creation_input_tokens: 9_990, output_tokens: 400 }), (t += MIN)));
  rows.push(row("msg_mod_search", 0, "claude-opus-5-5", recorded({ input_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 4_000, output_tokens: 600 }, { server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } }), (t += MIN)));
  const path = join(dir, `${MODIFIER_SESSION}.jsonl`);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  utimesSync(path, t / 1000, t / 1000);
  return path;
}
