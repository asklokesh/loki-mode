#!/usr/bin/env bash
# tests/test-proven-pr-installed-layout.sh -- T8 / F47 guard for the Proven PR
# loop (Loop 6, v7.90.0).
#
# THE POINT (the F47 ship-bug class): the Evidence Receipt we write into a PR
# body cites `loki proof verify <id>` as the "verify it yourself" command. That
# command is only honest if it actually WORKS for a real user who installed Loki
# from npm. F47 was a real ship bug where, in the INSTALLED layout, the verify
# path could not resolve the verifier (autonomy/lib/proof-verify.py). This test
# re-runs that lesson on ship: it builds the npm tarball, extracts it to a temp
# dir (the installed layout), and runs `loki proof verify <id>` from THAT layout
# on three fixtures, asserting the verifier path resolves and the bash exit
# contract holds:
#   - clean proof   -> exit 0 AND stdout reports a real verdict ("ok": true)
#   - tampered proof -> exit 1 (hash mismatch; the verifier ran)
#   - malformed proof-> exit 2 AND stdout shows the verifier's load error
#
# The F47 CATCH is the clean-case exit 0 with real verifier output. If the
# layout cannot find the verifier, bash cmd_proof prints "Verifier not found"
# and exits 2 -- the SAME code as a malformed proof. So an exit-2 assertion
# alone cannot distinguish "path did not resolve" (the F47 bug) from "correctly
# rejected bad input." We therefore (1) assert the clean case returns 0 with
# real output, and (2) assert the string "Verifier not found" is ABSENT in every
# case. Together these prove the verifier path resolved in the installed layout.
#
# Routes exercised against the installed layout:
#   1. package/autonomy/loki proof verify ...           (bash, direct -- the
#      tightest F47 surface: exercises ${_LOKI_SCRIPT_DIR}/lib/proof-verify.py
#      with no shim)
#   2. LOKI_LEGACY_BASH=1 package/bin/loki proof verify (shim -> bash handoff)
#   3. package/bin/loki proof verify ...                (Bun default route, only
#      when loki-ts/dist/loki.js was packed and bun is on PATH -- the real-user
#      default route; proof.ts resolves REPO_ROOT/autonomy/lib/proof-verify.py)
#
# SAFETY (non-negotiable, v7.72 real-tunnel burn): this test NEVER opens a real
# PR, NEVER posts a real check-run, NEVER calls gh / gh api. It builds fixtures
# in a temp git repo with a temp HOME and temp LOKI_DIR; it only invokes the
# read-only `loki proof verify` path. npm pack is run with --ignore-scripts so a
# prepack build cannot run (autonomy/lib/*.py are static, included by the files
# array regardless).
#
# This test owns ONLY itself; it writes nothing into the repo under test.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
SKIP=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
ok()   { echo "ok: $1"; PASS=$((PASS+1)); }
skip() { echo "SKIP: $1"; SKIP=$((SKIP+1)); }

# --- Workspace (temp HOME + temp build/extract dirs) -------------------------
WORK="$(mktemp -d -t loki-t8-installed.XXXXXX)"
FAKE_HOME="$(mktemp -d -t loki-t8-home.XXXXXX)"
cleanup() {
    rm -rf "$WORK" "$FAKE_HOME" 2>/dev/null || true
}
trap cleanup EXIT

# Hermetic env for every packed-loki invocation: a temp HOME so first-run /
# telemetry / disclosure markers never touch the real HOME, and DO_NOT_TRACK to
# silence any egress attempt. LOKI_DIR is set per-invocation to the temp repo.
export HOME="$FAKE_HOME"
export DO_NOT_TRACK=1
export LOKI_TELEMETRY_DISABLED=true

# --- Preconditions -----------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
    fail "npm not available; cannot build the installed layout"
    echo ""
    echo "Result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
    exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 not available; cannot build a valid proof fixture"
    echo ""
    echo "Result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
    exit 1
fi
if ! command -v git >/dev/null 2>&1; then
    fail "git not available; cannot build the temp repo"
    echo ""
    echo "Result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
    exit 1
