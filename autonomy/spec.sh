#!/usr/bin/env bash
# autonomy/spec.sh - Loki living-spec core (loki spec).
#
# "The spec is the contract; we keep it true."
#
# This is a STANDALONE module (like autonomy/verify.sh). It deliberately does
# NOT source run.sh: the in-loop GENERATED_PRD reconcile (run.sh:10432/:10439)
# is welded to the autonomous build loop, fires only as an LLM prompt, and
# silently rewrites the PRD without producing a divergence report a human can
# read or a gate can block on (see internal/SDD-PANEL-B.md section 2).
#
# What this module adds (the gap Panel B identified):
#   - A deterministic spec-to-content binding artifact (.loki/spec/spec.lock):
#     per-requirement content hashes of the spec sections, plus repo HEAD at
#     lock time. No LLM pass needed to answer "has the spec gone stale".
#   - Cheap drift detection: `loki spec status` recomputes hashes and reports
#     ADDED / REMOVED / CHANGED requirements, plus whether code changed since
#     the lock (diff stat vs the locked HEAD). Deterministic, no LLM cost.
#   - A machine-readable trust artifact (.loki/spec/drift-report.json) that
#     plugs straight into `loki verify` as a SPEC_DRIFT finding.
#   - `loki spec sync`: explicit human action that refreshes the lock after a
#     review. This MVP NEVER auto-rewrites the spec itself.
#
# Subcommands:
#   loki spec lock     build/refresh .loki/spec/spec.lock from the spec
#   loki spec status   cheap drift detection vs the lock (exit 0 in-sync, 1 drift)
#   loki spec sync     refresh the lock after review (alias semantics of lock,
#                      named distinctly so the human-review intent is explicit)
#
# Spec source resolution (first match wins):
#   1. explicit path argument
#   2. .loki/generated-prd.md
#   3. prd.md
#   4. PRD.md
#   5. docs/prd.md
#
# Requirement model: a "requirement" is either a markdown checklist item
# (`- [ ]` / `- [x]`) or a section heading (`#`..`######`). Each requirement
# gets a stable id derived from its normalized text, and a content hash over
# the requirement line plus the body text that follows it up to the next
# requirement of the same-or-shallower level. This makes a CHANGED verdict
# fire when the prose under a heading is edited, not only when the heading text
# moves.
#
# Exit codes:
#   0  in sync (status) / lock written (lock, sync)
#   1  drift detected (status only)
#   2  usage / spec-not-found error
#   3  internal error (could not complete)

set -uo pipefail

SPEC_EXIT_OK=0
SPEC_EXIT_DRIFT=1
SPEC_EXIT_USAGE=2
SPEC_EXIT_ERROR=3
SPEC_SCHEMA_VERSION="1.0"

SPEC_DIR_DEFAULT=".loki/spec"
SPEC_LOCK_NAME="spec.lock"
SPEC_DRIFT_REPORT_NAME="drift-report.json"

_spec_log() { printf '[spec] %s\n' "$*" >&2; }
_spec_err() { printf '[spec][error] %s\n' "$*" >&2; }

# Resolve tool version from the VERSION file shipped alongside the repo.
_spec_tool_version() {
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -f "$here/../VERSION" ]; then
        tr -d '[:space:]' <"$here/../VERSION"
    else
        echo "unknown"
    fi
}

