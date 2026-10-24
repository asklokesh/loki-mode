#!/usr/bin/env bash
#===============================================================================
# loki github publish: receipt-stamped GitHub export (TEN-DEPLOY-07)
#
# gh and git are PATH shims that record argv and never reach the network. The
# git shim passes through to real git so a local bare repo serves as origin.
# Receipts come from the REAL generator (same builder as
# tests/test-deploy-receipt-gate.sh) so hash/signature verdicts are genuine.
# Positive control: the VERIFIED case must reach success, so a publish that
# always refuses cannot pass.
#===============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOKI_BIN="$PROJECT_DIR/autonomy/loki"
GENERATOR="$PROJECT_DIR/autonomy/lib/proof-generator.py"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; [ -n "${2:-}" ] && echo "        $2"; }

command -v python3 >/dev/null 2>&1 || { echo "  SKIPPED: python3 missing"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "  SKIPPED: git missing"; exit 0; }
python3 -c "import cryptography" >/dev/null 2>&1 || { echo "  SKIPPED: cryptography missing (VERIFIED fixture unavailable)"; exit 0; }
REAL_GIT="$(command -v git)"

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-ghpub.XXXXXX")"
export HOME="$WORKROOT/home"; mkdir -p "$HOME"
unset LOKI_RECEIPT_SIGNING_KEY LOKI_RECEIPT_SIGNING_KEY_FILE
trap 'rm -rf "$WORKROOT" 2>/dev/null || true' EXIT INT TERM

FAKE_BIN="$WORKROOT/fake-bin"; mkdir -p "$FAKE_BIN"
GH_LOG="$WORKROOT/gh.log"; GIT_LOG="$WORKROOT/git.log"
# Stateful branch-protection stub. PROT_JSON_F is the server-side GET body of
# the full protection; the file is absent while the branch is unprotected.
# PUT reads its JSON body from stdin (--input -) and stores it GET-shaped.
PROT_STUB="$WORKROOT/prot-stub.sh"
PROT_JSON_F="$WORKROOT/prot-json"; PROT_LOG_F="$WORKROOT/prot.log"
cat > "$PROT_STUB" <<'EOF'
#!/usr/bin/env bash
exec python3 -c '
import json, os, sys
args = sys.argv[1:]
method, url = "GET", ""
for i, a in enumerate(args):
    if a == "-X":
        method = args[i + 1]
    if a.startswith("repos/"):
        url = a
state = os.environ["PROT_JSON_F"]
if method == "GET":
    if not os.path.exists(state):
        print(json.dumps({"message": "Branch not protected"}))
        sys.exit(1)
    sys.stdout.write(open(state).read())
elif method == "DELETE":
    if os.path.exists(state):
        os.remove(state)
elif method == "PUT":
    b = json.load(sys.stdin)
    def actors(d):
        if d is None:
            return None
        return {"users": [{"login": x} for x in d["users"]], "teams": [{"slug": x} for x in d["teams"]], "apps": [{"slug": x} for x in d["apps"]]}
    g = {}
    rs = b.get("required_status_checks")
    if rs:
        g["required_status_checks"] = {"strict": rs["strict"], "checks": rs["checks"], "contexts": [c["context"] for c in rs["checks"]]}
    g["enforce_admins"] = {"enabled": b["enforce_admins"]}
    rv = b.get("required_pull_request_reviews")
    if rv:
        for k in ("dismissal_restrictions", "bypass_pull_request_allowances"):
            if k in rv:
                rv[k] = actors(rv[k])
        g["required_pull_request_reviews"] = rv
    if b.get("restrictions"):
        g["restrictions"] = actors(b["restrictions"])
    for k in ("required_linear_history", "allow_force_pushes", "allow_deletions", "block_creations",
              "required_conversation_resolution", "lock_branch", "allow_fork_syncing"):
        g[k] = {"enabled": b[k]}
    open(state, "w").write(json.dumps(g, sort_keys=True) + "\n")
    print("{}")
' "$@"
EOF
chmod +x "$PROT_STUB"
export PROT_JSON_F PROT_LOG_F

