#!/usr/bin/env bash
# Receipt verdicts on the shipped demo receipt, through the real CLI:
#   VERIFIED (rc 0), TAMPERED when one hash digit changes (rc 1), TAMPERED when
#   events.jsonl changes, UNSIGNED when the attestation is stripped, UNCHECKED when
#   the key is absent. Then the JWKS attestation module (autonomy/receipt_jwt.py):
#   sign then verify against the published key set, a changed receipt hash must
#   fail, and alg "none" must be refused (skipped, reported, if `cryptography`
#   is not installed).
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. autonomy/receipt_jwt.py: make verify_attestation return (True, claims)
#      before the signature check; the JWKS cases must fail.
#   2. loki-ts/dist/loki.js: replace every `verdict:"TAMPERED"` with
#      `verdict:"VERIFIED"` (a verifier that never says TAMPERED); the
#      flipped-digit and appended-event cases must fail.
#
# FR08 legs (proof passport, review queue, merge gate) and the defects planted to prove them:
#   P1 buildPassport (receipt_bundle.ts): drop the run-outcome check; the PARTIAL leg fails.
#   P2 buildPassport: drop the local-path guard; the leaked-HOME leg fails.
#   P3 passportsIn (receipt_surface.ts): change a marker so it no longer matches what the renderer emits; the round-trip leg fails.
#   P4 review_queue.ts judgePassport: drop the commit == headRefOid comparison; PR 2 turns READY.
#   P5 review_queue.ts assess: drop the tier != low reason; PR 3 turns READY.
#   P6 review_queue.ts judgePassport: trust the envelope's embedded key instead of --pubkey; PR 7 turns READY.
#   P7 review_queue.ts assess: pass process.env to classifyRisk; PR 3 is no longer high (the test exports LOKI_RISK_TIER=low).
#   P8 autonomy/loki _merge_pr_gated: replace the receipt head_sha filter with `true`; the stale-head leg merges.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need python3
cd "$ROOT" || exit 2

echo "TEST: receipt sign / verify round trip"

export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
FX="$ROOT/skills/fixtures/demo-receipt"
W="$T/r"
mkdir -p "$W"
cp "$FX/receipt.json" "$FX/events.jsonl" "$FX/pubkey.jwk" "$W/"

verdict() { # verdict <receipt> [extra args] -> prints "<rc> <verdict line>"
    local out rc
    out="$(bash "$ROOT/bin/loki" verify "$@" 2>&1)"; rc=$?
    printf '%s %s\n' "$rc" "$(printf '%s\n' "$out" | sed -n 's/^verdict: //p' | head -1)"
}

r="$(verdict --pubkey "$W/pubkey.jwk" "$W/receipt.json")"
[ "$r" = "0 VERIFIED" ] && ok "untouched receipt: VERIFIED rc 0" || bad "untouched receipt gave: $r"

r="$(verdict "$W/receipt.json")"
[ "$r" = "2 UNCHECKED" ] && ok "no key available: UNCHECKED rc 2 (never VERIFIED)" || bad "keyless verify gave: $r"

python3 -I - "$W" <<'PY'
import json, sys
w = sys.argv[1]
raw = open(w + "/receipt.json").read()
d = json.loads(raw)
h = d["diff_sha256"]
last = "0" if h[-1] != "0" else "1"
open(w + "/flipped.json", "w").write(raw.replace(h, h[:-1] + last, 1))
d["verification"] = {"jwt": None, "kid": None}
json.dump(d, open(w + "/unsigned.json", "w"), indent=2)
PY
cp "$W/events.jsonl" "$W/events.orig"

r="$(verdict --pubkey "$W/pubkey.jwk" "$W/flipped.json")"
[ "$r" = "1 TAMPERED" ] && ok "one changed hash digit: TAMPERED rc 1" || bad "flipped receipt gave: $r"

# unsigned and events edits are judged next to events.jsonl, so give each its own dir
mkdir -p "$W/u" "$W/e"
cp "$W/unsigned.json" "$W/u/receipt.json"; cp "$W/events.orig" "$W/u/events.jsonl"
r="$(verdict --pubkey "$W/pubkey.jwk" "$W/u/receipt.json")"
[ "$r" = "3 UNSIGNED" ] && ok "stripped attestation: UNSIGNED rc 3 (never VERIFIED)" || bad "unsigned receipt gave: $r"

