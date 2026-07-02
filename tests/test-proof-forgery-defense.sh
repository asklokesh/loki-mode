#!/usr/bin/env bash
# tests/test-proof-forgery-defense.sh
#
# Proves the honest scope of proof-verify.py's forgery defense (v7.111.0).
#
# This test locks THREE facts about the verifier, and is deliberately explicit
# that the CRITICAL non-forgeability gap is MITIGATED + RELABELED, NOT closed:
#
#   (a) GENUINE proof            -> ok:true, headline_consistent:true.
#   (b) INCONSISTENT forgery     -> ok:false, headline_consistent:false.
#         (headline flipped to VERIFIED, facts left not_run, integrity hash
#          recomputed by the forger). This is what the defense-in-depth catches:
#          a headline that disagrees with the facts it claims to summarize.
#   (c) CONSISTENT forgery on the UNSIGNED path -> STILL ok:true, and the output
#         honestly reports generator_trusted:true. This PROVES we do NOT
#         overclaim: a forger who rewrites BOTH the facts AND the headline to a
#         mutually consistent lie and recomputes the hash STILL PASSES on the
#         unsigned path. Neutral non-forgeability needs the signed record, which
#         is founder-gated and out of scope.
#
# It ALSO proves the fix is real by running case (b) against the ORIGINAL
# proof-verify.py (git show HEAD:...) -- which lacks the headline_consistent
# gate and therefore returns ok:true for the inconsistent forgery -- and then
# against the working-tree (fixed) file, which returns ok:false. FAIL-on-old,
# PASS-on-new, for the same input.
#
# Self-skips (exit 0, SKIP) when git or python3 are unavailable. No network,
# no signing key required.

set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GENERATOR="$REPO/autonomy/lib/proof-generator.py"
VERIFIER="$REPO/autonomy/lib/proof-verify.py"

PASS=0
FAIL=0

