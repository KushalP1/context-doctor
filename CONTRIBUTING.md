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

## Good first issues

- **A new session format.** `src/session.ts` reads Claude Code transcripts and
  ChatGPT exports. Cursor is open — it needs someone with a sample file.
- **Pricing updates.** `src/pricing.ts` is one table; provider prices drift.
- **A new finding.** `src/profile.ts` detectors are self-contained: detect a
  waste pattern, estimate its savings, suggest the fix, add a test.
- **Docs.** If something took you more than one read to understand, that is a
  bug worth fixing.

## Reporting a bug

Include the output of `context-doctor doctor` (it is safe to paste — it lists
integration status, not conversation content) plus what you expected. If it
involves a conversation, please redact it; the profile numbers alone are often
enough to diagnose.

## Security

Found something sensitive? Please open a private security advisory on GitHub
rather than a public issue.
