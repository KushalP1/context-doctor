# Does a smaller context actually help? Measure it

[← README](../README.md)

Everything else in this tool measures what is *in* the context. None of it can tell you whether the task succeeded, so a smaller transcript can be a cheaper failure. `experiment` is the honest test:

```bash
context-doctor experiment \
  --task "Add a null check to parseHeader in src/parse.ts and make the tests pass" \
  --check "npm test" \
  --existing 9c6f9dc9-457b-4d09-bf6d-a499c2f2f919 \
  --model sonnet --budget 1
```

It runs the task in a **fresh** session, resets the tree to the starting commit, then runs it again **forked from your existing session** (`--resume … --fork-session`, so your real session is never touched), same model, same tools. For each arm it records what you were billed (input, cache read, cache write, output), cost, wall clock, turns, and whether your `--check` command passed, then puts them side by side:

```
                               fresh      existing
──────────────────────────────────────────────────
billed input                     20k           65k
  of which cache read              0           60k
  of which cache write          8.0k          4.0k
cost                          $0.110        $0.420
wall clock                        4s            9s
check                           PASS      FAIL (1)

Verdict: fresh was cheaper AND passed; existing failed the check. Clear win for fresh.
```

The verdict line is the point: cheaper only counts if it also passed. Because this spends your Claude budget it caps spend per arm (`--budget`, default $1), refuses to start on a dirty tree (both arms must begin from one commit, and the tree is reset between them), and refuses to run from inside a Claude Code session, where the CLI cannot start. `--dry-run` shows the exact commands first.
