/** reads: files read across sessions, counted from transcripts, images billed as images. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReads, repeatedReads } from "../reads.js";

function session(dir: string, name: string, cwd: string, files: Array<[string, unknown]>): string {
  const lines: string[] = [];
  files.forEach(([path, content], i) => {
    lines.push(JSON.stringify({ type: "assistant", cwd, message: { model: "claude-sonnet-5", content: [{ type: "tool_use", id: `${name}-${i}`, name: "Read", input: { file_path: path } }] } }));
    lines.push(JSON.stringify({ type: "user", cwd, message: { content: [{ type: "tool_result", tool_use_id: `${name}-${i}`, content }] } }));
  });
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

test("a file read in most of a project's sessions is a summary candidate; images count as images", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-reads-"));
  const big = "export const x = 1;\n".repeat(400);
  const shot = [{ type: "image", source: { type: "base64", data: "A".repeat(500_000) } }];
  const paths = [
    session(dir, "s1", "/w/app", [["/w/app/README.md", big], ["/w/app/shot.png", shot]]),
    session(dir, "s2", "/w/app", [["/w/app/README.md", big], ["/w/app/shot.png", shot]]),
    session(dir, "s3", "/w/app", [["/w/app/README.md", big], ["/w/app/shot.png", shot], ["/w/app/README.md", big]]),
    session(dir, "s4", "/w/app", [["/w/app/other.ts", "x"]]),
  ];
  const r = repeatedReads(30, paths);
  assert.equal(r.sessions, 4);
  const readme = r.files.find((f) => f.path.endsWith("README.md"))!;
  assert.equal(readme.sessions, 3);
  assert.equal(readme.reads, 4);
  assert.equal(readme.projectSessions, 4);
  assert.equal(readme.advice, "summarize");
  const shotFile = r.files.find((f) => f.path.endsWith("shot.png"))!;
  assert.equal(shotFile.tokens, 3 * 1600, "an image bills as ~1.6k tokens, not as 500k chars of base64");
  assert.ok(!r.files.some((f) => f.path.endsWith("other.ts")), "read in one session: not repeated");
  assert.match(renderReads(r), /Read in most of their project's sessions: .*README\.md/);
});
