#!/usr/bin/env bash
# Intent Ledger: does the SPEC still say what the person actually wanted?
#
# THE PROBLEM THIS ANSWERS. Our verification proves code matches spec. It cannot
# prove the spec was RIGHT. 8090 AI documents a real build where "the software
# converged with the interpretation. The interpretation had diverged from the
# intent." A perfect verification gate passes that build, and the build is still
# wrong. That gap sits upstream of every gate we have, and no competitor ships an
# answer -- 8090 published the argument and their own "Tests" module has zero
# documentation pages and zero changelog entries.
#
# WHAT WE DELIBERATELY DID NOT BUILD. The obvious feature is a semantic fidelity
# score: ask a model "does this spec faithfully express this intent?" and print a
# percentage. That is an LLM judgment wearing the costume of a measurement, and
# it is precisely what our receipts exist to refuse -- they already separate
# deterministic FACTS from AI ASSESSMENTS. There is no similarity number, no
# embedding distance, and no percent-aligned figure anywhere in this file, and a
# future contributor adding one would be removing the reason it is trustworthy.
#
# WHAT IS ACTUALLY MEASURABLE, and it is enough. autonomy/spec.sh already
# persists a content_hash per requirement into .loki/spec/spec.lock. So if an
# intent statement records WHICH requirement it was affirmed against AND that
# requirement's hash AT THAT MOMENT, then divergence is pure hash comparison:
#
#   the intent was affirmed against requirement R at hash H;
#   R now hashes to H';
#   nobody re-affirmed.
#
# That is 8090's failure mode, detected deterministically, re-derivable by hand,
# with no model in the loop. `content_hash_at_link` is the entire design -- store
# only a requirement id and every verdict collapses to UNKNOWN.
#
# WHAT ALREADY EXISTED (checked before building, not assumed). Three of the four
# things this was scoped to do are already shipped and are NOT rebuilt here:
#   - ASSUMED-BUT-NOT-STATED    -> spec-interrogation.sh:284 (.loki/assumptions/)
#   - spec-vs-built divergence  -> spec.sh + verify.sh:2161 (spec.lock, drift gate)
#   - pre-committed predictions -> lib/expectation-ledger.py
# This file references the assumption store by id. A second store would drift
# from the first.

set -uo pipefail

_INTENT_SCHEMA_VERSION="1.0"

# Named refusals. Mirrors the outcome ledger's ANCHOR_REASONS: a status we cannot
# compute is reported by NAME, never as 0 and never as a pass. The most important
# entry is no_distinct_intent_source -- see intent_do_status.
_intent_unknown_reason() {
    case "${1:-}" in
        no_intent_record)          echo "no intent has been recorded (run: loki intent record)" ;;
        no_spec_lock)              echo "no .loki/spec/spec.lock (run: loki spec lock)" ;;
        no_distinct_intent_source) echo "the spec IS the user's own document, so intent and interpretation are the same artifact" ;;
        link_missing_content_hash) echo "link predates hash recording, so staleness cannot be computed" ;;
        requirement_id_not_in_lock) echo "the linked requirement id is not in the current lock" ;;
        *)                         echo "unmeasurable" ;;
    esac
}

_intent_dir()  { echo "${LOKI_DIR:-.loki}/intent"; }
_intent_file() { echo "$(_intent_dir)/intent.json"; }
_intent_lock() { echo "${LOKI_DIR:-.loki}/spec/spec.lock"; }

_intent_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

_intent_sha256() {
    if command -v shasum >/dev/null 2>&1; then
        printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
    else
        printf '%s' "$1" | sha256sum | awk '{print $1}'
    fi
}

