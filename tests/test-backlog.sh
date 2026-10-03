#!/usr/bin/env bash
# Test: `loki backlog` (headless backlog runner, D51) and loki.yaml validation.
#
# Everything external is mocked: `gh` is a fake on PATH, the per-issue launcher
# is LOKI_BACKLOG_LAUNCHER (a script that records its own concurrency), and
# HOME is a scratch dir so the real ~/.loki/loki.yaml never leaks in.
#
# Covers: config validation (good, bad, env override, lookup order), --dry-run,
# concurrency cap, exit codes, per-issue worktree+branch, daily budget stop, and
# that the PAT value never reaches stdout, stderr or any log.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
export LOKI_NO_BROWSER=1

TO=""
if command -v timeout >/dev/null 2>&1; then TO="timeout -k 10 120"
elif command -v gtimeout >/dev/null 2>&1; then TO="gtimeout -k 10 120"; fi

PASS=0; FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
fail() { echo "[FAIL] $1 -- $2"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-backlog-test.XXXXXXXX")"
trap 'rm -rf "$TMP"' EXIT
TMP="$(cd "$TMP" && pwd -P)"

SENTINEL="ghp_SENTINELTOKEN0123456789abcdefghijkl"
export HOME="$TMP/home"; mkdir -p "$HOME"
BIN="$TMP/bin"; mkdir -p "$BIN"

# Fake gh: logs argv and the token env, serves $TMP/issues.json for `issue list`.
cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$MOCK_DIR/gh.args"
echo "${GH_TOKEN:-unset}" >> "$MOCK_DIR/gh.token"
if [ "$1 $2" = "issue list" ]; then cat "$MOCK_DIR/issues.json"; exit 0; fi
exit 0
EOF
chmod +x "$BIN/gh"
export MOCK_DIR="$TMP"
export PATH="$BIN:$PATH"

# Mock launcher: $1 = owner/repo#N. Records concurrency, cwd and branch.
# Behaviour per issue comes from $MOCK_DIR/outcomes ("N:exit:kind").
cat > "$TMP/launcher.sh" <<'EOF'
#!/usr/bin/env bash
ref="$1"; n="${ref##*#}"
echo "$n $(pwd -P) $(git branch --show-current)" >> "$MOCK_DIR/launches"
if [ -d node_modules ]; then echo "$n" >> "$MOCK_DIR/nm"; fi
mkdir "$MOCK_DIR/lock.$n"
cur=$(ls -d "$MOCK_DIR"/lock.* | wc -l | tr -d ' ')
echo "$cur" >> "$MOCK_DIR/conc"
sleep 1
rule="$(grep "^$n:" "$MOCK_DIR/outcomes" 2>/dev/null | head -1)"
code="$(echo "$rule" | cut -d: -f2)"; kind="$(echo "$rule" | cut -d: -f3)"
echo "token seen by launcher: ${GH_TOKEN:-unset}"
case "$kind" in
  pr)      echo "Outcome:    VERIFIED"; echo "PR:         https://github.com/acme/widgets/pull/10$n"
           echo "Cost:       \$${MOCK_COST:-0.50} (claude, 10k tokens)" ;;
  nopr)    echo "Outcome:    VERIFIED"; echo "PR:         none"; echo "Cost:       not measured" ;;
  blocked) echo "Outcome:    BLOCKED"; echo "Reason:     spec conflict: should the API return 404 or 410?"
           echo "PR:         none" ;;
  failed)  echo "Outcome:    FAILED"; echo "Reason:     tests failed: 3 failing"; echo "PR:         none" ;;
esac
rmdir "$MOCK_DIR/lock.$n"
exit "${code:-0}"
EOF
chmod +x "$TMP/launcher.sh"
export LOKI_BACKLOG_LAUNCHER="$TMP/launcher.sh"

# Fixture repo whose origin matches acme/widgets.
REPO="$TMP/repo"
git init -q "$REPO"
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$REPO" remote add origin https://github.com/acme/widgets.git
cd "$REPO" || exit 1

issues5='[{"number":1,"title":"a","labels":[{"name":"bug"}]},{"number":2,"title":"b","labels":[]},{"number":3,"title":"c","labels":[]},{"number":4,"title":"d","labels":[]},{"number":5,"title":"e","labels":[]}]'
reset_mock() { rm -rf "$TMP"/lock.* "$TMP"/launches "$TMP"/conc "$TMP"/gh.args "$TMP"/gh.token "$TMP"/outcomes "$HOME/.loki"; : > "$TMP/outcomes"; }
run() { $TO bash "$LOKI" "$@"; }

