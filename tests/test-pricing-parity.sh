#!/usr/bin/env bash
#
# test-pricing-parity.sh (MW-1 round 2)
#
# The per-model price rows live in six places that must agree. A bump in one
# (loki-ts/data/model-pricing.json) that misses a sibling makes the TS route
# report a different cost than the dashboard and the bash budget gate.
# Compares input and output $/MTok for every Claude model key present in 2 or
# more tables, and cache_read / cache_write between the JSON and the budget.ts
# fallback. Offline, reads tracked files only.
#
# Tables: model-pricing.json, budget.ts _FALLBACK_PRICING, run.sh
# _write_pricing_json, run.sh check_budget_limit, dashboard/server.py
# _DEFAULT_PRICING, autonomy/loki cost-estimate table (title-case keys).
# Non-Claude rows (codex, gpt-5.6-*) are out of scope here.
#
# LOKI_PRICING_PARITY_ROOT points the test at a mutated copy (mutation check).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${LOKI_PRICING_PARITY_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"

# #310: .loki/pricing.json rows derive from model-pricing.json at runtime. Run the
# real _write_pricing_json from run.sh against a pricing source (SCRIPT_DIR layout:
# <tree>/autonomy next to <tree>/loki-ts/data) and copy the written file to $2.
# shellcheck disable=SC2329
write_pricing_out() {
    local src="$1" dest="$2" work rc=0
    work="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")" || return 1
    mkdir -p "$work/autonomy" "$work/loki-ts/data" "$work/proj/.loki"
    cp "$src" "$work/loki-ts/data/model-pricing.json" 2>/dev/null || true
    (
        cd "$work/proj" || exit 1
        SCRIPT_DIR="$work/autonomy"
        log_error() { :; }; log_warn() { :; }; log_info() { :; }
        # shellcheck disable=SC1090
        source <(awk 'f && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ {exit} /^_write_pricing_json\(\) \{/ {f=1} f' "$REPO_ROOT/autonomy/run.sh")
        _write_pricing_json 2>/dev/null
        cp .loki/pricing.json "$dest"
    ) || rc=$?
    case "$work" in "${TMPDIR:-/tmp}"/loki-run.*) rm -rf -- "$work" ;; esac
    return "$rc"
}
pricing_out_dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")" || exit 1
write_pricing_out "$REPO_ROOT/loki-ts/data/model-pricing.json" "$pricing_out_dir/pricing.json" \
    || echo "FAIL: _write_pricing_json did not run against the real pricing source"

python3 - "$REPO_ROOT" "$pricing_out_dir/pricing.json" <<'PY'
import json, re, sys

root = sys.argv[1]
KEYS = ("fable", "claude-fable-5", "opus", "sonnet", "haiku", "claude-haiku-4-5", "claude-haiku-5-5")
NUM = r"([0-9]+(?:\.[0-9]+)?)"


def read(p):
    with open(f"{root}/{p}", encoding="utf-8") as f:
        return f.read()


def rows_dict(text, q):
    """Rows like  'key': {'input': X, 'output': Y  (either quote style)."""
    pat = re.compile(
        rf"{q}([A-Za-z0-9.\-]+){q}\s*:\s*\{{\s*{q}input{q}\s*:\s*{NUM}\s*,\s*{q}output{q}\s*:\s*{NUM}"
    )
    out = {}
    for m in pat.finditer(text):
        k = m.group(1).lower()
        if k in KEYS:
            out.setdefault(k, (float(m.group(2)), float(m.group(3))))
    return out


def window(text, marker, size):
    a = text.index(marker)
    return text[a : a + size]


tables = {}
pj = json.loads(read("loki-ts/data/model-pricing.json"))["pricing"]
tables["model-pricing.json"] = {k: (v["input"], v["output"]) for k, v in pj.items() if k in KEYS}

