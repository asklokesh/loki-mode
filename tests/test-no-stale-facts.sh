#!/usr/bin/env bash
# STALE-ZERO SZ-03: docs must not carry stale facts.
#   (a) a `loki <cmd>` in README/SKILL/docs/wiki naming a top-level command absent
#       from the registry (loki-ts/src/cli/registry.ts, visible or hidden)
#   (b) dead env vars LOKI_ENGINE, LOKI_LEGACY_BASH, LOKI_SDK_LOOP
#   (c) a version string of an older major (v9.x and below)
# Exclusions: CHANGELOG.md, docs/history/, docs/v10/ planning records.
# ADVISORY while the legacy removal is in flight: prints findings and exits 0
# unless LOKI_STALE_ZERO_STRICT=1. The positive controls always run and are
# always fatal (a scanner that cannot see a planted violation is broken).
# Scanner: tests/lib/scan-stale-facts.py.
# shellcheck disable=SC2016  # fixture text deliberately contains literal backticks
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAN="$SCRIPT_DIR/lib/scan-stale-facts.py"

PASS=0
FAIL=0
pass() { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

echo "test-no-stale-facts"

if ! command -v python3 >/dev/null 2>&1 || ! command -v bun >/dev/null 2>&1; then
    echo "  [SKIP] python3 and bun are required"
    exit 0
fi

TMP_ROOT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
WORK="$(mktemp -d "${TMP_ROOT}/loki-run.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$WORK"' EXIT

CMDS="$WORK/commands.txt"
if ! (cd "$REPO_ROOT" && bun -e '
import { REGISTRY, allNames } from "./loki-ts/src/cli/registry.ts";
for (const c of REGISTRY) for (const n of allNames(c)) if (!n.startsWith("-")) console.log(n);
') >"$CMDS" 2>"$WORK/bun.err" || [ ! -s "$CMDS" ]; then
    fail "could not read the command registry: $(head -1 "$WORK/bun.err")"
    echo "  Passed: $PASS  Failed: $FAIL"
    exit 1
fi
pass "registry lists $(wc -l <"$CMDS" | tr -d ' ') names"

# --- Positive controls: planted violations in a temp tree ---------------------
BAD="$WORK/bad"
mkdir -p "$BAD/docs/history" "$BAD/docs/v10" "$BAD/wiki"
{
    echo '# Bad'
    echo 'Run `loki frobnicate-everything` now.'
    echo 'Set LOKI_ENGINE=legacy for the old path.'
    echo 'Introduced in v9.4.2.'
    echo '```bash'
    echo 'loki zzz-not-a-command --flag'
    echo '```'
} >"$BAD/README.md"
cp "$BAD/README.md" "$BAD/docs/history/old.md"
cp "$BAD/README.md" "$BAD/docs/v10/PLAN.md"
echo 'The LOKI_LEGACY_BASH switch and LOKI_SDK_LOOP.' >"$BAD/wiki/Page.md"

python3 "$SCAN" "$BAD" "$CMDS" >"$WORK/bad.out"
for kind in command envvar version; do
    if grep -q "^${kind}	" "$WORK/bad.out"; then pass "control: planted $kind violation caught"; else fail "control: planted $kind violation NOT caught"; fi
done
if grep -q "^command	README.md:6" "$WORK/bad.out"; then pass "control: fenced-block command caught"; else fail "control: fenced-block command NOT caught"; fi
if grep -q "wiki/Page.md:1	LOKI_LEGACY_BASH" "$WORK/bad.out" && grep -q "wiki/Page.md:1	LOKI_SDK_LOOP" "$WORK/bad.out"; then pass "control: wiki dead env vars caught"; else fail "control: wiki dead env vars NOT caught"; fi
if grep -qE "docs/(history|v10)/" "$WORK/bad.out"; then fail "control: excluded paths were scanned"; else pass "control: docs/history and docs/v10 excluded"; fi

GOOD="$WORK/good"
mkdir -p "$GOOD"
{
    echo '# Good'
    echo 'Run `loki doctor` and `loki "fix the bug"` or `loki owner/repo#1`.'
    echo 'Released as v10.2.0.'
    echo '```bash'
    echo 'loki status'
    echo '```'
} >"$GOOD/README.md"
python3 "$SCAN" "$GOOD" "$CMDS" >"$WORK/good.out"
if [ ! -s "$WORK/good.out" ]; then pass "control: clean tree has no findings"; else fail "control: clean tree flagged: $(head -1 "$WORK/good.out")"; fi

# --- Real scan ------------------------------------------------------------------
python3 "$SCAN" "$REPO_ROOT" "$CMDS" >"$WORK/real.out"
total="$(wc -l <"$WORK/real.out" | tr -d ' ')"
for kind in command envvar version; do
    n="$(grep -c "^${kind}	" "$WORK/real.out" || true)"
    echo "  findings ${kind}: ${n}"
done
echo "  findings total: ${total}"

if [ "$total" -gt 0 ]; then
    head -40 "$WORK/real.out" | sed 's/^/    /'
    [ "$total" -gt 40 ] && echo "    ... ($((total - 40)) more)"
    if [ "${LOKI_STALE_ZERO_STRICT:-0}" = "1" ]; then
        fail "stale facts found in docs (strict mode)"
    else
        echo "  [ADVISORY] stale facts present; set LOKI_STALE_ZERO_STRICT=1 to enforce"
    fi
else
    pass "no stale facts in docs"
fi

# --- Pinned facts (FV-docs-pin) -------------------------------------------------
# loki answer resumes the BLOCKED run in place; the old "Resume a BLOCKED" wording must not return.
hits="$(cd "$REPO_ROOT" && grep -rIl "Resume a BLOCKED" README.md autonomy/loki loki-ts/src completions docs/CLI-REFERENCE.md docs/slack.md 2>/dev/null || true)"
if [ -z "$hits" ]; then pass "loki answer wording: no 'Resume a BLOCKED' left"; else fail "loki answer wording stale in: $(echo "$hits" | tr '\n' ' ')"; fi
if grep -qi "loki answer" "$REPO_ROOT/docs/slack.md"; then pass "docs/slack.md mentions CLI loki answer"; else fail "docs/slack.md lacks CLI loki answer line"; fi

# wiki/Providers.md capability rows must equal the providers/<p>.sh vars.
prov_out="$(cd "$REPO_ROOT" && python3 - <<'PY'
import re
rows = {}
for line in open("wiki/Providers.md", encoding="utf-8"):
    if line.startswith("| **") and line.count("|") >= 8:
        c = [x.strip() for x in line.strip().strip("|").split("|")]
        rows[re.sub(r"[* ]", "", c[0]).lower()] = c
def var(p, k):
    m = re.search(r"^%s=(\S+)" % k, open("providers/%s.sh" % p, encoding="utf-8").read(), re.M)
    return m.group(1).split("#")[0] if m else None
def ctx(v):
    return "varies" if v is None else ("%dM" % (int(v) // 1000000) if int(v) % 1000000 == 0 else "%dK" % (int(v) // 1000))
bad = []
for p in ("claude", "cline", "codex", "aider", "opencode"):
    c = rows.get(p)
    if not c or len(c) < 7:
        bad.append("%s: row or Degraded column missing" % p); continue
    par = var(p, "PROVIDER_HAS_PARALLEL") == "true"
    mx = var(p, "PROVIDER_MAX_PARALLEL")
    want_par = ("Yes (max %s)" % mx) if par and mx != "1" and p == "codex" else ("Yes" if par else "No")
    want = {3: want_par, 4: "Yes" if var(p, "PROVIDER_HAS_MCP") == "true" else "No", 5: ctx(var(p, "PROVIDER_CONTEXT_WINDOW")), 6: "Yes" if var(p, "PROVIDER_DEGRADED") == "true" else "No"}
    for i, w in want.items():
        if c[i] != w:
            bad.append("%s col %d: doc '%s' != providers/%s.sh '%s'" % (p, i, c[i], p, w))
print("\n".join(bad))
PY
)"
if [ -z "$prov_out" ]; then pass "wiki/Providers.md matches providers/*.sh"; else fail "wiki/Providers.md drift: $(echo "$prov_out" | tr '\n' ';')"; fi
grep -q "providers/\*.sh" "$REPO_ROOT/wiki/Providers.md" && pass "Providers.md cites its source" || fail "Providers.md lacks source note"

# Documented minimum Node must equal package.json engines.node.
node_min="$(cd "$REPO_ROOT" && python3 -c 'import json,re;print(re.search(r"(\d+)",json.load(open("package.json"))["engines"]["node"]).group(1))')"
node_bad=""
for f in README.md docs/INSTALLATION.md wiki/Installation.md; do
    docs_min="$(grep -E '^- \*{0,2}Node|^- Node|^\| Node' "$REPO_ROOT/$f" | grep -oE '[0-9]+' | head -1 || true)"
    [ "$docs_min" = "$node_min" ] || node_bad="$node_bad $f($docs_min)"
done
if [ -z "$node_bad" ]; then pass "documented Node floor equals package.json engines (${node_min})"; else fail "Node floor != ${node_min} in:$node_bad"; fi

# wiki pages must be stamped with the current VERSION, and CLI-Reference carries no legacy banner.
cur_ver="$(tr -d '\n' <"$REPO_ROOT/VERSION")"
stale_stamps="$(grep -lE 'still ships in [0-9]+\.[0-9]+\.[0-9]+' "$REPO_ROOT"/wiki/*.md | while read -r f; do grep -qE "still ships in ${cur_ver//./\\.}( |\\.|,)" "$f" || basename "$f"; done | tr '\n' ' ')"
if [ -z "$stale_stamps" ]; then pass "wiki version stamps equal VERSION ${cur_ver}"; else fail "wiki stamps != ${cur_ver}: ${stale_stamps}"; fi
if grep -q "Legacy engine note" "$REPO_ROOT/wiki/CLI-Reference.md"; then fail "wiki/CLI-Reference.md still has the legacy engine banner"; else pass "wiki/CLI-Reference.md has no legacy banner"; fi
if grep -q 'wiki/\*.md' "$REPO_ROOT/scripts/generate-stale-zero.sh"; then pass "generate-stale-zero.sh stamps wiki pages"; else fail "generate-stale-zero.sh does not stamp wiki pages"; fi

echo "  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
