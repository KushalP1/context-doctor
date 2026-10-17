/**
 * The Claude Code plugin and `install` both give Claude Code our MCP server,
 * skill and hooks. With both, every session loads the server's instructions
 * and tools twice. install must leave Claude Code to the plugin, and doctor
 * must say so when an earlier install is still there.
 */
export {};
