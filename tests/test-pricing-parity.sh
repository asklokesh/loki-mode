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

python3 - "$REPO_ROOT" <<'PY'
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
tables["run.sh _write_pricing_json"] = rows_dict(window(run, '"fable":           {"input"', 2500), '"')
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
    "run.sh _write_pricing_json": cache_rows(window(run, '"fable":           {"input"', 900), '"'),
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
    "run.sh _write_pricing_json": openai_rows(window(run, '"fable":           {"input"', 2500), '"'),
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

print("PRICING-PARITY-TEST:", "FAIL" if fails else "PASS")
sys.exit(1 if fails else 0)
PY
rc=$?
[ "$rc" -eq 0 ] || exit "$rc"

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
        bash_fail=1
    else
        echo "ok:   bash route prices $model at $want per 1M in+out"
    fi
done
exit "$bash_fail"
