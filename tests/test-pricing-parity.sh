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
KEYS = ("fable", "claude-fable-5", "opus", "sonnet", "haiku")
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
fb = window(ts, "const _FALLBACK_PRICING", 1500)
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
tables["run.sh _write_pricing_json"] = rows_dict(window(run, '"fable":           {"input"', 900), '"')
tables["run.sh check_budget_limit"] = rows_dict(window(run, "pricing = {\n    'fable'", 700), "'")
tables["dashboard _DEFAULT_PRICING"] = rows_dict(window(read("dashboard/server.py"), '"fable":  {"input"', 700), '"')
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

print("PRICING-PARITY-TEST:", "FAIL" if fails else "PASS")
sys.exit(1 if fails else 0)
PY
