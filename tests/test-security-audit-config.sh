#!/usr/bin/env bash
# tests/test-security-audit-config.sh
#
# E-114: guards scripts/security-audit-gitleaks.sh, the command shape behind
# .github/workflows/security-audit.yml's "gitleaks scan (all reachable
# history)" step. THE BUG: `gitleaks git .` loads the checked-out tree's OWN
# .gitleaks.toml (gitleaks' own precedence: -c/--config, then env
# GITLEAKS_CONFIG, then env GITLEAKS_CONFIG_TOML, then <target path>/
# .gitleaks.toml, else its embedded default). A pushed commit that ships a
# zero-rule .gitleaks.toml (`title = "x"`) therefore disables secret scanning
# for that same push -- a reviewer reproduced this against the pre-push hook
# (E-110), and the CI step used the same no-`--config` shape.
#
# Drives the real script against disposable scratch repos with the real
# pinned gitleaks binary when one is on PATH (SKIP, never a silent pass,
# otherwise). Per CLAUDE.md, a test fixture that looks like a secret must be
# built at runtime by string concatenation so gitleaks never sees a literal
# in this file's own committed bytes.

# shellcheck disable=SC2015,SC2016
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/security-audit-gitleaks.sh"

PASS=0
FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=== security-audit.yml gitleaks config isolation (E-114) ==="

[ -f "$SCRIPT" ] || { echo "  FAIL: $SCRIPT missing"; exit 1; }
[ -x "$SCRIPT" ] || { echo "  FAIL: $SCRIPT is not executable"; exit 1; }

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-e114-test.XXXXXX")"
cleanup() { rm -rf -- "$TMP_ROOT"; }
trap cleanup EXIT

SA_YML="$REPO_ROOT/.github/workflows/security-audit.yml"
REL_YML="$REPO_ROOT/.github/workflows/release.yml"

# --- D75 workflow-text checks (W7, W8): need no gitleaks binary -------------
# Extract the real text from the workflow files so the test exercises it, not a copy.
cat > "$TMP_ROOT/extract.py" <<'PYEOF'
import re, sys, yaml
kind, out = sys.argv[1], sys.argv[2]
sa = open(sys.argv[3]).read()
rel = open(sys.argv[4]).read()
if kind == "step":
    d = yaml.safe_load(sa)
    steps = d["jobs"]["secret-scan"]["steps"]
    run = [s["run"] for s in steps if s.get("name", "").startswith("Select gitleaks scan mode")]
    assert len(run) == 1, "expected exactly one scan-mode step"
    open(out, "w").write(run[0])
elif kind == "jq":
    m = re.findall(r"--jq '(\.workflow_runs\[\][^\n]*)' 2>/dev/null", rel)
    assert len(m) == 1, "expected exactly one fetch_runs jq filter"
    open(out, "w").write(m[0])
elif kind == "sfn":
    out_s = ""
    for fn in ("sched_audit_api", "sched_audit_fetch", "sched_audit_ok", "sched_audit_gate"):
        m = re.findall(r"^ {10}" + fn + r"\(\) \{\n(.*?\n) {10}\}\n", rel, re.S | re.M)
        assert len(m) == 1, "expected exactly one " + fn
        out_s += fn + "() {\n" + m[0] + "}\n"
    open(out, "w").write(out_s)
elif kind == "awk":
    m = re.findall(r"'(\$1==\"Security Audit\"[^\n]*END\{print c\})'", rel)
    assert len(m) == 1, "expected exactly one audit_verdict awk program"
    open(out, "w").write(m[0])
elif kind == "if":
    d = yaml.safe_load(sa)
    job = sys.argv[5]
    open(out, "w").write(d["jobs"][job]["if"])
PYEOF
_extract() { python3 "$TMP_ROOT/extract.py" "$1" "$2" "$SA_YML" "$REL_YML" "${3:-}"; }

# W7: release.yml required-ci counts a Security Audit run only from main or a dispatch.
if command -v jq >/dev/null 2>&1; then
  _extract jq "$TMP_ROOT/fetch.jq" && _extract awk "$TMP_ROOT/verdict.awk"
  _w7() { # _w7 <jq-prog-file> ; 0 = filter behaves per D75
    local prog parent_train parent_main parent_disp tests_train
    prog="$(cat "$1")"
    _mk_blob() { # branch event conclusion name
      printf '{"workflow_runs":[{"name":"%s","status":"completed","conclusion":"%s","created_at":"2026-10-03T00:00:00Z","event":"%s","head_branch":"%s"}]}' "$4" "$3" "$2" "$1"
    }
    _verdict() { jq -r "$prog" | awk -F'\t' "$(cat "$TMP_ROOT/verdict.awk")"; }
    parent_train="$(_mk_blob train/x push success 'Security Audit' | _verdict)"
    parent_main="$(_mk_blob main push success 'Security Audit' | _verdict)"
    parent_disp="$(_mk_blob train/x workflow_dispatch success 'Security Audit' | _verdict)"
    tests_train="$(_mk_blob train/x push success 'Tests' | jq -r "$prog" | awk -F'\t' '$1=="Tests"&&$3=="success"{print "kept"}')"
    [ -z "$parent_train" ] && [ "$parent_main" = "success" ] && [ "$parent_disp" = "success" ] && [ "$tests_train" = "kept" ]
  }
  if _w7 "$TMP_ROOT/fetch.jq"; then
    ok "W7: a train/** push Security Audit success is not reused; main push and dispatch successes are; Tests on a train branch is untouched"
  else
    bad "W7: required-ci Security Audit filter does not match D75"
  fi
  # mutation: drop the D75 select clause -> the train success is reused -> must go red
  python3 - "$TMP_ROOT/fetch.jq" "$TMP_ROOT/fetch.mut.jq" <<'PYEOF'
import sys
s = open(sys.argv[1]).read()
m = ' | select(.name!="Security Audit" or .head_branch=="main" or .event=="workflow_dispatch")'
assert m in s
open(sys.argv[2], "w").write(s.replace(m, ""))
PYEOF
  if _w7 "$TMP_ROOT/fetch.mut.jq"; then
    bad "W7 mutation (filter removed) stayed green: the check cannot see the guard"
  else
    ok "W7 mutation (filter removed) goes red"
  fi
else
  bad "W7: jq is required for this test"
fi

# W9: a red daily scheduled scan halts releases unless a newer successful main run
# supersedes it; an API error blocks; paging cannot hide the scheduled run (release.yml
# required-ci, D75/D75b). The stub gh below emulates the Actions API filters
# (event, branch, status=success, created>=, per_page, total_count, newest first)
# so the REAL extracted gate functions run unchanged.
if command -v jq >/dev/null 2>&1; then
  _extract sfn "$TMP_ROOT/sched.fn.sh"
  cat > "$TMP_ROOT/gh-stub.sh" <<'STUBEOF'
