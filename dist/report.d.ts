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
/**
 * Mask filesystem paths and file names inside a finding's text.
 *
 * Any path with a separator goes (absolute, ~/, ./, Windows, or relative
 * like docs/plan.pdf), and so does any bare name with an extension: a
 * finding names a file by its last segment ("Q3-layoffs-draft.docx was read
 * 3 times"), and the name itself can be the secret, whatever its type. An
 * extension must start with a letter, so figures like ~1.2k or 0.5x stay.
 */
export declare function redactText(text: string): string;
export declare function renderProfile(profile: ContextProfile, options?: RenderOptions): string;
