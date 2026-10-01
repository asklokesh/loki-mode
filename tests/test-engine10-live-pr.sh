#!/usr/bin/env bash
# E-40 (docs/v10/ENGINE.md 23:00Z cut): live PR smoke on a sandbox GitHub repo.
# Runs one small real task through bin/loki with LOKI_ENGINE=v10 from the dist
# entry (LOKI_TS_ENTRY, default loki-ts/dist/loki.js) against
# LOKI_E10_LIVE_REPO=<owner>/<sandbox>, then checks the five Wall items.
# Without the variable it prints SKIP and exits 0; SKIP never counts as done.
# Uses the operator's real gh auth, so it never isolates HOME. Point it only at
# a throwaway sandbox repo: it opens a PR there and closes it at the end.
set -uo pipefail

REPO="${LOKI_E10_LIVE_REPO:-}"
if [ -z "$REPO" ]; then
    echo "SKIP: LOKI_E10_LIVE_REPO not set (live PR smoke needs an approved sandbox repo)"
    exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }
die() { echo "FAIL: $1"; echo "Results: $PASS passed, $((FAIL + 1)) failed"; exit 1; }

case "$REPO" in
    */*/*) die "LOKI_E10_LIVE_REPO must be <owner>/<repo>, got: $REPO" ;;
esac
printf '%s' "$REPO" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' \
    || die "LOKI_E10_LIVE_REPO must be <owner>/<repo>, got: $REPO"
command -v gh >/dev/null 2>&1 || die "gh not on PATH"
command -v python3 >/dev/null 2>&1 || die "python3 not on PATH"

: "${LOKI_TS_ENTRY:=$ROOT/loki-ts/dist/loki.js}"
[ -f "$LOKI_TS_ENTRY" ] || die "engine entry missing: $LOKI_TS_ENTRY (build dist first: cd loki-ts && bun run build)"
export LOKI_TS_ENTRY LOKI_ENGINE=v10 LOKI_NO_BROWSER=1
echo "entry: $LOKI_TS_ENTRY"

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-e10-live.XXXXXX")" || exit 1
trap 'rm -rf "$W"' EXIT
CLONE="$W/repo"
LIMIT="${LOKI_E10_LIVE_TIMEOUT:-1800}"
TO=""
command -v timeout >/dev/null 2>&1 && TO="timeout -k 10 $LIMIT"

gh repo clone "$REPO" "$CLONE" -- -q >"$W/clone.log" 2>&1 || die "gh repo clone $REPO failed: $(tr '\n' ' ' < "$W/clone.log")"
git -C "$CLONE" config user.name "loki-e10-live"
git -C "$CLONE" config user.email "loki-e10-live@example.invalid"

TASK="Append the line 'loki e10 live smoke $(date -u +%Y%m%dT%H%M%SZ)' to LOKI_SMOKE.md"
# The task goes first: bin/loki routes a leading flag to the legacy CLI.
loki() { (cd "$CLONE" && $TO "$ROOT/bin/loki" "$@"); }

loki "$TASK" >"$W/run1.out" 2>&1
echo "run rc=$? (last lines follow)"; tail -n 5 "$W/run1.out"

# ev <field>: reads .loki/engine.json and the run's events.jsonl.
ev() {
    python3 - "$CLONE" "$1" <<'PY'
import json, os, sys
repo, want = sys.argv[1], sys.argv[2]
try:
    marker = json.load(open(os.path.join(repo, ".loki", "engine.json")))
    evs = [json.loads(l) for l in open(os.path.join(repo, marker["events"])) if l.strip()]
except Exception as e:
    print(f"ERR {e}"); sys.exit(0)
prs = [e.get("data", {}) for e in evs if e.get("type") == "pr.opened"]
done = [e.get("data", {}) for e in evs if e.get("type") == "run.completed"]
last = prs[-1] if prs else {}
out = {
    "run": marker.get("run_id", ""),
    "verdict": (done[-1].get("verdict") if done else None) or "",
    "pr_count": str(len(prs)),
    "url": last.get("url") or "",
    "draft": json.dumps(last.get("draft")),
    "existing": json.dumps(last.get("existing")),
}
print(out.get(want, ""))
PY
}

RUN="$(ev run)"
case "$RUN" in ""|ERR*) die "no run id in .loki/engine.json ($RUN)" ;; esac
VERDICT="$(ev verdict)"
URL="$(ev url)"
DRAFT="$(ev draft)"
N1="$(ev pr_count)"
echo "run: $RUN verdict: ${VERDICT:-none}"
[ "$VERDICT" = "FAILED" ] && die "verdict FAILED: the supervisor opens no PR on FAILED"
[ "$N1" -ge 1 ] 2>/dev/null || die "no pr.opened event in the run"

# 1. PR URL.
if printf '%s' "$URL" | grep -Eq "^https://github\.com/$REPO/pull/[0-9]+$"; then
    ok "PR URL: $URL"
else
    die "PR URL not a $REPO pull URL: ${URL:-(empty)}"
fi

# 2. isDraft agrees with the event and with the verdict (non-VERIFIED is draft;
# VERIFIED may still be draft on a cap hit, so that direction is not asserted).
IS_DRAFT="$(gh pr view "$URL" --repo "$REPO" --json isDraft -q .isDraft 2>"$W/err")"
if [ "$IS_DRAFT" = "$DRAFT" ] && { [ "$VERDICT" = "VERIFIED" ] || [ "$IS_DRAFT" = "true" ]; }; then
    ok "isDraft: $IS_DRAFT (event draft $DRAFT, verdict $VERDICT)"
else
    bad "isDraft: gh=$IS_DRAFT event=$DRAFT verdict=$VERDICT err=$(tr '\n' ' ' < "$W/err")"
fi

# 3. loki/deep-verify status context on the PR head commit.
HEAD_SHA="$(gh pr view "$URL" --repo "$REPO" --json headRefOid -q .headRefOid 2>/dev/null)"
CTX="$(gh api "repos/$REPO/commits/$HEAD_SHA/statuses" --jq '.[].context' 2>/dev/null)"
if printf '%s\n' "$CTX" | grep -qx 'loki/deep-verify'; then
    ok "status context: loki/deep-verify on $HEAD_SHA"
else
    bad "status context loki/deep-verify missing on ${HEAD_SHA:-(no sha)} (got: $(printf '%s' "$CTX" | tr '\n' ','))"
fi

# 4. loki verify <run> exits 0 (D47: UNSIGNED exits 3 and is refused; a signed run exits 0,
#    or the unsigned run is accepted explicitly with --allow-unsigned and the line says so).
loki verify "$RUN" >"$W/verify.out" 2>&1
vrc=$?
VLINE="$(grep -E '^(verdict|attestation):' "$W/verify.out" | tr '\n' ' ')"
if [ "$vrc" -eq 0 ]; then
    ok "loki verify $RUN rc=0: $VLINE"
elif [ "$vrc" -eq 3 ] && grep -q '^verdict: UNSIGNED' "$W/verify.out" \
    && grep -q 'refusing (pass --allow-unsigned to accept)' "$W/verify.out"; then
    loki verify "$RUN" --allow-unsigned >"$W/verify2.out" 2>&1
    v2=$?
    if [ "$v2" -eq 0 ] && grep -q 'accepted by --allow-unsigned' "$W/verify2.out"; then
        ok "loki verify $RUN UNSIGNED refused rc=3, accepted rc=0 with --allow-unsigned: $VLINE"
    else
        bad "loki verify $RUN --allow-unsigned rc=$v2: $(tr '\n' ' ' < "$W/verify2.out")"
    fi
else
    bad "loki verify $RUN rc=$vrc: $(tr '\n' ' ' < "$W/verify.out")"
fi

# 5. A second --resume reports existing: true with the same URL.
loki "$TASK" --resume "$RUN" >"$W/run2.out" 2>&1
rrc=$?
N2="$(ev pr_count)"
EXISTING="$(ev existing)"
URL2="$(ev url)"
if [ "$N2" = "$((N1 + 1))" ] && [ "$EXISTING" = "true" ] && [ "$URL2" = "$URL" ]; then
    ok "resume: existing: $EXISTING, same URL $URL2"
else
    bad "resume rc=$rrc: pr.opened $N1 -> $N2, existing=$EXISTING, url=$URL2 (want $URL)"
fi

# Leave the sandbox clean for the next run.
gh pr close "$URL" --repo "$REPO" --delete-branch >/dev/null 2>&1 || echo "note: could not close $URL"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
