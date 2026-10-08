#!/usr/bin/env bash
# scripts/b9-scoreboard.sh -- ROUTER-1 B9 parity scoreboard (R1-17, docs/v11/ROUTER-1.md section 7).
# Runs the four arms on one repo and prints one METRICS row per arm and run:
#   1 raw        `claude -p` on the account default (baseline)
#   2 router     loki quick, LOKI_ROUTER=1
#   3 no-router  loki quick, LOKI_ROUTER=0 (attribution control)
#   4 no-advisor loki quick, LOKI_ROUTER=1 LOKI_ROUTER_ADVISOR=off
# Each row carries solve (hidden tests), wall seconds, usd and the receipt's route.shape_key.
#
#   --dry-run               fixture bugrepo + stub `claude` on PATH (no keys, no network)
#   --repo DIR --base SHA --test-cmd CMD [--task TEXT] [--name NAME]
#                           real mode: clone DIR at SHA per run; CMD exit 0 means solved
#   --n N                   runs per arm (default 1 in dry-run, 3 otherwise)
#   --results-out FILE      append one TSV line per run: arm repo run solved wall usd shape_key
#   --metrics-out FILE      append the METRICS rows to FILE (default: stdout only)
#   --emit-shape-defaults OUT.json --results FILE
#                           section 4.6: list every shape where arm 2 solved fewer runs than
#                           arm 1. Arm 1 has no receipt, so a repo's shape comes from its arm 2
#                           rows. No runs are made in this mode. Entries are `sonnet`, or
#                           `prior-default` when --confirm-results FILE (the Sonnet rerun, same TSV
#                           format) also solved fewer than raw on that shape.
#   BLOCKED: an arm that fails its authenticated preflight, or errors (not a timeout) before
#                           changing anything, is recorded as BLOCKED with the reason, exit 3. BLOCKED
#                           rows never count and never feed --emit-shape-defaults.
#   --emit-shape-defaults requires --confirm-results (exit 2 without it).
#   --emit-seed OUT.json --results FILE
#                           provisional seed for the confirming rerun: unconfirmed loss shapes (BLOCKED
#                           excluded), `"_provisional": true`. Exit 2, nothing written, for any path
#                           resolving into loki-ts/data/ (so never the shipped router-shape-defaults.json).
#                           The rerun must read the seed through a test-only path. NOTE: R1-16's
#                           shapeDefault() has no override yet; R1-11 or R1-19 must add
#                           LOKI_ROUTER_SHAPE_DEFAULTS_FILE (this script does not touch TS).
#   --repeat N              alias of --n (runs per arm); the later of --n/--repeat wins
#   --summarize FILE        no runs: print the per-arm summary (mean and min/max of wall, usd and the
#                           token fields) for a results TSV, plus `router_cost_ratio=<arm2/arm3 usd>` and
#                           `gate_1_05=PASS|FAIL` (D89 Amendment 2 / R1-19: router-on cost <= router-off x 1.05,
#                           n>=3 recorded runs per arm). Any field a run did not record prints NOT RECORDED,
#                           never 0; an unrecorded ratio is FAIL, never a false green. A real run prints
#                           this summary for its own rows at the end.
#   Per-run usage fields (TSV columns 8-12; from .loki/metrics/result-cost-*.json for arms 2-4, from the
#   claude JSON `usage` for arm 1): cache_read, cache_create, fresh_in, out, advisor_calls.
#   --timeout SEC           per-run limit via timeout -k (default 600)
#
# B9-RAW-ARM (D91 COST-HALF and 10x metric owner): two-arm raw-vs-loki mode, same task text and model family.
#   --ab                    arms `raw` (claude -p --output-format json, no Loki) and `loki` (loki start), n per arm
#                           (default 3) on each fixture: trivial-sum, two-bug (generated, hidden checks copied in
#                           after the arm finishes) and, when --repo/--base/--test-cmd are given, that real repo
#                           as a third fixture. Raw usd is claude's total_cost_usd; loki usd and verdict come from
#                           the run's receipt.json (cost.usd, verdict VERIFIED). Wall and cost come ONLY from the SDK
#                           result line (raw: total_cost_usd, duration_ms, cache_read/creation_input_tokens) or the
#                           RECEIPT-TRUTH receipt fields (time.total_s, cost.cache_read_tokens, cost.cache_creation_tokens;
#                           time.wall_s and cost.input_tokens are never read). A missing field, or total_s differing from
#                           the sum of time.stages by more than 1%, makes the row NOT RECORDED, never 0.
#   --arms LIST             with --ab, comma list of arms: raw (claude -p), raw-codex (codex exec --sandbox workspace-write
#                           --skip-git-repo-check, no Loki), loki. Default raw,loki. The ratio report needs both raw and
#                           loki; raw-codex rows are written to the TSV but not yet reported per arm. A raw-codex preflight failure (no codex, not logged in) is BLOCKED
#                           (rc 3, no scored row), never a failed solve. Codex reports no cost or wall here, so its
#                           usd and wall read NOT RECORDED. A timed-out cell is recorded (solved 0), not dropped.
#   --check-tasks TSV       no runs: validate the public FCR task set (id repo sha test_cmd license task): 40-hex SHA,
#                           license on the allowlist, unique ids. rc 1 invalid, rc 4 valid but under 20 rows (INCOMPLETE).
#   --dry                   alias of --dry-run; with --ab it uses recorded stubs (no keys, no network) for CI
#   --model M               passed to the raw arm as --model and to loki as LOKI_SESSION_MODEL
#   --version V             release label for the METRICS row and JSON
#   --json-out FILE         the report JSON (cost, correctness and wall ratios, 95% bootstrap intervals, n)
#   --ab-report TSV         no runs: report over an AB results TSV (arm fixture run solved verified wall usd cache_read cache_create);
#                           with --json-out, --metrics-out, --version. Math lives in scripts/b9-ab-report.py.
# Dry-run uses a throwaway HOME; real mode keeps the caller's HOME (credentials).
#
# Dry-run fixture: scripts/b9-fixtures/trivial-sum.sh (also used for the T10 supply-guard cost measurement,
# where the task is run as `loki start "$TASK"`; start has no --no-pr flag, PRs are opt-in via --pr).
# Test hook: B9_LOKI overrides the loki binary.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TASK="sum() skips the first element; fix it"
DRY=0 REPO="" BASE="" TESTCMD="" NAME="" N="" RESULTS_OUT="" METRICS_OUT="" EMIT="" SEED="" RESULTS_IN="" CONFIRM_IN="" TIMEOUT=600 SUMMARIZE="" AB=0 ABREPORT="" JSONOUT="" VERSION_LABEL="unknown" MODEL="" ABFIX="" ARMS="raw,loki" CHECKTASKS=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run|--dry) DRY=1 ;;
        --ab) AB=1 ;;
        --ab-report) ABREPORT="${2:-}"; shift ;;
        --json-out) JSONOUT="${2:-}"; shift ;;
        --version) VERSION_LABEL="${2:-}"; shift ;;
        --model) MODEL="${2:-}"; shift ;;
        --fixtures) ABFIX="${2:-}"; shift ;;
        --arms) ARMS="${2:-}"; shift ;;
        --check-tasks) CHECKTASKS="${2:-}"; shift ;;
        --repo) REPO="${2:-}"; shift ;;
        --base) BASE="${2:-}"; shift ;;
        --test-cmd) TESTCMD="${2:-}"; shift ;;
        --task) TASK="${2:-}"; shift ;;
        --name) NAME="${2:-}"; shift ;;
        --n|--repeat) N="${2:-}"; shift ;;
        --summarize) SUMMARIZE="${2:-}"; shift ;;
        --results-out) RESULTS_OUT="${2:-}"; shift ;;
        --metrics-out) METRICS_OUT="${2:-}"; shift ;;
        --emit-shape-defaults) EMIT="${2:-}"; [ -n "$EMIT" ] || { echo "--emit-shape-defaults needs an output path" >&2; exit 2; }; shift ;;
        --results) RESULTS_IN="${2:-}"; shift ;;
        --emit-seed) SEED="${2:-}"; [ -n "$SEED" ] || { echo "--emit-seed needs an output path" >&2; exit 2; }; shift ;;
        --confirm-results) CONFIRM_IN="${2:-}"; shift ;;
        --timeout) TIMEOUT="${2:-}"; shift ;;
        *) echo "usage: $0 --dry-run | --repo DIR --base SHA --test-cmd CMD | --emit-shape-defaults OUT.json --results FILE" >&2; exit 2 ;;
    esac
    shift
