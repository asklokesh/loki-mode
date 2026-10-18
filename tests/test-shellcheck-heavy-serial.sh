#!/usr/bin/env bash
# Guard (FC-LINT-OOM): tests/run-shellcheck.sh never runs a heavy file (at least
# LOKI_SHELLCHECK_HEAVY_LINES lines) at the same time as any other shellcheck.
# Real shellcheck peaks at ~8-10 GB RSS on autonomy/loki and autonomy/run.sh; two
# at once killed the 16 GB CI runner (Tests shard 0, exit 143, "runner has
# received a shutdown signal"). A fake shellcheck on PATH records overlaps.
# New file: no existing suite covers run-shellcheck.sh scheduling.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d "${LOKI_RUN_TMP:-${TMPDIR:-/tmp}}/loki-sc-heavy.XXXXXX")" || exit 1
trap 'rm -rf -- "$T"' EXIT
mkdir -p "$T/bin" "$T/repo/autonomy" "$T/state/active" "$T/state/heavy"
fails=0

cat > "$T/bin/shellcheck" <<'EOF'
#!/usr/bin/env bash
f="${*: -1}"; s="$SC_FAKE_STATE"
heavy=0; [ "$(wc -l < "$f")" -ge "$LOKI_SHELLCHECK_HEAVY_LINES" ] && heavy=1
touch "$s/active/$$"; [ "$heavy" -eq 1 ] && touch "$s/heavy/$$"
for _ in 1 2 3 4 5; do
    n=$(ls "$s/active" | wc -l); h=$(ls "$s/heavy" | wc -l)
    if [ "$h" -gt 0 ] && [ "$n" -gt 1 ]; then echo "$f" >> "$s/overlap"; fi
    sleep 0.1
done
rm -f "$s/active/$$" "$s/heavy/$$"
exit 0
EOF
chmod +x "$T/bin/shellcheck"

# Two heavy files (one is the ratchet target autonomy/loki), several light ones.
for i in $(seq 1 60); do echo "echo $i"; done > "$T/repo/autonomy/loki"
for i in $(seq 1 60); do echo "echo $i"; done > "$T/repo/autonomy/run.sh"
for i in 1 2 3 4 5 6; do echo "echo light" > "$T/repo/light$i.sh"; done

out="$(cd "$T/repo" && PATH="$T/bin:$PATH" SC_FAKE_STATE="$T/state" LOKI_SHELLCHECK_HEAVY_LINES=50 \
    LOKI_SHELLCHECK_JOBS=4 LOKI_SHELLCHECK_RATCHET_ROOT=. bash "$SCRIPT_DIR/run-shellcheck.sh" 2>&1)"
rc=$?
if [ -s "$T/state/overlap" ]; then
    echo "FAIL: a heavy file ran alongside another shellcheck: $(sort -u "$T/state/overlap" | tr '\n' ' ')"; fails=$((fails + 1))
else
    echo "PASS: heavy files ran alone"
fi
if [ "$rc" -eq 0 ] && grep -q "Checked ./autonomy/run.sh" <<< "$out" && grep -q "Checked ./light6.sh" <<< "$out"; then
    echo "PASS: every file still checked, exit 0"
else
    echo "FAIL: rc=$rc or a file was not checked"; printf '%s\n' "$out" | tail -20; fails=$((fails + 1))
fi
echo "Results: $((2 - fails)) passed, $fails failed"
[ "$fails" -eq 0 ]
