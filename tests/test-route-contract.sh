#!/usr/bin/env bash
# Routing contract (LM-003): every supported start/quick invocation form is run
# through `loki route --json` and asserted against a table. Equivalent forms
# (flag order, --prd vs positional, env vs flag) must land on the same engine
# and adapter, and any compatibility route (legacy engine, non-Claude provider)
# must report non-empty capability_differences. docs/contracts/routing.md holds
# the same table, rendered from the live output; this test fails if it drifts.
#
# Regenerate the doc with: bash tests/test-route-contract.sh --update-doc

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/bin/loki"
DOC="$REPO_ROOT/docs/contracts/routing.md"
UPDATE=0
[ "${1:-}" = "--update-doc" ] && UPDATE=1

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 missing"; exit 0; }

loki_run_tmp_create() {
    local temp_root marker
    [ -z "${LOKI_RUN_TMP:-}" ] || return 64
    temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || return 64
    LOKI_RUN_TMP="$(mktemp -d "${temp_root}/loki-run.XXXXXXXX")" || return 1
    marker="${LOKI_RUN_TMP}/.loki-run-owned"
    chmod 700 "$LOKI_RUN_TMP" || return 1
    printf '%s\n' "$LOKI_RUN_TMP" >"$marker" && chmod 600 "$marker" || return 1
    export LOKI_RUN_TMP
}
loki_run_tmp_create || { echo "FAIL: cannot create run tmp"; exit 1; }
WORK="$LOKI_RUN_TMP/work"
mkdir -p "$WORK"
cleanup() {
    case "${LOKI_RUN_TMP:-}" in
        */loki-run.*) [ -f "$LOKI_RUN_TMP/.loki-run-owned" ] && rm -rf -- "$LOKI_RUN_TMP" ;;
    esac
}
trap cleanup EXIT

printf '# Spec\nBuild a thing.\n' >"$WORK/p.md"
printf '{"title":"x"}\n' >"$WORK/p.json"
printf 'title: x\n' >"$WORK/p.yaml"
head -c 100100 /dev/zero | tr '\0' 'a' >"$WORK/big.md"

# Table: id|group|env assignments (space separated, may be empty)|args
# Fields are split on '|'. Args are split on spaces; "_" inside an arg is a space.
TABLE='
prd-md|prd-claude||start p.md
prd-md-flag-last|prd-claude||start p.md --provider claude
prd-md-flag-first|prd-claude||start --provider claude p.md
prd-md-prd-flag|prd-claude||start --prd p.md
prd-json|prd-json||start p.json
prd-yaml|prd-yaml||start p.yaml
task-words|task-claude||start fix_the_bug
task-multi-arg|task-claude||start fix the bug
task-bare-flag-first|task-claude||--explain-route --json fix_the_bug
quick-task|quick-claude||quick fix_the_bug
quick-task-multi-arg|quick-claude||quick fix the bug
issue-ref|issue-claude||start owner/repo#5
issue-ref-flag-last|issue-claude||start owner/repo#5 --provider claude
issue-url|issue-claude||start https://github.com/owner/repo/issues/5
brief-one-word|brief-claude||start hello
provider-codex|codex||start p.md --provider codex
provider-codex-first|codex||start --provider codex p.md
provider-codex-env|codex|LOKI_PROVIDER=codex|start p.md
provider-cline|cline||start p.md --provider cline
provider-aider|aider||start p.md --provider aider
provider-opencode|opencode||start p.md --provider opencode
provider-gemini|gemini||start p.md --provider gemini
engine-legacy-flag|legacy-explicit||start p.md --engine legacy
engine-legacy-flag-first|legacy-explicit||start --engine legacy p.md
engine-legacy-env|legacy-explicit|LOKI_ENGINE=legacy|start p.md
engine-engine10-flag|engine10-explicit||start p.md --engine engine10
engine-engine10-env|engine10-explicit|LOKI_ENGINE=engine10|start p.md
unsupported-flag|legacy-flag||start p.md --parallel
unsupported-flag-first|legacy-flag||start --parallel p.md
prd-too-large|legacy-size||start big.md
'

# Expected per group: engine|adapter|compat (1 = capability_differences must be non-empty)
expect_for() {
    case "$1" in
        prd-claude|prd-json|prd-yaml|task-claude|quick-claude|issue-claude|brief-claude|engine10-explicit)
            echo "engine10|engine10:claude|0" ;;
        codex|cline|aider|opencode) echo "engine10|engine10:$1|1" ;;
        gemini) echo "legacy|legacy-bash:gemini|1" ;;
        legacy-explicit|legacy-flag|legacy-size) echo "legacy|legacy-bash:claude|1" ;;
        *) echo "?|?|?" ;;
    esac
}

route_json() {
    local envs="$1"; shift
    local -a args=()
    local a
    for a in "$@"; do args+=("${a//_/ }"); done
    # Explicit scoped env: no inherited provider or engine selection.
    ( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE -u LOKI_MODEL_ROUTE -u LOKI_SESSION_MODEL \
        -u LOKI_MODEL_OVERRIDE -u LOKI_LEGACY_BASH LOKI_NO_BROWSER=1 HOME="$LOKI_RUN_TMP" \
        ${envs:+$envs} "$LOKI" route "${args[@]}" --json 2>/dev/null )
}

