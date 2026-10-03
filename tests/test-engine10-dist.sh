#!/usr/bin/env bash
# E-32 (docs/v10/ENGINE.md): the Loki 10 engine must run from the npm package,
# which ships loki-ts/dist and no loki-ts/src. Packs the repo, extracts it,
# bundles the current src into <extract>/loki-ts/dist/loki.js (the Captain's
# rebuild; nothing is written to the repo's own dist), then drives the bundle.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

if ! command -v bun >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "FAIL: bun and npm are required"; exit 1
fi

T="$(mktemp -d "${TMPDIR:-/tmp}/e10-dist.XXXXXX")"
trap 'rm -rf -- "$T"' EXIT
T="$(cd "$T" && pwd -P)" # macOS TMPDIR is under /var -> /private/var
export LOKI_NO_BROWSER=1 LOKI_TELEMETRY_DISABLED=1

# 1. Pack and extract. --ignore-scripts: no prepack hook may touch the repo dist.
(cd "$REPO" && npm pack --ignore-scripts --silent --pack-destination "$T") >"$T/pack.out" 2>"$T/pack.err"
TGZ="$(ls "$T"/*.tgz 2>/dev/null | head -1)"
if [ -z "$TGZ" ]; then bad "npm pack produced a tarball"; cat "$T/pack.err"; exit 1; fi
mkdir -p "$T/x" && tar -xzf "$TGZ" -C "$T/x"
P="$T/x/package"
[ ! -e "$P/loki-ts/src" ] && ok "packed tree has no loki-ts/src" || bad "packed tree has no loki-ts/src"

# 2. Rebuild the bundle from the current src into the extract.
B="$P/loki-ts/dist/loki.js"
if (cd "$REPO/loki-ts" && bun build src/cli.ts --target=bun --outfile "$B") >"$T/build.out" 2>&1; then
    ok "bun build of src/cli.ts into the extract"
else
    bad "bun build of src/cli.ts into the extract"; tail -20 "$T/build.out"
fi

# 3. Every stage module is inside the bundle (the non-literal loader bundled none).
# intake and pr export a plain `stage`, so their run functions mark them.
for id in runIntake planStage wallStage implementStage verifyStage fixStage sealStage runPr deepStage; do
    grep -q "$id" "$B" && ok "bundle contains $id" || bad "bundle contains $id"
done

# 4. cli TABLE routes resolve from the bundle.
mkdir -p "$T/cwd"
TO="$(command -v timeout || command -v gtimeout || true)"
run_b() { (cd "$T/cwd" && env -i HOME="$T/cwd" PATH="$PATH" LOKI_NO_BROWSER=1 LOKI_TELEMETRY_DISABLED=1 \
    ${TO:+"$TO" -k 10 30} "$@"); }
out="$(run_b bun "$B" engine10 status 2>&1)"; rc=$?
case "$rc:$out" in 1:*"no runs found"*) ok "engine10 status runs from dist" ;; *) bad "engine10 status runs from dist (rc=$rc: $out)" ;; esac
# The session child route: an unknown provider is rejected by resolveProvider inside
# session.ts, which proves the route loaded without starting any provider.
out="$(run_b env LOKI_E10_PROVIDER=e32-none bun "$B" engine10 session 2>&1)"; rc=$?
case "$rc:$out" in 1:*"unknown provider: e32-none"*) ok "engine10 session runs from dist" ;; *) bad "engine10 session runs from dist (rc=$rc: $out)" ;; esac

# 5. Paths resolve from REPO_ROOT, so the push helper is found inside the package.
# A probe bundled next to loki.js reads what the bundled pr stage resolves.
printf 'import { DEFAULT_PUSH_SH } from "%s/loki-ts/src/engine10/stages/pr.ts";\nconsole.log(DEFAULT_PUSH_SH);\n' "$REPO" >"$T/probe.ts"
bun build "$T/probe.ts" --target=bun --outfile "$P/loki-ts/dist/e32-probe.js" >/dev/null 2>&1
got="$(run_b bun "$P/loki-ts/dist/e32-probe.js" 2>&1)"
rm -f "$P/loki-ts/dist/e32-probe.js"
[ "$got" = "$P/autonomy/lib/engine10-push.sh" ] && ok "pr stage resolves engine10-push.sh inside the package" \
    || bad "pr stage resolves engine10-push.sh inside the package (got: $got)"
[ -f "$P/autonomy/lib/engine10-push.sh" ] && [ -f "$P/autonomy/issue-providers.sh" ] \
    && ok "push and issue-provider scripts ship in the package" || bad "push and issue-provider scripts ship in the package"

# 6. The package, with the rebuilt dist, lists the three files the engine needs.
(cd "$P" && npm pack --dry-run --json --ignore-scripts) >"$T/dry.json" 2>/dev/null
for f in autonomy/lib/engine10-push.sh autonomy/receipt_jwt.py loki-ts/dist/loki.js; do
    grep -q "\"path\": \"$f\"" "$T/dry.json" && ok "dry-run lists $f" || bad "dry-run lists $f"
done

# 7. Full run from the package (card step 3) needs supervisor main (E-42).
# ponytail: add the stub-provider run here once E-42 gives supervisor.ts a main.
echo "PENDING E-42: end-to-end run from the package is not exercised yet (not counted as a pass)"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
