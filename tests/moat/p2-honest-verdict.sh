#!/usr/bin/env bash
# Moat property P2: Honest verdict.
#
# A model-only "looks good" can never produce a pass, and unknown, unreadable or
# unmeasured evidence never produces a pass. Verifier exit contract:
#   0 passed  1 failed  2 could not check  3 nothing to check
#   20 durable no-retry  64 usage  66 input missing
#
# Output: exactly one "CASE <ID> PASS|FAIL <description>" line per case on
# stdout. Everything else goes to stderr. Exit 0 whenever the script ran to
# completion, whatever the case results. A missing prerequisite is a FAIL,
# never a skip. Every "absent/rejected" assertion carries a positive control so
# the probe cannot pass vacuously.
#
# Hermetic: no network, no model or API call. The one LLM reviewer consulted
# (P2.model-looks-good-cannot-pass) is a PATH stub that answers
# `loki internal sdk-judge` with a canned "looks good".
#
# Case bodies are called through run_case and the council stubs are called by
# the sourced library, so shellcheck cannot see their callers.
# shellcheck disable=SC2329
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
LOKI_SHIM="$REPO_ROOT/bin/loki"
GEN="$REPO_ROOT/autonomy/lib/proof-generator.py"
PV="$REPO_ROOT/autonomy/lib/proof-verify.py"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"
T_START="$(date +%s)"

RUN="$(mktemp -d "${TMPDIR:-/tmp}/moat-p2.XXXXXX")" || { echo "moat-p2: cannot create temp dir" >&2; exit 1; }
RUN="$(cd "$RUN" && pwd -P)"
trap 'rm -rf "$RUN"' EXIT
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/stub"

export LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true
export LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false
export HOME="$RUN/home" TMPDIR="$RUN/tmp" PYTHONDONTWRITEBYTECODE=1
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0
export NO_UPDATE_NOTIFIER=1 npm_config_update_notifier=false npm_config_offline=true
export npm_config_audit=false npm_config_fund=false npm_config_cache="$RUN/npm-cache"
# Model-free by construction: no key reaches any child, even by accident.
unset ANTHROPIC_API_KEY OPENAI_API_KEY 2>/dev/null || true

# The only "reviewer" any case can reach. Anything but the judge call fails.
cat > "$RUN/stub/loki" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "internal" ] && [ "${2:-}" = "sdk-judge" ]; then
    printf '%s\n' '{"summary":"looks good to me, ship it","findings":[]}'
    exit 0
fi
exit 97
EOF
chmod +x "$RUN/stub/loki"

# --- harness ------------------------------------------------------------------
_st="FAIL"; _why=""
run_case() { # <id> <description> <function>
    local id="$1" desc="$2" fn="$3"
    _st="FAIL"; _why="case body did not reach a verdict"
    "$fn"
    if [ "$_st" = "PASS" ]; then
        printf 'CASE %s PASS %s\n' "$id" "$desc"
    else
        printf 'CASE %s FAIL %s: %s\n' "$id" "$desc" "$_why"
    fi
}
need() { # <tool>... ; sets _why and returns 1 on the first missing one
    local b
    for b in "$@"; do
        command -v "$b" >/dev/null 2>&1 || { _why="prerequisite missing: $b"; return 1; }
    done
}
g() { local d="$1"; shift; git -C "$d" -c user.email=moat@loki.local -c user.name=moat -c commit.gpgsign=false "$@"; }
new_repo() { # <dir> : one committed file
    mkdir -p "$1" && git init -q "$1" 2>/dev/null && printf 'seed\n' > "$1/seed.txt" \
        && g "$1" add seed.txt && g "$1" commit -qm seed
}
# Run the CLI on one route. Usage: loki_route bun|bash <args...>
loki_route() {
    local route="$1"; shift
    if [ "$route" = "bash" ]; then LOKI_LEGACY_BASH=1 bash "$LOKI_SHIM" "$@"; else bash "$LOKI_SHIM" "$@"; fi
}

# Receipt that every axis can genuinely check (mirrors tests/test_verify_chain.py
# _receipt): headline from the verifier's own rule, hash over the canonical form.
write_receipt() { # <out proof.json> <repo> [usd]
    mkdir -p "$(dirname "$1")"
    python3 - "$1" "$2" "${3:-0.42}" "$PV" <<'PY'
import hashlib, importlib.util, json, subprocess, sys
out, repo, usd, pv_path = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
spec = importlib.util.spec_from_file_location("pv", pv_path)
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)
head = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"],
                      capture_output=True, text=True).stdout.strip()
facts = {"git": {"base_sha": head, "head_sha": head,
                 "diff": {"count": 0, "insertions": 0, "deletions": 0}},
         "tests": {"status": "verified", "command": "pytest -q", "exit_code": 0},
         "execution": {"outcome": "complete", "exit_code": 0}}
proof = {"schema_version": "1.1", "facts": facts,
         "honesty": {"headline": pv._compute_headline(facts, []), "degraded": []},
         "cost": {"available": True, "usd": usd, "input_tokens": 1000,
                  "output_tokens": 50, "cache_read_tokens": 0,
                  "cache_creation_tokens": 0}}
proof["verification"] = {"hash": hashlib.sha256(pv._canonical(proof).encode()).hexdigest()}
with open(out, "w") as fh:
    json.dump(proof, fh, indent=2)
PY
}
# Workspace whose receipt passes every chain stage (the positive control of
# tests/test_verify_chain.py): measured cost, optional policy, all committed
# before the receipt is written. Usage: chain_ws <dir> <policy-json|"">
chain_ws() {
    new_repo "$1" || return 1
    mkdir -p "$1/.loki/metrics/efficiency"
    printf '%s\n' '{"iteration":1,"input_tokens":1000,"output_tokens":50,"cache_read_tokens":0,"cache_creation_tokens":0,"cost_usd":0.42,"model":"x","duration_ms":1000,"status":"completed"}' \
        > "$1/.loki/metrics/efficiency/iteration-1.json"
    [ -n "$2" ] && printf '%s' "$2" > "$1/.loki-policy.json"
    g "$1" add -A && g "$1" commit -qm fixture || return 1
    write_receipt "$1/.loki/proofs/r1/proof.json" "$1"
}