done
# FCR-2: --arms selects the --ab arms (default raw,loki); raw-codex is `codex exec --sandbox workspace-write --skip-git-repo-check` with no Loki.
for _a in ${ARMS//,/ }; do
    case "$_a" in raw|raw-codex|loki) ;; *) echo "b9-scoreboard: unknown arm '$_a' (raw, raw-codex, loki)" >&2; exit 2 ;; esac
done

# --- per-arm summary over a results TSV (also printed at the end of a run) -----
# Columns: 1 arm 2 repo 3 run 4 solved 5 wall 6 usd 7 shape 8 cache_read 9 cache_create 10 fresh_in 11 out 12 advisor_calls.
# A missing, "unknown", non-numeric or absent value is NOT RECORDED and is excluded from the mean (never counted as 0).
summarize_results() { # summarize_results FILE
    awk -F '\t' '
        function isnum(v) { return v ~ /^[0-9]+([.][0-9]+)?$/ }
        function fmt(v, f) { return (f == "usd") ? sprintf("%.4f", v) : sprintf("%.1f", v) }
        BEGIN {
            nf = split("wall usd cache_read cache_create fresh_in out advisor_calls", F, " ")
            col["wall"] = 5; col["usd"] = 6; col["cache_read"] = 8; col["cache_create"] = 9
            col["fresh_in"] = 10; col["out"] = 11; col["advisor_calls"] = 12
            nm[1] = "raw"; nm[2] = "router"; nm[3] = "no-router"; nm[4] = "no-advisor"
        }
        $1 ~ /^[1-4]$/ && $4 != "BLOCKED" {
            a = $1; runs[a]++
            for (i = 1; i <= nf; i++) {
                f = F[i]; v = $(col[f])
                if (isnum(v) && !(f == "usd" && v + 0 <= 0)) {
                    c[a, f]++; sum[a, f] += v
                    if (!((a, f) in mn) || v + 0 < mn[a, f]) mn[a, f] = v + 0
                    if (!((a, f) in mx) || v + 0 > mx[a, f]) mx[a, f] = v + 0
                }
            }
        }
        END {
            for (a = 1; a <= 4; a++) {
                if (!(a in runs)) { printf "summary arm %d %s: n=0 NOT RECORDED\n", a, nm[a]; continue }
                for (i = 1; i <= nf; i++) {
                    f = F[i]
                    if (c[a, f] == 0) { printf "summary arm %d %s %s: NOT RECORDED (0 of %d runs)\n", a, nm[a], f, runs[a]; continue }
                    printf "summary arm %d %s %s: mean=%s min=%s max=%s (n=%d of %d runs)\n", a, nm[a], f, fmt(sum[a, f] / c[a, f], f), fmt(mn[a, f], f), fmt(mx[a, f], f), c[a, f], runs[a]
                }
            }
            reason = ""
            if (c[2, "usd"] < 3 || c[3, "usd"] < 3) reason = sprintf("need n>=3 recorded usd per arm (router=%d, no-router=%d)", c[2, "usd"] + 0, c[3, "usd"] + 0)
            else if (sum[2, "usd"] <= 0 || sum[3, "usd"] <= 0) reason = "a mean usd is 0"
            if (reason != "") { print "router_cost_ratio=NOT RECORDED"; print "gate_1_05=FAIL"; print "gate_reason=" reason; exit }
            ratio = (sum[2, "usd"] / c[2, "usd"]) / (sum[3, "usd"] / c[3, "usd"])
            printf "router_cost_ratio=%.4f\n", ratio
            print (ratio <= 1.05 ? "gate_1_05=PASS" : "gate_1_05=FAIL")
        }' "$1"
}

