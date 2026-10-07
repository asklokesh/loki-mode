#!/usr/bin/env bash
# FC-29 sibling sweep: no CLI path may let the receipt verifier hash an ambient
# cwd. autonomy/loki resolves the verified tree in ONE helper, loki_verify_root:
# explicit TARGET_DIR, then the parent of an absolute LOKI_DIR, then the cwd or
# repo top-level if it holds .loki, else a plain refusal (never "." by default).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${LOKI_GUARD_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
LOKI="$ROOT/autonomy/loki"
export LOKI_NO_BROWSER=1

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-vroot-XXXXXX")"
SCRATCH="$(cd "$SCRATCH" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT

echo "TEST: the verifier never defaults to the caller's cwd (FC-29 sweep)"

# Source guard: no verifier spawn takes "${TARGET_DIR:-.}" directly.
if grep -nE 'proof-verify|"\$verifier"' "$LOKI" | grep -F 'TARGET_DIR:-.' >/dev/null; then
    bad "a verifier spawn still passes \${TARGET_DIR:-.}"
else
    ok "no verifier spawn passes \${TARGET_DIR:-.}"
fi

# Pull the helper out of the CLI so it is tested as written.
_fn="$SCRATCH/fn.sh"
awk '/^loki_verify_root\(\) \{/{p=1} p{print} p&&/^}/{exit}' "$LOKI" > "$_fn"
if [ ! -s "$_fn" ]; then
    bad "loki_verify_root is missing from autonomy/loki"
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
fi

_root() { # <cwd> [env assignments...]
    local cwd="$1"; shift
    ( cd "$cwd" && env -u TARGET_DIR -u LOKI_DIR "$@" bash -c '. "$0"; loki_verify_root' "$_fn" 2>"$SCRATCH/err" )
}

BARE="$SCRATCH/bare"; mkdir -p "$BARE"
PROJ="$SCRATCH/proj"; mkdir -p "$PROJ/.loki" "$PROJ/sub/deep"
git -C "$PROJ" init -q 2>/dev/null

# 1. A non-project cwd is refused with a sentence.
out="$(_root "$BARE" HOME="$SCRATCH/nohome")"; rc=$?
if [ "$rc" -ne 0 ] && [ -z "$out" ] && grep -q 'Cannot tell which project tree' "$SCRATCH/err"; then
    ok "non-project cwd is refused with a plain sentence"
else
    bad "non-project cwd resolved to '$out' (rc=$rc)"
fi

# 2. $HOME is refused even when it holds a .loki dir.
mkdir -p "$SCRATCH/home/.loki"
out="$(_root "$SCRATCH/home" HOME="$SCRATCH/home")"; rc=$?
if [ "$rc" -ne 0 ] && [ -z "$out" ]; then ok "HOME is never a verify root"; else bad "HOME resolved to '$out'"; fi

# 3. A subdirectory of a project resolves to the project top-level.
out="$(_root "$PROJ/sub/deep" HOME="$SCRATCH/nohome")"; rc=$?
want="$(cd "$PROJ" && git rev-parse --show-toplevel)"
if [ "$rc" -eq 0 ] && [ "$out" = "$want" ]; then ok "subdirectory resolves to the project top-level"; else bad "subdir gave '$out' (rc=$rc), want '$want'"; fi

# 4. cwd holding .loki is used as is.
out="$(_root "$PROJ" HOME="$SCRATCH/nohome")"
[ "$out" = "$PROJ" ] && ok "cwd with .loki is the root" || bad "cwd with .loki gave '$out'"

# 5. Explicit TARGET_DIR wins.
out="$(_root "$BARE" HOME="$SCRATCH/nohome" TARGET_DIR="$PROJ")"
[ "$out" = "$PROJ" ] && ok "explicit TARGET_DIR wins" || bad "TARGET_DIR gave '$out'"

# 6. End to end: a bare cwd with a reachable proof exits 2 (NOT CHECKED), and
# never runs the verifier on the cwd.
mkdir -p "$BARE/p/.loki/proofs/r1"
echo '{"verification":{"hash":"x"}}' > "$BARE/p/.loki/proofs/r1/proof.json"
out="$(cd "$BARE" && env -u TARGET_DIR LOKI_DIR="p/.loki" HOME="$SCRATCH/nohome" LOKI_LEGACY_BASH=1 timeout -k 5 60 bash "$LOKI" proof verify r1 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q 'NOT CHECKED'; then
    ok "proof verify from a non-project cwd exits 2 NOT CHECKED"
else
    bad "proof verify from a non-project cwd gave rc=$rc: $out"
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
