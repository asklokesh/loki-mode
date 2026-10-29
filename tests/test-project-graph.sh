#!/usr/bin/env bash
# tests/test-project-graph.sh -- Phase F (v7.5.23) regression test for
# autonomy/lib/project-graph.sh.
#
# Verifies the discovery algorithm:
# - From a member dir (acme/ui): finds app_id=acme, root=acme, 3 members
# - From a dir without a manifest: exits 0 with empty exported env vars
# - Mismatched app_id in a sibling -> skipped + logged
# - Cache hit: second run within the same mtime spawns no python3
# - Output style matches tests/test-claude-flags.sh (PASS:/FAIL:/total)

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$REPO_ROOT/autonomy/lib/project-graph.sh"
FIXTURE_SRC="$REPO_ROOT/tests/fixtures/project-graph/acme"

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() {
    [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"
}
trap cleanup EXIT

# ---------- Static checks ----------
if bash -n "$HELPER" 2>/dev/null; then
    ok "helper parses with bash -n"
else
    bad "helper failed bash -n"
fi

if command -v shellcheck >/dev/null 2>&1; then
    if shellcheck -S error "$HELPER" >/dev/null 2>&1; then
        ok "helper shellcheck -S error clean"
    else
        bad "helper shellcheck -S error reported issues"
    fi
else
    ok "SKIP: shellcheck not on PATH"
fi

# Source the helper for function tests.
# shellcheck disable=SC1090
. "$HELPER"

# ---------- Fixture setup: copy acme tree into a tmp dir ----------
TMPROOT=$(mktemp -d -t loki-project-graph-XXXX)
cp -R "$FIXTURE_SRC" "$TMPROOT/acme"
ACME="$TMPROOT/acme"
[ -f "$ACME/.loki/app.json" ] || bad "fixture missing parent manifest"
[ -f "$ACME/ui/.loki/app.json" ] || bad "fixture missing ui manifest"

# ---------- 1. Discovery from member dir ----------
# Run in a subshell to avoid polluting later cases.
(
    unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
    loki_project_graph_discover "$ACME/ui"
    printf 'ROOT=%s\nAPP=%s\nMEMS=%s\n' \
        "$LOKI_PROJECT_GRAPH_ROOT" "$LOKI_PROJECT_GRAPH_APP_ID" "$LOKI_PROJECT_GRAPH_MEMBERS"
) > "$TMPROOT/out1.txt"

root=$(grep '^ROOT=' "$TMPROOT/out1.txt" | sed 's/^ROOT=//')
app=$(grep '^APP=' "$TMPROOT/out1.txt" | sed 's/^APP=//')
mems=$(grep '^MEMS=' "$TMPROOT/out1.txt" | sed 's/^MEMS=//')

if [ "$app" = "acme" ]; then ok "discover: app_id=acme from ui"; else bad "discover: app_id got [$app]"; fi
if [ -n "$root" ]; then ok "discover: root set"; else bad "discover: root empty"; fi
# Members should include the 3 dirs (sorted by absolute path).
mem_count=$(printf '%s' "$mems" | tr ':' '\n' | grep -c .)
if [ "$mem_count" -eq 3 ]; then ok "discover: 3 members"; else bad "discover: got $mem_count members [$mems]"; fi
for m in "$ACME/ui" "$ACME/api" "$ACME/service"; do
    case ":$mems:" in
        *":$m:"*) ok "discover: members contains $(basename "$m")" ;;
        *)        bad "discover: members missing $(basename "$m") (mems=$mems)" ;;
    esac
done