gh() {
  local url="$2" p="" kv q ev="" br="" st="" cr="" pp=100 n
  shift 2
  while [ $# -gt 0 ]; do [ "$1" = --jq ] && p="$2"; shift; done
  if [ -n "${W9_FLAKY:-}" ]; then
    n="$(cat "$W9_FLAKY" 2>/dev/null || echo 0)"; echo $((n + 1)) > "$W9_FLAKY"
    [ "$n" -ge 2 ] || return 1
  fi
  q="${url#*\?}"
  local IFS='&'
  for kv in $q; do
    case "$kv" in
      event=*) ev="${kv#event=}" ;;
      branch=*) br="${kv#branch=}" ;;
      status=*) st="${kv#status=}" ;;
      created=*) cr="${kv#created=%3E%3D}" ;;
      per_page=*) pp="${kv#per_page=}" ;;
    esac
  done
  if [ -n "${W9_RAW_SCHED:-}" ] && [ "$ev" = schedule ]; then
    printf '%s' "$W9_RAW_SCHED" | jq -r "$p"
    return
  fi
  printf '%s' "$BLOB" | jq --arg ev "$ev" --arg br "$br" --arg st "$st" --arg cr "$cr" --argjson pp "$pp" '
    ([.workflow_runs[] | select(.status=="completed")
      | select($ev=="" or .event==$ev) | select($br=="" or .head_branch==$br)
      | select($st!="success" or .conclusion=="success") | select($cr=="" or .created_at >= $cr)]
     | sort_by(.created_at) | reverse) as $all
    | {total_count: ($all|length), workflow_runs: $all[:$pp]}' | jq -r "$p"
}
STUBEOF
  _sched_run() { # _sched_run <fn-file> <runs-json | FAIL> -> prints "<rc>|<output>"
    local out rc=0
    out="$(BLOB="$2" bash -c '
      source "$1"; REPO=x/y; sleep() { :; }
      if [ "$BLOB" = FAIL ]; then gh() { return 1; }; else source "$2"; fi
      sched_audit_gate' _ "$1" "$TMP_ROOT/gh-stub.sh" 2>&1)" || rc=$?
    printf '%s|%s' "$rc" "$out"
  }
  _r() { # name event conclusion created [branch]
    local c="\"$3\""
    [ "$3" = null ] && c=null
    printf '{"name":"Security Audit","status":"completed","conclusion":%s,"created_at":"%s","event":"%s","head_branch":"%s","html_url":"https://example.invalid/runs/%s"}' "$c" "$4" "$2" "${5:-main}" "$1"
  }
  _many() { # _many <count> <event> <conclusion>: <count> main runs all newer than 2026-10-01
    local i out=""
    for i in $(seq 1 "$1"); do
      out="${out:+$out,}$(_r "m$i" "$2" "$3" "$(printf '2026-10-03T%02d:%02d:00Z' $((i / 60)) $((i % 60)))" "${4:-main}")"
    done
    printf '%s' "$out"
  }
  _blob() { local IFS=,; printf '{"workflow_runs":[%s]}' "$*"; }
  _expect() { # _expect <fn> <rc> <substring> <runs-json|FAIL>
    local o
    o="$(_sched_run "$1" "$4")"
    [ "${o%%|*}" = "$2" ] && case "$o" in *"$3"*) true ;; *) false ;; esac
  }
  _w9() { # _w9 <fn-file> ; 0 = every case behaves per D75/D75b
    local f="$1" o
    _expect "$f" 1 "runs/s" "$(_blob "$(_r s schedule failure 2026-10-03T08:00:00Z)" "$(_r p push success 2026-10-03T07:00:00Z)")" || return 1
    _expect "$f" 1 "'cancelled'" "$(_blob "$(_r c schedule cancelled 2026-10-03T08:00:00Z)")" || return 1
    _expect "$f" 1 "'timed_out'" "$(_blob "$(_r t schedule timed_out 2026-10-03T08:00:00Z)")" || return 1
    _expect "$f" 1 "'null'" "$(_blob "$(_r n schedule null 2026-10-03T08:00:00Z)")" || return 1
    _expect "$f" 0 "supersedes" "$(_blob "$(_r p push success 2026-10-03T07:00:00Z)" "$(_r s schedule failure 2026-09-28T07:00:00Z)")" || return 1
    _expect "$f" 0 "supersedes" "$(_blob "$(_r d workflow_dispatch success 2026-10-03T07:00:00Z)" "$(_r s schedule failure 2026-09-28T07:00:00Z)")" || return 1
    # a newer success on a train/** branch does NOT clear it
    _expect "$f" 1 "runs/s" "$(_blob "$(_r tr push success 2026-10-03T09:00:00Z train/x)" "$(_r s schedule failure 2026-10-03T08:00:00Z)")" || return 1
    # a success OLDER than the scheduled failure does not clear it
    _expect "$f" 1 "runs/s" "$(_blob "$(_r s schedule failure 2026-10-03T08:00:00Z)" "$(_r p push success 2026-10-02T07:00:00Z)")" || return 1
    _expect "$f" 0 "succeeded" "$(_blob "$(_r s schedule success 2026-10-03T08:00:00Z)")" || return 1
    # newest scheduled run is the one that counts
    _expect "$f" 0 "succeeded" "$(_blob "$(_r s2 schedule success 2026-10-03T08:00:00Z)" "$(_r s1 schedule failure 2026-10-02T08:00:00Z)")" || return 1
    _expect "$f" 1 "runs/s2" "$(_blob "$(_r s2 schedule failure 2026-10-03T08:00:00Z)" "$(_r s1 schedule success 2026-10-02T08:00:00Z)")" || return 1
    # a non-main scheduled failure (newer) is ignored
    _expect "$f" 0 "succeeded" "$(_blob "$(_r x schedule failure 2026-10-03T09:00:00Z feature)" "$(_r s schedule success 2026-10-03T08:00:00Z)")" || return 1
    # runs exist but none scheduled: passes (the schedule query has total_count 0)
    _expect "$f" 0 "no completed scheduled run" "$(_blob "$(_r p push success 2026-10-03T07:00:00Z)")" || return 1
    _expect "$f" 0 "no completed scheduled run" '{"workflow_runs":[]}' || return 1
    # PAGE-OVERFLOW: 120 newer main push failures push the scheduled failure off any single
    # 100-run page. The old one-page gate passed this as "no scheduled run"; it must block.
    _expect "$f" 1 "runs/s" "$(_blob "$(_r s schedule failure 2026-09-28T07:00:00Z)" "$(_many 120 push failure)")" || return 1
    # same overflow, but 120 newer push successes: the success beyond the old page clears it
    _expect "$f" 0 "supersedes" "$(_blob "$(_r s schedule failure 2026-09-28T07:00:00Z)" "$(_many 120 push success)")" || return 1
    # 120 newer successes on a train branch must not inflate the main total_count: plain red
    _expect "$f" 1 "no newer successful main run" "$(_blob "$(_r s schedule failure 2026-09-28T07:00:00Z)" "$(_many 120 push success train/x)")" || return 1
    # more successes exist than were fetched and none qualifies: indeterminate blocks
    _expect "$f" 1 "indeterminate" "$(_blob "$(_r s schedule failure 2026-09-28T07:00:00Z)" "$(_many 120 pull_request success)")" || return 1
    # schedule query says total_count 5 but returns no run: indeterminate, never "none"
    o="$(W9_RAW_SCHED='{"total_count":5,"workflow_runs":[]}' _sched_run "$f" "$(_blob "$(_r p push success 2026-10-03T07:00:00Z)")")"
    [ "${o%%|*}" = "1" ] && case "$o" in *indeterminate*) true ;; *) false ;; esac || return 1
    # D75b LOW 1: a response with NO total_count and a red scheduled run must block,
    # never be read as "zero runs"
    o="$(W9_RAW_SCHED="{\"workflow_runs\":[$(_r s schedule failure 2026-10-03T08:00:00Z)]}" _sched_run "$f" "$(_blob "$(_r p push failure 2026-10-03T07:00:00Z)")")"
    [ "${o%%|*}" = "1" ] && case "$o" in *"runs/s"*) true ;; *) false ;; esac || return 1
    # two transient gh errors then success: the retry reads the verdict
    : > "$TMP_ROOT/w9.flaky"
    o="$(W9_FLAKY="$TMP_ROOT/w9.flaky" _sched_run "$f" "$(_blob "$(_r s schedule success 2026-10-03T08:00:00Z)")")"
    [ "${o%%|*}" = "0" ] || return 1
    # a failing gh (404, outage) blocks after retries
    _expect "$f" 1 "cannot read scheduled Security Audit runs (API error)" FAIL
  }
  if _w9 "$TMP_ROOT/sched.fn.sh"; then
    ok "W9: scheduled red blocks unless a newer main push or dispatch success supersedes it (including past 100 runs); train success does not; >100 runs, indeterminate and API error block; green, no schedule and zero runs pass with a reason"
  else
    bad "W9: scheduled-audit gate does not match D75/D75b"
  fi
  _w9_mut() { # _w9_mut <name> <old> <new> [<old2> <new2>]
    python3 - "$TMP_ROOT/sched.fn.sh" "$TMP_ROOT/sched.fn.$1.sh" "$2" "$3" "${4:-}" "${5:-}" <<'PYEOF'
import sys
s = open(sys.argv[1]).read()
for old, new in ((sys.argv[3], sys.argv[4]), (sys.argv[5], sys.argv[6])):
    if not old:
        continue
    assert s.count(old) == 1, old
    s = s.replace(old, new)
open(sys.argv[2], "w").write(s)
PYEOF
    if _w9 "$TMP_ROOT/sched.fn.$1.sh"; then bad "W9 mutation ($1) stayed green"; else ok "W9 mutation ($1) goes red"; fi
  }
  _w9_mut noblock 'review it before releasing"; return 1' 'review it before releasing"; return 0'
  _w9_mut nobranchsched 'event=schedule&branch=main&status=completed' 'event=schedule&status=completed'
  _w9_mut nobranchsucc 'branch=main&status=success' 'status=success'
  _w9_mut noclear 'if $n > 0 then "cleared"' 'if false then "cleared"'
  _w9_mut oldsuccess '&created=%3E%3D${created}' '' '.created_at > "'"'"'"$created"'"'"'")' '.created_at > "0")'
  _w9_mut noindet 'elif (.total_count // 0) > ((.workflow_runs // []) | length) then "indeterminate"' 'elif false then "indeterminate"'
  _w9_mut indetpass 'could not be fully read ($url); blocking"; return 1' 'could not be fully read ($url); blocking"; return 0'
  _w9_mut nototalcheck 'if (.total_count == 0 and ((.workflow_runs // []) | length) == 0) then "none"' 'if ((.workflow_runs // []) | length) == 0 then "none"'
  _w9_mut nulltotalzero 'if (.total_count == 0 and ((.workflow_runs // []) | length) == 0) then "none"' 'if (.total_count // 0) == 0 then "none"'
  _w9_mut mixedpage 'event=schedule&branch=main&status=completed&per_page=1' 'branch=main&status=completed&per_page=100'
  _w9_mut failopen '(API error)"
    return 1' '(API error)"
    return 0'
  _w9_mut noretry 'for i in 1 2 3; do' 'for i in 1; do'
  # the gate must actually be called from required-ci and must fail the job
  if grep -qF 'sched_reason="$(sched_audit_gate)"' "$REL_YML" \
     && grep -qF 'FAIL: the daily scheduled Security Audit is not green' "$REL_YML"; then
    ok "W9: required-ci calls the scheduled-audit gate and exits 1 when it blocks"
  else
    bad "W9: required-ci does not call the scheduled-audit gate"
  fi
  grep -vF 'sched_reason="$(sched_audit_gate)"' "$REL_YML" > "$TMP_ROOT/release.nocall.yml"
  if grep -qF 'sched_reason="$(sched_audit_gate)"' "$TMP_ROOT/release.nocall.yml"; then
    bad "W9 mutation (call dropped) stayed green"
  else
    ok "W9 mutation (call dropped) goes red"
  fi