# Drive the REAL receipt generator, then re-derive the headline with the
# verifier's mirrored rule. Prints "<generator headline>|<verifier headline>",
# plus "|<degraded items>" when a fourth argument "ledger" is given.
# Usage: gen_headlines <name> <quality-gates-json> <with-tests yes|no> [ledger]
gen_headlines() {
    local d="$RUN/gen/$1"
    new_repo "$d" >/dev/null 2>&1 || { echo "FIXTURE|FIXTURE"; return; }
    printf 'change\n' >> "$d/seed.txt"; g "$d" commit -qam change
    mkdir -p "$d/.loki/state" "$d/.loki/quality"
    printf '%s' "$2" > "$d/.loki/state/quality-gates.json"
    if [ "$3" = "yes" ]; then # the deterministic facts a VERIFIED headline needs
        printf '%s' '{"status":"verified","command":"npm test","exit_code":0}' > "$d/.loki/quality/test-results.json"
        printf '%s' '{"command":"npm run build","exit_code":0,"ran":true}' > "$d/.loki/quality/build-results.json"
    fi
    (cd "$d" && python3 "$GEN" --loki-dir "$d/.loki" --out-dir "$d/out" --quiet) >/dev/null 2>&1
    python3 - "$d/out/proof.json" "$PV" "${4:-}" <<'PY' 2>/dev/null || echo "NOPROOF|NOPROOF"
import importlib.util, json, sys
p = json.load(open(sys.argv[1]))
spec = importlib.util.spec_from_file_location("pv", sys.argv[2])
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)
h = p.get("honesty") or {}
deg = h.get("degraded") or []
line = "%s|%s" % (h.get("headline"), pv._compute_headline(p.get("facts") or {}, deg))
if sys.argv[3] == "ledger":
    line += "|" + ",".join(str(x.get("item")) for x in deg)
print(line)
PY
}

# Call one completion-council function in a subshell with the real library
# sourced, inside <repo>. The council's vote is stubbed to "2 of 3 COMPLETE"
# (quorum present, not unanimous, so the devil's advocate does not run): that is
# "a council vote alone". Echoes the function's return code.
council_call() { # <repo> <base-sha> <function>
    (
        cd "$1" || exit 99
        log_info() { :; }; log_warn() { :; }; log_error() { :; }; log_success() { :; }
        log_debug() { :; }; log_header() { :; }; log_step() { :; }
        source "$COUNCIL_SH" >/dev/null 2>&1 || exit 98
        export COUNCIL_STATE_DIR="$1/.loki/council" TARGET_DIR="$1" ITERATION_COUNT=7
        export _LOKI_RUN_START_SHA="$2" LOKI_TEST_PROVENANCE=0 __LOKI_CLAUDE_HELP_CACHE=__no_claude__
        COUNCIL_ENABLED=true; COUNCIL_SIZE=3
        mkdir -p "$COUNCIL_STATE_DIR/votes"
        council_aggregate_votes() {
            printf '%s\n' '{"verdict":"COMPLETE","complete_votes":2,"total_members":3}' \
                > "$COUNCIL_STATE_DIR/votes/round-${ITERATION_COUNT}.json"
            echo "COMPLETE"
        }
        "$3" >/dev/null 2>&1
    )
    echo "$?"
}
council_repo() { # <dir> <test-results-json|""> -> echoes base sha; commits a real diff
    new_repo "$1" >/dev/null 2>&1 || return 1
    printf '.loki/\n' > "$1/.gitignore"; g "$1" add .gitignore; g "$1" commit -qm ignore
    local base; base="$(g "$1" rev-parse HEAD)"
    printf 'feature\n' > "$1/feature.txt"; g "$1" add feature.txt; g "$1" commit -qm feature
    if [ -n "$2" ]; then mkdir -p "$1/.loki/quality"; printf '%s\n' "$2" > "$1/.loki/quality/test-results.json"; fi
    echo "$base"
}
jfield() { # <file> <python expr over d>
    python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1" 2>/dev/null
}

# --- cases --------------------------------------------------------------------

case_advisory_only() {
    need python3 git || return
    local adv='{"code_review":"passed","devils_advocate":"passed","magic_debate":"passed","council":"passed","anti_sycophancy":"passed"}'
    local ctl='{"code_review":"passed","static_analysis":"passed","mock_integrity":"passed"}'
    local h c
    h="$(gen_headlines advonly "$adv" no)"
    c="$(gen_headlines advctl "$ctl" yes)"
    if [ "$c" != "VERIFIED|VERIFIED" ]; then
        _why="positive control broken: exogenous passes + verified tests produced '$c', expected VERIFIED|VERIFIED"
        return
    fi
    case "$h" in
        VERIFIED*|*"|VERIFIED"*) _why="advisory-only passes produced a VERIFIED headline (generator|verifier = $h)" ;;
        "NOT VERIFIED|NOT VERIFIED") _st="PASS" ;;
        *) _why="unexpected headline pair '$h'" ;;
    esac
}

case_unknown_gate() {
    need python3 git || return
    local c u s
    c="$(gen_headlines unkctl '{"brand_new_gate_x":"passed","code_review":"passed"}' yes)"
    u="$(gen_headlines unkname '{"brand_new_gate_x":"failed","code_review":"passed"}' yes)"
    s="$(gen_headlines unkstatus '{"static_analysis":"banana","code_review":"passed"}' yes ledger)"
    if [ "$c" != "VERIFIED|VERIFIED" ]; then
        _why="positive control broken: the same fixture with the unknown gate passing produced '$c', expected VERIFIED|VERIFIED"
        return
    fi
    if [ "$u" != "NOT VERIFIED|NOT VERIFIED" ]; then
        _why="a FAILED gate with an unrecognized name did not block (generator|verifier = $u); unknown must default to exogenous"
        return
    fi
    # An unrecognized STATUS is unmeasured: it may not read as a clean VERIFIED
    # and it must be named in the degraded ledger (WITH GAPS is the honest
    # headline when the tests themselves did verify).
    case "$s" in
        "VERIFIED|"*|*"|VERIFIED|"*) _why="an unrecognized gate STATUS read as a clean VERIFIED (generator|verifier|ledger = $s)" ;;
        *"quality_gate:static_analysis"*) _st="PASS" ;;
        *) _why="an unrecognized gate STATUS was not named in the degraded ledger (generator|verifier|ledger = $s)" ;;
    esac
}