ts = read("loki-ts/src/runner/budget.ts")
fb = window(ts, "const _FALLBACK_PRICING", 3000)
fb = fb[: fb.index("};")]
ts_rows, ts_cache = {}, {}
for m in re.finditer(
    rf"\"?([A-Za-z0-9.\-]+)\"?:\s*\{{\s*input:\s*{NUM},\s*output:\s*{NUM}(?:,\s*cache_read:\s*{NUM},\s*cache_write:\s*{NUM})?",
    fb,
):
    if m.group(1) in KEYS:
        ts_rows[m.group(1)] = (float(m.group(2)), float(m.group(3)))
        if m.group(4):
            ts_cache[m.group(1)] = (float(m.group(4)), float(m.group(5)))
tables["budget.ts fallback"] = ts_rows

run = read("autonomy/run.sh")
try:
    with open(sys.argv[2], encoding="utf-8") as _fh:
        gen = json.load(_fh)["models"]
except (OSError, ValueError, KeyError):
    gen = {}
tables["run.sh _write_pricing_json"] = {k: (v["input"], v["output"]) for k, v in gen.items() if k in KEYS}
tables["run.sh check_budget_limit"] = rows_dict(window(run, "pricing = {\n    'fable'", 1800), "'")
tables["dashboard _DEFAULT_PRICING"] = rows_dict(window(read("dashboard/server.py"), '"fable":  {"input"', 1800), '"')
tables["autonomy/loki"] = rows_dict(window(read("autonomy/loki"), "pricing = {\n    'Fable'", 400), "'")

fails = 0
for name, t in tables.items():
    print(f"  {name}: {t}")
    if not t:
        print(f"FAIL: no Claude rows extracted from {name}")
        fails += 1

for k in KEYS:
    have = {n: t[k] for n, t in tables.items() if k in t}
    if len(have) >= 2 and len(set(have.values())) != 1:
        print(f"FAIL: {k} input/output differ across tables: {have}")
        fails += 1
    elif have:
        print(f"ok:   {k} {sorted(set(have.values()))[0]} in {len(have)} tables")

for k, v in ts_cache.items():
    jc = pj[k]
    if (jc.get("cache_read"), jc.get("cache_write")) != v:
        print(f"FAIL: {k} cache rates differ: json={(jc.get('cache_read'), jc.get('cache_write'))} budget.ts={v}")
        fails += 1

for name in ("run.sh check_budget_limit", "dashboard _DEFAULT_PRICING", "autonomy/loki", "run.sh _write_pricing_json"):
    if "sonnet" not in tables[name]:
        print(f"FAIL: sonnet missing from {name}")
        fails += 1

# PRICE-TRUTH: pin the Claude rows to the published page (read 2026-10-08,
# platform.claude.com/docs/en/about-claude/pricing) and require every table
# that carries cache rates to agree with the JSON. Tuple order: input, output,
# cache_read, cache_write_5m, cache_write_1h.
PUBLISHED = {
    "fable": (10.0, 50.0, 0.25, 12.5, 20.0),
    "opus": (4.0, 20.0, 0.2, 5.0, 8.0),
    "sonnet": (2.0, 10.0, 0.1, 2.5, 4.0),
    "haiku": (0.1, 0.5, 0.01, 0.125, 0.2),
    "claude-haiku-5-5": (0.1, 0.5, 0.01, 0.125, 0.2),
    # Previous Haiku, still in the catalog: exact id stays $1/$5 (R1-02).
    "claude-haiku-4-5": (1.0, 5.0, 0.1, 1.25, 2.0),
}
for k, want in PUBLISHED.items():
    e = pj[k]
    got = (e["input"], e["output"], e.get("cache_read"), e.get("cache_write_5m"), e.get("cache_write_1h"))
    if got != want:
        print(f"FAIL: model-pricing.json {k} {got} != published {want}")
        fails += 1
    if e.get("cache_write") != e.get("cache_write_5m"):
        print(f"FAIL: model-pricing.json {k} legacy cache_write != cache_write_5m")
        fails += 1


