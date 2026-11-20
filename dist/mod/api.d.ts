/**
 * The part of Claude Code's mods API the context-doctor mod uses, typed here
 * so the mod compiles with the rest of the package (the engine's own
 * declarations, `claude-code`, exist only inside a mod folder Claude Code
 * writes types into). Each name and shape below was read from the
 * declarations Claude Code 2.1.321 writes (`claude-code.d.ts`): `$.process.run`,
 * `$.session.{id,model,compact}`, `$.ui.{open,resolve,invalidate,toast}`,
 * `$.command.register`, `$.clock.{now,every}`, `$.env.get`, `$.plugin.root`,
 * `$.model.fork` (from the GitHub copy of the declarations, 2026-11-15),
 * and the events `session.start`, `session.measure`, `session.end`,
 * `command.run`, `ui.render`; from 2.1.325's, for the usage pane,
 * `$.agent.list`, `$.session.usage`, the `Svg` element, a pane's `placement`
 * and `bodyColumns`, and `ui.close`; from 2.1.329's, `tool.describe` with
 * its `mcpServer` and an answer's `isDeferred`. A subset, structurally compatible: no
 * runtime code.
 */
export type Surface = "terminal" | "desktop" | "vscode" | "mobile";
export interface RateLimit {
    kind: string;
    percentUsed: number;
    resetsAt?: string;
}
export interface MeasureEvent {
    context: {
        tokens?: number;
        window: number;
        percent?: number;
    };
    rateLimits: RateLimit[];
    cost?: {
        usd: number;
    };
    changed: string[];
}
export interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
export type Element = unknown;
export type Ctor = (props: Record<string, unknown>) => Element;
export interface RenderEvent {
    component: string;
    surface: Surface;
    requestId?: string;
    props: {
        hasSurvey?: boolean;
        isWorking?: boolean;
        isCollapsed?: boolean;
        bodyColumns?: number;
        title?: string;
        isFocused?: boolean;
        placement?: "dock" | "inline" | "widget" | string;
    };
}
/** What `$.model.fork` resolves to: the reply and its usage, or why there is none (`nothing-to-fork`, `api-error`, `empty-reply`, `aborted`). */
export type ForkResult = {
    isAnswered: true;
    text: string;
    usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
    };
} | {
    isAnswered: false;
    reason: string;
    status?: number;
    usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
    };
};
/** One agent loop as `$.agent.list()` answers it (the fields the usage pane reads). */
export interface AgentInfo {
    id: string;
    type: string;
    description: string;
    status: string;
    name?: string;
    parentId?: string;
    teammateId?: string;
}
/** `$.session.usage()`: Claude Code's own figures, as `session.measure` pushes them. */
export interface SessionUsage {
    startedAt: number;
    context: MeasureEvent["context"];
    rateLimits: RateLimit[];
    cost?: {
        usd: number;
    };
}
export interface Engine {
    plugin: {
        name: string;
        root: string;
    };
    process: {
        run: (argv: readonly string[], init?: {
            cwd?: string;
            env?: Record<string, string>;
            stdin?: string;
            timeoutMs?: number;
        }) => Promise<RunResult>;
    };
    session: {
        id: () => Promise<string>;
        model: () => Promise<string>;
        cwd: () => Promise<string>;
        compact: (input?: {
            instructions?: string;
        }) => Promise<{
            skip?: string;
        }>;
        usage: () => Promise<SessionUsage>;
    };
    /** 2.1.325 has it; the usage pane says so where an older engine has not. */
    agent: {
        list: () => Promise<AgentInfo[]>;
    };
    ui: {
        open: (pane: {
            id: string;
            title?: string;
        }) => Promise<{
            isPlaced: boolean;
        }>;
        /** The engine's is generic per surface (each has its own table); the mod passes the render event it got. */
        resolve: (e: any) => Record<"Box" | "Text" | "Button", Ctor> & {
            Svg?: Ctor;
        };
        invalidate: (event: "ui.render") => void;
        toast: (text: string, options?: {
            timeoutMs?: number;
        }) => void;
    };
    command: {
        register: (spec: {
            name: string;
            description: string;
            argumentHint?: string;
        }) => Promise<unknown>;
    };
    /**
     * `$.model.fork` (claude-code.d.ts, mods/types on GitHub, read 2026-11-15):
     * the main thread's last request again (its model, system prompt, tools,
     * messages) with `prompt` after it, tools denied, its own tail never
     * cached, nothing written to the transcript. An engine without it throws a TypeError at the call (a module may not test for it: validate refuses `$.model` read as a value).
     */
    model: {
        fork: (request: {
            prompt: string;
        }) => Promise<ForkResult>;
    };
    clock: {
        now: () => Promise<number>;
        every: (ms: number, fn: () => void) => {
            cancel: () => void;
        };
    };
    env: {
        get: (name: string) => Promise<string | undefined>;
    };
}
export type Next<E, R> = (e: E) => Promise<R>;
export type Hook<E, R> = ($: Engine, e: E, next: Next<E, R>) => R | Promise<R>;
/** `on(event, matcher?, hook)`: the overloads the mod uses. */
export interface On {
    (event: "session.start", hook: Hook<{
        cwd: string;
        surface: Surface | null;
        isInteractive: boolean;
    }, {
        cwd: string;
    }>): unknown;
    (event: "session.measure", hook: Hook<MeasureEvent, {
        changed: string[];
    }>): unknown;
    (event: "session.end", hook: Hook<{
        reason: string;
        sessionId: string;
    }, {
        sessionId: string;
    }>): unknown;
    (event: "command.run", matcher: {
        command: string;
    }, hook: Hook<{
        command: string;
        args?: string;
    }, {
        text: string;
    }>): unknown;
    (event: "ui.render", matcher: {
        component: string;
        requestId?: string;
    }, hook: Hook<RenderEvent, Element>): unknown;
    (event: "ui.close", hook: Hook<{
        id: string;
        origin: {
            kind: string;
        };
    }, unknown>): unknown;
    (event: "tool.describe", hook: Hook<ToolDescribeInput, ToolDescribeResult>): unknown;
}
/**
 * `tool.describe` (2.1.323+; `mcpServer` and an answer's `isDeferred` from
 * 2.1.326, read in 2.1.329's declarations): one tool's description the first
 * time the engine renders its schema in a session. `isDeferred: true` on the
 * answer puts the tool behind ToolSearch from the next new thread or `/clear`;
 * `breakPromptCache` would send it at the next turn by re-writing the whole
 * prompt cache, which the mod never asks for.
 */
export interface ToolDescribeInput {
    tool: string;
    description: string;
    isDeferred?: true;
    provider?: unknown;
    mcpServer?: {
        type: "stdio" | "http" | "sse" | "ws" | "sdk" | "sse-ide" | "ws-ide" | "claudeai-proxy" | string;
        origin?: string;
        connectorId?: string;
    };
}
export interface ToolDescribeResult {
    description: string;
    isDeferred?: boolean;
    breakPromptCache?: boolean;
}
