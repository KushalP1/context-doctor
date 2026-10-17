/**
 * uninstall takes out what install put in, and says what it did: files
 * install created are deleted once they hold nothing (not left as
 * {"mcpServers":{}}), containers it added go, the user's own content and
 * the backups of their originals stay (and are listed), and a machine with
 * nothing installed is told so instead of a bare "Done.".
 */
export {};