def cache_rows(text, q):
    """Per-row cache_read / cache_write for rows keyed by a known model."""
    out = {}
    for m in re.finditer(rf"{q}([A-Za-z0-9.\-]+){q}\s*:\s*\{{((?:[^{{}}]|\{{[^{{}}]*\}})*)\}}", text):
        k = m.group(1).lower()
        if k not in PUBLISHED:
            continue
        row = {}
        for f in ("cache_read", "cache_write"):
            n = re.search(rf"{q}?{f}{q}?\s*[:=]\s*{NUM}", m.group(2))
            if n:
                row[f] = float(n.group(1))
        out.setdefault(k, row)
    return out


cache_tables = {
    "budget.ts fallback": cache_rows(fb, '"?'),
    "run.sh _write_pricing_json": {k: {f: float(v[f]) for f in ("cache_read", "cache_write") if f in v} for k, v in gen.items() if k in PUBLISHED},
    "run.sh check_budget_limit": cache_rows(window(run, "pricing = {\n    'fable'", 900), "'"),
    "dashboard _DEFAULT_PRICING": cache_rows(window(read("dashboard/server.py"), '"fable":  {"input"', 900), '"'),
}
for name, t in cache_tables.items():
    for k, row in t.items():
        if k == "claude-haiku-5-5":
            continue
        for f, v in row.items():
            want = pj[k]["cache_read"] if f == "cache_read" else pj[k]["cache_write_5m"]
            if v != want:
                print(f"FAIL: {name} {k} {f}={v} != json {want}")
                fails += 1
    for k in ("opus", "sonnet", "haiku", "fable"):
        if k in tables[name] and not t.get(k, {}).get("cache_read"):
            print(f"FAIL: {name} {k} carries no cache_read rate")
            fails += 1

# Exact-id rows (PRICE-TRUTH-2): a model-id-keyed lookup (the bash route uses an
# exact-string dict with a sonnet fallback) must find these ids, or a Haiku run
# is priced at the sonnet row (a 20x overcharge). Every id-keyed table carries both.
for name in ("model-pricing.json", "budget.ts fallback", "run.sh _write_pricing_json", "run.sh check_budget_limit", "dashboard _DEFAULT_PRICING"):
    for k in ("claude-haiku-4-5", "claude-haiku-5-5"):
        if k not in tables[name]:
            print(f"FAIL: {name} has no exact-id row for {k}")
            fails += 1
        elif tables[name][k] != PUBLISHED[k][:2]:
            print(f"FAIL: {name} {k} {tables[name][k]} != published {PUBLISHED[k][:2]}")
            fails += 1

# Alias rows must price exactly as the catalog-resolved model (PRICE-TRUTH):
# providers/model_catalog.json cli_aliases names the target id, and the page row
# for that id is the truth. Tables that cannot express a prompt-length tier carry
# the up-to-100K row only (Haiku 5.5).
catalog = json.loads(read("providers/model_catalog.json"))["providers"]["claude"]["cli_aliases"]
BY_ID = {
    "claude-fable-5-1": PUBLISHED["fable"],
    "claude-opus-5-5": PUBLISHED["opus"],
    "claude-sonnet-5-5": PUBLISHED["sonnet"],
    "claude-haiku-5-5": (0.1, 0.5, 0.01, 0.125, 0.2),
}
for alias in ("fable", "opus", "sonnet", "haiku"):
    target = catalog.get(alias)
    if target not in BY_ID:
        print(f"FAIL: catalog alias {alias} -> {target} has no published row in this test")
        fails += 1
        continue
    want = BY_ID[target]
    if PUBLISHED[alias] != want:
        print(f"FAIL: alias {alias} pinned {PUBLISHED[alias]} != {target} {want}")
        fails += 1
    for name, t in tables.items():
        if alias in t and t[alias] != want[:2]:
            print(f"FAIL: {name} alias {alias} {t[alias]} != {target} {want[:2]}")
            fails += 1
    for name, t in cache_tables.items():
        row = t.get(alias, {})
        if "cache_read" in row and row["cache_read"] != want[2]:
            print(f"FAIL: {name} alias {alias} cache_read {row['cache_read']} != {target} {want[2]}")
            fails += 1
        if "cache_write" in row and row["cache_write"] != want[3]:
            print(f"FAIL: {name} alias {alias} cache_write {row['cache_write']} != {target} {want[3]}")
            fails += 1
