/**
 * The part of Claude Code's mods API the context-doctor mod uses, typed here
 * so the mod compiles with the rest of the package (the engine's own
 * declarations, `claude-code`, exist only inside a mod folder Claude Code
 * writes types into). Each name and shape below was read from the
 * declarations Claude Code 2.1.321 writes (`claude-code.d.ts`): `$.process.run`,
 * `$.session.{id,model,compact}`, `$.ui.{open,resolve,invalidate,toast}`,
 * `$.command.register`, `$.clock.{now,every}`, `$.env.get`, `$.plugin.root`,
 * and the events `session.start`, `session.measure`, `command.run`,
 * `ui.render`. A subset, structurally compatible: no runtime code.
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
    };
    ui: {
        open: (pane: {
            id: string;
            title?: string;
        }) => Promise<{
            isPlaced: boolean;
        }>;
        /** The engine's is generic per surface (each has its own table); the mod passes the render event it got. */
        resolve: (e: any) => Record<"Box" | "Text" | "Button", Ctor>;
        invalidate: (event: "ui.render") => void;
        toast: (text: string, options?: {
            timeoutMs?: number;
        }) => void;
    };
    command: {
        register: (spec: {
            name: string;
            description: string;
        }) => Promise<unknown>;
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
}
