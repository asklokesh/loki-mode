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
# M5: is a (lowercased, trimmed) finding line an honest NEGATIVE / clean-bill
# report that must NOT be persisted as a finding? Returns 0 (skip) / 1 (keep).
#
# Disambiguation (proximity, not co-occurrence): we skip "no/none/nothing/not"
# closely followed by a PROBLEM-WORD, or a short clean-bill phrase. We KEEP
# "no <feature>" findings (missing-feature descriptions) and lines where the
# problem-word is far from the negation (a real finding that mentions an issue).
# Err toward KEEP when ambiguous.
# ---------------------------------------------------------------------------
_spec_line_is_negative() {
    _SPEC_LINE="$1" python3 -c '
import os, re
line = os.environ.get("_SPEC_LINE", "").strip().lower()
if not line:
    raise SystemExit(1)  # empty -> handled elsewhere; not our negative

problem = (r"concerns?|issues?|gaps?|conflicts?|contradictions?|"
           r"ambiguit(?:y|ies)|blind\s*spots?|risks?|problems?|"
           r"inconsistenc(?:y|ies)|defects?|bugs?|flaws?|weaknesses?")

# Clean-bill phrasings: "looks good/complete/clear/fine", "nothing stands out".
clean_bill = [
    r"^(this\s+)?(section|spec|prd|requirement|design)?\s*looks\s+(good|complete|clear|fine|solid|ok|okay)\b",
    r"^looks\s+(good|complete|clear|fine|solid|ok|okay)\b",
    r"^(this\s+)?(section|spec|prd)?\s*(is|seems|appears)\s+(complete|clear|fine|well\s*-?\s*defined|unambiguous)\b",
    r"^nothing\s+(stands?\s+out|notable|of\s+(concern|note)|to\s+(add|flag|report))\b",
    r"^all\s+(clear|good)\b",
]
for pat in clean_bill:
    if re.search(pat, line):
        raise SystemExit(0)  # skip

# Proximity negation: a negation word, then within a few words a problem-word.
# Allow up to ~3 intervening words (handles "no major concerns", "no obvious
# security issues here" stays KEEP because "issues" is >3 words out? -- no:
# "security issues" is 1 word out from "obvious"; but the negation must be the
# CLAUSE START to be a clean negative). We anchor the negation near line start
# so a mid-sentence "...which is a security issue" (real finding) is NOT matched.
neg_start = r"^(no|none|nothing|not|n/?a)\b"
if re.search(neg_start, line):
    # Within the leading clause (before the first comma / "but" / "however"),
    # is the negation closely followed by a problem-word?
    head = re.split(r",|\bbut\b|\bhowever\b|\bexcept\b|\bwhich\b|;", line, 1)[0]
    # negation word, then 0-3 filler words, then a problem-word.
    prox = r"\b(no|none|nothing|not)\b(?:\s+\w+){0,3}\s+(?:" + problem + r")\b"
    if re.search(prox, head):
        raise SystemExit(0)  # skip: "no major concerns", "nothing stands out"
    # "no <problem-word>" can also be possessive/standalone: "no concerns."
    if re.search(r"\b(no)\s+(?:" + problem + r")\b", head):
        raise SystemExit(0)
raise SystemExit(1)  # keep
' 2>/dev/null
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
    local line stripped q marker_line
    local unparsed_count=0
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

        # M6: strip LEADING whitespace into a separate var BEFORE the marker
        # match so indented list items ("  - x", "  * x", "    1. x") parse. We
        # keep the original $line untouched so the existing "### "/"## " heading
        # matches above were unaffected.
        marker_line="${line#"${line%%[![:space:]]*}"}"
        # Blank / whitespace-only lines are not findings and are not "unparsed".
        [ -z "$marker_line" ] && continue

        # M6: finding lines historically looked like "1. <q>" or "- <q>". Broaden
        # to also tolerate "N)" / "N:" numbered forms and the "* " / "+ " markdown
        # bullet markers, and any of these after leading whitespace (handled
        # above). The original "N. " and "- " behavior is preserved byte-
        # identically (first two cases). Exotic Unicode bullet glyphs are NOT
        # matched (multibyte glob matching is unreliable on bash 3.2). Lines that
        # match NO marker under an active section are counted (unparsed_count) so
        # silent finding-loss becomes visible -- the old code dropped "N)", "*",
        # etc. with a bare "continue".
        case "$marker_line" in
            [0-9]*". "*)
                q="${marker_line#*. }" ;;
            "- "*)
                q="${marker_line#- }" ;;
            [0-9]*") "*)
                q="${marker_line#*) }" ;;
            [0-9]*": "*)
                q="${marker_line#*: }" ;;
            "* "*)
                q="${marker_line#"* "}" ;;
            "+ "*)
                # "+ " is a valid markdown unordered-list marker too.
                q="${marker_line#+ }" ;;
            *)
                # Non-empty section line with no recognized ASCII list marker
                # (this includes exotic Unicode bullet glyphs, which we do NOT
                # try to match: multibyte bracket/glob matching is unreliable on
                # bash 3.2). Count it so the loss is no longer silent (M6), then
                # skip. The unparsed_count warn after the loop surfaces these.
                unparsed_count=$((unparsed_count + 1))
                continue ;;
        esac

        # Trim leading/trailing whitespace.
        stripped="$(printf '%s' "$q" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        [ -z "$stripped" ] && continue
        # Skip negative-result / clean-spec lines so a grill that honestly
        # reports "nothing found" never becomes a persisted finding (and, under
        # "### Contradictions", never deadlocks a clean spec to max-iterations).
        # Match a lowercased copy (bash 3.2 has no ${var,,}); write the original.
        #
        # M5 DISAMBIGUATION RULE: skip a line ONLY when it is an honest NEGATIVE
        # about a PROBLEM-WORD, not when it reports a missing FEATURE.
        #   skip  "no/none/nothing/not <problem-word>"  where the problem-word
        #         (concern|issue|gap|problem|conflict|contradiction|ambiguity|
        #          blind spot|risk|...) appears CLOSE AFTER the negation (within a
        #          few words -- proximity, NOT co-occurrence anywhere), so
        #          "No major concerns here" / "Nothing stands out" are skipped but
        #          "No input validation, which is a security issue" is KEPT (the
        #          problem-word "issue" is far from the negation, the line is a
        #          real finding about a missing feature);
        #   skip  short clean-bill phrases: "looks (good|complete|clear|fine)",
        #          "nothing (stands out|notable|of concern)", bare "none"/"n/a";
        #   KEEP  "no <feature>" (e.g. "No rate limiting on the login endpoint")
        #          -- that DESCRIBES a missing thing and is a real finding.
        # Err toward KEEPING when ambiguous: a false finding is acked/medium, a
        # dropped real one is worse.
        # Known limitation: a finding whose missing-FEATURE name happens to BE a
        # problem-word (e.g. "No issue tracking is specified") can be mis-skipped
        # by the "no <problem-word>" rule. This is rare phrasing; we accept it
        # rather than loosen the rule and let real negatives through.
        local stripped_lc
        stripped_lc="$(printf '%s' "$stripped" | tr '[:upper:]' '[:lower:]')"
        # Fast path: exact whole-line clean-bill phrasings.
        case "$stripped_lc" in
            "none"|"none."|"none found"*|"none identified"*|\
            "no contradiction"*|"no issues"*|"no conflicts"*|"no problems"*|\
            "no concerns"*|"no gaps"*|"not applicable"*|"n/a"*) continue ;;
        esac
        # Proximity-based negative detector for reworded honest negatives.
        if _spec_line_is_negative "$stripped_lc"; then
            continue
        fi

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

    # M6: make any silently-unparsed finding lines visible. The old parser sent
    # "N)", "N:", "*", bullet glyphs etc. straight to a bare continue, losing
    # real findings without a trace. We now count them and warn so a malformed
    # grill report (or a new list style) is diagnosable instead of invisible.
    if [ "${unparsed_count:-0}" -gt 0 ]; then
        log_warn "Spec interrogation: ${unparsed_count} non-empty section line(s) under a finding heading did not match a known list marker and were skipped (report=${report})."
    fi
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

    # Lowercase the spec body once.
    local spec_lc
    spec_lc="$(tr '[:upper:]' '[:lower:]' < "$spec_path" 2>/dev/null)"
    [ -n "$spec_lc" ] || return 0

    # H4 fix: collect declared DEPENDENCY NAMES, one per line, lowercased -- NOT
    # the entire manifest text. The old code grepped driver tokens (e.g. the
    # 2-char "pg") as UNANCHORED substrings of the whole manifest blob, so "pg"
    # matched the word "upgrade" in package.json scripts, any URL containing
    # "pg", etc. That wrote a high/contradictory ledger entry on a CLEAN spec
    # (contradictions are never auto-acked, so the completion gate never cleared
    # and the run ground to max-iterations) -- a direct violation of this
    # function's positive-conflict-only contract.
    #
    # For package.json we parse JSON and emit ONLY the keys under
    # dependencies / devDependencies / peerDependencies / optionalDependencies,
    # which structurally excludes scripts.upgrade (the worst offender). For the
    # line-oriented manifests (requirements.txt, pyproject.toml, go.mod, Gemfile)
    # we emit each non-comment line's leading token / quoted module path, which is
    # the dependency name. Tokens are later matched as a NAME PREFIX (see
    # _spec_repo_declares_engine), so "psycopg" still matches "psycopg2-binary"
    # and "mysql" still matches "mysql2" -- no false negatives from anchoring.
    local dep_names
    # shellcheck disable=SC2086  # word-split of the manifest path list is intended
    dep_names="$(_SPEC_MANIFESTS="$manifests" python3 -c '
