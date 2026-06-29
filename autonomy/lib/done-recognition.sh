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
             LOKI_DR_PRD="$prd_path" \
             python3 << 'DR_PARSE_EOF'
import json, os, re, sys

resp = os.environ.get("LOKI_DR_RESP", "")
action = os.environ.get("LOKI_DR_ACTION", "")
tests_path = os.environ.get("LOKI_DR_TESTS", "")
prd_path = os.environ.get("LOKI_DR_PRD", "")

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
    # PRODUCTION shapes first (enforce_test_coverage in run.sh writes these):
    #   real runner green : {"pass": true,  "status": "verified", "exit_code": 0}
    #   real runner red   : {"pass": false, "status": "failed",   "exit_code": 1}
    #   no runner         : {"pass": "inconclusive", "status": "not_run", "runner": "none"}
    status = str(d.get("status", "")).strip().lower()
    if status in ("not_run", "skipped", "none", "inconclusive"):
        return "unknown"  # no authoritative run happened
    # exit_code is the most authoritative red signal when present and numeric.
    ec = d.get("exit_code")
    if isinstance(ec, bool):
        ec = None  # guard: bool is an int subclass; do not treat true/false as 0/1
    if isinstance(ec, int):
        if ec != 0:
            return "red"
        # exit 0 alone is green only if nothing else contradicts it (checked below).
    p = d.get("pass")
    if p is True:
        # A clean pass:true with no contradicting red signal is authoritative green.
        if d.get("failed") in (None, 0) and (ec in (None, 0)):
            return "green"
    if p is False:
        return "red"
    # Legacy / generic shapes.
    failed = d.get("failed")
    if isinstance(failed, int):
        return "green" if failed == 0 else "red"
    if status in ("pass", "passed", "green", "ok", "success", "verified"):
        return "green"
    if status in ("fail", "failed", "red", "error"):
        return "red"
    passed = d.get("passed")
    total = d.get("total")
    if isinstance(passed, int) and isinstance(total, int) and total > 0:
        return "green" if passed >= total else "red"
    # exit_code 0 with no other signal: treat as green (a runner ran and succeeded).
    if isinstance(ec, int) and ec == 0:
        return "green"
    return "unknown"

axis = tests_axis(tests_path)

