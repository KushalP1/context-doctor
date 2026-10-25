#!/bin/bash
# Full local verification: build, tests, end-to-end smokes, the published npm
# package, Python, every CLI command on this machine's real history (read-only:
# anything that writes the ledger runs in a throwaway HOME), install/uninstall
# in a throwaway HOME, and the GitHub Action's steps.
#   bash scripts/verify-local.sh
R="$(cd "$(dirname "$0")/.." && pwd)"
cd $R || exit 1
pass=0; fail=0; FAILS=()
ok(){ echo "✓ $1"; pass=$((pass+1)); }
bad(){ echo "✗ $1"; fail=$((fail+1)); FAILS+=("$1"); }
run(){ local name="$1"; shift; local out; out=$("$@" 2>&1); local st=$?; if [ $st -eq 0 ]; then ok "$name"; else bad "$name (exit $st)"; echo "$out" | tail -8 | sed 's/^/    /'; fi; }
sb(){ mktemp -d; }

echo "== 1. Build and unit tests"
run "npm ci (clean install)" npm ci --silent
run "build" npm run build --silent
out=$(npm test 2>&1); echo "$out" | grep -qE "^ℹ fail 0" && ok "npm test: $(echo "$out" | grep -E '^ℹ pass' )" || { bad "npm test"; echo "$out" | grep -E "^✖" | head; }
run "committed dist/ matches src/" git diff --exit-code --quiet -- dist

echo "== 2. End-to-end smoke (local mocks, throwaway HOME)"
run "MCP over stdio (local build)" env HOME=$(sb) node scripts/smoke-mcp.mjs node dist/mcp.js
P=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
H=$(sb); HOME=$H node dist/mcp.js --http --port $P >/dev/null 2>&1 & MP=$!; sleep 1.5
run "MCP over streamable HTTP" env HOME=$H node scripts/smoke-mcp.mjs --http http://127.0.0.1:$P/mcp
kill $MP 2>/dev/null
run "OpenAI proxy + autopilot" env HOME=$(sb) node scripts/smoke-openai-proxy.mjs
run "Gemini proxy + autopilot" env HOME=$(sb) node scripts/smoke-gemini-proxy.mjs
run "Codex (real binary, if installed) through autopilot" env HOME=$(sb) node scripts/smoke-codex.mjs

echo "== 3. Published npm package"
v=$(npm view context-doctor version); [ "$v" = "$(node -p 'require("./package.json").version')" ] && ok "npm latest = repo version ($v)" || bad "npm $v vs repo $(node -p 'require("./package.json").version')"
run "npx context-doctor@$v mcp (published)" env HOME=$(sb) node scripts/smoke-mcp.mjs npx -y context-doctor@$v mcp
run "npx context-doctor@$v --version" bash -c "[ \"\$(npx -y context-doctor@$v --version)\" = \"$v\" ]"

echo "== 4. Python package"
for py in /usr/bin/python3 /opt/homebrew/bin/python3.11 /opt/homebrew/bin/python3; do
  run "Python $($py -c 'import sys;print(sys.version.split()[0])') unit + parity" env PYTHONPATH=python/src $py -m unittest discover -s python/tests -q
done
cp python/tests/parity.json /tmp/cd-parity-before.json; node scripts/gen-python-parity.mjs >/dev/null
run "parity fixtures current with the TypeScript" cmp -s /tmp/cd-parity-before.json python/tests/parity.json
V=$(sb)/venv; python3 -m venv $V && $V/bin/pip -q install ./python >/dev/null 2>&1
run "Python wheel installs and imports from a clean venv" bash -c "cd /tmp && $V/bin/python -c 'import context_doctor as c; assert c.pack_documents([\"rotate keyctl\"],\"rotate\").selected'"