# usage_fields KIND PATH: one TAB line `usd cache_read cache_create fresh_in out advisor_calls`.
# KIND=costdir: PATH is a .loki dir; sums its metrics/result-cost-*.json. KIND=claude: PATH is a claude -p JSON output.
# A field absent from any contributing record is NOT RECORDED; so are tokens that are all zero beside a nonzero
# dollar figure (the EV-8 failure mode).
usage_fields() {
    python3 -I - "$1" "$2" <<'PY'
import glob, json, os, re, sys
kind, path = sys.argv[1], sys.argv[2]
NR = "NOT RECORDED"
recs = []
if kind == "costdir":
    for f in sorted(glob.glob(os.path.join(path, "metrics", "result-cost-*.json"))):
        try:
            d = json.load(open(f))
            if isinstance(d, dict):
                recs.append(d)
        except Exception:
            pass
else:
    try:
        txt = open(path, errors="replace").read()
    except Exception:
        txt = ""
    for m in re.finditer(r"\{", txt):
        try:
            d, _ = json.JSONDecoder().raw_decode(txt[m.start():])
        except Exception:
            continue
        if isinstance(d, dict) and "total_cost_usd" in d:
            recs.append(d)
    recs = recs[-1:]
def num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)
def tot(get):
    vals = []
    for r in recs:
        v = get(r)
        if not num(v):
            return NR
        vals.append(v)
    return sum(vals) if vals else NR
def usage(r, *ks):
    u = r.get("usage") if kind == "claude" else r
    if not isinstance(u, dict):
        return None
    for k in ks:
        if k in u:
            return u[k]
    return None
usd = tot(lambda r: r.get("total_cost_usd"))
fields = [
    tot(lambda r: usage(r, "cache_read_input_tokens", "cache_read_tokens")),
    tot(lambda r: usage(r, "cache_creation_input_tokens", "cache_creation_tokens")),
    tot(lambda r: usage(r, "input_tokens")),
    tot(lambda r: usage(r, "output_tokens")),
]
if num(usd) and usd > 0 and all(num(x) for x in fields) and sum(fields) == 0:
    fields = [NR] * 4
adv = tot(lambda r: r.get("advisor_calls"))
print("\t".join(str(round(x, 6)) if isinstance(x, float) else str(x) for x in [usd] + fields + [adv]))
PY
}

