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
# check_author.py accept: the Wall's authored checklist. Failure writes status
# unknown plus the critical failing sentinel and never a checklist.json.
CA="$SCRIPT_DIR/../autonomy/lib/check_author.py"
ACC="$T/accept"
ACC_SPEC="$ACC/spec.md"
ACC_REPO="$ACC/repo"
mkdir -p "$ACC_REPO"
printf '# PRD\nGreet people.\n' > "$ACC_SPEC"
printf 'secret\n' > "$ACC_REPO/impl.txt"
printf '{}\n' > "$ACC_REPO/package.json"
( cd "$ACC_REPO" && git init -q && git add package.json impl.txt ) >/dev/null 2>&1
GOODJSON='{"categories":[{"name":"core","items":[{"id":"G1","title":"greets","priority":"critical","verification":[{"type":"file_exists","path":"present.txt"},{"type":"grep_codebase","pattern":"hello"}]}]}]}'

# acc_run <name> <stdin text>: runs accept into a fresh out dir, sets ACC_RC and ACC_OUT
acc_run() {
    ACC_OUT="$ACC/out-$1"
    rm -rf "$ACC_OUT"
    printf '%s' "$2" | python3 -I "$CA" accept --spec "$ACC_SPEC" --repo "$ACC_REPO" --out "$ACC_OUT" >"$ACC/acc.log" 2>&1
    ACC_RC=$?
}
acc_field() { python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2]))' "$ACC_OUT/author.json" "$1" 2>/dev/null; }

expect_unknown() {
    acc_run "$1" "$2"
    [ "$ACC_RC" -ne 0 ] || fail "accept $1: exit 0 on bad input"
    [ "$(acc_field status)" = unknown ] || fail "accept $1: status not unknown ($(acc_field status))"
    [ ! -e "$ACC_OUT/checklist.json" ] || fail "accept $1: checklist.json written on failure"
    python3 -I -c 'import json,sys
d=json.load(open(sys.argv[1]));i=d["categories"][0]["items"][0]
sys.exit(0 if i["priority"]=="critical" and i["status"]=="failing" else 1)' "$ACC_OUT/verification-results.json" 2>/dev/null \
        || fail "accept $1: critical failing sentinel not written"
}

