/**
 * An organization's contracted rates: Claude Code's `modelPricing` setting,
 * which it reads from managed (policy) settings only and applies to every
 * spend figure it reports (/cost, the status line, `total_cost_usd`).
 * Where it is set, context-doctor prices Claude requests at the same rates,
 * so its dollars match Claude Code's and the organization's bill.
 *
 * Read from the 2.1.321 binary and the settings reference
 * (code.claude.com/docs/en/settings-reference#modelpricing, read 2026-11-10):
 *  - `multiplier`: a number greater than 0 and at most 10, applied to every
 *    cost Claude Code computes, a row's included. Anything else is ignored.
 *  - `overrides`: model id to `{ input, output, cacheRead, cacheWrite }`, USD
 *    per million tokens, all four required, each 0 to 10000; a row missing
 *    one is ignored. `cacheWrite` prices 5-minute and 1-hour writes alike. A
 *    row is charged as written: no fast-mode or US-only surcharge, no
 *    long-prompt tier. Web searches keep their list fee.
 *  - A key that spells a Claude model (`claude-sonnet-4-6`, its Bedrock or
 *    Vertex id) covers every dated and provider spelling of that model; any
 *    other key (a gateway alias) only its exact id, which wins over a
 *    model's row.
 *  - Managed sources only: user, project and local settings never set it.
 *    Here, the managed settings files (effective.ts managedSettingsPaths:
 *    managed-settings.json, then managed-settings.d/*.json in alphabetical
 *    order, nested blocks merged key by key). MDM profiles and
 *    server-managed settings are not read.
 */
import type { ModelPricing } from "./pricing.js";
export interface OrgRates {
    /** Scales every Claude cost, a row's included (1 when unset). */
    multiplier: number;
    /** Rows by their exact key, lowercased. */
    exact: Map<string, ModelPricing>;
    /** Rows keyed by a Claude model, by that model's canonical id. */
    models: Map<string, ModelPricing>;
    /** The files that set it. */
    sources: string[];
    /** Fingerprint of the rates in force: cached dollars priced under other rates are stale. */
    key: string;
}
/**
 * One Claude model, however a provider spells it: "claude-sonnet-4-6" for
 * claude-sonnet-4-6-20260101, claude-sonnet-4-6[1m],
 * us.anthropic.claude-sonnet-4-6-v1:0 and claude-sonnet-4-6@20260101.
 * Undefined for an id that is not a Claude model's.
 */
export declare function canonicalClaude(id: string): string | undefined;
/** `modelPricing` from merged managed settings, as Claude Code keeps it; undefined when it changes nothing. */
export declare function parseOrgRates(value: unknown, sources?: string[]): OrgRates | undefined;
/** The merged `modelPricing` of the managed settings files, and which files set it. */
export declare function readOrgRates(env?: NodeJS.ProcessEnv): OrgRates | undefined;
/** The merged `modelPricing` of `paths`, in order (the base file, then the drop-ins). */
export declare function readOrgRatesFrom(paths: string[]): OrgRates | undefined;
/**
 * The organization's rates in force, read once per process (and again when
 * the variables that move the managed files change). The hook's cost: a
 * stat of the managed folder and its drop-in folder, once.
 */
export declare function orgRates(env?: NodeJS.ProcessEnv): OrgRates | undefined;
/** Forget what orgRates read (tests that rewrite a managed file in place). */
export declare function resetOrgRates(): void;
/** The row that prices `model`: its exact key first, then its Claude model's. */
export declare function orgRowFor(rates: OrgRates, model: string): ModelPricing | undefined;
/** Whether the organization's rates reach `model`: a row of its own, or a Claude model under the multiplier. */
export declare function orgApplies(rates: OrgRates | undefined, model: string | undefined): boolean;
/**
 * How a report's dollars were priced, for its heading: "at list prices", or
 * "at your organization's rates" where managed settings set `modelPricing`
 * (Claude models at those rates, any other provider's at list).
 */
export declare function priceBasis(plural?: boolean, env?: NodeJS.ProcessEnv): string;
/**
 * The line a report adds where the organization's rates are in force:
 * which files set them and what they are. Undefined at list prices.
 */
export declare function orgRatesLine(env?: NodeJS.ProcessEnv): string | undefined;