cat > "$FAKE_BIN/gh" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$GH_LOG"
case "\$1" in
    auth) exit 0 ;;
    repo) echo "https://github.com/stub-owner/stub-repo"; exit 0 ;;
    api)
        case "\$*" in
            *branches/*protection*) exec "$PROT_STUB" "\$@" ;;
        esac
        echo "{}"; exit 0 ;;
esac
exit 0
EOF
cat > "$FAKE_BIN/git" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$GIT_LOG"
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$FAKE_BIN/gh" "$FAKE_BIN/git"
reset_logs() { : > "$GH_LOG"; : > "$GIT_LOG"; }

# Fixture: two commits, real receipt for HEAD. signed=0 drops the attestation.
make_fixture() {
    local signed="$2" d="$WORKROOT/$1" base
    mkdir -p "$d"
    "$REAL_GIT" -C "$d" init -q .
    "$REAL_GIT" -C "$d" config user.email t@example.com
    "$REAL_GIT" -C "$d" config user.name t
    "$REAL_GIT" -C "$d" config commit.gpgsign false
    echo "# fixture" > "$d/README.md"; printf '.loki/\n' > "$d/.gitignore"
    "$REAL_GIT" -C "$d" add README.md .gitignore; "$REAL_GIT" -C "$d" commit -qm baseline
    base="$("$REAL_GIT" -C "$d" rev-parse HEAD)"
    echo '{ "name": "f", "version": "1.0.0" }' > "$d/package.json"
    "$REAL_GIT" -C "$d" add package.json; "$REAL_GIT" -C "$d" commit -qm app
    ( cd "$d" && _LOKI_RUN_START_SHA="$base" python3 "$GENERATOR" --loki-dir "$d/.loki" >/dev/null 2>&1 )
    if [ "$signed" = "0" ]; then
        python3 - "$d" <<'PY'
import glob, json, sys
for f in glob.glob(sys.argv[1] + "/.loki/proofs/*/proof.json"):
    p = json.load(open(f))
    p.get("verification", {}).pop("attestation", None)
    p.get("verification", {}).pop("attestation_kid", None)
    json.dump(p, open(f, "w"), indent=2)
PY
    fi
}

run_publish() {
    local d="$1"; shift
    ( cd "$d" && PATH="$FAKE_BIN:$PATH" LOKI_DIR="$d/.loki" bash "$LOKI_BIN" github publish "$@" 2>&1 )
}

echo "TEST: loki github publish"
echo "========================="

echo "1. usage on bad input"
OUT="$(cd "$WORKROOT" && PATH="$FAKE_BIN:$PATH" bash "$LOKI_BIN" github publish --bogus 2>&1)"; RC=$?
if [ "$RC" -ne 0 ] && grep -qi "usage: loki github publish" <<<"$OUT"; then
    ok "unknown flag prints usage with non-zero exit"
else
    bad "unknown flag did not print usage" "rc=$RC"
fi

echo "2. VERIFIED, no origin: private repo create + success status"
make_fixture a 1; reset_logs
OUT="$(run_publish "$WORKROOT/a" myrepo)"; RC=$?
HEADSHA="$("$REAL_GIT" -C "$WORKROOT/a" rev-parse HEAD)"
if [ "$RC" -eq 0 ] && grep -q "repo create myrepo --private --source . --push" "$GH_LOG"; then
    ok "gh repo create ... --private --source . --push"
else
    bad "repo create argv wrong" "rc=$RC log=$(cat "$GH_LOG") out=$OUT"
fi
if grep -q "^api repos/.*/statuses/$HEADSHA" "$GH_LOG" && grep -q "state=success" "$GH_LOG" && grep -q "context=loki/receipt" "$GH_LOG"; then
    ok "status state=success context=loki/receipt on HEAD"
else
    bad "status call wrong" "log=$(cat "$GH_LOG")"
fi
if grep -q "https://github.com/stub-owner/stub-repo" <<<"$OUT"; then
    ok "prints repo URL from gh output"
else
    bad "repo URL missing" "$OUT"
fi
if grep -qE '(^| )add( |$)' "$GIT_LOG"; then bad "git add was invoked" "$(cat "$GIT_LOG")"; else ok "no git add"; fi

echo "3. --public is opt-in"
make_fixture b 1; reset_logs
run_publish "$WORKROOT/b" pubrepo --public >/dev/null
if grep -q "repo create pubrepo --public --source . --push" "$GH_LOG"; then ok "--public in argv"; else bad "--public missing" "$(cat "$GH_LOG")"; fi
if grep -q -- "--private" "$GH_LOG"; then bad "--private present alongside --public"; else ok "default stays private"; fi

