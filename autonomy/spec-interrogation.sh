#!/usr/bin/env bash
# autonomy/spec-interrogation.sh - P2-1 spec interrogation + P2-2 assumption ledger.
#
# Net-new spec-robustness capability. Loki stays accurate even when the input
# spec is WRONG, ambiguous, or incomplete by DETECTING spec defects in the
# DISCOVERY phase and SURFACING them as first-class RECORDED ASSUMPTIONS, never
# silently autocorrecting.
#
# It reuses two existing building blocks unchanged:
#   - autonomy/grill.sh         the Devil's-Advocate spec interrogation (provider
#                               subcall) that writes .loki/grill/report.md.
#   - autonomy/prd-analyzer.py  deterministic missing-dimension detection that
#                               already generates assumption text (_make_assumption).
#
# This module:
#   1. classifies grill's report.md into structured findings
#      (ambiguous / contradictory / underspecified / missing) with a
#      deterministic severity (high / medium) -- NO LLM, reproducible.
#   2. records each spec gap as a first-class ledger entry under .loki/assumptions/.
#   3. exposes spec_ledger_high_unresolved_count for the completion gate
#      (council_assumption_ledger_gate in completion-council.sh).
#
# Design note (auto-acknowledgment lifecycle):
#   The completion gate blocks iff an entry is severity=high AND confirmed=false
#   AND acknowledged=false. In autonomous (non-TTY) mode no human can ever set
#   confirmed=yes, so the auto-acknowledgment lifecycle (run.sh) marks an
#   assumption acknowledged once it has been injected into the build prompt at
#   least once. That is the OPPOSITE of silent autocorrect: the gap is recorded,
#   prompt-injected, and surfaced in proof-of-done. LOKI_ASSUMPTIONS_REQUIRE_CONFIRM=1
#   disables auto-ack for a human-in-the-loop path (only confirmed=true clears).
#
# Design note (P2-4 contradictions -- the exception to the lifecycle above):
#   A GAP can become a recorded assumption: "the spec is silent, so I took the
#   implementer default." A CONTRADICTION cannot -- there is no default that
#   satisfies "X and not-X". So a contradiction (class=contradictory, forced to
#   severity=high) is NEVER auto-acknowledged, even in default autonomous mode
#   (spec_ledger_acknowledge_all skips it). It stays acknowledged=false and keeps
#   the completion gate BLOCKED until a human sets confirmed=true. We chose this
#   "block, do not assume away" behavior over the softer "auto-ack but surface
#   loudly" option because a silently-acked contradiction lets "done" be declared
#   over a spec we know is internally inconsistent, which is exactly the
#   accuracy failure this feature exists to prevent. Honest cost: in a fully
#   autonomous run an unresolved contradiction grinds the loop to max-iterations
#   (no human to confirm), wasting budget. It is STILL surfaced in proof-of-done
#   on every terminal path. Escape hatches: a human sets confirmed=true in
#   .loki/assumptions/, or the operator sets LOKI_ASSUMPTION_GATE=0. A follow-up
#   in run.sh (out of this module's scope) should add an early hard-stop on an
#   unresolved contradiction so the run fails fast instead of grinding.
#   Contradictions come from two sources: spec-INTERNAL (grill finds them, the
#   classifier tags them) and spec-EXTERNAL (spec_interrogation_external_check
#   compares the spec to the repo's declared dependencies; narrow + high-
#   confidence by design).
#
# Provider-aware + clean degrade: grill needs a provider CLI; when absent we log
# an honest message, skip the grill subcall (NO fabricated questions), but STILL
# fold prd-analyzer's deterministic missing-dimension assumptions into the ledger
# as medium (non-blocking) so degrade still surfaces something.
#
# Opt-out knobs (all default-on):
#   LOKI_SPEC_GRILL=0                  skip interrogation entirely
#   LOKI_ASSUMPTION_GATE=0            completion gate is pass-through (gate file)
#   LOKI_ASSUMPTIONS_REQUIRE_CONFIRM=1  require human confirmed=true (no auto-ack)
#   LOKI_SPEC_EXTERNAL_CHECK=0       skip the spec-vs-repo external contradiction check

set -uo pipefail