cp "$W/receipt.json" "$W/e/receipt.json"
{ cat "$W/events.orig"; echo '{"v":1,"type":"forged"}'; } > "$W/e/events.jsonl"
r="$(verdict --pubkey "$W/pubkey.jwk" "$W/e/receipt.json")"
[ "$r" = "1 TAMPERED" ] && ok "appended event: TAMPERED rc 1" || bad "edited events gave: $r"

if python3 -c "import cryptography" 2>/dev/null; then
    out="$(python3 -I - "$ROOT/autonomy" <<'PY' 2>&1
import sys, json, base64
sys.path.insert(0, sys.argv[1])
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import receipt_jwt as rj

def emit(name, cond):
    print(("OK " if cond else "NO ") + name)

k = Ed25519PrivateKey.generate()
kid = rj.compute_kid(k.public_key())
jwks = rj.build_jwks(private_key=k)
tok = rj.sign_attestation(k, kid, job_id="j", run_id="r", receipt_hash="abc", submitter="a")
good, claims = rj.verify_attestation(tok, jwks)
emit("signed token verifies against published JWKS", good and claims.get("receipt_sha256") == "abc")

h, p, s = tok.split(".")
claims_d = json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
claims_d["receipt_sha256"] = "def"
p2 = base64.urlsafe_b64encode(json.dumps(claims_d).encode()).rstrip(b"=").decode()
bad_ok, _ = rj.verify_attestation(".".join([h, p2, s]), jwks)
emit("changed receipt hash does not verify", not bad_ok)

hn = base64.urlsafe_b64encode(json.dumps({"alg": "none", "kid": kid, "typ": "JWT"}).encode()).rstrip(b"=").decode()
none_ok, _ = rj.verify_attestation(hn + "." + p + ".", jwks)
emit("alg none is refused", not none_ok)
PY
)"
    for want in "signed token verifies against published JWKS" "changed receipt hash does not verify" "alg none is refused"; do
        case "$out" in *"OK $want"*) ok "jwks: $want" ;; *) bad "jwks: $want ($out)" ;; esac
    done
else
    echo "  SKIP: cryptography not installed, JWKS attestation not measured here"
fi

