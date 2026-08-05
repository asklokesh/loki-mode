#!/usr/bin/env bash
# `loki verify --json` must emit the evidence document to stdout and NOTHING else.
#
# WHY THIS EXISTS. verify is the flagship command and the one an integrator most
# wants to pipe, but it had no --json: the evidence document was written to
# <out>/evidence.json and stdout carried only a human banner. A caller had to
# know the output path, and could not pipe at all.
#
# `loki ci` had the mirror problem -- it COULD emit JSON, but only via
# `--format json`, a flag name no other command uses. A script author reaching
# for the repo-wide --json convention found nothing and concluded the
# capability was missing. That is now an alias.
#
# THE STRICT ASSERTION IS "AND NOTHING ELSE". A single stray progress line on
# stdout breaks `| jq` for every consumer, and it is the easy thing to get
# wrong: the emitter's stdout is deliberately sent to /dev/null on the human
# path, so the JSON is routed over FD 3. This test parses stdout with a real
# JSON parser rather than grepping for a brace, because a grep would pass on
# output that jq would reject.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

command -v git >/dev/null 2>&1 || { echo "SKIP: git not available"; exit 0; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A repo with a REAL diff against the base. An empty diff short-circuits verify
# before the evidence emitter runs, so testing against one would assert nothing
# -- a trap this test fell into while being written.
(
    cd "$WORK" || exit 1
    git init -q .
    git config user.email test@example.com
    git config user.name test
    git config commit.gpgsign false
    echo "seed" > seed.txt
    git add seed.txt
    git commit -qm "init"
    git checkout -qb feature
    printf 'function add(a, b) {\n  return a + b;\n}\n' > lib.js
    git add lib.js
    git commit -qm "add lib"
) >/dev/null 2>&1 || { echo "SKIP: could not build a git fixture"; exit 0; }

out_file="$WORK/stdout.txt"
err_file="$WORK/stderr.txt"
( cd "$WORK" && "$LOKI" verify --base main --json ) >"$out_file" 2>"$err_file"
json_rc=$?

# 1. stdout must parse as JSON -- with a parser, not a grep.
parsed="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("PARSE_FAIL:" + str(e)[:80]); raise SystemExit
missing = [k for k in ("verdict", "exit_code") if k not in d]
print("MISSING:" + ",".join(missing) if missing else "OK:" + str(d["verdict"]))
' "$out_file" 2>/dev/null)"

case "$parsed" in
    OK:*)          ok "verify --json emits parseable JSON on stdout (verdict ${parsed#OK:})" ;;
    MISSING:*)     bad "the JSON is missing required fields: ${parsed#MISSING:}" ;;
    PARSE_FAIL:*)  bad "stdout is not valid JSON: ${parsed#PARSE_FAIL:}" ;;
    *)             bad "could not evaluate verify --json stdout (empty output?)" ;;
esac

# 2. The human banner must NOT be on stdout. This is what breaks a pipe.
if grep -q "VERDICT:" "$out_file"; then
    bad "the human VERDICT banner leaked onto stdout -- '| jq' would fail"
else
    ok "no human banner on stdout"
fi

# 3. But it must still reach the operator, on stderr. Moving it to stderr is
#    correct; dropping it would be a regression for someone watching a terminal.
if grep -q "VERDICT:" "$err_file"; then
    ok "the VERDICT banner still reaches the operator on stderr"
else
    bad "the VERDICT banner vanished entirely -- an interactive user lost it"
fi

# 4. The evidence FILE must still be written. --json adds a pipe; it must not
#    move the artifact that --check-fresh and the proof share both read.
if [ -s "$WORK/.loki/verify/evidence.json" ]; then
    ok "evidence.json is still written alongside --json"
else
    bad "evidence.json is missing -- --json moved the artifact instead of adding a pipe"
fi

# 5. The document on stdout and the document on disk must be the SAME. Two
#    serializers of one contract drift, and the drift surfaces as a caller
#    trusting a field the file no longer has.
same="$(python3 -c '
import json, sys
try:
    a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2]))
except Exception:
    print("UNREADABLE"); raise SystemExit
print("SAME" if a == b else "DIFFERENT")
' "$out_file" "$WORK/.loki/verify/evidence.json" 2>/dev/null)"

case "$same" in
    SAME)      ok "stdout and evidence.json carry the identical document" ;;
    DIFFERENT) bad "stdout and evidence.json DISAGREE -- two serializers have drifted" ;;
    *)         bad "could not compare stdout against evidence.json" ;;
esac

# 6. The exit code must be unchanged by the output format. A flag that alters a
#    verdict would be a trust defect, not a convenience.
( cd "$WORK" && "$LOKI" verify --base main ) >/dev/null 2>&1
plain_rc=$?
if [ "$json_rc" -eq "$plain_rc" ]; then
    ok "--json does not change the exit code (${json_rc} both ways)"
else
    bad "--json changed the exit code (${json_rc} vs ${plain_rc}) -- output format must not affect the verdict"
fi

# 7. The default path must be untouched: the banner belongs on stdout there.
plain_out="$( cd "$WORK" && "$LOKI" verify --base main 2>/dev/null )"
case "$plain_out" in
    *"VERDICT:"*) ok "without --json the banner is still on stdout (no regression)" ;;
    *) bad "the default path lost its stdout banner" ;;
esac

# 8. `loki ci --json` must be accepted as an alias for --format json.
ci_help="$("$LOKI" ci --help </dev/null 2>&1 || true)"
case "$ci_help" in
    *"--json"*) ok "loki ci documents --json as an alias" ;;
    *) bad "loki ci does not document the --json alias" ;;
esac

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
