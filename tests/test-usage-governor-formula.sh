#!/usr/bin/env bash
# GOV-FORMULA: the governor shows its inputs and arithmetic, and calibrates
# the per-seat burn from recorded readings (>= 3h) or states the default.
# `claude` is stubbed via PATH; the real CLI is never called.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOL="${GOV_TOOL:-$REPO_ROOT/scripts/usage-governor.py}"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

echo "TEST: usage-governor.py seat formula and burn calibration (GOV-FORMULA)"
[ -f "$TOOL" ] || { echo "  FAIL: $TOOL missing"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/root"

NOW="2026-10-08T07:40:00Z"
# Session resets 100 min after NOW (09:20Z = 05:20am America/New_York).
cat > "$WORK/fx.json" <<'EOF'
{"is_error": false, "result": "Current session: 31% used · resets Oct 8 at 5:20am (America/New_York)\nCurrent week (all models): 22% used · resets Oct 14 at 12:59pm (America/New_York)\n"}
EOF
cat > "$WORK/bin/claude" <<'EOF'
#!/usr/bin/env bash
cat "$STUB_FIXTURE"
EOF
chmod +x "$WORK/bin/claude"

# +1.5 weekly points per hour over 3h (4 readings), session rising too.
printf 'utc_time\twindow_percent\tweekly_percent\n2026-10-08T04:40:00Z\t10\t20\n2026-10-08T05:40:00Z\t16\t21.5\n2026-10-08T06:40:00Z\t23\t23\n2026-10-08T07:40:00Z\t31\t24.5\n' > "$WORK/read3h.tsv"
# Only 2h of readings.
printf 'utc_time\twindow_percent\tweekly_percent\n2026-10-08T05:40:00Z\t16\t21.5\n2026-10-08T06:40:00Z\t23\t23\n2026-10-08T07:40:00Z\t31\t24.5\n' > "$WORK/read2h.tsv"

run_gov() { # $1=readings $2=seats ; prints --json
  PATH="$WORK/bin:$PATH" STUB_FIXTURE="$WORK/fx.json" \
    python3 "$TOOL" --json --measure --now "$NOW" --root "$WORK/root" --readings "$1" \
      --live-log "$WORK/none.jsonl" --no-cache --seats "$2" 2>/dev/null
}
jq_() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

echo "T1 -- 1.5 pts/h with 10 seats -> burn 0.15, source=measured, >= 12 seats"
OUT="$(run_gov "$WORK/read3h.tsv" 10)"
got="$(printf '%s' "$OUT" | jq_ "(d['governor']['formula']['burn']['weekly_pct_per_seat_hour'], d['governor']['formula']['burn']['source'], d['governor']['max_engineers_next_hour'] >= 12)")"
if [ "$got" = "(0.15, 'measured', True)" ]; then ok "$got"; else bad "T1 got: $got"; fi

echo "T2 -- under 3h of readings falls back to default"
OUT="$(run_gov "$WORK/read2h.tsv" 10)"
got="$(printf '%s' "$OUT" | jq_ "(d['governor']['formula']['burn']['weekly_pct_per_seat_hour'], d['governor']['formula']['burn']['source'])")"
if [ "$got" = "(0.15, 'default')" ]; then ok "$got"; else bad "T2 got: $got"; fi

echo "T3 -- --json carries every input and formula field"
OUT="$(run_gov "$WORK/read3h.tsv" 10)"
got="$(printf '%s' "$OUT" | jq_ "(d['governor']['formula']['session_pct'], round(d['governor']['formula']['minutes_to_session_reset']), d['governor']['formula']['weekly_pct'], d['governor']['formula']['days_to_weekly_reset'] > 0, d['governor']['formula']['burn']['seats_assumed'], 'floor' in d['governor']['formula']['arithmetic'], d['governor']['formula']['binding'])")"
if [ "$got" = "(31.0, 100, 22.0, True, 10, True, 'seat_ceiling')" ]; then ok "$got"; else bad "T3 got: $got"; fi

echo "T4 -- human output prints inputs, burn source and arithmetic"
HUM="$(PATH="$WORK/bin:$PATH" STUB_FIXTURE="$WORK/fx.json" python3 "$TOOL" --measure --now "$NOW" --root "$WORK/root" \
  --readings "$WORK/read3h.tsv" --live-log "$WORK/none.jsonl" --no-cache --seats 10 2>/dev/null)"
if printf '%s' "$HUM" | grep -qF "Formula inputs: session 31% (resets in 100 min)" \
  && printf '%s' "$HUM" | grep -qF "weekly 0.15 pts/h (measured)" \
  && printf '%s' "$HUM" | grep -qF "Formula: min(ceiling 14"; then ok "human formula lines"; else bad "T4 got: $HUM"; fi

echo "T5 -- safety: cap drops as session approaches 100 before reset"
got="$(python3 - "$TOOL" <<'PYEOF'
import importlib.util, sys
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location("ug", sys.argv[1])
ug = importlib.util.module_from_spec(spec); spec.loader.exec_module(ug)
burn = {"seats_assumed": 10, "weekly_pct_per_seat_hour": 0.15, "session_pct_per_seat_hour": 1.0,
        "source": "measured", "session_source": "default", "readings_used": 4, "span_hours": 3.0}
def cap(sess, mins):
    f = ug.seat_formula(sess, 22, mins, 150, burn)
    return ug.measured_cap(sess, 22, 12, f)
print(cap(31, 100)[0], cap(60, 240)[0], cap(80, 120), cap(95, 120))
PYEOF
)"
if [ "$got" = "14 6 (2, 'hold_above_70_session') (0, 'over_ceiling')" ]; then ok "$got"; else bad "T5 got: $got"; fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
