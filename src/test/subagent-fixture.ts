/** Subagent transcripts for the subagents'-model tests: replies as Claude Code streams them, in a throwaway home. */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DAY = 86_400_000;

let n = 0;
/**
 * One subagent reply as Claude Code writes it while it streams: a first row
 * with a partial output count, then the last row with the final one. Usage:
 * 1k uncached, 200k read, 10k written (4k at 5 minutes, 6k at 1 hour), 1k out.
 */
export function reply(at: number, model: string, cwd: string, id = `msg_sm${n++}`): string[] {
  const usage = (out: number) => ({ input_tokens: 1000, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 10_000, output_tokens: out, cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 6000 } });
  const row = (out: number, k: number) => JSON.stringify({ type: "assistant", isSidechain: true, cwd, uuid: `${id}-${k}`, timestamp: new Date(at).toISOString(), message: { id, model, content: [{ type: "text", text: "ok" }], usage: usage(out) } });
  return [row(10, 0), row(1000, 1)];
}
// That reply at each price (Opus 5.5 $4/$20/$0.2, Sonnet 5.5 $2/$10/$0.1, Fable 5.1 $10/$50/$0.25):
// uncached + reads + writes (4k x 1.25 + 6k x 2 = 17k input-priced) + output.
export const OPUS = (1000 * 4 + 200_000 * 0.2 + 17_000 * 4 + 1000 * 20) / 1e6;
export const SONNET = (1000 * 2 + 200_000 * 0.1 + 17_000 * 2 + 1000 * 10) / 1e6;
export const FABLE = (1000 * 10 + 200_000 * 0.25 + 17_000 * 10 + 1000 * 50) / 1e6;

export interface Agent { id: string; type?: string; rows: string[] }

/** A throwaway home: a session with these subagents, a user agent file and a project one. */
export function history(agents: (cwd: string) => Agent[]): { home: string; cwd: string; parent: string; sub: string } {
  const home = mkdtempSync(join(tmpdir(), "cd-sm-"));
  const cwd = mkdtempSync(join(tmpdir(), "cd-sm-proj-"));
  mkdirSync(join(home, ".claude", "agents"), { recursive: true });
  writeFileSync(join(home, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews\nmodel: haiku\n---\nReview.\n");
  mkdirSync(join(cwd, ".claude", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "agents", "helper.md"), "---\nname: helper\ndescription: helps\n---\nHelp.\n");
  const project = join(home, ".claude", "projects", "-tmp-proj");
  const sub = join(project, "s1", "subagents");
  mkdirSync(sub, { recursive: true });
  const parent = join(project, "s1.jsonl");
  writeFileSync(parent, JSON.stringify({ type: "assistant", uuid: "p1", timestamp: new Date(Date.now() - 2 * DAY).toISOString(), message: { id: "p1", model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } }) + "\n");
  for (const a of agents(cwd)) {
    writeFileSync(join(sub, `agent-${a.id}.jsonl`), a.rows.join("\n") + "\n");
    if (a.type) writeFileSync(join(sub, `agent-${a.id}.meta.json`), JSON.stringify({ agentType: a.type, description: a.id }));
  }
  return { home, cwd, parent, sub };
}

export const now = Date.now();
export const at = now - 2 * DAY;
export function mixed(cwd: string): Agent[] {
  const gp = reply(at, "claude-opus-5-5", cwd);
  return [
    { id: "a1", type: "general-purpose", rows: gp },
    { id: "a2", type: "Explore", rows: reply(at, "claude-opus-5-5", cwd) },
    { id: "a3", type: "general-purpose", rows: reply(at, "claude-sonnet-5-5", cwd) },
    { id: "a4", type: "reviewer", rows: reply(at, "claude-opus-5-5", cwd) },
    { id: "a5", type: "helper", rows: reply(at, "claude-opus-5-5", cwd) },
    // A copy of a1's transcript (a resumed subagent): the same reply, billed once.
    { id: "a6", type: "general-purpose", rows: gp },
    { id: "a7", type: "mystery", rows: reply(at, "claude-opus-5-5", cwd) },
    // On Fable 5.1, with a request from before the period.
    { id: "a8", type: "general-purpose", rows: [...reply(now - 40 * DAY, "claude-fable-5-1", cwd), ...reply(at, "claude-fable-5-1", cwd)] },
  ];
}