fi

# --- 1. Build the npm tarball from the repo under test -----------------------
# --ignore-scripts: skip prepack (a dist/dashboard build that is slow / may fail
# in a worktree). autonomy/lib/*.py and *.sh are static files included by the
# package.json "files" array, so they are packed regardless.
echo "Building npm tarball (npm pack --ignore-scripts)..."
PACK_JSON="$WORK/pack.json"
if ! ( cd "$REPO_ROOT" && npm pack --ignore-scripts --pack-destination "$WORK" --json >"$PACK_JSON" 2>"$WORK/pack.err" ); then
    fail "npm pack failed"
    echo "--- npm pack stderr ---"; cat "$WORK/pack.err" 2>/dev/null | tail -20
    echo ""
    echo "Result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
    exit 1
fi

# Resolve the produced tarball filename.
TARBALL="$(python3 - "$PACK_JSON" "$WORK" <<'PYEOF'
import json, os, sys
pack_json, work = sys.argv[1], sys.argv[2]
try:
    with open(pack_json) as f:
        data = json.load(f)
    name = data[0]["filename"] if isinstance(data, list) and data else ""
except Exception:
    name = ""
# npm may report just the filename or a path; normalize to an absolute path in WORK.
if name:
    cand = name if os.path.isabs(name) else os.path.join(work, os.path.basename(name))
    if os.path.isfile(cand):
        print(cand); raise SystemExit(0)
# Fallback: glob the work dir for the single produced .tgz.
import glob
tgz = sorted(glob.glob(os.path.join(work, "*.tgz")))
print(tgz[0] if tgz else "")
PYEOF
)"
if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
    fail "could not locate packed tarball"
    echo ""
    echo "Result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
    exit 1
fi
ok "npm pack produced tarball: $(basename "$TARBALL")"

# --- 2. Assert the verifier AND the receipt renderer are in the pack ---------
# A dry-run lists the packed contents. The verify path needs proof-verify.py;
# the Proven PR feature also needs proof-pr.sh (the shared receipt renderer).
PACK_LIST="$WORK/pack-list.txt"
( cd "$REPO_ROOT" && npm pack --ignore-scripts --dry-run >"$PACK_LIST" 2>&1 ) || true

# Anchor the match on a trailing path boundary (whitespace / end of line) so a
# sibling like proof-verify.py.MUTANT cannot false-match the substring. grep -F
# fixes the literal dot; the [[:space:]] / $ alternation pins the file end.
if grep -E "autonomy/lib/proof-verify\.py([[:space:]]|$)" "$PACK_LIST" >/dev/null 2>&1; then
    ok "tarball includes autonomy/lib/proof-verify.py (verify path packed)"
else
    fail "tarball MISSING autonomy/lib/proof-verify.py -- F47 class: verify path not shipped"
fi

# proof-pr.sh is Slice A's shared renderer. It is copied into this worktree's
# autonomy/lib/ for the T8 build (Slice A is still being integrated). If the
# integrator confirms Slice A landed, this assertion stays green; if the file is
# absent (Slice A not yet merged into the branch under test), the test reports a
# clear, actionable line and the INTEGRATOR MUST confirm proof-pr.sh is packed
# once Slice A is integrated. It is a FAIL by default because the Proven PR
# feature is broken without the renderer in the tarball.
if grep -E "autonomy/lib/proof-pr\.sh([[:space:]]|$)" "$PACK_LIST" >/dev/null 2>&1; then
    ok "tarball includes autonomy/lib/proof-pr.sh (receipt renderer packed)"
else
    fail "tarball MISSING autonomy/lib/proof-pr.sh -- INTEGRATOR: confirm Slice A's proof-pr.sh is committed under autonomy/lib/ so it is packed (the Evidence Receipt renderer must ship)"
fi

# --- 3. Extract the tarball to the installed layout --------------------------
EXTRACT="$WORK/installed"
mkdir -p "$EXTRACT"
if ! tar -xzf "$TARBALL" -C "$EXTRACT" 2>"$WORK/tar.err"; then
    fail "could not extract tarball"
    cat "$WORK/tar.err" 2>/dev/null | tail -5
    echo ""
    echo "Result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
    exit 1