else
  bad "W9: jq is required for this test"
fi

# W8: a main push runs secret-scan even when train-reuse=true; other jobs keep E-160 reuse.
_eval_if() { # _eval_if <if-file> <event> <ref> <reuse> -> prints True/False
  python3 - "$1" "$2" "$3" "$4" <<'PYEOF'
import re, sys
e = open(sys.argv[1]).read().strip()
e = re.sub(r"^\$\{\{\s*|\s*\}\}$", "", e)
ev, ref, reuse = sys.argv[2:5]
e = e.replace("!cancelled()", "True").replace("&&", " and ").replace("||", " or ")
e = e.replace("!=", " __NE__ ")
e = e.replace("github.event_name", repr(ev)).replace("github.ref", repr(ref))
e = e.replace("needs.train-reuse.outputs.reuse", repr(reuse)).replace("__NE__", "!=")
print(bool(eval(e)))
PYEOF
}
_w8() { # _w8 <if-file>
  [ "$(_eval_if "$1" push refs/heads/main true)" = "True" ] \
    && [ "$(_eval_if "$1" push refs/heads/train/x true)" = "False" ] \
    && [ "$(_eval_if "$1" push refs/heads/main false)" = "True" ] \
    && [ "$(_eval_if "$1" push refs/heads/train/x false)" = "True" ]
}
_extract if "$TMP_ROOT/if.secret" secret-scan
if _w8 "$TMP_ROOT/if.secret"; then
  ok "W8: secret-scan runs on a main push even when train-reuse=true, and still skips for a train push with reuse=true"
else
  bad "W8: secret-scan if: does not ignore train reuse on a main push"
fi
printf "%s" "\${{ !cancelled() && needs.train-reuse.outputs.reuse != 'true' }}" > "$TMP_ROOT/if.old"
if _w8 "$TMP_ROOT/if.old"; then
  bad "W8 mutation (pre-D75 if:) stayed green: the check cannot see the guard"
else
  ok "W8 mutation (pre-D75 if:) goes red"
fi
_w8_others=1
for _j in npm-audit python-audit bun-audit; do
  _extract if "$TMP_ROOT/if.$_j" "$_j"
  [ "$(cat "$TMP_ROOT/if.$_j")" = "\${{ !cancelled() && needs.train-reuse.outputs.reuse != 'true' }}" ] || _w8_others=0
done
[ "$_w8_others" -eq 1 ] && ok "W8: npm-audit and bun-audit keep the E-160 reuse condition unchanged" \
  || bad "W8: another job's if: changed"

# D75: the cron is daily
if grep -qF "cron: '0 7 * * *'" "$SA_YML" && ! grep -qF "cron: '0 7 * * 1'" "$SA_YML"; then
  ok "D75: the schedule is daily"
else
  bad "D75: the schedule is not '0 7 * * *'"
fi

# Prefer the pinned binary scripts/install-gitleaks.sh puts on disk, then PATH.
GITLEAKS_BIN=""
# The runner gives suites a hermetic HOME (FC-07); the installed pin lives
# under the real one.
_pinned="${LOKI_REAL_HOME:-$HOME}/.local/share/loki/bin/gitleaks-8.30.0"
if [ -x "$_pinned" ]; then GITLEAKS_BIN="$_pinned"; else GITLEAKS_BIN="$(command -v gitleaks 2>/dev/null || true)"; fi
if [ -z "$GITLEAKS_BIN" ] && [ -n "${CI:-}" ]; then
  echo "  FAIL: no gitleaks binary under CI -- the Wall checks would not run (install scripts/install-gitleaks.sh first)"
  echo
  echo "=== $PASS passed, 1 failed ==="
  exit 1
fi
if [ -z "$GITLEAKS_BIN" ]; then
  echo "  SKIP: no gitleaks binary on PATH -- live scenarios not run (not a pass)"
  echo
  echo "=== $PASS passed, $FAIL failed (live scenarios skipped) ==="
  exit 0
fi

_installed_version="$("$GITLEAKS_BIN" version 2>&1 | tr -d '[:space:]')"
echo "  NOTE: using installed gitleaks ($GITLEAKS_BIN, $_installed_version)."
echo "        security-audit.yml pins v8.30.0; this host has ${_installed_version#Version} -- close enough to exercise the same --config precedence, not a substitute for the pinned CI binary."

_new_repo() {
  local repo="$1"
  git init -q -b main "$repo" >/dev/null
  git -C "$repo" config user.email "e114-test@loki.local"
  git -C "$repo" config user.name "e114 test"
  git -C "$repo" config commit.gpgsign false
  git -C "$repo" config core.hooksPath /dev/null
  : > "$repo/.gitleaksignore"
  printf 'readme\n' > "$repo/README.md"
  git -C "$repo" add .gitleaksignore README.md
  git -C "$repo" commit -qm "baseline" --no-gpg-sign --no-verify
  # r2: the trusted base is now always the nearest release TAG, never a raw
  # commit -- every scratch repo needs at least one so `git describe` has
  # something to find (production main always has release tags too).
  git -C "$repo" tag v1.0.0
}

# Built by concatenation so this file's own committed bytes never carry a
# contiguous AKIA-shaped token.
_akia_prefix='AKIA'
_akia_rest='1234567890ABCDEF'

# --- Scenario A: zero-rule .gitleaks.toml + a real secret, in the range --
# Must be REFUSED, with a clear founder-review message, no automatic bypass.
REPO_A="$TMP_ROOT/repo-refused"
_new_repo "$REPO_A"
BASE_A="$(git -C "$REPO_A" rev-parse HEAD)"
printf 'title = "x"\n' > "$REPO_A/.gitleaks.toml"
printf '%s\n' "const key = \"${_akia_prefix}${_akia_rest}\";" > "$REPO_A/secret.js"
git -C "$REPO_A" add .gitleaks.toml secret.js
git -C "$REPO_A" commit -qm "add zero-rule config and a secret" --no-gpg-sign --no-verify
TIP_A="$(git -C "$REPO_A" rev-parse HEAD)"

