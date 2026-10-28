/**
 * Text out of PDFs and office documents, with tools the OS already has.
 *
 * Most big documents people paste into a chat are PDFs and Word files. pack
 * stays dependency-free, so this shells out to what is usually installed:
 * `pdftotext` (poppler) anywhere, PDFKit through `osascript` on macOS,
 * `textutil` for Word/RTF/ODT on macOS, and `unzip` for the zipped XML
 * formats (docx, pptx, odt) elsewhere. When none is available the caller
 * gets a reason that names what to install, never a silent skip.
 *
 * Two safety rules, both learned from a QA pass on uploads over --http:
 *  - textutil runs with -noload -nostore. A ".doc" that is really HTML made
 *    textutil fetch its stylesheets and images, from 127.0.0.1 and from
 *    169.254.169.254 as readily as from the web: a server-side request
 *    forgery through a document;
 *  - the MCP server extracts with extractTextAsync, which never blocks the
 *    event loop and stops at a time budget for the whole call (a slow PDF
 *    held /health for 30 s; one can take 120 s). The synchronous
 *    extractText stays for the one-shot CLI.
 */

import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";

export const EXTRACTABLE = new Set([".pdf", ".docx", ".doc", ".rtf", ".odt", ".pptx"]);

const RUN = { encoding: "utf8" as const, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 };

