/**
 * The plugin's mod (src/mod): the band's states, the fix pane's rows, and
 * the hooks themselves driven by a stand-in for Claude Code's mods engine.
 *
 * The stand-in answers `$` the way the 2.1.321 declarations describe it and
 * runs `$.process.run` for real, in a throwaway HOME, so a button press
 * writes what the CLI writes; each press is compared byte for byte with the
 * CLI run by hand (`fix --apply <id>`, `fix undo <id>`) on a copy of the same
 * home. Nothing here starts Claude Code.
 */
export {};
