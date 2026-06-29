#!/usr/bin/env bash
# done-recognition.sh -- model-verified "already done?" gate for no-PRD reuse runs.
#
# Problem: a `loki start` with NO PRD over a project Loki already built and
# completed reverse-engineers (reuses) the prior generated PRD and then rebuilds
# a full task queue and re-runs the RARV loop, re-doing finished work. The reuse
# path never asks "is this reused PRD already satisfied by the current codebase?"
#
# This module inserts ONE localized gate in run_autonomous() between load_state
# and the queue/loop. On a no-PRD reuse run it re-verifies ground truth with the
# model (re-runs tests via the existing completion-test-evidence path, inspects
# code per requirement) and routes to one of three outcomes:
#   - done        -> refresh the verified-completion record + finish through the
#                    normal completion path (no wasted iterations, no queue).
#   - incomplete  -> write a satisfied-requirements manifest so populate_prd_queue
#                    builds ONLY the unsatisfied requirements.
#   - inconclusive-> do nothing; fall through to the normal full build (safe
#                    default). NEVER declare done on inconclusive.
#
# TRUST MOAT: a model `done` is DOWNGRADED to build if fresh tests are red or any
# requirement is unmet/uncertain. The positive verdict is always the model's,
# grounded in re-run reality, never asserted from a stale artifact. The `update`
# action (PRD stale by definition) may NEVER fast-stop as done.
#
# MODEL INTELLIGENCE, NEVER HARDCODED: the only deterministic short-circuit is
# NEGATIVE (cheap signals that route to BUILD). There is no deterministic
# "checklist all-verified -> stop" shortcut.
#
# Rollout: DEFAULT-ON. LOKI_DONE_RECOGNITION=0 disables the gate (legacy
# reuse-then-build behavior). Trust-safe because inconclusive always falls
# through to build.
#
# Indirection (for testability): the actual model call goes through
#   _loki_done_recog_invoke <prompt>   (echoes the raw model response)
# Tests stub this function to return canned JSON without a real model. This is
# the single injection seam, mirroring autonomy/lib/prd-enrich.sh.
#
# No emojis. No em dashes. bash 3.2 safe. Honors `set -uo pipefail`.

# Bound the single model call so a huge PRD or test log cannot run away.
: "${LOKI_DONE_RECOG_TIMEOUT:=180}"           # seconds for the single model call
: "${LOKI_DONE_RECOG_MAX_PRD_CHARS:=16000}"   # cap PRD context length
: "${LOKI_DONE_RECOG_MAX_TEST_CHARS:=4000}"   # cap test-results context length

# The single model-call primitive. Kept as its own function so:
#   1. it is the ONE place that touches the provider, and
#   2. tests can override it to return canned JSON.
# Mirrors _loki_prd_enrich_invoke (autonomy/lib/prd-enrich.sh:43) verbatim in
# shape. Calls `claude -p` directly (not provider_invoke) because `timeout`
# needs a real command, not a shell function.
_loki_done_recog_invoke() {
    local prompt="$1"
    command -v claude >/dev/null 2>&1 || return 1
    local rc=0
    local out=""
    if command -v timeout >/dev/null 2>&1; then
        out=$(CAVEMAN_DEFAULT_MODE=off timeout "${LOKI_DONE_RECOG_TIMEOUT}" \
                  claude --dangerously-skip-permissions -p "$prompt" 2>/dev/null) || rc=$?
    else
        out=$(CAVEMAN_DEFAULT_MODE=off \
                  claude --dangerously-skip-permissions -p "$prompt" 2>/dev/null) || rc=$?
    fi
    [ "$rc" -ne 0 ] && return 1
    [ -z "$out" ] && return 1
    printf '%s' "$out"
    return 0
}

# Decide whether model verification can be attempted. Returns 0 (ok) only when
# the active provider is claude and not degraded. Mirrors
# _loki_prd_enrich_provider_ok (autonomy/lib/prd-enrich.sh:65).
_loki_done_recog_provider_ok() {
    [ "${LOKI_PROVIDER:-claude}" = "claude" ] || return 1
    [ "${PROVIDER_DEGRADED:-false}" != "true" ] || return 1
    command -v claude >/dev/null 2>&1 || return 1
    return 0
}

