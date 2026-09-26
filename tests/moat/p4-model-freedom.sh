#!/usr/bin/env bash
# Case functions are dispatched by name through run_case (SC2329), and the
# embedded sed/awk/bash -c programs carry literal dollar signs (SC2016).
# shellcheck disable=SC2329,SC2016
# Moat property P4: model freedom.
#
# "The pipeline runs at top-only (claude-opus-5-5), at the cheapest capable
# model, and routed. The seeded-defect corpus shows the floor model does not
# raise the wrong-pass rate." (docs/LOKI-10-BUILD-PROMPT.md, section 2, item 4)
#
# Cases (IDs are permanent):
#   P4.catalog-has-top-model           providers/model_catalog.json lists
#                                      claude-opus-5-5 and the resolver returns
#                                      it for the top tier (and the opus alias)
#   P4.three-setups-resolve            top-only, floor-only and routed setups
#                                      dispatch the intended model id at every
#                                      RARV step, on the bash and Bun routes
#   P4.seeded-defect-corpus-present    >= 100 seeded defects across the five
#                                      categories exist at the agreed path, each
#                                      a runnable fixture (real files plus a
#                                      check command or expected verdict)
#   P4.floor-does-not-raise-wrong-pass a recorded measurement on that corpus,
#                                      with an outcome for every defect id,
#                                      shows wrong-pass(floor) <= wrong-pass(top)
#
# ---------------------------------------------------------------------------
# THE THREE SETUPS, AS SPELLED TODAY (P4.three-setups-resolve)
# ---------------------------------------------------------------------------
# Intended ids come from the catalog itself through the real resolver
# (loki_latest_model claude high|medium|small), so this case tests dispatch
# wiring, not catalog contents (P4.catalog-has-top-model does that). The
# dispatched value is a Claude CLI alias (opus/sonnet/haiku); the CLI resolves
# the alias itself, and the catalog's cli_aliases map is how Loki states what
# that alias means, so alias -> id goes through cli_aliases.
#
#   step    REASON  ACT  REFLECT  VERIFY   (RARV iterations 4,1,2,3)
#   top     high    high high     high
#   floor   small   small small   small
#   routed  high    medium medium small
#
# Pass bar: on EACH route, each setup must be delivered at every step by at
# least one documented spelling. A spelling that silently resolves to another
# model (for example small -> sonnet without LOKI_ALLOW_HAIKU) is a reported
# finding: it is named in the case line and on stderr, even on PASS.
# Documented spellings exercised:
#   T1 top     LOKI_SESSION_MODEL=high (generic vocabulary, "latest model in the class")
#   T2 top     LOKI_SESSION_MODEL=opus (vendor alias pin)
#   F1 floor   LOKI_SESSION_MODEL=small
#   F2 floor   LOKI_SESSION_MODEL=small LOKI_ALLOW_HAIKU=true
#   R1 routed  LOKI_LEGACY_TIER_SWITCHING=true plus per-tier
#              LOKI_CLAUDE_MODEL_PLANNING=opus _DEVELOPMENT=sonnet _FAST=haiku
# Bash route: the env above, fed through the REAL code: run.sh's top-level
# generic-tier block, its main-loop tier-selection block (extracted by marker
# and run verbatim), get_provider_tier_param and providers/claude.sh.
# Bun route: the session model goes through `--session-model` (parseStartArgs,
# the only surface the Bun runner reads for it), then getRarvTier, then the real
# claudeProvider().invoke with a stub CLI that records the --model it was given.
# The capability router is default-off and not enabled by any spelling here.
# Harness controls: T2 and F2 must deliver their setup on bash, and F2 on Bun,
# or the harness itself is broken and the case says so.
#
# ---------------------------------------------------------------------------
# ASSUMED CORPUS CONTRACT (P4.seeded-defect-corpus-present)
# ---------------------------------------------------------------------------
# Path: benchmarks/seeded-defects/manifest.json
#   {"schema": "loki.seeded-defects/v2",
#    "defects": [{"id": "SD-0001",
#                 "category": "logic-bug|spec-miss|test-fitting|mock-abuse|security",
#                 "dir": "cases/SD-0001",            (relative, inside the corpus dir)
#                 "files": ["src/calc.py", "tests/test_calc.py"],
#                                                    (relative to dir, the fixture itself)
#                 "expected_verdict": "NOT_SEALED",  (a seeded defect must never seal)
#                 "verdict_path": "deterministic|model",
#                 "check": "python3 -m pytest -q tests"}]}
#                                                    (required for deterministic)
# Rules: >= 100 defects, unique ids, every category present (each checked by
# name), expected_verdict NOT_SEALED, and every defect a runnable fixture: its
# dir exists inside the corpus, it names at least one file, every named file is
# a non-empty regular file whose real path stays inside its dir (no absolute
# path, no "..", no symlink out), a deterministic defect names its check
# command, and no two defects have byte-identical fixtures (one defect filed
# under two ids). An empty case dir is not a seeded defect.
#
# ASSUMED RESULTS CONTRACT (P4.floor-does-not-raise-wrong-pass)
# Path: benchmarks/seeded-defects/results/wrong-pass.json
#   {"schema": "loki.seeded-defects.results/v2",
#    "manifest_sha256": "<sha256 of the manifest bytes that were measured>",
#    "runs": [{"setup": "top",   "model": "claude-opus-5-5",
#              "outcomes": {"SD-0001": "NOT_SEALED", "SD-0002": "SEALED", ...}},
#             {"setup": "floor", "model": "claude-haiku-4-5",
#              "outcomes": {"SD-0001": "NOT_SEALED", ...}}]}
# Rules: the corpus is valid, the sha matches the CURRENT manifest (a stale
# measurement is not evidence), exactly one top and one floor run, each naming
# its model and carrying an outcome for EVERY defect id in the manifest and no
# other id, each outcome SEALED or NOT_SEALED. wrong_pass is derived as the
# count of SEALED outcomes (a seeded defect that seals is a wrong pass), never
# read from a summary; a run that also states n or wrong_pass must agree with
# its outcomes. Pass bar: floor wrong-pass <= top wrong-pass. A bare summary
# such as {"top": 0, "floor": 0} is not a measurement and fails.
#
# Contract (tests/moat): one "CASE <ID> PASS|FAIL <text>" stdout line per case,
# diagnostics on stderr, exit 0 whenever the script ran to completion. Hermetic:
# no model or network call; the only "claude" reachable is a stub.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
export LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true
export LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false PYTHONDONTWRITEBYTECODE=1

