/**
 * ChatGPT file inputs for pack_context over --http.
 *
 * A tool that lists a top-level field in `_meta["openai/fileParams"]` receives
 * a file the user uploaded as `{ download_url, file_id, mime_type?, file_name? }`
 * (developers.openai.com/apps-sdk/reference, "Define file inputs"; every file
 * object schema must declare all four properties and require only
 * download_url and file_id). The server downloads it and packs it like a
 * file read from disk, so a 200-page PDF reaches the model as the few chunks a
 * question needs.
 *
 * A URL from a caller is an SSRF risk on a server anyone with the tunnel URL
 * can reach, so a download is: https only (redirects too, at most three,
 * never to http), never to a private, loopback or link-local address (checked
 * on the resolved address at connect time, so DNS cannot point it inward),
 * no credentials in the URL, capped in size and time. Plain http to a
 * loopback address is allowed only when CONTEXT_DOCTOR_TEST_LOOPBACK_FILES=1,
 * for the tests' local mock server.
 */
import type { PackSource } from "./pack.js";
export interface OpenAiFile {
    download_url: string;
    file_id: string;
    mime_type?: string;
    file_name?: string;
}
export declare const FILE_LIMITS: {
    files: number;
    bytes: number;
    totalBytes: number;
    timeoutMs: number;
    redirects: number;
};
/** Loopback, private, link-local, CGNAT, unspecified, multicast or reserved: never a place a download should go. */
export declare function isPrivateAddress(ip: string): boolean;
/** A download URL this server may fetch, or the reason it may not. */
export declare function checkFileUrl(raw: string, env?: NodeJS.ProcessEnv): {
    url: URL;
} | {
    error: string;
};
/** Download one file, following at most FILE_LIMITS.redirects https redirects. */
export declare function downloadFile(raw: string, env?: NodeJS.ProcessEnv): Promise<{
    body: Buffer;
} | {
    error: string;
}>;
/** Download and read files ChatGPT passed, into pack sources. Never throws. */
export declare function sourcesFromOpenAiFiles(files: OpenAiFile[], env?: NodeJS.ProcessEnv): Promise<{
    sources: PackSource[];
    skipped: string[];
}>;
