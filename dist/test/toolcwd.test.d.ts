/**
 * Programs run by bare name (git, pdftotext, unzip, sqlite3…) run from the
 * temp folder, never from the folder being read.
 *
 * On Windows a bare name is found in the child's working folder before PATH:
 * `pack .` in a cloned repository, the MCP server's pack_context (its
 * working folder is the project its client opened) and `ci` in a pull
 * request's checkout ran a git.exe committed there. That lookup cannot be
 * staged on macOS or Linux, so these tests check what prevents it on every
 * OS: the working folder each program is started in, recorded by a stand-in
 * on PATH. (A stand-in cannot be a script on Windows, which spawns only
 * executables by bare name: skipped there.)
 */
export {};
