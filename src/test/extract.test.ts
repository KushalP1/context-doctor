/** extract: PDFs and Word files reach pack as text, through tools the OS already has. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractText } from "../extract.js";
import { packContext, readSources } from "../pack.js";

/** A minimal one-page PDF with a real text layer. */
function pdf(lines: string[]): string {
  const stream = "BT /F1 12 Tf 72 720 Td 16 TL " + lines.map((l) => `(${l}) '`).join(" ") + " ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  return out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
}

const has = (cmd: string) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd]).status === 0;
const canPdf = has("pdftotext") || process.platform === "darwin";

test("a PDF's text layer is read and packed", { skip: !canPdf && "no pdftotext and not macOS" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-extract-"));
  const path = join(dir, "manual.pdf");
  writeFileSync(path, pdf(["Signing keys", "Rotate the signing key with keyctl rotate.", "Billing", "Invoices go out monthly."]));
  const got = extractText(path);
  if (process.platform === "win32" && "error" in got) {
    // Windows toolchains ship assorted pdftotext builds; there the contract is
    // a stated reason instead of text, never a silent empty result.
    assert.ok(got.error.length > 0);
    return;
  }
  assert.ok("text" in got && /keyctl rotate/.test(got.text), JSON.stringify(got).slice(0, 200));
  const { sources, skipped } = readSources([path], dir);
  assert.deepEqual(skipped, []);
  const r = packContext(sources, { query: "rotate signing key" });
  assert.ok(r.selected.some((c) => c.text.includes("keyctl")));
});

test("a Word document is read on macOS through textutil", { skip: process.platform !== "darwin" && "macOS only" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-extract-"));
  writeFileSync(join(dir, "t.html"), "<h1>Refunds</h1><p>Refunds take five days.</p>");
  spawnSync("textutil", ["-convert", "docx", join(dir, "t.html"), "-output", join(dir, "t.docx")]);
  const got = extractText(join(dir, "t.docx"));
  assert.ok("text" in got && /five days/.test(got.text));
});

test("an unreadable PDF is reported with a reason, not dropped silently", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-extract-"));
  const path = join(dir, "broken.pdf");
  writeFileSync(path, "not a pdf");
  const { sources, skipped } = readSources([path], dir);
  assert.equal(sources.length, 0);
  assert.match(skipped[0], /broken\.pdf: /);
});