# ---------------------------------------------------------------------------
# record: capture an intent statement as a first-class artifact.
#
# THE TEXT IS COPIED, NEVER REFERENCED. autonomy/loki:2079 deletes
# .loki/state/brief.txt at the start of a later non-brief run, deliberately, so a
# stale one-liner cannot be inherited. An intent record whose only evidence is a
# file that a later run removes would be unmeasurable by construction, so the
# statement text and its sha256 are stored inline.
# ---------------------------------------------------------------------------
intent_do_record() {
    local statement=""
    local source="explicit"
    while [ $# -gt 0 ]; do
        case "$1" in
            --statement) statement="${2:-}"; shift 2 ;;
            *) shift ;;
        esac
    done

    if [ -z "$statement" ]; then
        local brief="${LOKI_DIR:-.loki}/state/brief.txt"
        if [ -f "$brief" ]; then
            statement="$(cat "$brief" 2>/dev/null || true)"
            source="brief"
        fi
    fi

    if [ -z "$statement" ]; then
        echo "No intent to record." >&2
        echo "Give one explicitly:  loki intent record --statement \"what you actually want\"" >&2
        return 2
    fi

    local dir; dir="$(_intent_dir)"
    mkdir -p "$dir" || return 3
    local file; file="$(_intent_file)"
    local sha; sha="$(_intent_sha256 "$statement")"
    local sid="${sha:0:12}"
    local now; now="$(_intent_now)"

    python3 - "$file" "$sid" "$statement" "$sha" "$source" "$now" "$_INTENT_SCHEMA_VERSION" <<'PYEOF'
import json, os, sys
path, sid, text, sha, source, now, schema = sys.argv[1:8]
doc = {"schema_version": schema, "statements": []}
if os.path.isfile(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except Exception:
        pass
doc.setdefault("statements", [])
# Idempotent on statement id, matching spec_ledger_write: recording the same
# intent twice must not create a second record or reset its link history.
for s in doc["statements"]:
    if s.get("id") == sid:
        print("already recorded: " + sid)
        sys.exit(0)
doc["statements"].append({
    "id": sid,
    "text": text,
    "text_sha256": sha,
    "source": source,
    "recorded_at": now,
    "assumption_ids": [],
    "links": [],
})
with open(path, "w", encoding="utf-8") as fh:
    json.dump(doc, fh, indent=2)
    fh.write("\n")
print("recorded: " + sid)
PYEOF
    return $?
}

# ---------------------------------------------------------------------------
# link: bind an intent statement to a spec requirement AT ITS CURRENT HASH.
#
# Capturing content_hash_at_link is the whole measurement. Without it a link
# records only "these are related", which no later comparison can falsify.
# ---------------------------------------------------------------------------
intent_do_link() {
    local sid="${1:-}" rid="${2:-}"
    if [ -z "$sid" ] || [ -z "$rid" ]; then
        echo "Usage: loki intent link <statement_id> <requirement_id>" >&2
        return 2
    fi
    local file; file="$(_intent_file)"
    local lock; lock="$(_intent_lock)"
    [ -f "$file" ] || { echo "no intent record; run: loki intent record" >&2; return 2; }
    [ -f "$lock" ] || { echo "no spec.lock; run: loki spec lock" >&2; return 2; }

    python3 - "$file" "$lock" "$sid" "$rid" "$(_intent_now)" <<'PYEOF'
import hashlib, json, sys
ipath, lpath, sid, rid, now = sys.argv[1:6]
with open(ipath, "r", encoding="utf-8") as fh:
    doc = json.load(fh)
with open(lpath, "r", encoding="utf-8") as fh:
    raw = fh.read()
lock = json.loads(raw)
lock_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()

req = None
for r in lock.get("requirements", []):
    if r.get("id") == rid:
        req = r
        break
if req is None:
    sys.stderr.write("requirement id not in spec.lock: " + rid + "\n")
    sys.exit(2)

stmt = None
for s in doc.get("statements", []):
    if s.get("id") == sid:
        stmt = s
        break
if stmt is None:
    sys.stderr.write("statement id not recorded: " + sid + "\n")
    sys.exit(2)

for l in stmt.setdefault("links", []):
    if l.get("requirement_id") == rid:
        print("already linked: " + sid + " -> " + rid)
        sys.exit(0)

ch = req.get("content_hash", "")
stmt["links"].append({
    "requirement_id": rid,
    "content_hash_at_link": ch,
    "spec_lock_hash_at_link": lock_hash,
    "affirmations": [{"content_hash": ch, "affirmed_at": now, "affirmed_by": "human"}],
})
with open(ipath, "w", encoding="utf-8") as fh:
    json.dump(doc, fh, indent=2)
    fh.write("\n")
print("linked: " + sid + " -> " + rid + " at " + ch[:12])
PYEOF
    return $?
}

