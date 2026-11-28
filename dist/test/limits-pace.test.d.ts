/**
 * The run-out forecast checked against your own past weeks (ROADMAP J3):
 * each closed weekly window is replayed every 12 hours, both paces put its
 * end somewhere, and the one that missed less on the last 2+ windows is
 * named and used for the run-out and for H2's credits figure, which gets a
 * range. Bursty weeks pick the window's average, a steady pace that changed
 * picks the last 24 hours'; with under 2 closed windows nothing changes.
 */
export {};
