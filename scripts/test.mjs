// Test runner. Exists so the suite is isolated from this machine's state in a
// way `npm test` can express on Windows too (no `VAR=x cmd` syntax there):
//  - no calibration file may scale the token numbers tests assert on;
//  - the test list is the compiled dist/test directory, so a new test file
//    cannot be forgotten in package.json.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = readdirSync("dist/test")
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => `dist/test/${f}`)
  .sort();

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: { ...process.env, CONTEXT_DOCTOR_NO_CALIBRATION: "1" },
});
process.exit(result.status ?? 1);