# ---------- 2. No manifest anywhere -> empty exports ----------
NOMARKER="$TMPROOT/standalone"
mkdir -p "$NOMARKER"
(
    unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
    loki_project_graph_discover "$NOMARKER"
    rc=$?
    printf 'RC=%s\nROOT=%s\nAPP=%s\nMEMS=%s\n' \
        "$rc" "$LOKI_PROJECT_GRAPH_ROOT" "$LOKI_PROJECT_GRAPH_APP_ID" "$LOKI_PROJECT_GRAPH_MEMBERS"
) > "$TMPROOT/out2.txt"
rc=$(grep '^RC=' "$TMPROOT/out2.txt" | sed 's/^RC=//')
root=$(grep '^ROOT=' "$TMPROOT/out2.txt" | sed 's/^ROOT=//')
app=$(grep '^APP=' "$TMPROOT/out2.txt" | sed 's/^APP=//')
mems=$(grep '^MEMS=' "$TMPROOT/out2.txt" | sed 's/^MEMS=//')
if [ "$rc" = "0" ]; then ok "no-manifest: returns 0"; else bad "no-manifest: rc=$rc"; fi
if [ -z "$root$app$mems" ]; then ok "no-manifest: all exports empty"; else bad "no-manifest: exports root=[$root] app=[$app] mems=[$mems]"; fi

# ---------- 3. Mismatched app_id sibling -> skipped + logged ----------
MISMATCH_TREE="$TMPROOT/mismatch"
mkdir -p "$MISMATCH_TREE/acme/ui/.loki" "$MISMATCH_TREE/acme/api/.loki" "$MISMATCH_TREE/acme/web/.loki" "$MISMATCH_TREE/acme/.loki"
printf '%s\n' '{"schema_version":1,"app_id":"acme"}' > "$MISMATCH_TREE/acme/.loki/app.json"
printf '%s\n' '{"schema_version":1,"app_id":"acme"}' > "$MISMATCH_TREE/acme/ui/.loki/app.json"
printf '%s\n' '{"schema_version":1,"app_id":"acme"}' > "$MISMATCH_TREE/acme/api/.loki/app.json"
# web is a fixed-name sibling but with a different app_id -> skip + log
printf '%s\n' '{"schema_version":1,"app_id":"other-app"}' > "$MISMATCH_TREE/acme/web/.loki/app.json"
(
    unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
    loki_project_graph_discover "$MISMATCH_TREE/acme/ui"
    printf 'APP=%s\nMEMS=%s\n' "$LOKI_PROJECT_GRAPH_APP_ID" "$LOKI_PROJECT_GRAPH_MEMBERS"
) > "$TMPROOT/out3.txt"
app=$(grep '^APP=' "$TMPROOT/out3.txt" | sed 's/^APP=//')
mems=$(grep '^MEMS=' "$TMPROOT/out3.txt" | sed 's/^MEMS=//')
if [ "$app" = "acme" ]; then ok "mismatch: cluster app_id=acme"; else bad "mismatch: got [$app]"; fi
case ":$mems:" in
    *":$MISMATCH_TREE/acme/web:"*) bad "mismatch: web member should be excluded" ;;
    *) ok "mismatch: web member excluded" ;;
esac
LOG="$MISMATCH_TREE/acme/ui/.loki/state/project-graph.log"
if [ -f "$LOG" ] && grep -q "app_id_mismatch" "$LOG"; then
    ok "mismatch: skip logged to project-graph.log"
else
    bad "mismatch: expected app_id_mismatch entry in $LOG"
fi

# ---------- 4. Cache hit: no python3 on the hot path ----------
# First run primes the cache, second run hits it. Wall-clock timing is not
# asserted: it is load dependent and flaked on a busy host. The contract the
# timing proxied is that a hit never spawns python3, which is checked directly
# with a recording python3 stub ahead of PATH.
# Use a fresh fixture so the cache file from test #1 isn't present.
CACHEFIX="$TMPROOT/cachefix"
cp -R "$FIXTURE_SRC" "$CACHEFIX"

# Prime cache.
(
    unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
    loki_project_graph_discover "$CACHEFIX/ui" >/dev/null
) || true

CACHE_FILE="$CACHEFIX/ui/.loki/state/project-graph.json"
if [ -f "$CACHE_FILE" ]; then
    ok "cache: file written on first run"
else
    bad "cache: expected $CACHE_FILE after first run"
