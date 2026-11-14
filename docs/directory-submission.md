# Submitting the plugin to Anthropic's directory

[← README](../README.md) · [privacy](./privacy.md) · [Desktop app and the mod](./desktop.md)

The owner's package for listing context-doctor in Anthropic's plugin directory (ROADMAP E5). Everything here was checked on 2026-11-14 against the directory's docs and Claude Code 2.1.325 (npm's newest and the Desktop app's). Submitting is the owner's step: nothing here submits or contacts anyone.

## In short

- **The directory accepts mods.** Its platform page says it lists a mod (code named under `modules` in `hooks/hooks.json`) for Claude Code, and its checklist names a `modules` array as a valid `hooks/hooks.json`. What it does not publish are the "rules of its own" that `claude plugin validate` says the portal applies to a hooks module; only the portal's **Validate** shows them.
- **Submit the directory build, from a branch.** `scripts/build-directory-plugin.mjs` makes a folder with only what the plugin runs (115 files) and a plugin.json with `engines["claude-code"]` and the listing fields. `claude plugin validate --profile directory --strict` passes on it with no error, no warning and no directory finding, and the canary runs green on it (26 of 26).
- **Fallback:** the same build with `--no-mod` (no hooks module), also strict-clean. Use it only if the portal or a reviewer refuses the mod.
- **Expect a reviewer.** Some holds cannot be avoided (below), so plan on a reviewer reading the plugin before it goes live, not on an automatic publish.

## What the directory requires (sources)