CATALOG="$REPO_ROOT/providers/model_catalog.json"
CORPUS_DIR="$REPO_ROOT/benchmarks/seeded-defects"
MANIFEST="$CORPUS_DIR/manifest.json"
RESULTS="$CORPUS_DIR/results/wrong-pass.json"
TOP_ID="claude-opus-5-5"

MOAT_TMP="$(mktemp -d)" || { echo "p4: mktemp failed" >&2; exit 1; }
MOAT_TMP="$(cd "$MOAT_TMP" && pwd -P)"
MOAT_MAIN_PID=$$
moat_cleanup() {
    [ "${BASHPID:-$$}" = "$MOAT_MAIN_PID" ] || return 0
    rm -rf -- "$MOAT_TMP"
}
trap moat_cleanup EXIT

diag() { printf 'p4: %s\n' "$*" >&2; }
# Strip every "$REPO_ROOT/" from a message. ${x//"pat"/} keeps the quotes on
# bash 3.2, so use prefix/suffix removal, which quotes the same on every bash.
rel() {
    local s="$1" r="$REPO_ROOT/"
    while [[ "$s" == *"$r"* ]]; do s="${s%%"$r"*}${s#*"$r"}"; done
    printf '%s' "$s"
}

# A stub `claude` first on PATH: nothing sourced below can reach the real CLI.
mkdir -p "$MOAT_TMP/bin" "$MOAT_TMP/work" "$MOAT_TMP/home"
cat > "$MOAT_TMP/bin/claude" <<'SH'
#!/bin/sh
[ "${1:-}" = "--help" ] && exit 0
[ -n "${MOAT_ARGV_OUT:-}" ] && printf '%s\n' "$@" > "$MOAT_ARGV_OUT"
exit 0
SH
chmod +x "$MOAT_TMP/bin/claude"

# Resolve a tier to an id with the REAL resolver against a given catalog.
latest_model() {  # $1 catalog  $2 tier
    env LOKI_MODEL_CATALOG="$1" bash -c '. "$1/providers/models.sh" && loki_latest_model claude "$2"' _ "$REPO_ROOT" "$2" 2>/dev/null
}
alias_id() {  # $1 catalog  $2 alias
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["providers"]["claude"].get("cli_aliases",{}).get(sys.argv[2],""))' "$1" "$2" 2>/dev/null
}

# ---------------------------------------------------------------------------
# P4.catalog-has-top-model
# ---------------------------------------------------------------------------
top_model_check() {  # $1 catalog; echoes a reason and returns 1 on failure
    local listed got al
    listed="$(python3 -c 'import json,sys; print(" ".join(m.get("id","") for m in json.load(open(sys.argv[1]))["providers"]["claude"]["models"]))' "$1" 2>/dev/null)" \
        || { echo "catalog unreadable"; return 1; }
    case " $listed " in *" $TOP_ID "*) ;; *) echo "$TOP_ID not in providers.claude.models[] (has: $listed)"; return 1 ;; esac
    got="$(latest_model "$1" high)"
    [ "$got" = "$TOP_ID" ] || { echo "loki_latest_model claude high returns '${got}', not $TOP_ID (first match wins)"; return 1; }
    al="$(alias_id "$1" opus)"
    [ "$al" = "$TOP_ID" ] || { echo "cli_aliases.opus is '${al}', not $TOP_ID, so the dispatched opus alias is not the top model"; return 1; }
    return 0
}

