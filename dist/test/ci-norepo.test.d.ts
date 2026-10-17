/**
 * `ci` outside a git repository listed no files, printed "No agent memory
 * files" and exited 0, so a CI step run in the wrong directory passed every
 * pull request. It must fail and say why.
 */
export {};
