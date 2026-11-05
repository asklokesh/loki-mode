#!/usr/bin/env bash
# PROTOTYPE (proto/micro-agent-decomposition): util/site_ledger.ts, the per-function micro-task decomposition.
# Hermetic: stub replies, no model, no network. Asserts:
#   ledger:      fixture a (two functions, three bare type assertions) yields exactly the workers Report and reportGroup,
#                sites 50/55/56 and 64, and one twin group {50, 55, 64}; named types get no worker.
#   siblings:    fixture b's Parse worker is told that line 34 appends rargs[0] while line 25 appends firstArg.
#   no noise:    fixture b has no twin group (locals and bare keywords are not twins).
#   closure:     a reply that changes 2 of the 3 twins is flagged twin_mixed at line 55 and re-issued once; the full
#                second reply leaves no residual. A reply that stays partial keeps the finding in residual (reported,
#                never dropped). A reply claiming "changed" on an untouched line is flagged claimed_change_absent.
#   apply (go):  the applied tree builds and its own tests pass; fixture acceptance tests pass only after the re-issue.
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. twinGroups returns [] -> the closure and apply-acceptance legs fail.
#   2. siblingNotes returns [] -> the siblings leg fails.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
command -v bun >/dev/null 2>&1 || { echo "site-ledger: needs bun" >&2; exit 2; }
cd "$ROOT/loki-ts" || exit 2
F="$ROOT/tests/min/fixtures/site_ledger"
echo "TEST: site ledger micro-task decomposition"

out="$(bun scripts/site_ledger_probe.ts "$F/a" "$T/la" ledger 2>&1 | tail -1)"
[ "$out" = '{"tasks":[{"id":"status.go#Report","sites":[50,55,56],"siblings":0},{"id":"status.go#reportGroup","sites":[64],"siblings":0}],"twins":[[{"task":"status.go#Report","line":50},{"task":"status.go#Report","line":55},{"task":"status.go#reportGroup","line":64}]]}' ] && ok "ledger a: two workers, four sites, one twin group" || bad "ledger a: $out"

outb="$(bun scripts/site_ledger_probe.ts "$F/b" "$T/lb" ledger 2>&1)"
printf '%s' "$outb" | grep -q 'line 25 passes `firstArg`; line 34 passes `rargs\[0\]`' && ok "siblings b: rargs[0] vs firstArg named" || bad "siblings b missing"
printf '%s' "$outb" | tail -1 | grep -q '"twins":\[\]' && ok "no twin noise on b" || bad "b twins: $(printf '%s' "$outb" | tail -1)"

closure="$(bun -e '
import { buildLedger, integrationFindings, parseReply } from "./src/util/site_ledger.ts";
import { cpSync, readFileSync } from "node:fs"; import { spawnSync } from "node:child_process";
const [fx, work] = process.argv.slice(1); cpSync(fx, work, { recursive: true });
for (const a of [["init","-q"],["add","."],["-c","user.name=t","-c","user.email=t@e.invalid","commit","-qm","b"]]) spawnSync("git", a, { cwd: work });
const tasks = buildLedger(work, readFileSync(work + "/TASK.md", "utf8"));
const report = tasks.find((t) => t.fn === "Report");
const src = report.source;
const lie = "```go\n" + src + "\n```\nSITE 50: changed - x\nSITE 55: changed - y\nSITE 56: unchanged - z\n";
const f = integrationFindings([report], new Map([[report.id, parseReply(lie, "go")]]));
console.log(f.filter((x) => x.kind === "claimed_change_absent").map((x) => x.line).join(","));
' "$F/a" "$T/lc" 2>&1)"
[ "$closure" = "50,55" ] && ok "claimed_change_absent on untouched lines" || bad "claimed: $closure"

if command -v go >/dev/null 2>&1; then
  r1="$(bun scripts/site_ledger_probe.ts "$F/a" "$T/s1" stub "$F/stub/a_partial_then_full.json" 2>&1 | tail -1)"
  printf '%s' "$r1" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["calls"]==3 and [(f["kind"],f["line"]) for f in d["first_findings"]]==[("twin_mixed",55)] and d["residual"]==[] and d["checks"]=={"vet":0,"test":0} and d["accept"]["status"]==0' && ok "partial then full: flagged, re-issued, tree green, acceptance green" || bad "r1: $r1"
  r2="$(bun scripts/site_ledger_probe.ts "$F/a" "$T/s2" stub "$F/stub/a_partial_twice.json" 2>&1 | tail -1)"
  printf '%s' "$r2" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert [(f["kind"],f["line"]) for f in d["residual"]]==[("twin_mixed",55)] and d["accept"]["status"]!=0' && ok "partial twice: residual reported, acceptance red" || bad "r2: $r2"
else
  echo "site-ledger: go not installed, apply legs skipped"
fi
finish