# --- --emit-shape-defaults: pure computation over a results TSV ---------------
if [ -n "$SEED" ]; then
    # Provisional seed for the confirming rerun: every unconfirmed loss shape, BLOCKED excluded.
    # Never written into the shipped data dir; the rerun reads it through a test-only path.
    [ -f "$RESULTS_IN" ] || { echo "--emit-seed needs --results FILE (a results TSV)" >&2; exit 2; }
    realp() { python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$1"; }
    SEED_REAL="$(realp "$SEED")"
    SHIPPED_DIR="$(realp "$REPO_ROOT/loki-ts/data")"
    case "$SEED_REAL" in
        "$SHIPPED_DIR"/* | */loki-ts/data/*)
            echo "--emit-seed refuses a path inside loki-ts/data/ (the shipped router-shape-defaults.json is seeded only by R1-19 after a confirming rerun): $SEED" >&2
            exit 2 ;;
    esac
    awk -F '\t' -v src="$(basename "$RESULTS_IN")" -v day="$(date -u +%Y-%m-%d)" '
        ($1 == 1 || $1 == 2) && $4 == "BLOCKED" { blocked[$2] = 1; next }
        $1 == 2 && $7 != "" && $7 != "unknown" { shape[$2] = $7 }
        $1 == 1 || $1 == 2 { n[$1, $2]++; s[$1, $2] += ($4 == 1); repos[$2] = 1 }
        END {
            cnt = 0
            for (r in repos) {
                if (r in blocked) continue
                k = shape[r]; if (k == "") continue
                raw[k] += s[1, r]; rt[k] += s[2, r]; nr[k] += n[1, r]; nt[k] += n[2, r]
                if (!(k in seen)) { seen[k] = 1; order[++cnt] = k }
            }
            for (i = 1; i <= cnt; i++) for (j = i + 1; j <= cnt; j++) if (order[j] < order[i]) { t = order[i]; order[i] = order[j]; order[j] = t }
            printf "{\"$schema_version\":1,\"_provisional\":true,\"_source\":\"b9-scoreboard --emit-seed %s %s\",\"shapes\":{", src, day
            first = 1
            for (i = 1; i <= cnt; i++) {
                k = order[i]
                if (rt[k] < raw[k]) {
                    printf "%s\"%s\":{\"executor\":\"sonnet\",\"evidence\":\"B9 %s (unconfirmed): router %d/%d vs raw %d/%d\"}", (first ? "" : ","), k, src, rt[k], nt[k], raw[k], nr[k]
                    first = 0
                }
            }
            printf "}}\n"
        }' "$RESULTS_IN" > "$SEED" || exit 1
    exit 0
fi
if [ -n "$EMIT" ]; then
    [ -f "$RESULTS_IN" ] || { echo "--emit-shape-defaults needs --results FILE (a results TSV)" >&2; exit 2; }
    [ -n "$CONFIRM_IN" ] || { echo "--emit-shape-defaults requires --confirm-results FILE: a single unconfirmed loss never seeds a default" >&2; exit 2; }
    [ -f "$CONFIRM_IN" ] || { echo "--confirm-results file not found: $CONFIRM_IN" >&2; exit 2; }
    # The confirming rerun (seeded file present) is a second TSV of the same format; its arm 2 rows
    # are the Sonnet run. A shape the rerun also loses is prior-default, otherwise sonnet.
    awk -F '\t' -v src="$(basename "$RESULTS_IN")" -v day="$(date -u +%Y-%m-%d)" -v conf="$CONFIRM_IN" '
        conf != "" && FILENAME == conf && $4 == "BLOCKED" { if ($1 == 2) cbr[$2] = 1; next }
        conf != "" && FILENAME == conf { if ($1 == 2 && $7 != "" && $7 != "unknown") { cs[$7] += ($4 == 1); cn[$7]++ }; next }
        ($1 == 1 || $1 == 2) && $4 == "BLOCKED" { blocked[$2] = 1; next }
        $1 == 2 && $7 != "" && $7 != "unknown" { shape[$2] = $7 }
        $1 == 1 || $1 == 2 { n[$1, $2]++; s[$1, $2] += ($4 == 1); repos[$2] = 1 }
        END {
            cnt = 0
            for (r in repos) {
                if (r in blocked) { print "b9-scoreboard: " r " has a BLOCKED arm 1/2 row; excluded" > "/dev/stderr"; continue }
                k = shape[r]; if (k == "") continue
                if (r in cbr) cbk[k] = 1
                raw[k] += s[1, r]; rt[k] += s[2, r]; nr[k] += n[1, r]; nt[k] += n[2, r]
                if (!(k in seen)) { seen[k] = 1; order[++cnt] = k }
            }
            for (i = 1; i <= cnt; i++) for (j = i + 1; j <= cnt; j++) if (order[j] < order[i]) { t = order[i]; order[i] = order[j]; order[j] = t }
            printf "{\"$schema_version\":1,\"_source\":\"b9-scoreboard --emit-shape-defaults %s %s\",\"shapes\":{", src, day
            first = 1
            for (i = 1; i <= cnt; i++) {
                k = order[i]
                if (rt[k] < raw[k]) {
                    if (!(k in cn) || (k in cbk)) { print "b9-scoreboard: " k " is unconfirmed (no valid Sonnet rerun rows); not emitted" > "/dev/stderr"; continue }
                    ex = "sonnet"; ev = sprintf("B9 %s: router %d/%d vs raw %d/%d", src, rt[k], nt[k], raw[k], nr[k])
                    if (k in cn) {
                        ev = ev sprintf("; sonnet rerun %d/%d", cs[k], cn[k])
                        if (cs[k] * nr[k] < raw[k] * cn[k]) ex = "prior-default"
                    }
                    printf "%s\"%s\":{\"executor\":\"%s\",\"evidence\":\"%s\"}", (first ? "" : ","), k, ex, ev
                    first = 0
                }
            }
            printf "}}\n"
        }' ${CONFIRM_IN:+"$CONFIRM_IN"} "$RESULTS_IN" > "$EMIT" || exit 1
    exit 0
fi

ab_report() { # ab_report TSV
    [ -n "$JSONOUT" ] || { echo "--ab-report needs --json-out FILE" >&2; return 2; }
    python3 -I "$REPO_ROOT/scripts/b9-ab-report.py" "$1" --json-out "$JSONOUT" --version "$VERSION_LABEL" \
        ${METRICS_OUT:+--metrics-out "$METRICS_OUT"}
}
check_tasks() { # check_tasks TSV
    python3 -I - "$1" <<'PY'
import csv, re, sys
OK = {"MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0", "Unlicense", "0BSD", "CC0-1.0"}
rows, errs, seen = [], [], set()
with open(sys.argv[1], newline="") as fh:
    for i, r in enumerate(csv.reader(fh, delimiter="\t"), 1):
        if not r or r[0].startswith("#") or r[0] == "id":
            continue
        if len(r) < 6:
            errs.append("line %d: need 6 columns (id repo sha test_cmd license task)" % i); continue
        id_, repo, sha, cmd, lic, task = [c.strip() for c in r[:6]]
        if id_ in seen: errs.append("line %d: duplicate id %s" % (i, id_))
        seen.add(id_)
        if not re.fullmatch(r"[0-9a-f]{40}", sha): errs.append("line %d: %s sha is not a 40-hex SHA" % (i, id_))
        if not repo.startswith("https://"): errs.append("line %d: %s repo must be an https URL" % (i, id_))
        if not cmd: errs.append("line %d: %s has no hidden test command" % (i, id_))
        if not task: errs.append("line %d: %s has no task text" % (i, id_))
        if lic not in OK: errs.append("line %d: %s license %r is not on the allowlist" % (i, id_, lic))
        rows.append(id_)
for e in errs: print(e)
n = len(rows)
if errs:
    print("tasks=%d INVALID" % n); sys.exit(1)
if n < 20:
    print("tasks=%d INCOMPLETE (need at least 20)" % n); sys.exit(4)
print("tasks=%d complete" % n)
PY
}
if [ -n "$CHECKTASKS" ]; then
    [ -f "$CHECKTASKS" ] || { echo "--check-tasks needs an existing TSV: $CHECKTASKS" >&2; exit 2; }
    check_tasks "$CHECKTASKS"; exit $?
fi

if [ -n "$ABREPORT" ]; then
    [ -f "$ABREPORT" ] || { echo "--ab-report needs an existing results TSV: $ABREPORT" >&2; exit 2; }
    ab_report "$ABREPORT"
    exit $?
fi

if [ -n "$SUMMARIZE" ]; then
    [ -f "$SUMMARIZE" ] || { echo "--summarize needs an existing results TSV: $SUMMARIZE" >&2; exit 2; }
    summarize_results "$SUMMARIZE"
    exit 0
fi

# --- run mode ------------------------------------------------------------------
# shellcheck source=/dev/null
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
mkdir -p "$T/home" "$T/bin"
RUN_TSV="$T/run-results.tsv"; : > "$RUN_TSV"

if [ "$DRY" -eq 1 ]; then
    [ -n "$N" ] || { [ "$AB" -eq 1 ] && N=3 || N=1; }
    NAME="${NAME:-fixture}"
    TESTCMD="node --test"
elif [ "$AB" -eq 1 ] && [ -z "$REPO" ]; then
    [ -n "$N" ] || N=3
elif [ -z "$REPO" ] || [ -z "$BASE" ] || [ -z "$TESTCMD" ]; then
    echo "real mode needs --repo, --base and --test-cmd (or use --dry-run)" >&2; exit 2
else
    [ -n "$N" ] || N=3
    NAME="${NAME:-$(basename "$REPO")}"
fi

mk_fixture() { # mk_fixture DIR (empty path): the shared B9 trivial fixture
    bash "$REPO_ROOT/scripts/b9-fixtures/trivial-sum.sh" "$1"
}

if [ "$DRY" -eq 1 ]; then
    cat > "$T/bin/claude" <<'STUB'
#!/usr/bin/env bash
case " $* " in *" --help "*|*" --version "*) echo "claude stub 2.1.285 --settings --session-id --resume --model --dangerously-skip-permissions"; exit 0;; esac
[ -f sum.js ] && sed -i.bak 's/i *= *1/i = 0/' sum.js && rm -f sum.js.bak
[ -f stats.js ] && sed -i.bak -e 's/(xs.length-1)/xs.length/' -e 's/let m=0/let m=-Infinity/' stats.js && rm -f stats.js.bak
mkdir -p .loki/signals; echo "fixed sum loop" > .loki/signals/COMPLETION_REQUESTED
CJ='{"type":"result","total_cost_usd": 0.0123,"duration_ms": 14000,"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":500,"cache_creation_input_tokens":100}}'
case " $* " in *" json "*) echo "${B9_STUB_CLAUDE_JSON-$CJ}";; *) echo "stub claude done";; esac
STUB
    chmod +x "$T/bin/claude"
    cat > "$T/bin/codex" <<'STUB'
#!/usr/bin/env bash
# stub codex for CI: B9_STUB_CODEX_AUTH=fail fails the preflight; B9_STUB_CODEX_MODE=noop edits nothing, sleep hangs.
# Like current codex it rejects unknown flags (rc 2, e.g. --full-auto) and refuses a non-git cwd without --skip-git-repo-check.
skip=0
for a in "$@"; do
    case "$a" in
        exec|workspace-write|read-only|danger-full-access) ;;
        --sandbox) ;;
        --skip-git-repo-check) skip=1 ;;
        -*) echo "error: unexpected argument '$a' found" >&2; exit 2 ;;
    esac
done
if [ "$skip" -eq 0 ] && ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Not inside a trusted directory and --skip-git-repo-check was not specified." >&2; exit 1
fi
case " $* " in *" single word OK "*) [ "${B9_STUB_CODEX_AUTH:-}" = fail ] && { echo "codex: not logged in" >&2; exit 1; }; echo OK; exit 0;; esac
[ "${B9_STUB_CODEX_MODE:-}" != sleep ] || sleep 30
if [ "${B9_STUB_CODEX_MODE:-}" != noop ]; then
    [ -f sum.js ] && sed -i.bak 's/i *= *1/i = 0/' sum.js && rm -f sum.js.bak
    [ -f stats.js ] && sed -i.bak -e 's/(xs.length-1)/xs.length/' -e 's/let m=0/let m=-Infinity/' stats.js && rm -f stats.js.bak
fi
echo "stub codex done"
STUB
    chmod +x "$T/bin/codex"
    export PATH="$T/bin:$PATH" LOKI_SKIP_AUTH_PREFLIGHT=1 LOKI_E10_INVOKER=cli
fi
# Only the dry-run gets a throwaway HOME. Real mode needs the user's own credentials, or every
# arm runs unauthenticated, scores solved=0 and --emit-shape-defaults seeds false losses.
[ "$DRY" -ne 1 ] || export HOME="$T/home"
export LOKI_NO_BROWSER=1 LOKI_DASHBOARD=false
unset LOKI_PROVIDER
LOKI="${B9_LOKI:-$REPO_ROOT/bin/loki}"

prep_run() { # prep_run DIR
    local d="$1"
    mkdir -p "$d"
    if [ "$DRY" -eq 1 ]; then
        mk_fixture "$d"
    else
        git clone -q --local "$REPO" "$d/repo" && git -C "$d/repo" checkout -q "$BASE"
    fi
}

arm_label() {
    case "$1" in 1) echo raw ;; 2) echo router ;; 3) echo no-router ;; *) echo no-advisor ;; esac
}

emit_row() { # emit_row arm run solved wall usd shape cache_read cache_create fresh_in out advisor_calls
    local row nr="NOT RECORDED" line
    row=$(printf '| %s | b9-scoreboard arm %s %s | %s run %s | solved=%s wall=%ss usd=%s shape_key=%s cache_read=%s cache_create=%s fresh_in=%s out=%s advisor_calls=%s |' \
        "$(date -u +%Y-%m-%dT%H:%MZ)" "$1" "$(arm_label "$1")" "$NAME" "$2" "$3" "$4" "$5" "$6" "${7:-$nr}" "${8:-$nr}" "${9:-$nr}" "${10:-$nr}" "${11:-$nr}")
    line=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$1" "$NAME" "$2" "$3" "$4" "$5" "$6" "${7:-$nr}" "${8:-$nr}" "${9:-$nr}" "${10:-$nr}" "${11:-$nr}")
    printf '%s\n' "$line" >> "$RUN_TSV"
    printf '%s\n' "$row"
    [ -z "$METRICS_OUT" ] || printf '%s\n' "$row" >> "$METRICS_OUT"
    [ -z "$RESULTS_OUT" ] || printf '%s\n' "$line" >> "$RESULTS_OUT"
}

emit_blocked() { # emit_blocked arm run reason
    local reason row
    reason=$(printf '%s' "$3" | tr '\t\n|' '   ' | cut -c1-200)
    row=$(printf '| %s | b9-scoreboard arm %s %s | %s run %s | BLOCKED reason=%s |' \
        "$(date -u +%Y-%m-%dT%H:%MZ)" "$1" "$(arm_label "$1")" "$NAME" "$2" "$reason")
    printf '%s\n' "$row"
    [ -z "$METRICS_OUT" ] || printf '%s\n' "$row" >> "$METRICS_OUT"
    [ -z "$RESULTS_OUT" ] || printf '%s\t%s\t%s\tBLOCKED\t0\tunknown\tunknown\t%s\n' "$1" "$NAME" "$2" "$reason" >> "$RESULTS_OUT"
}

# ARMENV is the exact env wrapper an arm runs under (preflight uses the same one, same HOME).
set_armenv() {
    case "$1" in
        1) ARMENV=(env) ;;
        2) ARMENV=(env -u LOKI_ROUTER_ADVISOR LOKI_ROUTER=1) ;;
        3) ARMENV=(env -u LOKI_ROUTER_ADVISOR LOKI_ROUTER=0) ;;
        *) ARMENV=(env LOKI_ROUTER=1 LOKI_ROUTER_ADVISOR=off) ;;
    esac
}

# One trivial authenticated call under the arm's env. An arm that cannot authenticate is
# BLOCKED, never scored: n=0 is not a pass (FC-16).
PF_REASON=""
preflight() { # preflight arm
    local pd="$T/pf-$1" rc
    mkdir -p "$pd"
    set_armenv "$1"
    ( cd "$pd" && timeout -k 10 "$TIMEOUT" "${ARMENV[@]}" claude -p "Reply with the single word OK" --output-format json ) < /dev/null > "$pd.out" 2>&1
    rc=$?
    if [ "$rc" -ne 0 ] || grep -Eq '"is_error": *true' "$pd.out"; then
        PF_REASON="preflight rc=$rc: $(cat "$pd.out")"
        return 1
    fi
    return 0
}


# --- --ab: raw vs loki on the same task text (B9-RAW-ARM) -----------------------
# receipt_fields DIR: TAB line `verified usd wall_s cache_read cache_create` from the newest .loki/runs/*/receipt.json.
# Cost and time come ONLY from the RECEIPT-TRUTH fields: time.total_s and cost.{usd,cache_read_tokens,cache_creation_tokens}.
# The old time.wall_s (a stage sum) and cost.input_tokens are never read as totals. verified is 1 only for verdict
# VERIFIED. The four measures read NOT RECORDED together (the row is unusable) when any new field is absent or not a
# positive/non-negative number, or when time.stages exists and total_s differs from its sum by more than 1%.
receipt_fields() {
    python3 -I - "$1" <<'PY'
import glob, json, os, sys
NR = "NOT RECORDED"
fs = sorted(glob.glob(os.path.join(sys.argv[1], ".loki", "runs", "*", "receipt.json")), key=os.path.getmtime)
v, out = 0, [NR] * 4
def num(x, pos):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and (x > 0 if pos else x >= 0)
if fs:
    try:
        d = json.load(open(fs[-1]))
        v = 1 if d.get("verdict") == "VERIFIED" else 0
        c, t = d.get("cost") or {}, d.get("time") or {}
        ok = num(c.get("usd"), True) and num(t.get("total_s"), True) \
            and num(c.get("cache_read_tokens"), False) and num(c.get("cache_creation_tokens"), False)
        st = t.get("stages")
        if ok:
            # same rule as the engine's reconciledTotalS: stages required, within 1% of total_s
            if not (isinstance(st, dict) and st):
                ok = False
            else:
                vals = [x for x in st.values() if num(x, False)]
                if len(vals) != len(st) or abs(t["total_s"] - sum(vals)) > 0.01 * t["total_s"]:
                    ok = False
        if ok:
            out = [round(c["usd"], 6), round(t["total_s"], 3), c["cache_read_tokens"], c["cache_creation_tokens"]]
    except Exception:
        pass
print("\t".join([str(v)] + [str(x) for x in out]))
PY
}

# raw_fields PATH: TAB line `usd wall_s cache_read cache_create` from the claude -p SDK result line only
# (total_cost_usd, duration_ms, usage.cache_read_input_tokens, usage.cache_creation_input_tokens). All four read
# NOT RECORDED together when the result line lacks any of them (a timed-out run has no result line).
raw_fields() {
    python3 -I - "$1" <<'PY'
import json, re, sys
NR = "NOT RECORDED"
try:
    txt = open(sys.argv[1], errors="replace").read()
except Exception:
    txt = ""
recs = []
for m in re.finditer(r"\{", txt):
    try:
        d, _ = json.JSONDecoder().raw_decode(txt[m.start():])
    except Exception:
        continue
    if isinstance(d, dict) and "total_cost_usd" in d:
        recs.append(d)
out = [NR] * 4
def num(x, pos):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and (x > 0 if pos else x >= 0)
if recs:
    d = recs[-1]
    u = d.get("usage") if isinstance(d.get("usage"), dict) else {}
    if num(d.get("total_cost_usd"), True) and num(d.get("duration_ms"), True) \
            and num(u.get("cache_read_input_tokens"), False) and num(u.get("cache_creation_input_tokens"), False):
        out = [round(d["total_cost_usd"], 6), round(d["duration_ms"] / 1000.0, 3),
               u["cache_read_input_tokens"], u["cache_creation_input_tokens"]]
print("\t".join(str(x) for x in out))
PY
}

run_ab() {
    local LBL AB_TSV="${RESULTS_OUT:-$T/ab-results.tsv}" fixtures fx arm run W D H TASKF TESTF S OUT ARC WALL SOLVED UF USD VERIFIED RF
    : > "$AB_TSV"
    if [ -n "$ABFIX" ]; then fixtures="${ABFIX//,/ }"; else fixtures="trivial-sum two-bug"; fi
    [ "$DRY" -eq 1 ] || [ -z "$REPO" ] || fixtures="$fixtures repo"
    if [ "$DRY" -eq 1 ] && [ -z "${B9_LOKI:-}" ]; then
        cat > "$T/bin/loki-stub" <<'STUB'
#!/usr/bin/env bash
[ -f sum.js ] && sed -i.bak 's/i *= *1/i = 0/' sum.js && rm -f sum.js.bak
[ -f stats.js ] && sed -i.bak -e 's/(xs.length-1)/xs.length/' -e 's/let m=0/let m=-Infinity/' stats.js && rm -f stats.js.bak
mkdir -p .loki/runs/r1
REC='{"schema":"loki.v10.receipt/1","verdict":"VERIFIED","cost":{"usd":0.0456,"cache_read_tokens":1000,"cache_creation_tokens":200},"time":{"wall_s":9,"total_s":42,"stages":{"plan":10,"implement":30,"verify":2}}}'
printf '%s\n' "${B9_STUB_RECEIPT-$REC}" > .loki/runs/r1/receipt.json
echo "Cost: \$0.0456"
STUB
        chmod +x "$T/bin/loki-stub"; LOKI="$T/bin/loki-stub"
    fi
    if [ "$DRY" -eq 0 ] && case ",$ARMS," in *,raw,*) true ;; *) false ;; esac && ! preflight 1; then
        echo "b9-scoreboard: raw arm BLOCKED: $PF_REASON" >&2; return 3
    fi
    local blocked=0
    case ",$ARMS," in *,raw-codex,*)
        mkdir -p "$T/pf-codex"
        if ! ( cd "$T/pf-codex" && timeout -k 10 "$TIMEOUT" codex exec --sandbox workspace-write --skip-git-repo-check "Reply with the single word OK" ) < /dev/null > "$T/pf-codex.out" 2>&1; then
            echo "b9-scoreboard: raw-codex arm BLOCKED: preflight failed: $(tail -c 200 "$T/pf-codex.out")" >&2; return 3
        fi ;;
    esac
    for fx in $fixtures; do
        for run in $(seq 1 "$N"); do
            for arm in ${ARMS//,/ }; do
                W="$T/ab-$fx-$arm-$run"; H="$W.hidden"; D="$W"; LBL="$fx"
                case "$fx" in
                    trivial-sum) bash "$REPO_ROOT/scripts/b9-fixtures/trivial-sum.sh" "$W" >/dev/null; TASKF="$TASK"; TESTF="node --test" ;;
                    two-bug) bash "$REPO_ROOT/scripts/b9-fixtures/b9-ab-two-bug.sh" "$W" "$H" >/dev/null; TASKF="mean() and max() in stats.js return wrong results; fix both"; TESTF="cp $H/hidden.test.js . && node --test" ;;
                    repo) mkdir -p "$W"; git clone -q --local "$REPO" "$W/repo" && git -C "$W/repo" checkout -q "$BASE"; D="$W/repo"; TASKF="$TASK"; TESTF="$TESTCMD"; LBL="${NAME:-repo}" ;;
                    *) echo "b9-scoreboard: unknown fixture $fx" >&2; return 2 ;;
                esac
                OUT="$T/ab-out-$LBL-$arm-$run.log"
                if [ "$arm" = raw-codex ]; then
                    ( cd "$D" && timeout -k 10 "$TIMEOUT" codex exec --sandbox workspace-write --skip-git-repo-check "$TASKF" ) < /dev/null > "$OUT" 2>&1
                elif [ "$arm" = raw ]; then
                    ( cd "$D" && timeout -k 10 "$TIMEOUT" claude -p "$TASKF" --dangerously-skip-permissions --output-format json ${MODEL:+--model "$MODEL"} ) < /dev/null > "$OUT" 2>&1
                else
                    ( cd "$D" && timeout -k 10 "$TIMEOUT" env ${MODEL:+LOKI_SESSION_MODEL="$MODEL"} "$LOKI" start "$TASKF" ) < /dev/null > "$OUT" 2>&1
                fi
                ARC=$?
                if [ "$ARC" -ne 0 ] && [ "$ARC" -ne 124 ] && [ "$ARC" -ne 137 ] \
                    && [ -z "$(git -C "$D" status --porcelain -- . ':!.loki' 2>/dev/null)" ]; then
                    echo "b9-scoreboard: $arm run $run on $fx BLOCKED: exit $ARC before any work: $(tail -c 200 "$OUT")" >&2
                    blocked=$((blocked + 1)); continue
                fi
                SOLVED=0; ( cd "$D" && bash -c "$TESTF" ) > "$T/ab-test-$LBL-$arm-$run.log" 2>&1 && SOLVED=1
                # Cost and time come from the SDK result line (raw) or the receipt (loki), never from our own clock.
                if [ "$arm" = raw-codex ]; then
                    VERIFIED="$SOLVED"; USD="NOT RECORDED"; WALLR="NOT RECORDED"; CR="NOT RECORDED"; CC="NOT RECORDED"
                elif [ "$arm" = raw ]; then
                    RF=$(raw_fields "$OUT"); VERIFIED="$SOLVED"
                    IFS=$'\t' read -r USD WALLR CR CC <<< "$RF"
                else
                    RF=$(receipt_fields "$D")
                    IFS=$'\t' read -r VERIFIED USD WALLR CR CC <<< "$RF"
                fi
                printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$arm" "$LBL" "$run" "$SOLVED" "$VERIFIED" "$WALLR" "$USD" "$CR" "$CC" >> "$AB_TSV"
            done
        done
    done
    [ "$blocked" -eq 0 ] || { echo "b9-scoreboard: $blocked BLOCKED run(s): this report does not count" >&2; return 3; }
    [ -n "$JSONOUT" ] || JSONOUT="$T/ab-report.json"
    ab_report "$AB_TSV"
}
if [ "$AB" -eq 1 ]; then run_ab; exit $?; fi

