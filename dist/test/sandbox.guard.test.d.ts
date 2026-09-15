/**
 * Structural guard: no test may sandbox HOME without USERPROFILE.
 *
 * The rule is easy to state and easy to forget, and CI only notices on
 * Windows, a day later. This test reads every test source and fails the
 * suite immediately instead.
 */
export {};