echo "4. dirty tree refuses with zero gh calls"
make_fixture c 1; echo x >> "$WORKROOT/c/package.json"; reset_logs
OUT="$(run_publish "$WORKROOT/c" r)"; RC=$?
if [ "$RC" -ne 0 ] && [ ! -s "$GH_LOG" ] && grep -qi dirty <<<"$OUT"; then
    ok "dirty tree refused, gh never called"
else
    bad "dirty tree not refused cleanly" "rc=$RC gh=$(cat "$GH_LOG")"
fi

echo "5. UNSIGNED receipt gives state=failure"
make_fixture d 0; reset_logs
run_publish "$WORKROOT/d" r >/dev/null
if grep -q "state=failure" "$GH_LOG" && ! grep -q "state=success" "$GH_LOG"; then
    ok "unsigned receipt -> failure, never success"
else
    bad "unsigned receipt status wrong" "$(cat "$GH_LOG")"
fi

echo "6. with origin: pushes HEAD after anchor check"
make_fixture e 1
"$REAL_GIT" init -q --bare "$WORKROOT/e-origin.git"
"$REAL_GIT" -C "$WORKROOT/e" remote add origin "$WORKROOT/e-origin.git"
reset_logs
OUT="$(run_publish "$WORKROOT/e")"
if grep -q "push origin HEAD" "$GIT_LOG" && ! grep -q "repo create" "$GH_LOG"; then
    ok "git push origin HEAD, no repo create"
else
    bad "origin path wrong" "git=$(cat "$GIT_LOG") gh=$(cat "$GH_LOG") out=$OUT"
fi

echo "7. with origin, stale receipt: no push"
make_fixture f 1
"$REAL_GIT" init -q --bare "$WORKROOT/f-origin.git"
"$REAL_GIT" -C "$WORKROOT/f" remote add origin "$WORKROOT/f-origin.git"
echo more > "$WORKROOT/f/more.txt"
"$REAL_GIT" -C "$WORKROOT/f" add more.txt
"$REAL_GIT" -C "$WORKROOT/f" commit -qm later
reset_logs
run_publish "$WORKROOT/f" >/dev/null; RC=$?
if [ "$RC" -ne 0 ] && ! grep -q " push " "$GIT_LOG"; then
    ok "HEAD not the receipt anchor: refused, no push"
else
    bad "stale receipt was pushed" "rc=$RC git=$(cat "$GIT_LOG")"
fi

echo "8. loki github protect"
make_fixture g 1
"$REAL_GIT" -C "$WORKROOT/g" remote add origin https://github.com/stub-owner/stub-repo.git
GSTATE="$WORKROOT/g/.loki/state/github-protect.json"
run_protect() { ( cd "$WORKROOT/g" && PATH="$FAKE_BIN:$PATH" LOKI_DIR="$WORKROOT/g/.loki" bash "$LOKI_BIN" github protect "$@" 2>&1 ); }
canon() { python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True))'; }
prot_set() { printf '%s' "$1" | canon > "$PROT_JSON_F"; }
prot_edit() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); exec(sys.argv[2]); open(sys.argv[1],"w").write(json.dumps(d,sort_keys=True)+"\n")' "$PROT_JSON_F" "$1"; }
FULL='{"required_status_checks":{"strict":true,"checks":[{"context":"ci/build","app_id":15368},{"context":"ci/test"}],"contexts":["ci/build","ci/test"]},"enforce_admins":{"enabled":true},"required_pull_request_reviews":{"dismiss_stale_reviews":true,"require_code_owner_reviews":true,"required_approving_review_count":2,"require_last_push_approval":false,"dismissal_restrictions":{"users":[{"login":"u1"}],"teams":[{"slug":"t1"}],"apps":[]}},"restrictions":{"users":[{"login":"u2"}],"teams":[],"apps":[]},"required_linear_history":{"enabled":true},"allow_force_pushes":{"enabled":false},"allow_deletions":{"enabled":false},"block_creations":{"enabled":true},"required_conversation_resolution":{"enabled":true},"lock_branch":{"enabled":false},"allow_fork_syncing":{"enabled":true}}'
ORIG="$WORKROOT/orig.json"
prot_set "$FULL"; cp "$PROT_JSON_F" "$ORIG"; reset_logs; : > "$PROT_LOG_F"

