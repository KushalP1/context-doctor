# Contributing to context-doctor

Thanks for looking. This project is deliberately small, dependency-light, and
easy to reason about. Contributions that keep it that way are very welcome.

## Getting set up

```bash
git clone https://github.com/KushalP1/context-doctor
cd context-doctor
npm install
npm test
```

`npm test` builds and runs the whole suite. It must be green before you push.

## The rules that keep this tool trustworthy

These are not style preferences. A PR that breaks one of them will be asked to
change, however good the feature is.

1. **No API keys for core function.** Profiling, optimizing, the hook, the
   proxy and the reports all work offline with no credentials. Optional
   accuracy adapters may accept a key the user already has, never require one.
2. **Nothing leaves the machine.** No telemetry, no analytics, no phoning
   home. The dashboard binds loopback; the proxy binds loopback by default.
3. **No silent data loss.** Lossy operations (history pruning) are opt-in and
   consented. The optimizer prints exactly what it changed.
4. **Report measurements, not guesses.** If a number cannot be measured, say
   so instead of estimating it. Estimates are labelled as estimates.
5. **The hot path stays cheap.** The hook runs on every prompt: keep the
   common case a `stat()` and nothing more. Any change there needs a timing
   note in the PR.
6. **Tests come with the change.** Every fix gets a regression test; every
   feature gets coverage of its success and failure paths.

## Making a change

- Branch from `main`, keep the diff focused.
- `dist/` is committed on purpose (it makes `npm install` from GitHub work
  with no build step). Run `npm run build` before committing so the CI
  dist-sync check passes.
- CI runs the suite on Linux, macOS and Windows across Node 20 and 22. Avoid
  shell-isms and path assumptions that only hold on one OS.
- Keep comments about *why*, not *what*.

## Checks beyond `npm test`

Two end-to-end checks, both run against a throwaway `HOME`:

```bash
HOME=$(mktemp -d) node scripts/smoke-mcp.mjs node dist/mcp.js
```

```bash
HOME=$(mktemp -d) node scripts/smoke-openai-proxy.mjs
```

The first connects to the MCP server the way a client does (it takes any launch command, `npx -y context-doctor mcp` included, or `--http <url>`), lists the tools and prompt, calls every tool and checks that bad input is rejected. The second runs the proxy against a local mock of OpenAI: streaming, the Responses API, usage capture and autopilot.

`bash scripts/verify-local.sh` runs everything before a release: build, tests, both smokes plus the Gemini proxy smoke, the published package, the Python package and its parity fixtures, every CLI command on your real history (read-only; anything that writes the ledger runs in a throwaway HOME), an install/uninstall round trip and the GitHub Action's steps.

## Good first issues

- **A new session format.** `src/session.ts` reads Claude Code transcripts and
  ChatGPT exports. Cursor is open — it needs someone with a sample file.
- **Pricing updates.** `src/pricing.ts` is one table; provider prices drift.
- **A new finding.** `src/profile.ts` detectors are self-contained: detect a
  waste pattern, estimate its savings, suggest the fix, add a test.
- **Docs.** If something took you more than one read to understand, that is a
  bug worth fixing.

## Releasing (maintainers)

**One-time setup.** Each row switches on one channel; any that is missing is skipped with a notice, never a failed run. Secrets go in the repo's Settings > Secrets and variables > Actions:

| Secret | Turns on | Where to get it |
|---|---|---|
| *(no secret: npm trusted publishing)* | `npm publish` on every `v*` tag, with provenance | npmjs.com > package `context-doctor` > Settings > Trusted Publisher > GitHub Actions: owner `KushalP1`, repository `context-doctor`, workflow `publish.yml`. npm is phasing out publish tokens that bypass 2FA; an `NPM_TOKEN` secret still works as a fallback |
| `MCPB_CERT`, `MCPB_KEY` (+ `MCPB_INTERMEDIATE`) | A signed Claude Desktop bundle, no install warning | A code-signing certificate from a trusted CA; paste the PEM text. `mcpb verify` must pass in CI or the release stops |
| `VSCE_PAT` | VS Code Marketplace on `vscode-v*` tags | Azure DevOps PAT, scope Marketplace > Manage, for the `gai-ventures` publisher |
| `OVSX_PAT` | Open VSX (where Cursor installs from) | open-vsx.org > Settings > Access Tokens |

**Each release:**

```bash
npm version minor        # or patch/major: bumps package.json and tags vX.Y.Z
npm test                 # the full suite; CI runs it on 3 OSes x Node 20/22/24
git push --follow-tags   # npm publish + GitHub release with the .mcpb attached
```

The GitHub release notes are the ROADMAP.md section headed `## Shipped in X.Y.Z` (see `.github/workflows/publish.yml`), so write that section before tagging; without it the notes say only "See ROADMAP.md."

For the editor extension: bump `vscode/package.json`, add a `vscode/CHANGELOG.md` entry, then `git tag vscode-vX.Y.Z && git push --tags`. The `.vsix` is attached to a GitHub release either way.

Locally, `npm run build:mcpb` builds the bundle (`MCPB_SELF_SIGNED=1` exercises the signing path with a throwaway certificate; Desktop still warns for those).

**What the npm download number measures.** `install` run through npx writes `npx -y context-doctor mcp` into MCP configs, and npx re-fetches the tarball whenever a new version exists. So every release is downloaded once by every active install within about a day, and the daily count is almost entirely those refreshes: on this package, release days run ~170 downloads and non-release days ~27. Read it as "size of the active installed base × number of releases", not as new users — a quiet week with no releases will look like a decline while nothing has changed. Two corollaries: the release-day figure is a live count of machines running context-doctor, and a broken release reaches all of them automatically, which is why `prepublishOnly` runs the full test suite. npm's stats also lag by several days and occasionally record a day as zero; a zero on a release day is a gap in their pipeline, not in usage.

Known gotcha: if `npm publish` fails with **`404 Not Found - PUT …/context-doctor`** on a package that clearly exists, the real cause is an **expired npm login token** — npm reports unauthenticated publishes as a 404, not a 401. Check with `npm whoami`; if that errors, run `npm login` and publish again.

`npm version` runs `scripts/sync-versions.mjs`, which copies the new version into `server.json`, the MCP server and the proxy, rebuilds `dist/` and stages it, so nothing needs syncing by hand. `dist/` is committed: run `npm run build` before committing any other change so the CI dist-sync check passes.

## Reporting a bug

Include the output of `context-doctor doctor` (it is safe to paste — it lists
integration status, not conversation content) plus what you expected. If it
involves a conversation, please redact it; the profile numbers alone are often
enough to diagnose.

## Security

Found something sensitive? Please open a private security advisory on GitHub
rather than a public issue.
