/**
 * ChatGPT file inputs for pack_context over --http.
 *
 * A tool that lists a top-level field in `_meta["openai/fileParams"]` receives
 * a file the user uploaded as `{ download_url, file_id, mime_type?, file_name? }`
 * (developers.openai.com/plugins/reference, "Define file inputs"; every file
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

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { PackSource } from "./pack.js";
import { EXTRACTABLE, extractText } from "./extract.js";

export interface OpenAiFile {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export const FILE_LIMITS = { files: 10, bytes: 5 * 1024 * 1024, totalBytes: 20 * 1024 * 1024, timeoutMs: 20_000, redirects: 3 };

const MIME_EXT: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/msword": ".doc",
  "application/rtf": ".rtf",
  "text/rtf": ".rtf",
  "application/vnd.oasis.opendocument.text": ".odt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

function loopbackAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTEXT_DOCTOR_TEST_LOOPBACK_FILES === "1";
}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

/**
 * The eight 16-bit groups of an IPv6 address, a dotted IPv4 tail included,
 * or undefined. Needed because one address has many spellings: the URL
 * parser writes [::ffff:127.0.0.1] as [::ffff:7f00:1], which a pattern for
 * the dotted form lets through to the loopback interface.
 */
function hextets(ip: string): number[] | undefined {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4[1].split(".").map(Number);
    s = s.slice(0, -v4[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = s.includes("::") ? 8 - h.length - t.length : 0;
  const all = [...h, ...Array(Math.max(0, fill)).fill("0"), ...t].map((x) => parseInt(x || "0", 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : undefined;
}

/** Loopback, private, link-local, CGNAT, unspecified, multicast or reserved: never a place a download should go. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const v = isIP(bare);
  if (v === 4) return isPrivateV4(bare);
  if (v === 6) {
    const g = hextets(bare);
    if (!g) return true;
    // ::, ::1, IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 inside.
    if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) {
      if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return true;
      return isPrivateV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    }
    if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64: whatever IPv4 it carries
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7, unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10, link-local
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard
    return false;
  }
  return true; // not an address at all: refuse
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

/** A download URL this server may fetch, or the reason it may not. */
export function checkFileUrl(raw: string, env: NodeJS.ProcessEnv = process.env): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "not a URL" };
  }
  if (url.username || url.password) return { error: "credentials in the URL" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const testLoopback = loopbackAllowed(env) && isLoopback(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && testLoopback)) return { error: `only https downloads are allowed (got ${url.protocol.replace(":", "")})` };
  if (testLoopback) return { url };
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) return { error: "a local host name" };
  if (isIP(host) && isPrivateAddress(host)) return { error: "a private or loopback address" };
  return { url };
}

/**
 * dns.lookup that refuses private addresses, used as the socket's lookup so
 * the address checked is the address connected to. Node 20+ asks with
 * `all: true` (happy eyeballs), older paths with a single address.
 */