# Compute the PRD identity hash. MUST be byte-identical here (writer) and in
# populate_prd_queue's manifest read-point (reader) or the guard always
# mismatches and silently falls back to a full build. Pinned to the same file
# and the same hashing path on both sides via this one helper.
_loki_done_recog_prd_sha() {
    local prd_file="${1:-}"
    [ -n "$prd_file" ] && [ -f "$prd_file" ] || { printf ''; return 0; }
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$prd_file" 2>/dev/null | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$prd_file" 2>/dev/null | awk '{print $1}'
    else
        # Last-resort: a python hash, still deterministic over the same bytes.
        LOKI_DR_PRD="$prd_file" python3 -c "
import hashlib, os
p = os.environ.get('LOKI_DR_PRD','')
try:
    with open(p,'rb') as f:
        print(hashlib.sha256(f.read()).hexdigest())
except Exception:
    print('')
" 2>/dev/null
    fi
}

# The gate. Called once, run-scoped, from run_autonomous() AFTER load_state and
# BEFORE the delegate-branch/start-sha block and populate_prd_queue.
#
# Arguments:
#   $1 = prd_path (the reused generated PRD, e.g. .loki/generated-prd.md)
#
# Behavior by outcome:
#   done        -> writes refreshed completion record, runs council-parity
#                  finalization subset (all type-guarded), returns 0 so the
#                  caller's `return 0` skips queue-build + loop and main()'s
#                  terminal block finalizes the run.
#   incomplete  -> writes .loki/state/satisfied-requirements.json, returns 1 so
#                  the caller falls through to a (now incremental) build.
#   inconclusive/fast-path/disabled -> returns 1 (fall through to build).
#
# Return contract:
#   0 = DONE (caller must short-circuit: `return 0` from run_autonomous)
#   1 = BUILD (caller falls through to the normal queue/loop)
reuse_done_recognition_gate() {
    local prd_path="${1:-}"
    local action="${GENERATED_PRD_ACTION:-}"
    local loki_dir="${TARGET_DIR:-.}/.loki"

    # --- Opt-out (rollout escape hatch). Default-on. -------------------------
    if [ "${LOKI_DONE_RECOGNITION:-1}" = "0" ]; then
        return 1
    fi

    # Must have a usable reused PRD to judge against.
    [ -n "$prd_path" ] && [ -f "$prd_path" ] || return 1

    # --- Negative fast-path A: no completion footprint at all ----------------
    # The project was never completed by a prior run; there is nothing plausibly
    # done. Never pay for a model call. (Cheapest, most common miss-avoidance.)
    if [ ! -f "$loki_dir/signals/COMPLETION_REQUESTED" ] \
       && [ ! -f "$loki_dir/state/completion.json" ] \
       && [ ! -f "$loki_dir/checklist/checklist.json" ]; then
        log_info "Done-recognition: no prior completion footprint; proceeding to build."
        return 1
    fi

    # --- Negative fast-path B: provider cannot model-verify -------------------
    # Cannot model-verify -> inconclusive -> build (never assert done offline).
    if ! _loki_done_recog_provider_ok; then
        log_info "Done-recognition: provider cannot verify (non-claude/degraded/no binary); proceeding to build."
        return 1
    fi

    log_step "Done-recognition: checking whether the existing code already satisfies the reused spec..."

    # --- Ground-truth re-verification: re-run tests NOW ----------------------
    # Reuse the SAME evidence axis the completion council/evidence gate reads, so
    # the gate cannot reach a verdict that contradicts the council. Swallow rc
    # (red tests are data, not a crash). When unavailable the file is simply
    # absent and the test axis is honestly inconclusive.
    if type ensure_completion_test_evidence >/dev/null 2>&1; then
        ensure_completion_test_evidence || true
    fi
    local _test_results="$loki_dir/quality/test-results.json"

    # --- Build the model prompt payload (python: bounded, defensive) ---------
    local prompt
    prompt=$(LOKI_DR_PRD="$prd_path" \
             LOKI_DR_TESTS="$_test_results" \
             LOKI_DR_COMPLETION="$loki_dir/state/completion.json" \
             LOKI_DR_EVIDENCE="$loki_dir/completion-evidence.md" \
             LOKI_DR_CHECKLIST="$loki_dir/checklist/checklist.json" \
             LOKI_DR_MAX_PRD="${LOKI_DONE_RECOG_MAX_PRD_CHARS}" \
             LOKI_DR_MAX_TEST="${LOKI_DONE_RECOG_MAX_TEST_CHARS}" \
             python3 << 'DR_PROMPT_EOF'
import json, os, sys

def read_capped(path, cap):
    try:
        with open(path, "r", errors="replace") as f:
            return f.read()[:cap]
    except Exception:
        return ""

prd = read_capped(os.environ.get("LOKI_DR_PRD", ""),
                  int(os.environ.get("LOKI_DR_MAX_PRD", "16000") or "16000"))
if not prd.strip():
    sys.exit(0)

tests = read_capped(os.environ.get("LOKI_DR_TESTS", ""),
                    int(os.environ.get("LOKI_DR_MAX_TEST", "4000") or "4000"))
completion = read_capped(os.environ.get("LOKI_DR_COMPLETION", ""), 2000)
evidence = read_capped(os.environ.get("LOKI_DR_EVIDENCE", ""), 2000)
checklist = read_capped(os.environ.get("LOKI_DR_CHECKLIST", ""), 2000)

prompt = """You are deciding whether a codebase ALREADY satisfies its spec, so a
build system can skip rebuilding work that is already done. Be rigorous and
conservative: a wrong "done" wastes the user's trust, a wrong "incomplete" only
costs a little rebuild. When unsure, say uncertain.

For EACH requirement in the PRD below:
  - Inspect the ACTUAL code in this repository (read the files) and the fresh
    test results, and decide whether the requirement is met NOW.
  - Treat all prior Loki artifacts (PRIOR CLAIMS section) as UNVERIFIED claims.
    Do NOT trust them; verify against the code and the fresh test results.

Then return ONLY a single JSON object (no prose, no markdown fences):
{
  "verdict": "done" | "incomplete" | "inconclusive",
  "summary": "<one plain sentence for the user>",
  "tests": { "passed": <int>, "total": <int>, "green": true|false },
  "requirements": [
    { "id": "<stable id or title slug>",
      "title": "<requirement title, matching the PRD feature heading>",
      "status": "met" | "unmet" | "uncertain",
      "evidence": "<file:line or test name proving it>" }
  ]
}

Verdict rules:
  - "done" ONLY when ALL requirements are "met" AND the fresh tests are green
    (or there is no test runner and you can cite concrete code evidence for
    every requirement).
  - "incomplete" when one or more requirements are "unmet".
  - "inconclusive" when you cannot establish ground truth.
No emojis. No em dashes.

=== PRD (the requirements to verify) ===
%s

=== FRESH TEST RESULTS (re-run now; authoritative for the test axis) ===
%s

=== PRIOR CLAIMS (possibly stale; verify, do not trust) ===
completion.json:
%s
completion-evidence.md:
%s
checklist.json:
%s
""" % (prd, tests or "(no test results captured)",
       completion or "(none)", evidence or "(none)", checklist or "(none)")

sys.stdout.write(prompt)
DR_PROMPT_EOF
)

    # Empty payload (unreadable/empty PRD) -> inconclusive -> build.
    if [ -z "$prompt" ]; then
        log_info "Done-recognition: could not build a verification payload; proceeding to build."
        return 1
    fi

    # --- The single model call (the mockable seam) ---------------------------
    local response
    response=$(_loki_done_recog_invoke "$prompt") || {
        log_info "Done-recognition: model verification unavailable (timeout/error); proceeding to build."
        return 1
    }
    if [ -z "$response" ]; then
        log_info "Done-recognition: empty verification response; proceeding to build."
        return 1
    fi

    # --- Parse + DEFENSIVELY re-derive the verdict (never trust top-line) ----
    # The python parser slices first '{' to last '}' (tolerate prose/fences),
    # re-derives the verdict from the per-requirement statuses + fresh test
    # axis, and emits a compact result the bash side routes on. `update` action
    # may NEVER yield a fast-stop done: it is forced to "incomplete" when the
    # model said done (downgraded to inconclusive if no requirement is met).
    local parsed
    parsed=$(LOKI_DR_RESP="$response" \
             LOKI_DR_TESTS="$_test_results" \
             LOKI_DR_ACTION="$action" \
             python3 << 'DR_PARSE_EOF'
import json, os, sys

resp = os.environ.get("LOKI_DR_RESP", "")
action = os.environ.get("LOKI_DR_ACTION", "")
tests_path = os.environ.get("LOKI_DR_TESTS", "")

def parse_object(text):
    try:
        v = json.loads(text)
        if isinstance(v, dict):
            return v
    except Exception:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        v = json.loads(text[start:end + 1])
        return v if isinstance(v, dict) else None
    except Exception:
        return None

obj = parse_object(resp)
if obj is None:
    print(json.dumps({"verdict": "inconclusive", "reason": "unparsable verdict",
                      "summary": "", "satisfied": []}))
    sys.exit(0)

reqs = obj.get("requirements")
if not isinstance(reqs, list):
    reqs = []

statuses = []
satisfied = []
for r in reqs:
    if not isinstance(r, dict):
        continue
    st = str(r.get("status", "")).strip().lower()
    title = (r.get("title") or "").strip()
    statuses.append(st)
    if st == "met" and title:
        satisfied.append(title)

# Fresh-test axis: authoritative. Read the persisted test-results.json and
# decide green/red/unknown INDEPENDENTLY of the model's self-report.
def tests_axis(path):
    try:
        with open(path, "r") as f:
            d = json.load(f)
    except Exception:
        return "unknown"  # no runner / no file -> not authoritative
    if not isinstance(d, dict):
        return "unknown"
    # Common shapes: {"failed": N}, {"passed":P,"total":T}, {"status":"pass"}.
    failed = d.get("failed")
    if isinstance(failed, int):
        return "green" if failed == 0 else "red"
    status = str(d.get("status", "")).strip().lower()
    if status in ("pass", "passed", "green", "ok", "success"):
        return "green"
    if status in ("fail", "failed", "red", "error"):
        return "red"
    passed = d.get("passed")
    total = d.get("total")
    if isinstance(passed, int) and isinstance(total, int) and total > 0:
        return "green" if passed >= total else "red"
    return "unknown"

axis = tests_axis(tests_path)

all_met = len(statuses) > 0 and all(s == "met" for s in statuses)
any_unmet = any(s == "unmet" for s in statuses)
any_met = any(s == "met" for s in statuses)

# Defensive re-derivation (do NOT trust obj["verdict"] blindly).
# done requires: all requirements met AND tests not red. If there is no test
# runner (axis unknown) the model may still establish done by code evidence,
# but a RED axis hard-blocks done (no fake-green).
if all_met and axis != "red":
    verdict = "done"
elif any_unmet or (any_met and not all_met):
    verdict = "incomplete"
elif all_met and axis == "red":
    # Model claimed everything met but fresh tests are red -> downgrade.
    verdict = "incomplete"
else:
    verdict = "inconclusive"

# The `update` action's PRD is stale by definition; a fast-stop done is a
# false-stop risk. Force done -> incomplete (incremental) when any requirement
# is met, else inconclusive. NEVER a fast-stop on update.
if action == "update" and verdict == "done":
    verdict = "incomplete" if any_met else "inconclusive"

reason = ""
if verdict == "inconclusive":
    if not statuses:
        reason = "no per-requirement evidence returned"
    elif axis == "red":
        reason = "fresh tests are red"
    else:
        reason = "could not establish ground truth"

# On incomplete we only trust the met set when the tests are not red; a red
# suite means even "met" claims are unverified, so the manifest stays empty
# (rebuild everything) rather than risk skipping broken work.
if verdict == "incomplete" and axis == "red":
    satisfied = []

print(json.dumps({
    "verdict": verdict,
    "summary": (obj.get("summary") or "").strip(),
    "reason": reason,
    "tests_axis": axis,
    "met_count": len([s for s in statuses if s == "met"]),
    "total_count": len(statuses),
    "satisfied": satisfied,
}))
DR_PARSE_EOF
)

    if [ -z "$parsed" ]; then
        log_info "Done-recognition: verdict parse produced no result; proceeding to build."
        return 1
    fi

    local verdict
    verdict=$(printf '%s' "$parsed" | python3 -c "import json,sys;print(json.load(sys.stdin).get('verdict',''))" 2>/dev/null)

    case "$verdict" in
        done)
            _loki_done_recog_finish "$prd_path" "$parsed"
            return 0
            ;;
        incomplete)
            _loki_done_recog_write_manifest "$prd_path" "$parsed"
            return 1
            ;;
        *)
            local _reason
            _reason=$(printf '%s' "$parsed" | python3 -c "import json,sys;print(json.load(sys.stdin).get('reason','') or 'unverifiable')" 2>/dev/null)
            log_info "Done-recognition: could not confirm the existing code already satisfies the reused spec (${_reason}). Proceeding to build to be safe."
            return 1
            ;;
    esac
}