# ---------------------------------------------------------------------------
# Logging shims. run.sh provides log_* helpers; when sourced standalone (tests,
# direct invocation) fall back to stderr so the module is self-contained.
# ---------------------------------------------------------------------------
if ! type log_info >/dev/null 2>&1; then
    log_info()    { printf '%s\n' "$*" >&2; }
fi
if ! type log_warn >/dev/null 2>&1; then
    log_warn()    { printf '[warn] %s\n' "$*" >&2; }
fi
if ! type log_step >/dev/null 2>&1; then
    log_step()    { printf '%s\n' "$*" >&2; }
fi

SPEC_LEDGER_DIR_DEFAULT=".loki/assumptions"

# Resolve the ledger directory (respects TARGET_DIR like the rest of the runner).
_spec_ledger_dir() {
    printf '%s/%s' "${TARGET_DIR:-.}" "$SPEC_LEDGER_DIR_DEFAULT"
}

# ---------------------------------------------------------------------------
# Deterministic severity for a grill finding given its section + line text.
# HIGH: security / scale / reliability / missing-or-untestable acceptance
#       criteria / explicit contradiction. MEDIUM: everything else.
# Echoes "high" or "medium".
# ---------------------------------------------------------------------------
spec_interrogation_severity_for() {
    local section="$1"
    local line="$2"
    local lc_section lc_line
    lc_section="$(printf '%s' "$section" | tr '[:upper:]' '[:lower:]')"
    lc_line="$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')"

    # Explicit contradiction keywords escalate to high regardless of section.
    case "$lc_line" in
        *contradict*|*conflict*|*inconsistent*|*mutually\ exclusive*)
            printf 'high'; return 0 ;;
    esac

    # P2-4: a "Contradictions" SECTION escalates to high even when the line has
    # no contradiction keyword. Keyword-only detection would silently miss a
    # contradiction phrased plainly ("section 2 mandates immutable records;
    # section 5 specifies an edit endpoint."), which is exactly the failure P2-4
    # exists to prevent -- and the grill-prompt follow-up that adds a
    # "Contradictions" section would emit such keyword-free findings.
    case "$lc_section" in
        *contradiction*|*contradictor*)
            printf 'high'; return 0 ;;
    esac

    # Section-driven severity.
    case "$lc_section" in
        *security*|*scale*|*reliability*)
            printf 'high'; return 0 ;;
    esac

    # Missing or untestable acceptance criteria are high (cannot verify done).
    case "$lc_line" in
        *acceptance\ criteria*|*acceptance\ criterion*|*testable*|*measurable*|*definition\ of\ done*)
            printf 'high'; return 0 ;;
    esac

    printf 'medium'
}

# ---------------------------------------------------------------------------
# Map a grill section heading to a finding class.
# Echoes one of: ambiguous | contradictory | underspecified | missing
# (contradictory is also forced at line level when a contradiction keyword hits).
# ---------------------------------------------------------------------------
spec_interrogation_class_for() {
    local section="$1"
    local line="$2"
    local lc_section lc_line
    lc_section="$(printf '%s' "$section" | tr '[:upper:]' '[:lower:]')"
    lc_line="$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')"

    case "$lc_line" in
        *contradict*|*conflict*|*inconsistent*|*mutually\ exclusive*)
            printf 'contradictory'; return 0 ;;
    esac

    # P2-4: a "Contradictions" SECTION tags its findings contradictory even when
    # the line carries no contradiction keyword (see severity_for for rationale).
    case "$lc_section" in
        *contradiction*|*contradictor*)
            printf 'contradictory'; return 0 ;;
    esac

    case "$lc_section" in
        *security*|*scale*|*reliability*) printf 'missing'; return 0 ;;
        *unstated\ assumption*)           printf 'underspecified'; return 0 ;;
        *ambiguit*|*acceptance*)          printf 'ambiguous'; return 0 ;;
    esac
    printf 'ambiguous'
}

# ---------------------------------------------------------------------------
# Map a grill section heading to an "affects" area for the ledger.
# ---------------------------------------------------------------------------
_spec_affects_for() {
    local section="$1"
    local lc_section
    lc_section="$(printf '%s' "$section" | tr '[:upper:]' '[:lower:]')"
    case "$lc_section" in
        *security*)              printf 'security' ;;
        *scale*|*reliability*)   printf 'scale-reliability' ;;
        *acceptance*|*ambiguit*) printf 'acceptance-criteria' ;;
        *unstated\ assumption*)  printf 'requirements' ;;
        *)                       printf 'requirements' ;;
    esac
}