if pj["haiku"].get("over_100k") != pj["claude-haiku-5-5"].get("over_100k"):
    print("FAIL: haiku alias over_100k tier differs from claude-haiku-5-5")
    fails += 1

# Non-Claude rows (OpenAI), verified against developers.openai.com/api/docs/pricing
# on 2026-10-08, Standard tier, short context (up to 272K input tokens):
# (input, output) per MTok. Every table that carries a row must agree with it.
OPENAI = {
    "gpt-5.3-codex": (1.75, 14.0),
    "gpt-5.6-sol": (4.0, 20.0),
    "gpt-5.6-terra": (2.0, 12.0),
    "gpt-5.6-luna": (0.2, 1.2),
}
OPENAI_CACHED = {"gpt-5.3-codex": 0.175, "gpt-5.6-sol": 0.4, "gpt-5.6-terra": 0.2, "gpt-5.6-luna": 0.02}


def openai_rows(text, q):
    out = {}
    pat = re.compile(rf"{q}(gpt-[A-Za-z0-9.\-]+){q}\s*:\s*\{{\s*{q}?input{q}?\s*:\s*{NUM}\s*,\s*{q}?output{q}?\s*:\s*{NUM}(?:\s*,\s*{q}?cache_read{q}?\s*:\s*{NUM})?")
    for m in pat.finditer(text):
        out.setdefault(m.group(1), (float(m.group(2)), float(m.group(3)), float(m.group(4)) if m.group(4) else None))
    return out


oa = {
    "model-pricing.json": {k: (v["input"], v["output"], v.get("cache_read")) for k, v in pj.items() if k.startswith("gpt-")},
    "budget.ts fallback": openai_rows(fb, '"?'),
    "run.sh _write_pricing_json": {k: (v["input"], v["output"], v.get("cache_read")) for k, v in gen.items() if k.startswith("gpt-")},
    "run.sh check_budget_limit": openai_rows(window(run, "pricing = {\n    'fable'", 1500), "'"),
    "dashboard _DEFAULT_PRICING": openai_rows(window(read("dashboard/server.py"), '"fable":  {"input"', 2500), '"'),
}
for name, t in oa.items():
    for k, (i, o, cr) in t.items():
        if k not in OPENAI:
            print(f"FAIL: {name} carries unpinned non-Claude row {k}")
            fails += 1
        elif (i, o) != OPENAI[k]:
            print(f"FAIL: {name} {k} {(i, o)} != OpenAI page {OPENAI[k]}")
            fails += 1
        elif cr is not None and cr != OPENAI_CACHED[k]:
            print(f"FAIL: {name} {k} cache_read {cr} != OpenAI page {OPENAI_CACHED[k]}")
            fails += 1

# No other file may carry a stale price row.
for rel in ("autonomy/tui.sh", "autonomy/context-tracker.py"):
    txt = read(rel)
    if re.search(r"opus\*\)\s+input_rate=15", txt) or '"input": 3.0,' in txt:
        print(f"FAIL: {rel} still carries a stale price row")
        fails += 1

# #310 derivation: the written file carries every model of model-pricing.json with
# identical rates and no row the source lacks, so a hand-kept row cannot drift.
for k, row in pj.items():
    g = gen.get(k)
    if g is None:
        print(f"FAIL: run.sh _write_pricing_json is missing {k} from model-pricing.json")
        fails += 1
        continue
    fields = ("input", "output") if k.startswith("gpt-") else ("input", "output", "cache_read", "cache_write", "cache_write_1h")
    for f in fields:
        if f in row and g.get(f) != row[f]:
            print(f"FAIL: run.sh _write_pricing_json {k} {f}={g.get(f)} != model-pricing.json {row[f]}")
            fails += 1
    if row.get("over_100k") and g.get("over_100k") != {"input": row["over_100k"]["input"], "output": row["over_100k"]["output"]}:
        print(f"FAIL: run.sh _write_pricing_json {k} over_100k {g.get('over_100k')} != model-pricing.json {row['over_100k']}")
        fails += 1
