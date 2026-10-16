#!/usr/bin/env bash
# scripts/assert-wall-executed.sh RECEIPT_JSON [MIN_CHECKS] [EXPECTED_CHECKS]
# FC-68: a release must not silently drop a verification check. Reads the keys seal.ts writes
# (checks[].result, wall.files, wall.passed, not_proven[]) and fails unless:
#   - at least MIN_CHECKS (default 2) checks executed (result pass or fail; not_run does not count);
#   - the Wall test is present (wall.files non-empty) and executed (wall.passed is a boolean);
#   - not_proven carries no "wall test discarded" or "wall base run not_run" line.
# Q17-04: EXPECTED_CHECKS (comma list of check-name substrings, e.g. lint,mutation,review; default empty =
# off) also requires each token to match a checks[].name whose result is pass or fail, so a dropped or
# not_run expected check fails the guard.
# Prints PASS/FAIL lines; exit 0 only when every assertion passes, 2 on usage errors.
set -uo pipefail
RCPT="${1:-}"; MIN="${2:-2}"; EXP="${3:-}"
[ -f "$RCPT" ] || { echo "usage: $0 RECEIPT_JSON [MIN_CHECKS]" >&2; exit 2; }
case "$MIN" in ''|*[!0-9]*) echo "MIN_CHECKS must be an integer" >&2; exit 2 ;; esac
case "$EXP" in *[!A-Za-z0-9_.,:-]*) echo "EXPECTED_CHECKS must be a comma list of [A-Za-z0-9_.:-] tokens" >&2; exit 2 ;; esac
exec node -e '
const fs = require("fs");
let r; try { r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { console.log("FAIL wall-guard: unreadable receipt (" + e.message + ")"); process.exit(1); }
const min = Number(process.argv[2]); let bad = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + "wall-guard: " + m); if (!c) bad++; };
const checks = Array.isArray(r.checks) ? r.checks : [];
const ran = checks.filter((c) => c && (c.result === "pass" || c.result === "fail")).length;
ok(ran >= min, "executed checks >= " + min + " (got " + ran + " of " + checks.length + ")");
const files = r.wall && Array.isArray(r.wall.files) ? r.wall.files : [];
ok(files.length >= 1, "Wall test present in receipt (wall.files: " + files.length + ")");
ok(!!r.wall && typeof r.wall.passed === "boolean", "Wall test executed (wall.passed: " + (r.wall ? JSON.stringify(r.wall.passed) : "absent") + ")");
const np = Array.isArray(r.not_proven) ? r.not_proven.map(String) : [];
const drop = np.filter((l) => /^wall test discarded:|^wall base run not_run:/.test(l));
ok(drop.length === 0, "no discarded or not_run Wall test in not_proven" + (drop.length ? " (" + drop.join("; ") + ")" : ""));
for (const tok of (process.argv[3] || "").split(",").filter(Boolean)) {
  const hit = checks.some((c) => c && typeof c.name === "string" && c.name.toLowerCase().includes(tok.toLowerCase()) && (c.result === "pass" || c.result === "fail"));
  ok(hit, "expected check \"" + tok + "\" executed in checks[]");
}
process.exit(bad ? 1 : 0);
' "$RCPT" "$MIN" "$EXP"
