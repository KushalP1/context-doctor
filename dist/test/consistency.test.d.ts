/**
 * savings, compact-window and overhead read the same transcripts for the
 * same --days. They used to disagree with no explanation: savings said 37
 * sessions under an 85-step progress bar, overhead said 80, and savings'
 * billed $3,458 sat next to compact-window's "as now" $3,173 (the replay's
 * own model of the bill). Now savings and compact-window count the same
 * sessions and show the same billed baseline, and every count says what it
 * counts. The progress lines that explain the wait go to a terminal only.
 */
export {};