# Requirement COVERAGE guard (deterministic, NEGATIVE-only: it can only route
# toward build, never toward done). The model returning "all met" over a SUBSET
# of the PRD is a fake-green: it silently declares unbuilt features satisfied.
# So we independently parse the PRD's feature/requirement titles and require the
# model to have COVERED every one. Any PRD title the model did not return a
# status for -> coverage gap -> done is not trustworthy.
def _norm_title(t):
    t = (t or "").strip().lower()
    # Mirror the populate_prd_queue normalization: drop a leading
    # "feature:"/"requirement:" label and surrounding markdown/heading marks.
    t = re.sub(r"^\s*(?:feature|requirement)\s*[:\-]\s*", "", t)
    t = re.sub(r"^[#\s>*\-]+", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t

def prd_feature_titles(path):
    """Best-effort PRD feature/requirement titles. Honest: returns None when we
    cannot reliably enumerate (so the guard does NOT fire on an unparseable PRD
    and wrongly block a real done -- it only fires when we DO know the set)."""
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", errors="replace") as f:
            raw = f.read()
    except Exception:
        return None
    if not raw.strip():
        return None
    titles = []
    # JSON PRD: collect "title"/"name"/"feature"/"requirement" values.
    try:
        d = json.loads(raw)
        def walk(o):
            if isinstance(o, dict):
                for k, v in o.items():
                    if k in ("title", "name", "feature", "requirement") and isinstance(v, str) and v.strip():
                        titles.append(v)
                    else:
                        walk(v)
            elif isinstance(o, list):
                for it in o:
                    walk(it)
        walk(d)
        if titles:
            return [_norm_title(t) for t in titles if _norm_title(t)]
    except Exception:
        pass
    # Markdown PRD. Loki's OWN generated PRDs (the canonical reuse target, written
    # by the codebase-analysis prompt) do NOT use "## Feature:" markers -- they use
    # sections like "## Existing Behavior and Requirements" with bullet items. So
    # we must enumerate from multiple shapes, not just an explicit Feature: label:
    #   - explicit "Feature:"/"Requirement:" lines (any depth)
    #   - bullet/numbered requirement items under a requirements-like section
    #   - sub-section headings (### ...) that name a discrete capability
    # A bare top-level document title (the single "# Title" line) is excluded.
    REQ_SECTION = re.compile(r"requirement|feature|behavior|capabilit|user stor|acceptance", re.I)
    NON_FEATURE = ("overview", "summary", "prd", "spec", "requirements", "features",
                   "scope", "goals", "detected stack", "stack", "non-goals",
                   "out of scope", "context", "background", "existing behavior and requirements")
    in_req_section = False
    for line in raw.splitlines():
        s = line.strip()
        if not s:
            continue
        # Explicit label anywhere.
        m = re.match(r"^(?:[#>*\-\d.\s]+)?(?:feature|requirement)\s*[:\-]\s+(.+)$", s, re.I)
        if m:
            n = _norm_title(m.group(1))
            if n and n not in NON_FEATURE:
                titles.append(n)
            continue
        # Section heading: track whether we are inside a requirements-like section.
        hm = re.match(r"^#{1,6}\s+(.+)$", s)
        if hm:
            head = _norm_title(hm.group(1))
            in_req_section = bool(REQ_SECTION.search(head))
            # A discrete sub-section heading (###+) that is not a known non-feature
            # label is itself a feature title.
            if re.match(r"^#{3,6}\s+", s) and head and head not in NON_FEATURE:
                titles.append(head)
            continue
        # Bullet / numbered item inside a requirements-like section is a requirement.
        if in_req_section:
            bm = re.match(r"^(?:[-*+]|\d+[.)])\s+(.+)$", s)
            if bm:
                n = _norm_title(bm.group(1))
                # Keep it short-ish (a requirement line, not a paragraph) and real.
                if n and n not in NON_FEATURE and len(n) <= 200:
                    titles.append(n)
    # Dedup, preserve order.
    seen = set(); uniq = []
    for t in titles:
        if t not in seen:
            seen.add(t); uniq.append(t)
    return uniq if uniq else None

all_met = len(statuses) > 0 and all(s == "met" for s in statuses)
any_unmet = any(s == "unmet" for s in statuses)
any_met = any(s == "met" for s in statuses)

# Coverage check: did the model address every PRD feature? If the PRD set is
# known and the model omitted any of it, the "all met" is over a subset -> not
# trustworthy as done.
_prd_titles = prd_feature_titles(prd_path)
_covered = set(_norm_title(t) for t in (
    (r.get("title") or "") for r in reqs if isinstance(r, dict)
) if _norm_title(t))
# coverage_gap is True when we KNOW the model under-enumerated the spec.
# coverage_unknown is True when we could NOT enumerate the PRD at all -- in which
# case we CANNOT trust a done (a wrong done burns trust; a wrong incomplete only
# costs a rebuild). Per the NEGATIVE-only-fast-path rule, an inability to verify
# coverage must block done, never enable it.
coverage_gap = False
coverage_unknown = _prd_titles is None
if _prd_titles is not None:
    _missing = [t for t in set(_prd_titles) if t not in _covered]
    coverage_gap = len(_missing) > 0

# The model's own top-line verdict. It is NECESSARY-but-not-sufficient for done:
# the defensive re-derivation can only ever DOWNGRADE from it, never upgrade. If
# the model itself did not say done (inconclusive/incomplete), we must not fast-
# stop even when the per-requirement breakdown looks all-met -- that would
# override the model's explicit negative judgment (critical-check-1: inconclusive
# falls through to build; critical-check-2: the positive decision is the model's,
# never a deterministic all-met=>done shortcut).
obj_verdict = str(obj.get("verdict", "")).strip().lower()
model_says_done = obj_verdict == "done"

# Defensive re-derivation: the model must say done AND every objective guard must
# pass. done requires: model top-line done AND all requirements met AND tests not
# red AND no coverage gap/unknown. Any guard failing downgrades (never upgrades).
if model_says_done and all_met and axis != "red" and not coverage_gap and not coverage_unknown:
    verdict = "done"
elif model_says_done and coverage_unknown and all_met and axis != "red":
    # Even with a model 'done', if we cannot enumerate the PRD to confirm full
    # coverage, route to inconclusive -> build (no fake-green over an unverifiable
    # spec). Handled by the coverage_unknown branch below; fall through.
    verdict = "inconclusive"
elif all_met and axis != "red" and not coverage_gap and not coverage_unknown and not model_says_done:
    # Per-requirement breakdown looks complete but the MODEL did not declare done
    # (it said inconclusive/incomplete). Respect the model: do not fast-stop.
    verdict = "inconclusive"
elif coverage_unknown and all_met and axis != "red":
    # We could not enumerate the PRD to confirm the model covered all of it. A
    # done over an unverifiable spec is a fake-green risk (the model may have
    # addressed a subset). Route to inconclusive -> build, never a fast-stop.
    verdict = "inconclusive"
elif coverage_gap and all_met and axis != "red":
    # Model reported all-met but did not cover every PRD feature -> it declared a
    # SUBSET done. Never a fast-stop on partial coverage (no fake-green). The met
    # subset can still seed an incremental build of the omitted features.
    verdict = "incomplete"
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
    "prd_feature_count": (len(set(_prd_titles)) if _prd_titles is not None else None),
    "coverage_gap": coverage_gap,
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

    local summary met total axis
    summary=$(printf '%s' "$parsed" | python3 -c "import json,sys;print(json.load(sys.stdin).get('summary','') or 'Project already satisfies its spec.')" 2>/dev/null)
    met=$(printf '%s' "$parsed" | python3 -c "import json,sys;print(json.load(sys.stdin).get('met_count',0))" 2>/dev/null)
    total=$(printf '%s' "$parsed" | python3 -c "import json,sys;print(json.load(sys.stdin).get('total_count',0))" 2>/dev/null)
    axis=$(printf '%s' "$parsed" | python3 -c "import json,sys;print(json.load(sys.stdin).get('tests_axis','unknown'))" 2>/dev/null)
    [ -n "$met" ] || met=0
    [ -n "$total" ] || total=0
    [ -n "$axis" ] || axis="unknown"
    # HONESTY: the receipt must only claim test-backing the gate actually computed.
    # A green axis means fresh tests ran AND passed now; otherwise the basis is
    # code inspection alone (no runner / inconclusive) -- never overclaim.
    local verify_basis
    if [ "$axis" = "green" ]; then
        verify_basis="re-ran the tests now (passed) and code inspection"
    else
        verify_basis="code inspection (no passing test run was available to confirm)"
    fi

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
        echo "Verdict: done (basis: ${verify_basis})"
        echo "Requirements met: ${met}/${total}"
        echo "Fresh-test axis: ${axis}"
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
    if [ "$axis" = "green" ]; then
        log_info "Verified ${met}/${total} requirements met and re-ran the tests now (passed). ${summary}"
    else
        log_info "Verified ${met}/${total} requirements met by code inspection (no passing test run was available to confirm). ${summary}"
    fi
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

    # The satisfied-requirements manifest is read by populate_prd_queue's
    # incremental skip-filter -- but populate_prd_queue early-returns when a stale
    # .prd-populated marker from the PRIOR (completed) run still exists, never
    # reaching the filter. Clear that marker (and reset the pending queue) so the
    # incremental rebuild actually runs and skips the satisfied features. Without
    # this, the founder-locked "build only the unsatisfied gap" behavior is inert.
    rm -f ".loki/queue/.prd-populated" 2>/dev/null || true
    if [ -f ".loki/queue/pending.json" ]; then
        # Drop prior PRD-sourced tasks so the incremental pass is the source of
        # truth; non-PRD tasks (if any) are preserved.
        python3 - <<'RESET_EOF' 2>/dev/null || true
import json, os, tempfile
p = ".loki/queue/pending.json"
try:
    with open(p) as f:
        data = json.load(f)
except Exception:
    raise SystemExit(0)
tasks = data.get("tasks", data) if isinstance(data, dict) else data
if isinstance(tasks, list):
    kept = [t for t in tasks if not (isinstance(t, dict) and str(t.get("id", "")).startswith("prd-"))]
    if isinstance(data, dict):
        data["tasks"] = kept
    else:
        data = kept
    d = os.path.dirname(os.path.abspath(p)) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".pending-", suffix=".json")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, p)
RESET_EOF
    fi

    local met total
    met=$(printf '%s' "$parsed" | python3 -c "import json,sys;print(json.load(sys.stdin).get('met_count',0))" 2>/dev/null)
    total=$(printf '%s' "$parsed" | python3 -c "import json,sys;print(json.load(sys.stdin).get('total_count',0))" 2>/dev/null)
    local unmet=$(( ${total:-0} - ${met:-0} ))
    log_info "Done-recognition: ${met:-0} of ${total:-0} requirements already satisfied; building only the ${unmet} unmet. Pass --fresh-prd to rebuild from scratch."
}