for k in gen:
    if k not in pj:
        print(f"FAIL: run.sh _write_pricing_json carries hand-kept row {k} absent from model-pricing.json")
        fails += 1

print("PRICING-PARITY-TEST:", "FAIL" if fails else "PASS")
sys.exit(1 if fails else 0)
PY
rc=$?
[ "$rc" -eq 0 ] || exit "$rc"

# #310: a model added to model-pricing.json appears in the run.sh output with its
# rates, and a changed price flows through, with no run.sh edit.
added_src="$pricing_out_dir/added-pricing.json"
python3 - "$REPO_ROOT/loki-ts/data/model-pricing.json" "$added_src" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
d["pricing"]["zz-added-model"] = {"input": 7.0, "output": 9.0, "cache_read": 0.7, "cache_write": 8.75, "cache_write_1h": 14.0, "label": "ZZ Added"}
d["pricing"]["sonnet"]["input"] = 2.5
json.dump(d, open(sys.argv[2], "w"))
PYEOF
write_pricing_out "$added_src" "$pricing_out_dir/added-out.json" || echo "FAIL: _write_pricing_json did not run against the added-model source"
added_check="$(python3 - "$pricing_out_dir/added-out.json" <<'PYEOF'
import json, sys
try:
    m = json.load(open(sys.argv[1]))["models"]
except (OSError, ValueError, KeyError):
    m = {}
a, s = m.get("zz-added-model", {}), m.get("sonnet", {})
ok = (a.get("input"), a.get("output"), a.get("cache_read"), a.get("label")) == (7.0, 9.0, 0.7, "ZZ Added") and s.get("input") == 2.5
print("ok" if ok else "bad")
PYEOF
)"
if [ "$added_check" = "ok" ]; then
    echo "ok:   run.sh _write_pricing_json derives an added model and a changed price from model-pricing.json"
else
    echo "FAIL: run.sh _write_pricing_json did not carry an added model or a changed price from model-pricing.json"
    exit 1
fi
case "$pricing_out_dir" in "${TMPDIR:-/tmp}"/loki-run.*) rm -rf -- "$pricing_out_dir" ;; esac

# PRICE-TRUTH-2: run the real check_budget_limit from run.sh on the bash route.
# 1M input + 1M output tokens: claude-haiku-4-5 must cost $6 ($1/$5), not the
# sonnet fallback $12, and claude-haiku-5-5 must cost $0.6 ($0.10/$0.50).
# shellcheck disable=SC1090,SC2034,SC2329
bash_route_cost() {
    local model="$1" work
    work="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")" || return 1
    mkdir -p "$work/.loki/metrics/efficiency"
    printf '{"model":"%s","input_tokens":1000000,"output_tokens":1000000}\n' "$model" \
        >"$work/.loki/metrics/efficiency/1.json"
    (
        cd "$work" || exit 1
        log_error() { :; }; log_warn() { :; }; log_info() { :; }; emit_event_json() { :; }
        BUDGET_LIMIT=0.000001; ITERATION_COUNT=1
        # shellcheck disable=SC1090
        # The function body holds a python dict whose closing brace sits at column 0,
        # so cut at the next top-level function instead of the first "^}".
        source <(awk 'f && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ {exit} /^check_budget_limit\(\) \{/ {f=1} f' "$REPO_ROOT/autonomy/run.sh")
        check_budget_limit >/dev/null 2>&1
        python3 -c "import json; print(json.load(open('.loki/metrics/budget.json'))['budget_used'])"
    )
    local out=$?
    case "$work" in "${TMPDIR:-/tmp}"/loki-run.*) rm -rf -- "$work" ;; esac
    return "$out"
}
bash_fail=0
for pair in "claude-haiku-4-5=6.0" "claude-haiku-5-5=0.6" "sonnet=12.0"; do
    model="${pair%%=*}"; want="${pair##*=}"
    got="$(bash_route_cost "$model")"
    if [ "$got" != "$want" ]; then
        echo "FAIL: bash route (check_budget_limit) prices $model at $got per 1M in+out, want $want"
        bash_fail=1; case_fail=1
    else
        echo "ok:   bash route prices $model at $want per 1M in+out"
    fi