# Red-first control: the OLD shape (`gitleaks git .` with no --config, from
# the checkout root) trusts the TIP's own .gitleaks.toml and finds nothing --
# this is the exact bypass E-114 closes.
_old_shape_rc=0
(cd "$REPO_A" && "$GITLEAKS_BIN" git . --log-opts="--all" \
  --gitleaks-ignore-path .gitleaksignore --no-banner --redact >/dev/null 2>&1) || _old_shape_rc=$?
if [ "$_old_shape_rc" -eq 0 ]; then
  ok "RED EVIDENCE: the pre-E-114 command shape (no --config) is bypassed by the tip's own zero-rule .gitleaks.toml"
else
  bad "could not reproduce the bypass with the old command shape -- fixture is not exercising the reported bug"
fi

REPORT_A="$TMP_ROOT/report-a.json"
_out_a="$(cd "$REPO_A" && GITLEAKS_BIN="$GITLEAKS_BIN" GITLEAKS_BEFORE="$BASE_A" \
  GITLEAKS_TIP="$TIP_A" GITLEAKS_REPORT="$REPORT_A" "$SCRIPT" 2>&1)"
_rc_a=$?

if [ "$_rc_a" -ne 0 ]; then
  ok "the fixed script refuses the job (exit $_rc_a) when the range adds a zero-rule .gitleaks.toml"
else
  bad "the fixed script did NOT refuse a range that adds a zero-rule .gitleaks.toml"
fi
if printf '%s' "$_out_a" | grep -q 'founder review'; then
  ok "the refusal names the dedicated-PR founder-review path (no automatic bypass)"
else
  bad "the refusal message does not point to founder review through a dedicated PR"
fi
if [ -f "$REPORT_A" ]; then
  _n_a="$(python3 -c "import json; print(len(json.load(open('$REPORT_A'))))" 2>/dev/null || echo "-1")"
  if [ "$_n_a" -ge 1 ]; then
    ok "defense in depth: even ignoring the refusal, the trusted-base-config scan independently caught $_n_a finding(s) -- the tip's zero-rule config never got used"
  else
    bad "the trusted-base-config scan reported $_n_a findings for a range with a real secret -- --config isolation is not working"
  fi
else
  bad "no report was written for the refused range -- the Upload step would error"
fi

# --- Scenario B: a clean range must pass -----------------------------------
REPO_B="$TMP_ROOT/repo-clean"
_new_repo "$REPO_B"
BASE_B="$(git -C "$REPO_B" rev-parse HEAD)"
printf 'nothing secret here\n' > "$REPO_B/notes.md"
git -C "$REPO_B" add notes.md
git -C "$REPO_B" commit -qm "harmless change" --no-gpg-sign --no-verify
TIP_B="$(git -C "$REPO_B" rev-parse HEAD)"

REPORT_B="$TMP_ROOT/report-b.json"
_out_b="$(cd "$REPO_B" && GITLEAKS_BIN="$GITLEAKS_BIN" GITLEAKS_BEFORE="$BASE_B" \
  GITLEAKS_TIP="$TIP_B" GITLEAKS_REPORT="$REPORT_B" "$SCRIPT" 2>&1)"
_rc_b=$?
if [ "$_rc_b" -eq 0 ]; then
  ok "a clean range (no config change, no secret) passes"
else
  bad "a clean range was refused (exit $_rc_b): $_out_b"
fi
if [ -f "$REPORT_B" ]; then
  _n_b="$(python3 -c "import json; print(len(json.load(open('$REPORT_B'))))" 2>/dev/null || echo "-1")"
  [ "$_n_b" -eq 0 ] && ok "the clean range's report has zero findings" \
    || bad "the clean range's report has $_n_b findings (expected 0)"
else
  bad "no report was written for the clean range"
fi

# --- Scenario C: a .gitleaksignore addition warns, never blocks ------------
REPO_C="$TMP_ROOT/repo-ignoreline"
_new_repo "$REPO_C"
BASE_C="$(git -C "$REPO_C" rev-parse HEAD)"
_added_line="deadbeefcafef00d1234567890abcdef12345678:test-rule:1"
printf '%s\n' "$_added_line" >> "$REPO_C/.gitleaksignore"
git -C "$REPO_C" add .gitleaksignore
git -C "$REPO_C" commit -qm "allowlist a reviewed fingerprint" --no-gpg-sign --no-verify
TIP_C="$(git -C "$REPO_C" rev-parse HEAD)"

REPORT_C="$TMP_ROOT/report-c.json"
_out_c="$(cd "$REPO_C" && GITLEAKS_BIN="$GITLEAKS_BIN" GITLEAKS_BEFORE="$BASE_C" \
  GITLEAKS_TIP="$TIP_C" GITLEAKS_REPORT="$REPORT_C" "$SCRIPT" 2>&1)"
_rc_c=$?
if [ "$_rc_c" -eq 0 ]; then
  ok "a .gitleaksignore addition alone does not block the job"
else
  bad "a .gitleaksignore addition alone was blocked (exit $_rc_c) -- should only warn"
fi
if printf '%s' "$_out_c" | grep -qF "::warning::.gitleaksignore gained a line"; then
  ok "the step prints a ::warning:: annotation for the .gitleaksignore addition"
else
  bad "no ::warning:: annotation was printed for the .gitleaksignore addition"
fi
if printf '%s' "$_out_c" | grep -qF "$_added_line"; then
  ok "the warning quotes the exact added .gitleaksignore line"
else
  bad "the warning does not quote the exact added line"
fi

# --- Scenario D: an ordinary train merge must NOT be a false positive ------
# base already has a real .gitleaks.toml. A side branch forked BEFORE that
# config existed is merged in AFTER it (this repo's own train-merge shape,
# e.g. f6c3add4). A per-commit `diff-tree -m` walk flags the merge itself,
# because the config looks "added" relative to the parent that forked before
# it -- even though base and tip carry the IDENTICAL config. This must pass
# clean: it also exercises the base-has-a-real-.gitleaks.toml --config path
# (scenarios A-C above all hit the no-base-config default-rules path only).
REPO_D="$TMP_ROOT/repo-merge"
_new_repo "$REPO_D"
git -C "$REPO_D" branch feature >/dev/null
printf '[extend]\nuseDefault = true\n' > "$REPO_D/.gitleaks.toml"
git -C "$REPO_D" add .gitleaks.toml
git -C "$REPO_D" commit -qm "add real gitleaks config" --no-gpg-sign --no-verify
BASE_D="$(git -C "$REPO_D" rev-parse HEAD)"
# This IS the release the merge should be measured against, not the older
# v1.0.0 baseline tag _new_repo already placed -- tag it v1.1.0 so
# `--abbrev=0` (nearest tag) finds this one.
git -C "$REPO_D" tag v1.1.0
git -C "$REPO_D" checkout -q feature
printf 'a harmless feature\n' > "$REPO_D/feature.txt"
git -C "$REPO_D" add feature.txt
git -C "$REPO_D" commit -qm "unrelated feature work" --no-gpg-sign --no-verify
git -C "$REPO_D" checkout -q main
git -C "$REPO_D" merge -q --no-edit --no-ff feature --no-gpg-sign
TIP_D="$(git -C "$REPO_D" rev-parse HEAD)"

REPORT_D="$TMP_ROOT/report-d.json"
_out_d="$(cd "$REPO_D" && GITLEAKS_BIN="$GITLEAKS_BIN" GITLEAKS_BEFORE="$BASE_D" \
  GITLEAKS_TIP="$TIP_D" GITLEAKS_REPORT="$REPORT_D" "$SCRIPT" 2>&1)"
_rc_d=$?
if [ "$_rc_d" -eq 0 ]; then
  ok "an ordinary train merge of a branch forked before the config existed is not a false-positive config change"
else
  bad "a clean train merge was refused (exit $_rc_d) -- per-commit config detection false-positives on merges: $_out_d"
fi
if printf '%s' "$_out_d" | grep -q "base commit's .gitleaks.toml"; then
  ok "the merge scenario exercises the base-has-a-config --config path"
else
  bad "the merge scenario did not report using the base commit's .gitleaks.toml"