acc_run happy "Here you go:
\`\`\`json
$GOODJSON
\`\`\`
done"
[ "$ACC_RC" -eq 0 ] || fail "accept happy path: rc $ACC_RC ($(cat "$ACC/acc.log"))"
[ "$(acc_field status)" = authored ] || fail "accept happy path: status not authored"
[ "$(acc_field spec_sha256)" = "$(python3 -I -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$ACC_SPEC")" ] || fail "accept happy path: spec_sha256 wrong"
[ -f "$ACC_OUT/checklist.json" ] || fail "accept happy path: no checklist.json"
ls "$ACC_OUT" | grep -q 'tmp' && fail "accept happy path: temp file left behind"
# the written checklist runs through the real verifier without schema errors
mkdir -p "$ACC/proj"
printf x > "$ACC/proj/present.txt"
VD="$(python3 -I "$SRC_DIR/checklist-verify.py" --checklist "$ACC_OUT/checklist.json" --freeze)"
( cd "$ACC/proj" && python3 -I "$SRC_DIR/checklist-verify.py" --checklist "$ACC_OUT/checklist.json" --expect-digest "$VD" ) >"$ACC/v.log" 2>&1 \
    || fail "accept happy path: verifier rejected the checklist ($(tail -1 "$ACC/v.log"))"
grep -q '^Checklist: ' "$ACC/v.log" || fail "accept happy path: verifier printed no summary"
[ -f "$ACC_OUT/verification-results.json" ] || fail "accept happy path: verifier wrote no results"

expect_unknown missing-verification '{"categories":[{"items":[{"id":"A","title":"a","priority":"major"}]}]}'
expect_unknown empty-verification '{"categories":[{"items":[{"id":"A","title":"a","priority":"major","verification":[]}]}]}'
expect_unknown bad-priority '{"categories":[{"items":[{"id":"A","title":"a","priority":"urgent","verification":[{"type":"file_exists","path":"x"}]}]}]}'
expect_unknown unknown-type '{"categories":[{"items":[{"id":"A","title":"a","priority":"major","verification":[{"type":"vibes","path":"x"}]}]}]}'
expect_unknown missing-field '{"categories":[{"items":[{"id":"A","title":"a","priority":"major","verification":[{"type":"command"}]}]}]}'
expect_unknown duplicate-id '{"categories":[{"items":[{"id":"A","title":"a","priority":"major","verification":[{"type":"file_exists","path":"x"}]},{"id":"A","title":"b","priority":"major","verification":[{"type":"file_exists","path":"x"}]}]}]}'
expect_unknown zero-items '{"categories":[{"items":[]}]}'
expect_unknown zero-items-many-cats '{"categories":[{"items":[]},{"name":"b","items":[]}]}'
expect_unknown no-categories '{"categories":[]}'
expect_unknown deep-nesting "{\"categories\":$(python3 -I -c 'print("["*200000)')"
expect_unknown non-json 'I could not do this task.'
expect_unknown empty ''
expect_unknown two-objects "$GOODJSON and also $GOODJSON"
expect_unknown over-cap "$(python3 -I -c 'import json
print(json.dumps({"categories":[{"items":[{"id":"I%d"%n,"title":"t","priority":"minor","verification":[{"type":"file_exists","path":"x"}]} for n in range(61)]}]}))')"
# a stale checklist.json from an earlier attempt must not survive a failure
mkdir -p "$ACC/out-stale"
printf '{}' > "$ACC/out-stale/checklist.json"
printf '' | python3 -I "$CA" accept --spec "$ACC_SPEC" --repo "$ACC_REPO" --out "$ACC/out-stale" >/dev/null 2>&1
[ ! -e "$ACC/out-stale/checklist.json" ] || fail "accept: stale checklist.json survived a failed attempt"

# an unreadable spec ends unknown with the sentinel and clears an earlier run's artifacts
if [ "$(id -u)" -ne 0 ]; then
    mkdir -p "$ACC/out-unreadable"
    printf '{}' > "$ACC/out-unreadable/checklist.json"
    printf '{"status":"authored"}' > "$ACC/out-unreadable/author.json"
    printf '# PRD\n' > "$ACC/unreadable.md"
    chmod 000 "$ACC/unreadable.md"
    printf '%s' "$GOODJSON" | python3 -I "$CA" accept --spec "$ACC/unreadable.md" --repo "$ACC_REPO" --out "$ACC/out-unreadable" >"$ACC/acc.log" 2>&1
    URC=$?
    chmod 600 "$ACC/unreadable.md"
    [ "$URC" -eq 1 ] || fail "accept unreadable spec: rc $URC, want 1"
    grep -q Traceback "$ACC/acc.log" && fail "accept unreadable spec: traceback"
    ACC_OUT="$ACC/out-unreadable"
    [ "$(acc_field status)" = unknown ] || fail "accept unreadable spec: status not unknown (stale authored survived)"
    [ ! -e "$ACC_OUT/checklist.json" ] || fail "accept unreadable spec: stale checklist.json survived"
    grep -q check_authoring_unknown "$ACC_OUT/verification-results.json" || fail "accept unreadable spec: no sentinel"
fi
# a failed accept replaces a prior authored status in the same out dir
acc_run stale-author "$GOODJSON"
[ "$(acc_field status)" = authored ] || fail "accept stale-author setup: not authored"
printf '{"categories":[{"items":[]}]}' | python3 -I "$CA" accept --spec "$ACC_SPEC" --repo "$ACC_REPO" --out "$ACC_OUT" >/dev/null 2>&1
[ "$(acc_field status)" = unknown ] || fail "accept: stale authored status survived a failed attempt"
[ ! -e "$ACC_OUT/checklist.json" ] || fail "accept: stale checklist.json survived a failed attempt"

# pre-pass result fields never reach the written checklist (contract.ts reads passed from it)
acc_run strip '{"categories":[{"items":[{"id":"S","title":"s","priority":"major","verification":[{"type":"file_exists","path":"x","passed":true,"status":"passing","output":"ok","verified_at":"now"}]}]}]}'
[ "$ACC_RC" -eq 0 ] || fail "accept strip: rc $ACC_RC"
python3 -I -c 'import json,sys
v=json.load(open(sys.argv[1]))["categories"][0]["items"][0]["verification"][0]
sys.exit(1 if set(v)&{"passed","status","output","verified_at"} else 0)' "$ACC_OUT/checklist.json" \
    || fail "accept: pre-pass result fields survived into checklist.json"

# a failing author.json write (ENOSPC) must still leave the sentinel and no stale pass
mkdir -p "$ACC/out-enospc"
printf '{"status":"authored"}' > "$ACC/out-enospc/author.json"
printf '{}' > "$ACC/out-enospc/checklist.json"
printf '{"categories":[{"items":[{"id":"OLD","title":"o","priority":"major","status":"passing","passed":true}]}]}' > "$ACC/out-enospc/verification-results.json"
printf '{"categories":[{"items":[]}]}' | python3 -I -c '
import errno, importlib.util, os, sys
ca, spec, repo, out = sys.argv[1:5]
m = importlib.util.spec_from_file_location("check_author_mod", ca)
mod = importlib.util.module_from_spec(m)
m.loader.exec_module(mod)
real = mod.atomic_write
def flaky(path, text):
    if path.endswith("author.json"):
        raise OSError(errno.ENOSPC, "No space left on device")
    return real(path, text)
mod.atomic_write = flaky
sys.exit(mod.main(["accept", "--spec", spec, "--repo", repo, "--out", out]))
' "$CA" "$ACC_SPEC" "$ACC_REPO" "$ACC/out-enospc" >"$ACC/acc.log" 2>&1
ERC=$?
[ "$ERC" -eq 1 ] || fail "accept ENOSPC: rc $ERC, want 1"
grep -q Traceback "$ACC/acc.log" && fail "accept ENOSPC: traceback"
grep -q check_authoring_unknown "$ACC/out-enospc/verification-results.json" || fail "accept ENOSPC: sentinel missing (stale results survived)"
[ ! -e "$ACC/out-enospc/checklist.json" ] || fail "accept ENOSPC: stale checklist.json survived"
grep -q authored "$ACC/out-enospc/author.json" 2>/dev/null && fail "accept ENOSPC: stale authored status survived"

# accept never opens, lists or spawns anything under --repo (audit hook: open,
# os.listdir, os.scandir, and any subprocess/system/exec/spawn event)
printf '%s' "$GOODJSON" | python3 -I -c '
import os, runpy, sys
ca, repo, spec, out = sys.argv[1:5]
repo = os.path.realpath(repo)
touched = []
def under(p):
    if isinstance(p, (str, bytes, os.PathLike)):
        return os.path.realpath(os.fsdecode(p)).startswith(repo)
    return False
def hook(event, args):
    if event in ("open", "os.listdir", "os.scandir", "os.chdir", "os.walk"):
        if args and under(args[0]):
            touched.append("%s:%s" % (event, os.fsdecode(args[0])))
    elif event in ("subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty"):
        touched.append(event)
sys.addaudithook(hook)
sys.argv = [ca, "accept", "--spec", spec, "--repo", repo, "--out", out]
try:
    runpy.run_path(ca, run_name="__main__")
except SystemExit:
    pass
sys.stderr.write("TOUCHED:" + ",".join(touched) + "\n")
' "$CA" "$ACC_REPO" "$ACC_SPEC" "$ACC/out-spy" 2>"$ACC/spy.log"
grep -q '^TOUCHED:$' "$ACC/spy.log" || fail "accept touched the repo tree: $(cat "$ACC/spy.log")"
[ -f "$ACC/out-spy/checklist.json" ] || fail "accept spy run did not complete the happy path"

# the context prompt tells the author the checklist format
python3 -I "$CA" context --spec "$ACC_SPEC" --repo "$ACC_REPO" | grep -q 'categories' || fail "context prompt lacks the checklist format"



# Walled check author (checklist_author): the real function against a stub
# provider on PATH. The stub records its cwd, what that directory held, and the
# prompt, then answers per STUB_MODE.
AU="$T/author"
mkdir -p "$AU/bin" "$AU/proj-repo-xyz/.loki/state"
cat > "$AU/bin/claude" <<'STUB'
#!/usr/bin/env bash
case " $* " in *" -p "*) ;; *) exit 0 ;; esac
n=$(cat "$STUB_DIR/count" 2>/dev/null || echo 0)
echo $((n + 1)) > "$STUB_DIR/count"
pwd -P > "$STUB_DIR/cwd"
ls -A | wc -l | tr -d ' ' > "$STUB_DIR/cwd-entries"
cat > "$STUB_DIR/prompt"
case "${STUB_MODE:-good}" in
    good) reply="$STUB_GOOD" ;;
    bad) reply='I could not do this.' ;;
    second) if [ "$n" -ge 1 ]; then reply="$STUB_GOOD"; else reply='no'; fi ;;
esac
# the real CLI wraps the reply when asked for --output-format json
case " $* " in
    *" --output-format json "*) python3 -I -c 'import json,sys;print(json.dumps({"type":"result","result":sys.argv[1]}))' "$reply" ;;
    *) printf '%s\n' "$reply" ;;
esac
exit 0
STUB
chmod +x "$AU/bin/claude"
AUP="$AU/proj-repo-xyz"
printf '# PRD\nGreet people.\n' > "$AU/spec.md"
printf '{}\n' > "$AUP/package.json"
printf 'secret implementation\n' > "$AUP/impl.txt"
( cd "$AUP" && git init -q && git add package.json impl.txt ) >/dev/null 2>&1
cat > "$AU/driver.sh" <<DRV
set -u
log_info() { printf '%s\n' "\$*" >> "$AU/info.log"; }
log_step() { :; }
log_warn() { printf '%s\n' "\$*" >> "$AU/warn.log"; }
export CHECKLIST_ENABLED=true CHECKLIST_TIMEOUT=5 STUB_DIR="$AU" STUB_GOOD='$GOODJSON' STUB_MODE="\${STUB_MODE:-good}"
export PATH="$AU/bin:\$PATH" LOKI_PROVIDER="\${LOKI_PROVIDER:-claude}" TMPDIR="$AU/tmp"
mkdir -p "$AU/tmp"
. "$SRC_DIR/prd-checklist.sh"
checklist_init "$AU/spec.md"
checklist_select_heldout() { :; }
checklist_oracle_triangulate() { :; }
checklist_author "$AU/spec.md"; arc=\$?
echo "author=\$arc digest=\${CHECKLIST_FROZEN_DIGEST:-none}"
eval "\${AFTER:-:}"
DRV
au_run() {  # <mode> [after-hook]: echoes the driver's summary lines
    ( cd "$AUP" && STUB_MODE="$1" AFTER="${2:-:}" PRISTINE_JSON="$PRISTINE" AU_SPEC="$AU/spec.md" bash "$AU/driver.sh" 2>/dev/null )
}
au_field() { python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2]))' "$AUP/.loki/checklist/author.json" "$1" 2>/dev/null; }
au_calls() { cat "$AU/count" 2>/dev/null || echo 0; }
au_reset() { rm -r "$AUP/.loki/checklist" 2>/dev/null; rm -f "$AU/count"; }

# success: authored in an empty cwd, prompt never names the repo, frozen
au_reset
out="$(au_run good)"
case "$out" in "author=0 digest="[0-9a-f]*) ;; *) fail "author success: $out" ;; esac
[ "$(au_field status)" = authored ] || fail "author success: status not authored"
[ -f "$AUP/.loki/checklist/checklist.json" ] || fail "author success: no checklist.json"
[ "$(cat "$AU/cwd-entries" 2>/dev/null)" = 0 ] || fail "author: cwd was not empty ($(cat "$AU/cwd-entries" 2>/dev/null))"
case "$(cat "$AU/cwd" 2>/dev/null)" in "$(cd "$AUP" && pwd -P)"*) fail "author: provider ran inside the repo" ;; "") fail "author: provider never ran" ;; esac
grep -q 'proj-repo-xyz' "$AU/prompt" && fail "author: prompt names the repo path"
grep -q 'secret implementation' "$AU/prompt" && fail "author: prompt leaks implementation"
grep -q 'no-tools' "$AUP/.loki/checklist/author-isolation.txt" || fail "author: claude isolation label missing"
[ "$(au_calls)" = 1 ] || fail "author success: provider calls $(au_calls), want 1"
ls "$AU"/tmp/loki-author.* >/dev/null 2>&1 && fail "author: run-owned work dir left behind"
# same process, authored twice: the in-memory digest lets the second call skip the provider
au_reset
au_run good 'checklist_author "$AU_SPEC"' >/dev/null
[ "$(au_calls)" = 1 ] || fail "author: second call in the same process called the provider again ($(au_calls))"
au_reset
au_run good >/dev/null
# a restarted process holds no in-memory accepted digest and author.json is an
# unsigned file the implementer can forge, so it re-authors instead of trusting it
au_run good >/dev/null
[ "$(au_calls)" = 2 ] || fail "author: restart trusted an unsigned author.json ($(au_calls), want 2)"
# a changed spec is authored again
printf '# PRD\nGreet people loudly.\n' > "$AU/spec.md"
au_run good >/dev/null
[ "$(au_calls)" = 3 ] || fail "author: changed spec was not re-authored ($(au_calls))"
printf '# PRD\nGreet people.\n' > "$AU/spec.md"

# first attempt bad, second good: authored on attempt 2
au_reset
au_run second >/dev/null
{ [ "$(au_field status)" = authored ] && [ "$(au_field attempts)" = 2 ]; } || fail "author retry: status $(au_field status) attempts $(au_field attempts)"

# always bad: exactly 2 attempts, sentinel, no checklist; an implementer-written
# checklist.json is refused by freeze and never verified
au_reset
out="$(au_run bad 'printf "%s\n" "$PRISTINE_JSON" > .loki/checklist/checklist.json; checklist_freeze_once; echo "freeze_after_impl=$? digest=${CHECKLIST_FROZEN_DIGEST:-none}"; checklist_verify; echo "verify_after_impl=$?"')"
case "$out" in "author=1 digest=none"*) ;; *) fail "author failure: $out" ;; esac
[ "$(au_calls)" = 2 ] || fail "author failure: $(au_calls) attempts, want 2"
[ "$(au_field status)" = unknown ] || fail "author failure: status not unknown"
grep -q check_authoring_unknown "$AUP/.loki/checklist/verification-results.json" || fail "author failure: sentinel missing"
case "$out" in *"freeze_after_impl=1 digest=none"*) ;; *) fail "implementer-written checklist.json was frozen: $out" ;; esac
case "$out" in *"verify_after_impl=0"*) fail "verify succeeded on an implementer-written checklist: $out" ;; esac
grep -q 'not authored by the check author' "$AU/warn.log" || fail "freeze refusal not logged"
# restart after two failed attempts does not call the provider again
rm -f "$AU/count" "$AUP/.loki/checklist/checklist.json"
au_run good >/dev/null
[ "$(au_calls)" = 0 ] || fail "author: provider called again after two failed attempts"

# forge: the author fails, then the implementer writes checklist.json AND a
# matching author.json itself; freeze must still refuse (author.json is not bound
# to the checklist content)
au_reset
out="$(au_run bad 'sp="$(python3 -I -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],\"rb\").read()).hexdigest())" "$AU_SPEC")"; printf "%s\n" "$PRISTINE_JSON" > .loki/checklist/checklist.json; printf "{\"status\":\"authored\",\"spec_sha256\":\"%s\"}" "$sp" > .loki/checklist/author.json; checklist_freeze_once; echo "forge_freeze=$? digest=${CHECKLIST_FROZEN_DIGEST:-none}"')"
case "$out" in *"forge_freeze=1 digest=none"*) ;; *) fail "forged author.json froze an implementer checklist: $out" ;; esac
grep -q 'does not match the checklist the check author produced' "$AU/warn.log" || fail "forge refusal not logged"
# forge after a real authoring: the implementer swaps in its own checklist.json
# (author.json left authored) before a fresh freeze; the digest comparison refuses
au_reset
out="$(au_run good 'CHECKLIST_FROZEN_DIGEST=""; printf "%s\n" "$PRISTINE_JSON" > .loki/checklist/checklist.json; checklist_freeze_once; echo "swap_freeze=$? digest=${CHECKLIST_FROZEN_DIGEST:-none}"')"
case "$out" in *"swap_freeze=1 digest=none"*) ;; *) fail "swapped checklist.json froze after authoring: $out" ;; esac

# codex and seam providers: cwd-only, never claimed tool-denied
au_reset
( cd "$AUP" && LOKI_PROVIDER=codex STUB_MODE=bad bash "$AU/driver.sh" >/dev/null 2>&1 )
grep -q 'check author isolation: cwd-only' "$AUP/.loki/checklist/author-isolation.txt" || fail "codex: isolation label not cwd-only"
grep -qi 'tool' "$AUP/.loki/checklist/author-isolation.txt" && fail "codex: isolation label claims tool denial"

# static wiring: run.sh calls the author after checklist_init and skips the INIT
# prompt on author.json; the text-only role list names check_author
grep -A3 'checklist_init "\$prd_path"' "$SRC_DIR/run.sh" | grep -q 'checklist_author "\$prd_path"' || fail "run.sh does not call checklist_author after checklist_init"
grep -q '! -f ".loki/checklist/author.json" \]; then' "$SRC_DIR/run.sh" || fail "run.sh INIT prompt not skipped on author.json"
grep -q 'grill|check_author|' "$SRC_DIR/lib/claude-flags.sh" || fail "check_author missing from text-only roles"

if [ "$INNER" = 0 ] && [ -z "${LOKI_FREEZE_SRC_DIR:-}" ]; then
    mutate() {  # <name> <file> <old> <new> [<old2> <new2>]  (same file, applied in order)
        local name="$1" file="$2" old="$3" new="$4" old2="${5:-}" new2="${6:-}" dir="$T/mut-$1"
        mkdir -p "$dir"
        cp "$SRC_DIR"/prd-checklist.sh "$SRC_DIR"/checklist-verify.py "$SRC_DIR"/run.sh "$dir/"
        cp -R "$SRC_DIR/lib" "$SRC_DIR/grill.sh" "$dir/"
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
    mutate author-gate-off prd-checklist.sh 'if [ "$CHECKLIST_AUTHOR_REQUIRED" = "true" ]; then' 'if false; then'
    mutate author-runs-in-repo prd-checklist.sh 'out="$(cd "$cwd" && LOKI_DIR' 'out="$(LOKI_DIR'
    mutate author-not-once prd-checklist.sh 'if [ "$prior_status" = "authored" ] && [ -n "$_CHECKLIST_AUTHORED_DIGEST" ]; then' 'if false; then'
    mutate drop-authored-digest-compare prd-checklist.sh '[ -z "$_CHECKLIST_AUTHORED_DIGEST" ] || [ "$(_checklist_file_sha "$CHECKLIST_FILE")" != "$_CHECKLIST_AUTHORED_DIGEST" ]' 'false'
    mutate author-unbounded prd-checklist.sh 'CHECKLIST_AUTHOR_MAX_ATTEMPTS=2' 'CHECKLIST_AUTHOR_MAX_ATTEMPTS=3'
    mutate runsh-drops-author-call run.sh 'checklist_author "$prd_path" || true' ':'
    mutate runsh-keeps-init-prompt run.sh ' && [ ! -f ".loki/checklist/author.json" ]; then' '; then'
    mutate harness-omits-digest prd-checklist.sh '--expect-digest "$CHECKLIST_FROZEN_DIGEST"' '--timeout 5'
fi

if [ "$FAIL" -eq 0 ]; then echo "PASS: checklist freeze"; exit 0; fi
exit 1