fi
# npm tarballs unpack under a top-level "package/" dir.
PKG="$EXTRACT/package"
if [ ! -d "$PKG" ]; then
    fail "extracted tarball has no package/ dir"
    echo ""
    echo "Result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
    exit 1
fi
PKG_LOKI="$PKG/autonomy/loki"
PKG_BIN="$PKG/bin/loki"
PKG_VERIFIER="$PKG/autonomy/lib/proof-verify.py"
for f in "$PKG_LOKI" "$PKG_BIN" "$PKG_VERIFIER"; do
    rel="${f#"$PKG"/}"
    if [ -f "$f" ]; then
        ok "installed layout has $rel"
    else
        fail "installed layout MISSING $rel"
    fi
done
chmod +x "$PKG_LOKI" "$PKG_BIN" 2>/dev/null || true

# --- 4. Build a temp git repo with a real diff -------------------------------
REPO="$WORK/repo"
mkdir -p "$REPO"
(
    cd "$REPO"
    git init -q
    git config user.email "t8@example.com"
    git config user.name "T8 SDET"
    git config commit.gpgsign false
    printf 'line one\n' > app.txt
    git add app.txt
    git commit -q -m "base"
    printf 'line one\nline two added\n' > app.txt
    printf 'brand new file\n' > extra.txt
    git add app.txt extra.txt
    git commit -q -m "head"
) || { fail "could not build temp git repo"; echo ""; echo "Result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"; exit 1; }

BASE_SHA="$(cd "$REPO" && git rev-parse HEAD~1)"
HEAD_SHA="$(cd "$REPO" && git rev-parse HEAD)"

# --- 5. Build the three proof fixtures using the PACKED verifier's helpers ---
# Using the packed proof-verify.py's own _numstat / _diff_sha256_from_stat /
# _canonical to BUILD the fixture guarantees recorded == recomputed, so a clean
# proof verifies (no false drift) and the hash matches (no false tamper). This
# is the honest way to prove the path resolves: the verdict is real, not forced.
PROOFS_DIR="$REPO/.loki/proofs"
CLEAN_ID="clean-run-0001"
TAMPER_ID="tamper-run-0002"
MALFORMED_ID="malformed-run-0003"
mkdir -p "$PROOFS_DIR/$CLEAN_ID" "$PROOFS_DIR/$TAMPER_ID" "$PROOFS_DIR/$MALFORMED_ID"

if ! python3 - "$PKG_VERIFIER" "$REPO" "$BASE_SHA" "$HEAD_SHA" \
        "$PROOFS_DIR/$CLEAN_ID/proof.json" \
        "$PROOFS_DIR/$TAMPER_ID/proof.json" \
        "$PROOFS_DIR/$MALFORMED_ID/proof.json" <<'PYEOF'
import hashlib
import importlib.util
import json
import sys

verifier_path = sys.argv[1]
repo = sys.argv[2]
base_sha = sys.argv[3]
head_sha = sys.argv[4]
clean_out = sys.argv[5]
tamper_out = sys.argv[6]
malformed_out = sys.argv[7]

# Import the PACKED verifier as a module so the fixture is built with the exact
# same canonicalization + stat-hash the verifier will re-derive.
spec = importlib.util.spec_from_file_location("pv_packed", verifier_path)
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)

# Re-derive the diff stat the same way the verifier will (base..HEAD).
stat = pv._numstat(repo, base_sha, "HEAD")
if stat is None:
    sys.stderr.write("could not compute numstat for fixture\n")
    raise SystemExit(1)

diff_block = {
    "count": stat["count"],
    "insertions": stat["insertions"],
    "deletions": stat["deletions"],
    "files": stat["files"],
}
diff_sha = pv._diff_sha256_from_stat(stat)