write_yaml() { cat > "$1"; }

# ---- Config validation -------------------------------------------------------
echo "== config validation"
reset_mock
write_yaml loki.yaml <<'EOF'
provider: claude
models:
  default: sonnet
  cheap: haiku
git:
  token_env: MY_PAT
repos:
  - acme/widgets
concurrency: 2
budgets:
  per_run_usd: 5
  per_day_usd: 50
knowledge_sources:
  - ./docs
notifications:
  slack_webhook_env: MY_SLACK
EOF
out="$(run config validate 2>&1)"; rc=$?
[ $rc -eq 0 ] && pass "valid loki.yaml validates (rc 0)" || fail "valid loki.yaml" "rc=$rc out=$out"

out="$(run config validate "$REPO_ROOT/docs/loki.yaml.example" 2>&1)"; rc=$?
[ $rc -eq 0 ] && pass "docs/loki.yaml.example validates" || fail "example file" "rc=$rc $out"

write_yaml loki.yaml <<EOF
concurrency: 0
bogus_key: 1
git:
  token_env: $SENTINEL
repos:
  - not-a-repo
budgets:
  per_day_usd: -3
EOF
out="$(run config validate 2>&1)"; rc=$?
[ $rc -ne 0 ] && pass "bad loki.yaml fails (rc $rc)" || fail "bad loki.yaml accepted" "$out"
for want in concurrency bogus_key token_env repos per_day_usd; do
  echo "$out" | grep -q "$want" && pass "error names $want" || fail "error names $want" "$out"
done
echo "$out" | grep -q "$SENTINEL" && fail "validator echoed the token value" "$out" || pass "validator never echoes a pasted token"

write_yaml loki.yaml <<'EOF'
concurrency: 2
EOF
out="$(LOKI_BACKLOG_CONCURRENCY=abc run config validate 2>&1)"; rc=$?
{ [ $rc -ne 0 ] && echo "$out" | grep -q LOKI_BACKLOG_CONCURRENCY; } && pass "bad env override rejected, names the variable" || fail "bad env override" "rc=$rc $out"

reset_mock; echo "$issues5" > "$TMP/issues.json"
out="$(LOKI_BACKLOG_CONCURRENCY=4 run backlog acme/widgets --all --dry-run 2>&1)"
echo "$out" | grep -q "concurrency 4" && pass "env override beats loki.yaml" || fail "env override" "$out"

rm -f loki.yaml; mkdir -p "$HOME/.loki"; printf 'concurrency: 5\n' > "$HOME/.loki/loki.yaml"
out="$(run backlog acme/widgets --all --dry-run 2>&1)"
echo "$out" | grep -q "concurrency 5" && pass "falls back to ~/.loki/loki.yaml" || fail "home fallback" "$out"
printf 'concurrency: 3\n' > loki.yaml
out="$(run backlog acme/widgets --all --dry-run 2>&1)"
echo "$out" | grep -q "concurrency 3" && pass "repo loki.yaml wins over home" || fail "repo precedence" "$out"
out="$(run backlog acme/widgets --all --dry-run --concurrency 1 2>&1)"
echo "$out" | grep -q "concurrency 1" && pass "--concurrency beats config" || fail "flag precedence" "$out"
rm -f loki.yaml

# ---- Dry run -----------------------------------------------------------------
echo "== dry-run"
reset_mock; echo "$issues5" > "$TMP/issues.json"
out="$(run backlog acme/widgets --all --dry-run 2>&1)"; rc=$?
[ $rc -eq 0 ] && pass "--all --dry-run exits 0" || fail "--dry-run rc" "$rc $out"
n="$(echo "$out" | grep -c 'would run')"
[ "$n" -eq 5 ] && pass "lists all 5 mocked issues" || fail "dry-run list count" "$n: $out"
[ ! -f "$TMP/launches" ] && pass "dry-run launches nothing" || fail "dry-run launched" "$(cat "$TMP/launches")"
grep -q -- '--state open' "$TMP/gh.args" && pass "queries open issues via gh" || fail "gh args" "$(cat "$TMP/gh.args")"

run backlog acme/widgets --label bug --dry-run >/dev/null 2>&1
grep -q -- '--label bug' "$TMP/gh.args" && pass "--label forwarded to gh" || fail "--label" "$(cat "$TMP/gh.args")"

