# Budgets and CI

[← README](../README.md)

## Enforce a budget in CI

**Memory files on every pull request.** CLAUDE.md, AGENTS.md, GEMINI.md and rules are re-read by every request of everyone working in the repository, so their growth deserves review. The repository is also a GitHub Action:

```yaml
# .github/workflows/context.yml
on: pull_request
permissions:
  contents: read
  pull-requests: write   # for the comment
jobs:
  memory:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: KushalP1/context-doctor@v0.38.0
        with:
          max-increase: "2000"        # fail a PR that adds more than 2k tokens
          requests-per-day: "5000"    # optional: price the change
```

It compares the memory files and their `@imports` at the PR head with the base branch, writes the table to the job summary, keeps one PR comment up to date, and fails over budget. Locally: `context-doctor ci --base origin/main`.

**Conversation fixtures.**

```bash
npx context-doctor analyze conversation.json --fail-over-budget
```

Exits 1 when the `.contextdoctorrc` budget is breached, so a pull request can be gated on context size the same way it is gated on tests.

## Context budgets (`.contextdoctorrc`)

Drop a `.contextdoctorrc` in a project (or your home directory) and context-doctor enforces your limits instead of its defaults:

```json
{
  "budget": { "maxTokens": 120000, "maxCostPerMessageUsd": 0.5, "maxWindowPct": 60 },
  "strategies": ["dedupe", "trim-tool-results"],
  "keepRecent": 6
}
```

The nearest file wins (walking up from the working directory, then `~`). `analyze` and `session` print a budget verdict, the every-prompt hook uses `maxTokens` as its warning threshold and names the breach to the model, and `optimize`/`proxy` pick up the defaults when you do not pass flags.