# ---------------------------------------------------------------------------
# affirm: re-affirm an intent against the requirement's CURRENT hash.
#
# WHY THIS EXISTS AND IS NOT OPTIONAL. Permanent idempotence is right for the
# assumption ledger and wrong here: without re-affirmation the first legitimate
# spec edit makes a statement STALE forever, the gate stays red, and a run grinds
# to max iterations against a finding no action can clear. That is the exact
# failure spec-interrogation.sh's own header documents for unresolved
# contradictions.
#
# It APPENDS rather than overwrites, so "this intent was re-affirmed across three
# successive versions of R" stays visible. The history is itself the useful fact.
# ---------------------------------------------------------------------------
intent_do_affirm() {
    local sid="${1:-}"
    [ -n "$sid" ] || { echo "Usage: loki intent affirm <statement_id>" >&2; return 2; }
    local file; file="$(_intent_file)"
    local lock; lock="$(_intent_lock)"
    [ -f "$file" ] || { echo "no intent record" >&2; return 2; }
    [ -f "$lock" ] || { echo "no spec.lock" >&2; return 2; }

    python3 - "$file" "$lock" "$sid" "$(_intent_now)" <<'PYEOF'
import json, sys
ipath, lpath, sid, now = sys.argv[1:5]
with open(ipath, "r", encoding="utf-8") as fh:
    doc = json.load(fh)
with open(lpath, "r", encoding="utf-8") as fh:
    lock = json.load(fh)
by_id = {r.get("id"): r for r in lock.get("requirements", [])}

n = 0
for s in doc.get("statements", []):
    if s.get("id") != sid:
        continue
    for l in s.get("links", []):
        req = by_id.get(l.get("requirement_id"))
        if req is None:
            continue
        ch = req.get("content_hash", "")
        l.setdefault("affirmations", []).append(
            {"content_hash": ch, "affirmed_at": now, "affirmed_by": "human"})
        n += 1
if n == 0:
    sys.stderr.write("nothing to affirm for: " + sid + "\n")
    sys.exit(2)
with open(ipath, "w", encoding="utf-8") as fh:
    json.dump(doc, fh, indent=2)
    fh.write("\n")
print("affirmed " + str(n) + " link(s) for " + sid)
PYEOF
    return $?
}

