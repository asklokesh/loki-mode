#!/usr/bin/env bash
# `loki heal --assess` must report the DECLARED runtime and frameworks, and must
# never guess what it cannot read.
#
# WHY THIS EXISTS. Measured on a real legacy repo: assess correctly detected
# package.json and flagged the missing lockfile, but said nothing about what the
# project was BUILT ON -- lodash 3.x and express 4.16 sat in the manifest
# unmentioned. After "how far behind am I", "what is this even built on" is the
# next question a legacy-modernization buyer asks, and answering "package.json
# exists" leaves them to open the file themselves. That is the work they were
# trying to delegate.
#
# THE HONESTY CONSTRAINT IS THE POINT. dependency_staleness stays "unknown"
# offline by deliberate design (autonomy/loki: "not computable offline; never
# guessed") -- that is an air-gap FEATURE, not a limitation, and this addition
# must not erode it. Everything asserted here is read from the manifest file;
# nothing is inferred about what is current upstream.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

command -v git >/dev/null 2>&1 || { echo "SKIP: git unavailable"; exit 0; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkrepo() {
    local d="$WORK/$1"; mkdir -p "$d"; ( cd "$d" && git init -q . \
        && git config user.email t@example.com && git config user.name t \
        && git config commit.gpgsign false ) >/dev/null 2>&1
    printf '%s' "$d"
}

assess() {
    ( cd "$1" && git add -A >/dev/null 2>&1; git commit -qm x >/dev/null 2>&1
      "$LOKI" heal . --assess --json </dev/null 2>/dev/null ) | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
except Exception:
    print("UNPARSEABLE"); raise SystemExit
print(json.dumps(d.get("maintenance_risk", {}).get("runtime", {})))
' 2>/dev/null
}

# 1. A node project: report the runtime, the dependency COUNT, and the
#    frameworks actually present.
d="$(mkrepo node)"
cat > "$d/package.json" <<'J'
{"name":"old","version":"0.1.0","dependencies":{"express":"^4.16.0","lodash":"^3.10.1","request":"^2.88.0"}}
J
r="$(assess "$d")"
case "$r" in
    UNPARSEABLE) bad "assess did not emit parseable JSON for a node project" ;;
    *)
        if printf '%s' "$r" | grep -q '"declared_runtime": "node'; then
            ok "reports the declared node runtime"
        else
            bad "no declared_runtime for a package.json project: ${r}"
        fi
        if printf '%s' "$r" | grep -q 'express'; then
            ok "names the framework present in the manifest (express)"
        else
            bad "framework_hints missed express: ${r}"
        fi
        if printf '%s' "$r" | grep -q '"declared_dependencies": 3'; then
            ok "counts declared dependencies (3)"
        else
            bad "wrong or missing dependency count: ${r}"
        fi
        ;;
esac

# 2. engines.node present -> report the ACTUAL constraint, not a placeholder.
d="$(mkrepo engines)"
cat > "$d/package.json" <<'J'
{"name":"e","version":"1.0.0","engines":{"node":">=18"},"dependencies":{}}
J
r="$(assess "$d")"
if printf '%s' "$r" | grep -q '>=18'; then
    ok "reports the declared engine constraint verbatim"
else
    bad "did not surface engines.node: ${r}"
fi

# 3. A MALFORMED manifest must produce nulls, not a guess and not a crash.
#    Reporting nothing is correct; reporting something wrong is the failure.
d="$(mkrepo broken)"
printf '{ this is not valid json' > "$d/package.json"
r="$(assess "$d")"
case "$r" in
    UNPARSEABLE) bad "a malformed manifest crashed the whole assess" ;;
    *)
        if printf '%s' "$r" | grep -q '"declared_runtime": null'; then
            ok "a malformed manifest yields null, not a fabricated runtime"
        else
            bad "a malformed manifest produced a value: ${r}"
        fi
        ;;
esac

# 4. THE HONESTY INVARIANT. dependency_staleness must remain "unknown" offline
#    no matter what else we learned to read. If this ever reports a number
#    without a network opt-in, the air-gapped guarantee is broken.
stale="$( ( cd "$WORK/node" && "$LOKI" heal . --assess --json </dev/null 2>/dev/null ) | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
except Exception:
    print("UNPARSEABLE"); raise SystemExit
print(d.get("maintenance_risk", {}).get("dependency_staleness"))
' 2>/dev/null)"
if [ "$stale" = "unknown" ]; then
    ok "dependency_staleness stays 'unknown' offline (never guessed)"
else
    bad "dependency_staleness became '${stale}' without a network opt-in"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
