/**
 * Codex's spawned agents bill to the thread that spawned them. Their
 * rollouts name it in their own (first) session_meta: `parent_thread_id`,
 * and `source.subagent.thread_spawn.parent_thread_id` (Codex Desktop 0.146
 * on the author's machine). A forked one starts with a copy of its parent's
 * history, session_meta rows and token_count events included, counted once
 * (codexEventKey). A thread the user forked names only `forked_from_id`: a
 * session of its own. On a parent, a forked spawned agent, a fresh one and a
 * user fork, the session price equals `spend`'s figure for that session.
 */
export {};