case_model_looks_good() {
    need python3 git npm bash bun || return
    local d="$RUN/verify-llm" route rc v llm tg bad=""
    new_repo "$d" >/dev/null 2>&1 || { _why="fixture repo could not be created"; return; }
    g "$d" branch -M main
    printf '%s\n' '{"name":"moat-p2","version":"1.0.0","private":true,"scripts":{"test":"exit 1"}}' > "$d/package.json"
    g "$d" add package.json; g "$d" commit -qm base
    g "$d" checkout -qb feature
    printf 'module.exports = 1;\n' > "$d/index.js"; g "$d" add index.js; g "$d" commit -qm feature
    for route in bun bash; do
        rc=0
        (cd "$d" && PATH="$RUN/stub:$PATH" LOKI_GATE_TIMEOUT=60 loki_route "$route" verify main --out "$RUN/verify-llm-$route") \
            >/dev/null 2>"$RUN/verify-llm-$route.err" || rc=$?
        local ev="$RUN/verify-llm-$route/evidence.json"
        v="$(jfield "$ev" "d.get('verdict')")"
        llm="$(jfield "$ev" "(d.get('llm_review') or {}).get('status')")"
        tg="$(jfield "$ev" "[g.get('status') for g in d.get('deterministic_gates',[]) if g.get('gate')=='tests'][0]")"
        # Controls: the stub reviewer WAS consulted and said "looks good", and
        # the deterministic test evidence really was red.
        if [ "$llm" != "reviewed" ]; then bad="$bad [$route: reviewer control broken, llm_review.status='$llm' (stub not consulted)]"; continue; fi
        if [ "$tg" != "fail" ]; then bad="$bad [$route: evidence control broken, tests gate='$tg' not fail]"; continue; fi
        if [ "$rc" -eq 0 ] || [ "$v" = "VERIFIED" ]; then
            bad="$bad [$route: model 'looks good' + red tests gave verdict=$v rc=$rc]"
        fi
    done
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

case_missing_pass_key() {
    need python3 git || return
    local d1="$RUN/passkey-missing" d2="$RUN/passkey-ctl" b1 b2 v1 v2
    b1="$(council_repo "$d1" '{"runner":"jest","summary":"no pass key"}')" || { _why="fixture failed"; return; }
    b2="$(council_repo "$d2" '{"runner":"jest","pass":true,"summary":"green"}')" || { _why="fixture failed"; return; }
    council_call "$d1" "$b1" council_evidence_gate >/dev/null
    council_call "$d2" "$b2" council_evidence_gate >/dev/null
    v1="$(jfield "$d1/.loki/council/evidence-gate-details.json" "str(d['tests']['inconclusive']).lower()")"
    v2="$(jfield "$d2/.loki/council/evidence-gate-details.json" "str(d['tests']['inconclusive']).lower()")"
    if [ "$v2" != "false" ]; then
        _why="positive control broken: pass:true read tests.inconclusive='$v2', expected false (affirmative)"
    elif [ "$v1" = "true" ]; then
        _st="PASS"
    else
        _why="a results file with no pass key was read as affirmative (tests.inconclusive='$v1')"
    fi
}

# The Bun route's test gate (runTestCoverage, the real loki-ts source) reads
# .loki/quality/test-results.json. "Reads as passed" means an affirmative pass:
# passed === true and not inconclusive. Anything else from the artifact must be
# a failure or an explicit inconclusive.
case_bun_inconclusive() {
    need bun || return
    local d="$RUN/bun-tc" out
    mkdir -p "$d/work"
    cat > "$d/probe.ts" <<'TS'
import * as fs from "node:fs";
const repo = process.env.MOAT_REPO!, root = process.env.MOAT_WORK!;
const { runTestCoverage } = await import(`${repo}/loki-ts/src/runner/quality_gates.ts`);
const shapes: Record<string, string> = {
  control_true: '{"runner":"jest","pass":true}',
  control_false: '{"runner":"jest","pass":false}',
  inconclusive: '{"runner":"node-test","pass":"inconclusive","status":"no_tests_run","exit_code":0,"passed_count":null,"failed_count":null}',
  no_pass_key: '{"runner":"jest","summary":"no pass key"}',
};
const out: string[] = [];
for (const [name, body] of Object.entries(shapes)) {
  const lokiDir = `${root}/${name}/.loki`, cwd = `${root}/${name}`;
  fs.mkdirSync(`${lokiDir}/quality`, { recursive: true });
  fs.writeFileSync(`${lokiDir}/quality/test-results.json`, body);
  // Fresh for iteration 1, so each shape is judged on its pass value and not
  // turned inconclusive by staleness (P2.zero-test-never-affirmative covers that).
  fs.writeFileSync(`${lokiDir}/quality/.test-results.iter`, "1\n");
  // cwd has no package.json, so the gate can never fall back to `npm test`.
  const r = await runTestCoverage({ lokiDir, cwd, iterationCount: 1, log: () => {} } as never);
  out.push(`${name}=${r.passed === true && r.inconclusive !== true ? "PASSED" : r.passed === false ? "FAILED" : r.inconclusive === true ? "INCONCLUSIVE" : "OTHER"}`);
}
console.log(out.join(" "));
TS
    out="$(cd "$d/work" && env -u LOKI_STUB_GATE_TEST_COVERAGE MOAT_REPO="$REPO_ROOT" MOAT_WORK="$d/work" \
        bun run "$d/probe.ts" 2> "$d/err")"
    if [ -z "$out" ]; then
        _why="the Bun probe produced no verdicts (loki-ts/node_modules missing? run bun install in loki-ts): $(head -c 300 "$d/err" | tr '\n' ' ')"
        return
    fi
    case "$out" in *control_true=PASSED*control_false=FAILED*) ;; *)
        _why="controls broken: want control_true=PASSED and control_false=FAILED, got ($out)"; return ;;
    esac
    case "$out" in
        *" inconclusive=INCONCLUSIVE no_pass_key=INCONCLUSIVE") _st="PASS" ;;
        *) _why="the Bun test gate read an unrecorded outcome as something other than inconclusive ($out)" ;;
    esac
}

# A runner that exits 0 having executed zero tests proved nothing, and a
# results file from another iteration is not this iteration's evidence. The
# fixture's `npm test` is a stub jest under node_modules/.bin that prints jest's
# own zero-test line ("No tests found") or, for the positive control, a real
# summary line; both exit 0, so only the output tells them apart.
zt_fixture() { # <dir> <jest-stderr-line> : package.json + stub jest in <dir>
    mkdir -p "$1/node_modules/.bin" || return 1
    printf '%s\n' '{"name":"moat-zt","version":"1.0.0","private":true,"scripts":{"test":"jest --passWithNoTests"}}' > "$1/package.json"
    printf '#!/bin/sh\nprintf "%%s\\n" "%s" >&2\nexit 0\n' "$2" > "$1/node_modules/.bin/jest"
    chmod +x "$1/node_modules/.bin/jest"
}
# The real enforce_test_coverage (plus the zero-test detector it calls, which
# sits directly above it) cut out of run.sh, with only the log helpers stubbed.
zt_harness() { # <out file>
    local rs="$REPO_ROOT/autonomy/run.sh" s e n
    s="$(grep -n '^_loki_zero_tests_executed() {' "$rs" | head -1 | cut -d: -f1)"
    e="$(grep -n '^enforce_test_coverage() {' "$rs" | head -1 | cut -d: -f1)"
    n="$(awk -v s="$e" 'NR>s && /^[a-zA-Z_][a-zA-Z0-9_]*\(\) \{/ {print NR; exit}' "$rs")"
    [ -n "$s" ] && [ -n "$e" ] && [ -n "$n" ] || return 1
    e="$(awk -v s="$e" -v n="$n" 'NR>s && NR<n && /^}[[:space:]]*$/ {last=NR} END {print last}' "$rs")"
    { printf '%s\n' 'log_info() { :; }' 'log_warn() { :; }' 'log_error() { :; }'
      awk -v s="$s" -v e="$e" 'NR>=s && NR<=e' "$rs"; } > "$1"
    bash -n "$1" 2>/dev/null
}