fi
if [ -f "$REPORT_D" ]; then
  _n_d="$(python3 -c "import json; print(len(json.load(open('$REPORT_D'))))" 2>/dev/null || echo "-1")"
  [ "$_n_d" -eq 0 ] && ok "the merge range's report has zero findings" \
    || bad "the merge range's report has $_n_d findings (expected 0)"
else
  bad "no report was written for the merge range"
fi

# --- Scenario E: the r2 opus-reject repro (two-push bypass) ---------------
# Main is unprotected and this workflow only runs on a VERSION push. Push A
# (no VERSION change) adds a zero-rule .gitleaks.toml and gets no audit at
# all. Push B (the VERSION bump, with a real secret) has before = A's own
# sha. r1 trusted A's tree directly via GITLEAKS_BEFORE and scanned itself
# clean -- reviewer's exact repro: tag v1.0.0, commit B1 = `title = "x"`
# .gitleaks.toml (unaudited, untagged), commit a leak, GITLEAKS_BEFORE=B1.
# This must now be REFUSED: GITLEAKS_BEFORE is only a search anchor, never
# a trusted tree, so the walk lands on v1.0.0 (no .gitleaks.toml there).
REPO_E="$TMP_ROOT/repo-r2-repro"
_new_repo "$REPO_E"
printf 'title = "x"\n' > "$REPO_E/.gitleaks.toml"
git -C "$REPO_E" add .gitleaks.toml
git -C "$REPO_E" commit -qm "push A: add zero-rule config, no VERSION change, no audit" --no-gpg-sign --no-verify
B1_E="$(git -C "$REPO_E" rev-parse HEAD)"
printf '%s\n' "const key = \"${_akia_prefix}${_akia_rest}\";" > "$REPO_E/secret.js"
git -C "$REPO_E" add secret.js
git -C "$REPO_E" commit -qm "push B: VERSION bump plus a real secret" --no-gpg-sign --no-verify
TIP_E="$(git -C "$REPO_E" rev-parse HEAD)"

REPORT_E="$TMP_ROOT/report-e.json"
_out_e="$(cd "$REPO_E" && GITLEAKS_BIN="$GITLEAKS_BIN" GITLEAKS_BEFORE="$B1_E" \
  GITLEAKS_TIP="$TIP_E" GITLEAKS_REPORT="$REPORT_E" "$SCRIPT" 2>&1)"
_rc_e=$?
if [ "$_rc_e" -ne 0 ]; then
  ok "r2 repro: refused even though GITLEAKS_BEFORE names the attacker's own unaudited weakened-config commit"
else
  bad "r2 repro: GITLEAKS_BEFORE=<unaudited commit> was trusted directly -- the two-push bypass is NOT closed"
fi
if printf '%s' "$_out_e" | grep -q 'founder review'; then
  ok "r2 repro: the refusal still names the founder-review path"
else
  bad "r2 repro: no founder-review message on refusal"
fi

# --- Scenario F: r3 repro -- no release tag at all must NOT fall back ------
# df88b43d (r2) fell back to `origin/main~1` when no `v*` tag was reachable.
# That commit was never audited either, so trusting its .gitleaks.toml (or
# diffing against it) is the SAME bug class and fails open. Repro: an
# untagged repo, push A adds a zero-rule config (untagged, no audit), push B
# adds a leak; origin/main~1 (df88b43d's fallback) resolves to push A's own
# commit. No tag anywhere in this repo -- the fix must refuse outright, not
# fall back to any commit.
REPO_F="$TMP_ROOT/repo-no-tag-fallback"
git init -q -b main "$REPO_F" >/dev/null
git -C "$REPO_F" config user.email "e114-test@loki.local"
git -C "$REPO_F" config user.name "e114 test"
git -C "$REPO_F" config commit.gpgsign false
git -C "$REPO_F" config core.hooksPath /dev/null
: > "$REPO_F/.gitleaksignore"
printf 'readme\n' > "$REPO_F/README.md"
git -C "$REPO_F" add .gitleaksignore README.md
git -C "$REPO_F" commit -qm "baseline, untagged repo (no release tag exists at all)" --no-gpg-sign --no-verify
printf 'title = "x"\n' > "$REPO_F/.gitleaks.toml"
git -C "$REPO_F" add .gitleaks.toml
git -C "$REPO_F" commit -qm "push A: zero-rule config, no VERSION change, no audit" --no-gpg-sign --no-verify
# shellcheck disable=SC2034
B1_F="$(git -C "$REPO_F" rev-parse HEAD)"
printf '%s\n' "const key = \"${_akia_prefix}${_akia_rest}\";" > "$REPO_F/secret.js"
git -C "$REPO_F" add secret.js
git -C "$REPO_F" commit -qm "push B: VERSION bump plus a real secret" --no-gpg-sign --no-verify
TIP_F="$(git -C "$REPO_F" rev-parse HEAD)"
# origin/main~1 must resolve to push A's own commit for df88b43d's fallback
# to be exploitable at all -- give the repo a real origin whose main tip is
# this push's tip, exactly as a checkout's origin/main would be in CI.
git clone -q --bare "$REPO_F" "$REPO_F.origin.git"
git -C "$REPO_F" remote add origin "$REPO_F.origin.git"
git -C "$REPO_F" fetch -q origin

REPORT_F="$TMP_ROOT/report-f.json"
_out_f="$(cd "$REPO_F" && GITLEAKS_BIN="$GITLEAKS_BIN" GITLEAKS_BEFORE="" \
  GITLEAKS_TIP="$TIP_F" GITLEAKS_REPORT="$REPORT_F" "$SCRIPT" 2>&1)"
_rc_f=$?
if [ "$_rc_f" -ne 0 ]; then
  ok "r3 repro: an untagged repo with no release tag is refused, not fell back to origin/main~1"
else
  bad "r3 repro: no release tag fell back to an unaudited commit and passed -- fails open (same bug class as r1/r2)"
fi

# --- Scenario G (E-159 a): an evil merge's OWN content ----------------------
# `merge -s ours --no-commit` then a token added in the merge commit itself: the
# per-commit git scan never sees it. The --cc merge scan must.
_run_script() { # _run_script <repo> <report> [extra env assignment]
  (cd "$1" && env ${3:+"$3"} GITLEAKS_BIN="$GITLEAKS_BIN" GITLEAKS_BEFORE="" \
    GITLEAKS_TIP="$(git -C "$1" rev-parse HEAD)" GITLEAKS_REPORT="$2" "$SCRIPT" >"$2.out" 2>&1)
}
REPO_G="$TMP_ROOT/repo-evil-merge"
_new_repo "$REPO_G"
git -C "$REPO_G" checkout -q -b side
printf 'side\n' > "$REPO_G/side.txt"
git -C "$REPO_G" add side.txt
git -C "$REPO_G" commit -qm "side" --no-gpg-sign --no-verify
git -C "$REPO_G" checkout -q main
git -C "$REPO_G" merge -q --no-ff --no-commit -s ours side >/dev/null 2>&1
printf '%s\n' "const key = \"${_akia_prefix}${_akia_rest}\";" > "$REPO_G/CHANGELOG.md"
git -C "$REPO_G" add CHANGELOG.md
git -C "$REPO_G" commit -qm "evil merge" --no-gpg-sign --no-verify
_g_old_rc=0
(cd "$REPO_G" && "$GITLEAKS_BIN" git . --log-opts="--all" --no-banner --redact >/dev/null 2>&1) || _g_old_rc=$?
[ "$_g_old_rc" -eq 0 ] && ok "RED EVIDENCE: the per-commit git scan alone misses an evil merge's own content" \
  || bad "fixture does not reproduce the evil-merge blind spot"
if _run_script "$REPO_G" "$TMP_ROOT/report-g.json"; then
  bad "E-159a: the script passed an evil merge carrying a secret in the merge commit itself"
else
  ok "E-159a: the script fails an evil merge carrying a secret in the merge commit itself"
fi

