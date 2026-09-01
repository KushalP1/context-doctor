/**
 * Render a ContextProfile as a readable terminal/markdown report.
 * Plain text with ASCII bars — no color deps, so output pastes cleanly
 * anywhere (terminals, issues, chat).
 */
import { ContextProfile } from "./profile.js";
export interface RenderOptions {
    /**
     * Replace anything quoted from the conversation with a placeholder, so a
     * profile can be pasted into a bug report without leaking content. Numbers
     * and structure — the parts that make a report useful — are kept.
     */
    redact?: boolean;
}
export declare function renderProfile(profile: ContextProfile, options?: RenderOptions): string;