case_top_model() {
    command -v python3 >/dev/null 2>&1 || { echo "FAIL|prerequisite missing: python3"; return 0; }
    [ -f "$CATALOG" ] || { echo "FAIL|providers/model_catalog.json missing"; return 0; }
    local why good="$MOAT_TMP/cat-good.json" late="$MOAT_TMP/cat-late.json"
    # Positive control: the same check passes on a copy with the entry first,
    # and fails on a copy where it is listed AFTER claude-opus-5 (first match
    # wins, so presence alone must not pass).
    python3 - "$CATALOG" "$good" "$late" "$TOP_ID" <<'PY' || { echo "FAIL|could not build control catalogs"; return 0; }
import json, sys
src, good, late, top = sys.argv[1:5]
for path, first in ((good, True), (late, False)):
    d = json.load(open(src))
    c = d["providers"]["claude"]
    entry = {"id": top, "alias": "opus", "tier": "planning"}
    ms = [m for m in c["models"] if m.get("id") != top]
    idx = next((i for i, m in enumerate(ms) if m.get("tier") == "planning"), len(ms))
    ms.insert(idx if first else idx + 1, entry)
    c["models"] = ms
    c.setdefault("cli_aliases", {})["opus"] = top
    json.dump(d, open(path, "w"))
PY
    why="$(top_model_check "$good")" || { echo "FAIL|positive control failed on a catalog that lists $TOP_ID first: $why"; return 0; }
    top_model_check "$late" >/dev/null && { echo "FAIL|control: the check passed although $TOP_ID was listed after claude-opus-5"; return 0; }
    why="$(top_model_check "$CATALOG")" || { echo "FAIL|$why"; return 0; }
    echo "PASS|catalog lists $TOP_ID, loki_latest_model claude high and cli_aliases.opus both resolve to it"
}

# ---------------------------------------------------------------------------
# P4.three-setups-resolve
# ---------------------------------------------------------------------------
RUN_SH="$REPO_ROOT/autonomy/run.sh"

# Pull the real code out of run.sh by its markers. Any missing marker fails the
# case: a harness that silently ran nothing would report a clean dispatch.
extract_bash_harness() {
    local out="$MOAT_TMP/bash-dispatch.sh" f
    [ -f "$RUN_SH" ] || { echo "autonomy/run.sh missing"; return 1; }
    sed -n '/^_loki_generic_tier="\${LOKI_SESSION_MODEL:-}"$/,/^unset _loki_generic_tier$/p' "$RUN_SH" > "$MOAT_TMP/generic.sh"
    grep -q 'high) *LOKI_SESSION_MODEL="planning"' "$MOAT_TMP/generic.sh" || { echo "run.sh generic-tier block not found (marker drift)"; return 1; }
    : > "$MOAT_TMP/fns.sh"
    for f in get_rarv_tier get_rarv_phase_name get_provider_tier_param; do
        awk -v fn="$f" '$0 ~ "^" fn "\\(\\) \\{" {c=1} c {print} c && /^\}/ {exit}' "$RUN_SH" >> "$MOAT_TMP/fns.sh"
        grep -q "^$f() {" "$MOAT_TMP/fns.sh" || { echo "run.sh function $f not found"; return 1; }
    done
    awk '/^[[:space:]]*local _loki_session_pin_opus=0$/ {c=1} /echo "=== RARV Phase: \$rarv_phase, Tier:/ {exit} c {print}' "$RUN_SH" > "$MOAT_TMP/loop.body"
    if ! grep -q '_loki_session_pin_opus=1' "$MOAT_TMP/loop.body" \
        || ! grep -q 'tier_param=\$(get_provider_tier_param' "$MOAT_TMP/loop.body"; then
        echo "run.sh main-loop tier-selection block not found (marker drift)"; return 1
    fi
    {
        printf '%s\n' 'set -u' '. "$MOAT_REPO/providers/claude.sh" >/dev/null 2>&1' \
            'type resolve_model_for_tier >/dev/null 2>&1 || { echo "HARNESS-BROKEN claude.sh did not load"; exit 3; }'
        cat "$MOAT_TMP/generic.sh" "$MOAT_TMP/fns.sh"
        printf '%s\n' 'log_info() { :; }' 'log_warn() { :; }' 'emit_model_substituted() { :; }' \
            'loki_apply_tier_harness_policy() { :; }' 'log_file=/dev/null; agent_log=/dev/null'
        printf '%s\n' '_moat_dispatch() {'
        cat "$MOAT_TMP/loop.body"
        printf '%s\n' '    printf "%s\n" "$tier_param"' '}'
        printf '%s\n' 'cd "$MOAT_WORK" || exit 1' \
            'for s in REASON:4 ACT:1 REFLECT:2 VERIFY:3; do ITERATION_COUNT="${s#*:}"; printf "%s=%s\n" "${s%%:*}" "$(_moat_dispatch)"; done'
    } > "$out"
    bash -n "$out" 2>/dev/null || { echo "extracted bash harness does not parse"; return 1; }
    return 0
}

# Spellings: name|setup|session|env (space-separated KEY=VALUE)
SPELLINGS='T1-high|top|high|
T2-opus|top|opus|
F1-small|floor|small|
F2-small-allow-haiku|floor|small|LOKI_ALLOW_HAIKU=true
R1-legacy-per-tier|routed||LOKI_LEGACY_TIER_SWITCHING=true LOKI_CLAUDE_MODEL_PLANNING=opus LOKI_CLAUDE_MODEL_DEVELOPMENT=sonnet LOKI_CLAUDE_MODEL_FAST=haiku'

run_bash_route() {  # writes name STEP=alias lines to $1
    local out="$1" name setup session envs line
    : > "$out"
    while IFS='|' read -r name setup session envs; do
        [ -n "$name" ] || continue
        # shellcheck disable=SC2086
        line="$(env -i HOME="$MOAT_TMP/home" PATH="$MOAT_TMP/bin:$PATH" MOAT_REPO="$REPO_ROOT" MOAT_WORK="$MOAT_TMP/work" \
            ${session:+LOKI_SESSION_MODEL=$session} $envs bash "$MOAT_TMP/bash-dispatch.sh" 2>/dev/null | tr '\n' ' ')"
        printf '%s %s\n' "$name" "$line" >> "$out"
    done <<< "$SPELLINGS"
}