done

# TEN-COST-42: the bash readers of default_max_cost_usd keep the 100 fallback
# but must say so on stderr when the pricing file exists yet is unreadable or
# has no parsable key. An absent file stays silent (documented fallback), and a
# healthy file prints nothing extra. Run.sh reader is extracted as a function;
# the autonomy/loki reader is driven through the real `loki start --help` entry path
# against a copy of autonomy/ whose pricing file is mutated.
budget_work="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")" || exit 1
mkdir -p "$budget_work/loki-ts/data"
cp -R "$REPO_ROOT/autonomy" "$budget_work/autonomy"
cp "$REPO_ROOT/VERSION" "$budget_work/VERSION" 2>/dev/null || true
price="$budget_work/loki-ts/data/model-pricing.json"
# shellcheck disable=SC1090
source <(awk '/^_loki_budget_default_from\(\) \{/ {f=1} f {print} f && /^\}/ {exit}' "$REPO_ROOT/autonomy/run.sh")

budget_case() {
    # $1 label, $2 want-warning (1/0), $3 want-run.sh value
    local label="$1" want_warn="$2" want_val="$3" rc_out rc_err val case_fail=0
    rc_err="$budget_work/err.txt"
    val="$(_loki_budget_default_from "$price" 2>"$rc_err")"
    if [ "$val" != "$want_val" ]; then
        echo "FAIL: run.sh reader ($label) returned '$val', want '$want_val'"; bash_fail=1; case_fail=1
    fi
    if [ "$want_warn" = 1 ] && ! grep -q 'default_max_cost_usd' "$rc_err"; then
        echo "FAIL: run.sh reader ($label) gave no stderr warning"; bash_fail=1; case_fail=1
    elif [ "$want_warn" = 0 ] && [ -s "$rc_err" ]; then
        echo "FAIL: run.sh reader ($label) printed unexpected stderr: $(cat "$rc_err")"; bash_fail=1; case_fail=1
    fi
    bash "$budget_work/autonomy/loki" start --help >"$budget_work/out.txt" 2>"$rc_err"
    rc_out="$?"
    if [ "$want_warn" = 1 ] && ! grep -q 'default_max_cost_usd' "$rc_err"; then
        echo "FAIL: loki start --help ($label) gave no stderr warning (rc=$rc_out)"; bash_fail=1; case_fail=1
    elif [ "$want_warn" = 0 ] && grep -q 'default_max_cost_usd' "$rc_err"; then
        echo "FAIL: loki start --help ($label) warned on a healthy or absent file"; bash_fail=1; case_fail=1
    fi
    [ "$case_fail" = 0 ] && echo "ok:   budget default reader ($label)"
}

cp "$REPO_ROOT/loki-ts/data/model-pricing.json" "$price"
healthy="$(sed -n 's/.*"default_max_cost_usd"[[:space:]]*:[[:space:]]*\([0-9][0-9.]*\).*/\1/p' "$price" | head -n 1)"
healthy="$(awk -v v="$healthy" 'BEGIN{printf "%.2f", v}')"
budget_case "healthy file" 0 "$healthy"
printf '{"pricing":{}}\n' >"$price"
budget_case "keyless file" 1 "100.00"
cp "$REPO_ROOT/loki-ts/data/model-pricing.json" "$price"
chmod 000 "$price"
if [ -r "$price" ]; then
    echo "skip: running as a user that can read mode 000 files; unreadable case not testable"
