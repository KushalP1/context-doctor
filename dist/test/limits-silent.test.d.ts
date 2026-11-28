/**
 * A weekly meter that went silent (ROADMAP J2): a weekly window whose
 * readings stop while the 5-hour window goes on rising gets one line (where
 * it stopped, how far the 5-hour rose after, the weekly that amounts to),
 * no pace from its old reading, and a per-1% fit that ends at its last
 * reading. With no silence the report is unchanged. And the recorder's side
 * of the cause: a fall the proxy reads (usage given back) is kept.
 */
export {};