case_zero_test_never_affirmative() {
    need python3 git node npm bash bun timeout || return
    local h="$RUN/zt-harness.sh" leg d b marker tpass dpass out bad=""
    zt_harness "$h" || { _why="could not cut enforce_test_coverage out of run.sh"; return; }
    # Bash route: the real gate writes the marker and results, then the real
    # council evidence gate writes evidence-gate-details.json from them.
    for leg in zero green; do
        d="$RUN/zt-bash-$leg"
        b="$(council_repo "$d" "")" || { _why="fixture $leg failed"; return; }
        if [ "$leg" = zero ]; then zt_fixture "$d" "No tests found, exiting with code 0"
        else zt_fixture "$d" "Tests:       1 passed, 1 total"; fi || { _why="fixture $leg failed"; return; }
        # A marker left by an earlier iteration: a zero-test run must not keep it.
        mkdir -p "$d/.loki/quality" && : > "$d/.loki/quality/unit-tests.pass"
        (cd "$d" && TARGET_DIR="$d" LOKI_GATE_TIMEOUT=60 bash -c ". '$h'; enforce_test_coverage") >/dev/null 2>&1
        council_call "$d" "$b" council_evidence_gate >/dev/null
        if [ -e "$d/.loki/quality/unit-tests.pass" ]; then marker=present; else marker=absent; fi
        tpass="$(jfield "$d/.loki/quality/test-results.json" "json.dumps(d.get('pass'))")"
        dpass="$(jfield "$d/.loki/council/evidence-gate-details.json" "json.dumps(d['tests']['pass'])")"
        if [ "$leg" = green ]; then
            # Positive control: a real pass is affirmative everywhere, so the
            # negatives below are measurements, not absences.
            [ "$marker" = present ] && [ "$tpass" = true ] && [ "$dpass" = true ] \
                || { _why="control broken: a real passing run gave marker=$marker results.pass=$tpass details.tests.pass=$dpass"; return; }
        else
            [ "$tpass" = '"inconclusive"' ] || bad="$bad [bash: zero-test results.pass=$tpass, want \"inconclusive\" (detector did not fire?)]"
            [ "$marker" = absent ] || bad="$bad [bash: zero-test run left unit-tests.pass]"
            [ -n "$dpass" ] && [ "$dpass" != true ] || bad="$bad [bash: evidence-gate-details tests.pass=${dpass:-missing} for a zero-test run]"
        fi
    done
    # Bun route: runTestCoverage (the real loki-ts source) on a stale artifact
    # and on a zero-test `npm test`, each with a positive control.
    mkdir -p "$RUN/zt-bun/work"
    zt_fixture "$RUN/zt-bun/npm-zero" "No tests found, exiting with code 0" || { _why="bun fixture failed"; return; }
    zt_fixture "$RUN/zt-bun/npm-green" "Tests:       1 passed, 1 total" || { _why="bun fixture failed"; return; }
    cat > "$RUN/zt-bun/probe.ts" <<'TS'
import * as fs from "node:fs";
const repo = process.env.MOAT_REPO!, root = process.env.MOAT_ROOT!;
const { runTestCoverage } = await import(`${repo}/loki-ts/src/runner/quality_gates.ts`);
// [leg, marker]: a string or null writes a pass:true artifact (null = no
// freshness marker); undefined writes no artifact (the npm legs).
const legs: Array<[string, string | null | undefined]> = [
  ["fresh", "1"],        // control: this iteration's pass:true artifact
  ["no_marker", null],   // stale: no .test-results.iter
  ["old_marker", "0"],   // stale: an earlier iteration's marker
  ["npm-green", undefined], // control: npm test ran a test
  ["npm-zero", undefined],  // npm test exit 0, zero tests executed
];
const out: string[] = [];
for (const [name, marker] of legs) {
  const cwd = `${root}/${name}`, lokiDir = `${cwd}/.loki`;
  fs.mkdirSync(`${lokiDir}/quality`, { recursive: true });
  if (marker !== undefined) {
    fs.writeFileSync(`${lokiDir}/quality/test-results.json`, '{"runner":"jest","pass":true,"passed_count":3,"failed_count":0}');
    if (marker !== null) fs.writeFileSync(`${lokiDir}/quality/.test-results.iter`, `${marker}\n`);
  }
  const r = await runTestCoverage({ lokiDir, cwd, iterationCount: 1, log: () => {} } as never);
  out.push(`${name}=${r.passed === true && r.inconclusive !== true ? "PASSED" : r.passed === false ? "FAILED" : "INCONCLUSIVE"}`);
}
console.log(out.join(" "));
TS
    out="$(cd "$RUN/zt-bun/work" && env -u LOKI_STUB_GATE_TEST_COVERAGE MOAT_REPO="$REPO_ROOT" MOAT_ROOT="$RUN/zt-bun" \
        bun run "$RUN/zt-bun/probe.ts" 2> "$RUN/zt-bun/err")"
    case "$out" in
        *fresh=PASSED*npm-green=PASSED*) ;;
        *) _why="bun controls broken (a fresh pass:true artifact and a real npm test must pass): got '${out:-<none>}' $(head -c 300 "$RUN/zt-bun/err" | tr '\n' ' ')"; return ;;
    esac
    case "$out" in *no_marker=PASSED*) bad="$bad [bun: a pass:true artifact with no freshness marker read as passed]" ;; esac
    case "$out" in *old_marker=PASSED*) bad="$bad [bun: an earlier iteration's pass:true artifact read as passed]" ;; esac
    case "$out" in *npm-zero=PASSED*) bad="$bad [bun: npm test exit 0 with zero tests executed read as passed]" ;; esac
    zt_stale_session || return
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