out="$(run backlog acme/widgets --issues 7,9 --dry-run 2>&1)"
{ echo "$out" | grep -q '#7' && echo "$out" | grep -q '#9' && [ "$(echo "$out" | grep -c 'would run')" -eq 2 ]; } && pass "--issues 7,9 lists exactly those" || fail "--issues" "$out"

# ---- Usage errors ------------------------------------------------------------
echo "== usage errors"
run backlog acme/widgets >/dev/null 2>&1; rc=$?
[ $rc -eq 2 ] && pass "no selector exits 2" || fail "no selector rc" "$rc"
run backlog notarepo --all --dry-run >/dev/null 2>&1; rc=$?
[ $rc -eq 2 ] && pass "malformed owner/repo exits 2" || fail "bad repo rc" "$rc"
run backlog acme/widgets --issues x,y --dry-run >/dev/null 2>&1; rc=$?
[ $rc -eq 2 ] && pass "non-numeric --issues exits 2" || fail "bad issues rc" "$rc"
run backlog other/thing --all --dry-run >/dev/null 2>&1; rc=$?
[ $rc -eq 2 ] && pass "repo not matching origin exits 2" || fail "origin mismatch rc" "$rc"

# ---- Concurrency cap + per-issue worktree ------------------------------------
echo "== concurrency"
reset_mock; echo "$issues5" > "$TMP/issues.json"
for i in 1 2 3 4 5; do echo "$i:0:pr" >> "$TMP/outcomes"; done
out="$(run backlog acme/widgets --all --concurrency 2 2>&1)"; rc=$?
[ $rc -eq 0 ] && pass "all PRs -> exit 0" || fail "all-success rc" "$rc $out"
max="$(sort -n "$TMP/conc" | tail -1)"
[ "$max" -eq 2 ] && pass "max parallel == 2 (cap honoured and used)" || fail "max parallel" "max=$max"
echo "$out" | grep -q '#1 queued' && echo "$out" | grep -q '#1 running' && echo "$out" | grep -q '#1 PR https://github.com/acme/widgets/pull/101' \
  && pass "per-issue status lines (queued, running, PR url)" || fail "status lines" "$out"
echo "$out" | grep -qi 'summary' && pass "summary table printed" || fail "summary" "$out"
cut -d' ' -f2 "$TMP/launches" | sort -u | wc -l | grep -q '^ *5$' && pass "each issue ran in its own worktree" || fail "worktrees" "$(cat "$TMP/launches")"
grep -q ' loki/backlog-3$' "$TMP/launches" && pass "each issue on its own branch (loki/backlog-N)" || fail "branches" "$(cat "$TMP/launches")"
[ "$(git -C "$REPO" status --porcelain | wc -l | tr -d ' ')" = "0" ] && pass "base checkout left clean" || fail "base dirty" "$(git -C "$REPO" status --porcelain)"

# ---- Exit codes --------------------------------------------------------------
echo "== exit codes"
reset_mock; echo "$issues5" > "$TMP/issues.json"
printf '1:0:pr\n2:4:blocked\n3:1:failed\n4:0:nopr\n5:0:pr\n' > "$TMP/outcomes"
out="$(run backlog acme/widgets --all --concurrency 3 2>&1)"; rc=$?
[ $rc -ne 0 ] && pass "any non-PR issue -> non-zero exit" || fail "mixed rc" "$rc"
echo "$out" | grep -q '#2 BLOCKED: spec conflict: should the API return 404 or 410?' && pass "BLOCKED line carries the question" || fail "BLOCKED line" "$out"
echo "$out" | grep -q '#3 FAILED: tests failed: 3 failing' && pass "FAILED line carries the reason" || fail "FAILED line" "$out"
echo "$out" | grep -q '#4 VERIFIED' && pass "VERIFIED with no PR is a success state" || fail "VERIFIED line" "$out"

reset_mock; echo "$issues5" > "$TMP/issues.json"
printf '1:0:pr\n2:0:nopr\n' > "$TMP/outcomes"
run backlog acme/widgets --issues 1,2 >/dev/null 2>&1; rc=$?
[ $rc -eq 0 ] && pass "PR + VERIFIED only -> exit 0" || fail "success rc" "$rc"