function guardedLookup(allowLoopback: boolean) {
  return (hostname: string, options: object, callback: (...a: any[]) => void): void => {
    dnsLookup(hostname, options as any, (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => {
      if (err) return callback(err);
      const list = Array.isArray(address) ? address : [{ address, family: family ?? 4 }];
      const bad = list.find((a) => isPrivateAddress(a.address) && !(allowLoopback && isLoopback(a.address)));
      if (bad) return callback(Object.assign(new Error(`${hostname} resolves to a private address`), { code: "EPRIVATE" }));
      if (Array.isArray(address)) callback(null, address);
      else callback(null, address, family);
    });
  };
}

function getOnce(url: URL, env: NodeJS.ProcessEnv, deadline: number): Promise<{ status: number; location?: string; body?: Buffer; error?: string }> {
  return new Promise((resolve) => {
    const allowLoopback = loopbackAllowed(env) && isLoopback(url.hostname);
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    let settled = false;
    const done = (r: { status: number; location?: string; body?: Buffer; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      resolve(r);
    };
    const timeout = Math.max(1, deadline - Date.now());
    // The socket timeout is an idle timeout; a server dripping a byte at a
    // time would never trip it. This one bounds the whole download.
    const overall = setTimeout(() => {
      req.destroy();
      done({ status: 0, error: `timed out after ${Math.round(FILE_LIMITS.timeoutMs / 1000)} s` });
    }, timeout);
    const req = request(url, { method: "GET", lookup: guardedLookup(allowLoopback) as any, timeout, headers: { accept: "*/*", "user-agent": "context-doctor" } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return done({ status, location: typeof res.headers.location === "string" ? res.headers.location : undefined });
      }
      if (status !== 200) {
        res.resume();
        return done({ status, error: `HTTP ${status}` });
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > FILE_LIMITS.bytes) {
        req.destroy();
        return done({ status, error: `too large (${Math.round(declared / 1024)} KB; the limit is ${FILE_LIMITS.bytes / 1024 / 1024} MB)` });
      }
      const parts: Buffer[] = [];
      let size = 0;
      res.on("data", (d: Buffer) => {
        size += d.length;
        if (size > FILE_LIMITS.bytes) {
          req.destroy();
          done({ status, error: `too large (over ${FILE_LIMITS.bytes / 1024 / 1024} MB)` });
          return;
        }
        parts.push(d);
      });
      res.on("end", () => done({ status, body: Buffer.concat(parts) }));
      res.on("error", (e) => done({ status, error: e.message }));
    });
    req.on("timeout", () => {
      req.destroy();
      done({ status: 0, error: `timed out after ${Math.round(FILE_LIMITS.timeoutMs / 1000)} s` });
    });
    req.on("error", (e: NodeJS.ErrnoException) => done({ status: 0, error: e.code === "EPRIVATE" ? "refused: the host resolves to a private address" : e.message }));
    req.end();
  });
}

/** Download one file, following at most FILE_LIMITS.redirects https redirects. */
export async function downloadFile(raw: string, env: NodeJS.ProcessEnv = process.env): Promise<{ body: Buffer } | { error: string }> {
  const deadline = Date.now() + FILE_LIMITS.timeoutMs;
  let current = raw;
  for (let hop = 0; hop <= FILE_LIMITS.redirects; hop++) {
    const checked = checkFileUrl(current, env);
    if ("error" in checked) return { error: hop === 0 ? `refused: ${checked.error}` : `refused a redirect: ${checked.error}` };
    const r = await getOnce(checked.url, env, deadline);
    if (r.error) return { error: r.error };
    if (r.location !== undefined) {
      if (!r.location) return { error: `HTTP ${r.status} without a location` };
      current = new URL(r.location, checked.url).toString();
      continue;
    }
    return { body: r.body ?? Buffer.alloc(0) };
  }
  return { error: `more than ${FILE_LIMITS.redirects} redirects` };
}

/** A name for chunk ids: the file's own name without any path, or its id. */
function safeName(f: OpenAiFile): string {
  const base = (f.file_name ?? "").split(/[\\/]/).pop()?.replace(/[^\w.\- ]+/g, "_").trim();
  return (base || String(f.file_id || "file").replace(/[^\w.-]+/g, "_")).slice(0, 80);
}

/** Download and read files ChatGPT passed, into pack sources. Never throws. */
export async function sourcesFromOpenAiFiles(files: OpenAiFile[], env: NodeJS.ProcessEnv = process.env): Promise<{ sources: PackSource[]; skipped: string[] }> {
  const sources: PackSource[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const f of files.slice(0, FILE_LIMITS.files)) {
    const name = safeName(f);
    const got = await downloadFile(String(f.download_url ?? ""), env);
    if ("error" in got) {
      skipped.push(`${name}: ${got.error}`);
      continue;
    }
    total += got.body.length;
    if (total > FILE_LIMITS.totalBytes) {
      skipped.push(`${name}: over the ${FILE_LIMITS.totalBytes / 1024 / 1024} MB total for one call`);
      continue;
    }
    const ext = extname(name).toLowerCase();
    const docExt = EXTRACTABLE.has(ext) ? ext : MIME_EXT[(f.mime_type ?? "").split(";")[0].trim().toLowerCase()];
    if (docExt) {
      // The extractors work on files: write it to a private temp folder, read, remove.
      const dir = mkdtempSync(join(tmpdir(), "cd-file-"));
      try {
        const path = join(dir, `upload${docExt}`);
        writeFileSync(path, got.body, { mode: 0o600 });
        const text = extractText(path);
        if ("error" in text) skipped.push(`${name}: ${text.error}`);
        else sources.push({ name, text: text.text });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      continue;
    }
    if (got.body.subarray(0, 8000).includes(0)) {
      skipped.push(`${name}: binary (pack reads text, PDF and Word/PowerPoint/ODT files)`);
      continue;
    }
    sources.push({ name, text: got.body.toString("utf8") });
  }
  if (files.length > FILE_LIMITS.files) skipped.push(`${files.length - FILE_LIMITS.files} more file(s): at most ${FILE_LIMITS.files} per call`);
  return { sources, skipped };
}
