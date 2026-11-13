/**
 * The working folder for a program run by its bare name (git, pdftotext,
 * unzip, sqlite3, netstat, schtasks…).
 *
 * On Windows, Node (libuv) looks a bare name up in the child's working
 * folder before PATH, as cmd.exe does. Run from a project, `pack .`, the
 * MCP server's pack_context (whose working folder is the project its client
 * opened) and `ci` ran a git.exe committed to that repository, or a
 * pdftotext.exe beside the documents, instead of the real one. These
 * programs get every path absolute (git with -C), so they run from the
 * user's own temp folder instead, where a clone or a download cannot put a
 * program by that name.
 */
import { tmpdir } from "node:os";
export function toolCwd() {
    return tmpdir();
}
