// Test runner. Exists so the suite is isolated from this machine's state in a
// way `npm test` can express on Windows too (no `VAR=x cmd` syntax there):
//  - no calibration file may scale the token numbers tests assert on;
//  - the whole run gets a throwaway home directory, so no test can read or
//    change a developer's real ~/.claude (configs, transcripts, autopilot:
//    the hook's self-heal would otherwise start a real proxy mid-run);
//  - the test list is the compiled dist/test directory, so a new test file
//    cannot be forgotten in package.json.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "context-doctor-test-home-"));

const files = readdirSync("dist/test")
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => `dist/test/${f}`)
  .sort();

// HOME for POSIX, USERPROFILE for Windows (os.homedir() reads that there).
const env = { ...process.env, CONTEXT_DOCTOR_NO_CALIBRATION: "1", HOME: home, USERPROFILE: home };
// GitHub Copilot's home follows COPILOT_HOME wherever HOME is: never the real one.
delete env.COPILOT_HOME;
// Claude Code's config folder and managed settings follow these: never the developer's own.
delete env.CLAUDE_CONFIG_DIR;
delete env.CLAUDE_CODE_MANAGED_SETTINGS_PATH;
env.CONTEXT_DOCTOR_NO_MANAGED_SETTINGS = "1";
// On GitHub Actions, failing tests also become annotations: a job's log
// needs a signed-in reader, its annotations do not, so a failure on a runner
// nobody here can open (Windows, an older Node) still says which test and why.
const ci = Boolean(process.env.GITHUB_ACTIONS);
const tap = join(home, "results.tap");
const reporters = ci ? ["--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=tap", `--test-reporter-destination=${tap}`] : [];
const result = spawnSync(process.execPath, ["--test", ...reporters, ...files], { stdio: "inherit", env });
if (ci && result.status !== 0) {
  try {
    const lines = readFileSync(tap, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = line.match(/^\s*not ok \d+ - (.*)$/);
      if (!m) return;
      // The error from the YAML block that follows (a block scalar spans lines), and where.
      const block = lines.slice(i + 1, i + 60);
      const end = block.findIndex((l) => /^\s*\.\.\.\s*$/.test(l));
      const yaml = end >= 0 ? block.slice(0, end) : block;
      const at = yaml.findIndex((l) => /^\s+error:/.test(l));
      let detail = at >= 0 ? yaml[at].replace(/^\s+error:\s*\|?-?\s*/, "") : "";
      if (at >= 0 && !detail) detail = yaml.slice(at + 1, at + 6).map((l) => l.trim()).filter(Boolean).join(" ");
      const where = (yaml.find((l) => /^\s+location:/.test(l)) ?? "").replace(/^\s+location:\s*/, "").replace(/^'|'$/g, "").split(/[\\/]/).pop();
      const esc = (t) => t.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
      console.log(`::error title=${esc(m[1].slice(0, 200))}::${esc(`${where ? where + ": " : ""}${detail}`.slice(0, 600))}`);
    });
  } catch {
    // No TAP file: the plain log is all there is.
  }
}
rmSync(home, { recursive: true, force: true });
process.exit(result.status ?? 1);
