/**
 * `context-doctor report` — one impact report for this machine.
 *
 * Honesty rules baked in: proxy numbers are EXACT (real before/after on every
 * request). Session numbers are MEASURED-NOW (current size + what optimization
 * would still recover). The behavioral counterfactual — what Claude avoided
 * wasting because of hygiene guidance — cannot be measured by anyone: the same
 * session cannot be re-run without it. The report says so instead of inventing
 * a number.
 */
export declare function buildImpactReport(proxyPort?: number): Promise<string>;