fi

# Hit runs with a recording python3 stub first on PATH. Any python3 spawn on
# the hot path is logged and fails the check.
STUBBIN="$TMPROOT/stubbin"
STUBLOG="$TMPROOT/python3-calls.log"
mkdir -p "$STUBBIN"
: > "$STUBLOG"
printf '#!/bin/sh\necho "python3 $*" >> "%s"\nexit 1\n' "$STUBLOG" > "$STUBBIN/python3"
chmod +x "$STUBBIN/python3"
for _i in 1 2 3; do
    (
        PATH="$STUBBIN:$PATH"
        unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
        loki_project_graph_discover "$CACHEFIX/ui" >/dev/null
    )
done
if [ ! -s "$STUBLOG" ]; then
    ok "cache: 3 cache-hit runs spawned no python3"
else
    bad "cache: cache-hit run spawned python3: $(head -1 "$STUBLOG")"
fi

# Verify cached values match first-run exports.
(
    unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
    loki_project_graph_discover "$CACHEFIX/ui"
    printf 'APP=%s\nMEMS=%s\n' "$LOKI_PROJECT_GRAPH_APP_ID" "$LOKI_PROJECT_GRAPH_MEMBERS"
) > "$TMPROOT/out4.txt"
app=$(grep '^APP=' "$TMPROOT/out4.txt" | sed 's/^APP=//')
mems=$(grep '^MEMS=' "$TMPROOT/out4.txt" | sed 's/^MEMS=//')
if [ "$app" = "acme" ]; then ok "cache: cached app_id=acme"; else bad "cache: got [$app]"; fi
mem_count=$(printf '%s' "$mems" | tr ':' '\n' | grep -c .)
if [ "$mem_count" -eq 3 ]; then ok "cache: 3 members on hit"; else bad "cache: got $mem_count members [$mems]"; fi

# ---------- 5. Graph exists even when TARGET_DIR has no manifest ----------
# Spec scenario: parent + siblings have manifests, target_dir does not.
NOSELF="$TMPROOT/noself"
mkdir -p "$NOSELF/acme/.loki" "$NOSELF/acme/ui/.loki" "$NOSELF/acme/api/.loki" "$NOSELF/acme/orphan"
printf '%s\n' '{"schema_version":1,"app_id":"acme"}' > "$NOSELF/acme/.loki/app.json"
printf '%s\n' '{"schema_version":1,"app_id":"acme"}' > "$NOSELF/acme/ui/.loki/app.json"
printf '%s\n' '{"schema_version":1,"app_id":"acme"}' > "$NOSELF/acme/api/.loki/app.json"
# orphan/ has no manifest -- but should still discover the graph via parent.
(
    unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
    loki_project_graph_discover "$NOSELF/acme/orphan"
    printf 'APP=%s\n' "$LOKI_PROJECT_GRAPH_APP_ID"
) > "$TMPROOT/out5.txt"
app=$(grep '^APP=' "$TMPROOT/out5.txt" | sed 's/^APP=//')
if [ "$app" = "acme" ]; then
    ok "graph-without-self-manifest: app_id=acme discovered via parent"
else
    bad "graph-without-self-manifest: got [$app]"
fi

# ---------- 6. Invalid schema_version -> ignored ----------
BADSCHEMA="$TMPROOT/badschema"
mkdir -p "$BADSCHEMA/acme/ui/.loki" "$BADSCHEMA/acme/.loki"
printf '%s\n' '{"schema_version":2,"app_id":"acme"}' > "$BADSCHEMA/acme/.loki/app.json"
printf '%s\n' '{"schema_version":2,"app_id":"acme"}' > "$BADSCHEMA/acme/ui/.loki/app.json"
(
    unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
    loki_project_graph_discover "$BADSCHEMA/acme/ui"
    printf 'APP=%s\n' "$LOKI_PROJECT_GRAPH_APP_ID"
) > "$TMPROOT/out6.txt"
app=$(grep '^APP=' "$TMPROOT/out6.txt" | sed 's/^APP=//')
if [ -z "$app" ]; then
    ok "schema-mismatch: schema_version!=1 ignored"
