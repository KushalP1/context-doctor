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
function pdf(lines) {
    const stream = "BT /F1 12 Tf 72 720 Td 16 TL " + lines.map((l) => `(${l}) '`).join(" ") + " ET";
    const objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let out = "%PDF-1.4\n";
    const offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const x = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
    return out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
}
const has = (cmd) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd]).status === 0;
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
// -- Safety: no network from a document, and no blocking the server ----------
test("textutil never loads a document's subresources: an HTML '.doc' cannot make it fetch", { skip: process.platform !== "darwin" && "macOS only" }, async () => {
    const { createServer } = await import("node:http");
    const { extractTextAsync, TEXTUTIL_ARGS } = await import("../extract.js");
    assert.ok(TEXTUTIL_ARGS.includes("-noload") && TEXTUTIL_ARGS.includes("-nostore"));
    const hits = [];
    const srv = createServer((req, res) => {
        hits.push(req.url ?? "");
        res.end("body{}");
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    try {
        const dir = mkdtempSync(join(tmpdir(), "cd-extract-ssrf-"));
        const html = `<html><head><link rel="stylesheet" href="http://127.0.0.1:${port}/css"></head><body><p>quarterly report</p><img src="http://127.0.0.1:${port}/img.png"><iframe src="http://127.0.0.1:${port}/frame"></iframe></body></html>`;
        for (const name of ["upload.doc", "upload.docx", "upload.odt"]) {
            writeFileSync(join(dir, name), html);
            const got = await extractTextAsync(join(dir, name));
            assert.ok("text" in got && /quarterly report/.test(got.text), `${name}: ${JSON.stringify(got)}`);
        }
        await new Promise((r) => setTimeout(r, 200));
        assert.deepEqual(hits, [], "no request may leave the machine because of a document");
    }
    finally {
        srv.close();
    }
});
test("extraction is asynchronous and bounded: a hung converter neither blocks the event loop nor outlives the budget", { skip: process.platform === "win32" && "a POSIX shell script stands in for the converter" }, async () => {
    const { chmodSync } = await import("node:fs");
    const { extractTextAsync } = await import("../extract.js");
    const { readSourcesAsync } = await import("../pack.js");
    const bin = mkdtempSync(join(tmpdir(), "cd-extract-bin-"));
    for (const cmd of ["pdftotext", "osascript"]) {
        // A grandchild holding the output pipe open: killing the converter alone is not enough.
        writeFileSync(join(bin, cmd), "#!/bin/sh\nsleep 30 &\nwait\n");
        chmodSync(join(bin, cmd), 0o755);
    }
    const dir = mkdtempSync(join(tmpdir(), "cd-extract-slow-"));
    const path = join(dir, "slow.pdf");
    writeFileSync(path, pdf(["never read"]));
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    try {
        const started = Date.now();
        const got = await extractTextAsync(path, Date.now() + 600);
        const took = Date.now() - started;
        assert.ok("error" in got && /time allowed/.test(got.error), JSON.stringify(got));
        assert.ok(took < 3000, `stopped at the budget, not the converter (${took} ms)`);
        // A blocking read gives 0 or 1 ticks; a starved CI runner gave 4 of the ~12 a 600 ms wait allows.
        assert.ok(ticks >= 3, `the event loop kept running (${ticks} ticks in ${took} ms)`);
        const r = await readSourcesAsync([path], { cwd: dir, budgetMs: 300 });
        assert.equal(r.sources.length, 0);
        assert.match(r.skipped.join("\n"), /slow\.pdf: not read: the time allowed/);
    }
    finally {
        clearInterval(timer);
        process.env.PATH = savedPath;
    }
});
test("readSourcesAsync reads the same sources as readSources, PDFs included", { skip: !canPdf && "no pdftotext and not macOS" }, async () => {
    const { readSourcesAsync } = await import("../pack.js");
    const dir = mkdtempSync(join(tmpdir(), "cd-extract-async-"));
    writeFileSync(join(dir, "a.md"), "# A\n\nalpha");
    writeFileSync(join(dir, "manual.pdf"), pdf(["Rotate the signing key with keyctl rotate."]));
    const sync = readSources([dir], dir);
    // The same time a synchronous read allows one tool (30 s): Windows runners
    // start pdftotext slowly enough that the server's 20 s budget for a whole
    // call sometimes ran out there, and this test compares reading, not budgets.
    const asyncRead = await readSourcesAsync([dir], { cwd: dir, budgetMs: 60_000 });
    assert.deepEqual(asyncRead.sources.map((s) => s.name).sort(), sync.sources.map((s) => s.name).sort(), `skipped: ${asyncRead.skipped.join("; ")}`);
    if (process.platform !== "win32")
        assert.ok(asyncRead.sources.some((s) => /keyctl/.test(s.text)));
});