# ---------------------------------------------------------------------------
# Stable, dedupe-safe id for a gap: a-<8 hex of the gap text>.
# Idempotent: the same gap text always yields the same id, so re-running
# DISCOVERY does not duplicate ledger entries.
# ---------------------------------------------------------------------------
_spec_gap_id() {
    local gap="$1"
    local h
    if command -v shasum >/dev/null 2>&1; then
        h="$(printf '%s' "$gap" | shasum 2>/dev/null | cut -c1-8)"
    elif command -v sha1sum >/dev/null 2>&1; then
        h="$(printf '%s' "$gap" | sha1sum 2>/dev/null | cut -c1-8)"
    else
        # cksum fallback (always present): pad/truncate to 8 chars.
        h="$(printf '%s' "$gap" | cksum 2>/dev/null | cut -d' ' -f1)"
        h="$(printf '%08x' "${h:-0}" 2>/dev/null | cut -c1-8)"
    fi
    printf 'a-%s' "${h:-00000000}"
}

# ---------------------------------------------------------------------------
# Write (or skip-if-present) one ledger entry.
# Usage: spec_ledger_write <gap> <assumption> <why> <severity> <class> <affects> <source>
# Idempotent on the gap id. Returns 0 always (best-effort; never fails a run).
# ---------------------------------------------------------------------------
spec_ledger_write() {
    local gap="$1" assumption="$2" why="$3" severity="$4" class="$5" affects="$6" source="$7"
    local dir id file
    dir="$(_spec_ledger_dir)"
    mkdir -p "$dir" 2>/dev/null || return 0
    id="$(_spec_gap_id "$gap")"
    file="$dir/$id.json"
    # Idempotent: if this gap is already recorded, do not overwrite (preserves
    # any confirmed/acknowledged state set since).
    [ -f "$file" ] && return 0

    local ts
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")"
    _SL_ID="$id" _SL_GAP="$gap" _SL_ASSUMP="$assumption" _SL_WHY="$why" \
    _SL_SEV="$severity" _SL_CLASS="$class" _SL_AFFECTS="$affects" \
    _SL_SOURCE="$source" _SL_TS="$ts" _SL_FILE="$file" python3 -c '
import json, os, tempfile
rec = {
    "id":          os.environ["_SL_ID"],
    "gap":         os.environ["_SL_GAP"],
    "assumption":  os.environ["_SL_ASSUMP"],
    "why":         os.environ["_SL_WHY"],
    "severity":    os.environ["_SL_SEV"],
    "class":       os.environ["_SL_CLASS"],
    "affects":     os.environ["_SL_AFFECTS"],
    "source":      os.environ["_SL_SOURCE"],
    "confirmed":   False,
    "acknowledged": False,
    "created_at":  os.environ["_SL_TS"],
}
out = os.environ["_SL_FILE"]
d = os.path.dirname(out)
fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(rec, f, indent=2)
    os.replace(tmp, out)
except Exception:
    try: os.unlink(tmp)
    except OSError: pass
    raise
' 2>/dev/null || true
    return 0
}