# ---- Daily budget ------------------------------------------------------------
echo "== budget"
reset_mock; echo "$issues5" > "$TMP/issues.json"
printf 'budgets:\n  per_day_usd: 1.0\n' > loki.yaml
for i in 1 2 3; do echo "$i:0:pr" >> "$TMP/outcomes"; done
out="$(MOCK_COST=0.60 run backlog acme/widgets --issues 1,2,3 --concurrency 1 2>&1)"; rc=$?
[ "$(wc -l < "$TMP/launches" | tr -d ' ')" = "2" ] && pass "third run not launched once the daily budget is hit" || fail "budget launches" "$(cat "$TMP/launches") $out"
echo "$out" | grep -q '#3 BUDGET_STOP' && pass "BUDGET_STOP line for the unlaunched issue" || fail "BUDGET_STOP line" "$out"
[ $rc -ne 0 ] && pass "budget stop -> non-zero exit" || fail "budget rc" "$rc"
rm -f "$TMP/launches"
out="$(MOCK_COST=0.60 run backlog acme/widgets --issues 1 2>&1)"; rc=$?
{ [ ! -f "$TMP/launches" ] && echo "$out" | grep -q BUDGET_STOP; } && pass "spend persists across invocations (same day)" || fail "ledger" "$out"

reset_mock
printf '1:0:nopr\n2:0:nopr\n' > "$TMP/outcomes"
out="$(run backlog acme/widgets --issues 1,2 --concurrency 1 2>&1)"
[ "$(wc -l < "$TMP/launches" | tr -d ' ')" = "2" ] && pass "unmeasured cost is not counted as \$0 spend or a stop" || fail "unmeasured" "$out"
echo "$out" | grep -qi 'unmeasured\|not measured' && pass "summary reports unmeasured cost" || fail "unmeasured text" "$out"
rm -f loki.yaml

# ---- Shared worktree prep (D51-B05) ------------------------------------------
echo "== worktree prep"
printf 'node_modules/\n' > "$REPO/.gitignore"
git -C "$REPO" add .gitignore
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q -m ignore
mkdir -p "$REPO/node_modules/pkg"; echo x > "$REPO/node_modules/pkg/index.js"
for flag in 1 0; do
  reset_mock; rm -f "$TMP/nm"; echo "$issues5" > "$TMP/issues.json"; echo "1:0:pr" > "$TMP/outcomes"
  out="$(LOKI_WORKSPACES=$flag run backlog acme/widgets --issues 1 --concurrency 1 2>&1)"; rc=$?
  if [ "$flag" = 1 ]; then
    { [ $rc -eq 0 ] && [ -f "$TMP/nm" ]; } && pass "adopted prep: JS worktree has node_modules" || fail "adopted prep deps" "rc=$rc $out"
  else
    { [ $rc -eq 0 ] && [ ! -f "$TMP/nm" ]; } && pass "LOKI_WORKSPACES=0: legacy worktree (no deps copy)" || fail "legacy prep" "rc=$rc $out"
  fi
done
rm -rf "$REPO/node_modules" "$REPO/.gitignore"
git -C "$REPO" reset -q --hard HEAD~1

# ---- PAT never printed -------------------------------------------------------
echo "== PAT hygiene"
reset_mock; echo "$issues5" > "$TMP/issues.json"
printf 'git:\n  token_env: MY_PAT\n' > loki.yaml
printf '1:0:pr\n2:1:failed\n' > "$TMP/outcomes"
out="$(MY_PAT="$SENTINEL" run backlog acme/widgets --all --concurrency 2 2>&1)"
echo "$out" | grep -q "$SENTINEL" && fail "PAT in backlog output" "$out" || pass "PAT absent from stdout/stderr"
grep -q "$SENTINEL" "$TMP/gh.args" && fail "PAT in gh argv" "" || pass "PAT never in gh argv"
grep -q "$SENTINEL" "$TMP/gh.token" && pass "PAT delivered to gh via GH_TOKEN env" || fail "PAT not delivered to gh" "$(cat "$TMP/gh.token")"
leak="$(grep -rl "$SENTINEL" "$TMP/repo" "$TMP"/repo-backlog "$HOME" 2>/dev/null | head -3)"
[ -z "$leak" ] && pass "PAT absent from logs and state files (launcher echoed it)" || fail "PAT in files" "$leak"
out="$(env -u MY_PAT $TO bash "$LOKI" backlog acme/widgets --all --dry-run 2>&1)"; rc=$?
{ [ $rc -eq 2 ] && echo "$out" | grep -q MY_PAT; } && pass "unset token env var named in a clear error (rc 2)" || fail "unset PAT" "rc=$rc $out"
rm -f loki.yaml

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
