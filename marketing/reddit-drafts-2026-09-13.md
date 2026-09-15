# Reddit drafts, 2026-09-13 (approved by KP, not yet posted)

## 1. r/mcp modmail  (https://old.reddit.com/message/compose?to=%2Fr%2Fmcp)

Title: Showcase post caught by the site-wide filter

Hi mods, my showcase post (https://www.reddit.com/r/mcp/comments/1webv5u/) was removed by Reddit's spam filter, not by a mod action as far as I can tell. It is an MIT MCP server, disclosed as mine in the first line, showcase flair applied. Happy to change anything that does not fit the sub. If it is fine as is, would you approve it from the queue? Thanks.

## 2. r/ClaudeCode post  (https://old.reddit.com/r/ClaudeCode/submit?selftext=true, flair: Built with Claude Code)

Title: Built with Claude Code: a local profiler for Claude Code transcripts. What I measured across 42 sessions and the one number I got wrong

**What:** context-doctor, a CLI + MCP server that reads the JSONL transcripts in ~/.claude/projects and shows what is actually sitting in the live context: which tool calls, which results, how much is duplicated, where the prefix cache got invalidated. No API key, nothing leaves the machine. `npx -y context-doctor session`.

**How:** TypeScript, two deps (MCP SDK, zod). Token counting is a chars per token heuristic (3.2 for code, 4.0 for prose) so it runs offline. Built almost entirely in Claude Code over about a month; the transcripts it profiles are the ones it was built in.

**What I learned, in order of how much it surprised me:**

1. My counter looked about 55% low against what Claude Code billed. I spent a day assuming the heuristic was bad. It was not. The transcript on disk only covers roughly 39% of the per turn billed growth. There is a ~51k token baseline before your first message (system prompt, tool schemas, skills) plus about 700 tokens a turn of injected content that never gets written to the file. Anything that profiles transcripts alone is measuring a minority of the bill.

2. Tool calls, not tool results, are the biggest drain in file heavy sessions. A Write or a heredoc puts the whole file in permanently. 65% of one 292k session was tool calls, 22% was results.

3. Shell reads (cat, head, tail) dodge anything that only counts Read tool calls. 16 instances across 6 sessions.

4. Pruning that moves the boundary every turn kills the prefix cache: 22 of 24 turns invalidated with a sliding window, 8 of 24 when I held the boundary and moved it in steps.

One machine, 42 sessions, so a sample, not a study. Would be interested if anyone's split looks different.

Disclosure: I built it. MIT. https://github.com/KushalP1/context-doctor