# A clean ordinary merge must still pass (no false positive from --cc).
REPO_G2="$TMP_ROOT/repo-clean-merge"
_new_repo "$REPO_G2"
git -C "$REPO_G2" checkout -q -b side
printf 'side\n' > "$REPO_G2/side.txt"
git -C "$REPO_G2" add side.txt
git -C "$REPO_G2" commit -qm "side" --no-gpg-sign --no-verify
git -C "$REPO_G2" checkout -q main
printf 'main\n' > "$REPO_G2/main.txt"
git -C "$REPO_G2" add main.txt
git -C "$REPO_G2" commit -qm "main side" --no-gpg-sign --no-verify
git -C "$REPO_G2" merge -q --no-ff -m "clean merge" side >/dev/null 2>&1
if _run_script "$REPO_G2" "$TMP_ROOT/report-g2.json"; then
  ok "E-159a: an ordinary clean merge still passes"
else
  bad "E-159a: an ordinary clean merge was failed"; cat "$TMP_ROOT/report-g2.json.out"
fi

# --- Scenario H (E-159 b): gitleaks exits 0 when its internal git log fails --
REPO_H="$TMP_ROOT/repo-bad-range"
_new_repo "$REPO_H"
_h_raw_rc=0
(cd "$REPO_H" && "$GITLEAKS_BIN" git . --log-opts="HEAD~50..HEAD" --no-banner >/dev/null 2>&1) || _h_raw_rc=$?
[ "$_h_raw_rc" -eq 0 ] && ok "RED EVIDENCE: gitleaks itself exits 0 on an invalid range (fail-open)" \
  || bad "this gitleaks no longer exits 0 on an invalid range; fail-open control is stale"
if _run_script "$REPO_H" "$TMP_ROOT/report-h.json" "GITLEAKS_RANGE=HEAD~50..HEAD"; then
  bad "E-159b: the script reported a clean scan for an invalid range"
else
  ok "E-159b: the script refuses an invalid range instead of passing"
fi
if _run_script "$REPO_H" "$TMP_ROOT/report-h3.json" "GITLEAKS_RANGE=HEAD..HEAD"; then
  bad "E-159: an empty range (zero commits walked) was reported as a clean scan"
else
  ok "E-159: an empty range (zero commits walked) is refused"
fi
if _run_script "$REPO_H" "$TMP_ROOT/report-h2.json"; then
  ok "E-159b: a valid default (--all) scan of a clean repo still passes"
else
  bad "E-159b: a clean --all scan failed"; cat "$TMP_ROOT/report-h2.json.out"
fi

# --- D75 Wall checks W1-W6: range mode on train/** pushes -------------------
# The scan-mode step is extracted from security-audit.yml and run as written
# against scratch repos that have a real origin; every check runs against the real
# text first and then against a mutated copy that must go red.
_extract step "$TMP_ROOT/mode-step.sh"
_secret_line="const key = \"${_akia_prefix}${_akia_rest}\";"

_mutate_file() { # _mutate_file <src> <dst> <old> <new>   (exactly one occurrence)
  python3 - "$1" "$2" "$3" "$4" <<'PYEOF'
import sys
s = open(sys.argv[1]).read()
assert s.count(sys.argv[3]) == 1, "mutation anchor not found exactly once: " + sys.argv[3]
open(sys.argv[2], "w").write(s.replace(sys.argv[3], sys.argv[4]))
PYEOF
}

_mk_train() { # _mk_train <name> [stale]  -> T_REPO, T_ORIGIN; train/x checked out
  T_REPO="$TMP_ROOT/$1"; T_ORIGIN="$TMP_ROOT/$1.origin.git"
  _new_repo "$T_REPO"
  if [ "${2:-}" = "stale" ]; then
    git clone -q --bare "$T_REPO" "$T_ORIGIN"
  fi
  printf 'main1\n' > "$T_REPO/main1.txt"
  git -C "$T_REPO" add main1.txt
  git -C "$T_REPO" commit -qm "main tip" --no-gpg-sign --no-verify
  [ "${2:-}" = "stale" ] || git clone -q --bare "$T_REPO" "$T_ORIGIN"
  git -C "$T_REPO" remote add origin "$T_ORIGIN"
  git -C "$T_REPO" checkout -q -b train/x
}
_commit_file() { # _commit_file <repo> <path> <content>
  printf '%s\n' "$3" > "$1/$2"
  git -C "$1" add "$2"
  git -C "$1" commit -qm "add $2" --no-gpg-sign --no-verify
}
_run_step() { # _run_step <step-file> <repo> [ref] [event] -> prints the selected range
  local ref="${3:-refs/heads/train/x}" event="${4:-push}"
  : > "$2.env"
  (cd "$2" && env GITHUB_REF="$ref" GITHUB_EVENT_NAME="$event" GITHUB_SHA="$(git rev-parse HEAD)" \
    GITHUB_ENV="$2.env" bash "$1" > "$2.stepout" 2>&1)
  sed -n 's/^GITLEAKS_RANGE=//p' "$2.env" | tail -1
}
_scan_range() { # _scan_range <script> <repo> <range> -> rc; report at <repo>.report.json
  (cd "$2" && env GITLEAKS_BIN="$GITLEAKS_BIN" GITLEAKS_BEFORE="" GITLEAKS_RANGE="$3" \
    GITLEAKS_TIP="$(git rev-parse HEAD)" GITLEAKS_REPORT="$2.report.json" "$1" > "$2.scanout" 2>&1)
}
_findings() { python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))))" "$1.report.json" 2>/dev/null || echo 0; }
# _caught <step> <script> <repo>: the range-mode pipeline reports the secret
_caught() {
  local r
  r="$(_run_step "$1" "$3")"
  grep -q '^gitleaks mode: range ' "$3.stepout" || return 1
  [ -n "$r" ] || return 1
  _scan_range "$2" "$3" "$r" && return 1
  [ "$(_findings "$3")" -ge 1 ]
}

_STEP_REAL="$TMP_ROOT/mode-step.sh"
_STEP_M1="$TMP_ROOT/mode-step.m1.sh"   # base = parent of the tip: range loses earlier train commits
_mutate_file "$_STEP_REAL" "$_STEP_M1" 'base="$(git merge-base origin/main "$GITHUB_SHA" 2>/dev/null || true)"' 'base="$(git rev-parse "${GITHUB_SHA}^")"'

# W1: secret in an early train-only commit, clean commit on top
_w1() { # _w1 <step> <name>
  _mk_train "$2"
  _commit_file "$T_REPO" secret.js "$_secret_line"
  _commit_file "$T_REPO" clean.txt "clean"
  _caught "$1" "$SCRIPT" "$T_REPO"
}
if _w1 "$_STEP_REAL" w1; then ok "W1: a secret in a train-only commit is caught in range mode"; else bad "W1: train-only secret not caught in range mode"; fi
if _w1 "$_STEP_M1" w1m; then bad "W1 mutation (range base = tip parent) stayed green"; else ok "W1 mutation (range base = tip parent) goes red"; fi

# W2: evil merges
_w2() { # _w2 <step> <script> <name>
  _mk_train "$3a"
  local r="$T_REPO"
  git -C "$r" branch side main
  git -C "$r" checkout -q side
  _commit_file "$r" side.txt side
  git -C "$r" checkout -q train/x
  _commit_file "$r" t.txt t
  git -C "$r" merge -q --no-ff --no-commit -s ours side >/dev/null 2>&1
  printf '%s\n' "$_secret_line" > "$r/CHANGELOG.md"
  git -C "$r" add CHANGELOG.md
  git -C "$r" commit -qm "evil merge" --no-gpg-sign --no-verify
  _caught "$1" "$2" "$r" || return 1
  # conflict resolution that adds a token
  _mk_train "$3b"
  r="$T_REPO"
  _commit_file "$r" f.txt base
  git -C "$r" branch side
  git -C "$r" checkout -q side
  _commit_file "$r" f.txt side
  git -C "$r" checkout -q train/x
  _commit_file "$r" f.txt train
  git -C "$r" merge --no-ff --no-commit side >/dev/null 2>&1
  printf '%s\n' "$_secret_line" > "$r/f.txt"
  git -C "$r" add f.txt
  git -C "$r" commit -qm "resolve conflict" --no-gpg-sign --no-verify
  _caught "$1" "$2" "$r"
}
_SCRIPT_M2="$TMP_ROOT/script.m2.sh"
python3 - "$SCRIPT" "$_SCRIPT_M2" <<'PYEOF'
import sys
s = open(sys.argv[1]).read()
n = s.count("--diff-merges=first-parent")
assert n >= 2, n
open(sys.argv[2], "w").write(s.replace(" --diff-merges=first-parent", ""))
PYEOF
chmod +x "$_SCRIPT_M2"
if _w2 "$_STEP_REAL" "$SCRIPT" w2; then ok "W2: an evil merge (-s ours plus a token) and a conflict resolution adding a token are caught in range mode"; else bad "W2: an evil merge was not caught in range mode"; fi
if _w2 "$_STEP_REAL" "$_SCRIPT_M2" w2m; then bad "W2 mutation (--diff-merges removed from the script) stayed green"; else ok "W2 mutation (--diff-merges removed from the script) goes red"; fi