# ---------------------------------------------------------------------------
# Resolve the spec source path. Echoes the path on success, empty on failure.
# ---------------------------------------------------------------------------
spec_resolve_source() {
    local explicit="${1:-}"
    if [ -n "$explicit" ]; then
        if [ -f "$explicit" ]; then
            printf '%s\n' "$explicit"
            return 0
        fi
        return 1
    fi
    local candidate
    for candidate in \
        ".loki/generated-prd.md" \
        "prd.md" \
        "PRD.md" \
        "docs/prd.md"; do
        if [ -f "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

# ---------------------------------------------------------------------------
# Parse a spec into a requirement map (id, kind, level, text, content_hash)
# and print it as a compact JSON object: { "requirements": [ ... ] }.
#
# Deterministic, pure-Python (no LLM). Used by both lock and status.
# ---------------------------------------------------------------------------
spec_parse_requirements_json() {
    local spec_path="$1"
    _SPEC_PARSE_PATH="$spec_path" python3 - <<'PYEOF'
import hashlib, json, os, re, sys

path = os.environ["_SPEC_PARSE_PATH"]
try:
    with open(path, encoding="utf-8", errors="replace") as fh:
        raw = fh.read()
except OSError as exc:
    sys.stderr.write("spec parse: cannot read %s: %s\n" % (path, exc))
    sys.exit(3)

lines = raw.splitlines()

heading_re = re.compile(r'^(#{1,6})\s+(.*\S)\s*$')
# Checklist item: optional leading whitespace, a bullet, then [ ] / [x] / [X].
checklist_re = re.compile(r'^\s*[-*]\s+\[([ xX])\]\s+(.*\S)\s*$')


def norm(text):
    # Normalize for the id: lowercase, collapse whitespace, drop trailing
    # punctuation. Keeps the id stable across cosmetic edits to spacing.
    t = text.strip().lower()
    t = re.sub(r'\s+', ' ', t)
    t = re.sub(r'[\s:.;,]+$', '', t)
    return t


# First pass: locate every requirement (heading or checklist item) with its
# line index and a "level". Headings use their markdown level (1..6).
# Checklist items use level 100 (deeper than any heading) so a heading's body
# extends across the checklist items beneath it but each checklist item still
# hashes its own line.
reqs = []
for i, line in enumerate(lines):
    m = heading_re.match(line)
    if m:
        level = len(m.group(1))
        text = m.group(2).strip()
        reqs.append({"line": i, "level": level, "kind": "heading", "text": text})
        continue
    c = checklist_re.match(line)
    if c:
        text = c.group(2).strip()
        reqs.append({"line": i, "level": 100, "kind": "checklist", "text": text})


# Second pass: compute the content hash for each requirement. The body of a
# requirement runs from its own line up to (but not including) the next
# requirement whose level is the same or shallower. For checklist items
# (level 100) the body is just the item line itself, because the next
# requirement (another checklist item at 100, or any heading at <=6) ends it
# immediately.
out = []
seen_ids = {}
n = len(reqs)
for idx, r in enumerate(reqs):
    start = r["line"]
    end = len(lines)
    for j in range(idx + 1, n):
        if reqs[j]["level"] <= r["level"]:
            end = reqs[j]["line"]
            break
    body = "\n".join(lines[start:end])
    h = hashlib.sha256(body.encode("utf-8")).hexdigest()

    base_id = norm(r["text"]) or ("req-%d" % start)
    # Disambiguate identical requirement text by appending an occurrence index.
    if base_id in seen_ids:
        seen_ids[base_id] += 1
        rid = "%s#%d" % (base_id, seen_ids[base_id])
    else:
        seen_ids[base_id] = 0
        rid = base_id

    out.append({
        "id": rid,
        "kind": r["kind"],
        "level": r["level"],
        "text": r["text"],
        "line": start + 1,
        "content_hash": h,
    })

json.dump({"requirements": out}, sys.stdout, indent=2)
sys.stdout.write("\n")
PYEOF
}

# ---------------------------------------------------------------------------
# spec lock / spec sync core.
#
# Builds .loki/spec/spec.lock with: schema, tool version, spec path, locked-at
# timestamp, repo HEAD at lock time, and the parsed requirement map.
# `sync` is `lock` with a flag recorded in the lock so the artifact carries the
# human-review intent (Panel B: sync is an explicit human action).
# ---------------------------------------------------------------------------
spec_do_lock() {
    local spec_path="$1"
    local out_dir="$2"
    local origin="$3"   # "lock" or "sync"

    local req_json
    if ! req_json="$(spec_parse_requirements_json "$spec_path")"; then
        _spec_err "failed to parse spec at $spec_path"
        return $SPEC_EXIT_ERROR
    fi

    # Resolve the current commit SHA honestly. Note: `git rev-parse HEAD` prints
    # the literal string "HEAD" (and exits 0) in a repo with no commits, so the
    # naive `|| echo "(none)"` fallback never fires there. Use `--verify HEAD`,
    # which fails (rc!=0) when HEAD does not resolve, and record an honest
    # sentinel instead of the failed-resolution artifact.
    local head_sha="(none)"
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        if head_sha="$(git rev-parse --verify HEAD 2>/dev/null)"; then
            :
        else
            head_sha="no-commits"
        fi
    fi

    local locked_at tool_version
    locked_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    tool_version="$(_spec_tool_version)"

    mkdir -p "$out_dir" || { _spec_err "cannot create $out_dir"; return $SPEC_EXIT_ERROR; }

    _SPEC_OUT="$out_dir/$SPEC_LOCK_NAME" \
    _SPEC_REQ_JSON="$req_json" \
    _SPEC_PATH="$spec_path" \
    _SPEC_HEAD="$head_sha" \
    _SPEC_LOCKED_AT="$locked_at" \
    _SPEC_TOOLVER="$tool_version" \
    _SPEC_SCHEMA="$SPEC_SCHEMA_VERSION" \
    _SPEC_ORIGIN="$origin" \
    python3 - <<'PYEOF'
import json, os, sys

req = json.loads(os.environ["_SPEC_REQ_JSON"])
doc = {
    "schema_version": os.environ["_SPEC_SCHEMA"],
    "produced_by": {
        "tool": "loki spec",
        "tool_version": os.environ["_SPEC_TOOLVER"],
        "origin": os.environ["_SPEC_ORIGIN"],
    },
    "spec_path": os.environ["_SPEC_PATH"],
    "locked_at": os.environ["_SPEC_LOCKED_AT"],
    "locked_head": os.environ["_SPEC_HEAD"],
    "requirements": req.get("requirements", []),
}
out = os.environ["_SPEC_OUT"]
with open(out, "w", encoding="utf-8") as fh:
    json.dump(doc, fh, indent=2)
    fh.write("\n")
print(out)
PYEOF
    local rc=$?
    if [ "$rc" -ne 0 ]; then
        _spec_err "failed to write lock file"
        return $SPEC_EXIT_ERROR
    fi

    local count
    count="$(printf '%s' "$req_json" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("requirements", [])))' 2>/dev/null || echo "?")"
    local head_label
    if [ "$head_sha" = "no-commits" ] || [ "$head_sha" = "(none)" ]; then
        head_label="$head_sha"
    else
        head_label="HEAD ${head_sha:0:12}"
    fi
    _spec_log "$origin: $count requirement(s) from $spec_path at $head_label"
    printf 'Locked %s requirement(s) -> %s\n' "$count" "$out_dir/$SPEC_LOCK_NAME"
    return $SPEC_EXIT_OK
}

# ---------------------------------------------------------------------------
# spec status core.
#
# Compares current spec hashes vs the lock; reports ADDED / REMOVED / CHANGED
# requirements and whether code changed since the locked HEAD (diff stat).
# Emits .loki/spec/drift-report.json and a human table. Exit 0 in-sync, 1 drift.
# The drift signal is the exit code (0 in sync, 1 drift); callers branch on $?.
# ---------------------------------------------------------------------------
spec_do_status() {
    local spec_path="$1"
    local out_dir="$2"
    local as_json="$3"   # "true" | "false"

    local lock_file="$out_dir/$SPEC_LOCK_NAME"
    if [ ! -f "$lock_file" ]; then
        _spec_err "no spec lock found at $lock_file. Run 'loki spec lock' first."
        return $SPEC_EXIT_USAGE
    fi

    local cur_json
    if ! cur_json="$(spec_parse_requirements_json "$spec_path")"; then
        _spec_err "failed to parse current spec at $spec_path"
        return $SPEC_EXIT_ERROR
    fi

    # Compute code-changed-since-lock via git diff stat vs the locked HEAD.
    local locked_head code_changed="unknown" diff_files=0 diff_ins=0 diff_del=0
    locked_head="$(python3 -c 'import sys,json; print(json.load(open(sys.argv[1])).get("locked_head",""))' "$lock_file" 2>/dev/null || echo "")"
    if [ -n "$locked_head" ] && [ "$locked_head" != "(none)" ] \
       && git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
       && git rev-parse --verify --quiet "$locked_head" >/dev/null 2>&1; then
        local numstat
        numstat="$(git diff --numstat "$locked_head" HEAD 2>/dev/null || echo "")"
        if [ -n "$numstat" ]; then
            diff_files="$(printf '%s\n' "$numstat" | grep -c . || echo 0)"
            diff_ins="$(printf '%s\n' "$numstat" | awk '$1 ~ /^[0-9]+$/ {s+=$1} END {print s+0}')"
            diff_del="$(printf '%s\n' "$numstat" | awk '$2 ~ /^[0-9]+$/ {s+=$2} END {print s+0}')"
            code_changed="true"
        else
            code_changed="false"
        fi
    fi

    mkdir -p "$out_dir" || { _spec_err "cannot create $out_dir"; return $SPEC_EXIT_ERROR; }

    # Diff the requirement maps in Python; emit drift-report.json; print a table
    # to stderr (status human output) and the drift flag to stdout.
    local report_path="$out_dir/$SPEC_DRIFT_REPORT_NAME"
    local result
    result="$(
        _SPEC_LOCK_FILE="$lock_file" \
        _SPEC_CUR_JSON="$cur_json" \
        _SPEC_REPORT="$report_path" \
        _SPEC_SPEC_PATH="$spec_path" \
        _SPEC_SCHEMA="$SPEC_SCHEMA_VERSION" \
        _SPEC_CODE_CHANGED="$code_changed" \
        _SPEC_DIFF_FILES="$diff_files" \
        _SPEC_DIFF_INS="$diff_ins" \
        _SPEC_DIFF_DEL="$diff_del" \
        _SPEC_LOCKED_HEAD="${locked_head:-}" \
        _SPEC_AS_JSON="$as_json" \
        python3 - <<'PYEOF'
import json, os, sys

lock = json.load(open(os.environ["_SPEC_LOCK_FILE"], encoding="utf-8"))
cur = json.loads(os.environ["_SPEC_CUR_JSON"])

locked = {r["id"]: r for r in lock.get("requirements", [])}
current = {r["id"]: r for r in cur.get("requirements", [])}

added, removed, changed = [], [], []
for rid, r in current.items():
    if rid not in locked:
        added.append(r)
    elif r["content_hash"] != locked[rid]["content_hash"]:
        changed.append({"id": rid, "text": r["text"], "kind": r["kind"],
                        "line": r.get("line"),
                        "locked_hash": locked[rid]["content_hash"],
                        "current_hash": r["content_hash"]})
for rid, r in locked.items():
    if rid not in current:
        removed.append(r)

code_changed = os.environ["_SPEC_CODE_CHANGED"]
drift = bool(added or removed or changed)

report = {
    "schema_version": os.environ["_SPEC_SCHEMA"],
    "spec_path": os.environ["_SPEC_SPEC_PATH"],
    "lock_path": os.environ["_SPEC_LOCK_FILE"],
    "locked_head": os.environ["_SPEC_LOCKED_HEAD"],
    "in_sync": (not drift),
    "drift": drift,
    "code_changed_since_lock": (code_changed == "true"),
    "code_diff_stats": {
        "files_changed": int(os.environ["_SPEC_DIFF_FILES"]),
        "insertions": int(os.environ["_SPEC_DIFF_INS"]),
        "deletions": int(os.environ["_SPEC_DIFF_DEL"]),
    },
    "summary": {
        "added": len(added),
        "removed": len(removed),
        "changed": len(changed),
    },
    "added": added,
    "removed": removed,
    "changed": changed,
}

with open(os.environ["_SPEC_REPORT"], "w", encoding="utf-8") as fh:
    json.dump(report, fh, indent=2)
    fh.write("\n")

# Human table -> stderr (stdout is reserved for the drift flag the caller reads).
def line(s=""):
    sys.stderr.write(s + "\n")

line("")
line("Spec drift status")
line("  spec:        %s" % report["spec_path"])
line("  lock:        %s" % report["lock_path"])
line("  locked HEAD: %s" % (report["locked_head"] or "(none)"))
cc = report["code_diff_stats"]
if report["code_changed_since_lock"]:
    line("  code:        CHANGED since lock (%d files, +%d / -%d)" %
         (cc["files_changed"], cc["insertions"], cc["deletions"]))
elif code_changed == "false":
    line("  code:        unchanged since lock")
else:
    line("  code:        (could not compare against locked HEAD)")
line("")
line("  ADDED:   %d" % len(added))
line("  REMOVED: %d" % len(removed))
line("  CHANGED: %d" % len(changed))
line("")
if drift:
    for r in added:
        line("  + ADDED    [%s] %s" % (r["kind"], r["text"]))
    for r in removed:
        line("  - REMOVED  [%s] %s" % (r["kind"], r["text"]))
    for r in changed:
        line("  ~ CHANGED  [%s] %s" % (r["kind"], r["text"]))
    line("")
    line("  Verdict: SPEC-DRIFTED. Review, then run 'loki spec sync' to re-lock.")
else:
    line("  Verdict: SPEC-TRUE. Spec and lock agree.")
line("")

if os.environ["_SPEC_AS_JSON"] == "true":
    # Machine output on stdout when --json requested: the full report plus a
    # trailing DRIFT line the bash caller parses for the exit code.
    sys.stdout.write(json.dumps(report, indent=2) + "\n")

# Always emit the drift flag as the final stdout line for the bash caller.
sys.stdout.write("DRIFT=%s\n" % ("true" if drift else "false"))
PYEOF
    )"
    local rc=$?
    if [ "$rc" -ne 0 ]; then
        _spec_err "failed to compute drift report"
        return $SPEC_EXIT_ERROR
    fi

    # Emit the JSON body (everything except the trailing DRIFT= line) to stdout
    # when --json was requested, then read the drift flag.
    local drift_flag
    drift_flag="$(printf '%s\n' "$result" | grep '^DRIFT=' | tail -1 | cut -d= -f2)"
    if [ "$as_json" = "true" ]; then
        printf '%s\n' "$result" | grep -v '^DRIFT='
    fi

    printf 'Drift report: %s\n' "$report_path" >&2

    if [ "$drift_flag" = "true" ]; then
        return $SPEC_EXIT_DRIFT
    fi
    return $SPEC_EXIT_OK
}

# ---------------------------------------------------------------------------
# Verify integration hook.
#
# Called by autonomy/verify.sh when .loki/spec/spec.lock exists. Runs the
# drift check quietly and, on drift, emits ONE SPEC_DRIFT record to stdout in
# the verify finding TSV shape:
#     severity \t category \t source \t file \t line \t message
# Severity is High (-> BLOCKED under verify's default --block-on critical,high).
# A spec lock is an explicit human declaration that "this spec is the contract"
# (loki spec lock / sync), so once it exists, real drift is a blocking gate, not
# a soft concern. Graceful no-op (prints nothing, returns 0) when there is no
# lock or the spec cannot be resolved, so an unlocked / first-run workflow is
# never blocked.
#
# This function is intentionally side-effect-light for the verify caller: it
# still writes the drift-report.json (a useful artifact) and never prints to the
# verify human channel; the BLOCK is delivered purely via the High finding the
# verify verdict logic consumes.
# ---------------------------------------------------------------------------
spec_verify_hook() {
    local out_dir="${1:-$SPEC_DIR_DEFAULT}"
    local lock_file="$out_dir/$SPEC_LOCK_NAME"
    [ -f "$lock_file" ] || return 0

    local spec_path
    # Prefer the spec path recorded in the lock; fall back to resolution.
    spec_path="$(python3 -c 'import sys,json; print(json.load(open(sys.argv[1])).get("spec_path",""))' "$lock_file" 2>/dev/null || echo "")"
    # The lock recorded a spec path but that file is now MISSING (the locked spec
    # was deleted). That is real drift -- the contract the lock binds no longer
    # exists -- so emit a High spec_drift finding (blocking, consistent with the
    # content-drift finding below) instead of silently returning 0. NEVER fall
    # back to spec_resolve_source here: comparing against a different candidate
    # file would mask the deletion and attest a spec that is not the locked one.
    # The empty-spec_path case below is a SEPARATE, legitimate fallback (legacy
    # locks that never recorded a path).
    if [ -n "$spec_path" ] && [ ! -f "$spec_path" ]; then
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
            "High" "spec_drift" "deterministic:loki-spec" "$spec_path" "null" \
            "locked spec file missing: $spec_path (the spec is the contract; restore it or run 'loki spec sync' after review to re-lock against the current spec)"
        return 0
    fi
    if [ -z "$spec_path" ]; then
        spec_path="$(spec_resolve_source "")" || return 0
    fi
    [ -n "$spec_path" ] && [ -f "$spec_path" ] || return 0

    # Run status quietly (suppress its human table on stderr). The drift report
    # JSON it writes is what we read below; its exit code is intentionally
    # ignored here (we attest, we do not block, in the hook).
    spec_do_status "$spec_path" "$out_dir" "false" >/dev/null 2>&1 || true

    local report_path="$out_dir/$SPEC_DRIFT_REPORT_NAME"
    [ -f "$report_path" ] || return 0

    local summary
    summary="$(python3 - "$report_path" <<'PYEOF' 2>/dev/null || echo ""
import json, sys
r = json.load(open(sys.argv[1]))
if not r.get("drift"):
    sys.exit(0)
s = r.get("summary", {})
print("Spec has drifted from its lock: %d added, %d removed, %d changed requirement(s). The spec is the contract; run 'loki spec status' for detail and 'loki spec sync' to re-lock after review." % (s.get("added", 0), s.get("removed", 0), s.get("changed", 0)))
PYEOF
)"
    [ -n "$summary" ] || return 0

    # Emit one High SPEC_DRIFT finding in the verify TSV shape (blocking under
    # verify's default --block-on critical,high; only reachable when a lock exists).
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
        "High" "spec_drift" "deterministic:loki-spec" "$spec_path" "null" "$summary"
    return 0
}

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
spec_help() {
    cat <<'EOF'
loki spec - the living spec: the spec is the contract; we keep it true.

USAGE:
    loki spec <lock|status|sync> [<spec-path>] [options]

DESCRIPTION:
    Binds a spec (PRD) to content hashes so drift between the spec and the code
    is detectable cheaply and deterministically -- no LLM pass required to ask
    "has the spec gone stale". The lock + drift report are auditable trust
    artifacts that feed `loki verify`.

SUBCOMMANDS:
    lock      Build .loki/spec/spec.lock: a deterministic map of spec
              requirements (checklist items and headings) to content hashes,
              plus repo HEAD at lock time.
    status    Cheap drift detection: compare current spec hashes vs the lock,
              report ADDED / REMOVED / CHANGED requirements and whether code
              changed since the locked HEAD. Emits .loki/spec/drift-report.json
              and a human table. Exit 0 in-sync, 1 on drift.
    sync      Refresh the lock after a human review (explicit action). This MVP
              NEVER auto-rewrites the spec itself.

SPEC RESOLUTION (when <spec-path> is omitted, first match wins):
    .loki/generated-prd.md  ->  prd.md  ->  PRD.md  ->  docs/prd.md

OPTIONS:
    --out <dir>   Output directory for the lock + report. Default: .loki/spec
    --json        (status only) Emit the full drift report JSON to stdout.
    -h, --help    Show this help.

EXIT CODES:
    0  in sync (status) / lock written (lock, sync)
    1  drift detected (status)
    2  usage error (spec or lock not found)
    3  internal error

VERIFY INTEGRATION:
    When .loki/spec/spec.lock exists, `loki verify` runs the drift check and
    adds a High-severity SPEC_DRIFT finding on drift, which BLOCKS verify under
    its default --block-on critical,high. Locking is an explicit declaration
    that the spec is the contract, so post-lock drift is a hard gate. No lock =
    graceful no-op (gate skipped, never blocks an unlocked / first-run workflow).

EOF
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
spec_main() {
    local sub="${1:-}"
    [ $# -gt 0 ] && shift

    case "$sub" in
        -h|--help|help|"") spec_help; return $SPEC_EXIT_OK ;;
    esac

    local spec_arg=""
    local out_dir="$SPEC_DIR_DEFAULT"
    local as_json="false"

    while [ $# -gt 0 ]; do
        case "$1" in
            -h|--help) spec_help; return $SPEC_EXIT_OK ;;
            --out) out_dir="${2:-}"; shift 2 ;;
            --json) as_json="true"; shift ;;
            --) shift; break ;;
            -*) _spec_err "unknown option: $1"; spec_help; return $SPEC_EXIT_USAGE ;;
            *)
                if [ -z "$spec_arg" ]; then spec_arg="$1"; else
                    _spec_err "unexpected argument: $1"; return $SPEC_EXIT_USAGE
                fi
                shift ;;
        esac
    done

    local spec_path
    if ! spec_path="$(spec_resolve_source "$spec_arg")"; then
        if [ -n "$spec_arg" ]; then
            _spec_err "spec file not found: $spec_arg"
        else
            _spec_err "no spec found (looked for .loki/generated-prd.md, prd.md, PRD.md, docs/prd.md). Pass a path explicitly."
        fi
        return $SPEC_EXIT_USAGE
    fi

    case "$sub" in
        lock)
            spec_do_lock "$spec_path" "$out_dir" "lock"
            return $?
            ;;
        sync)
            spec_do_lock "$spec_path" "$out_dir" "sync"
            return $?
            ;;
        status)
            spec_do_status "$spec_path" "$out_dir" "$as_json"
            return $?
            ;;
        *)
            _spec_err "unknown subcommand: $sub"
            spec_help
            return $SPEC_EXIT_USAGE
            ;;
    esac
}

# Allow direct execution: bash autonomy/spec.sh <sub> [args]
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    spec_main "$@"
    exit $?
fi