# ---------------------------------------------------------------------------
# Classify a grill report.md into ledger entries.
# Usage: spec_interrogation_classify_report <report.md path>
# Pure: reads the markdown, writes ledger entries. No provider call. This is the
# function the test (a) drives with a fixture report.
# Returns 0 on success (including zero findings), 1 if the report is missing.
# ---------------------------------------------------------------------------
spec_interrogation_classify_report() {
    local report="$1"
    [ -f "$report" ] || return 1

    local section=""
    local line stripped q
    while IFS= read -r line || [ -n "$line" ]; do
        # Track the current "### Section" heading.
        case "$line" in
            "### "*)
                section="${line#"### "}"
                continue ;;
            "## "*)
                # A top-level heading (e.g. "## Grill findings") is not a finding
                # section; reset so stray numbered lines under it are ignored
                # until a real ### section starts.
                section=""
                continue ;;
        esac

        [ -z "$section" ] && continue

        # Finding lines look like "1. <question>" or "- <question>".
        case "$line" in
            [0-9]*". "*)
                q="${line#*. }" ;;
            "- "*)
                q="${line#- }" ;;
            *)
                continue ;;
        esac

        # Trim leading/trailing whitespace.
        stripped="$(printf '%s' "$q" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        [ -z "$stripped" ] && continue
        # Skip negative-result / clean-spec lines so a grill that honestly
        # reports "nothing found" never becomes a persisted finding (and, under
        # "### Contradictions", never deadlocks a clean spec to max-iterations).
        # Match a lowercased copy (bash 3.2 has no ${var,,}); write the original.
        # Patterns are START-anchored to whole-line negative phrasings so a real
        # finding that merely contains "no" (e.g. "no input validation on the
        # login endpoint") is NOT skipped.
        local stripped_lc
        stripped_lc="$(printf '%s' "$stripped" | tr '[:upper:]' '[:lower:]')"
        case "$stripped_lc" in
            "none"|"none."*|"none found"*|"none identified"*|\
            "no contradiction"*|"no issues"*|"no conflicts"*|"no problems"*|\
            "no concerns"*|"no gaps"*|"not applicable"*|"n/a"*) continue ;;
        esac

        local sev class affects assumption
        sev="$(spec_interrogation_severity_for "$section" "$stripped")"
        class="$(spec_interrogation_class_for "$section" "$stripped")"
        affects="$(_spec_affects_for "$section")"
        # No-fabrication: the finding is a QUESTION; the honest assumption is a
        # stated default, NOT an invented resolution the build will not follow.
        # P2-4: a CONTRADICTION is special. A gap can become a recorded
        # assumption (a stated default), but a contradiction CANNOT be assumed
        # away -- there is no consistent default for "X and not-X". So a
        # contradictory finding carries a contradiction-specific message instead
        # of the implementer-default text. This keeps spec_ledger_prompt_block
        # honest (it would otherwise instruct the build agent to "proceed with a
        # default" for something that has no consistent default) and makes the
        # ledger rollup state the truth: unresolvable by assumption, needs a
        # human.
        if [ "$class" = "contradictory" ]; then
            assumption="UNRESOLVED CONTRADICTION: the spec is internally inconsistent here and cannot be assumed away; a human must resolve it before this can be built correctly."
        else
            assumption="Spec gives no answer; proceeding with the implementer default for ${affects}."
        fi

        spec_ledger_write \
            "$stripped" \
            "$assumption" \
            "grill: ${section}" \
            "$sev" \
            "$class" \
            "$affects" \
            "grill"
    done < "$report"
    return 0
}

