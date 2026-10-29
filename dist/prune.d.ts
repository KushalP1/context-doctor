/**
 * `context-doctor overhead prune`: MCP servers and skills a project has not
 * used in N days, switched off for that project only.
 *
 * Every MCP server's tool definitions (or, with tool search, their names)
 * and every skill's name and description ride in each request of every
 * session, used or not ("33k tokens before reading the prompt"). The
 * transcripts say what each project actually calls: MCP tools are
 * `mcp__<server>__<tool>`, skills are the `Skill` tool (`{skill}`) or a
 * typed `/<name>`. The plan lists, per project with enough sessions, the
 * configured servers and installed skills with no use in the period; with
 * `--write` they are switched off for the current folder's project, in its
 * own `.claude/settings.local.json` (a backup kept, each entry recorded so
 * `--undo` takes exactly those out again):
 *
 *  - a server from the project's `.mcp.json`: `disabledMcpjsonServers`;
 *  - a server from ~/.claude.json (user or local scope): `deniedMcpServers`
 *    `{serverName}` (settings-reference: entries from every settings file
 *    merge; it shows as blocked in /mcp until the entry is removed);
 *  - a personal or project skill: `skillOverrides` `"off"` (Claude Code
 *    2.1.129+; older versions ignore the key).
 *
 * Never touched: anything the app provides (claude.ai connectors, the
 * desktop app's own servers, plugin servers and skills), which no config
 * file here lists, and context-doctor's own server, whose standing rules
 * work without a single call. Verified against the settings reference and
 * the 2.1.308 binary (disabledMcpjsonServers, deniedMcpServers merged from
 * every settings file, skillOverrides).
 */
import { type Extractor } from "./scan.js";
import { type McpServerConfig } from "./mcpschema.js";
/** A folder as one spelling: /var and /private/var (macOS) or a symlinked checkout are the same project. */
export declare function canonical(p: string): string;
/** Fewer sessions than this in the period say too little about what a project uses. */
export declare const MIN_SESSIONS = 3;
export interface ProjectUse {
    cwd: string;
    sessions: number;
    /** MCP uses by full name: tools (mcp__server__tool) and prompts run as slash commands. */
    mcpNames: Map<string, number>;
    /** MCP resource-tool uses by their `server` input. */
    mcpResources: Map<string, number>;
    /** Skill uses by name (the part after a plugin's "plugin:" prefix too). */
    skillUses: Map<string, number>;
}
export declare const PRUNE_ROWS: Extractor<{
    cwd: boolean;
}>;
/** What each project (by the `cwd` its sessions record) used in the last `days`, subagents included. */
export declare function projectUsage(days?: number, paths?: string[], now?: number): Map<string, ProjectUse>;
export interface SkillInfo {
    name: string;
    scope: "personal" | "project";
    /** Tokens of its listing (name and description) in every request. */
    tokens: number;
}
/** Skills Claude Code lists in `cwd`: ~/.claude/skills and <cwd>/.claude/skills (not plugins'). */
export declare function installedSkills(cwd: string, home?: string): SkillInfo[];
export interface PruneItem {
    kind: "mcp" | "skill";
    name: string;
    scope: McpServerConfig["scope"] | SkillInfo["scope"];
    /** The settings entry that switches it off for this project. */
    entry: "disabledMcpjsonServers" | "deniedMcpServers" | "skillOverrides";
    tokens?: number;
}
export interface ProjectPlan {
    cwd: string;
    sessions: number;
    unused: PruneItem[];
    /** Configured or installed, and used: name and uses. */
    used: Array<{
        kind: "mcp" | "skill";
        name: string;
        uses: number;
    }>;
    /** Too few sessions to judge. */
    thin: boolean;
    /** Already switched off here by an earlier prune (or by hand). */
    alreadyOff: string[];
}
export interface PrunePlan {
    days: number;
    plans: ProjectPlan[];
}
/** The project's own settings file, where prune writes. */
export declare function localSettingsPath(cwd: string): string;
export declare function planPrune(days?: number, opts?: {
    home?: string;
    usage?: Map<string, ProjectUse>;
    cwds?: string[];
    minSessions?: number;
}): PrunePlan;
/** Where `--write` records what it added, for `--undo`. */
export declare function pruneRecordPath(): string;
interface Added {
    disabledMcpjsonServers: string[];
    deniedMcpServers: string[];
    skillOverrides: string[];
}
/**
 * Switch the plan's unused servers and skills off in the project's
 * `.claude/settings.local.json`. The file's original is kept once as
 * `.context-doctor.backup`; every entry added is recorded for `--undo`.
 */
export declare function applyPrune(plan: ProjectPlan): {
    file: string;
    backup?: string;
    added: Added;
};
/** Take out exactly what `--write` added for this project (entries changed since by hand stay). */
export declare function undoPrune(cwd: string): {
    file: string;
    removed: string[];
} | undefined;
export declare function renderPrune(r: PrunePlan, current: string, opts?: {
    usdPerKPerMonth?: number;
    home?: string;
}): string;
export {};