FAILS=0 BLOCKED=0
arm=1
while [ "$arm" -le 4 ]; do
    run=1
    if ! preflight "$arm"; then
        while [ "$run" -le "$N" ]; do
            emit_blocked "$arm" "$run" "$PF_REASON"; BLOCKED=$((BLOCKED + 1)); run=$((run + 1))
        done
        arm=$((arm + 1)); continue
    fi
    set_armenv "$arm"
    while [ "$run" -le "$N" ]; do
        W="$T/work-$arm-$run"
        if ! prep_run "$W"; then
            echo "b9-scoreboard: could not prepare $W" >&2; FAILS=$((FAILS + 1)); run=$((run + 1)); continue
        fi
        D="$W"; [ "$DRY" -eq 1 ] || D="$W/repo"
        S=$(date +%s)
        OUT="$T/out-$arm-$run.log"
        if [ "$arm" -eq 1 ]; then
            ( cd "$D" && timeout -k 10 "$TIMEOUT" "${ARMENV[@]}" claude -p "$TASK" --dangerously-skip-permissions --output-format json ) < /dev/null > "$OUT" 2>&1
        else
            ( cd "$D" && timeout -k 10 "$TIMEOUT" "${ARMENV[@]}" "$LOKI" quick "$TASK" ) < /dev/null > "$OUT" 2>&1
        fi
        ARC=$?
        WALL=$(( $(date +%s) - S ))
        # Errored (not a timeout) before changing anything: nothing was attempted, so it is not a score.
        if [ "$ARC" -ne 0 ] && [ "$ARC" -ne 124 ] && [ "$ARC" -ne 137 ] \
            && [ -z "$(git -C "$D" status --porcelain -- . ':!.loki' 2>/dev/null)" ]; then
            emit_blocked "$arm" "$run" "exit $ARC before any work: $(tail -c 300 "$OUT")"
            BLOCKED=$((BLOCKED + 1)); run=$((run + 1)); continue
        fi
        SOLVED=0
        ( cd "$D" && bash -c "$TESTCMD" ) > "$T/test-$arm-$run.log" 2>&1 && SOLVED=1
        if [ "$arm" -eq 1 ]; then
            UF=$(usage_fields claude "$OUT")
        else
            UF=$(usage_fields costdir "$D/.loki")
        fi
        IFS=$'\t' read -r U_USD U_CR U_CC U_FR U_OUT U_ADV <<< "$UF"
        if [ "$arm" -eq 1 ]; then
            USD=$(grep -Eo '"total_cost_usd": *[0-9.]+' "$T/out-$arm-$run.log" | sed -n 1p | grep -Eo '[0-9.]+$')
        else
            USD=$(sed 's/\x1b\[[0-9;]*m//g' "$T/out-$arm-$run.log" | grep -Eo 'Cost[: |]*\$[0-9.]+' | sed -n 1p | grep -Eo '[0-9.]+$')
        fi
        SHAPE=""
        if [ "$arm" -ne 1 ] && [ -d "$D/.loki" ]; then
            FOUND=$(grep -rEho '"shape_key" *: *"[^"]*"' "$D/.loki" --include='*.json' 2>/dev/null)
            FOUND="${FOUND%%$'\n'*}"
            if [ -n "$FOUND" ]; then
                SHAPE="${FOUND#*\"shape_key\"}"; SHAPE="${SHAPE#*\"}"; SHAPE="${SHAPE%\"*}"
            fi
        fi
        # Dollars: the result-cost/usage figure first, else the figure scraped from the output above.
        case "${U_USD:-}" in ''|"NOT RECORDED") ;; *) USD="$U_USD" ;; esac
        emit_row "$arm" "$run" "$SOLVED" "$WALL" "${USD:-unknown}" "${SHAPE:-unknown}" "$U_CR" "$U_CC" "$U_FR" "$U_OUT" "$U_ADV"
        run=$((run + 1))
    done
    arm=$((arm + 1))
done
summarize_results "$RUN_TSV"
[ "$BLOCKED" -eq 0 ] || { echo "b9-scoreboard: $BLOCKED BLOCKED run(s): this scoreboard does not count" >&2; exit 3; }
[ "$FAILS" -eq 0 ]