# ---------------------------------------------------------------------------
# P2-4 EXTERNAL contradiction check: spec vs existing code/config.
#
# A spec-internal contradiction is found by the grill (LLM) and recognized by
# the classifier above. An EXTERNAL contradiction is the spec disagreeing with
# the repo it is being built into (spec says Postgres, repo wired to Mongo).
#
# Design constraint -- PRECISION OVER RECALL (deliberate):
#   A contradiction is tagged high + contradictory and (per the auto-ack skip
#   above) BLOCKS completion until a human resolves it. In an autonomous run no
#   human is present, so a false positive grinds a GOOD spec to max-iterations.
#   That is a severe failure mode. A grep heuristic is far lower-confidence than
#   the LLM-identified internal contradictions feeding the same blocking path, so
#   this check fires ONLY on UNAMBIGUOUS POSITIVE-CONFLICT evidence and is happy
#   to miss real conflicts (low recall) rather than ever block a clean spec.
#
# Scope of THIS slice: database-engine conflict only -- the single signal where
# "what the spec names" and "what the repo is wired to" are both concretely
# detectable from declared dependencies. The trigger requires ALL FOUR:
#   1. the spec explicitly names database engine X, AND
#   2. a manifest (package.json / requirements.txt / go.mod / pyproject.toml /
#      Gemfile) declares a concrete driver for a DIFFERENT engine Y, AND
#   3. that same manifest declares NO driver for engine X, AND
#   4. the spec does NOT also name engine Y (if it names BOTH, the spec is
#      discussing the choice -- "we chose Mongo over Postgres" -- not in
#      conflict; skip rather than false-fire on a good spec).
# Bare prose substring matches in source files are intentionally NOT used (specs
# mention databases in passing; comments and migrations carry both drivers).
#
# Honest deferral: other external conflicts (REST-vs-gRPC, language/runtime,
# cloud provider) are NOT implemented here. They need a higher-confidence
# extractor than a single grep and are documented as the harder follow-up.
#
# Usage: spec_interrogation_external_check <spec_path>
# Best-effort; writes at most one contradiction ledger entry; never fails a run.
# ---------------------------------------------------------------------------
spec_interrogation_external_check() {
    local spec_path="${1:-}"
    [ -n "$spec_path" ] && [ -f "$spec_path" ] || return 0
    [ "${LOKI_SPEC_EXTERNAL_CHECK:-1}" = "0" ] && return 0

    local repo_root="${TARGET_DIR:-.}"

    # Collect declared-dependency manifest text (declarations only, not prose).
    local manifests="" m
    for m in \
        "$repo_root/package.json" \
        "$repo_root/requirements.txt" \
        "$repo_root/pyproject.toml" \
        "$repo_root/go.mod" \
        "$repo_root/Gemfile"; do
        [ -f "$m" ] && manifests="$manifests $m"
    done
    # No declared dependencies => no concrete repo signal => nothing to conflict.
    [ -n "$manifests" ] || return 0

    # Lowercase the spec body and the manifest text once.
    local spec_lc deps_lc
    spec_lc="$(tr '[:upper:]' '[:lower:]' < "$spec_path" 2>/dev/null)"
    # shellcheck disable=SC2086  # word-split of the manifest path list is intended
    deps_lc="$(cat $manifests 2>/dev/null | tr '[:upper:]' '[:lower:]')"
    [ -n "$spec_lc" ] && [ -n "$deps_lc" ] || return 0

    # Engine -> concrete driver-dependency token (a dependency name, not prose).
    # Keys are the engine names we look for in the SPEC; values are the package
    # tokens that prove the repo is wired to that engine.
    _spec_db_driver_token() {
        case "$1" in
            postgres) printf '%s' 'pg|psycopg|postgresql|asyncpg|node-postgres|sequelize-postgres|gorm.io/driver/postgres' ;;
            mongodb)  printf '%s' 'mongoose|pymongo|mongodb|motor|go.mongodb.org/mongo-driver' ;;
            mysql)    printf '%s' 'mysql|mysql2|pymysql|mysqlclient|gorm.io/driver/mysql' ;;
            *)        printf '' ;;
        esac
    }
    # Does the spec name engine $1? Match unambiguous engine names only.
    _spec_names_engine() {
        case "$1" in
            postgres) printf '%s' 'postgres\|postgresql' ;;
            mongodb)  printf '%s' 'mongodb\|mongo db\|mongo database' ;;
            mysql)    printf '%s' 'mysql' ;;
            *)        printf '' ;;
        esac
    }

    local engines="postgres mongodb mysql"
    local spec_engine other_engine
    for spec_engine in $engines; do
        local spec_pat
        spec_pat="$(_spec_names_engine "$spec_engine")"
        [ -n "$spec_pat" ] || continue
        printf '%s' "$spec_lc" | grep -q -e "$spec_pat" || continue

        # Spec names this engine. Is the repo wired to a DIFFERENT one, with no
        # driver for the spec's engine?
        local spec_engine_token
        spec_engine_token="$(_spec_db_driver_token "$spec_engine")"
        # If the repo DOES declare a driver for the spec's engine, there is no
        # conflict (they agree) -- skip.
        if printf '%s' "$deps_lc" | grep -E -q -- "$spec_engine_token"; then
            continue
        fi

        for other_engine in $engines; do
            [ "$other_engine" = "$spec_engine" ] && continue
            # PRECISION guard: if the spec ALSO names other_engine, this is not an
            # unambiguous conflict -- the spec is discussing both engines (e.g.
            # "we chose MongoDB over PostgreSQL"). Skip rather than false-fire on
            # a good spec, since a false contradiction would block it to max-iter.
            local other_spec_pat
            other_spec_pat="$(_spec_names_engine "$other_engine")"
            if [ -n "$other_spec_pat" ] && printf '%s' "$spec_lc" | grep -q -e "$other_spec_pat"; then
                continue
            fi
            local other_token
            other_token="$(_spec_db_driver_token "$other_engine")"
            [ -n "$other_token" ] || continue
            if printf '%s' "$deps_lc" | grep -E -q -- "$other_token"; then
                # UNAMBIGUOUS: spec names X, repo declares a Y driver, repo has
                # no X driver. Record one high/contradictory external finding.
                local gap assumption
                gap="External contradiction: the spec specifies the ${spec_engine} database, but this repository declares a ${other_engine} driver dependency and no ${spec_engine} driver."
                assumption="UNRESOLVED CONTRADICTION: the spec and the existing code disagree on the database engine and this cannot be assumed away; a human must reconcile the spec with the repo before building."
                spec_ledger_write \
                    "$gap" \
                    "$assumption" \
                    "external: spec vs repo dependencies" \
                    "high" \
                    "contradictory" \
                    "data-store" \
                    "external-check"
                # One database-engine conflict is enough to block; stop scanning.
                return 0
            fi
        done
    done
    return 0
}