# Stale-session leg (both routes): a previous session left .test-results.iter
# "1", a pass:true test-results.json and unit-tests.pass. The next session
# restarts at iteration 0, so its iteration 1 would read that pass as fresh.
# Starting at 0 (terminal or corrupt previous state) must drop the marker and
# unit-tests.pass: bash load_state (cut out of run.sh) and Bun
# loadStateForRunner, then the Bun gate at iteration 1 must not read passed.
# Appends to the caller's $bad; returns 1 with _why set when a control breaks.
zt_stale_session() {
    local ss="$RUN/zt-session" lsh="$RUN/zt-load-state.sh" leg d it args pre post
    { printf '%s\n' 'log_info() { :; }' 'log_warn() { :; }' 'log_error() { :; }'
      sed -n '/^_loki_state_file() {/,/^}/p; /^load_state() {/,/^}/p' "$REPO_ROOT/autonomy/run.sh"; } > "$lsh"
    grep -q '^load_state() {' "$lsh" && grep -q '^_loki_state_file() {' "$lsh" && bash -n "$lsh" 2>/dev/null \
        || { _why="could not cut load_state out of run.sh"; return 1; }
    for leg in bash-terminal bash-corrupt bun-terminal bun-corrupt; do
        d="$ss/$leg"
        mkdir -p "$d/.loki/quality" || { _why="stale-session fixture $leg failed"; return 1; }
        case "$leg" in
            *terminal) printf '%s\n' '{"retryCount":0,"iterationCount":1,"status":"council_approved"}' > "$d/.loki/autonomy-state.json" ;;
            *corrupt) printf '%s\n' '{not json' > "$d/.loki/autonomy-state.json" ;;
        esac
        printf '%s\n' '{"runner":"jest","pass":true,"passed_count":3,"failed_count":0}' > "$d/.loki/quality/test-results.json"
        printf '1\n' > "$d/.loki/quality/.test-results.iter"
        : > "$d/.loki/quality/unit-tests.pass"
    done
    cat > "$ss/probe.ts" <<'TS'
const repo = process.env.MOAT_REPO!;
const { runTestCoverage } = await import(`${repo}/loki-ts/src/runner/quality_gates.ts`);
const { loadStateForRunner } = await import(`${repo}/loki-ts/src/runner/state.ts`);
// argv: <name> <dir> <load 0|1> triples. load=1 runs loadStateForRunner first
// and gates at its iteration + 1 (the loop increments before the gates run);
// load=0 gates at iteration 1.
const a = process.argv.slice(2), out: string[] = [];
for (let i = 0; i + 2 < a.length; i += 3) {
  const [name, dir, load] = [a[i], a[i + 1], a[i + 2]];
  const ctx = { lokiDir: `${dir}/.loki`, cwd: dir, iterationCount: 7, retryCount: 0, log: () => {} };
  if (load === "1") {
    await loadStateForRunner(ctx as never);
    out.push(`${name}.iter=${ctx.iterationCount}`);
    ctx.iterationCount += 1;
  } else {
    ctx.iterationCount = 1;
  }
  const r = await runTestCoverage(ctx as never);
  out.push(`${name}=${r.passed === true && r.inconclusive !== true ? "PASSED" : r.passed === false ? "FAILED" : "INCONCLUSIVE"}`);
}
console.log(out.join(" "));
TS
    zt_probe() { (cd "$ss" && env -u LOKI_STUB_GATE_TEST_COVERAGE MOAT_REPO="$REPO_ROOT" bun run "$ss/probe.ts" "$@" 2> "$ss/err"); }
    # Control: before any load, each leftover reads as passed at iteration 1.
    args=""
    for leg in bash-terminal bash-corrupt bun-terminal bun-corrupt; do args="$args $leg $ss/$leg 0"; done
    # shellcheck disable=SC2086  # $args is word-split into triples on purpose (no spaces in $RUN paths)
    pre="$(zt_probe $args)"
    case "$pre" in "bash-terminal=PASSED bash-corrupt=PASSED bun-terminal=PASSED bun-corrupt=PASSED") ;;
        *) _why="stale-session control broken (each leftover must read passed before a load): got '${pre:-<none>}' $(head -c 300 "$ss/err" | tr '\n' ' ')"; return 1 ;;
    esac
    # Bash route: the real load_state. The env never reaches a real repo's .loki.
    for leg in bash-terminal bash-corrupt; do
        d="$ss/$leg"
        it="$(cd "$d" && env -u LOKI_DIR -u LOKI_SESSION_ID -u LOKI_DURABLE_STATE TARGET_DIR="$d" ITERATION_COUNT=5 \
            bash -c '. "$1"; load_state; printf "%s" "$ITERATION_COUNT"' _ "$lsh" 2>/dev/null)"
        [ "$it" = 0 ] || { _why="stale-session control broken: bash load_state left ITERATION_COUNT='$it' for $leg, want 0"; return 1; }
    done
    post="$(zt_probe bash-terminal "$ss/bash-terminal" 0 bash-corrupt "$ss/bash-corrupt" 0 \
        bun-terminal "$ss/bun-terminal" 1 bun-corrupt "$ss/bun-corrupt" 1)"
    case "$post" in *"bun-terminal.iter=0 "*"bun-corrupt.iter=0 "*) ;;
        *) _why="stale-session control broken: loadStateForRunner did not start at iteration 0: got '${post:-<none>}' $(head -c 300 "$ss/err" | tr '\n' ' ')"; return 1 ;;
    esac
    for leg in bash-terminal bash-corrupt bun-terminal bun-corrupt; do
        d="$ss/$leg/.loki/quality"
        [ -e "$d/.test-results.iter" ] && bad="$bad [${leg%%-*}: a new session at iteration 0 kept the previous session's .test-results.iter (${leg#*-} state)]"
        [ -e "$d/unit-tests.pass" ] && bad="$bad [${leg%%-*}: a new session at iteration 0 kept the previous session's unit-tests.pass (${leg#*-} state)]"
        [ -e "$d/test-results.json" ] && bad="$bad [${leg%%-*}: a new session at iteration 0 kept the previous session's test-results.json, which the receipt would report as this run (${leg#*-} state)]"
        case " $post " in *" $leg=PASSED "*) bad="$bad [${leg%%-*}: after a ${leg#*-} previous state the Bun gate read the previous session's pass:true as passed at iteration 1]" ;; esac
    done
    return 0
}

