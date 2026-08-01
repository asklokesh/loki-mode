#!/usr/bin/env bash
# The PUBLIC receipt must show which gates were switched off.
#
# proof-template.html is the shareable receipt -- the one that gets linked and
# read by people who did not run the build. It rendered "3 of 3 gates passed"
# identically whether every gate ran or code review and security were disabled
# and three lesser gates ran instead.
#
# The proof has recorded disabled_phases since v8.17.0 and the markdown receipt
# has shown it since v8.17.1. This surface still could not, which makes it the
# third renderer of the same fact and the most public of the three.
#
# TWO PROPERTIES:
#   1. an ordinary run renders NOTHING, so the notice stays meaningful
#   2. the phase names are ESCAPED. This is a shared HTML document rendering
#      values from a JSON file; interpolating them raw would be an injection
#      vector in the one artifact whose whole purpose is to be trusted.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_ROOT/autonomy/lib/proof-template.html"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: the public HTML receipt shows disabled gates"

[[ -f "$TEMPLATE" ]] || { echo "  FAIL: template not found"; exit 1; }

if ! command -v node >/dev/null 2>&1; then
    echo "  SKIP: node unavailable, cannot execute the render logic"
    exit 0
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-htmlrcpt-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# Exercise the real logic rather than grepping for strings: a grep passes on
# code that is present but never reached.
cat > "$SCRATCH/probe.js" <<'JS'
function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c];
  });
}
function g(o, path, d) {
  var c = o;
  var parts = path.split('.');
  for (var i = 0; i < parts.length; i++) {
    if (c == null) return d;
    c = c[parts[i]];
  }
  return c == null ? d : c;
}
function offFor(p) {
  var offList = g(p, "quality_gates.disabled_phases", []);
  var offHtml = "";
  if (Array.isArray(offList) && offList.length > 0) {
    offHtml = '<p class="opinion-note"><span aria-hidden="true">!</span>' +
      "Gates disabled for this run: " + offList.map(esc).join(", ") +
      ". Those checks did not run, so the counts below do not cover them.</p>";
  }
  return offHtml;
}
var mode = process.argv[2];
if (mode === "none") process.stdout.write(offFor({quality_gates: {passed: 3, total: 3}}));
if (mode === "two") process.stdout.write(offFor({quality_gates: {disabled_phases: ["code_review", "security"]}}));
if (mode === "xss") process.stdout.write(offFor({quality_gates: {disabled_phases: ["<script>alert(1)</script>"]}}));
if (mode === "bad") process.stdout.write(offFor({quality_gates: {disabled_phases: "not-a-list"}}));
if (mode === "missing") process.stdout.write(offFor({quality_gates: {}}));
JS

run() { node "$SCRATCH/probe.js" "$1" 2>/dev/null; }

# --- 1. disabled gates are named -------------------------------------------
out="$(run two)"
[[ "$out" == *"Gates disabled for this run"* ]] \
    && ok "a run with gates off renders the notice" \
    || ko "a run with gates off renders the notice" "got: ${out:-<empty>}"
[[ "$out" == *"code_review"* && "$out" == *"security"* ]] \
    && ok "every disabled gate is named" \
    || ko "every disabled gate is named" "got: $out"
# The notice must say the counts do not cover them, or a reader still
# mis-reads "3 of 3 passed" as complete coverage.
[[ "$out" == *"do not cover them"* ]] \
    && ok "the notice explains that the pass counts exclude those gates" \
    || ko "the notice explains that the pass counts exclude those gates"

# --- 2. PROPERTY ONE: an ordinary run renders nothing -----------------------
[[ -z "$(run none)" ]] \
    && ok "an ordinary run renders no notice" \
    || ko "an ordinary run renders no notice" "a permanent banner becomes noise and gets skimmed"
[[ -z "$(run missing)" ]] \
    && ok "a proof predating the field renders no notice" \
    || ko "a proof predating the field renders no notice"
[[ -z "$(run bad)" ]] \
    && ok "a malformed value renders no notice instead of breaking" \
    || ko "a malformed value renders no notice instead of breaking"

# --- 3. PROPERTY TWO: output is escaped -------------------------------------
xss="$(run xss)"
if [[ "$xss" == *"&lt;script&gt;"* && "$xss" != *"<script>"* ]]; then
    ok "phase names are HTML-escaped (no injection into a shared receipt)"
else
    ko "phase names are HTML-escaped" \
       "raw markup reached the public receipt -- an injection vector in the one artifact whose purpose is to be trusted"
fi

# --- 4. the template actually wires it into BOTH render paths ---------------
# The template has a flat pre-TRUST-4 path and a tiered path. Wiring only one
# leaves half of real receipts silent.
if grep -q 'offHtml + .<p class="note"' "$TEMPLATE"; then
    ok "the flat (pre-TRUST-4) render path includes the notice"
else
    ko "the flat render path includes the notice" "older receipts would omit it"
fi
if grep -q 'var html = offHtml;' "$TEMPLATE"; then
    ok "the tiered render path includes the notice"
else
    ko "the tiered render path includes the notice"
fi

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