# Bare flag-first rows use --explain-route (route verb would swallow them).
route_row() {
    local envs="$1" argstr="$2"
    local -a words
    read -r -a words <<<"$argstr"
    if [ "${words[0]}" = "--explain-route" ]; then
        local -a args=()
        local a
        for a in "${words[@]}"; do args+=("${a//_/ }"); done
        ( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE -u LOKI_MODEL_ROUTE -u LOKI_SESSION_MODEL \
            -u LOKI_MODEL_OVERRIDE -u LOKI_LEGACY_BASH LOKI_NO_BROWSER=1 HOME="$LOKI_RUN_TMP" \
            ${envs:+$envs} "$LOKI" "${args[@]}" 2>/dev/null )
    else
        route_json "$envs" "${words[@]}"
    fi
}

field() { python3 -I -c 'import json,sys; d=json.loads(sys.stdin.read()); v=d[sys.argv[1]]; print(len(v) if isinstance(v,list) else v)' "$1"; }

ROWS_TSV="$LOKI_RUN_TMP/rows.tsv"
: >"$ROWS_TSV"
while IFS='|' read -r id group envs argstr; do
    [ -n "$id" ] || continue
    out="$(route_row "$envs" "$argstr")"
    if [ -z "$out" ]; then bad "$id: no route output"; continue; fi
    eng="$(printf '%s' "$out" | field engine 2>/dev/null)"
    adp="$(printf '%s' "$out" | field adapter 2>/dev/null)"
    ncd="$(printf '%s' "$out" | field capability_differences 2>/dev/null)"
    rsn="$(printf '%s' "$out" | field reason 2>/dev/null)"
    IFS='|' read -r want_eng want_adp compat <<<"$(expect_for "$group")"
    if [ "$eng" = "$want_eng" ] && [ "$adp" = "$want_adp" ]; then
        ok "$id: $eng / $adp"
    else
        bad "$id: got $eng / $adp, want $want_eng / $want_adp"
    fi
    if [ "$compat" = "1" ]; then
        if [ "${ncd:-0}" -gt 0 ]; then ok "$id: compatibility route lists capability differences"
        else bad "$id: compatibility route has empty capability_differences"; fi
    else
        if [ "${ncd:-1}" = "0" ]; then ok "$id: full Claude path has no capability differences"
        else bad "$id: full path lists capability differences ($ncd)"; fi
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$envs" "$argstr" "$eng" "$adp" "$ncd" "$rsn" >>"$ROWS_TSV"
done <<<"$TABLE"

# Error forms: missing PRD file is a usage error (exit 2), never a silent route.
set +e
( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE LOKI_NO_BROWSER=1 HOME="$LOKI_RUN_TMP" "$LOKI" route start nope.md --json >/dev/null 2>&1 )
rc=$?
set -e
if [ "$rc" = "2" ]; then ok "missing PRD file: exit 2"; else bad "missing PRD file: exit $rc, want 2"; fi
set +e
( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE LOKI_NO_BROWSER=1 HOME="$LOKI_RUN_TMP" "$LOKI" route start p.md --engine engine10 --parallel --json >/dev/null 2>&1 )
rc=$?
set -e
if [ "$rc" = "2" ]; then ok "--engine engine10 with an unsupported flag: exit 2"; else bad "--engine engine10 + --parallel: exit $rc, want 2"; fi

# Render the contract table from the live results.
RENDER="$LOKI_RUN_TMP/render.md"
python3 -I - "$ROWS_TSV" >"$RENDER" <<'PY'
import sys
print("| Invocation (after `loki route`, unless it starts with `loki` or an env var) | Engine | Adapter | Capability differences | Reason |")
print("|---|---|---|---|---|")
for line in open(sys.argv[1]):
    id_, envs, args, eng, adp, ncd, rsn = line.rstrip("\n").split("\t")
    args = " ".join('"%s"' % w.replace("_", " ") if "_" in w else w for w in args.split(" "))
    inv = "`" + (envs + " " if envs else "") + ("loki " if args.startswith("--explain-route") else "") + args + "`"
    cd = "none" if ncd == "0" else "%s listed" % ncd
    print("| %s | %s | %s | %s | %s |" % (inv, eng, adp, cd, rsn.replace("|", "/")))
PY

BEGIN='<!-- route-table:begin (generated by tests/test-route-contract.sh --update-doc) -->'
END='<!-- route-table:end -->'
if [ "$UPDATE" = "1" ]; then
    python3 -I - "$DOC" "$RENDER" "$BEGIN" "$END" <<'PY'
import sys
doc, render, begin, end = sys.argv[1:5]
s = open(doc).read()
a = s.index(begin) + len(begin)
b = s.index(end)
s = s[:a] + "\n" + open(render).read() + s[b:]
open(doc, "w").write(s)
PY
    echo "updated $DOC"
fi
current="$(python3 -I - "$DOC" "$BEGIN" "$END" <<'PY'
import sys
doc, begin, end = sys.argv[1:4]
s = open(doc).read()
a = s.index(begin) + len(begin)
b = s.index(end)
sys.stdout.write(s[a:b].strip("\n") + "\n")
PY
)"
if [ "$current" = "$(cat "$RENDER")" ]; then
    ok "docs/contracts/routing.md table matches live route output"
else
    bad "docs/contracts/routing.md table drifted; run: bash tests/test-route-contract.sh --update-doc"
fi

echo "route contract: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