# W3: a .gitleaks.toml added inside the range is refused (exit 1), no secret needed
_w3() { # _w3 <script> <name>
  _mk_train "$2"
  _commit_file "$T_REPO" .gitleaks.toml 'title = "x"'
  local r rc=0
  r="$(_run_step "$_STEP_REAL" "$T_REPO")"
  _scan_range "$1" "$T_REPO" "$r" || rc=$?
  [ "$rc" -eq 1 ] && grep -q 'founder review' "$T_REPO.scanout"
}
_SCRIPT_M3="$TMP_ROOT/script.m3.sh"
_mutate_file "$SCRIPT" "$_SCRIPT_M3" 'if [ "$_config_touched" -eq 1 ]; then' 'if [ "$_config_touched" -eq 99 ]; then'
chmod +x "$_SCRIPT_M3"
if _w3 "$SCRIPT" w3; then ok "W3: a .gitleaks.toml added inside the range is refused with exit 1"; else bad "W3: config added in range was not refused"; fi
if _w3 "$_SCRIPT_M3" w3m; then bad "W3 mutation (refusal disabled) stayed green"; else ok "W3 mutation (refusal disabled) goes red"; fi

# W4: stale origin/main (older than the real main tip) -> larger range, still catches
_w4() { # _w4 <step> <name>
  _mk_train "$2" stale
  _commit_file "$T_REPO" secret.js "$_secret_line"
  _commit_file "$T_REPO" clean.txt "clean"
  _caught "$1" "$SCRIPT" "$T_REPO" || return 1
  local r base
  r="$(sed -n 's/^GITLEAKS_RANGE=//p' "$T_REPO.env" | tail -1)"
  base="${r%%..*}"
  # stale origin/main is the baseline commit, so main1 is inside the range: 3 commits
  [ "$(git -C "$T_REPO" rev-list --count "$r")" -eq 3 ] && [ "$base" = "$(git -C "$T_REPO" rev-parse "origin/main")" ]
}
if _w4 "$_STEP_REAL" w4; then ok "W4: a stale origin/main gives the larger range (3 commits) and still catches the secret"; else bad "W4: stale origin/main case failed"; fi
if _w4 "$_STEP_M1" w4m; then bad "W4 mutation stayed green"; else ok "W4 mutation (range base = tip parent) goes red"; fi

# W5: fallback to the full scan, proven by the logged mode
_w5() { # _w5 <step> <name> -> 0 iff all three doubt cases log full and export an empty range
  local r
  # (a) origin unreachable (stale origin/main ref exists, fetch fails)
  _mk_train "${2}a"
  _commit_file "$T_REPO" t.txt t
  git -C "$T_REPO" fetch -q origin main
  git -C "$T_REPO" remote set-url origin "$TMP_ROOT/does-not-exist.git"
  r="$(_run_step "$1" "$T_REPO")"
  [ -z "$r" ] && grep -q '^gitleaks mode: full$' "$T_REPO.stepout" || return 1
  # (b) no origin at all: empty base
  _mk_train "${2}b"
  _commit_file "$T_REPO" t.txt t
  git -C "$T_REPO" remote remove origin
  r="$(_run_step "$1" "$T_REPO")"
  [ -z "$r" ] && grep -q '^gitleaks mode: full$' "$T_REPO.stepout" || return 1
  # (c) zero commits between merge-base and SHA (train tip equals main tip)
  _mk_train "${2}c"
  r="$(_run_step "$1" "$T_REPO")"
  [ -z "$r" ] && grep -q '^gitleaks mode: full$' "$T_REPO.stepout" || return 1
  # (d) not a train ref, and a train ref on a non-push event
  _mk_train "${2}d"
  _commit_file "$T_REPO" t.txt t
  # GITLEAKS-INCR: a main push now selects <previous tag>..SHA (covered by
  # tests/test-gitleaks-incremental.sh), so the non-selected ref here is a slice branch.
  r="$(_run_step "$1" "$T_REPO" refs/heads/slice-x push)"
  [ -z "$r" ] && grep -q '^gitleaks mode: full$' "$T_REPO.stepout" || return 1
  r="$(_run_step "$1" "$T_REPO" refs/heads/train/x workflow_dispatch)"
  [ -z "$r" ] && grep -q '^gitleaks mode: full$' "$T_REPO.stepout"
}
_STEP_M5A="$TMP_ROOT/mode-step.m5a.sh"; _STEP_M5C="$TMP_ROOT/mode-step.m5c.sh"; _STEP_M5D="$TMP_ROOT/mode-step.m5d.sh"
_mutate_file "$_STEP_REAL" "$_STEP_M5A" 'if git fetch --no-tags origin main >/dev/null 2>&1; then' 'if true; then'
_mutate_file "$_STEP_REAL" "$_STEP_M5C" "'' | *[!0-9]* | 0) ;;" "'' | *[!0-9]*) ;;"
_mutate_file "$_STEP_REAL" "$_STEP_M5D" 'if [ "${GITHUB_EVENT_NAME:-}" = "push" ]; then' 'if true; then'
if _w5 "$_STEP_REAL" w5; then ok "W5: unreachable origin, no origin, an empty range, a non-train ref and a non-push event all log 'gitleaks mode: full' with an empty range"; else bad "W5: a doubt case did not fall back to the full scan"; fi
if _w5 "$_STEP_M5A" w5a; then bad "W5 mutation (fetch result ignored) stayed green"; else ok "W5 mutation (fetch result ignored) goes red"; fi
if _w5 "$_STEP_M5C" w5c; then bad "W5 mutation (empty-range check removed) stayed green"; else ok "W5 mutation (empty-range check removed) goes red"; fi
if _w5 "$_STEP_M5D" w5d; then bad "W5 mutation (event check removed) stayed green"; else ok "W5 mutation (event check removed) goes red"; fi

# W6: range mode never reads the tip's or the merge-base's config
_w6() { # _w6 <script> <name>
  # (a) zero-rule tip config + secret in the range
  _mk_train "${2}a"
  printf 'title = "x"\n' > "$T_REPO/.gitleaks.toml"
  git -C "$T_REPO" add .gitleaks.toml
  _commit_file "$T_REPO" secret.js "$_secret_line"
  local r
  r="$(_run_step "$_STEP_REAL" "$T_REPO")"
  _scan_range "$1" "$T_REPO" "$r" && return 1
  [ "$(_findings "$T_REPO")" -ge 1 ] || return 1
  # (b) zero-rule config committed on main (the merge-base), secret on the train
  _mk_train "${2}b"
  git -C "$T_REPO" checkout -q main
  printf 'title = "x"\n' > "$T_REPO/.gitleaks.toml"
  git -C "$T_REPO" add .gitleaks.toml
  git -C "$T_REPO" commit -qm "main adds zero-rule config" --no-gpg-sign --no-verify
  git -C "$T_REPO" push -q origin main
  git -C "$T_REPO" checkout -q train/x
  git -C "$T_REPO" merge -q --no-edit main >/dev/null 2>&1
  _commit_file "$T_REPO" secret.js "$_secret_line"
  r="$(_run_step "$_STEP_REAL" "$T_REPO")"
  _scan_range "$1" "$T_REPO" "$r" && return 1
  [ "$(_findings "$T_REPO")" -ge 1 ]
}
_SCRIPT_M6A="$TMP_ROOT/script.m6a.sh"; _SCRIPT_M6B="$TMP_ROOT/script.m6b.sh"
_mutate_file "$SCRIPT" "$_SCRIPT_M6A" 'mv ./.gitleaks.toml "$_tip_config_backup"' 'true'
_mutate_file "$SCRIPT" "$_SCRIPT_M6B" "_base=\"\$(git describe --tags --abbrev=0 --match 'v[0-9]*' \"\$_describe_from\" 2>/dev/null || true)\"" '_base="$(git merge-base origin/main "$_tip" 2>/dev/null || true)"'
chmod +x "$_SCRIPT_M6A" "$_SCRIPT_M6B"
if _w6 "$SCRIPT" w6; then ok "W6: a zero-rule tip config and a zero-rule merge-base config never hide a secret in range mode"; else bad "W6: range mode trusted a tip or merge-base config"; fi
if _w6 "$_SCRIPT_M6A" w6a; then bad "W6 mutation (tip config left in place) stayed green"; else ok "W6 mutation (tip config left in place) goes red"; fi
if _w6 "$_SCRIPT_M6B" w6b; then bad "W6 mutation (merge-base config trusted) stayed green"; else ok "W6 mutation (merge-base config trusted) goes red"; fi