# A coherent VERIFIED proof: tests verified with a real command + exit 0, a
# non-empty diff, no degraded gaps. (Mirrors _compute_headline's VERIFIED rule;
# the verifier itself does not recompute the headline, but we keep the fixture
# internally honest.)
proof = {
    "schema_version": "1.1",
    "run_id": clean_out.split("/")[-2],
    "generated_at": "2026-06-20T00:00:00Z",
    "honesty": {
        "headline": "VERIFIED",
        "degraded": [],
    },
    "facts": {
        "git": {
            "base_sha": base_sha,
            "head_sha": head_sha,
            "diff": diff_block,
            "diff_sha256": diff_sha,
        },
        "tests": {"status": "verified", "command": "echo ok", "exit_code": 0},
        "build": {"status": "verified", "command": "true"},
        "security": {"ran": True, "high_active": 0},
        "cost": {"usd": 0.0123},
        "meta": {"run_id": clean_out.split("/")[-2]},
    },
    # Mirror the diff at top-level too (schema-tolerant verifier reads facts.git
    # first; this keeps the fixture readable by older code paths as well).
    "files_changed": diff_block,
}

def _sign(p):
    """Attach a correct integrity hash exactly as the generator does: sha256 of
    the canonical form with verification removed."""
    unsigned = dict(p)
    unsigned.pop("verification", None)
    digest = hashlib.sha256(pv._canonical(unsigned).encode("utf-8")).hexdigest()
    p["verification"] = {"hash": digest, "algo": "sha256", "scope": "integrity"}
    return p

# CLEAN: correctly signed, facts match the repo -> verifier should report ok.
with open(clean_out, "w") as f:
    json.dump(_sign(dict(proof)), f, indent=2)

# TAMPER: sign first, THEN mutate a field after signing -> hash mismatch -> the
# verifier ran and detected tampering -> exit 1. (A missing file would be a
# different bash-exit-1 path; we want the verifier's own tamper verdict.)
tampered = _sign(dict(proof))
tampered["run_id"] = "EDITED-AFTER-SIGNING"
tampered["facts"]["cost"]["usd"] = 9999.99
with open(tamper_out, "w") as f:
    json.dump(tampered, f, indent=2)

# MALFORMED: a PRESENT file with invalid JSON content -> the verifier's loader
# raises ProofLoadError -> exit 2 with a load error on stdout. (Never a missing
# file, which bash guards to exit 1 before python runs.)
with open(malformed_out, "w") as f:
    f.write("{ this is : not valid json ,,, ")

print("fixtures built")
PYEOF
then
    fail "could not build proof fixtures"
    echo ""
    echo "Result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
    exit 1
fi
ok "built clean / tampered / malformed proof fixtures with the packed verifier helpers"

# --- 6. The route runner -----------------------------------------------------
# Runs `loki proof verify <id>` from the INSTALLED layout against the temp repo.
# Captures combined stdout+stderr and the exit code. LOKI_DIR points the proof
# lookup at the temp repo; TARGET_DIR points the drift re-check at the same repo;
# CWD is the temp repo so a default "." also resolves correctly.
#
# Args: <label> <command-prefix...> -- the command must accept "proof verify <id>"
run_route_clean() {
    local label="$1"; shift
    local out rc
    out="$( cd "$REPO" && LOKI_DIR="$REPO/.loki" TARGET_DIR="$REPO" "$@" proof verify "$CLEAN_ID" 2>&1 )"
    rc=$?
    # F47 catch: clean proof MUST exit 0 with a real verdict, and MUST NOT print
    # "Verifier not found" (which would mean the path did not resolve).
    if printf '%s' "$out" | grep -q "Verifier not found"; then
        fail "[$label] clean: 'Verifier not found' printed -- F47: verifier path did NOT resolve in the installed layout"
        return
    fi
    if [ "$rc" -ne 0 ]; then
        fail "[$label] clean: expected exit 0, got $rc"
        printf '%s\n' "$out" | tail -8
        return
    fi
    if printf '%s' "$out" | grep -qE '"ok"[[:space:]]*:[[:space:]]*true'; then
        ok "[$label] clean proof -> exit 0 with real verifier verdict (\"ok\": true) -- verifier path resolved"
    else
        fail "[$label] clean: exit 0 but stdout did not contain a real verdict (\"ok\": true)"
        printf '%s\n' "$out" | tail -8
    fi
}