import json, os, re, sys
names = set()
for m in os.environ.get("_SPEC_MANIFESTS", "").split():
    if not m or not os.path.isfile(m):
        continue
    base = os.path.basename(m).lower()
    try:
        text = open(m, "r", encoding="utf-8", errors="replace").read()
    except Exception:
        continue
    if base == "package.json":
        try:
            data = json.loads(text)
        except Exception:
            data = None
        if isinstance(data, dict):
            for key in ("dependencies", "devDependencies",
                        "peerDependencies", "optionalDependencies"):
                section = data.get(key)
                if isinstance(section, dict):
                    for dep in section.keys():
                        names.add(str(dep).lower())
        continue
    # Line-oriented manifests: take the leading dependency token of each line.
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        # Quoted module/gem path (go.mod require, Gemfile gem "name", pyproject).
        q = re.findall(r"[\x22\x27]([^\x22\x27]+)[\x22\x27]", line)
        if q:
            for tok in q:
                tok = tok.strip().lower()
                if tok:
                    names.add(tok)
            # go.mod / Gemfile also carry a bare leading token sometimes; fall
            # through to grab it too.
        # Bare leading token (requirements.txt "psycopg2-binary==2.9",
        # go.mod "gorm.io/driver/postgres v1.5.0").
        tok = re.split(r"[\s=<>!~;\[\]()]", line, 1)[0].strip().lower()
        # Strip a leading directive word (go.mod "require", Gemfile "gem").
        if tok in ("require", "gem", "module", "go", "toolchain", "exclude",
                   "replace", "retract"):
            rest = line.split(None, 1)
            if len(rest) > 1:
                tok = re.split(r"[\s=<>!~;\[\]()]", rest[1].strip(), 1)[0].strip().lower()
                tok = tok.strip("\x22\x27")
        if tok:
            names.add(tok)