run_bun_route() {  # writes name STEP=model lines (or REJECTED) to $1
    local out="$1"
    cat > "$MOAT_TMP/bun-dispatch.ts" <<'TS'
import * as fs from "node:fs";
const repo = process.env.MOAT_REPO!, work = process.env.MOAT_WORK!, argvFile = process.env.MOAT_ARGV_OUT!;
const { claudeProvider } = await import(`${repo}/loki-ts/src/runner/providers.ts`);
const { getRarvTier } = await import(`${repo}/loki-ts/src/runner/rarv.ts`);
const { parseStartArgs } = await import(`${repo}/loki-ts/src/commands/start.ts`);
const KEYS = ["LOKI_SESSION_MODEL", "LOKI_ALLOW_HAIKU", "LOKI_LEGACY_TIER_SWITCHING", "LOKI_CLAUDE_MODEL_PLANNING",
  "LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_CLAUDE_MODEL_FAST", "LOKI_MODEL_PLANNING", "LOKI_MODEL_DEVELOPMENT",
  "LOKI_MODEL_FAST", "LOKI_MAX_TIER", "LOKI_TIER_ROUTING", "ANTHROPIC_BASE_URL", "LOKI_MODEL_OVERRIDE", "LOKI_CAPABILITY_ROUTER"];
const lines: string[] = [];
for (const row of fs.readFileSync(process.argv[2], "utf8").split("\n")) {
  if (!row.trim()) continue;
  const [name, , session, envs] = row.split("|");
  for (const k of KEYS) delete process.env[k];
  for (const kv of (envs || "").split(" ").filter(Boolean)) { const i = kv.indexOf("="); process.env[kv.slice(0, i)] = kv.slice(i + 1); }
  let sessionModel: string | undefined;
  if (session) {
    const parsed = parseStartArgs(["moat-spec.md", "--session-model", session], () => {}, () => {}, (k: string, v: string) => { process.env[k] = v; });
    if (typeof parsed === "number") { lines.push(`${name} REJECTED(rc=${parsed})`); continue; }
    sessionModel = parsed.sessionModel;
  }
  const ctxSession = sessionModel ?? "sonnet"; // autonomous.ts runner default
  const got: string[] = [];
  for (const [label, it] of [["REASON", 4], ["ACT", 1], ["REFLECT", 2], ["VERIFY", 3]] as const) {
    const tier = getRarvTier(it, { sessionModel: ctxSession });
    fs.rmSync(argvFile, { force: true });
    await claudeProvider().invoke({ provider: "claude", prompt: "moat", tier, cwd: work,
      iterationOutputPath: `${work}/out.txt`, mainLoop: true });
    const argv = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, "utf8").split("\n") : [];
    const i = argv.indexOf("--model");
    got.push(`${label}=${i >= 0 ? argv[i + 1] : "NO-MODEL"}`);
  }
  lines.push(`${name} ${got.join(" ")}`);
}
console.log(lines.join("\n"));
TS
    printf '%s\n' "$SPELLINGS" > "$MOAT_TMP/spellings.txt"
    ( cd "$MOAT_TMP/work" && env HOME="$MOAT_TMP/home" PATH="$MOAT_TMP/bin:$PATH" LOKI_CLAUDE_CLI="$MOAT_TMP/bin/claude" \
        MOAT_REPO="$REPO_ROOT" MOAT_WORK="$MOAT_TMP/work" MOAT_ARGV_OUT="$MOAT_TMP/argv.txt" \
        bun run "$MOAT_TMP/bun-dispatch.ts" "$MOAT_TMP/spellings.txt" ) > "$out" 2> "$MOAT_TMP/bun.err"
}

# Compare one route's output with the intended ids. Echo mismatching spelling
# names; per-step detail goes to stderr.
grade_route() {  # $1 route  $2 output file  $3 top  $4 mid  $5 floor
    local route="$1" out="$2" name setup session envs row want step got id bad="" miss
    while IFS='|' read -r name setup session envs; do
        [ -n "$name" ] || continue
        row="$(grep "^$name " "$out" | head -n 1)"
        miss=""
        if [ -z "$row" ] || [[ "$row" == *REJECTED* ]]; then
            miss="${row#"$name "}"; [ -n "$miss" ] || miss="no output"
            diag "$route $name ($setup): ${miss}"
        else
            for step in REASON ACT REFLECT VERIFY; do
                case "$setup:$step" in
                    top:*|routed:REASON) want="$3" ;;
                    floor:*|routed:VERIFY) want="$5" ;;
                    *) want="$4" ;;
                esac
                got="$(printf '%s\n' "$row" | tr ' ' '\n' | sed -n "s/^$step=//p")"
                id="$(alias_id "$CATALOG" "$got")"; [ -n "$id" ] || id="$got"
                if [ "$id" != "$want" ]; then
                    miss="$miss $step=$id"
                    diag "$route $name ($setup) $step: got $got ($id) want $want"
                fi
            done
        fi
        [ -z "$miss" ] || bad="$bad $name"
    done <<< "$SPELLINGS"
    printf '%s\n' "${bad# }"
}

