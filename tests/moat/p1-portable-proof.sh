#!/usr/bin/env bash
# Moat property P1 - Portable proof.
#
# Claim: a signed proof verifies OFFLINE with only a public key, and
# verification FAILS on a different tree, a modified field, a wrong key, or a
# stripped signature.
#
# Contract (tests/moat): exactly one "CASE <ID> PASS|FAIL <desc>" stdout line
# per case, exit 0 whenever the script ran to completion. A missing
# prerequisite is a FAIL with "prerequisite missing: X", never a skip. When a
# real kernel or sandbox egress block is available (proven by a positive
# control), every verify runs under it, so an accidental network dependency
# shows up here as a failure rather than as a pass on a connected laptop. With
# none available the offline cases FAIL with "prerequisite missing: egress
# sandbox" and the refusal cases still run, unblocked. A proxy environment is
# set as defense in depth but can never produce a PASS by itself.
# P1_FORCE_EGRESS_FALLBACK=1 skips the mechanisms, so it can only force that
# FAIL path (for manual testing).
set -uo pipefail

T0=$(date +%s)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOKI="$ROOT/bin/loki"
GEN="$ROOT/autonomy/lib/proof-generator.py"

export LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 \
    CI=true LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false

IDS="P1.signed-proof-carries-attestation P1.offline-verify-bash P1.offline-verify-bun P1.different-tree-fails P1.modified-field-fails P1.wrong-key-fails P1.stripped-signature-fails P1.empty-jwks-value-fails P1.verification-metadata-signed"

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
open(k + "/attacker.kid", "w").write(rj.compute_kid(attacker.public_key()))
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
# Defense in depth only: proxy-honouring clients are pointed at a dead port.
# This is not a block, so it never counts toward EGRESS_OK.
PROXY=(HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9
    http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 all_proxy=http://127.0.0.1:9)
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
# the listener side (a queued connection). The probe prints a marker and must
# exit 0, so a prefix that could not launch it (or that ignores its arguments)
# is "not measured", never "blocked".
egress_probe() {
    python3 - "${OFFLINE[@]}" <<'PY'
import socket, subprocess, sys
prefix = sys.argv[1:]
MARK = "P1-EGRESS-PROBE-RAN"
srv = socket.socket()
srv.bind(("127.0.0.1", 0))
srv.listen(8)
port = srv.getsockname()[1]
probe = ("import socket\ntry:\n    socket.create_connection(('127.0.0.1', %d), timeout=3)\n"
         "except OSError:\n    pass\nprint(%r)\n" % (port, MARK))

def reached(cmd):
    # True / False when the probe ran, None when it did not run at all.
    try:
        r = subprocess.run(cmd + [sys.executable, "-c", probe], capture_output=True, timeout=30)
    except Exception:
        return None
    if r.returncode != 0 or MARK not in r.stdout.decode("utf-8", "replace"):
        return None
    srv.settimeout(0.5)
    try:
        c, _ = srv.accept()
        c.close()
        return True
    except OSError:
        return False

control = reached([])
under = reached(prefix)
print("egress probe: control reached=%s, under prefix reached=%s (None = probe did not run)"
      % (control, under), file=sys.stderr)
sys.exit(0 if control is True and under is False else 1)
PY
}

# try_egress <label> <prefix...>: the mechanism must launch "true" (exit 0,
# mirroring detect_egress_block in p5-sovereignty.sh) before its block is
# probed; a mechanism that cannot even start is never trusted.
EGRESS_OK=0
EGRESS_MECH="none"
try_egress() {
    local label="$1"
    shift
    EGRESS=("$@")
    if "${EGRESS[@]}" true >/dev/null 2>&1; then
        build_offline
        if egress_probe; then
            EGRESS_OK=1
            EGRESS_MECH="$label"
            return 0
        fi
    fi
    echo "p1: egress mechanism not usable here: $label" >&2
    EGRESS=()
    return 1
}
if [ -n "${P1_FORCE_EGRESS_FALLBACK:-}" ]; then
    echo "p1: P1_FORCE_EGRESS_FALLBACK set: no egress mechanism tried" >&2
else
    if command -v sandbox-exec >/dev/null 2>&1; then
        try_egress "sandbox-exec deny network*" sandbox-exec -p '(version 1)(allow default)(deny network*)'
    fi
    if [ "$EGRESS_OK" -eq 0 ] && command -v unshare >/dev/null 2>&1; then
        try_egress "unshare -rn" unshare -rn \
            || { command -v setpriv >/dev/null 2>&1 \
                && try_egress "sudo unshare -n, setpriv back to uid $(id -u)" \
                    sudo -n unshare -n -- setpriv "--reuid=$(id -u)" "--regid=$(id -g)" --clear-groups --; }
    fi
fi
# With no proven block, OFFLINE runs without a prefix: the negative cases are
# still measured, and the offline cases FAIL on the missing prerequisite.
[ "$EGRESS_OK" -eq 1 ] || EGRESS=()
build_offline
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
print("ATTESTATION_PRESENT")
PY
)"
# An explicit sentinel, not empty output: a killed or crashed checker must
# never read as a pass.
if [ "$_att" = "ATTESTATION_PRESENT" ]; then
    report P1.signed-proof-carries-attestation PASS "generator with a signing key writes verification.attestation (kid matches the key); unkeyed control writes none"