# ---------------------------------------------------------------------------
# Fold prd-analyzer's deterministic missing-dimension assumptions into the
# ledger as medium (non-blocking). Reads .loki/prd-observations.md "Assumptions
# Made" section. Best-effort; runs even when no provider is available so degrade
# still surfaces something. Usage: spec_ledger_fold_prd_observations [path]
# ---------------------------------------------------------------------------
# shellcheck disable=SC2120  # optional [path] arg by design (see Usage above); callers pass none
spec_ledger_fold_prd_observations() {
    local obs="${1:-${TARGET_DIR:-.}/.loki/prd-observations.md}"
    [ -f "$obs" ] || return 0

    local in_section="false" line item
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            "## Assumptions Made"*) in_section="true"; continue ;;
            "## "*) in_section="false"; continue ;;
        esac
        [ "$in_section" = "true" ] || continue
        case "$line" in
            "- "*)
                item="${line#- }"
                item="$(printf '%s' "$item" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')" ;;
            *)
                continue ;;
        esac
        [ -z "$item" ] && continue
        # The analyzer emits "No assumptions needed; PRD is comprehensive" when
        # the PRD is clean: that is not a gap, skip it.
        case "$item" in
            "No assumptions needed"*) continue ;;
        esac
        # Use the analyzer's assumption text as the gap so each distinct missing
        # dimension gets its own ledger entry (the dedupe id derives from the gap
        # text; a constant gap would collapse all dimensions into one entry).
        spec_ledger_write \
            "Missing PRD dimension: ${item}" \
            "$item" \
            "prd-analyzer: missing dimension" \
            "medium" \
            "missing" \
            "requirements" \
            "prd-analyzer"
    done < "$obs"
    return 0
}

# ---------------------------------------------------------------------------
# Count ledger entries that BLOCK completion: severity=high AND confirmed=false
# AND acknowledged=false. Echoes an integer. Used by the council gate and the
# completion summary. Zero when the ledger dir is absent.
# ---------------------------------------------------------------------------
spec_ledger_high_unresolved_count() {
    local dir
    dir="$(_spec_ledger_dir)"
    if [ ! -d "$dir" ]; then printf '0'; return 0; fi
    _SL_DIR="$dir" python3 -c '
import glob, json, os
d = os.environ["_SL_DIR"]
n = 0
for p in glob.glob(os.path.join(d, "a-*.json")):
    try:
        with open(p) as f:
            r = json.load(f)
    except Exception:
        continue
    if r.get("severity") == "high" and not r.get("confirmed") and not r.get("acknowledged"):
        n += 1
print(n)
' 2>/dev/null || printf '0'
}

# Total ledger entries + high count, "total high" on one line. For summaries.
spec_ledger_counts() {
    local dir
    dir="$(_spec_ledger_dir)"
    if [ ! -d "$dir" ]; then printf '0 0'; return 0; fi
    _SL_DIR="$dir" python3 -c '
import glob, json, os
d = os.environ["_SL_DIR"]
total = high = 0
for p in glob.glob(os.path.join(d, "a-*.json")):
    try:
        with open(p) as f:
            r = json.load(f)
    except Exception:
        continue
    total += 1
    if r.get("severity") == "high":
        high += 1
print("%d %d" % (total, high))
' 2>/dev/null || printf '0 0'
}