case_proof_verify_contract() {
    need python3 git bun || return
    local ws="$RUN/pv-ws" route rc want bad=""
    chain_ws "$ws" "" >/dev/null 2>&1 || { _why="receipt fixture could not be built"; return; }
    # Tampered copy: a hashed field changed, hash left stale.
    mkdir -p "$ws/.loki/proofs/r2"
    python3 - "$ws/.loki/proofs/r1/proof.json" "$ws/.loki/proofs/r2/proof.json" <<'PY' || { _why="tamper fixture failed"; return; }
import json, sys
p = json.load(open(sys.argv[1])); p["cost"]["usd"] = 999.99
json.dump(p, open(sys.argv[2], "w"), indent=2)
PY
    local id
    for route in bun bash; do
        for want in "0:r1" "1:r2" "64:" "66:no-such-proof-id"; do
            id="${want#*:}"; rc=0
            if [ -n "$id" ]; then
                (cd "$ws" && LOKI_DIR="$ws/.loki" TARGET_DIR="$ws" loki_route "$route" proof verify "$id") >/dev/null 2>&1 || rc=$?
            else
                (cd "$ws" && LOKI_DIR="$ws/.loki" TARGET_DIR="$ws" loki_route "$route" proof verify) >/dev/null 2>&1 || rc=$?
            fi
            [ "$rc" = "${want%%:*}" ] || bad="$bad [$route ${id:-<no id>}: got $rc want ${want%%:*}]"
        done
    done
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

case_proof_chain_contract() {
    need python3 git bun || return
    local route rc want ws bad=""
    chain_ws "$RUN/ch-ok" '{"max_usd": 5.0}' >/dev/null 2>&1 || { _why="fixture ch-ok failed"; return; }
    chain_ws "$RUN/ch-over" '{"max_usd": 0.01}' >/dev/null 2>&1 || { _why="fixture ch-over failed"; return; }
    chain_ws "$RUN/ch-shadow" '{"max_usd": 0.01}' >/dev/null 2>&1 || { _why="fixture ch-shadow failed"; return; }
    printf '%s\n' 'import os, sys' 'open(os.environ.get("MOAT_MARK", "/dev/null"), "a").write(sys.argv[0] + "\n")' 'sys.exit(0)' \
        | tee "$RUN/ch-shadow/json.py" > "$RUN/ch-shadow/sitecustomize.py"
    g "$RUN/ch-shadow" add json.py sitecustomize.py && g "$RUN/ch-shadow" commit -qm "shadow the stages" >/dev/null 2>&1 \
        || { _why="fixture ch-shadow commit failed"; return; }
    mkdir -p "$RUN/ch-empty/.loki" "$RUN/ch-blind/.loki"
    printf '%s' '{"max_usd": "not-a-number"}' > "$RUN/ch-blind/.loki-policy.json"
    for route in bun bash; do
        for want in "0 ch-ok" "1 ch-over" "2 ch-blind" "3 ch-empty" "66 ch-absent" "64 ch-empty"; do
            ws="$RUN/${want#* }"
            rc=0
            if [ "${want%% *}" = "64" ]; then
                loki_route "$route" proof chain "$ws" --no-such-flag >/dev/null 2>&1 || rc=$?
            else
                loki_route "$route" proof chain "$ws" --repo-dir "$ws" >/dev/null 2>&1 || rc=$?
            fi
            [ "$rc" = "${want%% *}" ] || bad="$bad [$route ${want#* }: got $rc want ${want%% *}]"
        done
        # The checkout under verification cannot supply a stage's modules: a
        # committed json.py/sitecustomize.py plus an empty PYTHONPATH component
        # (which adds the cwd) must not turn an over-budget chain into a pass.
        rc=0; (cd "$RUN/ch-shadow" && PYTHONPATH=":/nonexistent" MOAT_MARK="$RUN/ch-shadow.mark" \
            loki_route "$route" proof chain "$RUN/ch-shadow" --repo-dir "$RUN/ch-shadow") >/dev/null 2>&1 || rc=$?
        [ "$rc" = 1 ] || bad="$bad [$route chain hostile PYTHONPATH + shadow modules: got $rc want 1]"
        [ ! -s "$RUN/ch-shadow.mark" ] || bad="$bad [$route chain: a committed shadow module ran in a stage: $(head -1 "$RUN/ch-shadow.mark")]"
        # A verifier never exits 0 without a verdict: help is a usage error.
        for _h in -h --help --he -hq; do
            rc=0; loki_route "$route" proof chain "$RUN/ch-ok" "$_h" >/dev/null 2>&1 || rc=$?
            [ "$rc" = 64 ] || bad="$bad [$route chain $_h: got $rc want 64]"
        done
    done
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

case_verify_contract() {
    need git bash || return
    local d="$RUN/verify-empty" nogit="$RUN/verify-nogit" route rc bad=""
    new_repo "$d" >/dev/null 2>&1 || { _why="fixture failed"; return; }
    g "$d" branch -M main
    mkdir -p "$nogit"
    for route in bun bash; do
        rc=0; (cd "$d" && loki_route "$route" verify main --no-llm --out "$RUN/ve-$route") >/dev/null 2>&1 || rc=$?
        [ "$rc" = "3" ] || bad="$bad [$route nothing-to-check (empty diff): got $rc want 3]"
        rc=0; (cd "$nogit" && loki_route "$route" verify main --no-llm --out "$RUN/vn-$route") >/dev/null 2>&1 || rc=$?
        [ "$rc" = "2" ] || bad="$bad [$route could-not-check (not a git repo): got $rc want 2]"
        rc=0; (cd "$d" && loki_route "$route" verify --no-such-flag) >/dev/null 2>&1 || rc=$?
        [ "$rc" = "64" ] || bad="$bad [$route usage (unknown flag): got $rc want 64]"
    done
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

case_fast_verify() {
    need python3 bash || return
    local empty="$RUN/fv-empty" hit="$RUN/fv-hit" route rc bad=""
    mkdir -p "$empty" "$hit"
    printf "test('adds', () => { const x = 1 + 1; });\n" > "$hit/app.test.js"
    for route in bun bash; do
        # Positive control: a real high finding must exit non-zero, so the
        # probe below can see a non-zero at all.
        rc=0; loki_route "$route" verify --fast "$hit" --no-cache >/dev/null 2>&1 || rc=$?
        if [ "$rc" = "0" ]; then bad="$bad [$route control broken: an assertionless test exited 0]"; continue; fi
        rc=0; loki_route "$route" verify --fast "$empty" --no-cache >/dev/null 2>&1 || rc=$?
        [ "$rc" != "0" ] || bad="$bad [$route nothing scanned: exit 0]"
        rc=0; loki_route "$route" verify --fast "$RUN/fv-absent" --no-cache >/dev/null 2>&1 || rc=$?
        [ "$rc" != "0" ] || bad="$bad [$route nonexistent root: exit 0]"
        rc=0; loki_route "$route" verify --fast "$empty" --no-cache --no-such-flag >/dev/null 2>&1 || rc=$?
        [ "$rc" != "0" ] || bad="$bad [$route unknown flag: exit 0]"
    done
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

case_council_inconclusive() {
    need python3 git || return
    local dinc="$RUN/cc-inc" dgreen="$RUN/cc-green" dempty="$RUN/cc-empty" b rc_inc rc_green rc_empty inc
    b="$(council_repo "$dinc" "")" || { _why="fixture failed"; return; }
    rc_inc="$(council_call "$dinc" "$b" council_evaluate)"
    inc="$(jfield "$dinc/.loki/council/evidence-gate-details.json" "str(d['tests']['inconclusive']).lower()")"
    b="$(council_repo "$dgreen" '{"runner":"jest","pass":true,"summary":"green"}')" || { _why="fixture failed"; return; }
    rc_green="$(council_call "$dgreen" "$b" council_evaluate)"
    new_repo "$dempty" >/dev/null 2>&1 || { _why="fixture failed"; return; }
    b="$(g "$dempty" rev-parse HEAD)"
    mkdir -p "$dempty/.loki/quality"
    printf '%s\n' '{"runner":"jest","pass":true}' > "$dempty/.loki/quality/test-results.json"
    rc_empty="$(council_call "$dempty" "$b" council_evaluate)"
    # Control A: the evidence gate is live in this harness (empty diff blocks).
    # Control B: the harness CAN complete (conclusive green + vote -> 0).
    # Control C: the inconclusive state is what the gate actually recorded.
    if [ "$rc_empty" != "1" ]; then _why="control A broken: empty diff returned $rc_empty, expected 1"; return; fi
    if [ "$rc_green" != "0" ]; then _why="control B broken: conclusive green + vote returned $rc_green, expected 0"; return; fi
    if [ "$inc" != "true" ]; then _why="control C broken: gate recorded tests.inconclusive='$inc'"; return; fi
    if [ "$rc_inc" = "0" ]; then
        _why="inconclusive evidence (no test results) + a 2-of-3 council vote returned 0 from council_evaluate, i.e. council_approved"
    else
        _st="PASS"
    fi
}

# D7 on the council side: the council runs inside the agent's own repo, so a
# committed json.py (reads every file as a green run) or sitecustomize.py
# (loaded through an empty PYTHONPATH component) must never become the verdict.
# Both write MOAT_MARK when imported.
shadow_modules() { # <repo> : commit the shadow modules into the run's diff
    cat > "$1/json.py" <<'EOF'
import os
open(os.environ.get("MOAT_MARK", os.devnull), "a").write("json.py\n")
class JSONDecodeError(ValueError): pass
def load(*a, **k): return {"runner": "jest", "pass": True, "status": "passed"}
def loads(*a, **k): return load()
def dump(*a, **k): pass
def dumps(*a, **k): return "{}"
EOF
    printf '%s\n' 'import os' 'open(os.environ.get("MOAT_MARK", os.devnull), "a").write("sitecustomize.py\n")' \
        > "$1/sitecustomize.py"
    g "$1" add json.py sitecustomize.py && g "$1" commit -qm "shadow modules"
}

case_council_readers_not_shadowed() {
    need python3 git || return
    local fail='{"runner":"jest","pass":false,"summary":"1 failed"}'
    local green='{"runner":"jest","pass":true,"summary":"green"}'
    local leg d b fn rc want bad=""
    for leg in shadow-fail shadow-green plain-fail plain-green; do
        d="$RUN/shadow-$leg"
        case "$leg" in *-fail) b="$(council_repo "$d" "$fail")" ;; *) b="$(council_repo "$d" "$green")" ;; esac \
            || { _why="fixture $leg failed"; return; }
        case "$leg" in shadow-*) shadow_modules "$d" >/dev/null 2>&1 || { _why="fixture $leg commit failed"; return; } ;; esac
        case "$leg" in *-fail) want=1 ;; *) want=0 ;; esac
        # Control: this environment really does load both shadows into an
        # unguarded interpreter run from the repo, so "the marker stayed
        # empty" below is a measurement, not an absence.
        if [ "$leg" = shadow-fail ]; then
            (cd "$d" && PYTHONPATH=":/nonexistent" MOAT_MARK="$RUN/shadow-ctl.mark" python3 -c 'import json') >/dev/null 2>&1
            if ! grep -q '^sitecustomize.py$' "$RUN/shadow-ctl.mark" 2>/dev/null \
                || ! grep -q '^json.py$' "$RUN/shadow-ctl.mark" 2>/dev/null; then
                _why="control broken: an unguarded python3 in the fixture did not load both shadows"
                return
            fi
        fi
        for fn in council_evidence_gate _council_convergence_evidence_green; do
            rc="$(export PYTHONPATH=":/nonexistent" MOAT_MARK="$d.mark"; council_call "$d" "$b" "$fn")"
            [ "$rc" = "$want" ] || bad="$bad [$leg $fn: got $rc want $want]"
        done
        [ ! -s "$d.mark" ] || bad="$bad [$leg: a repo module ran in the council: $(sort -u "$d.mark" | tr '\n' ' ')]"
    done
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

