/**
 * Structural guard: no test may sandbox HOME without USERPROFILE.
 *
 * The rule is easy to state and easy to forget, and CI only notices on
 * Windows, a day later. This test reads every test source and fails the
 * suite immediately instead.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("every test that overrides HOME also overrides USERPROFILE", () => {
  // Tests are compiled to dist/test; the sources they came from live in src/test.
  const here = dirname(fileURLToPath(import.meta.url));
  const srcDir = join(here, "..", "..", "src", "test");
  const offenders: string[] = [];
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith(".ts") || file === "sandbox.ts") continue;
    const text = readFileSync(join(srcDir, file), "utf8");
    const setsHome = /\bHOME\s*:\s*|process\.env\.HOME\s*=/.test(text);
    const setsProfile = /USERPROFILE|sandboxEnv|withSandboxHome/.test(text);
    if (setsHome && !setsProfile) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `these tests sandbox HOME only, which os.homedir() ignores on Windows: ${offenders.join(", ")}`);
});
