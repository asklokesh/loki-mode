#!/usr/bin/env bash
# Moat property P1 - Portable proof.
#
# Claim: a signed proof verifies OFFLINE with only a public key, and
# verification FAILS on a different tree, a modified field, a wrong key, or a
# stripped signature.
#
# Contract (tests/moat): exactly one "CASE <ID> PASS|FAIL <desc>" stdout line
# per case, exit 0 whenever the script ran to completion. A missing
# prerequisite is a FAIL with "prerequisite missing: X", never a skip. Every
# verify runs with network egress blocked, so an accidental network dependency
# shows up here as a failure rather than as a pass on a connected laptop.
# P1_FORCE_EGRESS_FALLBACK=1 skips the kernel mechanisms to exercise the
# proxy fallback (labelled as such in the case description).
set -uo pipefail

T0=$(date +%s)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOKI="$ROOT/bin/loki"
GEN="$ROOT/autonomy/lib/proof-generator.py"

export LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 \
    CI=true LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false

IDS="P1.signed-proof-carries-attestation P1.offline-verify-bash P1.offline-verify-bun P1.different-tree-fails P1.modified-field-fails P1.wrong-key-fails P1.stripped-signature-fails"

# Newlines in a reason (a python traceback, say) are folded so every case stays
# exactly one stdout line.
report() { printf 'CASE %s %s %s\n' "$1" "$2" "$(printf '%s' "$3" | tr '\n' ' ')"; }
fail_all() {
    local id
    for id in $IDS; do report "$id" FAIL "$1"; done
    echo "p1: runtime $(( $(date +%s) - T0 ))s" >&2
    exit 0
}

# --- prerequisites ------------------------------------------------------------
missing=""
for _t in python3 git openssl; do
    command -v "$_t" >/dev/null 2>&1 || missing="$missing $_t"
done
if command -v python3 >/dev/null 2>&1 && ! python3 -c 'import cryptography' 2>/dev/null; then
    missing="$missing python3-cryptography"
fi
[ -x "$LOKI" ] || missing="$missing bin/loki"
[ -f "$GEN" ] || missing="$missing proof-generator.py"
[ -z "$missing" ] || fail_all "prerequisite missing:$missing"
HAVE_BUN=0
command -v bun >/dev/null 2>&1 && HAVE_BUN=1

_w="$(mktemp -d "${TMPDIR:-/tmp}/moat-p1.XXXXXX")" || fail_all "could not create a temp dir"
trap 'rm -rf "$_w"' EXIT
W="$(cd "$_w" && pwd -P)" || fail_all "could not resolve the temp dir"
mkdir -p "$W/keys" "$W/out" "$W/home" "$W/tmp"

# --- fixture: keys (OUTSIDE the repo: untracked files count in the tree digest)
for _k in victim attacker; do
    openssl genpkey -algorithm ed25519 -out "$W/keys/$_k.pem" 2>/dev/null \
        || fail_all "fixture setup failed: openssl could not generate ed25519 keys"
done

python3 - "$ROOT" "$W/keys" <<'PY' || fail_all "fixture setup failed: could not build JWKS files"
import json, sys
root, k = sys.argv[1], sys.argv[2]
sys.path.insert(0, root + "/autonomy")
import receipt_jwt as rj
from cryptography.hazmat.primitives import serialization

def load(name):
    return serialization.load_pem_private_key(open(k + "/" + name, "rb").read(), password=None)

victim, attacker = load("victim.pem"), load("attacker.pem")
vkid = rj.compute_kid(victim.public_key())
open(k + "/victim.kid", "w").write(vkid)
json.dump(rj.build_jwks(private_key=victim), open(k + "/jwks.json", "w"))
json.dump(rj.build_jwks(private_key=attacker), open(k + "/attacker-jwks.json", "w"))
# The victim's kid over the attacker's key bytes: key selection by kid succeeds,
# so only the signature check itself can refuse it.
swap = rj.build_jwks(private_key=attacker)
swap["keys"][0]["kid"] = vkid
json.dump(swap, open(k + "/kidswap-jwks.json", "w"))
PY

