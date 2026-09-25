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
    need python3 git npm bash || return
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
    need python3 git || return
    local route rc want ws bad=""
    chain_ws "$RUN/ch-ok" '{"max_usd": 5.0}' >/dev/null 2>&1 || { _why="fixture ch-ok failed"; return; }
    chain_ws "$RUN/ch-over" '{"max_usd": 0.01}' >/dev/null 2>&1 || { _why="fixture ch-over failed"; return; }
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

# --- run ----------------------------------------------------------------------
run_case P2.advisory-only-never-verified "advisory/model-only gate passes never yield a VERIFIED headline (generator + verifier)" case_advisory_only
run_case P2.unknown-gate-fails-closed "an unrecognized gate name or status cannot read green (generator + verifier)" case_unknown_gate
run_case P2.model-looks-good-cannot-pass "loki verify: a stub reviewer saying 'looks good' over red tests is not VERIFIED/0 (both routes)" case_model_looks_good
run_case P2.missing-pass-key-not-pass "evidence gate: test-results with no pass key is inconclusive, not affirmative" case_missing_pass_key
run_case P2.proof-verify-exit-contract "loki proof verify exits 0 clean, 1 tampered, 64 no id, 66 unknown id (both routes)" case_proof_verify_contract
run_case P2.proof-chain-exit-contract "loki proof chain exits 0/1/2/3/64/66 (both routes)" case_proof_chain_contract
run_case P2.verify-exit-contract "loki verify maps nothing-to-check to 3, could-not-check to 2, usage to 64 (both routes)" case_verify_contract
run_case P2.fast-verify-inconclusive-not-zero "loki verify --fast with nothing scanned, a nonexistent root or an unknown flag does not exit 0 (both routes)" case_fast_verify
run_case P2.council-inconclusive-cannot-exit-zero "inconclusive evidence plus a council vote alone cannot approve completion" case_council_inconclusive

printf 'moat-p2: finished in %ss\n' "$(( $(date +%s) - T_START ))" >&2
exit 0
