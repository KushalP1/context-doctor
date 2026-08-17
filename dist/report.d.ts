/**
 * Render a ContextProfile as a readable terminal/markdown report.
 * Plain text with ASCII bars — no color deps, so output pastes cleanly
 * anywhere (terminals, issues, chat).
 */
import { ContextProfile } from "./profile.js";
export declare function renderProfile(profile: ContextProfile): string;