for n in sorted(names):
    print(n)
' 2>/dev/null)"
    # No parsed dependency names => no concrete repo signal => nothing to conflict.
    [ -n "$dep_names" ] || return 0

    # Engine -> concrete driver-dependency tokens (dependency NAMES, not prose).
    # Keys are the engine names we look for in the SPEC; values are the package
    # name tokens (space-separated) that prove the repo is wired to that engine.
    # H4: these are matched against extracted dependency NAMES as a name-prefix
    # (see _spec_repo_declares_engine), never as substrings of the whole manifest.
    _spec_db_driver_token() {
        case "$1" in
            postgres) printf '%s' 'pg psycopg postgresql asyncpg node-postgres sequelize-postgres gorm.io/driver/postgres' ;;
            mongodb)  printf '%s' 'mongoose pymongo mongodb motor go.mongodb.org/mongo-driver' ;;
            mysql)    printf '%s' 'mysql mysql2 pymysql mysqlclient gorm.io/driver/mysql' ;;
            *)        printf '' ;;
        esac
    }
    # H4: does the repo's declared dependency NAMES include a driver for engine $1?
    # Matches each driver token against the extracted dependency names (in
    # $dep_names, one per line) using EXACT-name OR NAME-PREFIX semantics:
    #   - exact: name == token                 ("pg" matches a "pg" dep)
    #   - prefix: name == token + suffix       ("psycopg" matches "psycopg2-binary",
    #             where suffix begins with a NON-alphanumeric boundary char OR a
    #             digit, so "mysql" matches "mysql2" but "pg" does NOT match "pgx"
    #             of an unrelated package -- wait, see below)
    # We anchor on a delimiter/digit boundary so the 2-char "pg" cannot match an
    # unrelated longer alpha name, while real versioned variants (mysql2,
    # psycopg2-binary) still match. Returns 0 if a driver is declared, else 1.
    _spec_repo_declares_engine() {
        local engine="$1" tokens
        tokens="$(_spec_db_driver_token "$engine")"
        [ -n "$tokens" ] || return 1
        _SPEC_DEP_NAMES="$dep_names" _SPEC_TOKENS="$tokens" python3 -c '
import os
names = set(n.strip().lower() for n in os.environ.get("_SPEC_DEP_NAMES", "").splitlines() if n.strip())
tokens = [t.strip().lower() for t in os.environ.get("_SPEC_TOKENS", "").split() if t.strip()]
def matches(name, tok):
    if name == tok:
        return True
    # Path-style tokens (go module paths) match a name that IS that path.
    if "/" in tok:
        return name == tok
    if name.startswith(tok):
        nxt = name[len(tok):len(tok)+1]
        # A real driver variant continues with a digit (mysql2) or a delimiter
        # (psycopg2-binary -> after "psycopg" comes "2"; node-postgres handled
        # by exact). An unrelated longer alpha name (e.g. "pglite", "pgbouncer")
        # must NOT match the 2-char "pg" token, so we reject an alpha suffix.
        return nxt.isdigit() or nxt in ("-", "_", ".")
    return False
for name in names:
    for tok in tokens:
        if matches(name, tok):
            raise SystemExit(0)
raise SystemExit(1)
' 2>/dev/null
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
        # H4: match driver tokens against the extracted dependency NAMES (exact /
        # name-prefix), NOT as substrings of the whole manifest. The old blob
        # grep here could substring-match unrelated text and SUPPRESS a real
        # conflict (false negative), so this site is fixed too, not just the
        # firing site below.
        # If the repo DOES declare a driver for the spec's engine, there is no
        # conflict (they agree) -- skip.
        if _spec_repo_declares_engine "$spec_engine"; then
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
            # H4: same name-based match for the firing site -- the repo must
            # declare a concrete driver NAME for the other engine. This is the
            # site that wrote the bogus high/contradictory entry on a clean spec
            # when "pg" substring-matched "upgrade" in package.json scripts.
            if _spec_repo_declares_engine "$other_engine"; then
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
#
# F50 (zero-config brief mode): a one-line-brief run (LOKI_TTFV=brief) is the
# zero-config first-pass path. There is no human in the loop and the audience
# is non-technical: a permanently-blocking contradiction makes a brief run grind
# to max-iterations and NEVER cleanly complete -- a broken first-run UX for the
# exact users the brief path exists to serve. Worse, a synthetic brief-PRD that
# Loki itself wrote is unlikely to carry a real human-authored contradiction;
# leaving the gate blocking yields no signal a non-technical user can act on.
# So in brief mode contradictions are RESOLVED-WITH-DEFAULT, not blocked: Loki
# acknowledges the entry, records resolved_with_default=true plus an honest
# resolution note, and the gate is allowed to clear. This is NOT hiding the gap:
# spec_ledger_counts still counts the entry, build_completion_summary still folds
# it into the proof-of-done, ledger.md still lists it, and `loki own` still tells
# the user to review the assumptions Loki had to make. PRD mode (a real
# human-authored spec, where a human CAN resolve a contradiction) keeps the
# original BLOCKING behavior unchanged. brief mode is detected from LOKI_TTFV=brief
# (set by cmd_start) and is overridable by the explicit param for tests/callers.
# Usage: spec_ledger_acknowledge_all [brief_mode]   # brief_mode: "brief" to resolve contradictions
# ---------------------------------------------------------------------------
spec_ledger_acknowledge_all() {
    [ "${LOKI_ASSUMPTIONS_REQUIRE_CONFIRM:-0}" = "1" ] && return 0
    local dir brief_mode
    # F50: brief/zero-config mode resolves contradictions with a default rather
    # than blocking forever. Explicit param wins; otherwise read LOKI_TTFV.
    brief_mode="${1:-${LOKI_TTFV:-}}"
    dir="$(_spec_ledger_dir)"
    [ -d "$dir" ] || return 0
    _SL_DIR="$dir" _SL_BRIEF="$brief_mode" python3 -c '
import glob, json, os, tempfile
d = os.environ["_SL_DIR"]
brief = os.environ.get("_SL_BRIEF", "") == "brief"
for p in glob.glob(os.path.join(d, "a-*.json")):
    try:
        with open(p) as f:
            r = json.load(f)
    except Exception:
        continue
    if r.get("acknowledged"):
        continue
    is_contradiction = r.get("class") == "contradictory"
    # P2-4: a contradiction cannot be assumed away, so it is never auto-acked
    # in default / PRD mode (a human can resolve it there).
    if is_contradiction and not brief:
        continue
    r["acknowledged"] = True
    # F50: brief-mode contradictions are resolved-with-default, marked honestly
    # so the receipt / ledger / `loki own` can show "Loki chose a default here".
    if is_contradiction and brief:
        r["resolved_with_default"] = True
        if not r.get("resolution_note"):
            r["resolution_note"] = (
                "Resolved with a reasonable default in zero-config brief mode "
                "(no human in the loop). Review and refine via a full PRD run "
                "(loki start ./prd.md) if this default is wrong."
            )
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
        # F50: surface a resolved-with-default state distinctly so a brief-mode
        # contradiction reads honestly ("Loki chose a default") rather than as a
        # plain ack or a silent pass.
        if e.get("confirmed"):
            state = "confirmed"
        elif e.get("resolved_with_default"):
            state = "resolved-with-default"
        elif e.get("acknowledged"):
            state = "acknowledged"
        else:
            state = "OPEN"
        lines.append("## %s [%s / %s / %s]" % (e.get("id",""), e.get("severity",""), e.get("class",""), state))
        lines.append("")
        lines.append("- Gap: %s" % e.get("gap",""))
        lines.append("- Assumption: %s" % e.get("assumption",""))
        lines.append("- Why: %s" % e.get("why",""))
        lines.append("- Affects: %s" % e.get("affects",""))
        lines.append("- Source: %s" % e.get("source",""))
        if e.get("resolution_note"):
            lines.append("- Resolution: %s" % e.get("resolution_note"))
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
