/**
 * Text out of PDFs and office documents, with tools the OS already has.
 *
 * Most big documents people paste into a chat are PDFs and Word files. pack
 * stays dependency-free, so this shells out to what is usually installed:
 * `pdftotext` (poppler) anywhere, PDFKit through `osascript` on macOS,
 * `textutil` for Word/RTF/ODT on macOS, and `unzip` for the zipped XML
 * formats (docx, pptx, odt) elsewhere. When none is available the caller
 * gets a reason that names what to install, never a silent skip.
 */
import { spawnSync } from "node:child_process";
import { extname } from "node:path";
export const EXTRACTABLE = new Set([".pdf", ".docx", ".doc", ".rtf", ".odt", ".pptx"]);
const RUN = { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 };
function run(cmd, args) {
    try {
        const r = spawnSync(cmd, args, RUN);
        return r.status === 0 && typeof r.stdout === "string" && r.stdout.trim() ? r.stdout : undefined;
    }
    catch {
        return undefined;
    }
}
const PDFKIT_JXA = 'ObjC.import("PDFKit"); function run(a) { const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(a[0])); return d.isNil() ? "" : d.string.js }';
/** Paragraph-ish text from zipped XML: one paragraph per closing p/slide-text tag, entities decoded. */
function fromZippedXml(path, members) {
    const xml = run("unzip", ["-p", path, ...members]);
    if (!xml)
        return undefined;
    return xml
        .replace(/<\/(w:p|a:p|text:p|text:h)>/g, "\n\n")
        .replace(/<(w:tab|w:br)\/>/g, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
/** The document's text, or the reason it could not be read. */
export function extractText(path) {
    const ext = extname(path).toLowerCase();
    const mac = process.platform === "darwin";
    let text;
    if (ext === ".pdf") {
        // Form feeds separate pages; as blank lines they become paragraph boundaries.
        text = run("pdftotext", ["-enc", "UTF-8", path, "-"])?.replace(/\f/g, "\n\n");
        if (!text && mac)
            text = run("osascript", ["-l", "JavaScript", "-e", PDFKIT_JXA, path]);
        if (!text) {
            return { error: mac ? "no text layer (scanned PDF?) or unreadable" : "needs pdftotext (install poppler-utils), or the PDF has no text layer" };
        }
    }
    else {
        if (mac && ext !== ".pptx")
            text = run("textutil", ["-convert", "txt", "-stdout", path]);
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
