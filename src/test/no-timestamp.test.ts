/**
 * A request recorded with no time of its own is priced as of now, as
 * requestCost prices any request it is given no time for: past a day its
 * model's price changed, that is the newer price, labelled an estimate.
 * Before, NaN compared as "never expired": the budget (and every replay
 * that passed the parsed time on) priced such a row at the ended price,
 * unlabelled, while lens, subagents and tasks priced it at today's, and
 * savings at 1970's. One rule now, the same in each.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestCost } from "../pricing.js";
import { refreshEntry } from "../budget.js";
import { sessionLens } from "../lens.js";
import { subagentReport } from "../subagents.js";
import { sessionCost } from "../tasks.js";
import { withSandboxHome } from "./sandbox.js";

/** After Gemini 4 Argon went from $2 / $10 to $4 / $20 (2026-12-01). */
const CLOCK = Date.UTC(2026, 11, 15, 12);
const iso = (t: number) => new Date(t).toISOString();
const usage = { input_tokens: 100_000, output_tokens: 10_000 };
/** A dated Claude reply, then the Argon reply (through a gateway that records the model it ran), stamped or not. */
function rows(stamped: boolean, tag: string): string {
  return [
    { type: "user", uuid: `${tag}-u`, timestamp: iso(CLOCK - 3 * 3_600_000), message: { role: "user", content: "go" } },
    { type: "assistant", uuid: `${tag}-a`, timestamp: iso(CLOCK - 2 * 3_600_000), message: { id: `${tag}-m1`, model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1_000, output_tokens: 100 } } },
    { type: "assistant", uuid: `${tag}-b`, ...(stamped ? { timestamp: iso(CLOCK - 3_600_000) } : {}), message: { id: `${tag}-m2`, model: "gemini-4-argon", role: "assistant", content: [{ type: "text", text: "ok" }], usage } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n";
}

test("a request with no timestamp is priced as of now, alike in the budget, lens, subagents and tasks (and as requestCost prices it)", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-no-ts-"));
  const realNow = Date.now;
  Date.now = () => CLOCK;
  try {
    await withSandboxHome(home, () => {
      const dir = join(home, ".claude", "projects", "-Users-me-app");
      const write = (name: string, stamped: boolean) => {
        const main = join(dir, `${name}.jsonl`);
        mkdirSync(join(dir, name, "subagents"), { recursive: true });
        writeFileSync(main, rows(stamped, name));
        writeFileSync(join(dir, name, "subagents", "agent-a1.jsonl"), rows(stamped, `${name}-sub`).replace(/"type":"assistant"/g, '"type":"assistant","isSidechain":true'));
        return main;
      };
      const stamped = write("stamped", true), bare = write("bare", false);
      const argon = requestCost("gemini-4-argon", usage, NaN)!;
      assert.equal(argon.changedOn, "2026-12-01");
      assert.ok(Math.abs(argon.totalUsd - (100_000 * 4 + 10_000 * 20) / 1e6) < 1e-12, "the newer price");
      assert.ok(Math.abs(argon.totalUsd - requestCost("gemini-4-argon", usage)!.totalUsd) < 1e-12);

      const budget = (p: string) => refreshEntry("claude", p, undefined, 0, true)!.e.d.reduce((a, b) => a + b, 0);
      const lens = (p: string) => sessionLens(p).totalUsd;
      const subagents = (p: string) => subagentReport(p)!.totalCostUsd;
      const tasks = (p: string) => sessionCost(p)!.usd;
      for (const [name, f] of [["the session price (the budget's ledger entry)", budget], ["lens", lens], ["subagents", subagents], ["tasks", tasks]] as const) {
        const a = f(stamped), b = f(bare);
        assert.ok(Math.abs(a - b) < 1e-9, `${name}: ${b} with no timestamp, ${a} stamped`);
        assert.ok(a > argon.totalUsd, `${name}: ${a} holds the Argon request at its newer price`);
      }
    });
  } finally {
    Date.now = realNow;
    rmSync(home, { recursive: true, force: true });
  }
});
