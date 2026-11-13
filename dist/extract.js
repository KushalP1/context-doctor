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
import { dirname, extname, join, resolve } from "node:path";
import { toolCwd } from "./toolcwd.js";
export const EXTRACTABLE = new Set([".pdf", ".docx", ".doc", ".rtf", ".odt", ".pptx"]);
const RUN = { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 };
function run(cmd, args) {
    try {
        const r = spawnSync(cmd, args, { ...RUN, cwd: toolCwd() });
        return r.status === 0 && typeof r.stdout === "string" && r.stdout.trim() ? r.stdout : undefined;
    }
    catch {
        return undefined;
    }
}
/** Never load or write a document's subsidiary resources (stylesheets, images, frames). */
export const TEXTUTIL_ARGS = ["-convert", "txt", "-noload", "-nostore", "-stdout"];
const PDFKIT_JXA = 'ObjC.import("PDFKit"); function run(a) { const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(a[0])); return d.isNil() ? "" : d.string.js }';
/**
 * pdftotext comes in two families (poppler, and Xpdf as shipped with some
 * Windows toolchains) that disagree on `-enc` names and on writing to stdout,
 * so try the common form, then without the encoding flag, then via a file.
 */
function pdftotext(path) {
    const direct = run("pdftotext", ["-enc", "UTF-8", path, "-"]) ?? run("pdftotext", [path, "-"]);
    if (direct)
        return direct;
    const out = join(mkdtempSync(join(tmpdir(), "cd-pdf-")), "out.txt");
    try {
        spawnSync("pdftotext", [path, out], { ...RUN, cwd: toolCwd() });
        const text = existsSync(out) ? readFileSync(out, "utf8") : "";
        return text.trim() ? text : undefined;
    }
    catch {
        return undefined;
    }
    finally {
        rmSync(dirname(out), { recursive: true, force: true });
    }
}
/** Paragraph-ish text from zipped XML: one paragraph per closing p/slide-text tag, entities decoded. */
function fromZippedXml(path, members) {
    const xml = run("unzip", ["-p", path, ...members]);
    return xml ? xmlToText(xml) : undefined;
}
function xmlToText(xml) {
    return xml
        .replace(/<\/(w:p|a:p|text:p|text:h)>/g, "\n\n")
        .replace(/<(w:tab|w:br)\/>/g, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
/**
 * The document's path as a converter's argument: absolute, so a file named
 * like an option is never read as one. `pack .` met
 * `-eObjC.import("stdlib");$.system("…");var x={};x.pdf` as that very
 * string, and osascript ran it as a second script statement.
 */
function argPath(path) {
    return resolve(path);
}
/** The document's text, or the reason it could not be read. */
export function extractText(name) {
    const path = argPath(name);
    const ext = extname(path).toLowerCase();
    const mac = process.platform === "darwin";
    let text;
    if (ext === ".pdf") {
        // Form feeds separate pages; as blank lines they become paragraph boundaries.
        text = pdftotext(path)?.replace(/\f/g, "\n\n");
        if (!text && mac)
            text = run("osascript", ["-l", "JavaScript", "-e", PDFKIT_JXA, path]);
        if (!text) {
            return { error: mac ? "no text layer (scanned PDF?) or unreadable" : "needs pdftotext (install poppler-utils), or the PDF has no text layer" };
        }
    }
    else {
        if (mac && ext !== ".pptx")
            text = run("textutil", [...TEXTUTIL_ARGS, path]);
        if (!text) {
            const members = ext === ".docx" ? ["word/document.xml"] : ext === ".pptx" ? ["ppt/slides/*.xml"] : ext === ".odt" ? ["content.xml"] : [];
            if (members.length)
                text = fromZippedXml(path, members);
        }
        if (!text)
            return { error: mac ? "unreadable document" : `needs unzip${ext === ".doc" || ext === ".rtf" ? " (and .doc/.rtf need macOS textutil; save as .docx)" : ""}` };
    }
    return { text };
}
/** Default time budget for one extraction call in the MCP server. */
export const EXTRACT_BUDGET_MS = 20_000;
/**
 * Milliseconds on a monotonic clock. The budget is counted on it, never on
 * Date.now(): a wall clock can jump forward (time sync after a boot), and a
 * jump read as the budget running out.
 */
export const monotonicNow = () => performance.now();
/**
 * The longest one tool may run: half the time left (at least 2 s), and never
 * more than the 30 s the synchronous path gives a tool. One form of
 * pdftotext hanging used to take the whole budget, so the next form was
 * never tried: Windows runners reported a PDF as "not read: the time ran
 * out" inside a 60 s budget that the synchronous read of the same file
 * (30 s a tool) got through.
 */
function toolCap(left) {
    return Math.min(left, 30_000, Math.max(2_000, left / 2));
}
/**
 * A command's stdout, or undefined, without blocking the event loop: killed
 * (SIGKILL) when its share of the time (toolCap) runs out. `timedOut` is set
 * only when `end` (on the monotonic clock) has passed: a tool stopped
 * earlier is a failed tool, and the next one is tried.
 */
function runAsync(cmd, args, end) {
    const left = Math.ceil(end - monotonicNow());
    if (left <= 0)
        return Promise.resolve({ timedOut: true });
    const timeout = Math.ceil(toolCap(left));
    return new Promise((resolve) => {
        let settled = false;
        const finish = (r) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(r);
        };
        let child;
        // execFile's own timeout kills the child, but its callback waits for the
        // output pipes to close, which a grandchild can hold open: answer at the
        // deadline whatever the pipes do.
        const timer = setTimeout(() => {
            child?.kill("SIGKILL");
            finish({ timedOut: monotonicNow() >= end - 50 });
        }, timeout);
        try {
            child = execFile(cmd, args, { cwd: toolCwd(), encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
                // Only the clock says the budget ran out: a child killed for another
                // reason (seen on Windows runners, well inside a 60 s budget) is a
                // failed tool, and the next one is tried.
                if (err)
                    return finish({ timedOut: monotonicNow() >= end - 50 });
                finish({ out: typeof stdout === "string" && stdout.trim() ? stdout : undefined, timedOut: false });
            });
            child.on("error", () => finish({ timedOut: false }));
            // No input, as spawnSync gives the synchronous path: a converter that
            // reads stdin gets end-of-file instead of waiting out the budget.
            child.stdin?.on("error", () => { });
            child.stdin?.end();
        }
        catch {
            finish({ timedOut: false });
        }
    });
}
/**
 * extractText for a server: asynchronous, and bounded by `end` (on the
 * monotonic clock, monotonicNow()) across every tool it tries. Past it the
 * reason says so. A caller with one budget for several documents sets one
 * `end` on the same clock: a deadline on the wall clock, converted per
 * document, let a clock jump between two documents cut the later ones short.
 */
export async function extractTextAsync(name, end = monotonicNow() + EXTRACT_BUDGET_MS) {
    const path = argPath(name);
    const ext = extname(path).toLowerCase();
    const mac = process.platform === "darwin";
    let text;
    let timedOut = false;
    const tryRun = async (cmd, args) => {
        if (text || timedOut)
            return;
        const r = await runAsync(cmd, args, end);
        if (r.timedOut)
            timedOut = true;
        else
            text = r.out;
    };
    const late = () => ({ error: "not read: the time allowed for reading documents in this call ran out" });
    if (ext === ".pdf") {
        await tryRun("pdftotext", ["-enc", "UTF-8", path, "-"]);
        await tryRun("pdftotext", [path, "-"]);
        if (!text && !timedOut) {
            const out = join(mkdtempSync(join(tmpdir(), "cd-pdf-")), "out.txt");
            try {
                const r = await runAsync("pdftotext", [path, out], end);
                if (r.timedOut)
                    timedOut = true;
                else if (existsSync(out))
                    text = readFileSync(out, "utf8").trim() ? readFileSync(out, "utf8") : undefined;
            }
            finally {
                rmSync(dirname(out), { recursive: true, force: true });
            }
        }
        text = text?.replace(/\f/g, "\n\n");
        if (!text && mac)
            await tryRun("osascript", ["-l", "JavaScript", "-e", PDFKIT_JXA, path]);
        if (!text) {
            if (timedOut)
                return late();
            return { error: mac ? "no text layer (scanned PDF?) or unreadable" : "needs pdftotext (install poppler-utils), or the PDF has no text layer" };
        }
        return { text };
    }
    if (mac && ext !== ".pptx")
        await tryRun("textutil", [...TEXTUTIL_ARGS, path]);
    if (!text && !timedOut) {
        const members = ext === ".docx" ? ["word/document.xml"] : ext === ".pptx" ? ["ppt/slides/*.xml"] : ext === ".odt" ? ["content.xml"] : [];
        if (members.length) {
            const r = await runAsync("unzip", ["-p", path, ...members], end);
            if (r.timedOut)
                timedOut = true;
            else if (r.out)
                text = xmlToText(r.out);
        }
    }
    if (!text) {
        if (timedOut)
            return late();
        return { error: mac ? "unreadable document" : `needs unzip${ext === ".doc" || ext === ".rtf" ? " (and .doc/.rtf need macOS textutil; save as .docx)" : ""}` };
    }
    return { text };
}