case_three_setups() {
    command -v python3 >/dev/null 2>&1 || { echo "FAIL|prerequisite missing: python3"; return 0; }
    command -v bun >/dev/null 2>&1 || { echo "FAIL|prerequisite missing: bun (Bun route cannot be measured)"; return 0; }
    local why top mid floor bash_bad bun_bad
    top="$(latest_model "$CATALOG" high)"; mid="$(latest_model "$CATALOG" medium)"; floor="$(latest_model "$CATALOG" small)"
    [ -n "$top" ] && [ -n "$mid" ] && [ -n "$floor" ] || { echo "FAIL|catalog did not resolve high/medium/small (got '$top' '$mid' '$floor')"; return 0; }
    [ "$top" != "$floor" ] || { echo "FAIL|catalog resolves top and floor to the same model ($top); setups are indistinguishable"; return 0; }
    diag "intended ids: top=$top mid=$mid floor=$floor"
    why="$(extract_bash_harness)" || { echo "FAIL|$why"; return 0; }

    run_bash_route "$MOAT_TMP/bash.out"
    sed 's/^/  bash /' "$MOAT_TMP/bash.out" >&2
    run_bun_route "$MOAT_TMP/bun.out" || { echo "FAIL|Bun harness crashed: $(tail -c 200 "$MOAT_TMP/bun.err" | tr '\n' ' ')"; return 0; }
    sed 's/^/  bun  /' "$MOAT_TMP/bun.out" >&2

    bash_bad="$(grade_route bash "$MOAT_TMP/bash.out" "$top" "$mid" "$floor")"
    bun_bad="$(grade_route bun "$MOAT_TMP/bun.out" "$top" "$mid" "$floor")"
    # Harness controls: a spelling each route is known to honor must pass, or a
    # mismatch below could be the harness and not the product.
    case " $bash_bad " in *" T2-opus "*|*" F2-small-allow-haiku "*)
        echo "FAIL|bash harness control failed: LOKI_SESSION_MODEL=opus or small+LOKI_ALLOW_HAIKU=true did not dispatch its setup"; return 0 ;; esac
    case " $bun_bad " in *" F2-small-allow-haiku "*) echo "FAIL|Bun harness control failed: --session-model small + LOKI_ALLOW_HAIKU=true did not dispatch $floor at every step"; return 0 ;; esac
    local bash_missing bun_missing silent
    bash_missing="$(setups_without_spelling "$bash_bad")"
    bun_missing="$(setups_without_spelling "$bun_bad")"
    silent="bash[${bash_bad:-none}] bun[${bun_bad:-none}]"
    if [ -z "$bash_missing" ] && [ -z "$bun_missing" ]; then
        echo "PASS|every setup has a working documented spelling on both routes (top=$top mid=$mid floor=$floor); spellings that still mis-resolve silently: $silent"
    else
        echo "FAIL|no working documented spelling for: bash[${bash_missing:-none}] bun[${bun_missing:-none}]; spellings that mis-resolve silently: $silent (per-step detail on stderr)"
    fi
}

# The pass bar: each setup needs at least one documented spelling that delivers
# it at every step, on each route. A spelling that silently mis-resolves while
# another spelling works is reported (stderr, reason) but does not fail the
# case on its own. Echo the setups with no working spelling.
setups_without_spelling() {  # $1 space-separated failing spelling names
    local setup name s ok missing=""
    for setup in top floor routed; do
        ok=""
        while IFS='|' read -r name s _; do
            [ "$s" = "$setup" ] || continue
            case " $1 " in *" $name "*) ;; *) ok=1 ;; esac
        done <<< "$SPELLINGS"
        [ -n "$ok" ] || missing="$missing $setup"
    done
    printf '%s\n' "${missing# }"
}

# ---------------------------------------------------------------------------
# Corpus and results checkers (P4.seeded-defect-corpus-present, P4.floor-...)
# ---------------------------------------------------------------------------
cat > "$MOAT_TMP/corpus.py" <<'PY'
import hashlib, json, os, sys
CATS = ["logic-bug", "spec-miss", "test-fitting", "mock-abuse", "security"]
MANIFEST_SCHEMA = "loki.seeded-defects/v2"
RESULTS_SCHEMA = "loki.seeded-defects.results/v2"
OUTCOMES = ("SEALED", "NOT_SEALED")

def inside(path, root):
    path, root = os.path.realpath(path), os.path.realpath(root)
    return path != root and os.path.commonpath([path, root]) == root

def fixture(root, x):
    """Validate one defect's fixture. Returns (reason, None) or (None, fingerprint)."""
    did, rel = x["id"], x.get("dir")
    if not isinstance(rel, str) or not rel or os.path.isabs(rel):
        return f"{did}: dir must be a relative path inside the corpus", None
    case = os.path.join(root, rel)
    if not inside(case, root) or not os.path.isdir(case):
        return f"{did}: case dir {rel!r} missing or outside the corpus", None
    files = x.get("files")
    if not isinstance(files, list) or not files:
        return f"{did}: names no fixture files (an empty case dir is not a seeded defect)", None
    for f in files:
        if not isinstance(f, str) or not f or os.path.isabs(f) or ".." in f.replace("\\", "/").split("/"):
            return f"{did}: fixture path must be relative to its case dir, without dot-dot segments: {f}", None
        p = os.path.join(case, f)
        if not inside(p, case):
            return f"{did}: fixture {f!r} resolves outside its case dir", None
        if not os.path.isfile(p):
            return f"{did}: fixture file {f!r} is not a regular file", None
        if os.path.getsize(p) == 0:
            return f"{did}: fixture file {f!r} is empty", None
    h = hashlib.sha256()
    for f in sorted(set(files)):
        h.update(f.encode() + b"\0" + hashlib.sha256(open(os.path.join(case, f), "rb").read()).digest())
    return None, h.hexdigest()