run_route_tamper() {
    local label="$1"; shift
    local out rc
    out="$( cd "$REPO" && LOKI_DIR="$REPO/.loki" TARGET_DIR="$REPO" "$@" proof verify "$TAMPER_ID" 2>&1 )"
    rc=$?
    if printf '%s' "$out" | grep -q "Verifier not found"; then
        fail "[$label] tamper: 'Verifier not found' printed -- F47: verifier path did NOT resolve"
        return
    fi
    if [ "$rc" -eq 1 ]; then
        ok "[$label] tampered proof -> exit 1 (verifier ran and detected hash mismatch)"
    else
        fail "[$label] tamper: expected exit 1, got $rc"
        printf '%s\n' "$out" | tail -8
    fi
}

run_route_malformed() {
    local label="$1"; shift
    local out rc
    out="$( cd "$REPO" && LOKI_DIR="$REPO/.loki" TARGET_DIR="$REPO" "$@" proof verify "$MALFORMED_ID" 2>&1 )"
    rc=$?
    if printf '%s' "$out" | grep -q "Verifier not found"; then
        fail "[$label] malformed: 'Verifier not found' printed -- F47: verifier path did NOT resolve"
        return
    fi
    if [ "$rc" -ne 2 ]; then
        fail "[$label] malformed: expected exit 2, got $rc"
        printf '%s\n' "$out" | tail -8
        return
    fi
    # Exit 2 must come FROM the verifier (a load error), not from path resolution.
    if printf '%s' "$out" | grep -qiE 'malformed|error'; then
        ok "[$label] malformed proof -> exit 2 with verifier load error (the 2 came from the verifier, not a missing path)"
    else
        fail "[$label] malformed: exit 2 but no verifier load error in output (cannot prove the 2 came from the verifier)"
        printf '%s\n' "$out" | tail -8
    fi
}

# --- 7. Route 1: bash, direct (tightest F47 surface) -------------------------
echo ""
echo "=== Route 1: package/autonomy/loki (bash, direct) ==="
run_route_clean    "bash-direct" bash "$PKG_LOKI"
run_route_tamper   "bash-direct" bash "$PKG_LOKI"
run_route_malformed "bash-direct" bash "$PKG_LOKI"

# --- 8. Route 2: shim -> bash handoff ----------------------------------------
echo ""
echo "=== Route 2: LOKI_LEGACY_BASH=1 package/bin/loki (shim -> bash) ==="
run_route_clean    "shim-bash" env LOKI_LEGACY_BASH=1 bash "$PKG_BIN"
run_route_tamper   "shim-bash" env LOKI_LEGACY_BASH=1 bash "$PKG_BIN"
run_route_malformed "shim-bash" env LOKI_LEGACY_BASH=1 bash "$PKG_BIN"

# --- 9. Route 3: Bun default route (real-user default) -----------------------
echo ""
echo "=== Route 3: package/bin/loki (Bun default route) ==="
if command -v bun >/dev/null 2>&1 && [ -f "$PKG/loki-ts/dist/loki.js" ]; then
    run_route_clean    "bun" bash "$PKG_BIN"
    run_route_tamper   "bun" bash "$PKG_BIN"
    run_route_malformed "bun" bash "$PKG_BIN"
else
    if ! command -v bun >/dev/null 2>&1; then
        skip "Bun route: bun not on PATH. Run on a bun host: (cd <installed>/package && LOKI_DIR=<repo>/.loki TARGET_DIR=<repo> bin/loki proof verify <id>) -- expect 0/1/2"
    else
        skip "Bun route: loki-ts/dist/loki.js not in the packed tarball. Build dist then re-pack to exercise the Bun default route."
    fi
fi

# --- Result ------------------------------------------------------------------
echo ""
echo "Result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