| Requirement | Where it is stated | context-doctor |
|---|---|---|
| A GitHub repository, your GitHub account connected on claude.ai with push access; a paid plan (Pro, Max, Ultra, Team or Enterprise; on Team and Enterprise an Owner) | [Submit your plugin](https://claude.com/docs/plugins/submit), [Publish to the directory](https://claude.com/docs/directory/publish) | KushalP1/context-doctor, public |
| Portal flow: Source (repository, plugin path, branch or tag) → **Validate** → Listing details (read from plugin.json and the README) → Data handling (4 questions) → Compliance (contact email, 4 acknowledgements) → Review and submit (push webhook or scheduled check; auto-publish toggle) | [Submit your plugin](https://claude.com/docs/plugins/submit) | Answers below |
| `.claude-plugin/plugin.json`; `name` lowercase, digits, hyphens, unique, not reserved or brand-like; `description`, `author`, `version` (warnings if missing) | [Pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist) | All set; `context-doctor` |
| README of 40+ words outside code blocks (blocks); a LICENSE or `license` (blocks) | Checklist; the `README_MISSING`, `README_TRIVIAL` and `LICENSE_MISSING` rules in the 2.1.325 binary | `plugin/README.md` becomes the build's README; MIT |
| Icon: a square PNG or JPEG, 512 to 2048 px, under 2 MB; used for the listing only the first time the plugin is saved or submitted | `ICON_MISSING` / `ICON_INVALID` in the binary; [manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference) (directory listing fields) | `assets/icon.png`, 512×512, 3.8 KB |
| Listing fields `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`, read from plugin.json only | Manifest reference | All but terms of service, in the build |
| No `.DS_Store` and the like (blocks); no symbolic links, submodules or LFS for what loads (blocks); Windows-safe names; no `export-ignore`/`filter` in `.gitattributes` | Checklist | None; `.gitattributes` sets only `text=auto eol=lf` |
| Repository under 50 MiB archived, 256 MiB unpacked, under 10,000 files; every file under 5 MiB (else validation stops) | Checklist | 2.9 MB archived, 949 files; largest file in the build 1.8 MB |
| Each non-image file under 256 KiB, at most 512 files, no other binaries; readable, not minified, code (each held for a reviewer) | Checklist | The build: 115 files; only `dist/mcp.bundle.js` over 256 KiB (unminified) |
| `package.json` beside a lockfile at the plugin root: held ("Dependencies install from a lockfile") | Checklist; [plugin loading](https://code.claude.com/docs/en/plugins/loading) | The build has a `package.json` with no lockfile and no dependencies |
| Hook and MCP commands: every path written from `${CLAUDE_PLUGIN_ROOT}`, no other variables or inline programs (blocks); a hook or server that runs a non-shell file is held ("Scripts the validator couldn't follow") | Checklist | All commands are `node "${CLAUDE_PLUGIN_ROOT}/dist/…"`: held, unavoidable for a Node plugin |
| No package launchers (`npx`, `uvx`) unpinned in hooks or servers; no registry config | Checklist | None in hooks or the server. The autopilot skill asks before `npm install -g context-doctor`; a skill's text is not part of this check |
| No credentials in files; no credential read from the environment and sent to a server (held) | Checklist | None by default. `analyze --exact` and `ab` read `ANTHROPIC_API_KEY` when the user runs them; disclosed in the README |
| Security scan: the README must describe everything the plugin runs, sends or fetches | Checklist, "Prepare for the security scan" | `plugin/README.md`, "What it runs, reads, writes and sends" |
| Directory Policy: privacy (1D, 1E, 1G), descriptions that match what tools do (2A-2G), a privacy policy, support contact, documentation, a test account with sample data, 3+ example prompts (3A-3E), MCP annotations and current dependencies (5E, 5G) | [Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy) | Below. Every tool is annotated; the server is on the MCP SDK's v2 packages |
| Local MCP servers go in a plugin; `.mcpb` listings are deprecated | [Submit a connector](https://claude.com/docs/connectors/building/submission) | The plugin carries the server |
| `engines["claude-code"]`: a semver range outside of which Claude Code (2.1.323+) does not install, update or load the plugin | Claude Code CHANGELOG 2.1.323; the manifest schema in the 2.1.325 binary | `>=2.1.76` in the build (why below) |
| Hooks modules: TypeScript ones are type-checked by `claude plugin validate` (each finding a warning, fatal under `--strict`) | CHANGELOG 2.1.323; checked by hand | Ours is JavaScript (`dist/mod/register.js`): the check returns no findings for a `.js` module, and none for ours |

## Validate output, before and after

On the repository as it was (`claude plugin validate --profile directory --strict .`, throwaway HOME, every Claude Code here): **passed with no warnings** on 2.1.311, 2.1.321, 2.1.323 and 2.1.325, with two notes: the folder also holds a marketplace manifest, and "hooks/hooks.json names a hooks module … the developer portal's own validation applies those rules". 2.1.62 has no `--strict` or `--profile` and passes.

On the directory build (`node scripts/build-directory-plugin.mjs --validate`, 2.1.325):

```
Built build/directory-plugin (with the mod): 115 files
⚠ dist/mcp.bundle.js: over 256 KiB, held for a reviewer (expected for the MCP server's bundle)
✓ claude plugin validate --profile directory --strict on Claude Code 2.1.325: no errors, no warnings, no directory findings
  note: hooks/hooks.json names a hooks module (a code file listed under `modules`). The plugin directory has rules of its own for such code, …
  note: ../dist/mod/register.js calls: $.clock.every, $.clock.now, $.command.register, $.env.get, $.process.run (via compact, loadPlan, measure, press), $.session.compact (via compact), $.session.cwd, $.session.id, $.session.model (via measure), $.ui.invalidate, $.ui.open, $.ui.resolve, $.ui.toast (via compact)
  note: ../dist/mod/register.js env writes: nothing
  note: ../dist/mod/register.js env reads: CONTEXT_DOCTOR_MOD_BAND, CONTEXT_DOCTOR_NO_MOD, CONTEXT_DOCTOR_NO_SESSION_PRICE, CONTEXT_DOCTOR_SESSION_PRICE
```

`--no-mod`: 113 files, the same pass and no notes. The hooks-module note never goes away: it is a note, not a warning, and it says the local command does not run the portal's mod rules.

## Why `engines` and the listing fields are in the build only

Claude Code 2.1.62 to 2.1.75 refuse a `plugin.json` with any key they do not know and then load **nothing** of the plugin: "Plugin … has an invalid manifest file … Unrecognized key: "engines"" (measured on 2.1.62, 2.1.68 and 2.1.75; 2.1.76, 2.1.77, 2.1.78, 2.1.79, 2.1.83, 2.1.90, 2.1.120, 2.1.200, 2.1.286 and 2.1.323 load it). Without those keys, the repository's own plugin still loads its MCP server, skills and hooks on 2.1.62. So the repository's manifest stays as it is (its test says so), and only the build carries `engines: {"claude-code": ">=2.1.76"}` (the oldest Claude Code that loads a manifest carrying it), `icon`, `documentationUrl`, `supportUrl` and `privacyPolicyUrl`. Claude Code reads `engines` only from 2.1.323, and every version from then on satisfies the range, so it is a statement, not a gate. The mod stays gated as before: Claude Code runs modules from 2.1.286, and an older one drops only `hooks/hooks.json`. On 2.1.311 and 2.1.321, `--strict` warns that `engines` is an unknown field; from 2.1.323 it is known.

## The submission, step by step (the owner)

1. **Build and push the branch the directory follows.** The build keeps a `.git` folder in its output, so the same folder works for every release:

   ```bash
   npm ci && npm run build
   node scripts/build-directory-plugin.mjs --validate --out ../context-doctor-directory
   cd ../context-doctor-directory
   git init -b directory            # first time only
   git add -A && git commit -m "context-doctor $(node -p 'require("./package.json").version') for the directory"
   git push https://github.com/KushalP1/context-doctor.git directory
   ```

   For the fallback, add `--no-mod` to the build. Each release: build, commit and push again into the same folder (raise `version`, which `npm version` already does). Pushing a branch is all it takes; a workflow could do it on each `v*` tag, which is not set up.
2. **Run Validate in the portal before submitting.** [claude.ai/directory/manage](https://claude.ai/directory/manage) → **Submit new** → **Plugin bundle**. Repository `KushalP1/context-doctor`, plugin path empty, branch `directory`. Select **Validate**. If the mod's rules block, rebuild with `--no-mod`, push, and **Re-validate**.
3. **Listing details.** Read from the build's plugin.json and README; nothing to type. Check that they read well.
4. **Data handling** and **Compliance**: the answers below; the contact email is the owner's.
5. **Review and submit.** Keep **GitHub push webhook** (needs admin on the repository) so a pushed release is checked at once; leave auto-publish off for the first version.
6. **After listing:** the plugin's **Usage** tab (installs, versions, runs, errors) is the directory's install count, read beside npm's.

The submission belongs to the organization it is made from: the first to submit a repository folder holds the listing.

## Listing details

- **Name:** `context-doctor` (no `displayName`; the listing shows the name).
- **Short description** (plugin.json): "Cut your Claude Code bill, measured on your own sessions: /context-doctor:fix ranks every fix by what it would have saved you and applies the ones you choose (reversibly), /context-doctor:savings shows the dollars, and an every-prompt check names the waste."
- **Long description:** the build's README (`plugin/README.md`).
- **Publisher:** gAI Ventures (`author`), https://gai.ventures.
- **Links:** documentation https://github.com/KushalP1/context-doctor#readme · support https://github.com/KushalP1/context-doctor/issues · privacy https://github.com/KushalP1/context-doctor/blob/main/docs/privacy.md · no terms of service (MIT).
- **Icon:** `assets/icon.png` (512×512 PNG). It becomes the listing icon only on the first save or submission: replace it before then if a different one is wanted.
- **Categories and keywords:** the plugin docs name no category field for a plugin listing; the keywords are plugin.json's (`context`, `tokens`, `cost`, `prompt-caching`, `context-window`, `autopilot`, `hooks`, `mcp`). If the form offers categories: Developer tools, Productivity.
- **Screenshots:** not required for a plugin (the docs ask for carousel screenshots only for MCP Apps). If the form takes them, PNG, at least 1000 px wide: (1) `/context-doctor:fix` in a terminal session, the ranked plan; (2) the Desktop app band above the prompt with **Compact first**; (3) the `/context-doctor-fix` pane with Apply and Undo; (4) `/context-doctor:spend`. Each with the prompt that produced it.
- **Surfaces:** the portal derives them. Claude Code gets everything. Cowork loads the hooks, skills and local MCP server when the session runs on the user's computer. claude.ai chat loads only the skills, which run `node` on the user's Claude Code history and so have nothing to work on there.

## Data handling answers

- **Reads or stores personal data?** It reads, on the user's machine, the usage records Claude Code (and Codex, Gemini CLI, Cursor) already keep, and the transcript of the current session, which Claude Code hands its hooks. It stores token counts, prices, model names, the start of session ids and timestamps under `~/.claude`, a measurement cache under `~/.cache/context-doctor`, and the handoffs a user asks for under `~/.context-doctor/handoffs`. Nothing leaves the machine; nothing reaches the publisher.
- **Sends data to services other than its declared connectors?** No, by default. Only on an explicit user command: `autopilot on` (a 127.0.0.1 proxy forwarding Claude Code's own requests to the Anthropic endpoint they were going to), `analyze --exact` (Anthropic's token counting, with the user's key), `ab --yes` (Anthropic's Messages API with the user's key, or the user's own Claude Code), `pack --semantic` (the user's Ollama).
- **How long it keeps data?** On the user's machine only: ledgers capped in size (oldest first), the cache until its transcripts are gone, the newest 100 handoffs. Deleting the files or `context-doctor uninstall` removes them.
- **Intended for people under 18?** No.

## Permissions the plugin uses, and why

| What | Why |
|---|---|
| Hook `SessionStart` | Session-start state for the price and cold-return checks |
| Hook `UserPromptSubmit` | The every-prompt check: one line when a session is heavy, past a price, or back after the cache expired |
| Hook `PreToolUse`, matcher `Agent\|Task` (10 s) | A subagent's price before it starts |
| Hook `PreModelSwitch` (10 s), in `hooks/hooks.json` | A model switch's re-write price |
| Hook `PreCompact` | Compaction instructions that keep what the session still needs |
| MCP server (stdio, `node dist/mcp.bundle.js`) | `profile_context`, `optimize_context`, `pack_context`, `context_best_practices` (read-only), `save_handoff` (writes one handoff on request, after a consent form where the client shows forms), `recall` (read-only) |
| Mod: `session.measure` + `$.process.run` | Runs `node dist/cli.js mod measure` with Claude Code's rate-limit windows and session cost, so the limits and cost ledgers are kept where the status line never runs |
| Mod: `ui.render` (`AbovePrompt`, `Pane`), `$.ui.*`, `$.clock.*` | The band above the prompt and the `/context-doctor-fix` pane; a 30 s tick for the cache countdown |
| Mod: `command.run`, `$.command.register` | `/context-doctor-fix` |
| Mod: `$.process.run` on a press | `node dist/cli.js fix --apply <id>` / `fix undo <id>`: the CLI's own locked, backed-up, undoable change |
| Mod: `$.session.compact` on a press | **Compact first**, between turns only, never by itself |
| Mod: `$.session.id/model/cwd`, `$.env.get` | Which session to measure; its four `CONTEXT_DOCTOR_*` switches |
| Files | Reads `~/.claude` (transcripts, settings); writes its own `.context-doctor-*` files; writes a Claude Code setting only when the user applies a fix (backup kept, `fix undo` restores it byte for byte) |
| Network | None, except the four opt-in commands above |

The mod makes no `$.http` call, writes no environment variable and no file itself; `CONTEXT_DOCTOR_NO_MOD=1` turns it off. Details: [the mod](./desktop.md).

## How a reviewer can test it

No account and no key are needed. Load the build for one session with `claude --plugin-dir <a checkout of the directory branch>`, or install the repository's own plugin: `/plugin marketplace add KushalP1/context-doctor`, then `/plugin install context-doctor@context-doctor`.

**Sample data** (the "testing account"): the test suite's fixture history (Claude Code sessions with subagents, a workflow and a desktop-app session), dated now:

```bash
git clone https://github.com/KushalP1/context-doctor && cd context-doctor && npm ci && npm run build
SAMPLE=$(mktemp -d)
node -e 'import("./dist/test/history-fixture.js").then(m => m.buildHistory(process.argv[1], Date.now()))' "$SAMPLE"
HOME=$SAMPLE node dist/cli.js fix      # the ranked plan: $127 of input; compact window, autopilot, subagents' model
HOME=$SAMPLE node dist/cli.js spend    # $145 across 276 requests, by project
```

**Example prompts** in Claude Code with the plugin:

1. "What would have cut my Claude Code bill last month? Apply the ones that cost no quality." (`/context-doctor:fix`)
2. "Why is this session so expensive? Check it and fix the top problem." (`/context-doctor:checkup`)
3. "What does every request re-read before my message, and what does it cost?" (`/context-doctor:overhead`)
4. "Answer this from the log without reading all of it: which request failed first?" (`/context-doctor:pack`)

**The mod:** in the Desktop app's Code tab, `/context-doctor-fix` opens the pane; a session over 150k tokens left idle past its cache shows the band with **Compact first**.

## Evidence: the canary

`scripts/canary.mjs` runs the plugin in a real Claude Code with no person and no network: `claude -p --plugin-dir` against a local mock of the Messages API, in a throwaway HOME with a made-up credential. On the directory build, 2.1.325: **GREEN, 26 of 26** (the plugin loads with no `plugin_errors`, its MCP server connects and negotiates MCP 2026-07-28, all five hooks run and exit 0 and say their lines, the PreCompact instructions reach the compaction request, the mod's `session.measure` writes the limits and cost ledgers, context-doctor's price within 2% of Claude Code's, `validate --profile directory --strict` passes, nothing tried to reach another host). On the `--no-mod` build: everything but the four mod checks green, as expected. `verify-local.sh` and the weekly canary workflow (npm's newest Claude Code) validate both builds strictly and run the canary on the build. Details: [CONTRIBUTING](../CONTRIBUTING.md#checks-beyond-npm-test).

## What a reviewer may raise

- **Held, unavoidable:** "Scripts the validator couldn't follow" (every hook and the server run `node` on files in the plugin), the MCP server's bundle over 256 KiB (1.8 MB, readable), and the hooks module under the portal's own rules.
- **Policy 1G** ("must not query or extract data from … chat history … must not persistently store or use conversation content …"): context-doctor's function is to measure the user's own Claude Code usage, which means reading local transcripts; it keeps counts and prices, not content. `save_handoff` stores a chat summary, only on the user's request (with a consent form where the client shows forms). The README and privacy policy say both plainly. This is the most likely question.
- **Policy 2D** (no coercing Claude into calling tools): the MCP server's instructions ask Claude to call `profile_context` before answering questions about tokens or cost, and once a chat is long. These are its own tools, on the user's topic; if a reviewer objects, the instructions in `src/rules.ts` are where to soften it.
- **Fix writes Claude Code settings** (a model, a compaction window, a cache lifetime, autopilot's `ANTHROPIC_BASE_URL`): only on the user's yes, each with a backup and `fix undo`. The security scan looks for "changing Claude's permission settings"; no fix touches permissions.
- **The name:** `context-doctor` is not reserved; whether another organization took it is shown only by **Validate**.

## Fallback: without the mod

If the portal blocks the hooks module or a reviewer refuses it, submit `node scripts/build-directory-plugin.mjs --no-mod --validate` instead: the same plugin without `modules` in `hooks/hooks.json` and without `dist/mod/` (113 files, strict-clean, no notes). Directory users then get the hooks, skills and MCP server; the band, **Compact first**, `/context-doctor-fix` and the ledgers the mod keeps stay with this repository's own marketplace (`/plugin marketplace add KushalP1/context-doctor`) and `context-doctor install`, which enables that plugin on Claude Code 2.1.286+.

## Option not recommended: the repository root

Submitting the root (no plugin path, branch `main`) needs no build, but the portal would hold it for 949 files, `package.json` beside `package-lock.json` (a dependency install), four files over 256 KiB and a minified server, and the listing would have no privacy or support link (the root manifest keeps none, for 2.1.62-2.1.75). The README it would show is the whole project's, not the plugin's.