def load_defects(manifest):
    d = json.load(open(manifest))
    return d.get("defects") if isinstance(d, dict) else None

def corpus(manifest):
    if not os.path.isfile(manifest):
        return f"no corpus manifest at {manifest}"
    try:
        d = json.load(open(manifest))
    except Exception as e:
        return f"manifest unreadable: {e}"
    if not isinstance(d, dict) or d.get("schema") != MANIFEST_SCHEMA:
        return f"manifest schema is {d.get('schema') if isinstance(d, dict) else None!r}, want {MANIFEST_SCHEMA!r}"
    defects = d.get("defects")
    if not isinstance(defects, list) or not all(isinstance(x, dict) for x in defects):
        return "defects must be a list of objects"
    ids = [x.get("id") for x in defects]
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        return "defect ids missing or not unique"
    root = os.path.dirname(os.path.abspath(manifest))
    counts = {c: 0 for c in CATS}
    seen = {}
    for x in defects:
        did = x["id"]
        if x.get("category") not in counts:
            return f"{did}: unknown category {x.get('category')!r}"
        counts[x["category"]] += 1
        if x.get("expected_verdict") != "NOT_SEALED":
            return f"{did}: expected_verdict must be NOT_SEALED"
        path = x.get("verdict_path")
        if path not in ("deterministic", "model"):
            return f"{did}: verdict_path must be deterministic or model"
        check = x.get("check")
        if check is not None and not (isinstance(check, str) and check.strip()):
            return f"{did}: check must be a non-empty command string"
        if path == "deterministic" and check is None:
            return f"{did}: a deterministic defect must name its check command"
        why, fp = fixture(root, x)
        if why:
            return why
        if fp in seen:
            return f"{did}: fixture is byte-identical to {seen[fp]} (one defect filed under two ids)"
        seen[fp] = did
    empty = [c for c in CATS if counts[c] == 0]
    if empty:
        return "categories with no defects: " + ", ".join(empty)
    if len(defects) < 100:
        return f"only {len(defects)} defects, need >= 100"
    return None

def results(manifest, res):
    why = corpus(manifest)
    if why:
        return "corpus invalid: " + why
    if not os.path.isfile(res):
        return f"no recorded measurement at {res}"
    try:
        r = json.load(open(res))
    except Exception as e:
        return f"results unreadable: {e}"
    if not isinstance(r, dict) or r.get("schema") != RESULTS_SCHEMA:
        return f"results schema is {r.get('schema') if isinstance(r, dict) else None!r}, want {RESULTS_SCHEMA!r}"
    sha = hashlib.sha256(open(manifest, "rb").read()).hexdigest()
    if r.get("manifest_sha256") != sha:
        return "results were measured on a different manifest (sha mismatch); stale measurement"
    ids = {x["id"] for x in load_defects(manifest)}
    n = len(ids)
    runs = {}
    if not isinstance(r.get("runs"), list) or not all(isinstance(x, dict) for x in r["runs"]):
        return "runs must be a list of objects"
    for run in r["runs"]:
        runs.setdefault(run.get("setup"), []).append(run)
    got = {}
    for setup in ("top", "floor"):
        rs = runs.get(setup) or []
        if len(rs) != 1:
            return f"need exactly one {setup} run, found {len(rs)}"
        run = rs[0]
        if not (isinstance(run.get("model"), str) and run["model"].strip()):
            return f"{setup} run names no model"
        oc = run.get("outcomes")
        if not isinstance(oc, dict) or not oc:
            return f"{setup} run has no per-defect outcomes keyed by defect id (a summary count is not a measurement)"
        missing, extra = sorted(ids - set(oc)), sorted(set(oc) - ids)
        if missing:
            return f"{setup} run has no outcome for {len(missing)} defect(s), first {missing[0]}"
        if extra:
            return f"{setup} run has outcomes for {len(extra)} id(s) not in the manifest, first {extra[0]}"
        odd = sorted(k for k, v in oc.items() if v not in OUTCOMES)
        if odd:
            return f"{setup} run outcome for {odd[0]} is {oc[odd[0]]!r}, want SEALED or NOT_SEALED"
        wp = sum(1 for v in oc.values() if v == "SEALED")
        for key, want in (("n", n), ("wrong_pass", wp)):
            if key in run and run[key] != want:
                return f"{setup} run states {key}={run[key]!r} but its outcomes give {want}"
        got[setup] = wp
    if got["floor"] > got["top"]:
        return f"floor wrong-pass {got['floor']}/{n} exceeds top {got['top']}/{n}"
    return f"OK floor {got['floor']}/{n} <= top {got['top']}/{n}"

if __name__ == "__main__":
    out = corpus(sys.argv[2]) if sys.argv[1] == "corpus" else results(sys.argv[2], sys.argv[3])
    if out is None or out.startswith("OK"):
        print(out or "OK"); sys.exit(0)
    print(out); sys.exit(1)
PY

# Synthetic corpora and results for the positive controls: one valid corpus
# ("good") plus one variant per rejection rule, and one valid results file
# ("ok") plus one variant per results rule. Every variant differs from the
# valid one by a single mutation, so it can only be rejected by its own rule.
cat > "$MOAT_TMP/controls.py" <<'PY'
import hashlib, json, os, shutil, sys
CATS = ["logic-bug", "spec-miss", "test-fitting", "mock-abuse", "security"]

