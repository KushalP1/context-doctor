/**
 * E1: on a Claude Code that runs mods (2.1.286+), `install` switches the
 * plugin on in ~/.claude/settings.json (extraKnownMarketplaces,
 * enabledPlugins) instead of wiring its own MCP server, skill and hooks;
 * an older Claude Code anywhere on the machine keeps install's own wiring.
 * Every round trip gives every file back byte for byte; at no step is the
 * same piece wired twice; doctor says which route is active and whether the
 * mod records.
 */
export {};
