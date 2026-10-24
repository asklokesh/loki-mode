#!/usr/bin/env bash
# Checklist freeze. The harness (prd-checklist.sh) freezes the check definitions
# once, keeps the digest in its own memory, and passes it to every verify as
# --expect-digest. These cases drive the harness path, never only the verifier:
# an edited check must not be reported verified however the agent tampers with
# files, and the verifier must fail closed without a valid expected digest.
#
# LOKI_FREEZE_SRC_DIR points the suite at another autonomy/ copy (it must hold
# prd-checklist.sh and checklist-verify.py); the mutation cases use it.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${LOKI_FREEZE_SRC_DIR:-$SCRIPT_DIR/../autonomy}"
INNER="${LOKI_FREEZE_INNER:-0}"
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }

FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
T="$(mktemp -d "${TMPDIR:-/tmp}/ckfreeze.XXXXXX")" || exit 1
trap 'rm -rf "$T"' EXIT

PROJ="$T/proj"
CL="$PROJ/.loki/checklist/checklist.json"
PRISTINE='{"categories":[{"name":"c","items":[
{"id":"A","title":"a","verification":[{"type":"file_exists","path":"present.txt"}]},
{"id":"B","title":"b","verification":[{"type":"file_exists","path":"missing.txt"}]}]}]}'

new_proj() {
    rm -rf "$PROJ"
    mkdir -p "$PROJ/.loki/checklist" "$PROJ/.loki/state"
    printf x > "$PROJ/present.txt"
    printf '%s\n' "$PRISTINE" > "$CL"
}

# status <item id> -> status the verifier wrote, or none
st() {
    python3 -I -c 'import json,sys
try:
    d=json.load(open(sys.argv[1]))
    print(([i.get("status","none") for c in d["categories"] for i in c["items"] if i["id"]==sys.argv[2]] or ["none"])[0])
except Exception:
    print("none")' "$CL" "$1"
}

# tamper: point check B at a file that exists, so an unguarded verify reports it verified
tamper() {
    python3 -I -c 'import json,sys
d=json.load(open(sys.argv[1]))
d["categories"][0]["items"][1]["verification"][0]["path"]="present.txt"
json.dump(d,open(sys.argv[1],"w"))' "$CL"
}

# forge: rewrite an embedded digest in the checklist to match the edited definitions
forge() {
    python3 -I -c 'import importlib.util,json,sys
s=importlib.util.spec_from_file_location("cv",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
d=json.load(open(sys.argv[2]));d["frozen_definition_sha256"]=m.definition_digest(d);json.dump(d,open(sys.argv[2],"w"))' "$SRC_DIR/checklist-verify.py" "$CL"
}
export CL PROJ SRC_DIR
export -f tamper forge

# harness <between-hook> -> runs the real harness functions in one bash process
# (the digest lives in that process's memory): freeze, two clean verifies, then
# the hook (the agent's tampering), then the verify under test. Prints
# "clean1=<rc> clean2=<rc> final=<rc>" and writes warnings to $T/harness.log.
harness() {
    local hook="$1"
    cat > "$T/driver.sh" <<DRV
set -u
log_info() { :; }
log_step() { :; }
log_warn() { printf '%s\n' "\$*" >> "$T/harness.log"; }
log_error() { :; }
export CHECKLIST_ENABLED=true CHECKLIST_TIMEOUT=5
. "$SRC_DIR/prd-checklist.sh"
checklist_init ""
checklist_select_heldout() { :; }
checklist_oracle_triangulate() { :; }
checklist_freeze_once 2>/dev/null
checklist_verify; c1=\$?
checklist_verify; c2=\$?
$hook
checklist_freeze_once 2>/dev/null
checklist_verify; fin=\$?
echo "clean1=\$c1 clean2=\$c2 final=\$fin"
DRV
    : > "$T/harness.log"
    ( cd "$PROJ" && bash "$T/driver.sh" 2>/dev/null )
}

# expect_blocked <name> <hook>: the edited check B must not be reported verified
expect_blocked() {
    local name="$1" hook="$2" out
    new_proj
    out="$(harness "$hook")"
    case "$out" in
        *"clean1=0 clean2=0 final="*) ;;
        *) fail "$name: clean harness verifies did not both succeed ($out)"; return ;;
    esac
    [ "$(st A)" = verified ] || fail "$name: A not verified"
    case "$out" in *"final=0") fail "$name: harness verify returned 0 on an edited checklist" ;; esac
    [ "$(st B)" != verified ] || fail "$name: edited check B reported verified"
    grep -qi 'hash mismatch' "$T/harness.log" || fail "$name: no hash mismatch reason logged"
}