# ---------------------------------------------------------------------------
# status: the divergence report. Every verdict is a fact or a named refusal.
# ---------------------------------------------------------------------------
intent_do_status() {
    local as_json=0
    [ "${1:-}" = "--json" ] && as_json=1
    local file; file="$(_intent_file)"
    local lock; lock="$(_intent_lock)"

    if [ ! -f "$file" ]; then
        if [ "$as_json" = "1" ]; then
            printf '{"schema_version":"%s","status":"UNKNOWN","reason":"no_intent_record","detail":"%s"}\n' \
                "$_INTENT_SCHEMA_VERSION" "$(_intent_unknown_reason no_intent_record)"
        else
            echo "Intent Ledger: UNKNOWN"
            echo "  $(_intent_unknown_reason no_intent_record)"
            echo ""
            echo "  Intent is not the spec. A spec you wrote yourself is your"
            echo "  INTERPRETATION already; recording intent separately is what makes"
            echo "  drift between the two measurable at all."
        fi
        return 0
    fi
    if [ ! -f "$lock" ]; then
        if [ "$as_json" = "1" ]; then
            printf '{"schema_version":"%s","status":"UNKNOWN","reason":"no_spec_lock","detail":"%s"}\n' \
                "$_INTENT_SCHEMA_VERSION" "$(_intent_unknown_reason no_spec_lock)"
        else
            echo "Intent Ledger: UNKNOWN"
            echo "  $(_intent_unknown_reason no_spec_lock)"
        fi
        return 0
    fi

    python3 - "$file" "$lock" "$as_json" "$_INTENT_SCHEMA_VERSION" <<'PYEOF'
import json, sys
ipath, lpath, as_json, schema = sys.argv[1:5]
as_json = as_json == "1"
with open(ipath, "r", encoding="utf-8") as fh:
    doc = json.load(fh)
with open(lpath, "r", encoding="utf-8") as fh:
    lock = json.load(fh)
by_id = {r.get("id"): r for r in lock.get("requirements", [])}

rows = []
for s in doc.get("statements", []):
    links = s.get("links") or []
    if not links:
        rows.append({"statement_id": s.get("id"), "verdict": "UNLINKED",
                     "detail": "recorded but never linked to a requirement"})
        continue
    for l in links:
        rid = l.get("requirement_id")
        row = {"statement_id": s.get("id"), "requirement_id": rid}
        if rid not in by_id:
            row["verdict"] = "LINKED-REMOVED"
            row["detail"] = "the linked requirement is no longer in the spec"
            rows.append(row); continue
        affs = l.get("affirmations") or []
        last = affs[-1].get("content_hash") if affs else l.get("content_hash_at_link")
        if not last:
            row["verdict"] = "UNKNOWN"
            row["reason"] = "link_missing_content_hash"
            rows.append(row); continue
        current = by_id[rid].get("content_hash", "")
        if current == last:
            row["verdict"] = "LINKED-CURRENT"
            row["affirmations"] = len(affs)
        else:
            row["verdict"] = "LINKED-STALE"
            row["detail"] = ("affirmed at " + last[:12] + ", requirement is now "
                             + current[:12] + " and nobody re-affirmed")
            row["affirmations"] = len(affs)
        rows.append(row)

stale = [r for r in rows if r["verdict"] in ("LINKED-STALE", "LINKED-REMOVED")]
summary = {
    "statements": len(doc.get("statements", [])),
    "linked_current": len([r for r in rows if r["verdict"] == "LINKED-CURRENT"]),
    "linked_stale": len([r for r in rows if r["verdict"] == "LINKED-STALE"]),
    "linked_removed": len([r for r in rows if r["verdict"] == "LINKED-REMOVED"]),
    "unlinked": len([r for r in rows if r["verdict"] == "UNLINKED"]),
    "unknown": len([r for r in rows if r["verdict"] == "UNKNOWN"]),
}

if as_json:
    print(json.dumps({"schema_version": schema, "summary": summary,
                      "rows": rows}, indent=2))
else:
    print("Intent Ledger -- does the spec still say what was actually wanted?")
    print("")
    for r in rows:
        line = "  " + str(r.get("statement_id", "?"))[:14].ljust(16)
        line += r["verdict"].ljust(16)
        if r.get("requirement_id"):
            line += str(r["requirement_id"])[:24].ljust(26)
        if r.get("detail"):
            line += "  " + r["detail"]
        print(line)
    print("")
    print("  statements " + str(summary["statements"])
          + "   current " + str(summary["linked_current"])
          + "   stale " + str(summary["linked_stale"])
          + "   removed " + str(summary["linked_removed"])
          + "   unlinked " + str(summary["unlinked"]))
    if stale:
        print("")
        print("  A stale link is the failure a verification gate cannot see: the")
        print("  code still matches the spec, and the spec moved away from what")
        print("  was wanted. Re-affirm once you agree with the change:")
        print("    loki intent affirm <statement_id>")

sys.exit(1 if stale else 0)
PYEOF
    return $?
}

intent_help() {
    echo "loki intent - does the spec still say what was actually wanted?"
    echo ""
    echo "Usage: loki intent <subcommand>"
    echo ""
    echo "  record [--statement \"...\"]   record intent as a first-class artifact"
    echo "  link <stmt_id> <req_id>       bind intent to a requirement at its current hash"
    echo "  affirm <stmt_id>              re-affirm after an agreed spec change"
    echo "  status [--json]               divergence report"
    echo ""
    echo "Verification proves code matches spec. It cannot prove the spec was"
    echo "right. This measures the other half, deterministically: an intent"
    echo "affirmed against requirement R at hash H reads LINKED-STALE once R"
    echo "changes and nobody re-affirms. No model judges anything here, and there"
    echo "is deliberately no similarity score."
}

intent_main() {
    local sub="${1:-}"
    [ $# -gt 0 ] && shift
    case "$sub" in
        record) intent_do_record "$@" ;;
        link)   intent_do_link "$@" ;;
        affirm) intent_do_affirm "$@" ;;
        status) intent_do_status "$@" ;;
        ""|--help|-h|help) intent_help ;;
        *) echo "unknown subcommand: $sub" >&2; intent_help >&2; return 2 ;;
    esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    intent_main "$@"
fi