def corpus(d, n=100, cats=CATS, mutate=None):
    os.makedirs(d)
    defects = []
    for i in range(n):
        did, rel = f"SD-{i:04d}", f"cases/SD-{i:04d}"
        case = os.path.join(d, rel)
        os.makedirs(case)
        open(os.path.join(case, "calc.py"), "w").write(f"def add(a, b):\n    return a - b + {i}  # seeded {did}\n")
        open(os.path.join(case, "check.sh"), "w").write("python3 -c 'import calc; assert calc.add(2, 2) == 4'\n")
        defects.append({"id": did, "category": cats[i % len(cats)], "dir": rel, "files": ["calc.py", "check.sh"],
                        "expected_verdict": "NOT_SEALED", "verdict_path": "deterministic", "check": "sh check.sh"})
    if mutate:
        mutate(d, defects)
    json.dump({"schema": "loki.seeded-defects/v2", "defects": defects}, open(os.path.join(d, "manifest.json"), "w"))

def empty_dirs(d, ds):
    for x in ds:
        shutil.rmtree(os.path.join(d, x["dir"])); os.makedirs(os.path.join(d, x["dir"])); del x["files"]
def missing_file(d, ds): ds[0]["files"].append("absent.py")
def empty_file(d, ds): open(os.path.join(d, ds[0]["dir"], "calc.py"), "w").close()
def dotdot(d, ds): ds[0]["files"] = ["../../manifest.json"]
def absolute(d, ds): ds[0]["files"] = [os.path.join(os.path.abspath(d), "manifest.json")]
def symlink(d, ds):
    os.symlink("../../manifest.json", os.path.join(d, ds[0]["dir"], "link.txt")); ds[0]["files"] = ["link.txt"]
def no_check(d, ds): del ds[0]["check"]
def dup_fixture(d, ds):
    shutil.copy(os.path.join(d, ds[0]["dir"], "calc.py"), os.path.join(d, ds[1]["dir"], "calc.py"))
def dir_escape(d, ds):
    out = d + "-outside"
    shutil.copytree(os.path.join(d, ds[0]["dir"]), out); ds[0]["dir"] = "../" + os.path.basename(out)
def bad_category(d, ds): ds[0]["category"] = "style-nit"

def results(manifest, out):
    raw = open(manifest, "rb").read()
    sha, ids = hashlib.sha256(raw).hexdigest(), [x["id"] for x in json.loads(raw)["defects"]]
    def run(setup, sealed, **kw):
        r = {"setup": setup, "model": setup + "-model",
             "outcomes": {i: ("SEALED" if k < sealed else "NOT_SEALED") for k, i in enumerate(ids)}}
        r.update(kw)
        return r
    def doc(runs, digest=sha):
        return {"schema": "loki.seeded-defects.results/v2", "manifest_sha256": digest, "runs": runs}
    missing = run("top", 1); del missing["outcomes"][ids[0]]
    extra = run("floor", 0); extra["outcomes"]["SD-9999"] = "NOT_SEALED"
    odd = run("floor", 0); odd["outcomes"][ids[-1]] = "ERROR"
    variants = {
        "ok": doc([run("top", 1), run("floor", 0)]),
        "worse": doc([run("top", 1), run("floor", 2)]),
        "stale": doc([run("top", 0), run("floor", 0)], "0" * 64),
        "bare": {"top": 0, "floor": 0},
        "summary-only": doc([{"setup": "top", "model": "t", "n": len(ids), "wrong_pass": 0},
                             {"setup": "floor", "model": "f", "n": len(ids), "wrong_pass": 0}]),
        "missing-id": doc([missing, run("floor", 0)]),
        "extra-id": doc([run("top", 1), extra]),
        "bad-value": doc([run("top", 1), odd]),
        "disagree": doc([run("top", 2), run("floor", 1, wrong_pass=0)]),
        "one-run": doc([run("top", 0)]),
        "no-model": doc([run("top", 1), run("floor", 0, model="")]),
    }
    os.makedirs(out)
    for name, body in variants.items():
        json.dump(body, open(os.path.join(out, name + ".json"), "w"))

if __name__ == "__main__":
    c = sys.argv[1]
    corpus(f"{c}/good")
    corpus(f"{c}/small", n=99)
    corpus(f"{c}/nocat", cats=CATS[:4])
    for name, fn in (("empty-dirs", empty_dirs), ("missing-file", missing_file), ("empty-file", empty_file),
                     ("dotdot", dotdot), ("absolute", absolute), ("symlink", symlink), ("no-check", no_check),
                     ("dup-fixture", dup_fixture), ("dir-escape", dir_escape), ("bad-category", bad_category)):
        corpus(f"{c}/{name}", mutate=fn)
    results(f"{c}/good/manifest.json", f"{c}/results")
PY

# name|substring the rejection reason must contain. Checking the reason, not
# only the exit code, keeps a control from passing because some OTHER rule
# happened to reject its variant.
CORPUS_REJECTS='small|only 99 defects
nocat|categories with no defects: security
empty-dirs|names no fixture files
missing-file|is not a regular file
empty-file|is empty
dotdot|without dot-dot segments: ../../manifest.json
absolute|without dot-dot segments: /
symlink|resolves outside its case dir
no-check|must name its check command
dup-fixture|byte-identical to SD-0000
dir-escape|outside the corpus
bad-category|unknown category'
RESULTS_REJECTS='worse|exceeds top
stale|stale measurement
bare|results schema is None
summary-only|no per-defect outcomes
missing-id|no outcome for 1 defect
extra-id|not in the manifest, first SD-9999
bad-value|want SEALED or NOT_SEALED
disagree|states wrong_pass=0 but its outcomes give 1
one-run|need exactly one floor run
no-model|floor run names no model'