# ---------------------------------------------------------------------------
# Auto-acknowledgment lifecycle helper: set acknowledged=true on every ledger
# entry. run.sh calls this once an iteration AFTER assumptions are injected into
# the build prompt (unless LOKI_ASSUMPTIONS_REQUIRE_CONFIRM=1). Best-effort.
#
# P2-4 EXCEPTION: class=contradictory entries are NEVER auto-acknowledged. A gap
# can be assumed away (auto-ack records that the implementer-default was taken),
# but a contradiction is unresolvable by assumption -- there is no default that
# satisfies "X and not-X". Auto-acknowledging it would silently clear the
# completion gate and let "done" be declared over an internally inconsistent
# spec. So a contradiction stays acknowledged=false until a human confirms a
# resolution (sets confirmed=true). This is deliberately the same teeth the
# LOKI_ASSUMPTIONS_REQUIRE_CONFIRM=1 path applies to ALL entries, scoped here to
# just contradictions in default autonomous mode. See the design note below.
# ---------------------------------------------------------------------------
spec_ledger_acknowledge_all() {
    [ "${LOKI_ASSUMPTIONS_REQUIRE_CONFIRM:-0}" = "1" ] && return 0
    local dir
    dir="$(_spec_ledger_dir)"
    [ -d "$dir" ] || return 0
    _SL_DIR="$dir" python3 -c '
import glob, json, os, tempfile
d = os.environ["_SL_DIR"]
for p in glob.glob(os.path.join(d, "a-*.json")):
    try:
        with open(p) as f:
            r = json.load(f)
    except Exception:
        continue
    if r.get("acknowledged"):
        continue
    # P2-4: a contradiction cannot be assumed away, so it is never auto-acked.
    if r.get("class") == "contradictory":
        continue
    r["acknowledged"] = True
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(r, f, indent=2)
        os.replace(tmp, p)
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
' 2>/dev/null || true
    return 0
}

# ---------------------------------------------------------------------------
# Build a compact prompt-injection block listing high-severity assumptions, so
# the build agent sees the spec gaps it must respect. Echoes the block (empty
# when no high-sev entries). Used by build_prompt in run.sh.
# ---------------------------------------------------------------------------
spec_ledger_prompt_block() {
    local dir
    dir="$(_spec_ledger_dir)"
    [ -d "$dir" ] || return 0
    _SL_DIR="$dir" python3 -c '
import glob, json, os
d = os.environ["_SL_DIR"]
rows = []
for p in sorted(glob.glob(os.path.join(d, "a-*.json"))):
    try:
        with open(p) as f:
            r = json.load(f)
    except Exception:
        continue
    if r.get("severity") != "high" or r.get("confirmed"):
        continue
    rows.append("- [%s] %s -> assumed: %s" % (r.get("affects",""), r.get("gap",""), r.get("assumption","")))
if rows:
    print("SPEC ASSUMPTIONS (high-severity, recorded because the spec was ambiguous; respect these or fix the spec): " + " ".join(rows))
' 2>/dev/null || true
    return 0
}

# ---------------------------------------------------------------------------
# Regenerate the human-readable ledger rollup .loki/assumptions/ledger.md.
# Best-effort. Called after writes and surfaced in proof-of-done.
# ---------------------------------------------------------------------------
spec_ledger_rebuild_md() {
    local dir
    dir="$(_spec_ledger_dir)"
    [ -d "$dir" ] || return 0
    _SL_DIR="$dir" python3 -c '
import glob, json, os, tempfile
d = os.environ["_SL_DIR"]
entries = []
for p in sorted(glob.glob(os.path.join(d, "a-*.json"))):
    try:
        with open(p) as f:
            entries.append(json.load(f))
    except Exception:
        continue
lines = ["# Assumption ledger", ""]
if not entries:
    lines.append("No assumptions recorded. The spec was complete and unambiguous.")
else:
    high = sum(1 for e in entries if e.get("severity") == "high")
    lines.append("Total assumptions: %d (%d high-severity)" % (len(entries), high))
    lines.append("")
    for e in entries:
        state = "confirmed" if e.get("confirmed") else ("acknowledged" if e.get("acknowledged") else "OPEN")
        lines.append("## %s [%s / %s / %s]" % (e.get("id",""), e.get("severity",""), e.get("class",""), state))
        lines.append("")
        lines.append("- Gap: %s" % e.get("gap",""))
        lines.append("- Assumption: %s" % e.get("assumption",""))
        lines.append("- Why: %s" % e.get("why",""))
        lines.append("- Affects: %s" % e.get("affects",""))
        lines.append("- Source: %s" % e.get("source",""))
        lines.append("")
out = os.path.join(d, "ledger.md")
fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, out)
except Exception:
    try: os.unlink(tmp)
    except OSError: pass
