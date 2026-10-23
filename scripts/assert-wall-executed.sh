#!/usr/bin/env bash
# scripts/assert-wall-executed.sh RECEIPT_JSON [MIN_CHECKS] [EXPECTED_CHECKS]
# a release must not silently drop a verification check. Reads the keys seal.ts writes
# (checks[].result, wall.files, wall.passed, not_proven[]) and fails unless:
#   - at least MIN_CHECKS (default 2) checks executed (result pass or fail; not_run does not count);
#   - the Wall test is present (wall.files non-empty) and executed (wall.passed is a boolean);
#   - not_proven carries no "wall test discarded" or "wall base run not_run" line.
# Q17-04: EXPECTED_CHECKS (comma list, default empty = off; implies the Wall assertions above) also requires:
#   - token "mutation": receipt.mutation_outcome is "yes" or "no" (the proof ran; "inconclusive" or absent fails);
#   - token "review": receipt.review is an object (seal.ts writes it only when cross review is configured);
#   - any other token: a checks[] entry whose name equals the token or starts with "<token>:" (verify names:
#     lint:*, <runner>:<path>, holdout:*, select-tests) with result pass or fail. Not a substring match.
# Prints PASS/FAIL lines; exit 0 only when every assertion passes, 2 on usage errors.
set -uo pipefail
RCPT="${1:-}"; MIN="${2:-2}"; EXP="${3:-}"
[ -f "$RCPT" ] || { echo "usage: $0 RECEIPT_JSON [MIN_CHECKS] [EXPECTED_CHECKS]" >&2; exit 2; }
case "$MIN" in ''|*[!0-9]*) echo "MIN_CHECKS must be an integer" >&2; exit 2 ;; esac
case "$EXP" in *[!A-Za-z0-9_.,:-]*) echo "EXPECTED_CHECKS must be a comma list of [A-Za-z0-9_.:-] tokens" >&2; exit 2 ;; esac
case "$EXP" in ,*|*,|*,,*) echo "EXPECTED_CHECKS must not contain an empty token" >&2; exit 2 ;; esac
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
  if (tok === "mutation") { ok(r.mutation_outcome === "yes" || r.mutation_outcome === "no", "expected \"mutation\" proof executed (mutation_outcome: " + JSON.stringify(r.mutation_outcome) + ")"); continue; }
  if (tok === "review") { ok(!!r.review && typeof r.review === "object", "expected \"review\" present in receipt.review"); continue; }
  const hit = checks.some((c) => c && typeof c.name === "string" && (c.name === tok || c.name.startsWith(tok + ":")) && (c.result === "pass" || c.result === "fail"));
  ok(hit, "expected check \"" + tok + "\" executed in checks[]");
}
process.exit(bad ? 1 : 0);
' "$RCPT" "$MIN" "$EXP"