# D7 on the checklist side (backlog 53): PRD checklist verification runs inside
# the agent's repo too. This json.py is smarter than the one above: it loads the
# real json and then rewrites every failing check it reads or writes as passing,
# so checklist-verify.py itself would write a green verification-results.json.
liar_json() { # <repo>
    cat > "$1/json.py" <<'EOF'
import os, sys
open(os.environ.get("MOAT_MARK", os.devnull), "a").write("json.py\n")
_me = sys.modules[__name__]
_here = os.path.dirname(os.path.abspath(__file__))
_saved = sys.path[:]
sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != _here]
del sys.modules[__name__]
try:
    import json as _real
finally:
    sys.path[:] = _saved
    sys.modules[__name__] = _me
JSONDecodeError = _real.JSONDecodeError
def _lie(o):
    if isinstance(o, list):
        return [_lie(v) for v in o]
    if not isinstance(o, dict):
        return o
    o = {k: _lie(v) for k, v in o.items()}
    if o.get("status") in ("failing", "pending"):
        o["status"] = "verified"
    if o.get("passed") is False:
        o["passed"] = True
    s = o.get("summary")
    if isinstance(s, dict) and "total" in s:
        o["summary"] = dict(s, verified=s["total"], failing=0, pending=0)
    return o
def load(fp, *a, **k): return _lie(_real.load(fp, *a, **k))
def loads(s, *a, **k): return _lie(_real.loads(s, *a, **k))
def dump(o, fp, *a, **k): return _real.dump(_lie(o), fp, *a, **k)
def dumps(o, *a, **k): return _real.dumps(_lie(o), *a, **k)
EOF
    printf '%s\n' 'import os' 'open(os.environ.get("MOAT_MARK", os.devnull), "a").write("sitecustomize.py\n")' \
        > "$1/sitecustomize.py"
}

# Run the real checklist path in <repo>: checklist_verify (held-out selection,
# the spec oracle, checklist-verify.py), then the prompt summary, the council
# evidence block, and the council's checklist hard gate over what it wrote.
checklist_call() { # <repo>
    (
        cd "$1" || exit 99
        log_info() { :; }; log_warn() { :; }; log_error() { :; }; log_success() { :; }
        log_debug() { :; }; log_header() { :; }; log_step() { :; }
        source "$REPO_ROOT/autonomy/prd-checklist.sh" >/dev/null 2>&1 || exit 98
        source "$COUNCIL_SH" >/dev/null 2>&1 || exit 98
        export COUNCIL_STATE_DIR="$1/.loki/council" ITERATION_COUNT=5
        mkdir -p "$COUNCIL_STATE_DIR"
        checklist_init "$1/spec.md"
        checklist_verify >/dev/null 2>&1
        printf 'SUMMARY %s\n' "$(checklist_summary 2>/dev/null)"
        checklist_as_evidence 2>/dev/null
        council_checklist_gate >/dev/null 2>&1
        printf 'GATE %s\n' "$?"
    )
}