else
    budget_case "unreadable file" 1 "100.00"
fi
chmod 600 "$price"
rm -f "$price"
budget_case "absent file" 0 "100.00"

case "$budget_work" in "${TMPDIR:-/tmp}"/loki-run.*) rm -rf -- "$budget_work" ;; esac
# #299: LOKI_INFERENCE_GEO=us is a 1.1x multiplier on token-priced cost. TS
# (calculateCostFromRecords), bash (check_budget_limit) and the Python surfaces
# (efficiency_cost helper, dashboard _calculate_model_cost) must report the same
# spend for the same record, geo unset and geo=us. All read one JSON key.
geo_work="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")" || exit 1
mkdir -p "$geo_work/.loki/metrics/efficiency"
printf '{"model":"sonnet","input_tokens":1000000,"output_tokens":1000000}\n' \
    >"$geo_work/.loki/metrics/efficiency/iter-1.json"

geo_ts() {
    (cd "$REPO_ROOT/loki-ts" && LOKI_INFERENCE_GEO="$1" bun -e '
import { calculateCostFromRecords } from "./src/runner/budget.ts";
console.log(calculateCostFromRecords([{ model: "sonnet", input_tokens: 1000000, output_tokens: 1000000 }]));
' 2>/dev/null)
}
# BUDGET_LIMIT is tiny so check_budget_limit takes the exceeded branch, which
# records the computed spend as budget_used in budget.json.
geo_bash() {
    (
        cd "$geo_work" || exit 1
        export SCRIPT_DIR="$REPO_ROOT/autonomy" BUDGET_LIMIT=0.01 ITERATION_COUNT=1
        log_error() { :; }; log_warn() { :; }; log_info() { :; }; emit_event_json() { :; }
        # shellcheck disable=SC1090
        source <(awk '/^check_budget_limit\(\) \{/ {f=1; print; next} f && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ {exit} f {print}' "$REPO_ROOT/autonomy/run.sh")
        rm -f .loki/metrics/budget.json
        LOKI_INFERENCE_GEO="$1" check_budget_limit >/dev/null 2>&1
        sed -n 's/.*"budget_used": *\([0-9.]*\).*/\1/p' .loki/metrics/budget.json
    )
}
geo_py() {
    LOKI_INFERENCE_GEO="$1" python3 - "$REPO_ROOT" <<'PYEOF' 2>/dev/null
import sys
sys.path.insert(0, sys.argv[1] + "/autonomy/lib")
from efficiency_cost import inference_geo_multiplier
print(round(12.0 * inference_geo_multiplier(), 4))
PYEOF
}
geo_dash() {
    LOKI_INFERENCE_GEO="$1" python3 - "$REPO_ROOT" <<'PYEOF' 2>/dev/null
import json, os, sys
from pathlib import Path as _Path
root = sys.argv[1]
src = open(root + "/dashboard/server.py").read()
seg = src[src.index("def _inference_geo_multiplier"):src.index('@app.get("/api/cost"')]
ns = {"os": os, "json": json, "_Path": _Path, "__file__": root + "/dashboard/server.py"}
ns["_get_model_pricing"] = lambda: {"sonnet": {"input": 2.0, "output": 10.0, "cache_read": 0.1, "cache_write": 2.5}}
exec(seg, ns)
print(round(ns["_calculate_model_cost"]("sonnet", 1000000, 1000000), 4))
PYEOF
}
geo_num() { awk -v v="$1" 'BEGIN{printf "%.4f", v}'; }

for geo_case in "unset:12.0000" "us:13.2000" "global:12.0000"; do
    geo="${geo_case%%:*}"; want="${geo_case##*:}"; [ "$geo" = unset ] && geo=""
    for surf in ts bash py dash; do
        got="$(geo_num "$(geo_$surf "$geo")")"
        if [ "$got" = "$want" ]; then
            echo "ok:   geo '${geo_case%%:*}' $surf spend $got"
        else
            echo "FAIL: geo '${geo_case%%:*}' $surf spend '$got', want $want"; bash_fail=1
        fi
    done
done

# The fallback constants must equal the JSON value, or an unreadable file would
# make the surfaces disagree with each other.
json_us="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]+'/loki-ts/data/model-pricing.json'))['inference_geo_multipliers']['us'])" "$REPO_ROOT")"
for f in loki-ts/src/providers/model_routes.ts autonomy/lib/efficiency_cost.py autonomy/run.sh dashboard/server.py; do
    if grep -Eq '(FALLBACK = |\{"us": |geo = )1\.1\b|1\.1 if os\.environ' "$REPO_ROOT/$f" && [ "$json_us" = "1.1" ]; then
        echo "ok:   geo fallback 1.1 matches JSON in $f"
    else
        echo "FAIL: geo fallback in $f missing or differs from JSON ($json_us)"; bash_fail=1
    fi
