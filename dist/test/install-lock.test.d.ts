/**
 * install and uninstall edit ~/.claude/settings.json under the same lock as
 * `fix`, `cache-ttl`, `compact-window` and autopilot, and write it through a
 * temporary file: run beside one of them, neither loses the other's change,
 * and no reader sees half a file.
 */
export {};