else
    report P1.signed-proof-carries-attestation FAIL "generator did not attest the proof: $_att"
fi

# --- P1.offline-verify-bash / P1.offline-verify-bun ---------------------------------
# There is ONE verifier. The "bun" leg runs the default bin/loki entry point,
# which hands any flagged verify (every --jwks call here) to the bash verifier;
# it proves the delegation keeps the verdict, not that a second verifier agrees.
ROUTES="bash, and the bun entry point delegating to the bash verifier"
for route in bash bun; do
    id="P1.offline-verify-$route"
    desc="signed proof verifies with only jwks.json, exit 0 + attestation: VERIFIED, egress: $EGRESS_MECH"
    [ "$route" = bun ] && desc="$desc (bun entry point delegates --jwks to the bash verifier)"
    if ! route_ok "$route"; then
        report "$id" FAIL "$desc - prerequisite missing: bun"
    elif [ "$EGRESS_OK" -ne 1 ]; then
        report "$id" FAIL "$desc - prerequisite missing: egress sandbox (no sandbox-exec, unshare -rn, or sudo -n unshare -n with setpriv proven on $(uname -s))"
    elif ! good "$route"; then
        _rc=$GOOD_RC_BASH
        [ "$route" = bun ] && _rc=$GOOD_RC_BUN
        report "$id" FAIL "$desc - verify exit $_rc, stderr: $(tr '\n' ' ' <"$W/out/good-$route.err" | cut -c1-160)"
    else
        report "$id" PASS "$desc"
    fi
done

