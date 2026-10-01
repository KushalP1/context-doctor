// Test runner. Exists so the suite is isolated from this machine's state in a
// way `npm test` can express on Windows too (no `VAR=x cmd` syntax there):
//  - no calibration file may scale the token numbers tests assert on;
//  - the whole run gets a throwaway home directory, so no test can read or
//    change a developer's real ~/.claude (configs, transcripts, autopilot:
//    the hook's self-heal would otherwise start a real proxy mid-run);
//  - the test list is the compiled dist/test directory, so a new test file
//    cannot be forgotten in package.json.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "context-doctor-test-home-"));

const files = readdirSync("dist/test")
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => `dist/test/${f}`)
  .sort();

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  // HOME for POSIX, USERPROFILE for Windows (os.homedir() reads that there).
  env: { ...process.env, CONTEXT_DOCTOR_NO_CALIBRATION: "1", HOME: home, USERPROFILE: home },
});
rmSync(home, { recursive: true, force: true });
process.exit(result.status ?? 1);
