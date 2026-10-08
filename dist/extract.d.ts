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
export declare const EXTRACTABLE: Set<string>;
/** The document's text, or the reason it could not be read. */
export declare function extractText(path: string): {
    text: string;
} | {
    error: string;
};