# Each negative case: the genuine proof must verify on the route (control), the
# forged input must exit with the EXACT expected code AND must not print
# "attestation: VERIFIED" (refuse_exact, below).
why=""
# refuse_exact <rc> <stderr-text|""> <route> <tag> <repo> <proof-id> [args...]: the EXACT
# exit code, so a FAILED/ABSENT (1) softened into NOT CHECKED (2), or a crash,
# no longer passes as "non-zero"; the verdict text when given; and never
# "attestation: VERIFIED".
refuse_exact() {
    local want="$1" text="$2"
    shift 2
    local route="$1" tag="$2"
    verify "$@"
    if [ "$RC" -ne "$want" ]; then
        why="$why $route/$tag: exit $RC, expected $want;"
    elif [ -n "$text" ] && ! grep -qF -- "$text" "$W/out/$tag.err"; then
        why="$why $route/$tag: stderr lacks '$text';"
    fi
    if verified "$tag"; then why="$why $route/$tag: printed attestation: VERIFIED;"; fi
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
finish P1.different-tree-fails "a tracked file edited after sealing makes verify exit 1 ($ROUTES)"

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
        refuse_exact 1 "" "$route" "stale-$route" "$R" p1stale --jwks "$W/keys/jwks.json"
        refuse_exact 1 "" "$route" "rehash-$route" "$R" p1rehash --jwks "$W/keys/jwks.json"
        grep -q "attestation: FAILED" "$W/out/rehash-$route.err" \
            || why="$why $route/rehash: signature did not report attestation: FAILED;"
    done
fi
finish P1.modified-field-fails "facts.git.head_sha forged (stale hash, and recomputed hash) makes verify exit 1 ($ROUTES)"

# --- P1.wrong-key-fails -------------------------------------------------------------
for route in bash bun; do
    precheck "$route" || continue
    refuse_exact 1 "attestation: FAILED" "$route" "kidswap-$route" "$R" p1 --jwks "$W/keys/kidswap-jwks.json"
    refuse_exact 1 "attestation: FAILED" "$route" "attacker-$route" "$R" p1 --jwks "$W/keys/attacker-jwks.json"
done
finish P1.wrong-key-fails "victim kid over different key bytes, and an attacker key set, both exit 1 with attestation: FAILED, never VERIFIED ($ROUTES)"

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
        refuse_exact 1 "attestation: ABSENT" "$route" "strip-$route" "$R" p1strip --jwks "$W/keys/jwks.json"
    done
fi
finish P1.stripped-signature-fails "verification.attestation deleted, verify --jwks exits 1 with attestation: ABSENT ($ROUTES)"

# --- P1.empty-jwks-value-fails -------------------------------------------------------
# An empty --jwks value ("--jwks ''", "--jwks=") used to skip the attestation
# check and exit 0 on an unsigned receipt, and a later empty --jwks cancelled an
# earlier real one. A mistyped flag ("--jwk f", "-jwks f") was ignored the same
# way. Each is a usage error, exit 64 exactly. The receipt is the generator's
# own unkeyed control run.
if ! { mkdir -p "$R/.loki/proofs/p0" && cp "$W/control/p0/proof.json" "$R/.loki/proofs/p0/proof.json"; } 2>/dev/null; then
    why=" fixture: no unsigned control proof (see gen-control.log);"
else
    for route in bash bun; do
        if ! route_ok "$route"; then why="$why $route: prerequisite missing: bun;"; continue; fi
        # Positive control: the unsigned receipt verifies clean with no --jwks,
        # so the 64 below comes from the flag rule, not a bad id or tree.
        verify "$route" "empty-ctl-$route" "$R" p0
        if [ "$RC" -ne 0 ]; then why="$why $route: control (no --jwks) exited $RC, expected 0;"; continue; fi
        refuse_exact 64 "empty value" "$route" "empty-sep-$route" "$R" p0 --jwks ''
        refuse_exact 64 "empty value" "$route" "empty-eq-$route" "$R" p0 --jwks=
        refuse_exact 64 "empty value" "$route" "empty-late-$route" "$R" p0 --jwks "$W/keys/jwks.json" --jwks ''
        refuse_exact 64 "Unknown option" "$route" "typo-jwk-$route" "$R" p0 --jwk "$W/keys/jwks.json"
        refuse_exact 64 "Unknown option" "$route" "typo-dash-$route" "$R" p0 -jwks "$W/keys/jwks.json"
    done
fi
finish P1.empty-jwks-value-fails "--jwks '', --jwks=, --jwks <real> --jwks '', and the mistyped --jwk <file> and -jwks <file> on an unsigned receipt each exit 64 (usage), never VERIFIED ($ROUTES)"

# --- P1.verification-metadata-signed ------------------------------------------------
# verification.* metadata beside the attestation must be covered by the
# signature: a forger who rewrites scope, algo or attestation_kid on a genuine
# signed proof must be refused. Each forged proof differs from the genuine one
# in exactly one field (checked below, so no edit is a no-op).
_meta="$(python3 - "$PJ" "$R/.loki/proofs" "$(cat "$W/keys/attacker.kid")" "$W/out/meta.list" <<'PY' 2>&1
import json, os, sys
src, proofs, attacker_kid, listing = sys.argv[1:5]
p = json.load(open(src))
v = p.get("verification") or {}
edits = [("scope", "integrity+provenance"), ("algo", "sha512"), ("attestation_kid", attacker_kid)]
if v.get("gpg_signature"):
    edits.append(("gpg_signature", v["gpg_signature"].replace("A", "B", 1)))
names = []
for field, val in edits:
    if field not in v or v[field] == val:
        print("genuine proof has no verification.%s to change" % field); sys.exit(1)
    q = json.loads(json.dumps(p))
    q["verification"][field] = val
    name = "p1meta-" + field.replace("_", "-")
    os.makedirs(os.path.join(proofs, name), exist_ok=True)
    out = os.path.join(proofs, name, "proof.json")
    json.dump(q, open(out, "w"), indent=2)
    r = json.load(open(out))
    diff = [k for k in set(r) | set(p) if r.get(k) != p.get(k)]
    vdiff = [k for k in set(r["verification"]) | set(v) if r["verification"].get(k) != v.get(k)]
    if diff != ["verification"] or vdiff != [field]:
        print("forged %s differs in %s / verification.%s, not exactly that field" % (name, diff, vdiff)); sys.exit(1)
    names.append(name)
open(listing, "w").write(" ".join(names))
PY
)"
_meta_desc="verification.scope, .algo and .attestation_kid each edited on a signed proof make verify --jwks exit 1 ($ROUTES)"
if [ -n "$_meta" ] || [ ! -s "$W/out/meta.list" ]; then
    why=" fixture: ${_meta:-no forged proofs written};"
else
    grep -q gpg "$W/out/meta.list" \
        || _meta_desc="$_meta_desc; gpg_signature absent from this fixture, not probed"
    for route in bash bun; do
        precheck "$route" || continue
        for _m in $(cat "$W/out/meta.list"); do
            # Exact 1: a future "no key for kid" NOT CHECKED (2) must not promote this case.
            refuse_exact 1 "" "$route" "${_m#p1}-$route" "$R" "$_m" --jwks "$W/keys/jwks.json"
        done
    done
fi
finish P1.verification-metadata-signed "$_meta_desc"

echo "p1: runtime $(( $(date +%s) - T0 ))s" >&2
exit 0