' 2>/dev/null || true
    return 0
}

# ---------------------------------------------------------------------------
# DISCOVERY orchestrator: run spec interrogation and populate the ledger.
# Usage: spec_interrogation_run <spec_path>
# Default-on; LOKI_SPEC_GRILL=0 opts out. Always non-fatal to the run.
# ---------------------------------------------------------------------------
spec_interrogation_run() {
    local spec_path="${1:-}"

    if [ "${LOKI_SPEC_GRILL:-1}" = "0" ]; then
        return 0
    fi

    # Source grill.sh for grill_main + grill_check_provider. Best-effort: if it
    # is missing we still fold prd-analyzer assumptions below.
    local _self_dir grill_sh
    _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    grill_sh="$_self_dir/grill.sh"
    local grill_available="false"
    if [ -f "$grill_sh" ]; then
        # shellcheck disable=SC1090
        . "$grill_sh" 2>/dev/null && grill_available="true"
    fi

    log_step "Spec interrogation (DISCOVERY): surfacing ambiguities as recorded assumptions..."

    # Provider-aware grill subcall. Degrade cleanly (no fabricated questions).
    if [ "$grill_available" = "true" ] && type grill_check_provider >/dev/null 2>&1; then
        if grill_check_provider 2>/dev/null; then
            local report_dir
            report_dir="${TARGET_DIR:-.}/.loki/grill"
            # grill_main resolves the spec source itself; pass the explicit path
            # when we have one so it grills exactly the active spec.
            if [ -n "$spec_path" ] && [ -f "$spec_path" ]; then
                grill_main "$spec_path" --out "$report_dir" >/dev/null 2>&1 || \
                    log_warn "Spec interrogation: grill subcall failed; continuing with prd-analyzer assumptions only."
            else
                grill_main --out "$report_dir" >/dev/null 2>&1 || \
                    log_warn "Spec interrogation: grill subcall failed; continuing with prd-analyzer assumptions only."
            fi
            local report="$report_dir/report.md"
            if [ -f "$report" ]; then
                spec_interrogation_classify_report "$report" || true
            fi
        else
            log_warn "Spec interrogation: no provider CLI available; skipping the Devil's-Advocate grill (no fabricated questions). Recording prd-analyzer assumptions only."
        fi
    else
        log_warn "Spec interrogation: grill module unavailable; recording prd-analyzer assumptions only."
    fi

    # Always fold prd-analyzer's deterministic missing-dimension assumptions
    # (works with no provider) so degrade still surfaces something.
    spec_ledger_fold_prd_observations || true

    # P2-4: best-effort EXTERNAL contradiction check (spec vs repo deps). Runs
    # with no provider (it is pure file inspection) and is intentionally narrow
    # (high-confidence DB-engine conflict only) so it never blocks a clean spec.
    spec_interrogation_external_check "$spec_path" || true

    spec_ledger_rebuild_md || true

    local counts total high
    counts="$(spec_ledger_counts)"
    total="${counts%% *}"
    high="${counts##* }"
    if [ "${total:-0}" != "0" ]; then
        log_info "Spec interrogation recorded ${total} assumption(s) (${high} high-severity) under .loki/assumptions/."
    fi
    return 0
}

# Allow direct execution for debugging: bash autonomy/spec-interrogation.sh <spec>
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    spec_interrogation_run "${1:-}"
    exit $?
fi