echo "== 5. CLI on real history (read-only)"
cd "$R/.."
for cmd in "doctor" "savings --days 7" "cache-misses --days 7" "overhead" "reads --days 7" "tasks --days 7" "session" "compact-window status" "autopilot status" "accuracy --limit 3" "report" "statusline </dev/null" "instructions" "init" "--version"; do
  out=$(eval node $R/dist/cli.js $cmd 2>&1); st=$?
  if [ $st -eq 0 ] && ! echo "$out" | grep -qiE "TypeError|ReferenceError|undefined is not|NaN|Cannot read"; then ok "cli: $cmd"; else bad "cli: $cmd (exit $st)"; echo "$out" | tail -5 | sed 's/^/    /'; fi
done
cd $R
run "cli: analyze example" env HOME=$(sb) node dist/cli.js analyze examples/sample-conversation.json --model claude-sonnet-5
run "cli: optimize example" env HOME=$(sb) bash -c "node dist/cli.js optimize examples/sample-conversation.json --out /tmp/cd-opt.json && node -e 'JSON.parse(require(\"fs\").readFileSync(\"/tmp/cd-opt.json\"))'"
run "cli: pack README with query" bash -c "node dist/cli.js pack README.md -q 'autopilot proxy' | head -1 | grep -q '^PACKED'"
run "cli: pack folder respects .gitignore" bash -c "node dist/cli.js pack . -q 'ledger rotation' | head -1 | grep -q '^PACKED'"
run "cli: overhead split plan (no write)" bash -c "cp README.md /tmp/cd-split.md && node dist/cli.js overhead split /tmp/cd-split.md >/dev/null && cmp -s README.md /tmp/cd-split.md"
run "cli: ci vs HEAD~5" node dist/cli.js ci --base HEAD~5
run "cli: diff two profiles" env HOME=$(sb) bash -c "node dist/cli.js analyze examples/sample-conversation.json --json > /tmp/a.json && node dist/cli.js diff /tmp/a.json /tmp/a.json"

echo "== 6. install/uninstall round trip in a throwaway HOME"
H=$(sb); mkdir -p $H/.claude $H/.cursor $H/.codex $H/.gemini $H/.copilot $H/Library/Application\ Support/Claude; echo '{}' > $H/.gemini/settings.json
# COPILOT_HOME would point Copilot's files outside the throwaway HOME: unset it.
run "install (all apps)" env -u COPILOT_HOME HOME=$H USERPROFILE=$H node dist/cli.js install
run "doctor after install" bash -c "env -u COPILOT_HOME HOME=$H node dist/cli.js doctor | grep -q 'All good'"
run "uninstall" env -u COPILOT_HOME HOME=$H node dist/cli.js uninstall
run "nothing of ours left" bash -c "! grep -rl 'context-doctor' $H/.claude/settings.json $H/.cursor/mcp.json $H/.codex/config.toml $H/.gemini/settings.json $H/.copilot 2>/dev/null | grep -q ."

echo "== 7. GitHub Action steps (simulated runner)"
G=$(sb); cd $G && git init -q && printf '# P\n\nRules.\n' > CLAUDE.md && git add -A && git -c user.email=t@t -c user.name=t commit -qm base && B=$(git rev-parse HEAD) && python3 -c "print('Long reference. '*900)" >> CLAUDE.md
step=$(node -e 'const y=require("fs").readFileSync(process.argv[1],"utf8");const i=y.indexOf("set +e");const j=y.indexOf("    - if:",i);process.stdout.write(y.slice(i,j).split("\n").map(l=>l.replace(/^        /,"")).join("\n"))' "$R/action.yml")
T=$(sb); env BASE_SHA=$B MAX_TOKENS="" MAX_INCREASE=1000 REQUESTS_PER_DAY=1000 MODEL=claude-sonnet-5 CD_VERSION=local GITHUB_ACTION_PATH=$R RUNNER_TEMP=$T GITHUB_OUTPUT=$T/out GITHUB_STEP_SUMMARY=$T/sum bash -c "$step" >/dev/null 2>&1
grep -q "status=1" $T/out && grep -q "<!-- context-doctor -->" $T/sum && ok "GitHub Action (local build): over-budget PR fails, summary written" || { bad "GitHub Action"; cat $T/out; }
cd $R

echo; echo "== RESULT: $pass passed, $fail failed"; for f in "${FAILS[@]}"; do echo "   - $f"; done