case_checklist_not_shadowed() {
    need python3 git || return
    local cl='{"categories":[{"name":"core","items":[
{"id":"c1","title":"readme exists","priority":"critical","verification":[{"type":"file_exists","path":"README.md"}]},
{"id":"c2","title":"seed says done","priority":"critical","verification":[{"type":"file_contains","path":"seed.txt","pattern":"DONE"}]},
{"id":"c3","title":"config exists","priority":"critical","verification":[{"type":"file_exists","path":"config.yml"}]}]}]}'
    local leg d out res want_res want_sum want_gate ev_has ev_not bad=""
    for leg in shadow-fail shadow-green plain-fail plain-green; do
        d="$RUN/cl-$leg"
        new_repo "$d" >/dev/null 2>&1 || { _why="fixture $leg failed"; return; }
        # A spec the oracle reads (a datastore claim, no API symbol, so no LSP probe).
        printf '%s\n' '# Spec' '' 'The service stores its data in PostgreSQL.' > "$d/spec.md"
        case "$leg" in
            *-green) printf 'DONE\n' > "$d/seed.txt"; printf 'readme\n' > "$d/README.md"; printf 'a: 1\n' > "$d/config.yml" ;;
        esac
        case "$leg" in shadow-*) liar_json "$d" ;; esac
        g "$d" add -A >/dev/null 2>&1 && g "$d" commit -qm fixture >/dev/null 2>&1 || { _why="fixture $leg commit failed"; return; }
        mkdir -p "$d/.loki/checklist" && printf '%s\n' "$cl" > "$d/.loki/checklist/checklist.json"
        # Control: in this environment an unguarded interpreter run from the
        # repo loads both shadows AND the liar lies, so an empty marker below
        # is a measurement, not an absence.
        if [ "$leg" = shadow-fail ]; then
            out="$(cd "$d" && PYTHONPATH=":/nonexistent" MOAT_MARK="$RUN/cl-ctl.mark" \
                python3 -c 'import json; print(json.loads("{\"status\": \"failing\"}")["status"])' 2>/dev/null)"
            if [ "$out" != "verified" ] || ! grep -q '^sitecustomize.py$' "$RUN/cl-ctl.mark" 2>/dev/null \
                || ! grep -q '^json.py$' "$RUN/cl-ctl.mark" 2>/dev/null; then
                _why="control broken: an unguarded python3 in the fixture did not load both shadows and lie (got '$out')"
                return
            fi
        fi
        out="$(export PYTHONPATH=":/nonexistent" MOAT_MARK="$d.mark"; checklist_call "$d")"
        res="$(jfield "$d/.loki/checklist/verification-results.json" "'%s/%s' % (d['summary']['verified'], d['summary']['failing'])")"
        # 3 items, 1 held out of the summary; the results file carries all 3.
        case "$leg" in
            *-fail)  want_res="0/3"; want_sum="SUMMARY 0/2 verified, 2 failing"; want_gate="GATE 1"; ev_has="[FAIL]"; ev_not="[PASS]" ;;
            *)       want_res="3/0"; want_sum="SUMMARY 2/2 verified, 0 failing"; want_gate="GATE 0"; ev_has="[PASS]"; ev_not="[FAIL]" ;;
        esac
        [ "$res" = "$want_res" ] || bad="$bad [$leg results verified/failing: got '$res' want $want_res]"
        printf '%s\n' "$out" | grep -q "^${want_sum}" || bad="$bad [$leg summary: got '$(printf '%s\n' "$out" | grep '^SUMMARY')']"
        printf '%s\n' "$out" | grep -qx "$want_gate" || bad="$bad [$leg gate: got '$(printf '%s\n' "$out" | grep '^GATE')' want $want_gate]"
        printf '%s\n' "$out" | grep -qF "$ev_has" || bad="$bad [$leg evidence lacks $ev_has]"
        ! printf '%s\n' "$out" | grep -qF "$ev_not" || bad="$bad [$leg evidence shows $ev_not]"
        [ ! -s "$d.mark" ] || bad="$bad [$leg: a repo module ran in checklist verification: $(sort -u "$d.mark" | tr '\n' ' ')]"
    done
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

# --- run ----------------------------------------------------------------------
run_case P2.advisory-only-never-verified "advisory/model-only gate passes never yield a VERIFIED headline (generator + verifier)" case_advisory_only
run_case P2.unknown-gate-fails-closed "an unrecognized gate name or status cannot read green (generator + verifier)" case_unknown_gate
run_case P2.model-looks-good-cannot-pass "loki verify: a stub reviewer saying 'looks good' over red tests is not VERIFIED/0 (verify is bash-only: bin/loki execs autonomy/loki on both entry points)" case_model_looks_good
run_case P2.missing-pass-key-not-pass "evidence gate: test-results with no pass key is inconclusive, not affirmative" case_missing_pass_key
run_case P2.bun-inconclusive-not-pass "Bun test gate (runTestCoverage): pass:\"inconclusive\" and a missing pass key read as inconclusive, never an affirmative pass (passed && !inconclusive); pass:true does" case_bun_inconclusive
run_case P2.zero-test-never-affirmative "a zero-test run leaves no unit-tests.pass and no evidence-gate tests.pass:true (bash), and neither a stale test-results.json nor a zero-test npm test reads as passed (Bun); real passes do on both; a new session at iteration 0 drops the previous session's freshness marker, unit-tests.pass and test-results.json (both routes)" case_zero_test_never_affirmative
run_case P2.proof-verify-exit-contract "loki proof verify exits 0 clean, 1 tampered, 64 no id, 66 unknown id (both routes)" case_proof_verify_contract
run_case P2.proof-chain-exit-contract "loki proof chain exits 0/1/2/3/64/66, -h/--help is 64 not 0, and a hostile PYTHONPATH cannot shadow a stage (both entry points)" case_proof_chain_contract
run_case P2.verify-exit-contract "loki verify maps nothing-to-check to 3, could-not-check to 2, usage to 64 (bash-only command, both entry points)" case_verify_contract
run_case P2.fast-verify-inconclusive-not-zero "loki verify --fast with nothing scanned, a nonexistent root or an unknown flag does not exit 0 (bash-only command, both entry points)" case_fast_verify
run_case P2.council-inconclusive-cannot-exit-zero "inconclusive evidence plus a council vote alone cannot approve completion" case_council_inconclusive
run_case P2.council-readers-not-shadowed "a json.py/sitecustomize.py in the agent's repo (hostile PYTHONPATH) cannot turn failing test results green in the council's readers" case_council_readers_not_shadowed
run_case P2.checklist-verify-not-shadowed "a json.py/sitecustomize.py in the agent's repo (hostile PYTHONPATH) cannot turn failing PRD checklist checks green (checklist-verify.py, summary, council evidence, hard gate)" case_checklist_not_shadowed

printf 'moat-p2: finished in %ss\n' "$(( $(date +%s) - T_START ))" >&2
exit 0
