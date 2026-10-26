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
export declare const EXTRACTABLE: Set<string>;
/** Never load or write a document's subsidiary resources (stylesheets, images, frames). */
export declare const TEXTUTIL_ARGS: string[];
/** The document's text, or the reason it could not be read. */
export declare function extractText(path: string): {
    text: string;
} | {
    error: string;
};
/** Default time budget for one extraction call in the MCP server. */
export declare const EXTRACT_BUDGET_MS = 20000;
/**
 * extractText for a server: asynchronous, and bounded by `deadline` (ms since
 * the epoch) across every tool it tries. Past the deadline the reason says so.
 */
export declare function extractTextAsync(path: string, deadline?: number): Promise<{
    text: string;
} | {
    error: string;
}>;