done


# #299c: the budget gate derives its rows from loki-ts/data/model-pricing.json
# (the literal dict is the fallback only). A mutated JSON price must move the
# number; a missing JSON must fall back to the literal rows.
src_work="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")" || exit 1
mkdir -p "$src_work/mut/autonomy" "$src_work/mut/loki-ts/data" "$src_work/none/autonomy" "$src_work/.loki/metrics/efficiency"
python3 - "$REPO_ROOT" "$src_work/mut/loki-ts/data/model-pricing.json" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1] + "/loki-ts/data/model-pricing.json"))
d["pricing"]["sonnet"]["input"] = 3.0
json.dump(d, open(sys.argv[2], "w"))
PYEOF
printf '{"model":"sonnet","input_tokens":1000000,"output_tokens":1000000}\n' >"$src_work/.loki/metrics/efficiency/1.json"
src_cost() {
    (
        cd "$src_work" || exit 1
        export SCRIPT_DIR="$1" BUDGET_LIMIT=0.01 ITERATION_COUNT=1
        log_error() { :; }; log_warn() { echo "$*" >>"$src_work/warns.txt"; }; log_info() { :; }; emit_event_json() { :; }
        # shellcheck disable=SC1090
        source <(awk '/^check_budget_limit\(\) \{/ {f=1; print; next} f && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ {exit} f {print}' "$REPO_ROOT/autonomy/run.sh")
        rm -f .loki/metrics/budget.json
        check_budget_limit >/dev/null 2>&1
        check_budget_limit >/dev/null 2>&1
        sed -n 's/.*"budget_used": *\([0-9.]*\).*/\1/p' .loki/metrics/budget.json
    )
}
for src_case in "$REPO_ROOT/autonomy:12.0000" "$src_work/mut/autonomy:13.0000" "$src_work/none/autonomy:12.0000"; do
    got="$(geo_num "$(src_cost "${src_case%:*}")")"; want="${src_case##*:}"
    if [ "$got" = "$want" ]; then
        echo "ok:   budget gate JSON source case ${src_case%:*} spend $got" | sed "s#$src_work#<tmp>#; s#$REPO_ROOT#<repo>#"
    else
        echo "FAIL: budget gate with SCRIPT_DIR ${src_case%:*} spent '$got', want $want"; bash_fail=1
    fi
done
if [ "$(grep -c 'missing or unreadable' "$src_work/warns.txt" 2>/dev/null)" = "1" ]; then
    echo "ok:   missing pricing JSON logged the fallback once"
else
    echo "FAIL: missing pricing JSON fallback log count is not 1"; bash_fail=1
fi
case "$src_work" in "${TMPDIR:-/tmp}"/loki-run.*) rm -rf -- "$src_work" ;; esac
case "$geo_work" in "${TMPDIR:-/tmp}"/loki-run.*) rm -rf -- "$geo_work" ;; esac
exit "$bash_fail"