# Clean path first: untouched checklist verifies, B fails honestly, no mismatch.
new_proj
out="$(harness ':')"
case "$out" in "clean1=0 clean2=0 final=0") ;; *) fail "clean path: $out" ;; esac
[ "$(st A)" = verified ] || fail "clean: A not verified"
[ "$(st B)" = failing ] || fail "clean: B not failing ($(st B))"
grep -qi 'hash mismatch' "$T/harness.log" && fail "clean path reported a mismatch"

STATE="$PROJ/.loki/state/checklist-freeze.json"
FIND="$PROJ/.loki/checklist"
# The seven bypasses: each must stay blocked on the harness path.
expect_blocked "edit only" 'tamper'
expect_blocked "delete the record" 'tamper; rm -f "'"$STATE"'"'
expect_blocked "chmod and rewrite the digest record" 'tamper; mkdir -p "'"$PROJ"'/.loki/state"; D="$(python3 -I "'"$SRC_DIR"'/checklist-verify.py" --checklist "'"$CL"'" --freeze)"; printf "{\"definition_sha256\":\"%s\"}" "$D" > "'"$STATE"'"; chmod u+w "'"$STATE"'"'
expect_blocked "re-run --freeze after the edit" 'tamper; python3 -I "'"$SRC_DIR"'/checklist-verify.py" --checklist "'"$CL"'" --freeze > "'"$STATE"'" 2>/dev/null'
expect_blocked "symlink record to /dev/null" 'tamper; ln -sf /dev/null "'"$STATE"'"'
expect_blocked "symlink record to {}" 'tamper; printf "{}" > "'"$PROJ"'/empty.json"; ln -sf "'"$PROJ"'/empty.json" "'"$STATE"'"'
expect_blocked "empty digest record" 'tamper; printf "{\"definition_sha256\":\"\"}" > "'"$STATE"'"'
expect_blocked "forged embedded digest in the checklist" 'tamper; forge'

# Direct verifier: fail closed without a valid expected digest.
V="$SRC_DIR/checklist-verify.py"
vrun() { ( cd "$PROJ" && python3 -I "$V" --checklist "$CL" "$@" ) >"$T/v.log" 2>&1; }
new_proj
GOOD="$(python3 -I "$V" --checklist "$CL" --freeze)"
case "$GOOD" in
    *[!0-9a-f]* | "") fail "--freeze did not print a bare hex digest: $GOOD" ;;
esac
[ "${#GOOD}" -eq 64 ] || fail "--freeze digest is not 64 chars"
vrun; rc=$?
[ "$rc" -eq 2 ] || fail "verify without --expect-digest: want rc 2, got $rc"
grep -q -- '--expect-digest' "$T/v.log" || fail "missing digest: reason not reported"
[ "$(st A)" != verified ] || fail "verify without --expect-digest wrote results"
for bad in "" "abc" "$(printf 'G%.0s' $(seq 1 64))" "${GOOD}00" "$(printf '%s' "$GOOD" | tr 'a-f' 'A-F')"; do
    new_proj
    vrun --expect-digest "$bad"; rc=$?
    [ "$rc" -eq 2 ] || fail "malformed --expect-digest '$bad': want rc 2, got $rc"
    [ "$(st A)" != verified ] || fail "malformed --expect-digest '$bad' wrote results"
done
new_proj
vrun --expect-digest "$(printf '0%.0s' $(seq 1 64))"; rc=$?
[ "$rc" -eq 3 ] || fail "wrong digest: want rc 3, got $rc"
grep -qi 'hash mismatch' "$T/v.log" || fail "wrong digest: no hash mismatch message"
new_proj
vrun --expect-digest "$GOOD" || fail "matching digest was refused: $(tail -1 "$T/v.log")"
[ "$(st A)" = verified ] || fail "matching digest: A not verified"
vrun --expect-digest "$GOOD" || fail "re-run after the verifier's own write-back was refused"

# --freeze writes nothing: no record exists to be trusted.
new_proj
python3 -I "$V" --checklist "$CL" --freeze >/dev/null
[ -z "$(ls -A "$PROJ/.loki/state")" ] || fail "--freeze wrote a file under .loki/state"

