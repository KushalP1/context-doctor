/**
 * A request recorded with no time of its own is priced as of now, as
 * requestCost prices any request it is given no time for: past a day its
 * model's price changed, that is the newer price, labelled an estimate.
 * Before, NaN compared as "never expired": the budget (and every replay
 * that passed the parsed time on) priced such a row at the ended price,
 * unlabelled, while lens, subagents and tasks priced it at today's, and
 * savings at 1970's. One rule now, the same in each.
 */
export {};
