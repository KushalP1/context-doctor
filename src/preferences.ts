/**
 * Standing context rules for chat apps that have no hook and, on phones and the
 * web, no MCP server either: claude.ai "personal preferences" and ChatGPT
 * "custom instructions" are read on every turn of every chat, which is the
 * closest thing those surfaces have to a UserPromptSubmit hook.
 *
 * Kept short (~90 tokens): it rides in every conversation.
 */

import { spawnSync } from "node:child_process";

export const CHAT_PREFERENCES = [
  "Context hygiene: when I paste something long, summarize it into the points you will use and work from the summary;",
  "do not carry it verbatim or re-quote it later, refer to it by name. Never inline base64.",
  "Past ~30 turns, or when I ask about tokens, limits, cost or speed: if a profile_context tool is available,",
  "call it with a sketch before answering and act on its top finding; otherwise offer me a 300-token handoff",
  "summary (decisions, current state, open items) to start a fresh chat.",
].join(" ");

/** Where to paste, per app. Paths are the UI labels, not URLs, so they survive redesigns. */
export const PREFERENCE_TARGETS = [
  "claude.ai / Claude Desktop / Claude mobile: Settings > Profile > \"What personal preferences should Claude consider in responses?\"",
  "ChatGPT: Settings > Personalization > Custom instructions > \"How would you like ChatGPT to respond?\"",
];

/** Copy text to the system clipboard; false when no clipboard tool is available. */
export function copyToClipboard(text: string, platform: NodeJS.Platform = process.platform): boolean {
  const candidates: Array<[string, string[]]> =
    platform === "darwin" ? [["pbcopy", []]]
    : platform === "win32" ? [["clip", []]]
    : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  for (const [cmd, args] of candidates) {
    const r = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

export function renderPreferences(copied: boolean | undefined): string {
  const lines = [
    "Paste this into your chat app's standing preferences. It applies to every chat, including on your phone:",
    "",
    CHAT_PREFERENCES,
    "",
    ...PREFERENCE_TARGETS.map((t) => `  ${t}`),
  ];
  if (copied === true) lines.push("", "Copied to the clipboard.");
  if (copied === false) lines.push("", "No clipboard tool found; copy the text above by hand.");
  return lines.join("\n");
}