function run(cmd: string, args: string[]): string | undefined {
  try {
    const r = spawnSync(cmd, args, RUN);
    return r.status === 0 && typeof r.stdout === "string" && r.stdout.trim() ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** Never load or write a document's subsidiary resources (stylesheets, images, frames). */
export const TEXTUTIL_ARGS = ["-convert", "txt", "-noload", "-nostore", "-stdout"];

const PDFKIT_JXA =
  'ObjC.import("PDFKit"); function run(a) { const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(a[0])); return d.isNil() ? "" : d.string.js }';

/**
 * pdftotext comes in two families (poppler, and Xpdf as shipped with some
 * Windows toolchains) that disagree on `-enc` names and on writing to stdout,
 * so try the common form, then without the encoding flag, then via a file.
 */
function pdftotext(path: string): string | undefined {
  const direct = run("pdftotext", ["-enc", "UTF-8", path, "-"]) ?? run("pdftotext", [path, "-"]);
  if (direct) return direct;
  const out = join(mkdtempSync(join(tmpdir(), "cd-pdf-")), "out.txt");
  try {
    spawnSync("pdftotext", [path, out], RUN);
    const text = existsSync(out) ? readFileSync(out, "utf8") : "";
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(dirname(out), { recursive: true, force: true });
  }
}

/** Paragraph-ish text from zipped XML: one paragraph per closing p/slide-text tag, entities decoded. */
function fromZippedXml(path: string, members: string[]): string | undefined {
  const xml = run("unzip", ["-p", path, ...members]);
  return xml ? xmlToText(xml) : undefined;
}

function xmlToText(xml: string): string {
  return xml
    .replace(/<\/(w:p|a:p|text:p|text:h)>/g, "\n\n")
    .replace(/<(w:tab|w:br)\/>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The document's text, or the reason it could not be read. */
export function extractText(path: string): { text: string } | { error: string } {
  const ext = extname(path).toLowerCase();
  const mac = process.platform === "darwin";
  let text: string | undefined;
  if (ext === ".pdf") {
    // Form feeds separate pages; as blank lines they become paragraph boundaries.
    text = pdftotext(path)?.replace(/\f/g, "\n\n");
    if (!text && mac) text = run("osascript", ["-l", "JavaScript", "-e", PDFKIT_JXA, path]);
    if (!text) {
      return { error: mac ? "no text layer (scanned PDF?) or unreadable" : "needs pdftotext (install poppler-utils), or the PDF has no text layer" };
    }
  } else {
    if (mac && ext !== ".pptx") text = run("textutil", [...TEXTUTIL_ARGS, path]);
    if (!text) {
      const members = ext === ".docx" ? ["word/document.xml"] : ext === ".pptx" ? ["ppt/slides/*.xml"] : ext === ".odt" ? ["content.xml"] : [];
      if (members.length) text = fromZippedXml(path, members);
    }
    if (!text) return { error: mac ? "unreadable document" : `needs unzip${ext === ".doc" || ext === ".rtf" ? " (and .doc/.rtf need macOS textutil; save as .docx)" : ""}` };
  }
  return { text };
}

/** Default time budget for one extraction call in the MCP server. */
export const EXTRACT_BUDGET_MS = 20_000;

/**
 * A command's stdout, or undefined, without blocking the event loop: killed
 * (SIGKILL) when `deadline` passes. `timedOut` says which happened.
 */
function runAsync(cmd: string, args: string[], deadline: number): Promise<{ out?: string; timedOut: boolean }> {
  const timeout = deadline - Date.now();
  if (timeout <= 0) return Promise.resolve({ timedOut: true });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { out?: string; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof execFile> | undefined;
    // execFile's own timeout kills the child, but its callback waits for the
    // output pipes to close, which a grandchild can hold open: answer at the
    // deadline whatever the pipes do.
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish({ timedOut: true });
    }, timeout);
    try {
      child = execFile(cmd, args, { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        // Only the clock says the budget ran out: a child killed for another
        // reason (seen on Windows runners, well inside a 60 s budget) is a
        // failed tool, and the next one is tried.
        if (err) return finish({ timedOut: Date.now() >= deadline - 50 });
        finish({ out: typeof stdout === "string" && stdout.trim() ? stdout : undefined, timedOut: false });
      });
      child.on("error", () => finish({ timedOut: false }));
    } catch {
      finish({ timedOut: false });
    }
  });
}

/**
 * extractText for a server: asynchronous, and bounded by `deadline` (ms since
 * the epoch) across every tool it tries. Past the deadline the reason says so.
 */
export async function extractTextAsync(path: string, deadline = Date.now() + EXTRACT_BUDGET_MS): Promise<{ text: string } | { error: string }> {
  const ext = extname(path).toLowerCase();
  const mac = process.platform === "darwin";
  let text: string | undefined;
  let timedOut = false;
  const tryRun = async (cmd: string, args: string[]) => {
    if (text || timedOut) return;
    const r = await runAsync(cmd, args, deadline);
    if (r.timedOut) timedOut = true;
    else text = r.out;
  };
  const late = () => ({ error: "not read: the time allowed for reading documents in this call ran out" });
  if (ext === ".pdf") {
    await tryRun("pdftotext", ["-enc", "UTF-8", path, "-"]);
    await tryRun("pdftotext", [path, "-"]);
    if (!text && !timedOut) {
      const out = join(mkdtempSync(join(tmpdir(), "cd-pdf-")), "out.txt");
      try {
        const r = await runAsync("pdftotext", [path, out], deadline);
        if (r.timedOut) timedOut = true;
        else if (existsSync(out)) text = readFileSync(out, "utf8").trim() ? readFileSync(out, "utf8") : undefined;
      } finally {
        rmSync(dirname(out), { recursive: true, force: true });
      }
    }
    text = text?.replace(/\f/g, "\n\n");
    if (!text && mac) await tryRun("osascript", ["-l", "JavaScript", "-e", PDFKIT_JXA, path]);
    if (!text) {
      if (timedOut) return late();
      return { error: mac ? "no text layer (scanned PDF?) or unreadable" : "needs pdftotext (install poppler-utils), or the PDF has no text layer" };
    }
    return { text };
  }
  if (mac && ext !== ".pptx") await tryRun("textutil", [...TEXTUTIL_ARGS, path]);
  if (!text && !timedOut) {
    const members = ext === ".docx" ? ["word/document.xml"] : ext === ".pptx" ? ["ppt/slides/*.xml"] : ext === ".odt" ? ["content.xml"] : [];
    if (members.length) {
      const r = await runAsync("unzip", ["-p", path, ...members], deadline);
      if (r.timedOut) timedOut = true;
      else if (r.out) text = xmlToText(r.out);
    }
  }
  if (!text) {
    if (timedOut) return late();
    return { error: mac ? "unreadable document" : `needs unzip${ext === ".doc" || ext === ".rtf" ? " (and .doc/.rtf need macOS textutil; save as .docx)" : ""}` };
  }
  return { text };
}