# The run.sh path: the post-iteration block of autonomy/run.sh (freeze call, then
# the interval verify) is extracted and executed as-is. Iteration 1 sees the
# checklist, the agent edits a check in a later iteration, then the interval
# verify runs. The freeze call must come first, so the edit never becomes the
# baseline. Removing the call turns this red. (Moving it after the verify is
# behaviorally equivalent: checklist_verify freezes on its own at that point.)
RUN_SH="$SRC_DIR/run.sh"
awk '/# Freeze the check definitions as soon as the checklist exists/{p=1} /# App Runner: init after first successful iteration/{p=0} p' "$RUN_SH" > "$T/runsh-block.sh"
if ! grep -q 'checklist_verify' "$T/runsh-block.sh" || ! grep -q 'checklist_freeze_once' "$T/runsh-block.sh"; then
    fail "run.sh post-iteration block not found (freeze call or interval verify missing)"
fi
runsh_iterations() {  # <tamper 0|1>: iteration 1 (no verify due), optional edit, interval verify
    cat > "$T/runsh-driver.sh" <<DRV
set -u
log_info() { :; }
log_step() { :; }
log_warn() { printf '%s\n' "\$*" >> "$T/harness.log"; }
export CHECKLIST_ENABLED=true CHECKLIST_TIMEOUT=5
. "$SRC_DIR/prd-checklist.sh"
checklist_init ""
checklist_select_heldout() { :; }
checklist_oracle_triangulate() { :; }
exit_code=0
SHOULD=0
checklist_should_verify() { [ "\$SHOULD" = 1 ]; }
iteration() { . "$T/runsh-block.sh"; }
iteration
[ "$1" = 1 ] && tamper
SHOULD=1
iteration
DRV
    : > "$T/harness.log"
    ( cd "$PROJ" && bash "$T/runsh-driver.sh" >/dev/null 2>&1 )
}
new_proj
runsh_iterations 0
[ "$(st A)" = verified ] || fail "run.sh path: clean interval verify did not verify A ($(st A))"
[ "$(st B)" = failing ] || fail "run.sh path: clean interval verify did not fail B ($(st B))"
new_proj
runsh_iterations 1
[ "$(st B)" != verified ] || fail "run.sh path: a check edited after iteration 1 was reported verified (freeze not done before the interval verify)"
grep -qi 'hash mismatch' "$T/harness.log" || fail "run.sh path: no hash mismatch logged for the edited check"

# Mutations of the guarded code: each must turn this suite red.
if [ "$INNER" = 0 ] && [ -z "${LOKI_FREEZE_SRC_DIR:-}" ]; then
    mutate() {  # <name> <file> <old> <new> [<old2> <new2>]  (same file, applied in order)
        local name="$1" file="$2" old="$3" new="$4" old2="${5:-}" new2="${6:-}" dir="$T/mut-$1"
        mkdir -p "$dir"
        cp "$SRC_DIR"/prd-checklist.sh "$SRC_DIR"/checklist-verify.py "$SRC_DIR"/run.sh "$dir/"
        python3 -I - "$dir/$file" "$old" "$new" "$old2" "$new2" <<'PY'
import sys
p, old, new, old2, new2 = sys.argv[1:6]
s = open(p).read()
for o, n in ((old, new), (old2, new2)):
    if not o:
        continue
    if o not in s:
        sys.exit("mutation anchor not found: " + o)
    s = s.replace(o, n, 1)
open(p, "w").write(s)
PY
        [ $? -eq 0 ] || { fail "mutation $name: anchor missing (guard text changed)"; return; }
        if LOKI_FREEZE_INNER=1 LOKI_FREEZE_SRC_DIR="$dir" bash "$0" >/dev/null 2>&1; then
            fail "mutation $name survived (suite stayed green)"
        fi
    }
    mutate drop-digest-compare checklist-verify.py 'if not hmac.compare_digest(' 'if False and not hmac.compare_digest('
    mutate drop-required-check checklist-verify.py 'if expected is None or not _DIGEST_RE.match(expected):' 'if False:'
    mutate accept-empty-digest checklist-verify.py 'if expected is None or not _DIGEST_RE.match(expected):' 'if expected is None:'
    mutate refreeze-every-verify prd-checklist.sh '[ -z "$CHECKLIST_FROZEN_DIGEST" ] || return 0' ':'
    mutate runsh-drops-freeze-call run.sh '            checklist_freeze_once || true' '            :'
    mutate harness-omits-digest prd-checklist.sh '--expect-digest "$CHECKLIST_FROZEN_DIGEST"' '--timeout 5'
fi

if [ "$FAIL" -eq 0 ]; then echo "PASS: checklist freeze"; exit 0; fi
exit 1