build_controls() {
    local c="$MOAT_TMP/ctl"
    [ -e "$c/.built" ] && return 0
    rm -rf "$c" && mkdir -p "$c" && python3 "$MOAT_TMP/controls.py" "$c" && : > "$c/.built"
}

# check_rejects MODE TABLE [RESULTS_DIR]: every variant in TABLE must be
# rejected, for its own reason. Echo the first control that misbehaved.
check_rejects() {
    local mode="$1" table="$2" c="$MOAT_TMP/ctl" name want why
    while IFS='|' read -r name want; do
        [ -n "$name" ] || continue
        if [ "$mode" = corpus ]; then
            why="$(python3 "$MOAT_TMP/corpus.py" corpus "$c/$name/manifest.json")"
        else
            why="$(python3 "$MOAT_TMP/corpus.py" results "$c/good/manifest.json" "$c/results/$name.json")"
        fi && { echo "control $mode '$name' was accepted"; return 1; }
        case "$why" in *"$want"*) ;; *) echo "control $mode '$name' was rejected for the wrong reason: $why"; return 1 ;; esac
    done <<< "$table"
    return 0
}

corpus_controls() {
    local why
    build_controls || { echo "could not build control corpora"; return 1; }
    why="$(python3 "$MOAT_TMP/corpus.py" corpus "$MOAT_TMP/ctl/good/manifest.json")" \
        || { echo "a valid 100-defect corpus was rejected: $why"; return 1; }
    check_rejects corpus "$CORPUS_REJECTS"
}

case_corpus() {
    command -v python3 >/dev/null 2>&1 || { echo "FAIL|prerequisite missing: python3"; return 0; }
    local why
    why="$(corpus_controls)" || { echo "FAIL|positive control failed: $why"; return 0; }
    why="$(python3 "$MOAT_TMP/corpus.py" corpus "$MANIFEST")" || { echo "FAIL|$(rel "$why")"; return 0; }
    echo "PASS|$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["defects"]))' "$MANIFEST") runnable seeded defects across all five categories"
}

case_floor_wrong_pass() {
    command -v python3 >/dev/null 2>&1 || { echo "FAIL|prerequisite missing: python3"; return 0; }
    local why
    why="$(corpus_controls)" || { echo "FAIL|positive control failed: $why"; return 0; }
    why="$(python3 "$MOAT_TMP/corpus.py" results "$MOAT_TMP/ctl/good/manifest.json" "$MOAT_TMP/ctl/results/ok.json")" \
        || { echo "FAIL|control: valid per-defect results with floor <= top were rejected: $why"; return 0; }
    why="$(check_rejects results "$RESULTS_REJECTS")" || { echo "FAIL|positive control failed: $why"; return 0; }
    why="$(python3 "$MOAT_TMP/corpus.py" results "$MANIFEST" "$RESULTS")" || { echo "FAIL|$(rel "$why")"; return 0; }
    echo "PASS|$why"
}

# ---------------------------------------------------------------------------
# Runner: exactly one CASE line per case, even when a case function dies.
# ---------------------------------------------------------------------------
EMITTED=""
run_case() {
    local id="$1" desc="$2" fn="$3" out rc status reason
    rc=0
    out="$("$fn")" || rc=$?
    out="${out##*$'\n'}"
    status="${out%%|*}"
    reason="${out#*|}"
    case "$status" in
        PASS|FAIL) ;;
        *) status=FAIL; reason="case crashed (rc=$rc, last output: ${out:0:120})" ;;
    esac
    # A function that printed PASS and then failed has not passed.
    if [ "$status" = PASS ] && [ "$rc" -ne 0 ]; then status=FAIL; reason="printed PASS but exited $rc: $reason"; fi
    reason="$(printf '%s' "$reason" | tr '\n\r' '  ')"
    if [ "$status" = PASS ]; then
        printf 'CASE %s PASS %s (%s)\n' "$id" "$desc" "$reason"
    else
        printf 'CASE %s FAIL %s: %s\n' "$id" "$desc" "$reason"
    fi
    EMITTED="$EMITTED $id"
}

START_S=$SECONDS
run_case P4.catalog-has-top-model "catalog lists $TOP_ID and the top tier resolves to it" case_top_model
run_case P4.three-setups-resolve "top-only, floor-only and routed setups dispatch the intended ids per step" case_three_setups
run_case P4.seeded-defect-corpus-present "seeded-defect corpus of >= 100 runnable defects in five categories" case_corpus
run_case P4.floor-does-not-raise-wrong-pass "per-defect measured wrong-pass rate at floor <= top on the corpus" case_floor_wrong_pass

for id in P4.catalog-has-top-model P4.three-setups-resolve P4.seeded-defect-corpus-present P4.floor-does-not-raise-wrong-pass; do
    case " $EMITTED " in *" $id "*) ;; *) printf 'CASE %s FAIL runner did not emit this case\n' "$id" ;; esac
done
diag "runtime $((SECONDS - START_S))s"
exit 0