else
    bad "schema-mismatch: got [$app] (should be empty)"
fi

# ---------- 7. Invalid app_id regex -> ignored ----------
BADID="$TMPROOT/badid"
mkdir -p "$BADID/acme/ui/.loki" "$BADID/acme/.loki"
printf '%s\n' '{"schema_version":1,"app_id":"AcMe!"}' > "$BADID/acme/.loki/app.json"
printf '%s\n' '{"schema_version":1,"app_id":"AcMe!"}' > "$BADID/acme/ui/.loki/app.json"
(
    unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
    loki_project_graph_discover "$BADID/acme/ui"
    printf 'APP=%s\n' "$LOKI_PROJECT_GRAPH_APP_ID"
) > "$TMPROOT/out7.txt"
app=$(grep '^APP=' "$TMPROOT/out7.txt" | sed 's/^APP=//')
if [ -z "$app" ]; then
    ok "bad-app-id: invalid regex rejected"
else
    bad "bad-app-id: got [$app] (should be empty)"
fi

# ---------- 8. Phase G: _lpg_find_git_root from 3 levels deep ----------
# Build a tree: <tmp>/repo/.git + <tmp>/repo/a/b/c (3 levels under repo).
# Walking from c/ must return <tmp>/repo (the dir that contains .git).
GITFIX="$TMPROOT/gitfix"
mkdir -p "$GITFIX/repo/.git" "$GITFIX/repo/a/b/c"
# Override HOME to a path NOT containing GITFIX so the $HOME stop does not
# short-circuit the walk before .git is found.
git_root_out=$(HOME="$TMPROOT/elsewhere" _lpg_find_git_root "$GITFIX/repo/a/b/c")
expected_root=$(cd "$GITFIX/repo" && pwd)
if [ "$git_root_out" = "$expected_root" ]; then
    ok "find_git_root: 3-levels-deep target resolves to git root"
else
    bad "find_git_root: expected [$expected_root], got [$git_root_out]"
fi

# ---------- 9. Phase G: _lpg_find_git_root stops at $HOME ----------
# Tree has no .git anywhere. Walking up from <FAKE_HOME>/proj/deep should
# stop at FAKE_HOME and return empty (NOT keep climbing to / and beyond).
FAKEHOME="$TMPROOT/fakehome"
mkdir -p "$FAKEHOME/proj/deep"
git_root_out=$(HOME="$FAKEHOME" _lpg_find_git_root "$FAKEHOME/proj/deep")
if [ -z "$git_root_out" ]; then
    ok "find_git_root: stops at \$HOME when no .git found"
else
    bad "find_git_root: should have stopped at HOME, got [$git_root_out]"
fi

# ---------- 10. Phase G: subdir walker emits root-to-leaf with LOKI_LAYER:subdir ----------
# Build: <tmp>/subwalk/repo/.git + intermediate CLAUDE.md files at each
# nesting level (repo/, repo/a/, repo/a/b/), and a scope CLAUDE.md at c/.
SUBWALK="$TMPROOT/subwalk"
mkdir -p "$SUBWALK/repo/.git" "$SUBWALK/repo/a/b/c"
printf '%s\n' '# repo root claude' > "$SUBWALK/repo/CLAUDE.md"
printf '%s\n' '# subdir a claude'    > "$SUBWALK/repo/a/CLAUDE.md"
printf '%s\n' '# subdir b claude'    > "$SUBWALK/repo/a/b/CLAUDE.md"
printf '%s\n' '# scope c claude'     > "$SUBWALK/repo/a/b/c/CLAUDE.md"
(
    unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
    HOME="$TMPROOT/elsewhere" TARGET_DIR="$SUBWALK/repo/a/b/c" load_app_graph_context
) > "$TMPROOT/subwalk.out"

