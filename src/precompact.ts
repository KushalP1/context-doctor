/**
 * PreCompact: tell Claude Code's compaction what this session cannot lose.
 *
 * A compaction replaces the session's history with a summary written by the
 * model, guided by generic instructions. Whatever a PreCompact hook prints is
 * added to those instructions (Claude Code merges it as custom instructions,
 * for automatic and manual compactions alike; checked in 2.1.295). So the
 * summary can be told, from the transcript itself, which files were changed,
 * what is still open, what the user insisted on, and which commands are still
 * failing: the things whose loss makes a session re-read, re-ask and repeat
 * mistakes after compacting. Facts only, short, and nothing invented: every
 * line comes from the transcript.
 */

import { forEachLine } from "./session.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** A user line that sets a rule or corrects course. */
const DIRECTIVE = /\b(don'?t|do not|never|always|instead|make sure|must|should not|shouldn'?t|stop|wrong|not what|revert|undo|keep|prefer|use )\b/i;
const MAX_CHARS = 2400;
/** Build, test and lint runs: the commands whose failure is state worth keeping (not a grep that found nothing). */
const CHECK_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check)\b|\b(pytest|tox|cargo\s+(test|build|check|clippy)|go\s+(test|build|vet)|make(\s+\w+)?|tsc|eslint|ruff|mypy|gradle\w*\s+\w+|mvn\s+\w+|swift\s+(build|test)|xcodebuild|dotnet\s+(build|test)|jest|vitest|phpunit|rspec)\b/;

/** What kind of check a command runs ("npm test", "pytest", "cargo build"): a later success of the same kind clears an earlier failure. */
function checkKind(cmd: string): string | undefined {
  return CHECK_COMMAND.exec(cmd)?.[0].replace(/\s+run\s+/, " ").replace(/\s+/g, " ");
}

export interface CompactFacts {
  edited: string[];
  todos: string[];
  directives: string[];
  failing: string[];
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** Facts from the session since the last compaction (the summary before it already carries the earlier ones). */
export function compactFacts(transcriptPath: string): CompactFacts {
  const edited: string[] = [];
  let todos: string[] = [];
  const directives: string[] = [];
  const commands = new Map<string, { cmd: string; kind: string }>(); // tool_use id -> a build/test/lint command
  const failing = new Map<string, string>(); // kind -> "command → last error line", removed when that kind later succeeds
  forEachLine(transcriptPath, (line) => {
    let e: any;
    try { e = JSON.parse(line); } catch { return; }
    if (!e || e.isSidechain) return;
    if (e.type === "system" && e.subtype === "compact_boundary") {
      edited.length = 0; todos = []; directives.length = 0; commands.clear(); failing.clear();
      return;
    }
    const c = e.message?.content;
    if (e.type === "assistant" && Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== "tool_use") continue;
        const path = b.input?.file_path ?? b.input?.notebook_path;
        if (EDIT_TOOLS.has(b.name) && typeof path === "string") {
          const i = edited.indexOf(path);
          if (i >= 0) edited.splice(i, 1);
          edited.push(path);
        } else if (b.name === "TodoWrite" && Array.isArray(b.input?.todos)) {
          todos = b.input.todos.filter((t: any) => t?.status !== "completed").map((t: any) => `${t.status === "in_progress" ? "[in progress] " : ""}${clip(String(t.content ?? ""), 140)}`);
        } else if (b.name === "Bash" && typeof b.input?.command === "string") {
          const kind = checkKind(b.input.command);
          if (kind) commands.set(b.id, { cmd: clip(b.input.command, 120), kind });
        }
      }
    } else if (e.type === "user") {
      if (typeof c === "string" && !e.isMeta && !e.isCompactSummary) {
        const text = c.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ").trim();
        if (text && text.length < 2000 && DIRECTIVE.test(text)) directives.push(clip(text, 200));
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type !== "tool_result" || !commands.has(b.tool_use_id)) continue;
          const { cmd, kind } = commands.get(b.tool_use_id)!;
          if (b.is_error) {
            const out = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
            failing.set(kind, `${cmd} → ${clip((out.split("\n").find((l: string) => /error|exception/i.test(l)) ?? out.split("\n").find((l: string) => /fail/i.test(l)) ?? out.split("\n")[0] ?? ""), 160)}`);
          } else {
            failing.delete(kind);
          }
        }
      }
    }
  });
  return { edited: edited.slice(-25).reverse(), todos: todos.slice(0, 15), directives: directives.slice(-8), failing: [...failing.values()].slice(-5) };
}

/** The custom instructions a PreCompact hook prints; empty when the transcript holds nothing to pin. */
export function compactInstructions(f: CompactFacts): string {
  const sections: string[] = [];
  const list = (title: string, items: string[]) => items.length && sections.push(`${title}:\n${items.map((i) => `- ${i}`).join("\n")}`);
  list("Files changed in this session (keep every path exactly)", f.edited);
  list("Open tasks (keep them, with their status)", f.todos);
  list("The user's own instructions and corrections (keep their substance, they still apply)", f.directives);
  list("Commands still failing at this point (keep the command and the error)", f.failing);
  if (!sections.length) return "";
  let out = [
    "context-doctor, from this session's transcript: the summary must carry the following, so the work continues without re-reading files, re-asking the user, or repeating a failed approach.",
    ...sections,
    "Keep exact identifiers (paths, function names, commands, versions, IDs, URLs). Leave out raw tool output already acted on; one line on what it showed is enough.",
  ].join("\n\n");
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS - 1) + "…";
  return out;
}
