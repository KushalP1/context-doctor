/**
 * `spend` reads Copilot CLI's `session.usage_record` events: each model call
 * once (a call written twice, a compaction a record already names), its
 * input less both cache counts, priced at list where the model has a price
 * and counted where it has none, its AI credits and premium requests kept
 * beside the price. The records are the shape GitHub's own collector and
 * the other readers parse (copilotusage.ts), with made-up numbers.
 */
export {};