# done path: refresh the verified-completion record (gate-owned, so it is
# deterministic even when sourced standalone in tests) and run the council-parity
# finalization subset (all type-guarded best-effort). The caller's `return 0`
# then skips the queue/loop, and main()'s terminal block finalizes the run.
_loki_done_recog_finish() {
    local prd_path="$1"
    local parsed="$2"
    local loki_dir="${TARGET_DIR:-.}/.loki"

    # The gate runs EARLY in run_autonomous, before the run normally mints these
    # run-scoped ids/baselines (run.sh sets them just after this call site). The
    # council-parity finalizers below (and what they transitively call) expect
    # them. run.sh is under `set -u`, so mint/guard them here if-absent so a real
    # done verdict never references an unbound var. Idempotent: := only sets when
    # unset, so this never clobbers a value the run already minted. The if-absent
    # trust-run-id mint is exactly the ordering fix the plan prescribes (no
    # hoisting of run.sh's existing block, keeping the change localized).
    if [ -z "${LOKI_TRUST_RUN_ID:-}" ] && type _loki_trust_run_id >/dev/null 2>&1; then
        LOKI_TRUST_RUN_ID="$(_loki_trust_run_id --new 2>/dev/null || echo "")"
        export LOKI_TRUST_RUN_ID
    fi
    : "${LOKI_TRUST_RUN_ID:=}"
    : "${_LOKI_RUN_START_SHA:=}"
    : "${_LOKI_RUN_START_EPOCH:=$(date +%s 2>/dev/null || echo 0)}"
    export LOKI_TRUST_RUN_ID _LOKI_RUN_START_SHA _LOKI_RUN_START_EPOCH

    mkdir -p "$loki_dir/state" 2>/dev/null || true

    local summary met total
    summary=$(printf '%s' "$parsed" | python3 -c "import json,sys;print(json.load(sys.stdin).get('summary','') or 'Project already satisfies its spec.')" 2>/dev/null)
    met=$(printf '%s' "$parsed" | python3 -c "import json,sys;print(json.load(sys.stdin).get('met_count',0))" 2>/dev/null)
    total=$(printf '%s' "$parsed" | python3 -c "import json,sys;print(json.load(sys.stdin).get('total_count',0))" 2>/dev/null)
    [ -n "$met" ] || met=0
    [ -n "$total" ] || total=0

    # Refresh the verified-completion record reflecting the NOW re-run results.
    # Prefer the shared standalone writer (one writer, no divergence). It reads
    # git/state, not loop locals, so it is safe at this pre-loop site. Wrapped
    # type-guarded so the standalone test (no run.sh) still works.
    if type build_completion_summary >/dev/null 2>&1; then
        build_completion_summary complete || true
    fi

    # Gate-owned durable artifacts (always written, so the receipt + dashboard
    # reflect THIS verified-done verdict and tests are deterministic). The
    # per-requirement evidence is recorded as the completion-evidence body.
    local ts
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    {
        echo "# Completion Evidence (reuse done-recognition)"
        echo ""
        echo "Generated: $ts"
        echo ""
        echo "Verdict: done (model-verified against re-run tests + code inspection)"
        echo "Requirements met: ${met}/${total}"
        echo ""
        echo "Summary: $summary"
        echo ""
        echo "## Per-requirement evidence"
        echo ""
        printf '%s' "$parsed" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for t in d.get('satisfied', []):
    print('- met: %s' % t)
" 2>/dev/null || true
    } > "$loki_dir/completion-evidence.md" 2>/dev/null || true

    # Refresh completion.json INLINE (gate-owned), guaranteeing the durable
    # machine-readable record exists with this verdict even when sourced
    # standalone. Atomic write.
    LOKI_DR_OUT="$loki_dir/state/completion.json" \
    LOKI_DR_SUMMARY="$summary" \
    LOKI_DR_MET="$met" \
    LOKI_DR_TOTAL="$total" \
    LOKI_DR_TS="$ts" \
    python3 -c "
import json, os, tempfile
out = os.environ['LOKI_DR_OUT']
def i(v):
    try: return int(v)
    except (TypeError, ValueError): return 0
rec = {
    'outcome': 'complete',
    'source': 'reuse-done-recognition',
    'verdict': 'done',
    'summary': os.environ.get('LOKI_DR_SUMMARY', ''),
    'requirements_met': i(os.environ.get('LOKI_DR_MET')),
    'requirements_total': i(os.environ.get('LOKI_DR_TOTAL')),
    'verified_at': os.environ.get('LOKI_DR_TS', ''),
}
d = os.path.dirname(os.path.abspath(out)) or '.'
try:
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.completion-', suffix='.json')
    with os.fdopen(fd, 'w') as f:
        json.dump(rec, f, indent=2)
    os.replace(tmp, out)
except Exception:
    pass
" 2>/dev/null || true

    # COMPLETED marker (gate-owned; idempotent overwrite, precedented by the
    # council force-approve path at run.sh:17692). main() also writes it.
    echo "Project already satisfied its spec (reuse done-recognition) at $ts" \
        > "$loki_dir/COMPLETED" 2>/dev/null || true

    # Council-parity finalization subset (mirrors run.sh:17693-17703). All
    # type-guarded so the standalone test needs zero stubs; production gets full
    # parity. main() owns _advance_current_phase COMPLETED + proof + handoff.
    type council_write_report >/dev/null 2>&1 && council_write_report || true
    type run_memory_consolidation >/dev/null 2>&1 && run_memory_consolidation || true
    type on_run_complete >/dev/null 2>&1 && on_run_complete || true
    type emit_completion_summary >/dev/null 2>&1 && emit_completion_summary complete || true
    type save_state >/dev/null 2>&1 && save_state "${RETRY_COUNT:-0}" "reuse_already_satisfied" 0 || true

    # User-facing message (enterprise UX). The last line names BOTH escape
    # hatches so a user who WANTS to extend a done project sees them unmissably.
    log_header "This project already satisfies its spec. Nothing to build." 2>/dev/null \
        || log_info "This project already satisfies its spec. Nothing to build."
    log_info "Verified ${met}/${total} requirements met and re-ran the tests now. ${summary}"
    log_info "To rebuild from scratch run 'loki start --fresh-prd'; to extend it, edit the spec or pass a new/changed PRD."
}

