// Writes the golden outputs the shared-scan tests compare against
// (src/test/golden/{base,grown}/*.txt): every history report run on the
// fixture history (dist/test/history-fixture.js), then again after it grew.
// Run it with the CLI of the code BEFORE the change being tested, e.g. a
// checkout of the previous commit's dist:
//   node scripts/gen-scan-golden.mjs /path/to/old/dist/cli.js
// (needs `npm run build` here first, for the fixture). Writes nothing outside
// a throwaway home and src/test/golden.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildHistory, growHistory, GOLDEN_COMMANDS } from "../dist/test/history-fixture.js";
import { goldenName, runReport } from "../dist/test/golden-run.js";

const cli = resolve(process.argv[2] ?? "dist/cli.js");
const home = mkdtempSync(join(tmpdir(), "cd-golden-"));
const cache = mkdtempSync(join(tmpdir(), "cd-golden-cache-"));
try {
  buildHistory(home);
  for (const stage of ["base", "grown"]) {
    if (stage === "grown") growHistory(home);
    const dir = join("src", "test", "golden", stage);
    mkdirSync(dir, { recursive: true });
    for (const args of GOLDEN_COMMANDS) {
      // An older CLI ignores the cache variables; a newer one reads nothing cached.
      writeFileSync(join(dir, goldenName(args)), runReport(cli, home, args, { CONTEXT_DOCTOR_NO_CACHE: "1", CONTEXT_DOCTOR_CACHE_DIR: cache }));
    }
    console.log(`${stage}: ${GOLDEN_COMMANDS.length} reports`);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
}