OUT="$(run_protect --dry-run)"; RC=$?
if [ "$RC" -eq 0 ] && [ "$(grep -c 'api repos/.*protection' "$GH_LOG")" = "1" ] && cmp -s "$PROT_JSON_F" "$ORIG" && ! grep -qE -- '-X (PATCH|PUT|DELETE)' "$GH_LOG" && [ ! -e "$GSTATE" ]; then
    ok "dry-run: exactly 1 protection API call, nothing changed, no state"
else
    bad "dry-run wrong" "rc=$RC log=$(cat "$GH_LOG") out=$OUT"
fi

OUT="$(run_protect)"; RC=$?
# Everything except the receipt entry must equal the original protection.
STRIPPED="$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1])); r=d["required_status_checks"]
r["checks"]=[c for c in r["checks"] if c["context"]!="loki/receipt"]
r["contexts"]=[c for c in r["contexts"] if c!="loki/receipt"]
print(json.dumps(d,sort_keys=True))' "$PROT_JSON_F")"
if [ "$RC" -eq 0 ] && [ "$STRIPPED" = "$(cat "$ORIG")" ] && grep -q '"context": "loki/receipt"' "$PROT_JSON_F"; then
    ok "protect adds loki/receipt; reviews, admins, restrictions, linear history, check app_ids preserved"
else
    bad "protect altered other settings" "rc=$RC out=$OUT json=$(cat "$PROT_JSON_F")"
fi
if grep -q '"app_id": 15368' "$PROT_JSON_F"; then ok "check app_id preserved"; else bad "app_id lost" "$(cat "$PROT_JSON_F")"; fi
if grep -q -- "--input -" "$GH_LOG" && grep -q -- "-X PUT" "$GH_LOG"; then ok "update sent as JSON via --input -"; else bad "PUT not via --input -" "$(cat "$GH_LOG")"; fi

reset_logs; OUT="$(run_protect)"; RC=$?
if [ "$RC" -eq 0 ] && [ "$(grep -o 'loki/receipt' "$PROT_JSON_F" | wc -l | tr -d ' ')" = "2" ] && ! grep -qE -- '-X (PATCH|PUT|DELETE)' "$GH_LOG"; then
    ok "protect is idempotent (no duplicate, no write)"
else
    bad "second protect not idempotent" "log=$(cat "$GH_LOG")"
fi

# --off refuses when the checkout points at a different repo.
reset_logs
"$REAL_GIT" -C "$WORKROOT/g" remote set-url origin https://github.com/other-owner/other-repo.git
OUT="$(run_protect --off)"; RC=$?
if [ "$RC" -ne 0 ] && grep -qi "saved state is for" <<<"$OUT" && ! grep -qE -- '-X (PUT|DELETE)' "$GH_LOG" && [ -e "$GSTATE" ]; then
    ok "--off refuses on slug mismatch, keeps state"
else
    bad "slug mismatch not refused" "rc=$RC out=$OUT"
fi
"$REAL_GIT" -C "$WORKROOT/g" remote set-url origin https://github.com/stub-owner/stub-repo.git

# --off refuses when loki/receipt was removed or protection drifted.
cp "$PROT_JSON_F" "$WORKROOT/after-protect.json"
prot_edit 'r=d["required_status_checks"]; r["checks"]=[c for c in r["checks"] if c["context"]!="loki/receipt"]; r["contexts"]=[c for c in r["contexts"] if c!="loki/receipt"]'
reset_logs; OUT="$(run_protect --off)"; RC=$?
if [ "$RC" -ne 0 ] && grep -qi "no longer a required check" <<<"$OUT" && ! grep -qE -- '-X (PUT|DELETE)' "$GH_LOG"; then
    ok "--off refuses when loki/receipt was removed"
else
    bad "removed receipt not refused" "rc=$RC out=$OUT"
fi
cp "$WORKROOT/after-protect.json" "$PROT_JSON_F"
prot_edit 'd["enforce_admins"]["enabled"]=False'
reset_logs; OUT="$(run_protect --off)"; RC=$?
if [ "$RC" -ne 0 ] && grep -qi "differs from what protect wrote" <<<"$OUT" && ! grep -qE -- '-X (PUT|DELETE)' "$GH_LOG"; then
    ok "--off refuses when protection drifted"
else
    bad "drift not refused" "rc=$RC out=$OUT"