# --- fixture: a git repo with a real diff, sealed by the real generator -------
R="$W/repo"
mkdir -p "$R"
g() { git -C "$R" -c user.email=moat@example.invalid -c user.name=moat \
        -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
{
    g init -q \
    && printf 'one\n' >"$R/a.txt" && g add a.txt && g commit -qm base \
    && BASE="$(g rev-parse HEAD)" \
    && printf 'two\n' >>"$R/a.txt" && printf 'new\n' >"$R/c.txt" \
    && g add a.txt c.txt && g commit -qm change \
    && mkdir -p "$R/.loki"
} >"$W/out/fixture.log" 2>&1 || fail_all "fixture setup failed: git repo: $(tail -3 "$W/out/fixture.log")"

(cd "$R" && env -u LOKI_RECEIPT_SIGNING_KEY _LOKI_RUN_START_SHA="$BASE" \
    LOKI_RECEIPT_SIGNING_KEY_FILE="$W/keys/victim.pem" \
    python3 "$GEN" --loki-dir "$R/.loki" --out-dir "$R/.loki/proofs/p1" --run-id p1 --quiet) \
    >"$W/out/gen.log" 2>&1
PJ="$R/.loki/proofs/p1/proof.json"
[ -f "$PJ" ] || fail_all "fixture setup failed: generator wrote no proof.json"
# Control for the presence probe: the same generator with no key configured.
(cd "$R" && env -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_RECEIPT_SIGNING_KEY_FILE \
    _LOKI_RUN_START_SHA="$BASE" \
    python3 "$GEN" --loki-dir "$R/.loki" --out-dir "$W/control/p0" --run-id p0 --quiet) \
    >"$W/out/gen-control.log" 2>&1

# --- egress block ---------------------------------------------------------------
# Every verify below runs as: "${OFFLINE[@]}" VAR=... bin/loki proof verify ...
# OFFLINE = [egress prefix] env -i <explicit environment>.
EGRESS=()
PROXY=()
EXTRA=()
[ -n "${PYTHONPATH:-}" ] && EXTRA+=("PYTHONPATH=$PYTHONPATH")
[ -n "${LOKI_TS_ENTRY:-}" ] && EXTRA+=("LOKI_TS_ENTRY=$LOKI_TS_ENTRY")
_pyub="$(python3 -m site --user-base 2>/dev/null || true)"
[ -n "$_pyub" ] && EXTRA+=("PYTHONUSERBASE=$_pyub")

build_offline() {
    OFFLINE=(${EGRESS[@]+"${EGRESS[@]}"} env -i "PATH=$PATH" "HOME=$W/home" "TMPDIR=$W/tmp"
        LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true
        LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false
        ${PROXY[@]+"${PROXY[@]}"} ${EXTRA[@]+"${EXTRA[@]}"})
}

# Positive control for the block itself: a live loopback listener must be
# reachable WITHOUT the prefix and unreachable WITH it. Reachability is read on
# the listener side (a queued connection), so a probe that errors for some
# unrelated reason cannot pass as "blocked" unless the control also connected.
egress_probe() {
    python3 - "$1" "${OFFLINE[@]}" <<'PY'
import socket, subprocess, sys
kind, prefix = sys.argv[1], sys.argv[2:]
srv = socket.socket()
srv.bind(("127.0.0.1", 0))
srv.listen(8)
port = srv.getsockname()[1]
if kind == "socket":
    probe = ("import socket\ntry:\n    socket.create_connection(('127.0.0.1', %d), timeout=3)\n"
             "except OSError:\n    pass\n" % port)
else:
    probe = ("import urllib.request\ntry:\n    urllib.request.urlopen('http://127.0.0.1:%d/', timeout=1)\n"
             "except Exception:\n    pass\n" % port)

def reached(cmd):
    try:
        subprocess.run(cmd + [sys.executable, "-c", probe], capture_output=True, timeout=30)
    except Exception:
        pass
    srv.settimeout(0.5)
    try:
        c, _ = srv.accept()
        c.close()
        return True
    except OSError:
        return False

control = reached([])
blocked = not reached(prefix)
print("egress probe (%s): control reached=%s, blocked under prefix=%s" % (kind, control, blocked),
      file=sys.stderr)
sys.exit(0 if control and blocked else 1)
PY
}

EGRESS_OK=0
EGRESS_MECH="none"
if [ -z "${P1_FORCE_EGRESS_FALLBACK:-}" ]; then
    if command -v sandbox-exec >/dev/null 2>&1; then
        EGRESS=(sandbox-exec -p '(version 1)(allow default)(deny network*)')
        build_offline
        egress_probe socket && { EGRESS_OK=1; EGRESS_MECH="sandbox-exec deny network*"; }
    fi
    if [ "$EGRESS_OK" -eq 0 ] && command -v unshare >/dev/null 2>&1; then
        EGRESS=(unshare -rn)
        build_offline
        egress_probe socket && { EGRESS_OK=1; EGRESS_MECH="unshare -rn"; }
        if [ "$EGRESS_OK" -eq 0 ] && command -v setpriv >/dev/null 2>&1 \
            && sudo -n true >/dev/null 2>&1; then
            EGRESS=(sudo -n unshare -n -- setpriv "--reuid=$(id -u)" "--regid=$(id -g)" --clear-groups --)
            build_offline
            egress_probe socket && { EGRESS_OK=1; EGRESS_MECH="sudo unshare -n, setpriv back to uid $(id -u)"; }
        fi
    fi
fi
if [ "$EGRESS_OK" -eq 0 ]; then
    # Not a kernel block: only proxy-honouring clients are redirected. Stated
    # in the case description so it is never mistaken for a real block.
    EGRESS=()
    PROXY=(HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9
        http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 all_proxy=http://127.0.0.1:9)
    build_offline
    egress_probe http && { EGRESS_OK=1; EGRESS_MECH="FALLBACK env -i + proxy 127.0.0.1:9 (not a kernel block)"; }
fi
echo "p1: egress mechanism: $EGRESS_MECH (active=$EGRESS_OK)" >&2

# --- verify runner ----------------------------------------------------------------
# verify <route> <tag> <repo> <proof-id> [args...]; sets RC; output in $W/out/<tag>.{out,err}
verify() {
    local route="$1" tag="$2" repo="$3" id="$4"
    shift 4
    local legacy=()
    [ "$route" = bash ] && legacy=(LOKI_LEGACY_BASH=1)
    "${OFFLINE[@]}" "LOKI_DIR=$repo/.loki" "TARGET_DIR=$repo" ${legacy[@]+"${legacy[@]}"} \
        "$LOKI" proof verify "$id" "$@" >"$W/out/$tag.out" 2>"$W/out/$tag.err"
    RC=$?
}
verified() { grep -q "attestation: VERIFIED" "$W/out/$1.err"; }
route_ok() { [ "$1" = bash ] || [ "$HAVE_BUN" -eq 1 ]; }

# Positive control shared by every case: the genuine proof, genuine key set.
GOOD_BASH=0
GOOD_BUN=0
verify bash good-bash "$R" p1 --jwks "$W/keys/jwks.json"
GOOD_RC_BASH=$RC
[ "$RC" -eq 0 ] && verified good-bash && GOOD_BASH=1
GOOD_RC_BUN=-
if [ "$HAVE_BUN" -eq 1 ]; then
    verify bun good-bun "$R" p1 --jwks "$W/keys/jwks.json"
    GOOD_RC_BUN=$RC
    [ "$RC" -eq 0 ] && verified good-bun && GOOD_BUN=1
fi
good() { if [ "$1" = bash ]; then [ "$GOOD_BASH" -eq 1 ]; else [ "$GOOD_BUN" -eq 1 ]; fi; }

# --- P1.signed-proof-carries-attestation --------------------------------------------
_att="$(python3 - "$PJ" "$W/control/p0/proof.json" "$(cat "$W/keys/victim.kid")" <<'PY' 2>&1
import json, sys
signed, control, kid = sys.argv[1], sys.argv[2], sys.argv[3]
v = json.load(open(signed)).get("verification") or {}
try:
    cv = json.load(open(control)).get("verification") or {}
except Exception as e:
    print("control proof unreadable: %s" % e); sys.exit(1)
if not v.get("attestation") or v.get("attestation").count(".") != 2:
    print("signed proof has no JWT at verification.attestation"); sys.exit(1)
if v.get("attestation_kid") != kid:
    print("attestation_kid %r is not the signing key's kid %r" % (v.get("attestation_kid"), kid)); sys.exit(1)
if "attestation" in cv:
    print("control: an unkeyed generator run also carries an attestation, so the probe is vacuous"); sys.exit(1)
PY
)"
if [ -z "$_att" ]; then
    report P1.signed-proof-carries-attestation PASS "generator with a signing key writes verification.attestation (kid matches the key); unkeyed control writes none"
else
    report P1.signed-proof-carries-attestation FAIL "generator did not attest the proof: $_att"
fi

# --- P1.offline-verify-bash / P1.offline-verify-bun ---------------------------------
for route in bash bun; do
    id="P1.offline-verify-$route"
    desc="signed proof verifies with only jwks.json, exit 0 + attestation: VERIFIED, egress: $EGRESS_MECH"
    if ! route_ok "$route"; then
        report "$id" FAIL "$desc - prerequisite missing: bun"
    elif [ "$EGRESS_OK" -ne 1 ]; then
        report "$id" FAIL "$desc - no egress block could be established and proven"
    elif ! good "$route"; then
        _rc=$GOOD_RC_BASH
        [ "$route" = bun ] && _rc=$GOOD_RC_BUN
        report "$id" FAIL "$desc - verify exit $_rc, stderr: $(tr '\n' ' ' <"$W/out/good-$route.err" | cut -c1-160)"
    else
        report "$id" PASS "$desc"
    fi
done

# Each negative case: the genuine proof must verify on the route (control), the
# forged input must exit non-zero AND must not print "attestation: VERIFIED".
# refuse <route> <tag> <repo> <proof-id> [args...] -> appends to $why on failure
why=""
refuse() {
    local route="$1" tag="$2"
    verify "$@"
    if [ "$RC" -eq 0 ]; then
        why="$why $route/$tag: exit 0;"
    elif verified "$tag"; then
        why="$why $route/$tag: printed attestation: VERIFIED;"
    fi
}
precheck() {
    if ! route_ok "$1"; then why="$why $1: prerequisite missing: bun;"; return 1; fi
    if ! good "$1"; then why="$why $1: positive control failed (genuine proof did not verify);"; return 1; fi
    return 0
}
finish() {
    if [ -z "$why" ]; then report "$1" PASS "$2"; else report "$1" FAIL "$2 -$why"; fi
    why=""
}

# --- P1.different-tree-fails --------------------------------------------------------
# The proof bytes are untouched here, so the attestation itself still verifies
# (correctly: the signature is genuine). The tree check must still fail the run,
# with the drift exit code 1 rather than the could-not-check code 2.
cp -R "$R" "$W/drift" && printf 'edited after sealing\n' >>"$W/drift/a.txt"
for route in bash bun; do
    precheck "$route" || continue
    verify "$route" "drift-$route" "$W/drift" p1 --jwks "$W/keys/jwks.json"
    [ "$RC" -eq 1 ] || why="$why $route: exit $RC, expected 1 (tree drift);"
done
finish P1.different-tree-fails "a tracked file edited after sealing makes verify exit 1 (bash + bun)"

# --- P1.modified-field-fails ----------------------------------------------------------
# Two forgeries of facts.git.head_sha: one leaves verification.hash stale (the
# integrity hash alone catches it), one recomputes the hash (only the signature
# can catch it, so that one must report attestation: FAILED).
_mut="$(python3 - "$PJ" "$R/.loki/proofs" <<'PY' 2>&1
import hashlib, json, os, sys
src, proofs = sys.argv[1], sys.argv[2]
p = json.load(open(src))
canon = lambda d: hashlib.sha256(json.dumps(d, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
body = dict(p); v = dict(body.pop("verification"))
if canon(body) != v["hash"]:
    print("rehash technique does not reproduce the genuine hash, so the rehash forgery would be vacuous"); sys.exit(1)
body["facts"]["git"]["head_sha"] = "f" * 40
for name, hv in (("p1stale", v["hash"]), ("p1rehash", canon(body))):
    os.makedirs(os.path.join(proofs, name), exist_ok=True)
    out = dict(body); out["verification"] = dict(v, hash=hv)
    json.dump(out, open(os.path.join(proofs, name, "proof.json"), "w"), indent=2)
    json.load(open(os.path.join(proofs, name, "proof.json")))
PY
)"
if [ -n "$_mut" ]; then
    why=" fixture: $_mut;"
else
    for route in bash bun; do
        precheck "$route" || continue
        refuse "$route" "stale-$route" "$R" p1stale --jwks "$W/keys/jwks.json"
        refuse "$route" "rehash-$route" "$R" p1rehash --jwks "$W/keys/jwks.json"
        grep -q "attestation: FAILED" "$W/out/rehash-$route.err" \
            || why="$why $route/rehash: signature did not report attestation: FAILED;"
    done
fi
finish P1.modified-field-fails "facts.git.head_sha forged (stale hash, and recomputed hash) makes verify exit non-zero (bash + bun)"

# --- P1.wrong-key-fails -------------------------------------------------------------
for route in bash bun; do
    precheck "$route" || continue
    refuse "$route" "kidswap-$route" "$R" p1 --jwks "$W/keys/kidswap-jwks.json"
    refuse "$route" "attacker-$route" "$R" p1 --jwks "$W/keys/attacker-jwks.json"
done
finish P1.wrong-key-fails "victim kid over different key bytes, and an attacker key set, both exit non-zero without VERIFIED (bash + bun)"

# --- P1.stripped-signature-fails --------------------------------------------------------
_strip="$(python3 - "$PJ" "$R/.loki/proofs/p1strip" <<'PY' 2>&1
import json, os, sys
p = json.load(open(sys.argv[1]))
del p["verification"]["attestation"]
os.makedirs(sys.argv[2], exist_ok=True)
json.dump(p, open(os.path.join(sys.argv[2], "proof.json"), "w"), indent=2)
PY
)"
if [ -n "$_strip" ]; then
    why=" fixture: $_strip;"
else
    for route in bash bun; do
        precheck "$route" || continue
        # Control: the integrity hash excludes verification.*, so the stripped
        # proof alone verifies clean; only the --jwks rule can refuse it.
        verify "$route" "strip-nojwks-$route" "$R" p1strip
        [ "$RC" -eq 0 ] || why="$why $route: control (no --jwks) exited $RC, expected 0;"
        refuse "$route" "strip-$route" "$R" p1strip --jwks "$W/keys/jwks.json"
    done
fi
finish P1.stripped-signature-fails "verification.attestation deleted, verify --jwks exits non-zero (bash + bun)"

echo "p1: NOT PROVEN: verification.* fields other than the attestation (scope, algo, attestation_kid, gpg_signature) are outside the signed digest; editing them is not detected by the signature." >&2
echo "p1: runtime $(( $(date +%s) - T0 ))s" >&2
exit 0