# ---- FR08: proof passport, review queue, merge gate ----
PP="$T/pp"
mkdir -p "$PP/bin" "$PP/gh" "$PP/out"
export RT_ROOT="$ROOT" PP
cat > "$PP/mk.ts" <<'TS'
// Re-signs a copy of the demo receipt under <out>/.loki/runs/e10-fr08-r1 with the key in LOKI_RECEIPT_SIGNING_KEY_FILE.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const root = process.env.RT_ROOT!, out = process.argv[2]!;
const v = await import(`${root}/loki-ts/src/engine10/verify_cmd.ts`), sg = await import(`${root}/loki-ts/src/util/receipt_signer.ts`);
const fx = `${root}/skills/fixtures/demo-receipt`;
mkdirSync(`${out}/.loki/runs/e10-fr08-r1`, { recursive: true });
const r = JSON.parse(readFileSync(`${fx}/receipt.json`, "utf8"));
r.run_id = "e10-fr08-r1"; delete r.log_seal; delete r.verification; delete r.receipt_sha256;
if (process.env.MK_VERDICT) r.verdict = process.env.MK_VERDICT;
if (process.env.MK_LEAK) r.evidence = [process.env.MK_LEAK];
r.receipt_sha256 = v.computeReceiptHash(r);
const s = sg.signReceipt("e10-fr08-r1", r.receipt_sha256); r.verification = { jwt: s.jwt, kid: s.kid };
writeFileSync(`${out}/.loki/runs/e10-fr08-r1/receipt.json`, JSON.stringify(r, null, 2));
copyFileSync(`${fx}/events.jsonl`, `${out}/.loki/runs/e10-fr08-r1/events.jsonl`);
TS
cat > "$PP/pp.ts" <<'TS'
// pp.ts <runDir> <outDir>: build a passport, render the receipt comment, parse it back, and write the two files an auditor would save.
import { writeFileSync } from "node:fs";
const root = process.env.RT_ROOT!, [runDir, outDir] = process.argv.slice(2) as [string, string];
const b = await import(`${root}/loki-ts/src/util/receipt_bundle.ts`), s = await import(`${root}/loki-ts/src/util/receipt_surface.ts`);
const p = await b.buildPassport(runDir);
if ("missing" in p) { console.log(`MISSING ${p.missing}`); process.exit(0); }
const comment = s.renderReceiptComment({ verdict: "VERIFIED", draft: false, draftReason: null, notProven: [], receiptSha256: null, runId: "e10-fr08-r1", passport: p });
writeFileSync(`${outDir}/comment.md`, comment);
const f = s.passportsIn(comment);
console.log(`OK n=${f.length} head=${p.head}`);
if (f.length === 1) { writeFileSync(`${outDir}/receipt.dsse.json`, f[0]!.envelope); writeFileSync(`${outDir}/pubkey.jwk`, f[0]!.jwk ?? ""); }
TS
cat > "$PP/keys.ts" <<'TS'
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { writeFileSync } from "node:fs";
const root = process.env.RT_ROOT!, pp = process.env.PP!;
const { publicJwk } = await import(`${root}/loki-ts/src/util/receipt_bundle.ts`);
for (const n of ["k", "k2"]) {
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(`${pp}/${n}.pem`, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
  writeFileSync(`${pp}/${n === "k" ? "pub" : "pub2"}.jwk`, `${publicJwk(createPublicKey(privateKey))}\n`);
}
TS
(cd "$ROOT/loki-ts" && bun "$PP/keys.ts")
mk() { # mk <outDir> <keyfile> [VAR=val...]
    local out="$1" key="$2"; shift 2
    (cd "$ROOT/loki-ts" && env LOKI_RECEIPT_SIGNING_KEY_FILE="$key" "$@" bun "$PP/mk.ts" "$out")
}
pp() { # pp <outDir> <keyfile> [VAR=val...] -> first output line of pp.ts
    local out="$1" key="$2"; shift 2
    (cd "$ROOT/loki-ts" && env LOKI_RECEIPT_SIGNING_KEY_FILE="$key" "$@" bun "$PP/pp.ts" "$out/.loki/runs/e10-fr08-r1" "$out" 2>&1 | head -1)
}
HEAD_SHA="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["head_sha"])' "$FX/receipt.json")"
mkdir -p "$PP/good" "$PP/bad" "$PP/leak" "$PP/off" "$PP/other"
mk "$PP/good" "$PP/k.pem"; mk "$PP/bad" "$PP/k.pem" MK_VERDICT=PARTIAL; mk "$PP/leak" "$PP/k.pem" "MK_LEAK=ran in $HOME/work"; mk "$PP/other" "$PP/k2.pem"

r="$(pp "$PP/good" "$PP/k.pem")"
case "$r" in "OK n=1 head=$HEAD_SHA") ok "passport: built for a VERIFIED run, one block parsed back out of the rendered comment" ;; *) bad "passport leg gave: $r" ;; esac
r="$(verdict --pubkey "$PP/good/pubkey.jwk" "$PP/good/receipt.dsse.json")"
[ "$r" = "0 VERIFIED" ] && ok "passport: the real CLI verifies the saved envelope offline with the saved key" || bad "passport verify gave: $r"
python3 -I - "$PP/good/receipt.dsse.json" "$PP/good/flip.dsse.json" <<'PY'
import json, sys
e = json.load(open(sys.argv[1]))
p = e["payload"]; i = len(p) // 2
e["payload"] = p[:i] + ("B" if p[i] != "B" else "C") + p[i + 1:]
json.dump(e, open(sys.argv[2], "w"))
PY
r="$(verdict --pubkey "$PP/good/pubkey.jwk" "$PP/good/flip.dsse.json")"
[ "$r" = "1 TAMPERED" ] && ok "passport: one changed payload character is TAMPERED" || bad "flipped passport gave: $r"
r="$(pp "$PP/bad" "$PP/k.pem")"
case "$r" in MISSING*"not issued"*) ok "passport: a PARTIAL run gets none ($r)" ;; *) bad "PARTIAL passport leg gave: $r" ;; esac
r="$(pp "$PP/leak" "$PP/k.pem")"
case "$r" in MISSING*"local paths"*) ok "passport: a receipt holding \$HOME is not published" ;; *) bad "leaked-path passport leg gave: $r" ;; esac
r="$(pp "$PP/good" "$PP/k.pem" LOKI_PR_PASSPORT=0)"
case "$r" in MISSING*"LOKI_PR_PASSPORT=0"*) ok "passport: LOKI_PR_PASSPORT=0 turns it off" ;; *) bad "disabled passport leg gave: $r" ;; esac

