/**
 * `diff` reads every input `session` reads. ChatGPT's conversations.json (and
 * Gemini chats) are .json, not .jsonl; read as a plain conversation they were
 * one message of raw text, so a 10-message export diffed as "5 → 5 tokens".
 */
export {};
