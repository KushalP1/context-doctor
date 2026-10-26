/**
 * Standing context rules for chat apps that have no hook and, on phones and the
 * web, no MCP server either: claude.ai "personal preferences" and ChatGPT
 * "custom instructions" are read on every turn of every chat, which is the
 * closest thing those surfaces have to a UserPromptSubmit hook.
 *
 * Kept short (~190 Claude tokens, ~125 GPT): it rides in every conversation.
 * The handoff is the one real cut a chat app allows: its history cannot be
 * edited, so a long chat continues in a new one from a short brief.
 */
import { spawnSync } from "node:child_process";
export const CHAT_PREFERENCES = [
    "Context hygiene: summarize anything long I paste into the points you will use; refer to it by name, never re-quote it,",
    "never inline base64. When I ask about tokens, limits, cost or speed, and once past ~30 turns: if profile_context exists,",
    "call it with a sketch and act on its top finding. When a chat grows long, offer a handoff once (its history cannot",
    "be trimmed): a 400-token brief of goal, decisions, state and open items, plus what must stay exact, saved with",
    "save_handoff if it exists, to start a new chat.",
].join(" ");
/** Where to paste, per app. Paths are the UI labels, not URLs, so they survive redesigns. */
export const PREFERENCE_TARGETS = [
    "claude.ai / Claude Desktop / Claude mobile: Settings > General > \"What personal preferences should Claude consider in responses?\"",
    "ChatGPT: Settings > Personalization > Custom instructions > \"What traits should ChatGPT have?\"",
];
/** Copy text to the system clipboard; false when no clipboard tool is available. */
export function copyToClipboard(text, platform = process.platform) {
    const candidates = platform === "darwin" ? [["pbcopy", []]]
        : platform === "win32" ? [["clip", []]]
            : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
    for (const [cmd, args] of candidates) {
        const r = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
        if (!r.error && r.status === 0)
            return true;
    }
    return false;
}
export function renderPreferences(copied) {
    const lines = [
        "Paste this into your chat app's standing preferences. It applies to every chat, including on your phone:",
        "",
        CHAT_PREFERENCES,
        "",
        ...PREFERENCE_TARGETS.map((t) => `  ${t}`),
    ];
    if (copied === true)
        lines.push("", "Copied to the clipboard.");
    if (copied === false)
        lines.push("", "No clipboard tool found; copy the text above by hand.");
    return lines.join("\n");
}
