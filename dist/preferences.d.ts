/**
 * Standing context rules for chat apps that have no hook and, on phones and the
 * web, no MCP server either: claude.ai "personal preferences" and ChatGPT
 * "custom instructions" are read on every turn of every chat, which is the
 * closest thing those surfaces have to a UserPromptSubmit hook.
 *
 * Kept short (~180 Claude tokens, ~120 GPT): it rides in every conversation.
 */
export declare const CHAT_PREFERENCES: string;
/** Where to paste, per app. Paths are the UI labels, not URLs, so they survive redesigns. */
export declare const PREFERENCE_TARGETS: string[];
/** Copy text to the system clipboard; false when no clipboard tool is available. */
export declare function copyToClipboard(text: string, platform?: NodeJS.Platform): boolean;
export declare function renderPreferences(copied: boolean | undefined): string;