# incomplete path: write the satisfied-requirements manifest so
# populate_prd_queue skips already-met features. prd_sha-guarded; keyed on
# feature TITLE (matched case-insensitively in the builder).
_loki_done_recog_write_manifest() {
    local prd_path="$1"
    local parsed="$2"
    local loki_dir="${TARGET_DIR:-.}/.loki"

    mkdir -p "$loki_dir/state" 2>/dev/null || true

    local prd_sha
    prd_sha=$(_loki_done_recog_prd_sha "$prd_path")
    local ts
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    LOKI_DR_OUT="$loki_dir/state/satisfied-requirements.json" \
    LOKI_DR_PARSED="$parsed" \
    LOKI_DR_SHA="$prd_sha" \
    LOKI_DR_TS="$ts" \
    python3 -c "
import json, os, sys, tempfile
out = os.environ['LOKI_DR_OUT']
try:
    parsed = json.loads(os.environ.get('LOKI_DR_PARSED', '{}'))
except Exception:
    parsed = {}
satisfied = parsed.get('satisfied', [])
if not isinstance(satisfied, list):
    satisfied = []
rec = {
    'prd_sha': os.environ.get('LOKI_DR_SHA', ''),
    'generated_at': os.environ.get('LOKI_DR_TS', ''),
    'satisfied': [s for s in satisfied if isinstance(s, str) and s.strip()],
    'source': 'reuse-done-recognition',
}
d = os.path.dirname(os.path.abspath(out)) or '.'
try:
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.satisfied-', suffix='.json')
    with os.fdopen(fd, 'w') as f:
        json.dump(rec, f, indent=2)
    os.replace(tmp, out)
except Exception:
    pass
" 2>/dev/null || true

    local met total
    met=$(printf '%s' "$parsed" | python3 -c "import json,sys;print(json.load(sys.stdin).get('met_count',0))" 2>/dev/null)
    total=$(printf '%s' "$parsed" | python3 -c "import json,sys;print(json.load(sys.stdin).get('total_count',0))" 2>/dev/null)
    local unmet=$(( ${total:-0} - ${met:-0} ))
    log_info "Done-recognition: ${met:-0} of ${total:-0} requirements already satisfied; building only the ${unmet} unmet. Pass --fresh-prd to rebuild from scratch."
}