# W10 (NPM-LAG): publish-npm holds until npm serves the exact version. The real run: block
# is extracted from release.yml and driven with a stubbed npm and a stubbed date-free clock.
cat > "$TMP_ROOT/extract10.py" <<'PYEOF'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
# WF-2MIN-3: publish-npm is merged into `release`; the pack is its own parallel
# job (pack-npm). npm-visible is a NON-BLOCKING reporter: it needs release,
# is continue-on-error, and no other job may need it.
assert d["jobs"]["npm-visible"]["needs"] == "release", "npm-visible must need release"
assert d["jobs"]["npm-visible"].get("continue-on-error") is True, "npm-visible must be continue-on-error"
assert "publish-npm" not in d["jobs"], "publish-npm must be merged into release"
for jn, j in d["jobs"].items():
    n = j.get("needs") or []
    n = [n] if isinstance(n, str) else n
    assert "npm-visible" not in n, "%s must not need npm-visible" % jn
pub_steps = d["jobs"]["release"]["steps"]
assert len([x for x in pub_steps if x.get("name", "").startswith("Publish")]) == 1, "exactly one publish step"
names_r = [x.get("name", "") for x in pub_steps]
assert names_r.index("Create GitHub Release") < [i for i, n in enumerate(names_r) if n.startswith("Publish the verified")][0], "tag and release must precede npm publish"
assert not [x for x in pub_steps if x.get("name", "").startswith("Wait until npm serves")], "release must not wait on the registry"
steps = d["jobs"]["npm-visible"]["steps"]
names = [s.get("name", "") for s in steps]
w = [i for i, n in enumerate(names) if n.startswith("Wait until npm serves")]
pub = [0]
assert len(w) == 1, "wait step must exist once in npm-visible"
open(sys.argv[2], "w").write(steps[w[0]]["run"])
for k, v in steps[w[0]]["env"].items():
    print("%s=%s" % (k, v))
PYEOF
if python3 "$TMP_ROOT/extract10.py" "$REL_YML" "$TMP_ROOT/npmwait.sh" > "$TMP_ROOT/npmwait.env"; then
  ok "W10: npm-visible is a non-blocking reporter holding the one npm-visibility wait; publish is merged into release after the tag"
else
  bad "W10: npm-visible wait job missing, blocking, needed by another job, or publish precedes the tag"
fi
_w10_run() { # _w10_run <script> <visible-after-N-polls|never> -> prints "<rc>|<output>"
  local d="$TMP_ROOT/w10.cur" rc=0 out
  rm -rf "$d"; mkdir -p "$d/bin"; printf '10.9.9\n' > "$d/VERSION"; echo 0 > "$d/count"
  cat > "$d/bin/npm" <<'NPMEOF'
#!/bin/bash
# stub: records the flags and lists the version only after N polls
echo "$*" >> "$W10_DIR/calls"
case "$*" in *--prefer-online*) ;; *) exit 0 ;; esac
n=$(( $(cat "$W10_DIR/count") + 1 )); echo "$n" > "$W10_DIR/count"
if [ "$W10_AFTER" != never ] && [ "$n" -gt "$W10_AFTER" ]; then echo "10.9.9"; else echo "npm error code E404" >&2; fi
NPMEOF
  chmod +x "$d/bin/npm"
  out="$(cd "$d" && env PATH="$d/bin:$PATH" W10_DIR="$d" W10_AFTER="$2" \
    NPM_WAIT_TIMEOUT_S=3 NPM_WAIT_BASE_S=1 NPM_WAIT_CAP_S=1 bash -c "$(cat "$1")" 2>&1)" || rc=$?
  printf '%s|%s' "$rc" "$out"
}
_w10() { # _w10 <script> ; 0 = behaves per NPM-LAG
  local o
  o="$(_w10_run "$1" never)"
  [ "${o%%|*}" = "1" ] && case "$o" in *NPM-LAG-TIMEOUT*) true ;; *) false ;; esac || return 1
  # lagging polls are neither a pass nor a failure message, and must be more than one
  [ "$(grep -c 'not visible on npm yet' <<<"$o")" -ge 2 ] || return 1
  # backoff: a 3s window with 1s sleeps polls a handful of times, never spins
  [ "$(cat "$TMP_ROOT/w10.cur/count")" -le 10 ] || return 1
  o="$(_w10_run "$1" 2)"
  [ "${o%%|*}" = "0" ] && case "$o" in *"OK: npm serves loki-mode@10.9.9 (poll 3)"*) true ;; *) false ;; esac || return 1
  # every poll bypasses the cache and names the exact version
  grep -q '^view loki-mode@10.9.9 version --prefer-online$' "$TMP_ROOT/w10.cur/calls" || return 1
  # visible on the first poll: no sleeping, immediate pass
  o="$(_w10_run "$1" 0)"
  [ "${o%%|*}" = "0" ] && case "$o" in *"poll 1"*) true ;; *) false ;; esac
}
_w10_mut() { # _w10_mut <name> <old> <new>
  python3 - "$TMP_ROOT/npmwait.sh" "$TMP_ROOT/npmwait.$1.sh" "$2" "$3" <<'PYEOF'
import sys
s = open(sys.argv[1]).read()
assert s.count(sys.argv[3]) == 1, sys.argv[3]
open(sys.argv[2], "w").write(s.replace(sys.argv[3], sys.argv[4]))
PYEOF
  if _w10 "$TMP_ROOT/npmwait.$1.sh"; then bad "W10 mutation ($1) stayed green"; else ok "W10 mutation ($1) goes red"; fi
}
set -a
# shellcheck disable=SC1091
. "$TMP_ROOT/npmwait.env"
set +a
unset NPM_WAIT_TIMEOUT_S NPM_WAIT_BASE_S NPM_WAIT_CAP_S
if _w10 "$TMP_ROOT/npmwait.sh"; then
  ok "W10: a never-listed version fails with NPM-LAG-TIMEOUT after the bounded wait; a version listed after 2 polls passes on poll 3 using --prefer-online"
else
  bad "W10: npm visibility wait does not match NPM-LAG"
fi
_w10_mut nocache ' --prefer-online' ''
_w10_mut timeoutpass 'echo "NPM-LAG-TIMEOUT:' 'echo "TIMEOUT:'
_w10_mut timeoutexit0 'polls); the publish step succeeded but the registry never listed it"
              exit 1' 'polls); the publish step succeeded but the registry never listed it"
              exit 0'
_w10_mut lagispass '[ "$FOUND" = "$VERSION" ]' '[ -z "$FOUND" ] || [ "$FOUND" = "$VERSION" ]'
_w10_mut nobackoff 'sleep "$delay"' ':'
# the default window is not shorter than the 45 minutes the smoke and promote steps assume
grep -q '^NPM_WAIT_TIMEOUT_S=2700$' "$TMP_ROOT/npmwait.env" \
  && ok "W10: default wait is 2700s (45 min)" || bad "W10: default wait is not 2700s"
# gating: Post-Release Smoke triggers only on a successful Release run, so a failed wait stops smoke and promote
if grep -qE "workflows: \[\"Release\"\]" "$REPO_ROOT/.github/workflows/post-release-smoke.yml" \
   && grep -q "workflow_run.conclusion == 'success'" "$REPO_ROOT/.github/workflows/post-release-smoke.yml"; then
  ok "W10: smoke runs only after a successful Release run, which now includes the npm visibility wait"
else
  bad "W10: smoke is not gated on a successful Release run"
fi

echo
echo "=== $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