_ok()   { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
_bad()  { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
_skip() { printf 'SKIP: %s\n' "$1"; exit 0; }

command -v git >/dev/null 2>&1 || _skip "git not available"
command -v python3 >/dev/null 2>&1 || _skip "python3 not available"
[ -f "$GENERATOR" ] || _skip "proof-generator.py not found"
[ -f "$VERIFIER" ] || _skip "proof-verify.py not found"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-proof-forgery-XXXXXX")"
cleanup() { rm -rf "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

GIT() { git -C "$PROJ" -c user.email=t@t.test -c user.name=tester "$@"; }

# --- build a real repo + one committed change + a genuine proof --------------
PROJ="$TMP/proj"
mkdir -p "$PROJ"
GIT init -q
printf 'one\n' > "$PROJ/a.txt"
GIT add a.txt
GIT commit -qm init
BASE="$(GIT rev-parse HEAD)"
printf 'one\ntwo\n' > "$PROJ/a.txt"
GIT add a.txt
GIT commit -qm second
mkdir -p "$PROJ/.loki"

if ! _LOKI_ITER_START_SHA="$BASE" python3 "$GENERATOR" \
        --loki-dir "$PROJ/.loki" --out-dir "$PROJ/out" \
        --run-id forgery-test --loki-version 7.111.0 --quiet; then
    _skip "proof generator failed (environment)"
fi
GENUINE="$PROJ/out/proof.json"
[ -f "$GENUINE" ] || _skip "generator produced no proof.json"

# Extract a single field from a verifier JSON result.
field() {  # field <json_file> <key>
    python3 - "$1" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
v = d.get(sys.argv[2])
print("true" if v is True else "false" if v is False else "null" if v is None else str(v))
PY
}

# Run a given verifier file, capture JSON to out_file. Echoes nothing.
run_verifier() {  # run_verifier <verifier_py> <proof_json> <repo_dir> <out_file>
    python3 "$1" "$2" "$3" > "$4" 2>/dev/null
    return 0
}

# Forge a proof: apply a python mutation, then recompute the integrity hash
# EXACTLY as the generator does (canonical = sort_keys + compact separators,
# with `verification` removed before hashing). This simulates a forger who
# rewrites facts and recomputes the hash -- the strongest unsigned attack.
forge() {  # forge <src_json> <dst_json> <python_mutation_body>
    local src="$1" dst="$2" body="$3"
    LOKI_FORGE_BODY="$body" python3 - "$src" "$dst" <<'PY'
import hashlib, json, os, sys
src, dst = sys.argv[1], sys.argv[2]
proof = json.load(open(src))
# The mutation body operates on `proof` in place.
exec(os.environ["LOKI_FORGE_BODY"])
# Recompute the integrity hash the way proof-generator._canonical + hash do:
# canonical JSON of the proof WITHOUT the verification block.
unsigned = dict(proof)
unsigned.pop("verification", None)
canon = json.dumps(unsigned, sort_keys=True, separators=(",", ":"))
h = hashlib.sha256(canon.encode("utf-8")).hexdigest()
proof.setdefault("verification", {})["hash"] = h
proof["verification"].pop("gpg_signature", None)  # unsigned path
with open(dst, "w") as f:
    json.dump(proof, f, indent=2)
PY
}

# ---------------------------------------------------------------------------
# (a) GENUINE proof verifies ok, headline_consistent true.
# ---------------------------------------------------------------------------
RES_A="$TMP/res_a.json"
run_verifier "$VERIFIER" "$GENUINE" "$PROJ" "$RES_A"
if [ "$(field "$RES_A" ok)" = "true" ] \
   && [ "$(field "$RES_A" headline_consistent)" = "true" ] \
   && [ "$(field "$RES_A" hash_ok)" = "true" ]; then
    _ok "(a) genuine proof verifies ok with headline_consistent=true"
else
    _bad "(a) genuine proof did not verify ok/consistent: $(cat "$RES_A")"
fi

# ---------------------------------------------------------------------------
# (b) INCONSISTENT forgery: flip headline to VERIFIED, leave facts not_run,
#     recompute hash. Must be caught: ok:false, headline_consistent:false.
# ---------------------------------------------------------------------------
FORGE_B="$TMP/forge_b.json"
forge "$GENUINE" "$FORGE_B" '
proof.setdefault("honesty", {})["headline"] = "VERIFIED"
# facts.tests.status left as-is (not_run) -- the lie is INCONSISTENT.
'
RES_B="$TMP/res_b.json"
run_verifier "$VERIFIER" "$FORGE_B" "$PROJ" "$RES_B"
if [ "$(field "$RES_B" ok)" = "false" ] \
   && [ "$(field "$RES_B" headline_consistent)" = "false" ]; then
    _ok "(b) inconsistent forgery caught: ok=false, headline_consistent=false"
else
    _bad "(b) inconsistent forgery NOT caught: $(cat "$RES_B")"
fi

# Also prove hash_ok stayed true (the forger DID recompute the hash) -- so the
# ONLY thing that caught it was the headline_consistent gate, not the hash.
if [ "$(field "$RES_B" hash_ok)" = "true" ]; then
    _ok "(b) hash_ok=true (forger recomputed hash); headline gate is what caught it"
else
    _bad "(b) expected hash_ok=true for a rehashed forgery: $(cat "$RES_B")"
fi

# ---------------------------------------------------------------------------
# (b') FIX PROOF: the SAME inconsistent forgery run against the ORIGINAL
#      proof-verify.py (before this fix) must PASS (ok:true) -- proving the
#      gate is new. If the original file cannot be recovered, skip this half.
# ---------------------------------------------------------------------------
OLD_VERIFIER="$TMP/old-proof-verify.py"
if git -C "$REPO" show HEAD:autonomy/lib/proof-verify.py > "$OLD_VERIFIER" 2>/dev/null \
   && [ -s "$OLD_VERIFIER" ]; then
    RES_B_OLD="$TMP/res_b_old.json"
    run_verifier "$OLD_VERIFIER" "$FORGE_B" "$PROJ" "$RES_B_OLD"
    OLD_OK="$(field "$RES_B_OLD" ok)"
    OLD_HC="$(field "$RES_B_OLD" headline_consistent)"
    # The old verifier either has no headline_consistent field (null) OR does
    # not gate ok on it -> the inconsistent forgery passes there.
    if [ "$OLD_OK" = "true" ] && [ "$OLD_HC" != "false" ]; then
        _ok "(b') old proof-verify.py PASSES the inconsistent forgery (fix is real: FAIL-on-old, PASS-on-new)"
    else
        # If HEAD already contains the fix (e.g. re-run after commit), this is
        # not a failure of the fix -- note it and continue.
        printf 'NOTE: old verifier gave ok=%s headline_consistent=%s (HEAD may already contain the fix)\n' \
            "$OLD_OK" "$OLD_HC"
    fi
else
    printf 'NOTE: could not recover HEAD:proof-verify.py; skipping FAIL-on-old half\n'
fi

# ---------------------------------------------------------------------------
# (c) CONSISTENT forgery on the UNSIGNED path: rewrite BOTH facts AND headline
#     to a matching lie (tests verified + exit_code 0 + command, no degraded,
#     headline VERIFIED), recompute hash. This STILL PASSES -- and the verifier
#     must honestly report generator_trusted:true. Proves we do NOT overclaim.
# ---------------------------------------------------------------------------
FORGE_C="$TMP/forge_c.json"
forge "$GENUINE" "$FORGE_C" '
tests = proof.setdefault("facts", {}).setdefault("tests", {})
tests["status"] = "verified"
tests["command"] = "pytest -q"
tests["exit_code"] = 0
# Make the headline consistent with the (lied) facts.
h = proof.setdefault("honesty", {})
h["headline"] = "VERIFIED"
h["degraded"] = []
'
RES_C="$TMP/res_c.json"
run_verifier "$VERIFIER" "$FORGE_C" "$PROJ" "$RES_C"
C_OK="$(field "$RES_C" ok)"
C_HC="$(field "$RES_C" headline_consistent)"
C_GT="$(field "$RES_C" generator_trusted)"
C_GPG="$(field "$RES_C" gpg_ok)"
if [ "$C_OK" = "true" ] && [ "$C_HC" = "true" ]; then
    _ok "(c) consistent unsigned forgery STILL passes (ok=true) -- we do NOT claim the CRITICAL is closed"
else
    _bad "(c) expected consistent unsigned forgery to still pass: $(cat "$RES_C")"
fi
if [ "$C_GT" = "true" ] && [ "$C_GPG" = "n/a" ]; then
    _ok "(c) verifier honestly reports generator_trusted=true, gpg_ok=n/a (unsigned; non-forgeability NOT guaranteed)"
else
    _bad "(c) verifier did not honestly disclose the unsigned/generator-trusted state: $(cat "$RES_C")"
fi

# ---------------------------------------------------------------------------
# (d) MIRROR-DRIFT CANARY: a CONSISTENT "VERIFIED WITH GAPS" proof must
#     round-trip to headline_consistent:true. _compute_headline reaches the
#     GAPS branch only via (any_verified AND degraded); this exercises that the
#     verifier's mirrored _compute_headline agrees with the generator's on that
#     branch (the generator stores the SAME degraded object it fed the headline,
#     proof-generator.py:730-734), so a mirror that drifts on GAPS would fail here.
# ---------------------------------------------------------------------------
FORGE_D="$TMP/forge_d.json"
forge "$GENUINE" "$FORGE_D" '
tests = proof.setdefault("facts", {}).setdefault("tests", {})
tests["status"] = "verified"
tests["command"] = "pytest -q"
tests["exit_code"] = 0
h = proof.setdefault("honesty", {})
h["headline"] = "VERIFIED WITH GAPS"
# Non-empty degraded -> any_verified AND degraded -> VERIFIED WITH GAPS.
h["degraded"] = [{"item": "build", "status": "not_run", "reason": "build not run"}]
'
RES_D="$TMP/res_d.json"
run_verifier "$VERIFIER" "$FORGE_D" "$PROJ" "$RES_D"
if [ "$(field "$RES_D" headline_consistent)" = "true" ]; then
    _ok "(d) VERIFIED WITH GAPS round-trips consistent (mirror agrees on the GAPS branch)"
else
    _bad "(d) GAPS mirror drift: verifier re-derived a different headline: $(cat "$RES_D")"
fi

# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