# Review queue: a fake gh serves 7 loki/* PRs and 1 other PR; the real CLI (from source) judges them.
cat > "$PP/bin/gh" <<'GH'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
G="$GH_FIX"; args=(); skip=0
for x in "$@"; do if [ "$skip" = 1 ]; then skip=0; continue; fi; if [ "$x" = --repo ]; then skip=1; continue; fi; args+=("$x"); done
set -- "${args[@]}"
case "$1 $2" in
    "pr list") cat "$G/list.json" ;;
    "pr checks") rc="$(cat "$G/checks-$3" 2>/dev/null || echo 0)"; [ "$rc" = 1 ] && echo "ci fail"; exit "$rc" ;;
    "pr diff") cat "$G/diff-$3.patch" ;;
    "pr view") case "$*" in *comments*) cat "$G/comments-$3.txt" 2>/dev/null ;; *headRefOid*) cat "$G/head-$3" ;; *isDraft*) echo false ;; esac ;;
    "pr edit"|"pr merge"|"label create") exit 0 ;;
    *) exit 1 ;;
esac
GH
chmod +x "$PP/bin/gh"
export GH_FIX="$PP/gh" GH_LOG="$PP/gh.log"
printf 'diff --git a/src/greet.js b/src/greet.js\nindex 111..222 100644\n--- a/src/greet.js\n+++ b/src/greet.js\n@@ -1,1 +1,2 @@\n old\n+new line\ndiff --git a/tests/greet.test.js b/tests/greet.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/tests/greet.test.js\n@@ -0,0 +1,2 @@\n+test\n+x\n' > "$PP/gh/diff-low.patch"
printf 'diff --git a/src/auth/login.ts b/src/auth/login.ts\nindex 111..222 100644\n--- a/src/auth/login.ts\n+++ b/src/auth/login.ts\n@@ -1,1 +1,2 @@\n old\n+new line\n' > "$PP/gh/diff-auth.patch"
OTHER_SHA="cccccccccccccccccccccccccccccccccccccccc"
python3 -I - "$PP/gh" "$HEAD_SHA" "$OTHER_SHA" <<'PY'
import json, shutil, sys
g, h, o = sys.argv[1:4]
def pr(n, oid=h, draft=False, head=None):
    return {"number": n, "title": f"PR {n}", "url": f"https://github.com/o/r/pull/{n}", "headRefName": head or f"loki/r{n}", "headRefOid": oid,
            "baseRefOid": "b" * 40, "isDraft": draft, "labels": [], "additions": 3, "deletions": 0, "changedFiles": 2}
rows = [pr(1), pr(2, oid=o), pr(3), pr(4), pr(5, draft=True), pr(6), pr(7), pr(8, head="feature/x")]
json.dump(rows, open(g + "/list.json", "w"))
for n in range(1, 9):
    shutil.copy(g + ("/diff-auth.patch" if n == 3 else "/diff-low.patch"), f"{g}/diff-{n}.patch")