fi
cp "$WORKROOT/after-protect.json" "$PROT_JSON_F"

OUT="$(run_protect --off)"; RC=$?
if [ "$RC" -eq 0 ] && cmp -s "$PROT_JSON_F" "$ORIG" && [ ! -e "$GSTATE" ]; then
    ok "--off restores the full prior protection byte-identical"
else
    bad "--off did not restore" "rc=$RC out=$OUT json=$(cat "$PROT_JSON_F")"
fi
OUT="$(run_protect --off)"; RC=$?
if [ "$RC" -ne 0 ]; then ok "--off with nothing stored fails clearly"; else bad "--off without state succeeded" "$OUT"; fi

# Protection without required checks keeps reviews/admins and restores to the same.
prot_set '{"enforce_admins":{"enabled":true},"required_pull_request_reviews":{"dismiss_stale_reviews":false,"require_code_owner_reviews":false,"required_approving_review_count":1,"require_last_push_approval":false},"required_linear_history":{"enabled":true},"allow_force_pushes":{"enabled":false},"allow_deletions":{"enabled":false},"block_creations":{"enabled":false},"required_conversation_resolution":{"enabled":false},"lock_branch":{"enabled":false},"allow_fork_syncing":{"enabled":false}}'
cp "$PROT_JSON_F" "$ORIG"
run_protect >/dev/null; RC=$?
if [ "$RC" -eq 0 ] && grep -q '"loki/receipt"' "$PROT_JSON_F" && grep -q '"required_approving_review_count": 1' "$PROT_JSON_F" && grep -q '"required_linear_history": {"enabled": true}' "$PROT_JSON_F"; then
    ok "protection without checks: receipt added, reviews and linear history kept"
else
    bad "nochecks case wrong" "rc=$RC json=$(cat "$PROT_JSON_F")"
fi
run_protect --off >/dev/null
if cmp -s "$PROT_JSON_F" "$ORIG"; then ok "--off returns protection without checks to the exact original"; else bad "nochecks restore wrong" "$(cat "$PROT_JSON_F")"; fi

# Unprotected branch: minimal protection, then removed again.
rm -f "$PROT_JSON_F"
OUT="$(run_protect)"; RC=$?
if [ "$RC" -eq 0 ] && [ -e "$PROT_JSON_F" ] && grep -q '"loki/receipt"' "$PROT_JSON_F"; then
    ok "unprotected branch gets minimal protection with loki/receipt"
else
    bad "unprotected case wrong" "rc=$RC out=$OUT"
fi
run_protect --off >/dev/null
if [ ! -e "$PROT_JSON_F" ]; then ok "--off returns an unprotected branch to unprotected"; else bad "--off left protection" "$(cat "$PROT_JSON_F")"; fi

echo "9. protect: branch name is percent-encoded in API paths"
make_fixture h 1
"$REAL_GIT" -C "$WORKROOT/h" remote add origin https://github.com/stub-owner/stub-repo.git
"$REAL_GIT" -C "$WORKROOT/h" symbolic-ref refs/remotes/origin/HEAD "refs/remotes/origin/rel/1.0#x"
reset_logs
( cd "$WORKROOT/h" && PATH="$FAKE_BIN:$PATH" LOKI_DIR="$WORKROOT/h/.loki" bash "$LOKI_BIN" github protect --dry-run >/dev/null 2>&1 )
if grep -q 'branches/rel/1.0%23x/protection' "$GH_LOG"; then ok "# is encoded as %23"; else bad "branch not encoded" "$(cat "$GH_LOG")"; fi
rm -f "$PROT_JSON_F"

echo "10. protect with gh not logged in"
UNAUTH="$WORKROOT/unauth-bin"; mkdir -p "$UNAUTH"; cp "$FAKE_BIN/git" "$UNAUTH/git"
printf '#!/usr/bin/env bash\ncase "$1" in auth) exit 1 ;; esac\nexit 0\n' > "$UNAUTH/gh"; chmod +x "$UNAUTH/gh"
OUT="$(cd "$WORKROOT/g" && PATH="$UNAUTH:$PATH" bash "$LOKI_BIN" github protect 2>&1)"; RC=$?
if [ "$RC" -ne 0 ] && grep -qi "not authenticated" <<<"$OUT"; then ok "unauthenticated gh: clear error, non-zero"; else bad "unauth case wrong" "rc=$RC $OUT"; fi


echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