repo_abs=$(cd "$SUBWALK/repo" && pwd)
# Each subdir layer must appear with the LOKI_LAYER:subdir marker.
ok_count=0
for p in "$repo_abs/CLAUDE.md" "$repo_abs/a/CLAUDE.md" "$repo_abs/a/b/CLAUDE.md"; do
    if grep -qF "<!-- LOKI_LAYER:subdir path=$p -->" "$TMPROOT/subwalk.out"; then
        ok_count=$((ok_count + 1))
    fi
done
# Scope layer should use the scope marker, not subdir.
scope_marker_present=0
if grep -qF "<!-- LOKI_LAYER:scope path=$repo_abs/a/b/c/CLAUDE.md -->" "$TMPROOT/subwalk.out"; then
    scope_marker_present=1
fi
# Root-to-leaf order: byte offset of the repo-root subdir marker must be
# less than the b-level subdir marker.
off_root=$(grep -bF "<!-- LOKI_LAYER:subdir path=$repo_abs/CLAUDE.md -->" "$TMPROOT/subwalk.out" | head -n1 | cut -d: -f1)
off_b=$(grep -bF "<!-- LOKI_LAYER:subdir path=$repo_abs/a/b/CLAUDE.md -->" "$TMPROOT/subwalk.out" | head -n1 | cut -d: -f1)
order_ok=0
if [ -n "$off_root" ] && [ -n "$off_b" ] && [ "$off_root" -lt "$off_b" ]; then
    order_ok=1
fi
if [ "$ok_count" = "3" ] && [ "$scope_marker_present" = "1" ] && [ "$order_ok" = "1" ]; then
    ok "subdir-walker: 3 subdir layers + scope, emitted root-to-leaf"
else
    bad "subdir-walker: count=$ok_count scope=$scope_marker_present order=$order_ok"
fi

# ---------- 11. Phase G: dedupe across parent + subdir collision ----------
# Build a fixture where LOKI_PROJECT_GRAPH_ROOT happens to equal git-root,
# so the parent layer path collides with the topmost subdir layer path.
# Expected: the collided CLAUDE.md is emitted EXACTLY ONCE (the first
# kind wins -- parent here, since parent is appended before subdir).
DEDUPE="$TMPROOT/dedupe"
mkdir -p "$DEDUPE/repo/.git" "$DEDUPE/repo/ui/.loki/state"
printf '%s\n' '# shared root claude' > "$DEDUPE/repo/CLAUDE.md"
printf '%s\n' '# ui scope claude'    > "$DEDUPE/repo/ui/CLAUDE.md"
repo_abs=$(cd "$DEDUPE/repo" && pwd)
ui_abs=$(cd "$DEDUPE/repo/ui" && pwd)
(
    # Manually set the project-graph env vars so the walker sees a parent
    # at git-root. No members; the parent layer alone collides with the
    # topmost subdir layer.
    LOKI_PROJECT_GRAPH_ROOT="$repo_abs"
    LOKI_PROJECT_GRAPH_APP_ID="dedupe"
    LOKI_PROJECT_GRAPH_MEMBERS=""
    export LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
    HOME="$TMPROOT/elsewhere" TARGET_DIR="$ui_abs" load_app_graph_context
) > "$TMPROOT/dedupe.out"

# Count how many times the colliding path appears as the path= value in
# any LOKI_LAYER marker. Must be exactly 1.
collide_count=$(grep -cF "<!-- LOKI_LAYER:parent path=$repo_abs/CLAUDE.md -->" "$TMPROOT/dedupe.out")
subdir_dup=$(grep -cF "<!-- LOKI_LAYER:subdir path=$repo_abs/CLAUDE.md -->" "$TMPROOT/dedupe.out")
if [ "$collide_count" = "1" ] && [ "$subdir_dup" = "0" ]; then
    ok "dedupe: parent + subdir collision emits the shared path exactly once"
else
    bad "dedupe: parent_count=$collide_count subdir_dup=$subdir_dup (want 1 + 0)"
fi

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