open(g + "/checks-6", "w").write("1")
PY
cp "$PP/good/comment.md" "$PP/gh/comments-1.txt"
for n in 2 3 5 6; do cp "$PP/good/comment.md" "$PP/gh/comments-$n.txt"; done
printf '## Loki receipt\n- Passport: not issued: run outcome PARTIAL\n' > "$PP/gh/comments-4.txt"
pp "$PP/other" "$PP/k2.pem" >/dev/null; cp "$PP/other/comment.md" "$PP/gh/comments-7.txt"
queue() { (cd "$PP/good" && env PATH="$PP/bin:$PATH" LOKI_TS_ENTRY="$ROOT/loki-ts/src/cli.ts" LOKI_RECEIPT_SIGNING_KEY_FILE="$PP/k.pem" LOKI_RISK_TIER=low LOKI_RISK_OVERRIDE_REASON=x bash "$ROOT/bin/loki" review queue "$@"); }
: > "$GH_LOG"
queue --help >/dev/null 2>&1; [ ! -s "$GH_LOG" ] && ok "review queue: --help makes no gh call" || bad "review queue --help called gh: $(cat "$GH_LOG")"
qout="$(queue --repo o/r --pubkey "$PP/pub.jwk" --json --mark 2>"$PP/queue.err")"; qrc=$?
[ "$qrc" = 0 ] && ok "review queue: exit 0" || bad "review queue exit $qrc: $(cat "$PP/queue.err")"
facts="$(printf '%s' "$qout" | python3 -I -c '
import json, sys
d = json.load(sys.stdin); by = {e["number"]: e for e in d}
rk = lambda n: by[n]["rank"]
print("ready=" + ",".join(str(e["number"]) for e in d if e["ready"]))
print("count=%d absent8=%s" % (len(d), 8 not in by))
print("r2=" + ";".join(by[2]["reasons"])); print("r4=" + ";".join(by[4]["reasons"])); print("r5=" + ";".join(by[5]["reasons"])); print("r6=" + ";".join(by[6]["reasons"]))
print("tier3=%s first=%s" % (by[3]["risk"]["tier"], rk(3) < min(rk(n) for n in (2, 4, 5, 6, 7))))
print("p7=" + by[7]["passport"]["status"] + " p1=" + by[1]["passport"]["status"] + " p2=" + by[2]["passport"]["status"])
print("rank1=%d" % rk(1))
' 2>&1)"
has "review queue: only PR 1 is READY" "$facts" "ready=1
"
has "review queue: 7 Loki PRs listed, the non-Loki PR is absent" "$facts" "count=7 absent8=True"
has "review queue: a passport for another commit names both commits" "$facts" "r2=passport is for commit ${HEAD_SHA:0:7}, PR head is ccccccc"
has "review queue: no passport is said plainly" "$facts" "r4=no proof passport"
has "review queue: a draft is named" "$facts" "r5=PR is a draft"
has "review queue: red CI is named" "$facts" "r6=CI checks failing"
has "review queue: the auth PR is high risk and outranks the low-risk needs-review rows (LOKI_RISK_TIER=low in the env is ignored)" "$facts" "tier3=high first=True"
has "review queue: a passport from an untrusted key is unchecked, not verified" "$facts" "p7=unchecked"
has "review queue: a wrong-commit passport is stale" "$facts" "p2=stale"
has "review queue: READY ranks first" "$facts" "rank1=1"
nadd="$(grep -c -- "--add-label loki-ready" "$GH_LOG")"
grep -q "^pr edit 1 --repo o/r --add-label loki-ready$" "$GH_LOG" && [ "$nadd" = 1 ] && ok "review queue: --mark labels only the READY PR" || bad "review queue --mark log: $(grep -- 'label' "$GH_LOG")"
qtxt="$(queue --repo o/r --pubkey "$PP/pub.jwk" 2>/dev/null)"
has "review queue: READY text carries the 60-second summary and the next step" "$qtxt" "Next: gh pr review 1 --approve && loki merge pr 1 --require-verified"
has "review queue: READY text says what is not proven" "$qtxt" "Not proven: "
has "review queue: a needs-review row is one line" "$qtxt" "#3 NEEDS REVIEW high risk: "

# Merge gate: --require-verified accepts a Loki 10 run receipt whose head_sha is the PR head, judged by `loki verify`.
gate() { # gate <repoDir> <PR head sha> -> merge output
    printf '%s' "$2" > "$PP/gh/head-1"; : > "$GH_LOG"
    (cd "$1" && env PATH="$PP/bin:$PATH" LOKI_RECEIPT_SIGNING_KEY_FILE="$PP/k.pem" bash "$ROOT/bin/loki" merge pr 1 --require-verified 2>&1)
}
out="$(gate "$PP/good" "$HEAD_SHA")"
has "merge gate: a verified Loki 10 receipt for the PR head merges" "$out" "1: merged"
grep -q "^pr merge 1 --squash --match-head-commit $HEAD_SHA$" "$GH_LOG" && ok "merge gate: gh pr merge is pinned to the PR head" || bad "merge gate log: $(cat "$GH_LOG")"
out="$(gate "$PP/good" "$OTHER_SHA")"
has "merge gate: a PR head the receipt does not name is refused" "$out" "gate: head"
grep -q "^pr merge" "$GH_LOG" && bad "merge gate: merged a PR head with no receipt" || ok "merge gate: no gh pr merge for a stale head"
out="$(gate "$PP/bad" "$HEAD_SHA")"
has "merge gate: a PARTIAL run receipt is refused as a verdict" "$out" "gate: verdict"
grep -q "^pr merge" "$GH_LOG" && bad "merge gate: merged a PARTIAL run" || ok "merge gate: no gh pr merge for a PARTIAL run"

finish
