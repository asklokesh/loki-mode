#!/usr/bin/env bash
# Engine end to end on the stub provider: the real bin/loki -> committed Bun
# bundle -> engine10 pipeline on a throwaway repo, with a stub `claude` that adds
# multiply() to calc.ts. No network, no model, no real key (a throwaway signing
# key lives in the temp dir). Asserts:
#   done run:   exit 0, "Receipt: VERIFIED", `loki verify` says VERIFIED, and the
#               stub session never saw the canary GH_TOKEN (Rule of Two).
#   tamper run: the stub forges an event mid-run; the run must end TAMPERED and
#               exit non-zero, never VERIFIED.
#   after the fact: one appended line in events.jsonl turns VERIFIED into TAMPERED.
#   high tier:  LOKI_RISK_TIER=high through the committed bundle: the security scan finds its script
#               (from the package root, not relative to the bundle file), passes, and the run is VERIFIED.
#   python legs (need pytest on the system interpreter; SKIP without it, a failure when CI=true):
#     a correct change on a repo with no venv and no dependency manifest, whose impacted pytest
#     passes, seals VERIFIED with the system-interpreter note kept as informational (no Playwright,
#     no UI); the same repo with a requirements.txt still caps (the system interpreter may not be
#     the project's); a change to a module no test imports, or to calc.py whose passing test never
#     calls the new function, still caps (nothing exercised it; the stub replaces a comment line
#     below add(), which must not credit add() as changed).
#   PR runs (L003, local bare origin, deep worker awaited): with LOKI_REVIEW_DEFAULT=1, one review session per
#               medium run (the pre-seal cross-review), no -council iteration anywhere,
#               BLOCK caps at PARTIAL, a FLAG lands on the receipt, result-cost sum
#               equals receipt cost on 3 draft runs, a full suite red only on base
#               ids is status success and a new failing id stays failure.
#   FAILED-PR / SECRET-PUSH (local bare origin): a FAILED run with committed work opens a draft PR (branch pushed, body led by
#               "## Failing checks", no deep verify, no pending deep-verify status); a run whose security scan matched a secret in an
#               added line (stub E2E_STUB_SECRET, calc.ts:5) pushes nothing, keeps its branch, prints one line naming calc.ts:5 and the
#               push command, never the matched text, and the receipt carries push_refused plus the NOT PROVEN line. Unit: the
#               bisection line finder, -U0 hunk line numbers, the refusal's fail-safe rules, the FAILED title and body, the writeback text.
#
#   capped run (FR09): a metered stub run capped between implement's start and end exits 6 with Outcome: PARTIAL and Reason: cost/time
#               cap reached, the start line carries "cap $X (--max-cost)" and "estimate: about", main is untouched and
#               implement's edit is committed on loki/<run>.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. tests/min/fixtures/e2e/bin/claude: in the done branch print LOKI_DONE
#      without appending multiply() (the run must stop reading VERIFIED).
#   2. this script: pass LOKI_ALLOW_AGENT_GITHUB_TOKEN=1 to the engine (the
#      opt-out that hands the token to the agent); the canary assertion must fail.
#   3. loki-ts/dist/loki.js: the pre-L003 bundle with the post-PR council (the
#      council, one-review, cost and base-red assertions must fail).
#   4. stages/deep.ts: drop the base_red exclusion from status_state (the
#      base-red assertion must fail).
#   5. stages/xreview.ts: default reviewer on medium only (the unit line must fail).
#   6. loki-ts/src/engine10/stages/seal.ts: sysInfo always null (the no-manifest leg reads PARTIAL).
#   7. loki-ts/src/util/python.ts: declaresPythonEnv always false (the requirements.txt leg reads VERIFIED).
#   7b. loki-ts/src/util/python.ts: pyprojectDeclaresDeps counts [build-system] requires again (the BUILD-REQUIRES cell reads true for build_only).
#   7c. loki-ts/src/util/python.ts: declaresPythonEnv's MANIFEST counts setup.py with LOKI_E10_SETUP_DEPS on (drop the `!on &&`; the SETUP-DEPS tenacity-repo cell reads true before requirements.txt).
#   7d. loki-ts/src/util/python.ts: setupCfgDeclaresDeps back to the key-only regex /^\s*install_requires\s*=/m (the SETUP-DEPS tenacity cfg cell reads true).
#   7e. loki-ts/src/util/python.ts: setupPyDeclaresDeps reads a non-literal install_requires as empty (the install_requires=reqs cell reads false: false VERIFIED direction),
#       or drops the `(?:[,)}]|$)` tail of the empty-literal test (the `[] + reqs` and `[] if x else` cells read false).
#   7f. loki-ts/src/engine10/stages/verify.ts fullSuiteKey: build the key from paths only, no content hash (the G6 relief unit's changed-content cell reads the same key:
#       a stale pass would be reused after a fix round edits a file).
#   7g. verify.ts deferFullSuite: defer at low tier whatever is red (drop the keep/changed test; the unit's lint-only cell reads true and K5 reads PARTIAL instead of FAILED).
#   7h. verify.ts: drop the `if (deferSuite) notProven.push(FULL_SUITE_DEFERRED_NOTE)` line (K2's first-verify assertion fails; a deferred verify could back VERIFIED).
#   7i. verify.ts reusableRun: drop the pass-or-fail test (the unit's not_run record cell is reused: a timed-out suite would never run again).
#   7i2. deep.ts runFullSuite: add a reuse line to notProven instead of relying on the check's reused field (the unit's runFullSuite cell reads np.size 1: every reused run held).
#   7j. loki-ts/src/engine10/machine.ts syseditBroke: drop the suiteUnmeasured term (the sysedit cell's first case reads both base-red suite ids: a correct zero-model repair is undone).
#   7j. loki-ts/src/util/python.ts PY_SATISFIES: every entry counted as met (markers and versions ignored); the SYSTEM-PROVIDES-DEPS ">=9999" cell reads true.
#   7k. loki-ts/src/util/python.ts declaredRuntimeRequirements: requirements and lock files not checked (PY_MANIFEST); the SYSTEM-PROVIDES-DEPS requirements.txt cell reads true.
#   7l. loki-ts/src/util/python.ts setupPyRuntimeRequirements: drop the (?=\s*[,)]) end-of-argument check; the `+ extra` and conditional reader cells read ["a"] (false VERIFIED).
#   7m. loki-ts/src/engine10/stages/seal.ts sysProvided: return true always (rebuild dist); the pip>=9999 python leg reads VERIFIED.
#   7n. loki-ts/src/util/python.ts interpreterSatisfies: spawn with cwd: tmpdir() again; the SYSTEM-PROVIDES-DEPS .python-version shim cell reads true (the probe asks another interpreter than the tests).
#   7o. loki-ts/src/util/python.ts PY_SATISFIES: read only sys.path (md.version(r.name)); the PYTHONPATH pip 0.0.1 cell reads true (the tests import that copy).
#   7p. loki-ts/src/util/python.ts setupPyRuntimeRequirements: drop the `**` unpacking test; the SPR setup(**kw) cell reads [].
#   7q. setupPyRuntimeRequirements: drop the distutils `requires=` test; the SPR setup(requires=["a"]) cell reads [].
#   7r. pyprojectRuntimeRequirements: drop the [tool.flit.metadata] requires and [tool.pdm] dependencies test; the SPR flit and pdm cells read [].
#   7s. setupCfgRuntimeRequirements: drop the file:/attr: test; the SPR file: and attr: cells read the directive as a requirement.
#   7t. setupCfgRuntimeRequirements: drop the `%(` test; the SPR interpolation cell reads ["a%(x)s"].
#   7u. PY_SATISFIES: drop the `r.url or r.extras` test; the SYSTEM-PROVIDES-DEPS extras and URL cells read true.
#   7v. declaredRuntimeRequirements: drop the requirements/ directory test; the SPR requirements/ cell reads ["pip>=1"] and the reqdir interpreter cell reads true.
#   7w. setupCfgRuntimeRequirements: match only the exact key install_requires again; the SPR install-requires, Install_Requires and two-manifest cells
#       read [] and ["pip>=1"] (the reader sees nothing, so a met second manifest lifts unchecked, and setupCfgDeclaresDeps, derived from the reader, reads no environment).
#   7x. python.ts stripPyComments: not triple-quote aware; the SPR triple-quote cell reads [] (a `#` in a URL then hides install_requires).
#   7o2. loki-ts/src/util/python.ts PY_SATISFIES: drop the user-site term from path; the SYSTEM-PROVIDES-DEPS PYTHONUSERBASE pip 0.0.1 cell reads true.
#   7o3. PY_SATISFIES: drop the `[os.getcwd()]` term from path; the SYSTEM-PROVIDES-DEPS repo-root pip 0.0.1 cell reads true (the tests import that copy).
#   7o4. PY_SATISFIES: `outside` back to `path` in the existence test; the SYSTEM-PROVIDES-DEPS root-only lokiabsentdist cell reads true (a dist-info
#       in the repo root is not an installed distribution).
#   7o5. PY_SATISFIES: `outside` back to `path[1:]`; the PYTHONPATH=. lokiabsentdist cell reads true (a vendored copy on PYTHONPATH satisfies again).
#   7y. python.ts setupPyDeclaresDeps or setupPyRuntimeRequirements: drop `(` or `{` from the class after `**` ([A-Za-z_({]); the SETUP-DEPS
#       setup(**(cfg)) or setup(**{k: v ...}) cell reads false, or the same SPR cell reads [] (a met second manifest then lifts unchecked).
#   7z. python.ts setupCfgRuntimeRequirements: skip only indented comment lines (/^\s+[#;]/), so a column-0 comment ends the key; the SETUP-DEPS
#       column-0 comment cell reads false (sysCase "none": the hold lifts with no check).
#   7z2. python.ts setupCfgDeclaresDeps: drop the `r === null ||` half; the SETUP-DEPS `file: r.txt` cell reads false.
#   7z3. python.ts setupCfgRuntimeRequirements: `opt && indent > level` back to `indent > 0`; the SPR indented-key cell reads [] and the SETUP-DEPS indented-key value reads false (a met second manifest then lifts unchecked).
#   8. loki-ts/src/engine10/stages/seal.ts: drop leanHold from verdictOf (the never-calls-multiply leg reads VERIFIED).
#   9. loki-ts/src/util/check_result.ts: changedSymbols counts any removed line as removed code (the
#      never-calls-multiply leg reads VERIFIED: the replaced comment credits add()).
#   10. loki-ts/src/engine10/stages/deep.ts: DEFAULT_SECRET_SCAN_SH back to new URL("../../../../autonomy/...",
#      import.meta.url) (rebuild dist); the high-tier leg reads "secret-scan.sh not found" and PARTIAL.
#   11. loki-ts/src/engine10/stages/xreview.ts: reviewDefaultOn returns true (the default unit line reads medium=1), or false
#       for high (it reads high=0).
#   12. loki-ts/src/engine10/stages/xreview.ts: drop the run-model pin for the default review (the high-tier leg reads no --model haiku).
#   13. loki-ts/src/engine10/machine.ts capReached: return false always (the capped run completes and reads VERIFIED, exit 0).
#   14. loki-ts/src/util/check_result.ts changedSymbols: drop the ENCLOSING-DECL fallback (the enclosing-declaration unit line reads method=[]).
#   30. machine.ts: cascadeNow ignores wallFailedOf (the lint-only leg cascades).
#   31. machine.ts: drop the Wall tail from the cascade brief (the brief leg finds no Wall failure).
#   32. wall.ts wallRoute: drop the !wallEnabled() lean override (the lean-path leg reads the Wall skipped).
#   33. machine.ts: never set fresh (the snapshot fallback leg reads stage.failed).
#   15. claude_model.ts chooseSessionModel: ignore EXPLICIT_MODEL_ENV (the env leg reads sonnet, source default).
#   16. supervisor.ts: do not export the default pin (the default leg reads the provider default and no --model).
#   17. seal.ts: drop model_source (every default-model leg reads absent).
#   18. claude_model.ts chooseSessionModel: ignore LOKI_DEFAULT_SESSION_MODEL=provider (the provider leg reads sonnet).
#   24. verify.ts: drop the ntf condition (the no-test fallback leg reads no full suite).
#   25. verify.ts: skip the envCrash conversion (the base crash leg reads STALLED, no base-crash line).
#   19. claude_model.ts DEFAULT_SESSION_MODEL changed to haiku without autonomy/route.sh (the newcomer-path acc-156 route leg reads ts haiku, route sonnet).
#   20. claude_model.ts chooseSessionModel: drop the LOKI_ROUTER check (the router leg reads source default; auto-route.sh's small, hard, wall legs run on sonnet).
#   21. seal.ts commitStage: drop the hooks-off retry (the commit hook leg reads FAILED, git commit failed).
#   22. seal.ts commitStage: skip the read-tree/checkout-index restore (the delivered commit holds "hook was here").
#   23. machine.ts: return before seal on a failed commit (the signing leg reads no-receipt).
#   34. loki-ts/src/util/receipt_surface.ts proofCardOf: go green on verdict VERIFIED instead of mutation_outcome "yes" (the never-green and states proof card unit lines fail).
#   35. loki-ts/src/e10ext/liveline.ts CandidateView: clear the pending flag on the first test.result instead of on verify's stage.completed (the diff-early, label-until-verify and stopped-verify unit lines fail).
#   36. loki-ts/src/e10ext/liveline.ts CandidateView: clear the pending flag on a failed verify too (the stopped-verify unit line fails).
#   66. secret-scan.sh and verify.sh tier2: `[:=]` in place of `(:=|[:=])`; the F1 Go short-declaration leg reads no/no.
#   65. stages/seal.ts scanWhy: return {} (rebuild dist); the SCAN-WHY leg reads null None.
#   61. autonomy/lib/secret-scan.sh: chain_filter stays `cat` for source files (drop the case); the F1 step.ts and auth.py legs read hit.
#   62. _secret_scan_drop_member_chain in both files: drop every unquoted value (the 459fddf4b rule, `grep -E '[:=][[:space:]]*[\"'\'']'`); the F1 deploy.py, envstr.ts, tpl.js, doc.py and digit.ts legs read no.
#   63. autonomy/verify.sh only: drop the source-file case (the lockstep break); the F1 step.ts and auth.py legs read no/hit.
#   64. _secret_scan_drop_member_chain in both files: allow digits in a segment (`[A-Za-z0-9_]`); the F1 digit.ts leg reads no.
#   37. loki-ts/src/engine10/supervisor.ts: drop failedPr from the push condition (rebuild dist); the FAILED-run legs read no PR, no pushed branch and no failing-checks body.
#   38. loki-ts/src/engine10/supervisor.ts: drop !refusal from the push condition (rebuild dist); the secret-match legs read a PR and a pushed branch.
#   39. loki-ts/src/engine10/stages/deep.ts runSecretScan: skip locate() (rebuild dist); every match reads "file name looks like a secret file", never calc.ts:5.
#   40. loki-ts/src/util/receipt_surface.ts proofCardOf: drop the ownSteps return (the ONE-PROOF-LINE cell reads "false not run" first).

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
cd "$ROOT" || exit 2

# ---- RW-03 HONEST REASONS (wording only; no verdict, outcome word or exit code moves) ----
# Unit, from source. A cause of Loki's own reads "Loki could not finish checking: <cause>" in the outcome line's reason: a failed checking or delivery
# stage (commit here), a stage's time limit, a run that ended with no receipt. A failing check still wins the reason, the cap reason and a session
# stage's own reason (implement) are unchanged, the next-step hint is picked from the cause as before, the outcome word and exit code for a FAILED and
# a capped sealed run are what they were, and openItems names each item that held a receipt with its class.
# Planted defects (each reverted): closure.ts ownReason returns the reason unchanged (commit and limit read without the lead); output.ts drops the
# lead from the no-receipt reason; run_summary.ts nextOf matches the raw reason (the no-receipt hint is no longer "loki doctor"); closure.ts RULES:
# class of "no fail-then-pass test" set to "a" (the items line reads a); seal.ts: drop the lead from either receipt line (the source pin fails).
RW3="$(cd "$ROOT/loki-ts" && bun -e '
const o = await import("./src/engine10/output.ts"), s = await import("./src/util/run_summary.ts"), c = await import("./src/engine10/closure.ts"), fs = await import("node:fs");
const ev = (type, stage, data) => ({ v: 1, seq: 0, ts: "2026-01-01T00:00:00Z", run: "r", type, stage, data });
const failChk = ev("stage.completed", "verify", { checks: [{ name: "bun:calc.test.ts", result: "fail", first_error: "expected 6" }] });
const out = [
  "commit=" + o.reasonOf([ev("stage.failed", "commit", { reason: "git commit failed" })], false, "commit failed", "FAILED"),
  "limit=" + o.reasonOf([ev("stage.failed", "verify", { reason: "limit" })], false, null, "PARTIAL"),
  "noreceipt=" + o.reasonOf([], false, null, "FAILED"),
  "session=" + o.reasonOf([ev("stage.failed", "implement", { reason: "session exited 1" })], false, null, "FAILED"),
  "check=" + o.reasonOf([failChk, ev("stage.failed", "commit", { reason: "git commit failed" })], false, null, "FAILED"),
  "cap=" + o.reasonOf([ev("cap.hit", "implement", {}), ev("stage.failed", "verify", { reason: "cap" })], false, null, "PARTIAL"),
  "words=" + [o.outcomeOf("FAILED", false, "commit failed", false, true), o.outcomeOf("PARTIAL", true, null, false, true), o.outcomeOf("FAILED", true, null, false, false)].join(","),
  "exit=" + [o.EXIT.FAILED, o.EXIT.PARTIAL, o.EXIT.BUDGET_STOP, o.EXIT.VERIFIED].join(","),
  "next=" + s.nextOf("failed", 0, c.LOKI_OWN_LEAD + "engine ended before sealing a receipt") + "|" + (s.nextOf("failed", 1, c.LOKI_OWN_LEAD + "git commit failed") === s.nextOf("failed", 1, "git commit failed")),
  "items=" + c.openItems({ checks: [{ name: "bun:a.test.ts", result: "fail" }, { name: "bun:b.test.ts", result: "fail", pre_red: true }], cost: { fix_rounds: [{}, {}] }, not_proven: ["no test shown to fail on the base commit and pass on the change", "verify stopped at its time limit before all checks ran", c.LOKI_OWN_LEAD + "git commit failed: gpg failed", "pre red: x", "something new"] }).map((i) => `${i.class}:${i.kind}${i.tried ? `(${i.tried})` : ""}`).join(";"),
  "seal=" + ["${LOKI_OWN_LEAD}diff not computed (git diff-tree failed)", "${LOKI_OWN_LEAD}git commit failed: "].map((t) => fs.readFileSync("./src/engine10/stages/seal.ts", "utf8").includes(t)).join(","),
];
console.log(out.join("\n"));
' 2>&1)"
RW3_WANT='commit=Loki could not finish checking: git commit failed
limit=Loki could not finish checking: the verify stage reached its time limit
noreceipt=Loki could not finish checking: engine ended before sealing a receipt
session=session exited 1
check=bun:calc.test.ts failed: expected 6
cap=cost/time cap reached
words=FAILED,PARTIAL,BUDGET_STOP
exit=1,6,3,0
next=loki doctor|true
items=b:a check fails(2 fix round(s));b:no fail-then-pass test;a:verify stopped at its time limit;c:Loki could not finish checking;c:other: something new
seal=true,true'
[ "$RW3" = "$RW3_WANT" ] && ok "rw-03 unit: Loki's own causes read 'Loki could not finish checking', a failing check and the cap keep their reason, no outcome word or exit code moved, open items carry their class" || bad "rw-03 unit gave: $RW3"
# ---- end RW-03 ----

# ---- RW-03 VERIFIED FLAG AND REVIEWER FLAG COUNT (unit 2 step 2) ----
# Unit, from source. The reviewer's findings on a receipt are counted beside the label and read first in NOT PROVEN; a summary with none is byte for byte
# what it was. LOKI_VERIFIED turns verified mode on, its bounds have defaults and overrides, the header says what this build does, and the receipt block
# exists only when the mode is on.
# Planted defects (each reverted): closure.ts reviewerFlagsSuffix returns "" (the count leaves the label); output.ts drops flagsFirst (the finding is no
# longer first); closure.ts verifiedReceiptBlock returns the block always (off reads a block); closure.ts verifiedOn accepts any value (off reads on).
RW3B="$(cd "$ROOT/loki-ts" && bun -e '
const o = await import("./src/engine10/output.ts"), c = await import("./src/engine10/closure.ts");
const base = { pr: null, verdict: "VERIFIED", flaky: [], cost: { usd: 1, provider: "claude", tokens: 10 }, wallS: 10, stages: [{ label: "implement", seconds: 10 }] };
const np = ["kill switch not checked", "cross-review flag (claude): bulk status has no transition rules", "cross-review flag (claude): delete orphans rows"];
const withFlags = o.formatSummary({ ...base, notProven: np }).split("\n"), plain = o.formatSummary({ ...base, notProven: ["kill switch not checked"] }).split("\n");
console.log([
  "label=" + withFlags[0].replace(/\s+/g, " "),
  "first=" + withFlags.find((l) => l.startsWith("NOT PROVEN")).replace(/^NOT PROVEN:\s+/, "").slice(0, 34),
  "plain=" + plain[0].replace(/\s+/g, " ") + "|" + plain.find((l) => l.startsWith("NOT PROVEN")).replace(/^NOT PROVEN:\s+/, ""),
  "one=" + c.reviewerFlagsSuffix(["cross-review block (claude): x"]) + "|none=" + JSON.stringify(c.reviewerFlagsSuffix(["cross-review not run: claude exited 1", "cross-review skipped: low risk (claude not run)"])),
  "on=" + [c.verifiedOn({ LOKI_VERIFIED: "1" }), c.verifiedOn({}), c.verifiedOn({ LOKI_VERIFIED: "0" })].join(","),
  "bounds=" + JSON.stringify(c.verifiedBounds({})) + JSON.stringify(c.verifiedBounds({ LOKI_VERIFIED_ROUNDS: "2", LOKI_VERIFIED_MAX_S: "600", LOKI_VERIFIED_MAX_USD: "1.5", LOKI_VERIFIED_MAX_TOKENS: "bad" })) + JSON.stringify(c.verifiedBounds({ LOKI_E10_DEFAULT_BUDGETS: "1" })) + JSON.stringify(c.verifiedBounds({ LOKI_VERIFIED_ROUNDS: "50" }).rounds), // NO-DEFAULT-BUDGET: no bound unless set (null), never clamped; the knob restores the old bounds
  "block=" + JSON.stringify(c.verifiedReceiptBlock({})) + (c.verifiedReceiptBlock({ LOKI_VERIFIED: "1" }).verified_mode ? "+on" : "+missing"),
  "header=" + (c.verifiedHeader({}).startsWith("verified mode: ") && (c.CLOSURE_ROUNDS_BUILT || /not in this build/.test(c.verifiedHeader({})))),
].join("\n"));
' 2>&1)"
RW3B_WANT='label=Outcome: VERIFIED, 2 reviewer flags open
first=cross-review flag (claude): bulk s
plain=Outcome: VERIFIED|kill switch not checked
one=, 1 reviewer flag open|none=""
on=true,false,false
bounds={"rounds":null,"wall_s":null,"usd":null,"tokens":null}{"rounds":2,"wall_s":600,"usd":1.5,"tokens":null}{"rounds":3,"wall_s":7200,"usd":5,"tokens":3000000}50
block={}+on
header=true'
[ "$RW3B" = "$RW3B_WANT" ] && ok "rw-03 unit: reviewer findings are counted beside the label and read first; no finding leaves the summary as it was; verified mode has its switch, bounds and receipt block" || bad "rw-03 step 2 unit gave: $RW3B"
# ---- end RW-03 step 2 unit ----

# Unit: ENCLOSING-DECL. An edit inside an indented method whose @@ context is a template-literal line (git's default funcname for .js) names the
# enclosing method from the head file; a context that names something keeps that name only; column-0 code names nothing (commander.js run).
U="$(cd "$ROOT/loki-ts" && bun -e '
const c = await import("./src/util/check_result.ts");
const file = ["class Command {", "  help() {", "    return `", "Expecting one of", "`;", "  }", "  sourceWithGlobals(key) {", "    let source;", "    this.all().forEach((cmd) => {", "      if (cmd.has(key)) {", "        source = cmd.get(key);", "      }", "    });", "  }", "}", "const top = 1;", "run(top);"].join("\n");
const read = (p) => (p === "lib/command.js" ? file : null), hdr = "diff --git a/lib/command.js b/lib/command.js\n--- a/lib/command.js\n+++ b/lib/command.js\n";
const method = c.changedSymbols(hdr + "@@ -10 +10 @@ Expecting one of\n-      if (cmd.get(key) !== undefined) {\n+      if (cmd.has(key)) {\n", read);
const kept = c.changedSymbols(hdr + "@@ -10 +10 @@ function other() {\n-      if (cmd.get(key) !== undefined) {\n+      if (cmd.has(key)) {\n", read);
const col0 = c.changedSymbols(hdr + "@@ -17 +17 @@ }\n-run(1);\n+run(top);\n", read);
const noReader = c.changedSymbols(hdr + "@@ -10 +10 @@ Expecting one of\n-      if (cmd.get(key) !== undefined) {\n+      if (cmd.has(key)) {\n");
process.env.LOKI_E10_ENCLOSING_DECL = "0"; const off = c.changedSymbols(hdr + "@@ -10 +10 @@ Expecting one of\n-      if (cmd.get(key) !== undefined) {\n+      if (cmd.has(key)) {\n", read);
console.log(`method=${JSON.stringify(method)} kept=${JSON.stringify(kept)} col0=${JSON.stringify(col0)} noreader=${JSON.stringify(noReader)} off=${JSON.stringify(off)}`);
' 2>&1)"
[ "$U" = 'method=["sourceWithGlobals"] kept=["other"] col0=[] noreader=[] off=[]' ] \
    && ok "unit: an edit inside an indented method names the enclosing method; a naming @@ context is kept as is; column-0 code names nothing" || bad "unit: enclosing-declaration gave: $U"

# Unit: AWE (presentation only, from source, no model). A fixture repo whose tree adds multiply() to calc.ts and a new file new.ts is fed the events a run emits:
#   LOKI_AWE_DIFF_EARLY: implement's stage.completed prints the real candidate diff (the new file included) under "Candidate diff (candidate, not yet checked)", each verify test.result
#     ticks in under it with the label, and the status line keeps the label until verify completes; a stopped verify never reads as checked; =0 prints none of it; on a TTY the status line is erased first.
#   LOKI_AWE_LIVE_COST: the status line carries run elapsed and the spend so far from cost events; =0 is the old line byte for byte.
#   LOKI_AWE_PROOF_CARD: from receipt.json only, a "yes" proof shows Before (the recorded output line) and After: passes in green; "no", inconclusive, no proof and no receipt are never green and
#     never say "After: passes"; a "yes" whose proving test did not pass is not green either. The default output carries the card as one line (renderAweProofLine: yes/no plus the
#     proving test file), the full card only under --verbose; the done run's default output holds the D48 8-line cap with the card on.
#   The VERIFIED console summary (default and --verbose) has no model-tier or model-comparison text.
#   PR body (runPr, the real stage, its push script faked to fail after the body is written): a VERIFIED body has no model-tier or model-comparison text (no "opus").
#   PR body from the receipt: the proof, conventions followed and Loki's own total cost (partial, unmetered and null read as such, never $0.00, no model comparison); LOKI_AWE_LIVE_COST=0 is the old body.
cat > "$T/awe.ts" <<'TS'
const SRC = process.env.AWE_SRC!;
const { LiveLine, CANDIDATE_LABEL } = await import(`${SRC}/e10ext/liveline.ts`);
const { proofCardOf, renderAweProofCard } = await import(`${SRC}/util/receipt_surface.ts`);
const { renderReviewerBody } = await import(`${SRC}/e10ext/reviewer_body.ts`);
const { proofCardOf: _pc, renderAweProofLine } = await import(`${SRC}/util/receipt_surface.ts`);
const { runPr } = await import(`${SRC}/engine10/stages/pr.ts`);
const [repo, base] = process.argv.slice(2);
const out: Record<string, unknown> = {};
const ev = (type: string, stage: string | null, data: Record<string, unknown> = {}) => ({ v: 1, seq: 0, ts: new Date().toISOString(), run: "r1", type, stage, data });
const implDone = ev("stage.completed", "implement", { duration_s: 40, diff_stat: { files: 2, added: 2, removed: 0, paths: [{ path: "calc.ts", added: 1, removed: 0 }, { path: "new.ts", added: 1, removed: 0 }] } });
const feed = (env: Record<string, string>, tty: boolean, verifyEnd: "completed" | "failed") => {
  let buf = "", t = 1000; const ll = new LiveLine({ tty, write: (s: string) => { buf += s; }, now: () => t, columns: 200, graceS: 0, repoDir: repo, env });
  const mid: Record<string, string | null> = {};
  ll.onEvent(ev("stage.completed", "intake", { base_sha: base, duration_s: 1 }));
  ll.onEvent(ev("stage.started", "implement")); t += 65_000; ll.onEvent(ev("cost", "implement", { usd: 0.04, input_tokens: 10, output_tokens: 5 }));
  mid.impl = ll.text();
  ll.onEvent(implDone); ll.onEvent(ev("stage.started", "verify"));
  ll.onEvent(ev("test.result", "verify", { name: "vitest:calc.test.ts", result: "pass" }));
  mid.verifying = ll.text();
  if (verifyEnd === "completed") ll.onEvent(ev("stage.completed", "verify", { duration_s: 5, checks: [{ name: "vitest:calc.test.ts", result: "pass" }] }));
  else ll.onEvent(ev("stage.failed", "verify", { duration_s: 5, reason: "limit" }));
  ll.onEvent(ev("stage.started", "seal")); mid.after = ll.text(); ll.clear();
  return { buf, ...mid };
};
const on = feed({}, false, "completed"), off = feed({ LOKI_AWE_DIFF_EARLY: "0", LOKI_AWE_LIVE_COST: "0" }, false, "completed");
const failed = feed({}, false, "failed"), tty = feed({}, true, "completed");
out.diff_on = [on.buf.includes(`Candidate diff (${CANDIDATE_LABEL}): 2 files, +2 -0`), on.buf.includes("+export const multiply"), on.buf.includes("+export const fresh"), on.buf.indexOf("Candidate diff") < on.buf.indexOf("check vitest:calc.test.ts: pass (candidate, not yet checked)"), on.buf.includes("Candidate checked by verify: 1 passed, 0 failed")].join(",");
out.label_until_verify = [String(on.verifying).includes(CANDIDATE_LABEL), String(on.after).includes(CANDIDATE_LABEL)].join(",");
out.label_failed_verify = [failed.buf.includes("Candidate checked"), failed.buf.includes("the candidate is still not checked"), String(failed.after).includes(CANDIDATE_LABEL)].join(",");
out.diff_off = [off.buf.includes("Candidate"), off.buf.includes("check vitest"), String(off.verifying).includes(CANDIDATE_LABEL)].join(",");
out.tty_clears = tty.buf.includes("\r\x1b[2KCandidate diff");
out.cost_on = String(on.impl);
out.cost_off = String(off.impl);
const checks = [{ name: "vitest:calc.test.ts", result: "pass" }];
const yes = { verdict: "VERIFIED", mutation_outcome: "yes", mutation_proof: "test fails without the fix: yes", mutation_before: [{ file: "calc.test.ts", lines: ["AssertionError: expected 6 to be 7"] }], checks, not_proven: ["no browser check ran"], cost: { usd: 0.3141 }, conventions: { formatted: [{ tool: "prettier", files: ["calc.ts"] }], release_note: ".changeset/x.md" } };
const no = { verdict: "VERIFIED", mutation_outcome: "no", mutation_proof: "test fails without the fix: no (warning: the Wall tests also pass on the old code)", checks, not_proven: ["Wall tests passed without the fix (mutation proof)"], cost: { usd: null, partial_usd: 0.1, measured_sessions: 1, total_sessions: 3 } };
const inc = { verdict: "VERIFIED", mutation_outcome: "inconclusive", mutation_proof: "test fails without the fix: inconclusive (timeout)", checks, not_proven: [], cost: { usd: 0, source: "cli-invoker-unmetered" } };
const none = { verdict: "PARTIAL", checks, not_proven: ["a check failed"] };
const card = (r: Record<string, unknown> | null) => renderAweProofCard(proofCardOf(r), true);
const GREEN = "\x1b[32m";
out.card_yes = [card(yes).includes(`${GREEN}fail-then-pass shown`), card(yes).includes("Before: calc.test.ts fails on your code with:\n    AssertionError: expected 6 to be 7\n  After: passes"), card(yes).includes("  - no browser check ran")].join(",");
out.card_never_green = [no, inc, none, null].map((r) => { const c = card(r); return c.includes(GREEN) || c.includes("After: passes") || proofCardOf(r).green; }).join(",");
out.card_states = [no, inc, none, null].map((r) => proofCardOf(r).state).join(",");
out.card_after_red = proofCardOf({ ...yes, checks: [{ name: "vitest:calc.test.ts", result: "fail" }] }).green;
const body = (receipt: Record<string, unknown> | null, env: Record<string, string> = {}) => renderReviewerBody({ verdict: "VERIFIED", draftReason: null, notProven: [], receiptPath: null, receiptSha256: null, signed: null, runId: "r", outputs: {}, receipt }, env, "0.0.0");
const by = body(yes);
out.pr_yes = [by.includes("## The proof\n- Before: `calc.test.ts` fails on the base code with:\n  ```text\n  AssertionError: expected 6 to be 7\n  ```\n- After: passes"), by.includes("## Conventions followed\n- Formatted with the repo's prettier: calc.ts\n- Release note added: .changeset/x.md"), by.includes("## Cost\n- Total: $0.31 (this run's own spend, from the receipt)"), /opus|cheaper|times/i.test(by.slice(by.indexOf("## Cost"), by.indexOf("## Receipt")))].join(",");
out.pr_never_green = [no, inc, none].map((r) => { const b = body(r); return b.includes("- After: passes") || b.includes("- Before:"); }).join(",");
out.pr_cost = [body(no).includes("- Total: partial: $0.10 for 1 of 3 sessions"), body(inc).includes("- Total: not measured (this invoker records no cost)"), body(none).includes("- Total: not measured (this run's"), body(inc).includes("$0.00")].join(",");
out.card_line = [yes, no, inc, none, null].map((r) => renderAweProofLine(_pc(r))).join(" | ");
const { mkdtempSync, writeFileSync: wf, readFileSync: rf, chmodSync } = await import("node:fs"), prd = mkdtempSync(`${repo}/../prbody.`), fakePush = `${prd}/push.sh`;
wf(fakePush, "#!/bin/sh\nexit 1\n"); chmodSync(fakePush, 0o755);
const prOut = { seal: { verdict: "VERIFIED", not_proven: [], receipt_path: null, receipt_sha256: null }, intake: { task: "add multiply", base_sha: base }, verify: { changed_files: [] } };
await runPr({ runId: "e10-prbody", repoDir: repo, runDir: `${prd}/run`, baseSha: base, branch: "loki/e10-prbody", provider: "claude", model: "sonnet", deep: false, capS: 0, pinnedOrigin: "https://github.com/acme/calc.git", emit: () => {}, outputs: () => prOut } as never, new AbortController().signal, { pushScriptPath: fakePush, gitlabPushScriptPath: fakePush }).catch(() => null);
let prBody = ""; try { prBody = rf(`${prd}/run/pr-body.md`, "utf8"); } catch { /* not written */ }
out.pr_no_model_cmp = [prBody.length > 0, /opus|model tier|top-tier|cost avoided|parity|cheaper|\bvs\.? raw/i.test(prBody)].join(",");
out.pr_off = [body(yes, { LOKI_AWE_LIVE_COST: "0" }) === body(null), body(yes, { LOKI_AWE_PROOF_CARD: "0" }).includes("## The proof"), body(yes, { LOKI_AWE_PROOF_CARD: "0" }).includes("## Cost")].join(",");
console.log(JSON.stringify(out));
TS
AWR="$T/awe-repo"; mkdir -p "$AWR"; git -C "$AWR" init -q -b main; git -C "$AWR" config user.name e2e; git -C "$AWR" config user.email e2e@example.invalid
printf 'export const add = (a: number, b: number) => a + b;\n' > "$AWR/calc.ts"; git -C "$AWR" add calc.ts; git -C "$AWR" commit -q -m base; AWB="$(git -C "$AWR" rev-parse HEAD)"
printf 'export const multiply = (a: number, b: number) => a * b;\n' >> "$AWR/calc.ts"; printf 'export const fresh = 1;\n' > "$AWR/new.ts"
AW="$(cd "$ROOT/loki-ts" && AWE_SRC="$ROOT/loki-ts/src" bun "$T/awe.ts" "$AWR" "$AWB" 2>&1 | tail -1)"
awe() { python3 -I -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2]))' "$AW" "$1" 2>/dev/null; }
[ "$(awe diff_on)" = "true,true,true,true,true" ] && ok "awe diff early: the candidate diff (new file included) prints when implement ends, checks tick in under it, then the checked line" || bad "awe diff early: got $(awe diff_on) ($AW)"
[ "$(awe label_until_verify)" = "true,false" ] && ok "awe honesty: the status line says 'candidate, not yet checked' until verify completes, and not after" || bad "awe label until verify: got $(awe label_until_verify)"
[ "$(awe label_failed_verify)" = "false,true,true" ] && ok "awe honesty: a stopped verify never reads as checked and the label stays" || bad "awe stopped verify: got $(awe label_failed_verify)"
[ "$(awe diff_off)" = "false,false,false" ] && ok "awe diff early off (LOKI_AWE_DIFF_EARLY=0): no candidate block, no ticks, no label" || bad "awe diff early off: got $(awe diff_off)"
[ "$(awe tty_clears)" = "True" ] && ok "awe diff early on a TTY: the status line is erased before the candidate block" || bad "awe tty: got $(awe tty_clears)"
[ "$(awe cost_on)" = '[implement] implementing  1m05s  run 1m05s  $0.04 so far  (intake done 1s)' ] && ok "awe live cost: the status line carries stage, run elapsed and the spend so far" || bad "awe live cost: got '$(awe cost_on)'"
[ "$(awe cost_off)" = '[implement] implementing  1m05s  (intake done 1s)' ] && ok "awe live cost off (LOKI_AWE_LIVE_COST=0): the old status line" || bad "awe live cost off: got '$(awe cost_off)'"
[ "$(awe card_yes)" = "true,true,true" ] && ok "awe proof card: a yes proof shows Before with the recorded output line, After: passes, in green, and the not-proven list" || bad "awe proof card yes: got $(awe card_yes)"
[ "$(awe card_never_green)" = "false,false,false,false" ] && ok "awe honesty: a no, inconclusive, absent or unsealed proof never renders green or says After: passes" || bad "awe proof card never green: got $(awe card_never_green)"
[ "$(awe card_states)" = "not shown,not run,not run,not run" ] && ok "awe proof card: no reads 'not shown', inconclusive and absent read 'not run'" || bad "awe proof card states: got $(awe card_states)"
[ "$(awe card_after_red)" = "False" ] && ok "awe honesty: a yes proof whose proving test did not pass after the change is not green" || bad "awe proof card after red: got $(awe card_after_red)"
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22.
# ONE-PROOF-LINE (receipt_surface.ts proofCardOf, reviewer_body.ts proofSection): an own proof is a green card naming the step; a failed own proof is not;
# a fail-then-pass test still wins when both exist.
OPL="$(cd "$ROOT/loki-ts" && bun --no-env-file --config=/dev/null -e '
const { proofCardOf, renderAweProofLine } = await import("./src/util/receipt_surface.ts"); const { proofSection } = await import("./src/e10ext/reviewer_body.ts");
const own = { mutation_outcome: "inconclusive", mutation_proof: "test fails without the fix: inconclusive (x)", own_proof: { ok: true, steps: ["search unit tests"], before: [{ step: "search unit tests", lines: ["1 failed"] }] } };
const a = proofCardOf(own), s = proofSection(own), b = proofCardOf({ ...own, own_proof: { ok: false, steps: [] } });
const c = proofCardOf({ mutation_outcome: "yes", mutation_proof: "test fails without the fix: yes (calc.test.ts)", mutation_before: [{ file: "calc.test.ts", lines: ["AssertionError"] }], checks: [{ name: "vitest:calc.test.ts", result: "pass" }], own_proof: { ok: true, steps: ["s"] } });
console.log([a.green + " " + a.state + " " + a.before[0].file + " " + (a.before[0].step === true), renderAweProofLine(a), s[1], s[5], b.green + " " + b.state, c.before[0].file + " " + (c.before[0].step === true)].join(" | "));' 2>&1)"
[ "$OPL" = 'true shown search unit tests true | Proof: yes, proof step search unit tests fails without the change and passes with it | - Before: proof step `search unit tests` fails in a copy of the checkout without the change, with: | - After: passes on the change | false not run | calc.test.ts false' ] && ok "ONE-PROOF-LINE: the own proof is the proof line when no test proved the change" || bad "ONE-PROOF-LINE gave: $OPL"
[ "$(awe pr_yes)" = "true,true,true,false" ] && ok "awe PR body from the receipt: the proof, conventions followed and Loki's own total cost, with no model comparison" || bad "awe PR body: got $(awe pr_yes)"
[ "$(awe pr_never_green)" = "false,false,false" ] && ok "awe honesty: a no, inconclusive or absent proof never writes Before/After into the PR body" || bad "awe PR body never green: got $(awe pr_never_green)"
[ "$(awe pr_cost)" = "true,true,true,false" ] && ok "awe PR cost: partial, unmetered and null read as such, never \$0.00" || bad "awe PR cost: got $(awe pr_cost)"
[ "$(awe card_line)" = "Proof: yes, calc.test.ts fails on your code and passes after the change | Proof: no (the new tests also pass on your old code, so they do not show the fix) | Proof: not run (inconclusive: timeout) | Proof: not run (the fail-then-pass proof runs only on a VERIFIED run) | Proof: not run (no trusted receipt was sealed)" ] && ok "awe proof card, one line (D48 default): yes names the proving test; no and not run say why" || bad "awe proof card line: got $(awe card_line)"
[ "$(awe pr_no_model_cmp)" = "true,false" ] && ok "PR body (runPr, VERIFIED): no model-tier or model-comparison text, no 'opus' (Loki's own cost only)" || bad "PR body model comparison: got $(awe pr_no_model_cmp)"
[ "$(awe pr_off)" = "true,false,true" ] && ok "awe PR body off: LOKI_AWE_LIVE_COST=0 is the old body; LOKI_AWE_PROOF_CARD=0 drops only the proof section" || bad "awe PR body off: got $(awe pr_off)"
# EMPTY-PUSH (FireLater#24 on 11.162.0: an already-done run pushed loki/<id> at the base commit and only gh pr create failed). runPr never spawns the push
# script for a branch equal to the run's base; a branch with a commit still reaches it. diffAgainstBase is tri-state: changed, unchanged, unknown (a bad ref).
# The supervisor's P1 gate uses the same helper instead of a bare safeGit call whose throw counted as a diff.
# Plants: EPa pr.ts drop the `=== false) return { status: "skipped"` guard (the empty branch reaches the push script); EPb safe_git.ts diffAgainstBase
# `return r.status === 0;` in place of `return r.status === 1;` (unchanged reads changed); EPc supervisor.ts back to the bare safeGit diff (the wiring check fails).
git -C "$AWR" branch -q loki/e10-empty "$AWB"; git -C "$AWR" stash -q -u; git -C "$AWR" checkout -q -b loki/e10-full; printf 'export const more = 2;\n' > "$AWR/more.ts"; git -C "$AWR" add more.ts; git -C "$AWR" commit -q -m full; git -C "$AWR" checkout -q main; git -C "$AWR" stash pop -q
cat > "$T/emptypush.ts" <<'TS'
const SRC = process.env.EP_SRC!, [repo, base, dir] = process.argv.slice(2);
const { runPr } = await import(`${SRC}/engine10/stages/pr.ts`), { diffAgainstBase } = await import(`${SRC}/util/safe_git.ts`);
const { writeFileSync, existsSync, chmodSync, mkdirSync } = await import("node:fs");
mkdirSync(dir, { recursive: true }); const fake = `${dir}/push.sh`, mark = `${dir}/pushed`; writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${mark}"\nexit 1\n`); chmodSync(fake, 0o755);
const run = async (branch: string) => (await runPr({ runId: "e10-ep", repoDir: repo, runDir: `${dir}/run-${branch.replace(/\W/g, "")}`, baseSha: base, branch, provider: "claude", model: "sonnet", deep: false, capS: 0, pinnedOrigin: "https://github.com/acme/calc.git", emit: () => {}, outputs: () => ({ seal: { verdict: "PARTIAL", not_proven: [], receipt_path: null, receipt_sha256: null }, intake: { task: "t", base_sha: base }, verify: { changed_files: [] } }) } as never, new AbortController().signal, { pushScriptPath: fake, gitlabPushScriptPath: fake }).catch((e: unknown) => ({ status: "threw", reason: String(e) }))) as { status: string; reason?: string };
const empty = await run("loki/e10-empty"), pushedAfterEmpty = existsSync(mark), full = await run("loki/e10-full");
console.log(JSON.stringify({ empty: [empty.status, /nothing to push/.test(empty.reason ?? ""), pushedAfterEmpty].join(","), full: [full.status !== "skipped", existsSync(mark)].join(","),
  tri: [diffAgainstBase(repo, base, "refs/heads/loki/e10-empty"), diffAgainstBase(repo, base, "refs/heads/loki/e10-full"), diffAgainstBase(repo, base, "refs/heads/no-such-branch")].map(String).join(",") }));
TS
EP="$(cd "$ROOT/loki-ts" && EP_SRC="$ROOT/loki-ts/src" bun "$T/emptypush.ts" "$AWR" "$AWB" "$T/emptypush" 2>&1 | tail -1)"
epv() { python3 -I -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2]))' "$EP" "$1" 2>/dev/null; }
[ "$(epv empty)" = "skipped,true,false" ] && ok "EMPTY-PUSH runPr: a branch equal to the run's base is skipped ('nothing to push') and the push script is never spawned" || bad "EMPTY-PUSH empty branch: got $(epv empty) ($EP)"
[ "$(epv full)" = "true,true" ] && ok "EMPTY-PUSH runPr: a branch with a commit still reaches the push script" || bad "EMPTY-PUSH full branch: got $(epv full) ($EP)"
[ "$(epv tri)" = "false,true,null" ] && ok "EMPTY-PUSH diffAgainstBase: unchanged, changed, and unknown for a ref git cannot read" || bad "EMPTY-PUSH diffAgainstBase: got $(epv tri) ($EP)"
grep -q 'const ch = diffAgainstBase(opts.repoDir, base, "HEAD", workerEnv);' "$ROOT/loki-ts/src/engine10/supervisor.ts" && grep -q 'hasDiff = ch !== false;' "$ROOT/loki-ts/src/engine10/supervisor.ts" && ! grep -q 'any failure counts as a diff' "$ROOT/loki-ts/src/engine10/supervisor.ts" && ok "EMPTY-PUSH wiring: the supervisor's P1 gate uses the tri-state helper" || bad "EMPTY-PUSH wiring: the supervisor's P1 gate does not use diffAgainstBase"

# R1 PR review loop (`loki address`, util/pr_lessons.ts respondToReview): a fake gh (one JSON answer per endpoint), a fake fixer that commits
# on its own loki/e10-fixN branch and writes that run's receipt, an injected receipt check, an injected push. No network, no model.
# Cells: A1 a non-Loki head branch refuses before any fix; A2 no receipt comment refuses; A3 a receipt comment from someone other than the PR
# author refuses; A4 a comment from a read-only author is skipped (denied), the write author's thread and review summary are fixed and the
# branch fast-forwards to the receipt's head commit; A5 the addressed reply names the sha, the run, the receipt sha and the marker, the review
# reply carries the review marker; A6 a receipt measured from another commit is held and the branch does not move; A7 an intact signed
# receipt whose own verdict is PARTIAL is held (verifyReceipt VERIFIED is integrity only), and the held reply names .loki/runs/<run>, not a
# branch; A8 without --post nothing is pushed or posted and replies.json is written; A9 with --post one push, one reply per item, a held
# reply carries the held marker at the pushed tip and goes to the right endpoint; A10 a rerun without --post on the addressed checkout says
# how to publish; A11 --post on it publishes the saved result with no new fix run; A12 a held reply at the current PR head settles its item
# (no new run), one at an older head does not. One cell per accept guard, each built so only that guard can hold it: A13 a receipt of
# another run; A14 a receipt verifyReceipt reads UNSIGNED; A15 a run whose own result line is not VERIFIED; A16 a receipt that is not the
# one the run sealed; A17 a receipt with push_refused; A18 a head commit that is not on the run's branch; A19 a commit that changes nothing.
# Post guards: A20 the PR head moved after proof; A21 origin changed during the fix; A22 defaultRespondPush hands LOKI_PR_FORK=0 and the
# pinned origin to the push script even when the caller set LOKI_PR_FORK=1, and a "created" answer throws. Stops (B3): A23 a fix run that
# leaves the tree dirty holds its item and stops, the accepted item before it is saved and --post still publishes it; A24 a fix run that
# moves the PR branch holds its item, and --post refuses to push a tip no receipt accepted. A25 a reply POST that fails after the push:
# the rerun posts only the reply that did not go out, with no new run and no push.
# Plants: R1a pr_lessons.ts respondToReview drop the lokiRunOfBranch refusal (A1 red); R1b hasLokiReceipt drop the PR-author test (A3 red);
# R1c canWrite return true when the permission is unreadable or read (A4 red); R1d acceptAddressRun drop the base_sha === pre test (A6 red);
# R1e respondToReview push when post is false (A8 red); R1f respondToReview drop the saved-result path (A11 red); R1g openReviewComments
# drop the heldMark test from settles (A12 red: the item held at this head runs again); R1n acceptAddressRun drop the receipt verdict
# check (A7 red); R1o drop the receipt run_id check (A13 red); R1p drop the verifyReceipt VERIFIED check (A14 red); R1q drop the outcome
# check (A15 red); R1r drop the sealed-sha check (A16 red); R1s drop the push_refused check (A17 red); R1t drop the merge-base ancestor
# check (A18 red); R1u drop the diffAgainstBase no-change check (A19 red); R1v respondToReview drop the head-moved-after-proof check (A20
# red); R1w drop the origin re-read check (A21 red); R1x defaultRespondPush drop LOKI_PR_FORK: "0" (A22 red); R1y make the dirty-tree stop
# throw again (A23 red); R1z drop the tip === landed push guard (A24 red); R1aa drop `if (e.posted) continue` (A25 red: both replies post
# again); R1ab held replies marked at proofHead instead of landed (A9 red); R1ac renderAddressReply names loki/<run> again (A7 red).
cat > "$T/address.ts" <<'TS'
const SRC = process.env.AD_SRC!, root = process.argv[2]!;
const m = await import(`${SRC}/util/pr_lessons.ts`);
const { execFileSync } = await import("node:child_process"), { mkdirSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
const g = (d: string, a: string[]) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const mkrepo = (name: string): { dir: string; h0: string } => {
  const dir = `${root}/${name}`; mkdirSync(dir, { recursive: true }); g(dir, ["init", "-q", "-b", "main"]); writeFileSync(`${dir}/a.ts`, "export const a = 1;\n"); g(dir, ["add", "a.ts"]); g(dir, ["commit", "-q", "-m", "base"]);
  g(dir, ["checkout", "-q", "-b", "loki/e10-orig"]); writeFileSync(`${dir}/b.ts`, "export const x = 2;\n"); g(dir, ["add", "b.ts"]); g(dir, ["commit", "-q", "-m", "run"]); g(dir, ["remote", "add", "origin", "https://github.com/acme/calc.git"]);
  return { dir, h0: g(dir, ["rev-parse", "HEAD"]) };
};
type Mode = "ok" | "wrongbase" | "partial" | "nullreview" | "otherrun" | "unsigned" | "outcome" | "sha" | "refused" | "offbranch" | "empty" | "dirty2" | "moved2";
type O = { ref?: string; receiptBy?: string | null; mode?: Mode; heldAt?: (h0: string) => string; prHead?: () => string; headMovesAfter?: boolean; failPost?: number; originFlip?: boolean };
async function scenario(name: string, o: O, post: boolean, repo?: { dir: string; h0: string }) {
  const r = repo ?? mkrepo(name), calls: string[] = [], posts: string[] = [], pushes: string[] = []; let fixes = 0, reads = 0, nPost = 0, origins = 0;
  const gh = async (args: string[]) => {
    const a = args.join(" "); calls.push(a);
    const J = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
    if (args.includes("POST")) { nPost++; if (o.failPost === nPost) return { code: 1, stdout: "", stderr: "HTTP 502" }; posts.push(a); return J({}); }
    if (a === "api repos/acme/calc/pulls/5") { reads++; return J({ head: { ref: o.ref ?? "loki/e10-orig", sha: o.headMovesAfter && reads > 1 ? "e".repeat(40) : o.prHead ? o.prHead() : r.h0 }, state: "open", user: { login: "lokibot" } }); }
    if (a === "api --paginate repos/acme/calc/issues/5/comments") return J(o.receiptBy === null ? [] : [{ user: { login: o.receiptBy ?? "lokibot" }, body: "<!-- loki-receipt -->\n## Loki receipt\n- Verify: `loki verify e10-orig`\n" }]);
    if (a === "api --paginate repos/acme/calc/pulls/5/comments") return J([...(o.heldAt ? [{ id: 98, in_reply_to_id: 11, body: `Not changed yet.\n<!-- loki-respond-held:${o.heldAt(r.h0)} -->`, user: { login: "lokibot" } }] : []), { id: 11, body: "rename x to y", path: "b.ts", line: 1, user: { login: "alice" }, diff_hunk: "@@ -0,0 +1 @@\n+export const x = 2;", html_url: "https://github.com/acme/calc/pull/5#discussion_r11" }, { id: 12, body: "drive-by", path: "b.ts", line: 1, user: { login: "mallory" } }]);
    if (a.startsWith("api graphql")) return J({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    if (a === "api --paginate repos/acme/calc/pulls/5/reviews") return J([{ id: 21, state: "CHANGES_REQUESTED", body: "also add a note", user: { login: "alice" }, html_url: "https://github.com/acme/calc/pull/5#pullrequestreview-21" }]);
    if (a === "api repos/acme/calc/collaborators/alice/permission") return J({ permission: "write" });
    if (a === "api repos/acme/calc/collaborators/mallory/permission") return J({ permission: "read" });
    return { code: 1, stdout: "", stderr: `unexpected: ${a}` };
  };
  const fix = async (c: { kind: string }, headRef: string) => {
    fixes++; if (o.mode === "nullreview" && c.kind === "review") return null;
    const id = `e10-fix${fixes}`, pre = g(r.dir, ["rev-parse", "HEAD"]), second = c.kind === "review", rs = `${"a".repeat(63)}${fixes}`;
    const moved = o.mode === "moved2" && second, dirty = o.mode === "dirty2" && second; // moved2: commits on the PR branch itself; dirty2: leaves an untracked file on its run branch
    if (!moved) g(r.dir, ["checkout", "-q", "-b", o.mode === "offbranch" ? `loki/side${fixes}` : `loki/${id}`]);
    if (o.mode === "empty") g(r.dir, ["commit", "-q", "--allow-empty", "-m", `fix ${fixes}`]);
    else { writeFileSync(`${r.dir}/f${fixes}.ts`, `export const f${fixes} = ${fixes};\n`); g(r.dir, ["add", `f${fixes}.ts`]); g(r.dir, ["commit", "-q", "-m", `fix ${fixes}`]); }
    const head = g(r.dir, ["rev-parse", "HEAD"]);
    if (dirty) writeFileSync(`${r.dir}/junk.txt`, "left behind\n"); else if (!moved) g(r.dir, ["checkout", "-q", headRef]);
    mkdirSync(`${r.dir}/.loki/runs/${id}`, { recursive: true });
    writeFileSync(`${r.dir}/.loki/runs/${id}/receipt.json`, JSON.stringify({ schema: "loki.v10.receipt/1", run_id: o.mode === "otherrun" ? "e10-other" : id, base_sha: o.mode === "wrongbase" ? "0".repeat(40) : pre, head_sha: head, receipt_sha256: rs, verdict: o.mode === "partial" ? "PARTIAL" : "VERIFIED", ...(o.mode === "refused" ? { push_refused: ["a secret in the diff"] } : {}) }));
    return { runId: id, outcome: o.mode === "outcome" ? "PARTIAL" : "VERIFIED", receiptSha256: o.mode === "sha" ? "b".repeat(64) : rs };
  };
  const verify = async (p: string) => ({ verdict: o.mode === "unsigned" ? "UNSIGNED" : "VERIFIED", reasons: [], receiptSha256: (JSON.parse(readFileSync(p, "utf8")) as { receipt_sha256: string }).receipt_sha256 });
  let res: any = null, err = "";
  const originUrl = () => (o.originFlip && ++origins > 1 ? "https://github.com/evil/calc.git" : "https://github.com/acme/calc.git");
  try { res = await m.respondToReview(r.dir, "acme/calc#5", { gh, fix, verify, post, push: (h: string) => { pushes.push(h); }, originUrl }); } catch (e) { err = String((e as Error).message); }
  const file = `${r.dir}/.loki/address/acme-calc-5/replies.json`, state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  return { r, res, err, fixes, posts, pushes, tip: g(r.dir, ["rev-parse", "HEAD"]), saved: state !== null, state };
}
const out: Record<string, string> = {};
{ const s = await scenario("a1", { ref: "feature-x" }, false); out.a1 = [/not a Loki pull request/.test(s.err), s.fixes].join(","); }
{ const s = await scenario("a2", { receiptBy: null }, false); out.a2 = [/carries no Loki receipt/.test(s.err), s.fixes].join(","); }
{ const s = await scenario("a3", { receiptBy: "mallory" }, false); out.a3 = [/carries no Loki receipt/.test(s.err), s.fixes].join(","); }
const a4 = await scenario("a4", { mode: "ok" }, false);
{ const e = a4.res?.entries ?? []; out.a4 = [a4.err, a4.res?.fixed, a4.res?.denied, a4.fixes, e.map((x: any) => `${x.kind}:${x.id}:${x.status}`).join("+"), a4.tip === e[1]?.sha].join(",");
  const t = e[0]?.reply ?? "", v = e[1]?.reply ?? "";
  out.a5 = [t.includes(`Addressed in ${String(e[0]?.sha).slice(0, 12)}`), t.includes("Loki run e10-fix1"), t.includes(`receipt sha256:${"a".repeat(63)}1`), t.includes("<!-- loki-respond -->"), v.includes("<!-- loki-respond-review:21 -->"), v.startsWith("Re: https://github.com/acme/calc/pull/5#pullrequestreview-21")].join(",");
  out.a8 = [a4.pushes.length, a4.posts.length, a4.saved, a4.res?.posted].join(","); }
{ const s = await scenario("a6", { mode: "wrongbase" }, false); out.a6 = [s.res?.fixed, s.res?.held, /measures from 000000000000/.test(s.res?.entries?.[0]?.reason ?? ""), s.tip === s.r.h0].join(","); }
const held = async (name: string, mode: Mode, re: RegExp, extra?: (s: any) => unknown) => { const s = await scenario(name, { mode }, false); return [s.res?.fixed, s.res?.held, re.test(s.res?.entries?.[0]?.reason ?? ""), s.tip === s.r.h0, ...(extra ? [extra(s)] : [])].join(","); };
out.a7 = await held("a7", "partial", /^its receipt records the run as PARTIAL, not VERIFIED$/, (s) => { const t = String(s.res?.entries?.[0]?.reply ?? ""); return t.includes("kept under .loki/runs/e10-fix1 where Loki ran") && !t.includes("local branch"); });
out.a13 = await held("a13", "otherrun", /^its receipt belongs to run e10-other, not e10-fix1$/);
out.a14 = await held("a14", "unsigned", /^its receipt reads UNSIGNED$/);
out.a15 = await held("a15", "outcome", /^the fix run ended PARTIAL$/);
out.a16 = await held("a16", "sha", /^its receipt is not the one the run sealed$/);
out.a17 = await held("a17", "refused", /security scan refused the push/);
out.a18 = await held("a18", "offbranch", /is not on loki\/e10-fix1 on top of the branch tip/);
out.a19 = await held("a19", "empty", /^the run changed nothing against the branch tip$/);
{ const s = await scenario("a9", { mode: "nullreview" }, true), p = s.posts;
  out.a9 = [s.err, s.pushes.join(" "), p.length, p.some((x) => x.includes("repos/acme/calc/pulls/5/comments/11/replies") && x.includes("<!-- loki-respond -->")), p.some((x) => x.includes("repos/acme/calc/issues/5/comments") && x.includes(`<!-- loki-respond-held-review:21:${s.tip} -->`) && !x.includes("<!-- loki-respond -->")), s.res?.posted, s.tip !== s.r.h0].join(","); }
{ const s = await scenario("a10", { mode: "ok" }, false, a4.r); out.a10 = [/publish it with: loki address acme\/calc#5 --post/.test(s.err), s.fixes].join(","); }
{ const s = await scenario("a11", { mode: "ok" }, true, a4.r); out.a11 = [s.err, s.fixes, s.pushes.length, s.posts.length, s.res?.fixed].join(","); }
{ const now = await scenario("a12now", { mode: "ok", heldAt: (h) => h }, false), old = await scenario("a12old", { mode: "ok", heldAt: () => "f".repeat(40) }, false);
  out.a12 = [now.fixes, now.res?.entries?.map((x: any) => x.id).join("+"), old.fixes].join(","); }
{ const s = await scenario("a20", { mode: "ok", headMovesAfter: true }, true); out.a20 = [/^head moved after proof/.test(s.err), s.pushes.length, s.posts.length].join(","); }
{ const s = await scenario("a21", { mode: "ok", originFlip: true }, true); out.a21 = [/^origin changed during the fix/.test(s.err), s.pushes.length, s.posts.length].join(","); }
{ const dir = `${root}/a22`; mkdirSync(dir, { recursive: true }); const sh = `${dir}/push.sh`, rec = `${dir}/env.txt`;
  writeFileSync(sh, 'printf "%s|%s|%s\\n" "${LOKI_PR_FORK:-unset}" "${_LOKI_PINNED_ORIGIN:-unset}" "$1" > "$PUSH_REC"\nprintf "%s\\n" "${FAKE_PR_STATE:-reused}" "https://github.com/acme/calc/pull/5"\n');
  process.env.LOKI_PR_FORK = "1"; process.env.PUSH_REC = rec;
  let e1 = "", e2 = ""; try { m.defaultRespondPush(dir, "loki/e10-orig", sh, "https://github.com/acme/calc.git", 20000); } catch (e) { e1 = String((e as Error).message); }
  const seen = existsSync(rec) ? readFileSync(rec, "utf8").trim() : "none";
  process.env.FAKE_PR_STATE = "created"; try { m.defaultRespondPush(dir, "loki/e10-orig", sh, "https://github.com/acme/calc.git", 20000); } catch (e) { e2 = String((e as Error).message); }
  delete process.env.FAKE_PR_STATE; delete process.env.LOKI_PR_FORK; delete process.env.PUSH_REC;
  out.a22 = [e1, seen, /a NEW PR was opened/.test(e2)].join(","); }
{ const s = await scenario("a23", { mode: "dirty2" }, true), e = s.res?.entries ?? [];
  out.a23 = [s.err, s.pushes.length, s.posts.length, e.map((x: any) => `${x.kind}:${x.status}`).join("+"), /^the fix run left uncommitted changes/.test(e[1]?.reason ?? ""), s.state?.entries?.length, s.state?.head === e[0]?.sha].join(","); }
{ const s = await scenario("a24", { mode: "moved2" }, true), e = s.state?.entries ?? [];
  out.a24 = [/its last accepted commit is/.test(s.err), s.pushes.length, s.posts.length, e.map((x: any) => `${x.kind}:${x.status}`).join("+"), /moved during the fix run/.test(e[1]?.reason ?? "")].join(","); }
{ const a = await scenario("a25", { mode: "ok", failPost: 2 }, true), tip = String(a.state?.head ?? "");
  const b = await scenario("a25b", { mode: "ok", prHead: () => tip }, true, a.r);
  out.a25 = [/HTTP 502/.test(a.err), a.pushes.length, a.posts.length, b.err, b.fixes, b.pushes.length, b.posts.length, b.posts.every((x) => x.includes("repos/acme/calc/issues/5/comments")), b.state?.posted].join(","); }
console.log(JSON.stringify(out));
TS
AD="$(cd "$ROOT/loki-ts" && AD_SRC="$ROOT/loki-ts/src" bun "$T/address.ts" "$T/address" 2>&1 | tail -1)"
adv() { python3 -I -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2]))' "$AD" "$1" 2>/dev/null; }
[ "$(adv a1)" = "true,0" ] && ok "R1 address A1: a head branch that is not loki/<run> refuses before any fix run" || bad "R1 A1: got $(adv a1) ($AD)"
[ "$(adv a2)" = "true,0" ] && ok "R1 address A2: no local receipt and no receipt comment refuses" || bad "R1 A2: got $(adv a2)"
[ "$(adv a3)" = "true,0" ] && ok "R1 address A3: a receipt comment from someone other than the PR author is not a receipt" || bad "R1 A3: got $(adv a3)"
[ "$(adv a4)" = ",2,1,2,thread:11:addressed+review:21:addressed,true" ] && ok "R1 address A4: the read-only author is skipped, the thread and the review summary are fixed, the branch is at the last receipt's head" || bad "R1 A4: got $(adv a4)"
[ "$(adv a5)" = "true,true,true,true,true,true" ] && ok "R1 address A5: the reply names the sha, the run, the receipt sha and the marker; the review reply carries the review marker" || bad "R1 A5: got $(adv a5)"
[ "$(adv a6)" = "0,2,true,true" ] && ok "R1 address A6: a receipt measured from another commit is held and the branch does not move" || bad "R1 A6: got $(adv a6)"
[ "$(adv a7)" = "0,2,true,true,true" ] && ok "R1 address A7: an intact signed receipt whose own verdict is PARTIAL is held; the held reply names .loki/runs/<run>, not a branch" || bad "R1 A7: got $(adv a7)"
[ "$(adv a8)" = "0,0,true,false" ] && ok "R1 address A8: without --post nothing is pushed or posted; replies.json is written" || bad "R1 A8: got $(adv a8)"
[ "$(adv a9)" = ",loki/e10-orig,2,true,true,true,true" ] && ok "R1 address A9: --post pushes once and posts one reply per item; the held review reply has the held marker at the pushed tip on the issue thread" || bad "R1 A9: got $(adv a9)"
[ "$(adv a10)" = "true,0" ] && ok "R1 address A10: a rerun without --post on the addressed checkout says how to publish and runs nothing" || bad "R1 A10: got $(adv a10)"
[ "$(adv a11)" = ",0,1,2,2" ] && ok "R1 address A11: --post on the addressed checkout publishes the saved result with no new fix run" || bad "R1 A11: got $(adv a11)"
[ "$(adv a12)" = "1,21,2" ] && ok "R1 address A12: a held reply at the current PR head settles its item; one at an older head does not" || bad "R1 A12: got $(adv a12)"
[ "$(adv a13)" = "0,2,true,true" ] && ok "R1 address A13: a receipt of another run is held" || bad "R1 A13: got $(adv a13)"
[ "$(adv a14)" = "0,2,true,true" ] && ok "R1 address A14: a receipt verifyReceipt reads UNSIGNED is held" || bad "R1 A14: got $(adv a14)"
[ "$(adv a15)" = "0,2,true,true" ] && ok "R1 address A15: a run whose result line is not VERIFIED is held, though its receipt reads VERIFIED" || bad "R1 A15: got $(adv a15)"
[ "$(adv a16)" = "0,2,true,true" ] && ok "R1 address A16: a receipt that is not the one the run sealed is held" || bad "R1 A16: got $(adv a16)"
[ "$(adv a17)" = "0,2,true,true" ] && ok "R1 address A17: a receipt whose security scan refused the push is held" || bad "R1 A17: got $(adv a17)"
[ "$(adv a18)" = "0,2,true,true" ] && ok "R1 address A18: a head commit on top of the tip but not on the run's own branch is held" || bad "R1 A18: got $(adv a18)"
[ "$(adv a19)" = "0,2,true,true" ] && ok "R1 address A19: a run commit that changes nothing is held" || bad "R1 A19: got $(adv a19)"
[ "$(adv a20)" = "true,0,0" ] && ok "R1 address A20: --post refuses when the PR head moved after proof; nothing pushed or posted" || bad "R1 A20: got $(adv a20)"
[ "$(adv a21)" = "true,0,0" ] && ok "R1 address A21: --post refuses when origin changed during the fix; nothing pushed or posted" || bad "R1 A21: got $(adv a21)"
[ "$(adv a22)" = ",0|https://github.com/acme/calc.git|push-pr,true" ] && ok "R1 address A22: the push gets LOKI_PR_FORK=0 and the pinned origin even under LOKI_PR_FORK=1; a created PR throws" || bad "R1 A22: got $(adv a22)"
[ "$(adv a23)" = ",1,2,thread:addressed+review:held,true,2,true" ] && ok "R1 address A23: a fix run that leaves the tree dirty holds its item and stops; the accepted item is saved and --post publishes it" || bad "R1 A23: got $(adv a23)"
[ "$(adv a24)" = "true,0,0,thread:addressed+review:held,true" ] && ok "R1 address A24: a fix run that moves the PR branch is held, and --post refuses a tip no receipt accepted" || bad "R1 A24: got $(adv a24)"
[ "$(adv a25)" = "true,1,1,,0,0,1,true,true" ] && ok "R1 address A25: after a reply POST fails past the push, the rerun posts only the missing reply, with no run and no push" || bad "R1 A25: got $(adv a25)"

echo "TEST: engine10 end to end on the stub provider"

FIX="$ROOT/tests/min/fixtures/e2e"
CANARY="ghp_E2ECANARYnotarealtoken0000000000000"
TASK="add a multiply(a, b) function to calc.ts"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 120)

# run_engine <mode> -> sets REPO, RC, OUT, RUNDIR, STUBENV, KEY
run_engine() {
    local mode="$1" d; shift
    d="$(mktemp -d "$T/run.XXXXXX")"
    REPO="$d/repo"
    cp -R "$FIX/repo" "$REPO"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e
    git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add calc.ts calc.test.ts bunfig.toml
    git -C "$REPO" commit -q -m base
    if [ -n "${E2E_PREP:-}" ]; then "$E2E_PREP" "$REPO"; fi # a leg's extra repo setup (hooks, config) after the base commit
    KEY="$d/k.pem"
    STUBENV="$d/stub-env.log"
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" \
        E2E_STUB_MODE="$mode" E2E_STUB_LOG="$d/stub.log" E2E_STUB_ENV_LOG="$STUBENV" \
        LOKI_E10_PLAN="${E2E_PLAN:-1}" GH_TOKEN="$CANARY" LOKI_RECEIPT_SIGNING_KEY_FILE="$KEY" \
        ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" ${E2E_VERB:+"$E2E_VERB"} "$TASK" --no-pr "$@" 2>&1)"
    RC=$?
    RUNDIR=""
    if [ -f "$REPO/.loki/engine.json" ]; then
        local rid
        rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
        [ -n "$rid" ] && RUNDIR="$REPO/.loki/runs/$rid"
        # the run ends with the checkout back on main and its work on loki/<rid>; look at that work there
        [ -n "$rid" ] && git -C "$REPO" rev-parse -q --verify "refs/heads/loki/$rid" >/dev/null && git -C "$REPO" checkout -q "loki/$rid"
    fi
}

verify_run() { # verify_run -> "<rc> <verdict>"
    local out rc
    out="$(LOKI_RECEIPT_SIGNING_KEY_FILE="$KEY" bash "$ROOT/bin/loki" verify "$RUNDIR/receipt.json" 2>&1)"; rc=$?
    printf '%s %s\n' "$rc" "$(printf '%s\n' "$out" | sed -n 's/^verdict: //p' | head -1)"
}

run_engine done
[ "$RC" -eq 0 ] && ok "done run exits 0" || { bad "done run exited $RC"; printf '%s\n' "$OUT" | tail -15 | sed 's/^/    | /'; }
grep -Eq '^Outcome:[[:space:]]+VERIFIED' <<< "$OUT" && ok "done run prints Outcome: VERIFIED" || bad "done run did not print Outcome: VERIFIED"
grep -q 'export function multiply' "$REPO/calc.ts" && ok "stub's change landed in calc.ts" || bad "calc.ts has no multiply()"
# D48 counts the start lines plus the summary block (Outcome: to the end); the live candidate diff and the branch note print while the run goes.
# PR-BASE: the one long start line became at most three short ones (target and base; model; cap and estimate), so they are counted as printed and the cap is 10 (it was 1 line and 8).
DSUM="$(printf '%s\n' "$OUT" | sed -n '/^Outcome:/,$p')"; DHEAD="$(awk '/^(Loki 10 engine|model |cap |estimate:)/ && !done { n++; next } { done = 1 } END { print n + 0 }' <<< "$OUT")"; DLN=$(( $(printf '%s\n' "$DSUM" | grep -c '') + DHEAD )); DPC="$(printf '%s\n' "$DSUM" | grep -ciE '(^|; )proof: (yes|no|not run)')"; DFULL="$(printf '%s\n' "$OUT" | grep -cE '^(  Before: |Not proven:)')"
[ -n "$DSUM" ] && [ "$DHEAD" -ge 1 ] && [ "$DHEAD" -le 3 ] && [ "$DLN" -le 10 ] && [ "$DPC" = 1 ] && [ "$DFULL" = 0 ] && ok "D48: the done run's default output is $DLN lines (cap 10: at most 3 start lines) with the one-line proof card on, no full card" || { bad "D48 cap with the proof card: $DLN lines, $DPC proof lines, $DFULL full-card lines"; printf '%s\n' "$OUT" | sed 's/^/    | /'; }
if [ -n "$RUNDIR" ] && [ -f "$RUNDIR/receipt.json" ]; then
    r="$(verify_run)"
    [ "$r" = "0 VERIFIED" ] && ok "loki verify on the run receipt: VERIFIED rc 0" || bad "loki verify gave: $r"
    cp "$RUNDIR/events.jsonl" "$T/events.orig"
    echo '{"v":1,"type":"forged"}' >> "$RUNDIR/events.jsonl"
    r="$(verify_run)"
    [ "$r" = "1 TAMPERED" ] && ok "event appended after the run: TAMPERED rc 1" || bad "edited log gave: $r"
else
    bad "done run left no receipt.json (run dir: '${RUNDIR}')"
fi
if [ -s "$STUBENV" ]; then
    grep -q "$CANARY" "$STUBENV" && bad "the agent session received the GitHub token (Rule of Two broken)" || ok "agent session never saw the GitHub token"
else
    bad "stub env log is empty (the stub never ran)"
fi

grep -qiE 'opus|parity|top-tier|cost avoided|tier sealed' <<< "$OUT" && { bad "VERIFIED console summary compares models"; printf '%s\n' "$OUT" | grep -iE 'opus|parity|top-tier|cost avoided|tier sealed' | sed 's/^/    | /'; } || ok "VERIFIED console summary (default): no opus, parity, top-tier or tier-sealed text (Loki's own cost only)"
run_engine done --verbose
grep -qiE 'opus|parity|top-tier|cost avoided|tier sealed' <<< "$OUT" && bad "VERIFIED console summary (--verbose) compares models" || ok "VERIFIED console summary (--verbose): no opus, parity, top-tier or tier-sealed text"
grep -qE '^Proof: ' <<< "$OUT" && grep -qE '^Not proven:' <<< "$OUT" && ok "--verbose: the full proof card prints after the summary" || { bad "--verbose: no full proof card"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; }

run_engine tamper
[ "$RC" -ne 0 ] && ok "tampered run exits non-zero" || bad "tampered run exited 0"
grep -Eq '^Receipt:[[:space:]]+TAMPERED' <<< "$OUT" && ok "tampered run prints Receipt: TAMPERED" || bad "tampered run did not print Receipt: TAMPERED"
grep -q 'Outcome:    VERIFIED' <<< "$OUT" && bad "tampered run claimed Outcome: VERIFIED" || ok "tampered run never claims Outcome: VERIFIED"

# FR09 hard cap: a metered stub (E2E_STUB_USAGE gives every session a $0.01 cost) first runs uncapped; the cap is then set from
# that run's own events (the cost before implement's first cost event, plus half of implement's cost), measured here and
# never hard-coded, so implement starts under the cap and ends over it. A sealed run is never BUDGET_STOP (outcomeOf: BUDGET_STOP
# needs a run that sealed no receipt), so the capped run reads PARTIAL, exit 6, "cost/time cap reached"; the start line states
# the cap and the quote before spending, implement's edit is kept as a commit on loki/<run>, and main is untouched.
# acc-156: a bare run with no model named starts on Loki's default session model (DEFAULT_SESSION_MODEL, sonnet), never the CLI's own account default;
# a flag or a model env wins, and LOKI_DEFAULT_SESSION_MODEL=provider gives the old run with no --model. The start line and the receipt say which and why.
# dm_facts -> "<receipt model>~<receipt model_source>~<implement --model value or none>~<start line model clause>"
dm_facts() {
    python3 -I - "$RUNDIR/receipt.json" "$T/dm-argv.log" "$OUT" <<'PY'
import json, os, re, sys
rec = json.load(open(sys.argv[1])); argv = open(sys.argv[2]).read().splitlines() if os.path.exists(sys.argv[2]) else []
impl = [l for l in argv if l.startswith("implement")]
m = re.search(r"--model (\S+)", impl[0]) if impl else None
lines = sys.argv[3].splitlines(); at = next((i for i, l in enumerate(lines) if l.startswith("Loki 10 engine")), -1)
c = re.match(r"model (.*)$", lines[at + 1]) if 0 <= at < len(lines) - 1 else None # PR-BASE: the header is three short lines, the model clause is the whole second line (it was a clause of one long line)
print("~".join([str(rec.get("model")), rec.get("model_source", "absent"), m.group(1) if m else "none", c.group(1) if c else "noclause"]))
PY
}
for leg in "default||" "flag|--session-model haiku|" "env||LOKI_MODEL_DEVELOPMENT=haiku" "provider||LOKI_DEFAULT_SESSION_MODEL=provider" "pinned||LOKI_DEFAULT_SESSION_MODEL=haiku" "router||LOKI_ROUTER=auto"; do
    IFS='|' read -r dm_name dm_flag dm_env <<< "$leg"; rm -f "$T/dm-argv.log"
    unset LOKI_SESSION_MODEL LOKI_SESSION_MODEL_SOURCE LOKI_MODEL_DEVELOPMENT LOKI_CLAUDE_MODEL_DEVELOPMENT LOKI_DEFAULT_SESSION_MODEL LOKI_ROUTER
    export E2E_STUB_ARGV_LOG="$T/dm-argv.log"; if [ -n "$dm_env" ]; then export "${dm_env?}"; fi
    # shellcheck disable=SC2086 # dm_flag is a flag and its value
    if [ -n "$dm_flag" ]; then E2E_VERB=start run_engine done $dm_flag; else run_engine done; fi
    unset E2E_STUB_ARGV_LOG; if [ -n "$dm_env" ]; then unset "${dm_env%%=*}"; fi
    DM="$( [ -n "$RUNDIR" ] && dm_facts 2>&1)"
    case "$dm_name:$DM" in
        "default:sonnet~default~sonnet~sonnet (Loki default, "*) ok "default model: a bare run pins sonnet (implement --model sonnet), the start line says Loki default, receipt model_source default" ;;
        "flag:haiku~explicit~haiku~haiku (--session-model"*) ok "default model: --session-model haiku wins over the default (receipt explicit)" ;;
        "env:haiku~explicit~haiku~haiku (LOKI_MODEL_DEVELOPMENT)") ok "default model: LOKI_MODEL_DEVELOPMENT wins over the default (receipt explicit)" ;;
        "provider:claude (provider default)~provider~none~claude (provider default) (LOKI_DEFAULT_SESSION_MODEL=provider"*) ok "default model: LOKI_DEFAULT_SESSION_MODEL=provider restores the CLI default (no --model passed)" ;;
        "pinned:haiku~default~haiku~haiku (LOKI_DEFAULT_SESSION_MODEL=haiku)") ok "default model: LOKI_DEFAULT_SESSION_MODEL=haiku changes the default (receipt default)" ;;
        "router:"*"~explicit~"*"(LOKI_ROUTER=auto)") ok "default model: the model router (LOKI_ROUTER=auto) is a model choice, so no default pin overrides its per-unit models" ;;
        *) bad "default model leg $dm_name: facts '$DM' (rc $RC)"; grep -m3 "^Loki 10 engine\|engine10:\|rror" <<< "$OUT" | sed 's/^/    | /' ;;
    esac
done
unset dm_name dm_flag dm_env DM

# acc-160 COMMIT-HOOK-BYPASS: a repo's own commit hooks never fail Loki's delivery. msw: the session's `pnpm run build` installed simple-git-hooks,
# whose commit-msg commitlint rejected "loki: ..." and ended the run "git commit failed" with no receipt. The prep installs a pre-commit hook that
# rewrites and restages calc.ts (lint-staged style) and a commit-msg hook that rejects a "loki:" subject.
hook_prep() {
    printf '#!/bin/sh\nprintf "// hook was here\\n" >> calc.ts && git add calc.ts\n' > "$1/.git/hooks/pre-commit"
    printf '#!/bin/sh\nif head -1 "$1" | grep -q "^loki:"; then echo "commitlint: type must be one of [feat, fix]" >&2; exit 1; fi\n' > "$1/.git/hooks/commit-msg"
    chmod +x "$1/.git/hooks/pre-commit" "$1/.git/hooks/commit-msg"
}
sign_prep() { git -C "$1" config commit.gpgSign true; git -C "$1" config gpg.program false; } # a signing setup that cannot sign: not a hook, so no bypass
hk_np() { python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r.get("verdict"), "|", " ".join(n for n in r.get("not_proven", []) if "commit" in n)[:300])' "$RUNDIR/receipt.json" 2>/dev/null || echo "no-receipt"; }
E2E_PREP=hook_prep run_engine done
HK="$(hk_np)"
case "$HK" in "VERIFIED | "*"the repo's own commit hook rejected Loki's commit (commitlint: type must be one of [feat, fix])"*) ok "commit hook: a hook that rejects the message is bypassed for Loki's commit, VERIFIED, and the receipt says so" ;; *) bad "commit hook: rejecting hook gave '$HK' (rc $RC)" ;; esac
grep -q "hook was here" "$REPO/calc.ts" && bad "commit hook: the pre-commit hook's restaged edit reached the delivered commit" || ok "commit hook: the delivered commit holds the verified tree, not the hook's restaged edit"
git -C "$REPO" log -1 --format=%s | grep -q "^loki: " && ok "commit hook: the delivered commit keeps Loki's own message" || bad "commit hook: delivered message '$(git -C "$REPO" log -1 --format=%s)'"
E2E_PREP=hook_prep LOKI_E10_COMMIT_HOOK_BYPASS=0 run_engine done
[ "$RC" -ne 0 ] && grep -q "git commit failed" <<< "$OUT" && [ ! -f "${RUNDIR:-/nonexistent}/receipt.json" ] && ok "commit hook: LOKI_E10_COMMIT_HOOK_BYPASS=0 keeps the old stop (git commit failed, no receipt)" || bad "commit hook: knob off gave rc $RC, receipt $( [ -f "${RUNDIR:-/x}/receipt.json" ] && echo yes || echo no)"
E2E_PREP=sign_prep run_engine done
HK="$(hk_np)"
case "$HK" in "FAILED | Loki could not finish checking: git commit failed: "*) ok "commit hook: a failure no hook caused (signing) is not bypassed, and the run still writes a FAILED receipt naming the git error" ;; *) bad "commit hook: signing failure gave '$HK' (rc $RC)" ;; esac
unset -f hook_prep sign_prep

# acc-162 NTF: a low-tier change whose repo maps no test file (an npm package whose tests have no .test name) still runs the repo's own test command.
ntf_prep() {
    git -C "$1" rm -q calc.test.ts bunfig.toml
    printf '{"name":"calc","private":true,"scripts":{"test":"node t.cjs"}}\n' > "$1/package.json"
    printf 'const s = require("fs").readFileSync(__dirname + "/calc.ts", "utf8");\nconst ok = s.includes("export function add");\nconsole.log("TAP version 13\\n" + (ok ? "ok" : "not ok") + " 1 - add is exported\\n1..1\\n# tests 1\\n# suites 0\\n# pass " + (ok ? 1 : 0) + "\\n# fail " + (ok ? 0 : 1) + "\\n# cancelled 0\\n# skipped 0\\n# todo 0");\nprocess.exit(ok ? 0 : 1);\n' > "$1/t.cjs"
    git -C "$1" add package.json t.cjs && git -C "$1" commit -q --amend -m base
}
ntf_facts() { python3 -I - "$RUNDIR/events.jsonl" <<'PY'
import json, sys
v = [json.loads(l)["data"] for l in open(sys.argv[1]) if '"stage.completed"' in l and '"verify"' in l]
v = [d for d in v if "checks" in d]
d = v[-1] if v else {}
full = [c["result"] for c in d.get("checks", []) if c["name"].startswith("full suite")]
print(d.get("no_test_fallback", False), "pass" in full, ",".join(sorted({c["name"].split(":")[0] for c in d.get("checks", [])})))
PY
}
E2E_PREP=ntf_prep LOKI_E10_NO_TEST_FALLBACK=1 run_engine done
f="$(ntf_facts)"; set -- $f
[ "$1" = True ] && [ "$2" = True ] && ok "no-test fallback: a low-tier verify that ran no test runs the repo's own test command, and it passed ($3)" || bad "no-test fallback facts: $f (rc $RC)"
E2E_PREP=ntf_prep LOKI_E10_NO_TEST_FALLBACK=0 LOKI_E10_LOW_TIER_FULL_SUITE=0 run_engine done # the old low-tier rule; G6 (11.172.0) runs the full suite at every tier
f="$(ntf_facts)"; set -- $f
[ "$1" = False ] && [ "$2" = False ] && ok "no-test fallback: LOKI_E10_NO_TEST_FALLBACK=0 keeps the low tier's deferred test command" || bad "no-test fallback off facts: $f"
unset -f ntf_prep

E2E_STUB_USAGE=10 run_engine done
cat > "$T/cap.py" <<'PY'
import json, sys
pre, impl, seen = 0.0, 0.0, False
for l in open(sys.argv[1]):
    e = json.loads(l)
    if e["type"] != "cost": continue
    u = e["data"].get("usd") or 0
    if e.get("stage") == "implement": seen = True; impl += u
    elif not seen: pre += u
print(round(pre + impl / 2, 4) if impl > 0 else "")
PY
CAP=""; [ -n "$RUNDIR" ] && CAP="$(python3 -I "$T/cap.py" "$RUNDIR/events.jsonl")"
if [ -n "$CAP" ]; then
    E2E_STUB_USAGE=10 run_engine done --max-cost "$CAP"
    [ "$RC" -eq 6 ] && ok "capped run: cap \$$CAP, exit 6" || { bad "capped run: exit $RC (want 6) with cap $CAP"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; }
    grep -Eq '^Outcome:[[:space:]]+PARTIAL' <<< "$OUT" && ok "capped run prints Outcome: PARTIAL, never VERIFIED" || bad "capped run did not print Outcome: PARTIAL"
    grep -Eq '^Reason:[[:space:]]+cost/time cap reached' <<< "$OUT" && ok "capped run names the cap as the reason" || bad "capped run does not name the cap as the reason"
    CAPTXT="$(python3 -I -c 'import sys; print("%.2f" % float(sys.argv[1]))' "$CAP")"
    grep -q 'estimate: about ' <<< "$(grep -F "cap \$$CAPTXT (--max-cost)" <<< "$OUT")" && ok "start line states the cap and quotes cost and time before spending" || bad "start line lacks 'cap \$$CAPTXT (--max-cost)' and 'estimate: about': $(head -1 <<< "$OUT")"
    git -C "$REPO" show main:calc.ts | grep -q multiply && bad "capped run changed main" || ok "capped run leaves main untouched"
    capid="$(basename "$RUNDIR")"
    git -C "$REPO" show "loki/$capid:calc.ts" 2>/dev/null | grep -q multiply && ok "the partial is kept: implement's multiply() is committed on loki/<run>" || bad "loki/<run> has no multiply() after the capped run"
else
    bad "capped run: no metered implement cost in the uncapped run's events (run dir '${RUNDIR}')"
fi

# py_engine <target> [manifest file...] -> REPO, OUT, NOTES (receipt not_proven, one per line)
py_engine() {
    local target="$1" d f rid; shift
    d="$(mktemp -d "$T/py.XXXXXX")"; REPO="$d/repo"; mkdir -p "$REPO/tests"
    printf 'def add(a, b):\n    return a + b\n# LOKI_STUB_INSERT\n' > "$REPO/calc.py"
    printf '"""Formatting helpers."""\n# LOKI_STUB_INSERT\n' > "$REPO/extra.py"
    printf 'import calc\n\n\ndef test_add():\n    assert calc.add(2, 3) == 5\n' > "$REPO/tests/test_calc.py"
    [ "${PY_UNTESTED:-0}" = 1 ] || printf '    if hasattr(calc, "multiply"):\n        assert calc.multiply(3, 4) == 12\n' >> "$REPO/tests/test_calc.py"
    printf '[pytest]\npythonpath = .\n' > "$REPO/pytest.ini"
    for f in "$@"; do printf 'pytest\n' > "$REPO/$f"; done
    if [ -n "${PY_PREP:-}" ]; then "$PY_PREP"; fi # a leg's extra base files
    git -C "$REPO" init -q -b main; git -C "$REPO" config user.name e2e; git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add -A .; git -C "$REPO" commit -q -m base
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u VIRTUAL_ENV \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" E2E_STUB_MODE="${PY_MODE:-stack}" \
        E2E_STUB_TARGET="$target" E2E_STUB_SNIPPET="$(printf 'def multiply(a, b):\n    return a * b')" \
        LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$d/k.pem" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "add a multiply(a, b) function to $target" --no-pr 2>&1)"
    NOTES=""
    rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
    [ -n "$rid" ] && NOTES="$(python3 -I -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["not_proven"]))' "$REPO/.loki/runs/$rid/receipt.json" 2>/dev/null)"
}
outcome() { printf '%s\n' "$OUT" | sed -n 's/^Outcome:[[:space:]]*\([A-Z_]*\).*/\1/p' | head -1; }
SYS="tests ran on the system interpreter"
# BUILD-REQUIRES (util/python.ts pyprojectDeclaresDeps): [build-system] requires and an empty dependencies list are not a declared environment, so the
# system interpreter is the project's own and its note does not cap (V1 calibration: 6 of 8 merged fixes were held by it). Plant 7b: count
# build-system requires again; the build_only and empty cells read true.
BR="$(cd "$ROOT/loki-ts" && bun --no-env-file --config=/dev/null -e '
const { pyprojectDeclaresDeps: f } = await import("./src/util/python.ts");
const c = ["[build-system]\nrequires = [\"setuptools\"]\n[project]\nname = \"x\"\n", "[project]\ndependencies = []\n", "[project]\ndependencies = [\n  # none\n]\n",
  "[project]\ndependencies = [\"requests\"]\n", "[project]\ndependencies = [\n  \"attrs\",\n]\n", "[project.optional-dependencies]\ntest = [\"pytest\"]\n", "[tool.poetry.dependencies]\npython = \"3\"\n", "[dependency-groups]\ndev = [\"pytest\"]\n"];
console.log(c.map(f).join(" "));' 2>&1)"
[ "$BR" = "false false false true true true true true" ] && ok "BUILD-REQUIRES: build-system requires and an empty dependencies list do not count as a Python environment; real dependencies do" || bad "BUILD-REQUIRES unit gave: $BR"
# SETUP-DEPS (util/python.ts setupPyDeclaresDeps, setupCfgDeclaresDeps, declaresPythonEnv): a setup.py counts only with an install_requires that is
# not an empty literal (computed values count, fail closed; setup_requires never counts), a setup.cfg only with a non-empty [options] install_requires.
# hc2 tenacity has both triggers: setup.py with only setup_requires and setup.cfg with an empty `install_requires =`. Plants 7c, 7d, 7e, 7y
# (`setup(**(cfg))` and `setup(**{...})` count), 7z (a column-0 comment inside the value does not end the key, as configparser reads it) and 7z2 (a `file:` value counts).
SD="$(cd "$ROOT/loki-ts" && SD_DIR="$T/setup-deps" bun --no-env-file --config=/dev/null -e '
const { setupPyDeclaresDeps: py, setupCfgDeclaresDeps: cfg, declaresPythonEnv } = await import("./src/util/python.ts");
const { mkdirSync, writeFileSync } = await import("node:fs"); const { spawnSync } = await import("node:child_process");
const ten = "#!/usr/bin/env python\n# Licensed under the Apache License\nimport setuptools\n\nsetuptools.setup(\n    setup_requires=[\"setuptools_scm\"],\n    use_scm_version=True,\n)\n";
const pyc = [ten, "from setuptools import setup\nsetup()\n", "setup(name=\"x\", install_requires=[])\n", "setup(install_requires=[\"a>=1\"])\n",
  "setup(install_requires=reqs)\n", "setup(install_requires=open(\"r.txt\").read().splitlines())\n", "setup(name=\"x\")  # install_requires=[\"a\"]\n",
  "setup(install_requires=[] + reqs)\n", "setup(install_requires=[] if x else [\"a\"])\n", "setup(\n    install_requires=[],\n)\n", "setup(**(cfg))\n",
  "setup(**{k: v for k, v in c})\n"];
const tenCfg = "[metadata]\nname = tenacity\n\n[options]\ninstall_requires =\npython_requires = >=3.10\npackages = find:\n\n[options.extras_require]\ntest =\n    pytest\n    tornado>=4.5\n    typeguard\n";
const cfc = [tenCfg, "[options]\ninstall_requires =\n    a>=1\n", "[options]\ninstall_requires = a\n", "[options]\ninstall_requires =\n    # none\n", "[options.extras_require]\ninstall_requires = a\n",
  "[options]\ninstall_requires =\n# core\n    requests>=9999\n", "[options]\ninstall_requires = file: r.txt\n", "[options]\n    install_requires =\n        requests>=9999\n    python_requires = >=3.8\n"];
const d = process.env.SD_DIR; mkdirSync(d, { recursive: true });
const git = (...a) => spawnSync("git", ["-C", d, ...a], { encoding: "utf8" });
git("init", "-q", "-b", "main"); git("config", "user.name", "e2e"); git("config", "user.email", "e2e@example.invalid");
writeFileSync(d + "/setup.py", ten); writeFileSync(d + "/setup.cfg", tenCfg);
writeFileSync(d + "/pyproject.toml", "[build-system]\nrequires = [\"setuptools\", \"setuptools_scm[toml]>=3.4\"]\n\n[tool.ruff]\nline-length = 88\n");
git("add", "-A", "."); git("commit", "-q", "-m", "base"); const before = declaresPythonEnv(d, "HEAD");
writeFileSync(d + "/requirements.txt", "tornado\n"); git("add", "requirements.txt"); git("commit", "-q", "-m", "reqs");
console.log(pyc.map(py).join(" ") + " | " + cfc.map(cfg).join(" ") + " | " + before + " " + declaresPythonEnv(d, "HEAD"));' 2>&1)"
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22.
[ "$SD" = "false false false true true true false true true false true true | false true true false false true true true | false true" ] && ok "SETUP-DEPS: a setup.py or setup.cfg counts as a Python environment only with runtime requirements (tenacity's reads false, a requirements.txt makes it true)" || bad "SETUP-DEPS unit gave: $SD"
# SYSTEM-PROVIDES-DEPS (util/python.ts systemProvidesDeclared, seal.ts sysInfo): a repo that declares runtime requirements reads the
# system-interpreter note as informational only when the interpreter that ran the tests meets every one. Readers first (no interpreter): poetry
# caret and tilde bounds as PEP 440 (^0.x is the lift-direction trap), a computed setup.py list unreadable, [project] dynamic dependencies unreadable;
# one value per fail-closed guard (plants 7p to 7t, 7v to 7y): `**`, distutils requires=, flit and pdm tables, file:, attr:, `%(`, a requirements/ file,
# both setup.cfg key spellings, a triple-quoted string before a URL fragment, two manifests whose second needs the key match (control: docs/base.txt),
# and `**` before a parenthesis or a brace.
SPR="$(cd "$ROOT/loki-ts" && bun --no-env-file --config=/dev/null -e '
const m = await import("./src/util/python.ts");
const j = (v) => JSON.stringify(v);
const pp = "[project]\ndependencies = [\"pip>=1\"]\n", rd = (other) => (f) => (f === "pyproject.toml" ? pp : other);
console.log([m.poetryConstraintToPep440("^1.2.3"), m.poetryConstraintToPep440("^0.2.3"), m.poetryConstraintToPep440("^0.0.3"), m.poetryConstraintToPep440("~1.2.3"), j(m.poetryConstraintToPep440("1.0||2.0")),
  j(m.pyprojectRuntimeRequirements("[tool.poetry.dependencies]\npython = \"^3.8\"\npyasn1 = \">=0.1.3\"\n")), j(m.pyprojectRuntimeRequirements("[project]\ndynamic = [\"dependencies\"]\n")),
  j(m.pyprojectRuntimeRequirements("[tool.poetry.dependencies]\nx = { git = \"https://example.invalid/x\" }\n")), j(m.setupPyRuntimeRequirements("setup(install_requires=reqs)")),
  j(m.setupPyRuntimeRequirements("setup(install_requires=[\"a>=1\"], setup_requires=[\"s\"])")), j(m.setupCfgRuntimeRequirements("[options]\ninstall_requires =\npython_requires = >=3.10\n")),
  j(m.setupPyRuntimeRequirements("setup(install_requires=[\"a\"] + extra)")), j(m.setupPyRuntimeRequirements("setup(install_requires=[\"a\"] if x else [\"b\"])")),
  j(m.setupPyRuntimeRequirements("setup(**kw)")), j(m.setupPyRuntimeRequirements("setup(requires=[\"a\"])")), j(m.pyprojectRuntimeRequirements("[tool.flit.metadata]\nrequires = [\"a\"]\n")),
  j(m.pyprojectRuntimeRequirements("[tool.pdm]\ndependencies = [\"a\"]\n")), j(m.setupCfgRuntimeRequirements("[options]\ninstall_requires = file: r.txt\n")),
  j(m.setupCfgRuntimeRequirements("[options]\ninstall_requires = attr: pkg.REQS\n")), j(m.setupCfgRuntimeRequirements("[options]\ninstall_requires =\n    a%(x)s\n")),
  j(m.declaredRuntimeRequirements(["pyproject.toml", "requirements/base.txt"], rd("pip\n"))), j(m.declaredRuntimeRequirements(["pyproject.toml", "docs/base.txt"], rd("pip\n"))),
  j(m.setupCfgRuntimeRequirements("[options]\ninstall-requires = zzz\n")), j(m.setupCfgRuntimeRequirements("[options]\nInstall_Requires = zzz\n")),
  j(m.setupPyRuntimeRequirements("\"\"\"5\" disk\"\"\"\nsetup(url=\"https://x/#r\", install_requires=[\"zzz\"])")),
  j(m.declaredRuntimeRequirements(["pyproject.toml", "setup.cfg"], rd("[options]\nInstall_Requires = zzz\n"))), j(m.setupPyRuntimeRequirements("setup(**(cfg))")),
  j(m.setupPyRuntimeRequirements("setup(**{k: v for k, v in c})")),
  j(m.setupCfgRuntimeRequirements("[options]\n    install_requires =\n        requests>=9999\n")), j(m.setupCfgRuntimeRequirements("[DEFAULT]\ninstall_requires = zzz\n\n[options]\npackages = find:\n"))].join(" "));' 2>&1)"
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22.
SPR_WANT='>=1.2.3,<2.0.0 >=0.2.3,<0.3.0 >=0.0.3,<0.0.4 >=1.2.3,<1.3 null ["pyasn1>=0.1.3"] null null null ["a>=1"] [] null null null null null null null null null null ["pip>=1"] ["zzz"] ["zzz"] ["zzz"] ["pip>=1","zzz"] null null ["requests>=9999"] ["zzz"]'
[ "$SPR" = "$SPR_WANT" ] && ok "SYSTEM-PROVIDES-DEPS readers: caret and tilde bounds translate, computed, dynamic and git requirements are unreadable" || bad "SYSTEM-PROVIDES-DEPS readers gave: $SPR"
# Interpreter cells, on scratch repos, against a distribution this python3 really has (pip, version probed, never hardcoded). Plants:
#   7j. util/python.ts PY_SATISFIES: append every entry as met (skip the marker and specifier checks); the ">=9999" cell reads true (false VERIFIED).
#   7k. util/python.ts declaredRuntimeRequirements: drop the PY_MANIFEST check; the requirements.txt cell reads true (false VERIFIED).
#   7n. interpreterSatisfies back to cwd: tmpdir(): the pyver cell (a shim that picks its interpreter by .python-version in the working directory, as pyenv,
#       asdf and mise do) reads true; nopyver is its control (no .python-version, the shim's other interpreter has the requirement: true either way).
#   7o. PY_SATISFIES reads only sys.path: the PYTHONPATH pip 0.0.1 cell reads true; a PYTHONPATH pip 99.0 copy is its control (true).
#       Both get the caller's whole environment with only PYTHONPATH set, so they differ from the rsa cell by that one variable.
#   7u. no url/extras test: the extras and URL cells read true. 7v. no requirements/ directory test: the reqdir cell reads true.
#   7o2. no user-site term: the PYTHONUSERBASE pip 0.0.1 cell reads true (its control sets PYTHONNOUSERSITE=1: true). The user site directory is
#       the one this python3 prints for that PYTHONUSERBASE, never hardcoded (a framework build uses lib/python/site-packages).
#   7o3. no cwd term: the rootlow cell (pip-0.0.1.dist-info in the repo root) reads true. 7o4. `outside` back to `path` in the existence test: the absent cell (a root-only
#       lokiabsentdist-1.0.dist-info, no such distribution installed) reads true. The working directory may refute, never satisfy.
#   7o5. `outside` back to `path[1:]`: the PYTHONPATH=. lokiabsentdist cell reads true (a vendored copy on PYTHONPATH satisfies again).
if python3 -I -c 'import importlib.metadata as m; m.version("pip")
try:
    import packaging.requirements
except Exception:
    import pip._vendor.packaging.requirements' >/dev/null 2>&1; then
    spd_repo() { # $1 name, then path=content pairs
        local r="$T/spd-$1"; shift; mkdir -p "$r"
        while [ $# -gt 0 ]; do mkdir -p "$(dirname "$r/${1%%=*}")"; printf '%b' "${1#*=}" > "$r/${1%%=*}"; shift; done
        git -C "$r" init -q -b main; git -C "$r" config user.name e2e; git -C "$r" config user.email e2e@example.invalid; git -C "$r" add -A .; git -C "$r" commit -q -m base
    }
    spd_repo rsa 'pyproject.toml=[tool.poetry.dependencies]\npython = "^3.8"\npip = ">=1"\n'
    spd_repo high 'pyproject.toml=[tool.poetry.dependencies]\npython = "^3.8"\npip = ">=9999"\n'
    spd_repo marker 'pyproject.toml=[project]\nname = "x"\ndependencies = ["nosuchdist-loki-xyz; python_version < \\"2\\"", "pip>=1"]\n'
    spd_repo computed 'setup.py=from setuptools import setup\nsetup(install_requires=reqs)\n'
    spd_repo reqtxt 'pyproject.toml=[project]\nname = "x"\ndependencies = ["pip>=1"]\n' 'requirements.txt=pip\n'
    spd_repo tooling 'pyproject.toml=[project]\nname = "x"\n[project.optional-dependencies]\ntest = ["pytest"]\n'
    spd_repo extras 'pyproject.toml=[project]\nname = "x"\ndependencies = ["pip[x]>=1"]\n'
    spd_repo url 'pyproject.toml=[project]\nname = "x"\ndependencies = ["pip @ https://example.invalid/pip.whl"]\n'
    spd_repo reqdir 'pyproject.toml=[project]\nname = "x"\ndependencies = ["pip>=1"]\n' 'requirements/base.txt=pip\n'
    spd_repo pyver 'pyproject.toml=[project]\nname = "x"\ndependencies = ["lokifakespd>=1"]\n' '.python-version=system\n'
    spd_repo nopyver 'pyproject.toml=[project]\nname = "x"\ndependencies = ["lokifakespd>=1"]\n'
    spd_repo indent 'pyproject.toml=[project]\nname = "x"\ndependencies = ["pip>=1"]\n' 'setup.cfg=[options]\n    install_requires =\n        requests>=9999\n'
    spd_repo absent 'pyproject.toml=[project]\nname = "x"\ndependencies = ["lokiabsentdist>=1"]\n' 'lokiabsentdist-1.0.dist-info/METADATA=Metadata-Version: 2.1\nName: lokiabsentdist\nVersion: 1.0\n'
    spd_repo rootlow 'pyproject.toml=[project]\nname = "x"\ndependencies = ["pip>=1"]\n' 'pip-0.0.1.dist-info/METADATA=Metadata-Version: 2.1\nName: pip\nVersion: 0.0.1\n'
    spd_us="$(PYTHONUSERBASE="$T/spd-ub" python3 -c 'import site; print(site.getusersitepackages())')"
    mkdir -p "$spd_us/pip-0.0.1.dist-info"; printf 'Metadata-Version: 2.1\nName: pip\nVersion: 0.0.1\n' > "$spd_us/pip-0.0.1.dist-info/METADATA"; unset spd_us
    for d in spd-fake/lokifakespd-1.0 spd-pp-low/pip-0.0.1 spd-pp-high/pip-99.0; do # dist-info copies: name and version from the directory
        mkdir -p "$T/$d.dist-info"; n="${d#*/}"; printf 'Metadata-Version: 2.1\nName: %s\nVersion: %s\n' "${n%-*}" "${n##*-}" > "$T/$d.dist-info/METADATA"
    done; unset d n
    printf '#!/bin/sh\n# picks its interpreter by working directory, as a pyenv shim does: with .python-version here the real python3, elsewhere one that also sees %s\nif [ -f .python-version ]; then exec python3 "$@"; fi\nexec python3 -I -c "import sys; sys.path.insert(0, \\"%s\\"); exec(sys.argv[1])" "$3"\n' "$T/spd-fake" "$T/spd-fake" > "$T/spd-cwd-python"; chmod +x "$T/spd-cwd-python"
    printf '#!/bin/sh\n# a python3 whose packaging and pip cannot be imported; argv is -I -c <script>\nexec python3 -I -c "import sys; sys.modules[\\"packaging\\"] = None; sys.modules[\\"pip\\"] = None; exec(sys.argv[1])" "$3"\n' > "$T/spd-nopkg-python"; chmod +x "$T/spd-nopkg-python"
    SPD="$(cd "$ROOT/loki-ts" && T="$T" bun --no-env-file --config=/dev/null -e '
const { systemProvidesDeclared: f } = await import("./src/util/python.ts");
const T = process.env.T, { PYTHONNOUSERSITE: _nus, ...us } = process.env;
console.log([f(`${T}/spd-rsa`, "HEAD", "python3"), f(`${T}/spd-high`, "HEAD", "python3"), f(`${T}/spd-marker`, "HEAD", "python3"), f(`${T}/spd-computed`, "HEAD", "python3"),
  f(`${T}/spd-reqtxt`, "HEAD", "python3"), f(`${T}/spd-rsa`, "HEAD", `${T}/spd-nopkg-python`), f(`${T}/spd-tooling`, "HEAD", "python3"),
  f(`${T}/spd-extras`, "HEAD", "python3"), f(`${T}/spd-url`, "HEAD", "python3"), f(`${T}/spd-reqdir`, "HEAD", "python3"),
  f(`${T}/spd-pyver`, "HEAD", `${T}/spd-cwd-python`), f(`${T}/spd-nopyver`, "HEAD", `${T}/spd-cwd-python`),
  f(`${T}/spd-rsa`, "HEAD", "python3", { ...process.env, PYTHONPATH: `${T}/spd-pp-low` }),
  f(`${T}/spd-rsa`, "HEAD", "python3", { ...process.env, PYTHONPATH: `${T}/spd-pp-high` }),
  f(`${T}/spd-rsa`, "HEAD", "python3", { ...us, PYTHONUSERBASE: `${T}/spd-ub` }), f(`${T}/spd-rsa`, "HEAD", "python3", { ...us, PYTHONUSERBASE: `${T}/spd-ub`, PYTHONNOUSERSITE: "1" }),
  f(`${T}/spd-absent`, "HEAD", "python3"), f(`${T}/spd-rootlow`, "HEAD", "python3"),
  f(`${T}/spd-absent`, "HEAD", "python3", { ...process.env, PYTHONPATH: "." }), f(`${T}/spd-rsa`, "HEAD", "python3", { ...process.env, PYTHONPATH: "." }),
  f(`${T}/spd-indent`, "HEAD", "python3")].join(" "));' 2>&1)"
    # STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22.
    SPD_WANT="true false true false false false false false false false false true false true false true false false false true false"
    [ "$SPD" = "$SPD_WANT" ] && ok "SYSTEM-PROVIDES-DEPS: a met poetry requirement and a marker-false entry lift; an unmet version, a computed list, a requirements.txt, no packaging, no runtime requirement, an extra, a URL, a requirements/ file, an interpreter chosen by the repo's .python-version, a failing PYTHONPATH, user-site or repo-root copy and a repo-root-only copy keep the hold" || bad "SYSTEM-PROVIDES-DEPS unit gave: $SPD (want: $SPD_WANT)"
elif [ "${CI:-}" = "true" ]; then
    bad "SYSTEM-PROVIDES-DEPS: python3 has no pip distribution or packaging (required in CI)"
else
    echo "SKIP: SYSTEM-PROVIDES-DEPS interpreter cells (python3 has no pip distribution or packaging)"
fi
# High tier through the BUNDLE (LOKI_TS_ENTRY is dist/loki.js): the security scan must find its script from the package
# root. A path relative to the bundle file points outside the package and reads "secret-scan.sh not found" (PARTIAL).
LOKI_RISK_TIER=high LOKI_SESSION_MODEL=haiku E2E_STUB_ARGV_LOG="$T/high-argv.log" run_engine done
rv="$(grep '^review ' "$T/high-argv.log" 2>/dev/null | grep -o -- '--model [^ ]*' | sort -u | tr '\n' ' ')"
[ "$rv" = "--model haiku " ] && ok "high tier: the default review runs (on by default for high risk), on the run's own Haiku pin" || bad "high tier: review --model arguments '$rv' (want one review on haiku)"
scan="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(" ".join(c["result"] for c in json.load(open(sys.argv[1]))["checks"] if c["name"]=="security scan"))' "$RUNDIR/receipt.json" 2>/dev/null)"
[ "$scan" = "pass" ] && ok "high tier through the bundle: the security scan ran and passed" || { bad "high tier through the bundle: security scan result '$scan'"; printf '%s\n' "$OUT" | grep -E '^(Outcome|NOT PROVEN)' | sed 's/^/    | /'; }
grep -Eq '^Outcome:[[:space:]]+VERIFIED' <<< "$OUT" && ok "high tier through the bundle: VERIFIED" || bad "high tier through the bundle: not VERIFIED"
if python3 -m pytest --version >/dev/null 2>&1; then
    py_engine calc.py
    [ "$(outcome)" = "VERIFIED" ] && ok "python, no dependency manifest: impacted pytest passed, VERIFIED" || { bad "python, no dependency manifest: outcome '$(outcome)', not VERIFIED"; printf '%s\n' "$NOTES" | sed 's/^/    np | /'; }
    grep -q "^$SYS (.*informational, does not cap)$" <<< "$NOTES" && ok "python, no dependency manifest: system-interpreter note kept as informational" || bad "python, no dependency manifest: informational note missing"
    py_engine calc.py requirements.txt
    [ "$(outcome)" = "PARTIAL" ] && ok "python, requirements.txt declared: still capped at PARTIAL" || bad "python, requirements.txt declared: outcome '$(outcome)', not PARTIAL"
    grep -qx "$SYS" <<< "$NOTES" && ok "python, requirements.txt declared: system-interpreter note caps (no suffix)" || bad "python, requirements.txt declared: note missing or marked informational"
    # SYSTEM-PROVIDES-DEPS seal wiring (seal.ts sysCase): a pyproject whose one runtime requirement this python3 meets reads VERIFIED with the
    # provided suffix; an unmet one keeps the plain capping note (plant 7m). Needs the pip distribution on python3 (the stub legs' interpreter).
    if python3 -I -c 'import importlib.metadata as m; m.version("pip")' >/dev/null 2>&1; then
        spd_met() { printf '[project]\nname = "calc"\nversion = "0"\ndependencies = ["pip>=1"]\n' > "$REPO/pyproject.toml"; }
        spd_unmet() { printf '[project]\nname = "calc"\nversion = "0"\ndependencies = ["pip>=9999"]\n' > "$REPO/pyproject.toml"; }
        PY_PREP=spd_met py_engine calc.py
        [ "$(outcome)" = "VERIFIED" ] && ok "python, pyproject requirement met on this interpreter: VERIFIED" || { bad "python, pyproject requirement met: outcome '$(outcome)', not VERIFIED"; printf '%s\n' "$NOTES" | sed 's/^/    np | /'; }
        grep -qF "$SYS (this interpreter has every runtime requirement the repo declares; informational, does not cap)" <<< "$NOTES" && ok "python, pyproject requirement met: note carries the provided suffix" || bad "python, pyproject requirement met: provided suffix missing"
        PY_PREP=spd_unmet py_engine calc.py
        [ "$(outcome)" = "PARTIAL" ] && ok "python, pyproject requirement unmet (pip>=9999): still capped at PARTIAL" || bad "python, pyproject requirement unmet: outcome '$(outcome)', not PARTIAL"
        grep -qx "$SYS" <<< "$NOTES" && ok "python, pyproject requirement unmet: system-interpreter note caps (no suffix)" || bad "python, pyproject requirement unmet: note missing or marked informational"
        PY_PREP=spd_met LOKI_E10_SYSTEM_PROVIDES_DEPS=0 py_engine calc.py
        [ "$(outcome)" = "PARTIAL" ] && ok "python, LOKI_E10_SYSTEM_PROVIDES_DEPS=0: a met requirement is held again" || bad "python, LOKI_E10_SYSTEM_PROVIDES_DEPS=0: outcome '$(outcome)', not PARTIAL"
        unset -f spd_met spd_unmet
    fi
    py_engine extra.py
    [ -n "$(outcome)" ] && [ "$(outcome)" != "VERIFIED" ] && ok "python, change no test imports: not VERIFIED ($(outcome))" || { bad "python, change no test imports: outcome '$(outcome)'"; printf '%s\n' "$NOTES" | sed 's/^/    np | /'; }
    PY_UNTESTED=1 py_engine calc.py
    [ -n "$(outcome)" ] && [ "$(outcome)" != "VERIFIED" ] && ok "python, impacted test passes but never calls multiply(): not VERIFIED ($(outcome))" || { bad "python, unexercised change: outcome '$(outcome)'"; printf '%s\n' "$NOTES" | sed 's/^/    np | /'; }
    grep -q "no passing check references a changed symbol.*multiply" <<< "$NOTES" && ok "python, unexercised change: the receipt names multiply as unexercised" || bad "python, unexercised change: no changed-symbol note"
    # VERIFY-PLAN R1 (LOKI_E10_LEAN_SYMBOL_HOLD, enforce by default): L1 is the leg above. L2 observe: the label without the hold and one observe entry; L3 =0: the label
    # without the hold, the line disclosed, no entry. Plants (each reverted): off still passes leanGap (L3 PARTIAL); observe applies the hold (L2 PARTIAL, no entry).
    l_facts() { python3 -I -c 'import json, sys, glob
r = json.load(open(glob.glob(sys.argv[1] + "/.loki/runs/*/receipt.json")[0]))
e = [o["would_label"] for o in r.get("observe") or [] if o.get("rule") == "LOKI_E10_LEAN_SYMBOL_HOLD"]
ln = [n for n in r.get("not_proven") or [] if n.startswith("no passing check references a changed symbol")]
print(r["verdict"], "entry=" + (e[0] if e else "none"), ("disclosed" if "(disclosed, does not cap)" in ln[0] else "hold") if ln else "noline", "held" if any(h["kind"] == "changed symbol not referenced" for h in r.get("held_by") or []) else "notheld")' "$REPO" 2>&1; }
    l1="$(l_facts)"
    LOKI_E10_LEAN_SYMBOL_HOLD=observe PY_UNTESTED=1 py_engine calc.py; l2="$(l_facts)"
    LOKI_E10_LEAN_SYMBOL_HOLD=0 PY_UNTESTED=1 py_engine calc.py; l3="$(l_facts)"
    case "$l1" in "PARTIAL entry=none hold held") ok "R1 L1 enforce (default): the changed-symbol hold holds the label and is on held_by ($l1)" ;; *) bad "R1 L1 gave: $l1" ;; esac
    [ "$l2" = "${l3%% *} entry=PARTIAL disclosed notheld" ] && [ "${l3%% *}" != PARTIAL ] && ok "R1 L2 observe: the label without the hold (${l2%% *}) and one observe entry saying PARTIAL ($l2)" || bad "R1 L2 gave: $l2 (L3: $l3)"
    case "$l3" in "PARTIAL "*) bad "R1 L3 =0 still held: $l3" ;; *" entry=none disclosed notheld") ok "R1 L3 =0: the label without the hold, the line disclosed, no entry ($l3)" ;; *) bad "R1 L3 gave: $l3" ;; esac
    # acc-162 BCE: a test whose conftest cannot import on base and head alike is the environment, not the change: not_run on NOT PROVEN, never FAILED.
    bce_prep() { printf 'import loki_missing_module_bce\n' > "$REPO/tests/conftest.py"; }
    PY_PREP=bce_prep LOKI_E10_BASE_CRASH_ENV=1 py_engine calc.py
    case "$(outcome)" in FAILED|STALLED|"") bad "base crash: a conftest that fails on base too ended '$(outcome)'" ;; *) grep -q "fails the same way on base, so its result cannot be read" <<< "$NOTES" && ok "base crash: the same ImportError on base makes the check environment ($(outcome)), named on NOT PROVEN" || bad "base crash: NOT PROVEN lacks the base-crash line ($(outcome))" ;; esac
    PY_PREP=bce_prep LOKI_E10_BASE_CRASH_ENV=0 py_engine calc.py
    grep -q "fails the same way on base" <<< "$NOTES" && bad "base crash: LOKI_E10_BASE_CRASH_ENV=0 still wrote the base-crash line" || ok "base crash: LOKI_E10_BASE_CRASH_ENV=0 keeps the crash a failure ($(outcome))"
    unset -f bce_prep
elif [ "${CI:-}" = "true" ]; then
    bad "python legs: pytest is not installed on the CI runner"
else
    echo "SKIP: python legs (pytest not installed)"
fi

# L003: one review per run, before seal. PR runs push to a local bare origin (engine10-push.sh local mode, no
# network); the detached deep worker is awaited. run_pr <label> <basered: none|stable|new> [env...] -> REPO, RUNDIR, D, OUT
run_pr() {
    local label="$1" basered="$2" i pid; shift 2
    D="$T/pr-$label"; REPO="$D/repo"; mkdir -p "$D"
    git init -q --bare -b main "$D/origin.git"
    cp -R "$FIX/repo" "$REPO"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e
    git -C "$REPO" config user.email e2e@example.invalid
    if [ "$basered" != none ]; then # a root npm suite already red on base (TAP ids); "new" adds a second failure once multiply() exists
        printf '{"name":"calc","private":true,"scripts":{"test":"node check.cjs"}}\n' > "$REPO/package.json"
        printf 'const extra = %s && require("fs").readFileSync("calc.ts", "utf8").includes("multiply");\nconsole.log("TAP version 13\\nnot ok 1 - legacy broken\\n" + (extra ? "not ok 2 - multiply broken\\n1..2\\n# fail 2" : "1..1\\n# fail 1"));\nprocess.exit(1);\n' \
            "$([ "$basered" = new ] && echo true || echo false)" > "$REPO/check.cjs"
        git -C "$REPO" add package.json check.cjs
    fi
    git -C "$REPO" add calc.ts calc.test.ts bunfig.toml
    git -C "$REPO" commit -q -m base
    git -C "$REPO" remote add origin "$D/origin.git"
    git -C "$REPO" push -q origin main
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u GH_TOKEN -u GITHUB_TOKEN \
        -u LOKI_REVIEW_PROVIDER -u LOKI_REVIEW_DEFAULT -u LOKI_XVENDOR_DEFAULT -u LOKI_RISK_TIER -u LOKI_PR_DRAFT \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" GH_CONFIG_DIR="$D/ghcfg" \
        E2E_STUB_MODE=done E2E_STUB_LOG="$D/stub.log" E2E_STUB_ITER_LOG="$D/iter.log" E2E_STUB_USAGE=10 \
        LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$D/k.pem" "$@" \
        ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$TASK" 2>&1)"
    RUNDIR="$REPO/.loki/runs/$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
    for i in $(seq 1 90); do [ -f "$RUNDIR/receipt-addendum-1.json" ] && break; sleep 1; done
    pid="$(python3 -I -c 'import json,sys; print(next((json.loads(l)["data"]["pid"] for l in open(sys.argv[1]) if "\"deep.started\"" in l), ""))' "$RUNDIR/events.jsonl" 2>/dev/null)"
    for i in $(seq 1 30); do [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || break; sleep 1; done
}
# pr_facts -> "<pr.opened> <draft> <deep.started> <review sessions> <council files+events> <verdict> <cost sum == receipt to the cent> <addendum status_state>"
pr_facts() {
    python3 -I - "$REPO" "$RUNDIR" "$D/stub.log" <<'PY'
import glob, json, os, sys
repo, rd, stub = sys.argv[1:4]
ev = [json.loads(l) for l in open(os.path.join(rd, "events.jsonl")) if l.strip().startswith("{")]
pr = [e for e in ev if e.get("type") == "pr.opened"]
costs = glob.glob(os.path.join(repo, ".loki", "metrics", "result-cost-*.json"))
council = sum(f.endswith("-council.json") for f in costs) + sum("-council" in json.dumps(e) for e in ev)
reviews = sum(1 for l in open(stub) if l.strip() == "review") if os.path.exists(stub) else 0
rec = json.load(open(os.path.join(rd, "receipt.json")))
total = sum(json.load(open(f)).get("total_cost_usd") or 0 for f in costs)
usd = rec.get("cost", {}).get("usd")
add = os.path.join(rd, "receipt-addendum-1.json")
state = json.load(open(add))["status_state"] if os.path.exists(add) else "none"
print(len(pr), bool(pr and pr[0]["data"].get("draft")), sum(e.get("type") == "deep.started" and not (e.get("data") or {}).get("poster") for e in ev), reviews, council,
      rec.get("verdict"), usd is not None and round(total, 2) == round(usd, 2), state)
PY
}

run_pr block none LOKI_RISK_TIER=medium LOKI_REVIEW_DEFAULT=1 E2E_STUB_REVIEW=BLOCK
f="$(pr_facts)"; set -- $f
[ "$1" = 1 ] && [ "$3" = 1 ] && ok "medium PR run: PR opened and deep verify ran" || { bad "medium PR run facts: $f"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
[ "$5" = 0 ] && ok "no result-cost file or event carries a -council iteration" || bad "council iteration found after the run ($5)"
[ "$4" = 1 ] && ok "exactly one review session in the run (the pre-seal cross-review)" || bad "review sessions in the run: $4 (want 1)"
[ "$6" = PARTIAL ] && [ "$2" = True ] && ok "reviewer BLOCK caps the verdict at PARTIAL (draft PR)" || bad "BLOCK review gave verdict $6, draft $2"
[ "$7" = True ] && ok "draft run: result-cost sum equals receipt cost to the cent" || bad "draft run: cost sum differs from the receipt"
grep -q '"base_red"' "$RUNDIR/receipt-addendum-1.json" 2>/dev/null && bad "addendum marked a suite base_red with no red base" || ok "no base_red mark on a green base"
# FR08: the review queue and the merge gate bind a receipt to a PR by head_sha, so the pushed PR branch must be exactly the sealed head
pushed="$(git -C "$D/origin.git" rev-parse "loki/$(basename "$RUNDIR")" 2>/dev/null)"
sealed="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("head_sha",""))' "$RUNDIR/receipt.json" 2>/dev/null)"
[ -n "$sealed" ] && [ "$pushed" = "$sealed" ] && ok "pushed PR branch tip equals the receipt head_sha (passport and merge gate bind to it)" || bad "pushed loki/<run> tip '$pushed' differs from receipt head_sha '$sealed'"

run_pr highrev none LOKI_RISK_TIER=high E2E_STUB_REVIEW=FLAG LOKI_PR_DRAFT=1
grep -q 'cross-review flag (claude): stub reviewer concern' "$RUNDIR/receipt.json" && ok "high-risk default-model run: the cross-review ran (no --model label passed to the CLI)" || bad "high-risk default-model run: cross-review did not run (reviewer got the provider-default label as --model?)"
grep -q 'cross-review not run: claude exited' "$RUNDIR/receipt.json" && bad "high-risk run: reviewer exited non-zero" || ok "high-risk run: reviewer exit clean"

run_pr flag none LOKI_RISK_TIER=medium LOKI_REVIEW_DEFAULT=1 E2E_STUB_REVIEW=FLAG LOKI_PR_DRAFT=1
f="$(pr_facts)"; set -- $f
[ "$4" = 1 ] && [ "$5" = 0 ] && ok "FLAG run: one review session, no council" || bad "FLAG run facts: $f"
grep -q 'cross-review flag (claude): stub reviewer concern' "$RUNDIR/receipt.json" && ok "reviewer FLAG finding lands on the receipt as NOT PROVEN" || bad "FLAG finding missing from the receipt"
[ "$2" = True ] && [ "$7" = True ] && ok "draft run 2: result-cost sum equals receipt cost to the cent" || bad "draft run 2 facts: $f"

[ "$6" = VERIFIED ] && ok "F3: a FLAG review without an UNMET line leaves the run VERIFIED" || bad "F3: FLAG run without UNMET gave verdict $6"
run_pr unmet none LOKI_RISK_TIER=medium LOKI_REVIEW_DEFAULT=1 E2E_STUB_REVIEW=FLAG "E2E_STUB_REVIEW_EXTRA=UNMET: Acceptance: a filter template and a history entry are saved" LOKI_PR_DRAFT=1
f="$(pr_facts)"; set -- $f
[ "$6" = PARTIAL ] && grep -q 'cross-review flag (claude): UNMET: Acceptance: a filter template and a history entry are saved' "$RUNDIR/receipt.json" \
    && ok "F3: the same FLAG review with one UNMET line caps the verdict at PARTIAL, the line on the receipt" || bad "F3: FLAG run with UNMET gave verdict $6"
U3="$(cd "$ROOT/loki-ts" && bun --no-env-file --config=/dev/null -e '
const x = await import("./src/engine10/stages/xreview.ts");
const six = JSON.stringify({ result: "VERDICT: FLAG\n- one\n- two\n- three\n- four\n- five\n- UNMET: Acceptance: six is cut today" }), plain = JSON.stringify({ result: "VERDICT: FLAG\n- one\n- two" });
const r6 = x.parseReview("claude", six), rp = x.parseReview("claude", plain);
console.log([r6.notes.length, r6.notes[0], r6.notes.filter(x.isUnmetNote).length, JSON.stringify(rp.notes), x.isUnmetNote("cross-review flag (claude): **UNMET**: a"), x.isUnmetNote("cross-review flag (claude): the UNMET word inside")].join(" | "));
' 2>&1)"
[ "$U3" = '5 | cross-review flag (claude): UNMET: Acceptance: six is cut today | 1 | ["cross-review flag (claude): one","cross-review flag (claude): two"] | true | false' ] \
    && ok "F3 unit: an UNMET reason written sixth is kept (sorted first, the cap stays 5); a review with no UNMET keeps its order; bold UNMET counts, the word inside a reason does not" || bad "F3 unit gave: $U3"

# G5 SKIP-NOTE end to end (oc63960): a full suite red only on base ids must seal without the "fix round skipped" note holding it; the same run with one
# new failing id in that suite is held by it. Plant G5-10: util/check_result.ts suiteSkipHolds always false: the new-id run seals without the note.
snote() { python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r.get("verdict"), any(str(n).startswith("fix round skipped: only full-suite failures remained") for n in r.get("not_proven", [])))' "$RUNDIR/receipt.json" 2>/dev/null || echo no-receipt; }
run_pr stable stable LOKI_PR_DRAFT=1
f="$(pr_facts)"; set -- $f
[ "$8" = success ] && ok "deep full suite red only on base-red ids: status success" || bad "base-red full suite gave status $8 ($f)"
grep -q '"base_red": true' "$RUNDIR/receipt-addendum-1.json" && ok "addendum marks the base-red suite" || bad "addendum lacks base_red"
[ "$4" = 0 ] && [ "$5" = 0 ] && ok "low tier PR run: zero review sessions" || bad "low tier review sessions: $4, council $5"
[ "$6" = VERIFIED ] && ok "F3: a run with no reviewer keeps its verdict (VERIFIED, as on the base commit)" || bad "F3: no-reviewer run verdict $6 (want VERIFIED, as on the base commit)"
[ "$2" = True ] && [ "$7" = True ] && ok "draft run 3: result-cost sum equals receipt cost to the cent" || bad "draft run 3 facts: $f"

run_pr new new LOKI_E10_LOW_TIER_FULL_SUITE=0 # the old low-tier rule: the full suite runs only in the post-seal deep worker
f="$(pr_facts)"; set -- $f
[ "$8" = failure ] && ok "a new failing id beyond the base-red ones keeps status failure" || bad "new full-suite failure gave status $8 ($f)"
# G6 LOW-TIER-FULL-SUITE (default on): the same low-tier run now runs the full suite before the seal, so the new failing id seals FAILED at the seal.
run_pr new-g6 new
f="$(pr_facts)"; set -- $f
[ "$6" = FAILED ] && ok "G6: a low-tier run with a new full-suite failure seals FAILED at the seal, not VERIFIED with a later deep-worker failure (the work still goes out as a draft PR)" || bad "G6: low-tier new failure gave verdict $6 ($f)"
# K5: the G6 leg above (a break only the full suite sees) must still read FAILED with FULL-SUITE-FINAL-ONLY and FULL-SUITE-REUSE on (both default on).
# G6 RELIEF unit (verify.ts fullSuiteKey, depStamp, deferFullSuite, reusableRun, nextSuiteRuns; deep.ts runFullSuite reuse). K1: the key moves with a changed
# file's content, an added untracked file, a deleted file and a dependency entry, and (a deliberate deviation from the spec's per-package scope) with a changed
# file in another package too: a package suite reads its dependencies' sources and a relative import across packages declares nothing, so every changed
# path is in every suite's key. depStamp ignores a runner cache and moves with an added or reinstalled package. deferFullSuite defers at low tier only on a
# red that feeds the fix round. reusableRun (K3, K3b, 7i): equal key and a pass or fail record reuses, marked on the check; another key, a stopped
# previous verify or a not_run record never does; a quick verify carries the record forward; the reused check is a copy. runFullSuite pushes a reused
# result without running the suite and adds no NOT PROVEN line (7i2). Seal's label rule caps a verify that carries the deferred line (7h).
G6R="$(cd "$ROOT/loki-ts" && G6R_DIR="$T/g6r" bun --no-env-file --config=/dev/null -e '
const v = await import("./src/engine10/stages/verify.ts"), se = await import("./src/engine10/stages/seal.ts"), dp = await import("./src/engine10/stages/deep.ts");
const { mkdirSync, writeFileSync } = await import("node:fs"); const { spawnSync } = await import("node:child_process");
const H = { "calc.ts": "a1", "calc.test.ts": "b1" }, B = { baseSha: "s0", name: "full suite: bun", cmd: "bun test", cwd: ".", hashes: H, deps: ["node_modules/x=pkg:10:1"] }, K = (o) => v.fullSuiteKey({ ...B, ...o }), k0 = K({});
const PA = { cwd: "packages/a", name: "full suite: a" };
const k1 = [K({}) === k0, K({ hashes: { ...H, "calc.ts": "a2" } }) !== k0, K({ hashes: { ...H, "new.ts": "c1" } }) !== k0, K({ hashes: { ...H, "calc.ts": "-" } }) !== k0, K({ deps: [...B.deps, "node_modules/y=pkg:3:1"] }) !== k0,
  K({ ...PA, hashes: { ...H, "packages/b/x.ts": "d1" } }) !== K(PA), K({ ...PA, hashes: { ...H, "root.ts": "r1" } }) !== K(PA), K({ hashes: { "calc.test.ts": "b1", "calc.ts": "a1" } }) === k0].every(Boolean);
const d = process.env.G6R_DIR; mkdirSync(d + "/node_modules/foo", { recursive: true }); writeFileSync(d + "/node_modules/foo/package.json", "{\"version\":\"1.0.0\"}");
const s1 = v.depStamp(d, "."); mkdirSync(d + "/node_modules/.vite", { recursive: true }); writeFileSync(d + "/node_modules/.vite/dep.json", "{}"); const s2 = v.depStamp(d, ".");
mkdirSync(d + "/node_modules/bar", { recursive: true }); writeFileSync(d + "/node_modules/bar/package.json", "{}"); const s3 = v.depStamp(d, ".");
writeFileSync(d + "/node_modules/foo/package.json", "{\"version\":\"1.10.0\"}"); const s4 = v.depStamp(d, ".");
const ds = [JSON.stringify(s1) === JSON.stringify(s2), JSON.stringify(s2) !== JSON.stringify(s3), JSON.stringify(s3) !== JSON.stringify(s4)].join(",");
const lowIn = (o) => ({ tier: "low", ntf: false, settle: false, checks: [{ name: "bun:calc.test.ts", result: "fail" }], touchedRed: new Set(), keep: new Set(["bun:calc.test.ts"]), changed: ["calc.ts"], ...o });
const df = [v.deferFullSuite(lowIn({})), v.deferFullSuite(lowIn({ checks: [{ name: "lint:eslint", result: "fail" }] })), v.deferFullSuite(lowIn({ keep: new Set(), checks: [{ name: "bun:t/x.test.ts", result: "fail" }], changed: ["calc.ts", "t/x.test.ts"] })),
  v.deferFullSuite(lowIn({ touchedRed: new Set(["bun:calc.test.ts"]) })), v.deferFullSuite(lowIn({ tier: "medium" })), v.deferFullSuite(lowIn({ ntf: true })), v.deferFullSuite(lowIn({ settle: true })),
  v.deferFullSuite(lowIn({}), { LOKI_E10_FULL_SUITE_FINAL_ONLY: "0" }), v.deferFullSuite(lowIn({ checks: [{ name: "bun:calc.test.ts", result: "pass" }] }))].join(",");
const S = { name: B.name, cmd: B.cmd, cwd: "." }, rec = (key, result) => ({ ...S, key, check: { name: B.name, cmd: B.cmd, result, duration_s: 40, ...(result === "fail" ? { ids: ["t > a"] } : {}) } });
const r0 = v.reusableRun({ full_suite_runs: [rec(k0, "pass")] }, S, k0), rf = v.reusableRun({ full_suite_runs: [rec(k0, "fail")] }, S, k0);
const carried = v.nextSuiteRuns([rec(k0, "pass")], []), replaced = v.nextSuiteRuns([rec(k0, "pass")], [rec("k9", "fail")]);
if (rf) rf.ids.push("t > b"); const orig = rec(k0, "fail"), again = v.reusableRun({ full_suite_runs: [orig] }, S, k0); if (again) again.ids.push("t > c");
const ru = [r0?.reused === true && r0?.reused_key === k0 && r0?.result === "pass", rf?.result === "fail", v.reusableRun({ full_suite_runs: [rec(k0, "pass")] }, S, "other") === null, v.reusableRun({ stopped_at: "limit", full_suite_runs: [rec(k0, "pass")] }, S, k0) === null,
  v.reusableRun({ full_suite_runs: [rec(k0, "not_run")] }, S, k0) === null, v.reusableRun({ full_suite_runs: [rec(k0, "pass")] }, { ...S, cwd: "packages/a" }, k0) === null, v.reusableRun(undefined, S, k0) === null,
  carried.length === 1 && v.reusableRun({ full_suite_runs: carried }, S, k0)?.reused === true, replaced.length === 1 && replaced[0].key === "k9", orig.check.ids.length === 1].join(",");
const g = d + "/repo"; mkdirSync(g, { recursive: true }); spawnSync("git", ["-C", g, "init", "-q", "-b", "main"]); writeFileSync(g + "/a.txt", "x\n"); spawnSync("git", ["-C", g, "add", "a.txt"]); spawnSync("git", ["-C", g, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "b"]);
const asked = [], ctx = { repoDir: g, baseSha: "HEAD", outputs: () => ({}), tests: { detect: async () => ({ runners: ["bun"], tests: [] }) } }, full = [], np = new Set();
await dp.runFullSuite(ctx, new AbortController().signal, { reuse: (s) => { asked.push(s.cwd); return v.reusableRun({ full_suite_runs: [{ ...rec(k0, "pass"), name: s.name, cmd: s.cmd }] }, s, k0); } }, full, np);
const rf2 = [full.length === 1 && full[0].reused === true && full[0].result === "pass", np.size === 0, asked.join(",") === "."].join(",");
const o = { implement: { exit: "done" }, verify: { checks: [{ name: "bun:calc.test.ts", result: "pass", n: 2 }], verify_scope: "complete", full_suite_deferred: true, not_proven: [v.FULL_SUITE_DEFERRED_NOTE] } };
const lab = se.verdictOf(o, [{ name: "bun:calc.test.ts", cmd: "bun test calc.test.ts", result: "pass", duration_s: 1, provenance: "agent_authored", n: 2 }], false, o.verify.not_proven.length > 0, false, true);
console.log([k1, ds, df, ru, rf2, lab].join(" | "));' 2>&1)"
[ "$G6R" = "true | true,true,true | true,false,true,false,false,false,false,false,false | true,true,true,true,true,true,true,true,true,true | true,true,true | PARTIAL" ] \
    && ok "G6 relief unit: the reuse key moves with any changed content, file, deletion or dependency entry (every changed path in every suite's key); a runner cache does not move the stamp; the suite is deferred at low tier only on a red that feeds the fix round; a result is reused only on an equal key, from a pass or fail, after an unstopped verify, as a copy marked on the check, and a quick verify carries it; runFullSuite pushes it without a NOT PROVEN line; a deferred verify caps the label" \
    || bad "G6 relief unit gave: $G6R"
# G6 RELIEF sysedit cell (machine.ts syseditBroke, plant 7j): with FULL-SUITE-FINAL-ONLY the first low-tier verify ran no suite, so the sysedit re-verify is the
# suite's first run. A suite failing only on base-red ids (pre_red) is not broken by the completion (none); one new id counts every suite id (undo, the
# fail-safe direction); a first verify that was not deferred compares as before (the base-red id it never saw counts).
SXB="$(cd "$ROOT/loki-ts" && bun --no-env-file --config=/dev/null -e '
const m = await import("./src/engine10/machine.ts");
const own = (r) => ({ name: "bun:calc.test.ts", result: r }), suite = (ids) => ({ name: "full suite: bun", result: "fail", ids });
const first = { full_suite_deferred: true, checks: [own("fail")] }, now = (ids) => ({ checks: [own("pass"), suite(ids)], pre_red: ["t > base1", "t > base2"] });
const show = (a) => (a.length ? a.join(",") : "none");
console.log([show(m.syseditBroke(first, now(["t > base1", "t > base2"]))), show(m.syseditBroke(first, now(["t > base1", "t > new"]))), show(m.syseditBroke({ checks: [own("fail")] }, now(["t > base1"])))].join(" | "));' 2>&1)"
[ "$SXB" = "none | full suite: bun t > base1,full suite: bun t > new | full suite: bun t > base1" ] \
    && ok "G6 relief sysedit: after a deferred first verify a suite red only on base keeps the zero-model repair, a new suite id still undoes it, and a non-deferred first verify compares as before" \
    || bad "G6 relief sysedit cell gave: $SXB"
# K2 (engine, low tier): implement leaves the task's test red (wrong), the fix round makes it green (fixit). With FULL-SUITE-FINAL-ONLY on the suite runs once
# (on the final candidate), with it off twice; the first verify's not_proven names the deferred line and the receipt does not. Plant 7h (no deferred line)
# fails the first-verify assertion; plant 7g (defer whatever is red) turns K5 above.
g6r_facts() { python3 -I - "$RUNDIR/events.jsonl" "$RUNDIR/receipt.json" <<'PY'
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1])]
runs = [e for e in ev if e.get("type") == "test.result" and str((e.get("data") or {}).get("name", "")).startswith("full suite") and not (e.get("data") or {}).get("reused")]
ver = [e["data"] for e in ev if e.get("type") == "stage.completed" and "checks" in (e.get("data") or {}) and "verify_scope" in (e.get("data") or {})]
note = "full suite deferred: a targeted check is red"
first = any(str(n).startswith(note) for n in (ver[0].get("not_proven", []) if ver else []))
try: r = json.load(open(sys.argv[2]))
except Exception: r = {}
print(len(runs), first, any(str(n).startswith(note) for n in r.get("not_proven", [])), r.get("verdict"), len(ver))
PY
}
E2E_STUB_FIX=fixit run_engine wrong
f="$(g6r_facts)"; set -- $f
G6R_ON="$4"
[ "$1" = 1 ] && [ "$2" = True ] && [ "$3" = False ] && ok "K2: a low-tier run whose first verify is red runs the full suite once, on the final candidate; the deferred line is on the first verify only" || bad "K2 (FINAL-ONLY on) facts: $f (want: 1 True False <verdict> <verifies>)"
LOKI_E10_FULL_SUITE_FINAL_ONLY=0 E2E_STUB_FIX=fixit run_engine wrong
f="$(g6r_facts)"; set -- $f
[ "$1" = 2 ] && [ "$2" = False ] && [ "$4" = "$G6R_ON" ] && ok "K2: LOKI_E10_FULL_SUITE_FINAL_ONLY=0 runs the suite on both verifies and seals the same label ($4)" || bad "K2 (FINAL-ONLY off) facts: $f (want: 2 False $G6R_ON <verifies>)"
unset -f g6r_facts
# The two runs above are low tier: their seal-time verify runs only bun:calc.test.ts and the npm suite runs in the post-seal deep worker, so suiteSkip never sees
# it (probe e10-20261120T142527Z-fb46: receipt checks [bun:calc.test.ts], the new id only in receipt-addendum-1). Medium tier runs the suite inside verify.
run_pr snstable stable LOKI_RISK_TIER=medium LOKI_PR_DRAFT=1
SNB="$(snote)"
run_pr snnew new LOKI_RISK_TIER=medium LOKI_PR_DRAFT=1
SNN="$(snote)"
[ "$SNB" = "VERIFIED False" ] && ok "G5 skip note: a full suite red only on base ids seals VERIFIED with no fix-round-skipped note holding it" || bad "G5 skip note: base-red-only suite sealed '$SNB' (want VERIFIED False)"
case "$SNN" in "VERIFIED"*) bad "G5 skip note: a suite with a new failing id sealed VERIFIED ($SNN)" ;; *" True") ok "G5 skip note: the same suite with one new failing id is held by the fix-round-skipped note ($SNN)" ;; *) bad "G5 skip note: the new-id suite sealed '$SNN' (want the note to hold it)" ;; esac

# FAILED-PR (2026-11-16, work-ps-1): a FAILED run with committed work opens a labelled draft PR instead of keeping its branch local,
# with the failing checks first in the body and no pending deep-verify status. SECRET-PUSH: the one exception is a security scan
# secret match (here calc.ts:5, a config key the scan's tier 2 matches): nothing is pushed, one line names the file:line and the push
# command, and the receipt carries push_refused plus the same NOT PROVEN line.
run_pr failed none LOKI_RISK_TIER=medium E2E_STUB_MODE=wrong E2E_STUB_FIX=noprogress
f="$(python3 -I - "$RUNDIR" <<'PY'
import json, os, sys
rd = sys.argv[1]
ev = [json.loads(l) for l in open(os.path.join(rd, "events.jsonl")) if l.strip().startswith("{")]
pr = [e for e in ev if e.get("type") == "pr.opened"]
rec = json.load(open(os.path.join(rd, "receipt.json")))
print(rec.get("verdict"), len(pr), bool(pr and pr[0]["data"].get("draft")), sum(e.get("type") == "deep.started" for e in ev), "push_refused" in rec)
PY
)"
[ "$f" = "FAILED 1 True 0 False" ] && ok "FAILED run: a draft PR opened (receipt FAILED, no deep verify, no push refusal)" || { bad "FAILED run facts: $f"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
[ -n "$(git -C "$D/origin.git" rev-parse --verify -q "loki/$(basename "$RUNDIR")")" ] && ok "FAILED run: the run branch was pushed" || bad "FAILED run: loki/<run> is not on the origin"
head -4 "$RUNDIR/pr-body.md" 2>/dev/null | grep -qx '## Failing checks' && grep -qx -- '- bun:calc.test.ts' "$RUNDIR/pr-body.md" && ok "FAILED run: the PR body leads with the failing checks" || bad "FAILED run: pr-body.md does not lead with the failing checks"
has "FAILED run: the receipt comment says no deep-verify status is set" "$OUT" "commit status loki/deep-verify not set (a FAILED run gets no deep verify)"
case "$OUT" in *"stays local (not pushed)"*) bad "FAILED run: the branch-stays-local line printed" ;; *) ok "FAILED run: no branch-stays-local line" ;; esac

run_pr secret none LOKI_RISK_TIER=high E2E_STUB_SECRET=1 E2E_STUB_FIX=noprogress
f="$(python3 -I - "$RUNDIR" <<'PY'
import json, os, sys
rd = sys.argv[1]
ev = [json.loads(l) for l in open(os.path.join(rd, "events.jsonl")) if l.strip().startswith("{")]
rec = json.load(open(os.path.join(rd, "receipt.json")))
print(rec.get("verdict"), sum(e.get("type") == "pr.opened" for e in ev), json.dumps(rec.get("push_refused", {}).get("matches")), any(n.startswith("not pushed: the security scan matched a secret at calc.ts:5") for n in rec.get("not_proven", [])))
sc = next((c for c in rec.get("checks", []) if c.get("name") == "security scan"), {})
print("SCANWHY", json.dumps(sc.get("secret_matches")), sc.get("reason"))
PY
)"
has "secret match: the receipt's failed security scan check records where it matched and why (SCAN-WHY)" "$f" 'SCANWHY ["calc.ts:5"] secret match: calc.ts:5'
f="${f%%$'\n'*}"
[ "$f" = 'FAILED 0 ["calc.ts:5"] True' ] && ok "secret match: no PR, the receipt names calc.ts:5 in push_refused and NOT PROVEN" || { bad "secret match facts: $f"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
[ -z "$(git -C "$D/origin.git" rev-parse --verify -q "loki/$(basename "$RUNDIR")")" ] && ok "secret match: nothing was pushed" || bad "secret match: loki/<run> reached the origin"
[ -n "$(git -C "$REPO" rev-parse --verify -q "loki/$(basename "$RUNDIR")")" ] && ok "secret match: the run branch is kept locally" || bad "secret match: the run branch is gone"
has "secret match: one line names the file:line and the push command" "$OUT" "engine10: run $(basename "$RUNDIR"): not pushed: the security scan matched a secret at calc.ts:5; review it, then push by hand: git push -u origin loki/$(basename "$RUNDIR")"
case "$OUT" in *"ended FAILED with no PR"*) bad "secret match: the no-PR line repeats the refusal" ;; *) ok "secret match: the refusal is not repeated by the no-PR line" ;; esac
grep -q 'q7ZpLm4Rt8' <<< "$OUT" && bad "secret match: the matched text was printed" || ok "secret match: the matched text is never printed"

# Unit: the scan's line location (git -U0 hunks to head lines, bisection over the matcher), the refusal's fail-safe rules, the FAILED title and body, the writeback text.
U="$(cd "$ROOT/loki-ts" && T="$T" bun -e '
const d = await import("./src/engine10/stages/deep.ts"), sr = await import("./src/features/self_review.ts"), s = await import("./src/engine10/stages/seal.ts"), p = await import("./src/engine10/stages/pr.ts"), w = await import("./src/integrations/writeback.ts");
const { mkdirSync, writeFileSync } = await import("node:fs"); const root = process.env.T + "/secline";
mkdirSync(root + "/backend/src/config", { recursive: true });
const cfg = ["import { z } from \"zod\";", "const schema = z.object({", "  ELASTICSEARCH_URL: z.string().optional(),", "  ELASTICSEARCH_API_KEY: z.string().optional(),", "});", "export const search = {", "  url: parsed.data.ELASTICSEARCH_URL,", "    apiKey: \"q7Zp" + "Lm4Rt8Vw2Xy6Bn\",", "};"]; // F1: a quoted literal (an unquoted parsed.data.X in a .ts file is an expression, never a match)
writeFileSync(root + "/backend/src/config/index.ts", cfg.join("\n") + "\n");
console.log("lines=" + JSON.stringify(await d.secretLines(d.DEFAULT_SECRET_SCAN_SH, root, "backend/src/config/index.ts")));
console.log("hunks=" + JSON.stringify(sr.addedLineNumbers("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,0 +4,2 @@\n+a\n+b\n@@ -10 +12 @@\n-old\n+new\n")));
const fail = (m) => ({ checks: [{ name: "security scan", result: "fail", ...(m === undefined ? {} : { secret_matches: m }) }] });
console.log("refuse=" + JSON.stringify(s.secretPushRefusal(fail(["a.ts:3"]), "e10-x")) + " high_only=" + JSON.stringify(s.secretPushRefusal(fail([]), "e10-x")) + " unrecorded=" + JSON.stringify(s.secretPushRefusal(fail(undefined), "e10-x")?.matches) + " pass=" + JSON.stringify(s.secretPushRefusal({ checks: [{ name: "security scan", result: "pass" }] }, "e10-x")));
console.log("title=" + p.prTitle("FAILED", root, "add search", ["security scan"]) + " | " + p.prTitle("FAILED", root, "add search", ["vitest:frontend/src/app/applications/page.test.tsx", "security scan", "lint"]) + " | " + p.prTitle("FAILED", root, "add search") + " | " + p.prTitle("PARTIAL", root, "add search", ["x"]));
console.log("head=" + JSON.stringify(p.failedHead("FAILED", ["security scan"], ["one reviewer"]).split("\n").slice(0, 3)) + " other=" + JSON.stringify(p.failedHead("PARTIAL", ["x"], ["y"])));
console.log("wb=" + JSON.stringify(w.commentText({ phase: "failed", verdict: "FAILED", prUrl: "https://github.com/o/r/pull/9", receiptSha256: null, task: "", reason: "failing: security scan" })));
' 2>&1)"
has "unit: bisection finds the flagged config line (a quoted apiKey literal, line 8 here), not the schema lines" "$U" "lines=[7]"
has "unit: -U0 hunks map added lines to head line numbers" "$U" "hunks=[4,5,12]"
has "unit: a secret match refuses the push with the push command" "$U" 'refuse={"check":"security scan","matches":["a.ts:3"],"command":"git push -u origin loki/e10-x"}'
has "unit: a scan failed only by a secure-scan HIGH finding does not refuse" "$U" "high_only=null"
has "unit: a failed scan that recorded no matches refuses (fail-safe)" "$U" 'unrecorded=["(where it matched was not recorded)"]'
has "unit: a passing scan never refuses" "$U" "pass=null"
has "unit: the FAILED title names the failing check, then how many more" "$U" "title=[FAILED: security scan] add search | [FAILED: vitest:frontend/src/app/applications/... +2] add search | [FAILED] add search | [PARTIAL] add search"
has "unit: the FAILED body leads with the failing checks; other verdicts get none" "$U" 'head=["## Failing checks","This run sealed FAILED: 1 blocking check still fails. Opened as a draft so the committed work is visible; it is not ready to merge until these pass.","- security scan"] other=""'
has "unit: the failed writeback names the draft PR" "$U" 'wb="Loki run failed; its committed work is in draft PR https://github.com/o/r/pull/9.\nReason: failing: security scan"'
# F1 (oc58562, 5 of 5 seeds refused their push): in a source file whose language quotes its string literals, an unquoted tier-2 value that is a dotted
# chain of identifiers with no digit (record.finish.tokens) is a member expression, not a literal; every other unquoted value still counts (Fable's review). Both scanners (autonomy/lib/secret-scan.sh and autonomy/verify.sh, kept in lockstep) read every case; the values are assembled here.
F1D="$T/f1scan"; mkdir -p "$F1D/packages/core/src" "$F1D/svc" "$F1D/conf"; F1V="abcdefghijklmnop$(printf '1234')"; F1H="Q7zp$(printf 'Lm4Rt8')Vw2Xy6Bn"
printf '          const usage = { tokens: record.finish.tokens,\n' > "$F1D/packages/core/src/step.ts"
printf 'export const cfg = { token: "%s" };\n' "$F1V" > "$F1D/packages/core/src/quoted.ts"
printf 'TOKEN=%s\n' "$F1V" > "$F1D/.env"
printf "const apiKey = 'sk-%s';\n" "$(printf 'A1b2C3d4')E5f6G7h8I9j0K1l2" > "$F1D/packages/core/src/sk.ts"
printf 'password = "%s"\n' "$F1H" > "$F1D/svc/db.py"
printf 'token = session.access_token_value\n' > "$F1D/svc/auth.py"
printf 'token: %s\n' "$F1V" > "$F1D/conf/app.yaml"
printf 'package cfg\n\nfunc Load() {\n\ttoken := "%s"\n\t_ = token\n}\n' "$F1H" > "$F1D/svc/cfg.go"
printf 'cmd = "export SECRET_KEY=%s && deploy"\n' "$F1V" > "$F1D/svc/deploy.py"
printf 'const s = "TOKEN=%s";\n' "$F1V" > "$F1D/packages/core/src/envstr.ts"
printf 'const env = `\nAPI_KEY=%s\n`;\n' "$F1V" > "$F1D/packages/core/src/tpl.js"
printf 'def run():\n    """set auth_token=%s"""\n' "$F1V" > "$F1D/svc/doc.py"
printf 'const token = abcdefgh.ijklmnop%s;\n' "$(printf 1)" > "$F1D/packages/core/src/digit.ts"
F1="$(for f in packages/core/src/step.ts packages/core/src/quoted.ts .env packages/core/src/sk.ts svc/db.py svc/auth.py conf/app.yaml svc/cfg.go svc/deploy.py packages/core/src/envstr.ts packages/core/src/tpl.js svc/doc.py packages/core/src/digit.ts; do
  a=no; b=no; bash -c '. "$1"; _commit_scan_secret_file "$2"' _ "$ROOT/autonomy/lib/secret-scan.sh" "$F1D/$f" && a=hit
  bash -c '. "$1" >/dev/null 2>&1; verify_secret_scan_file "$2"' _ "$ROOT/autonomy/verify.sh" "$F1D/$f" && b=hit
  printf '%s=%s/%s ' "$f" "$a" "$b"; done)"
has "F1: the oc58562 line (tokens: record.finish.tokens, unquoted in a .ts file) is not a secret, in both scanners" "$F1" "packages/core/src/step.ts=no/no "
has "F1: an unquoted member chain in a .py file (session.access_token_value) is not a secret, in both scanners" "$F1" "svc/auth.py=no/no "
has "F1: a quoted token literal in a .ts file is still a secret, in both scanners" "$F1" "packages/core/src/quoted.ts=hit/hit "
has "F1: a high-entropy quoted password in a .py file is still a secret, in both scanners" "$F1" "svc/db.py=hit/hit "
has "F1: a .env KEY=value is still a secret, in both scanners" "$F1" ".env=hit/hit "
has "F1: an unquoted value in a config file is still a secret, in both scanners" "$F1" "conf/app.yaml=hit/hit "
has "F1: an sk- key in single quotes is still a secret, in both scanners" "$F1" "packages/core/src/sk.ts=hit/hit "
has "F1: a Go short declaration of a quoted literal (token := \"...\") is a secret, in both scanners (missed before F1)" "$F1" "svc/cfg.go=hit/hit "
has "F1: KEY=value inside a quoted shell command in a .py file is still a secret, in both scanners" "$F1" "svc/deploy.py=hit/hit "
has "F1: TOKEN=value inside a quoted string in a .ts file is still a secret, in both scanners" "$F1" "packages/core/src/envstr.ts=hit/hit "
has "F1: API_KEY=value on a template literal line in a .js file is still a secret, in both scanners" "$F1" "packages/core/src/tpl.js=hit/hit "
has "F1: auth_token=value in a .py docstring is still a secret, in both scanners" "$F1" "svc/doc.py=hit/hit "
has "F1: an unquoted dotted value with a digit is still a secret, in both scanners" "$F1" "packages/core/src/digit.ts=hit/hit "

# ---- DELIVER-WHAT-EXISTS begin (2026-11-17): a run that produced a change never ends with "PR: none" -------------------------------------------
# Every way a run ends other than the user cancelling it, a usage-limit pause (resumable by design) and a security-scan secret match (the one
# deliberate exception, above) leaves the change committed on loki/<run> and, in pull request mode, a DRAFT pull request whose body leads with the
# honest state: what is done, what is open, why the run stopped and the command to continue. Legs (local bare origin, stub provider):
#   blocked:  the fix session answers LOKI_SPEC_CONFLICT with implement's change in the tree (outcome BLOCKED): a draft PR opens, the branch is pushed,
#             the body leads with the one question and `loki answer <run> --text`, then what is done; no deep verify starts; the run branch stays
#             local so the answer resumes on it.
#   unsealed: the engine worker is killed while the fix sits in a stash (no commit stage, no receipt): the run-end commit holds the fix, a draft PR
#             opens on it, and the body leads with "stopped before it finished", the reason and the command that runs the task again.
#   costcap:  the cost cap is reached after implement: the sealed PARTIAL run opens a draft PR whose body says why the run stopped and how to go on.
#   unit:     no draft for a failed, blocked or unfinished run is titled or labelled as mergeable: every title carries its bracket, the label is
#             always "loki: needs you" (never the green one), and the rule is one function (LOKI_E10_DELIVER_UNSEALED=0 restores the old rule).
# Planted defects (each reverted afterwards; run from source):
#   DWa. e10ext/commit_filter.ts deliverAsDraft: return verdict === "FAILED" && sealed (the old rule); blocked and unsealed read no PR and no pushed branch.
#   DWb. engine10/stages/pr.ts stateHead: return ""; the three bodies lose their leading state section.
#   DWc. engine10/stages/pr.ts prTitle: no bracket for SPEC_CONFLICT; the unit's title check fails (a blocked draft would read as a plain title).
#   DWd. engine10/stages/pr.ts lokiLabelFor: the green label for any verdict that is not FAILED; the unit's label check fails.
#   DWe. util/base_guard.ts finishRunBranch: drop the answerable test; blocked loses its local run branch after the push.
#   DWf. engine10/supervisor.ts: start the deep verify for a SPEC_CONFLICT draft again (drop deepAfterPr); blocked reads deep.started 1.
#   DWg. engine10/stages/seal.ts measuredConflictOf namedFile: return false (condition c); the measured leg reads FAILED (rebuild dist).
run_dw() { # [DW_ARGS="<loki flags>"] run_dw <label> [env...] -> D, REPO, OUT, RC, RUNDIR: run_pr without the deep-verify waits (none of these runs starts one)
    local label="$1"; shift
    D="$T/dw-$label"; REPO="$D/repo"; mkdir -p "$D"
    git init -q --bare -b main "$D/origin.git"
    cp -R "$FIX/repo" "$REPO"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e
    git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add calc.ts calc.test.ts bunfig.toml
    git -C "$REPO" commit -q -m base
    git -C "$REPO" remote add origin "$D/origin.git"
    git -C "$REPO" push -q origin main
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u GH_TOKEN -u GITHUB_TOKEN \
        -u LOKI_REVIEW_PROVIDER -u LOKI_REVIEW_DEFAULT -u LOKI_XVENDOR_DEFAULT -u LOKI_RISK_TIER -u LOKI_PR_DRAFT \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" GH_CONFIG_DIR="$D/ghcfg" \
        E2E_STUB_MODE=done E2E_STUB_LOG="$D/stub.log" E2E_STUB_USAGE=10 LOKI_RECEIPT_SIGNING_KEY_FILE="$D/k.pem" "$@" \
        ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$TASK" ${DW_ARGS:-} 2>&1)"; RC=$?
    RUNDIR="$(ls -d "$REPO"/.loki/runs/e10-* 2>/dev/null | head -1)"
}
dw_facts() { # -> "<run.completed verdict> <receipt sealed> <pr.opened> <draft> <deep.started> <branch on origin> <first heading of the PR body>"
    python3 -I - "$RUNDIR" "$D/origin.git" <<'PY'
import json, os, subprocess, sys
rd, origin = sys.argv[1], sys.argv[2]
ev = [json.loads(l) for l in open(os.path.join(rd, "events.jsonl")) if l.strip().startswith("{")]
done = [e for e in ev if e.get("type") == "run.completed"]
pr = [e for e in ev if e.get("type") == "pr.opened"]
pushed = subprocess.run(["git", "-C", origin, "rev-parse", "--verify", "-q", "loki/" + os.path.basename(rd)], capture_output=True).returncode == 0
try: head = next(l.strip() for l in open(os.path.join(rd, "pr-body.md")) if l.startswith("## "))
except Exception: head = "(no body)"
print(done[-1]["data"].get("verdict") if done else None, os.path.exists(os.path.join(rd, "receipt.json")), len(pr), bool(pr and pr[0]["data"].get("draft")),
      sum(e.get("type") == "deep.started" for e in ev), pushed, "|", head)
PY
}
dw_body_has() { grep -qF -- "$1" "$RUNDIR/pr-body.md" 2>/dev/null; }

run_dw blocked LOKI_RISK_TIER=medium E2E_STUB_MODE=wrong E2E_STUB_FIX=conflict LOKI_E10_MEASURED_LABELS=0 # the stub's claim is not measured (the full suite blames the change): =0 keeps this leg on the draft plumbing; the measured leg follows
f="$(dw_facts)"; rid="$(basename "$RUNDIR")"
[ "$f" = "SPEC_CONFLICT True 1 True 0 True | ## Loki needs one answer" ] && ok "blocked run with a change: a draft PR opened on the pushed branch, its body leads with the question, no deep verify" || { bad "blocked run facts: $f (rc $RC)"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
dw_body_has "calc.test.ts:7 expects multiply(3, 4) to be 12" && dw_body_has "loki answer $rid --text" && ok "blocked run: the body states the question and the command that answers it" || bad "blocked run: the body lacks the question or 'loki answer $rid --text'"
dw_body_has "## What is done" && [ "$(grep -n '^## ' "$RUNDIR/pr-body.md" | sed -n '2p' | cut -d: -f2-)" = "## What is done" ] && ok "blocked run: what is done comes right after the question" || bad "blocked run: second heading is '$(grep '^## ' "$RUNDIR/pr-body.md" | sed -n '2p')'"
[ -n "$(git -C "$REPO" rev-parse --verify -q "loki/$rid")" ] && [ "$(git -C "$REPO" rev-parse "loki/$rid")" = "$(git -C "$D/origin.git" rev-parse "loki/$rid")" ] && ok "blocked run: the run branch stays local (the answer resumes on it) and equals the pushed one" || bad "blocked run: local loki/$rid is gone or differs from the origin"
grep -Eq '^PR:[[:space:]]+none' <<< "$OUT" && bad "blocked run: the summary says PR: none while a change exists" || ok "blocked run: the summary never says PR: none"
[ "$RC" -eq 4 ] && grep -Eq '^Outcome:[[:space:]]+BLOCKED' <<< "$OUT" && ok "blocked run: outcome and exit code are unchanged (BLOCKED, 4)" || bad "blocked run: rc $RC, $(grep '^Outcome' <<< "$OUT")"
# blocked, measured (MEASURED-LABELS on, the default): implement writes a right multiply() and changes add(), so the multiply Wall (red on base) passes,
# calc.test.ts and the full suite pass on base and fail on head, and the fix session's conflict names calc.test.ts. Loki measured the conflict, so the
# user gets the answer path exactly as before: SPEC_CONFLICT, a draft PR leading with the question and `loki answer`, BLOCKED, exit 4. The blocked
# leg above runs with =0 (its stub claim is not measured). Plant DWg: seal.ts namedFile returns false (this leg reads FAILED, not SPEC_CONFLICT).
run_dw measured LOKI_RISK_TIER=medium E2E_STUB_MODE=breakadd E2E_STUB_FIX=conflict E2E_STUB_WALL=multiply LOKI_E10_WALL=1 LOKI_E10_WALL_ON_LEAN=1
f="$(dw_facts)"; rid="$(basename "$RUNDIR")"
[ "$f" = "SPEC_CONFLICT True 1 True 0 True | ## Loki needs one answer" ] && dw_body_has "loki answer $rid --text" && [ "$RC" -eq 4 ] && grep -Eq '^Outcome:[[:space:]]+BLOCKED' <<< "$OUT" \
    && ok "measured conflict (rule on): SPEC_CONFLICT, a draft PR on the pushed branch leading with the question and 'loki answer $rid --text', BLOCKED, exit 4" \
    || { bad "measured conflict (rule on): facts $f, rc $RC, $(grep '^Outcome' <<< "$OUT")"; printf '%s\n' "$OUT" | tail -20; }

run_dw unsealed E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit E2E_STUB_STASH=fix E2E_STUB_STASH_THEN=killworker E2E_STUB_STASH_MARK="$T/dw-unsealed.mark"
f="$(dw_facts)"; rid="$(basename "$RUNDIR")"
[ "$f" = "FAILED False 1 True 0 True | ## This run stopped before it finished" ] && ok "unsealed run (worker killed, no receipt): a draft PR opened on the pushed branch, its body leads with the stop" || { bad "unsealed run facts: $f (rc $RC)"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
git -C "$D/origin.git" show "loki/$rid:calc.ts" 2>/dev/null | grep -q 'return a \* b;' && ok "unsealed run: the pushed branch holds the fix that sat in the stash" || bad "unsealed run: the pushed branch does not hold the fix"
dw_body_has 'loki start "<the same task>"' && dw_body_has "No receipt was sealed" && dw_body_has "## What is done" && dw_body_has "## What is open" && ok "unsealed run: the body says nothing is proven, what is done, what is open and the command to continue" || bad "unsealed run: the body lacks the resume command, the no-receipt line or a state section"
grep -Eq '^PR:[[:space:]]+none' <<< "$OUT" && bad "unsealed run: the summary says PR: none while a change exists" || ok "unsealed run: the summary never says PR: none"
grep -Eq '^Outcome:[[:space:]]+FAILED' <<< "$OUT" && ok "unsealed run: the outcome is unchanged (FAILED)" || bad "unsealed run: $(grep '^Outcome' <<< "$OUT")"

DW_ARGS="--max-cost 0.015" run_dw costcap LOKI_E10_PLAN=1 # the metered stub: plan costs $0.01, implement takes the run past the cap
f="$(dw_facts)"
case "$f" in "PARTIAL True 1 True "*) ok "cost cap reached after implement: the sealed PARTIAL run opened a draft PR" ;; *) bad "cost cap run facts: $f (rc $RC)"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /' ;; esac
dw_body_has "## Why the run stopped" && dw_body_has "cost/time cap reached" && dw_body_has "--max-cost" && ok "cost cap run: the body says why the run stopped and how to continue" || bad "cost cap run: the body lacks the stop section, the reason or the --max-cost command"
git -C "$D/origin.git" show "loki/$(basename "$RUNDIR"):calc.ts" 2>/dev/null | grep -q multiply && ok "cost cap run: the pushed branch holds implement's change" || bad "cost cap run: the pushed branch has no multiply()"

U="$(cd "$ROOT/loki-ts" && T="$T" bun -e '
const p = await import("./src/engine10/stages/pr.ts"), cf = await import("./src/e10ext/commit_filter.ts");
const root = process.env.T + "/dw-unit"; (await import("node:fs")).mkdirSync(root, { recursive: true });
const V = ["FAILED", "SPEC_CONFLICT", "PARTIAL", "ALREADY_SATISFIED"];
console.log("titles=" + [p.prTitle("SPEC_CONFLICT", root, "add search"), p.prTitle("FAILED", root, "add search"), p.prTitle("PARTIAL", root, "add search"), p.prTitle("VERIFIED", root, "add search")].join(" | "));
console.log("labels=" + V.map((v) => p.lokiLabelFor(v).name).join(",") + " verified=" + p.lokiLabelFor("VERIFIED").name);
console.log("rule=" + [cf.deliverAsDraft("FAILED", true), cf.deliverAsDraft("FAILED", false), cf.deliverAsDraft("SPEC_CONFLICT", true), cf.deliverAsDraft("VERIFIED", true), cf.deliverAsDraft("PARTIAL", true), cf.deliverAsDraft("ALREADY_SATISFIED", true)].join(",")
  + " off=" + [cf.deliverAsDraft("FAILED", true, { LOKI_E10_DELIVER_UNSEALED: "0" }), cf.deliverAsDraft("FAILED", false, { LOKI_E10_DELIVER_UNSEALED: "0" }), cf.deliverAsDraft("SPEC_CONFLICT", true, { LOKI_E10_DELIVER_UNSEALED: "0" })].join(","));
console.log("deep=" + ["VERIFIED", "PARTIAL", "FAILED", "SPEC_CONFLICT"].map((v) => cf.deepAfterPr(v)).join(","));
const blocked = p.stateHead({ verdict: "SPEC_CONFLICT", sealed: true, runId: "e10-x", question: "which rounding mode?", reason: "spec conflict: which rounding mode?", next: "", done: ["2 files changed"], open: ["a"] }).split("\n");
const unsealed = p.stateHead({ verdict: "FAILED", sealed: false, runId: "e10-x", question: null, reason: "engine ended before sealing a receipt", next: "loki start o/r#7", done: ["1 file changed"], open: [] }).split("\n");
console.log("head=" + JSON.stringify([blocked[0], blocked.includes("loki answer e10-x --text \"<your decision>\""), unsealed[0], unsealed.includes("loki start o/r#7"), unsealed.some((l) => l.includes("not ready to merge")), blocked.some((l) => l.includes("not ready to merge"))]));
console.log("none=" + JSON.stringify([p.stateHead({ verdict: "VERIFIED", sealed: true, runId: "e10-x", question: null, reason: "", next: "", done: [], open: [] }), p.stateHead({ verdict: "FAILED", sealed: true, runId: "e10-x", question: null, reason: "", next: "", done: [], open: [] })]));
' 2>&1)"
has "unit: every draft title of a failed, blocked or partial run carries its bracket; only a VERIFIED title is plain" "$U" "titles=[NEEDS ANSWER] add search | [FAILED] add search | [PARTIAL] add search | add search"
has "unit: the green label is set for VERIFIED only; failed, blocked, partial and unfinished runs get loki: needs you" "$U" "labels=loki: needs you,loki: needs you,loki: needs you,loki: needs you verified=loki: safe to merge"
has "unit: a FAILED run (sealed or not) and a SPEC_CONFLICT run are delivered as drafts; LOKI_E10_DELIVER_UNSEALED=0 restores the sealed-FAILED-only rule" "$U" "rule=true,true,true,false,false,false off=true,false,false"
has "unit: a deep verify starts after a VERIFIED or PARTIAL pull request only" "$U" "deep=true,true,false,false"
has "unit: the state section leads with the question and its answer command, or with the stop, and says the draft is not ready to merge" "$U" 'head=["## Loki needs one answer",true,"## This run stopped before it finished",true,true,true]'
has "unit: a VERIFIED body and a sealed FAILED body with no stop get no state section (their existing heads lead)" "$U" 'none=["",""]'
# ---- DELIVER-WHAT-EXISTS end ----------------------------------------------------------------------------------------------------------------------

# Unit: every risk tier plans at most the one pre-seal reviewer, and the receipt credits "one reviewer" only from it.
# The unconfigured same-vendor review stays on for high risk and is opt-in for medium (LOKI_REVIEW_DEFAULT=1, xreview.ts reviewDefaultOn).
# The run start sits 60s back: readRiskRecord ignores a record older than the run, and a same-millisecond start raced it on Linux CI.
unit_review() { (cd "$ROOT/loki-ts" && env -u LOKI_REVIEW_PROVIDER -u LOKI_XVENDOR_DEFAULT "$@" bun -e '
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs"), { join } = require("node:path");
const x = await import("./src/engine10/stages/xreview.ts"), cr = await import("./src/util/check_result.ts");
const out = [];
for (const tier of ["low", "medium", "high"]) {
  const d = mkdtempSync(join(process.argv[1], "u-")); mkdirSync(join(d, ".loki", "state"), { recursive: true });
  writeFileSync(join(d, ".loki", "state", "risk-tier.json"), JSON.stringify({ tier }));
  out.push(`${tier}=${x.reviewExtraLimitS({ repoDir: d, provider: "claude", capS: 3600, startedAtMs: Date.now() - 60000, clock: { now: () => Date.now() } }) > 0 ? 1 : 0}`);
}
out.push(`block=${x.minVerdict("VERIFIED", { provider: "claude", level: "block", notes: [] })}`, `flag=${x.minVerdict("VERIFIED", { provider: "claude", level: "flag", notes: ["n"] })}`);
const risk = { tier: "high", checks_selected: ["targeted tests", "one reviewer"], checks_deferred: ["one reviewer"] };
out.push(`gapsReviewed=${cr.deepGaps(risk, [], [], true).notProven.join("|") || "-"}`, `gapsNot=${cr.deepGaps(risk, [], [], false).notProven.join("|") || "-"}`, `council=${cr.DEEP_ITEMS.includes("council")}`);
console.log(out.join(" "));
' "$T" 2>&1); }
U="$(unit_review LOKI_REVIEW_DEFAULT=1)"
[ "$U" = "low=0 medium=1 high=1 block=PARTIAL flag=VERIFIED gapsReviewed=- gapsNot=one reviewer council=false" ] \
    && ok "unit: reviewer planned on medium and high only, BLOCK caps at PARTIAL, one reviewer credited only by a run review" || bad "unit gave: $U"
U="$(unit_review -u LOKI_REVIEW_DEFAULT)"
case "$U" in "low=0 medium=0 high=1 "*) ok "unit: with no reviewer configured and no LOKI_REVIEW_DEFAULT, only the high tier plans a review session" ;; *) bad "unit (default) gave: $U" ;; esac

# EXP-0010: parallel attempts after a red first attempt. The stub (mode attempts) writes a wrong multiply() in every session except the one in
# the attempt worktree B<E2E_STUB_RIGHT>; E2E_STUB_FIX=noprogress keeps the primary's fix round red so the extra attempts run. Real bun test, real pytest, real vitest.
# CASCADE-V0 (LOKI_E10_CASCADE_V0, default off): the Wall is the oracle. A Wall test that fails on the first candidate (Haiku) starts ONE more attempt on the next
# LOKI_E10_ATTEMPT_MODELS entry (haiku,sonnet by default), before any fix round, and its brief carries the Wall's failing output. No other red cascades.
cas_ev() { python3 -I -c '
import json, sys
for l in open(sys.argv[1]):
    e = json.loads(l)
    if e["type"] == "attempts.selected": d = e["data"]; c = d.get("cascade") or {}; print("winner=%s total=%s trigger=%s to=%s" % (d.get("winner"), d.get("total"), c.get("trigger"), c.get("to"))); break
else: print("none")
' "$RUNDIR/events.jsonl" 2>/dev/null; }
cas_brief() { grep -l "The previous attempt at this task failed these acceptance tests" "$T"/cas.prompt.* 2>/dev/null | head -1; }
E2E_STUB_RIGHT=1 E2E_STUB_WALL=multiply E2E_STUB_PROMPT_LOG="$T/cas.prompt" LOKI_SESSION_MODEL=haiku LOKI_E10_CASCADE_V0=1 run_engine attempts
c="$(cas_ev)"
case "$c" in "winner=x1 total=2 trigger=wall to=claude-sonnet"*) ok "cascade: a failing Wall test on the Haiku candidate starts one Sonnet attempt, which wins ($c)" ;; *) bad "cascade: attempts.selected '$c' (outcome $(outcome))"; printf '%s\n' "$OUT" | tail -6 | sed 's/^/    | /' ;; esac
[ "$(outcome)" = "VERIFIED" ] && ok "cascade: the winning attempt's tree seals VERIFIED" || bad "cascade: outcome '$(outcome)'"
[ -n "$(cas_brief)" ] && grep -q "loki_wall_multiply" "$(cas_brief)" && ok "cascade: the retry brief carries the Wall's failing output" || bad "cascade: no implement prompt carried the Wall failure"
rm -f "$T"/cas.prompt*
E2E_STUB_WALL=multiply E2E_STUB_LINTBAD=1 LOKI_SESSION_MODEL=haiku LOKI_E10_CASCADE_V0=1 run_engine done
[ "$(cas_ev)" = "none" ] && ok "cascade: a red that is not the Wall (a lint error) never cascades" || bad "cascade: a lint-only red cascaded ($(cas_ev))"
E2E_STUB_RIGHT=1 E2E_STUB_WALL=multiply E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku run_engine attempts
[ "$(cas_ev)" = "none" ] && ok "cascade: off by default (no LOKI_E10_CASCADE_V0): no extra attempt" || bad "cascade: ran with the flag unset ($(cas_ev))"

# CASCADE-V0 must-haves. (1) The calc fixture is a lean task (small, a relevant visible test): the Wall still runs with LOKI_E10_WALL=1, and plan is not forced.
# (2) A pre-implement snapshot that fails (a 1 KB size ceiling) no longer drops the oracle under the flag: the Wall runs on a fresh base checkout, said on NOT PROVEN.
wall_facts() { python3 -I - "$RUNDIR/events.jsonl" "$RUNDIR/receipt.json" <<'PY'
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip().startswith("{")]
w = [e for e in ev if e.get("stage") == "wall" and e["type"] in ("stage.completed", "stage.failed", "stage.skipped")]
p = [e["type"] for e in ev if e.get("stage") == "plan" and e["type"] in ("stage.completed", "stage.skipped")]
d = (w[-1].get("data") or {}) if w else {}
try: rec = json.load(open(sys.argv[2]))
except Exception: rec = {}
np = " ".join(rec.get("not_proven", []))
print(w[-1]["type"] if w else "none", len(d.get("files") or []), d.get("base_checkout", "-"), "fresh-note" if "fresh checkout of the base commit" in np else "no-note", p[0] if p else "none", "oracle" if "wall_oracle" in rec else "no-oracle")
PY
}
E2E_STUB_WALL=multiply LOKI_E10_WALL=1 LOKI_E10_WALL_ON_LEAN=1 E2E_PLAN=auto run_engine done
f="$(wall_facts)"; set -- $f
[ "$1" = stage.completed ] && [ "$2" -ge 1 ] && [ "$5" = stage.skipped ] && [ "$6" = oracle ] && ok "lean path: LOKI_E10_WALL=1 runs the Wall on a lean task without forcing plan, and the receipt prices it ($f)" || bad "lean path wall facts: $f"
E2E_STUB_WALL=multiply E2E_PLAN=auto run_engine done
f="$(wall_facts)"; set -- $f
[ "$1" != stage.completed ] || [ "$2" = 0 ] && ok "lean path: with no Wall switch the lean task still skips the Wall ($f)" || bad "lean path default: the Wall ran ($f)"
E2E_STUB_WALL=multiply LOKI_E10_CASCADE_V0=1 LOKI_E10_WALL_SNAPSHOT_MAX_MB=0.000001 run_engine done
f="$(wall_facts)"; set -- $f
[ "$1" = stage.completed ] && [ "$3" = fresh ] && [ "$4" = fresh-note ] && ok "snapshot fallback: with the flag, a failed snapshot runs the Wall on a fresh base checkout, named on NOT PROVEN ($f)" || bad "snapshot fallback facts: $f"
E2E_STUB_WALL=multiply LOKI_E10_WALL=1 LOKI_E10_WALL_ON_LEAN=1 LOKI_E10_WALL_SNAPSHOT_MAX_MB=0.000001 run_engine done
f="$(wall_facts)"; set -- $f
[ "$1" = stage.failed ] && ok "snapshot fallback: without the cascade flag a failed snapshot still fails the Wall stage, as before ($f)" || bad "snapshot no-flag facts: $f"

# VERIFY-PLAN V3 WALL OBSERVE (LOKI_E10_WALL=observe; unset stays off). The Wall author writes and seals its tests, observeWall moves the record under observe_*
# keys and takes the files out of the checkout, a complete verify runs the sealed copies last (wall_observe), and seal writes an observe entry when they would
# change the label. W1 agrees (done), W2 disagrees (multiply adds, and the base calc.test.ts no longer calls multiply, so today's label is not FAILED), W2off is
# the same run with the Wall off, W3 is enforce. Plants (each reverted): observeWall keeps `files` (W1 wall.files non-empty); observeWall does not remove the
# installed files (W1/W2 a loki_wall file in the checkout or in an implement prompt); runObservedWall pushes into checks (W2 label moves); the seal block
# applies `would` to the label (W2 label FAILED); wallMode reads observe as enforce (W1 wall.files non-empty, W4); observeWall leaves wallSealed set (W6).
wobs_facts() { python3 -I - "$RUNDIR/events.jsonl" "$RUNDIR/receipt.json" "$REPO" <<'PY'
import json, sys, os, subprocess
ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip().startswith("{")]
vd = [e.get("data") or {} for e in ev if e.get("stage") == "verify" and e["type"] == "stage.completed"]
v = vd[-1] if vd else {}
try: rec = json.load(open(sys.argv[2]))
except Exception: rec = {}
wo = (v.get("wall_observe") or {}).get("files") or []
obs = [o for o in rec.get("observe") or [] if o.get("rule") == "LOKI_E10_WALL"]
left = [f for f in os.listdir(sys.argv[3]) if f.startswith("loki_wall")]
tree = subprocess.run(["git", "-C", sys.argv[3], "ls-tree", "-r", "--name-only", "HEAD"], capture_output=True, text=True).stdout.split()
print(rec.get("verdict"), "files=%d" % len(rec.get("wall", {}).get("files") or []), "obs=" + ",".join(f["result"] for f in wo) if wo else "obs=none",
      "entry=" + (obs[0]["would_label"] if obs else "none"), "left=%d" % len(left), "committed=%d" % sum(1 for t in tree if "loki_wall" in t),
      "disclosed" if any(n.startswith("Wall (observe):") and n.endswith("(disclosed, does not cap)") for n in rec.get("not_proven") or []) else "undisclosed")
PY
}
wobs_prep() { # W2: the base calc.test.ts stops calling multiply, so a wrong multiply() is caught by the Wall only
    python3 -I -c 'import sys; p = sys.argv[1] + "/calc.test.ts"; s = open(p).read(); open(p, "w").write("".join(l for l in s.splitlines(True) if "multiply" not in l))' "$1"
    git -C "$1" add calc.test.ts; git -C "$1" commit -q --amend -m base
}
E2E_STUB_WALL=multiply LOKI_E10_WALL=observe LOKI_E10_WALL_ON_LEAN=1 run_engine done
w1="$(wobs_facts)"
[ "$w1" = "VERIFIED files=0 obs=pass entry=none left=0 committed=0 disclosed" ] && ok "V3 W1: observe on a right change: VERIFIED as with the Wall off, no Wall files on the receipt, the observed Wall passed, no entry, nothing left in the checkout or committed ($w1)" || bad "V3 W1 gave: $w1"
E2E_PREP=wobs_prep E2E_STUB_WALL=multiply LOKI_E10_WALL=0 run_engine wrong; w2off="$(outcome)"
rm -f "$T"/wobs.prompt*; E2E_PREP=wobs_prep E2E_STUB_WALL=multiply E2E_STUB_PROMPT_LOG="$T/wobs.prompt" LOKI_E10_WALL=observe LOKI_E10_WALL_ON_LEAN=1 run_engine wrong
w2="$(wobs_facts)"; w2o="$(outcome)"
case "$w2" in *" files=0 obs=fail entry=FAILED left=0 committed=0 disclosed") [ "$w2o" = "$w2off" ] && [ "$w2o" != FAILED ] && ok "V3 W2: observe on a wrong change: the label is the Wall-off label ($w2o), the observed Wall failed and the receipt says it would be FAILED ($w2)" || bad "V3 W2: label $w2o, Wall-off label $w2off ($w2)" ;; *) bad "V3 W2 gave: $w2 (Wall-off label $w2off)" ;; esac
! grep -qs 'loki_wall' "$T"/wobs.prompt.implement* && ok "V3 W2: no implement or fix brief names a loki_wall file" || bad "V3 W2: an implement or fix brief named the observed Wall file"
E2E_PREP=wobs_prep E2E_STUB_WALL=multiply LOKI_E10_WALL=1 LOKI_E10_WALL_ON_LEAN=1 run_engine wrong
w3="$(wobs_facts) $(python3 -I -c 'import json, sys; ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip().startswith("{")]; w = [e for e in ev if e.get("stage") == "wall" and e["type"] == "stage.completed"]; print("wallran=%d" % len((w[-1].get("data") or {}).get("files") or []) if w else "wallran=none")' "$RUNDIR/events.jsonl")"
case "$w3" in "PARTIAL files=0 obs=none entry=none left=0 committed=0 undisclosed wallran=1") grep -q 'wall test discarded: loki_wall_multiply.test.ts (only Loki' <<< "$OUT" && ok "V3 W3: LOKI_E10_WALL=1 is today's Wall: it runs, its red test is set aside as a Wall-only failure (PARTIAL), and nothing is observed ($w3)" || bad "V3 W3: no Wall-only set-aside line ($w3)" ;; *) bad "V3 W3 gave: $w3" ;; esac
W46="$(cd "$ROOT/loki-ts" && bun -e '
import { wallMode } from "./src/engine10/sizing.ts"; import { observeWall } from "./src/engine10/stages/wall.ts";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
const m = (e: Record<string, string>) => wallMode(e as never);
console.log("W4", [m({}), m({ LOKI_E10_WALL: "observe" }), m({ LOKI_E10_WALL: " Observe " }), m({ LOKI_E10_WALL: "1" }), m({ LOKI_E10_WALL: "0" }), m({ LOKI_E10_CASCADE_V0: "1" }), m({ LOKI_E10_CASCADE_V0: "1", LOKI_E10_WALL: "0" }), m({ LOKI_E10_CASCADE_V0: "1", LOKI_E10_WALL: "observe" })].join(","));
const d = mkdtempSync(join(tmpdir(), "w6-")), f = join(d, "loki_wall_x.test.ts"); writeFileSync(f, "x");
const r = { status: "completed", data: { files: [{ path: f, sha256: "s" }], readOnlyFiles: [{ path: f }], base_run: { pass: 0, fail: 1 }, not_proven: ["n"], iteration_ids: ["i"] } } as never;
const c1 = { wallSealed: true }, o1 = observeWall(c1, r, { LOKI_E10_WALL: "observe" } as never) as { status: string; data: Record<string, unknown> };
console.log("W6o", c1.wallSealed, o1.status, o1.data.observe, "files" in o1.data, "not_proven" in o1.data, existsSync(f), JSON.stringify(o1.data.observe_base_run));
writeFileSync(f, "x"); const c2 = { wallSealed: true }, o2 = observeWall(c2, r, {} as never);
console.log("W6u", c2.wallSealed, o2 === r, existsSync(f));
const c3 = { wallSealed: true }, o3 = observeWall(c3, { status: "failed", data: {}, reason: "boom" } as never, { LOKI_E10_WALL: "observe" } as never) as { status: string; data: Record<string, unknown> };
console.log("W6f", o3.status, o3.data.observe_status, o3.data.observe_reason);
rmSync(d, { recursive: true, force: true });
' 2>&1)"
has "V3 W4: wallMode reads observe in any case, 1 and cascade v0 as enforce, 0 and unset as off, and observe wins over cascade v0" "$W46" "W4 off,observe,observe,enforce,off,enforce,off,observe"
has "V3 W6: in observe mode observeWall clears wallSealed, moves the record under observe_* keys, drops files and not_proven, removes the installed file" "$W46" 'W6o false completed true false false false {"pass":0,"fail":1}'
has "V3 W6: with the knob unset observeWall leaves wallSealed set and the record untouched" "$W46" "W6u true true true"
has "V3 W6: a failed Wall in observe mode is recorded and never fails the run" "$W46" "W6f completed failed boom"

# VERIFY-PLAN V6 REPLAN (LOKI_E10_REPLAN, off by default; LOKI_E10_REPLAN_MAX default 1, 0 allows none). At a stalled fix loop that no designed stop already
# decided, one more fix round runs in a fresh session past the round cap, with a STEP BACK block (the earlier rounds' own summaries and the class-of-failure
# sentence) in place of the ESCALATED ROUND paragraph. E2E_STUB_FIX=stepback fixes multiply() only from a STEP BACK brief. Plants (each reverted): replanDue
# ignores the knob (R2 gains an event); the fix stage keeps the cap for a replan (R1 STALLED); fixChain keeps the old session id (R1b); buildFixBrief drops the
# STEP BACK block (R5, R1 STALLED); the block sits beside ESCALATED ROUND instead of replacing it (R5); replanMax read through posEnv (R4); replanDue drops the
# wallOnly (R6), suiteOnly (R7) or fixExit (R8) test; stopped not reset after a moving replan (R1c reads STALLED; a green replan reads VERIFIED either way).
rp_facts() { python3 -I - "$RUNDIR/events.jsonl" "$RUNDIR/receipt.json" <<'PY'
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip().startswith("{")]
rp = [e for e in ev if e["type"] == "loop.repeat" and (e.get("data") or {}).get("reason", "").startswith("re-plan:")]
fx = [e.get("data") or {} for e in ev if e.get("stage") == "fix" and e["type"] == "stage.completed"]
try: rec = json.load(open(sys.argv[2]))
except Exception: rec = {}
last = ((fx[-1].get("fix_rounds") or [{}])[-1]) if fx else {}
print(rec.get("verdict"), "replans=%d" % len(rp), "lastreplan=%s" % bool(last.get("replan")), "diagnoses=%s" % any("diagnoses" in d for d in fx))
PY
}
rp_brief() { python3 -I -c 'import sys; t = open(sys.argv[1]).read() if __import__("os").path.exists(sys.argv[1]) else ""; seg = t.split("The previous Fast verify run failed.")[-1] if "STEP BACK." in t else ""; print("stepback" if "STEP BACK." in seg else "nostep", "carried" if "stub fix: kept the add approach" in seg else "notcarried", "escalated" if "ESCALATED ROUND" in seg else "clean")' "$T/rp.prompt.implement0"; }
rm -f "$T"/rp.prompt*; E2E_STUB_FIX=stepback E2E_STUB_PROMPT_LOG="$T/rp.prompt" LOKI_E10_REPLAN=1 run_engine wrong
r1="$(rp_facts) $(rp_brief) $(outcome)"
[ "$r1" = "VERIFIED replans=1 lastreplan=True diagnoses=True stepback carried clean VERIFIED" ] && ok "V6 R1: a stalled fix loop re-plans once in a fresh round whose STEP BACK brief carries the earlier summary and no ESCALATED ROUND; it fixes multiply() and the run is VERIFIED ($r1)" || bad "V6 R1 gave: $r1 (outcome $(outcome))"
E2E_STUB_FIX=stepbackhalf LOKI_E10_REPLAN=1 run_engine wrong
r1c="$(rp_facts) $(outcome)"
case "$r1c" in *" replans=1 "*" FAILED") ok "V6 R1c: a replan round that moves but leaves a failure ends the stall: the run is labeled from its tree (FAILED), not STALLED ($r1c)" ;; *) bad "V6 R1c gave: $r1c" ;; esac
E2E_STUB_FIX=stepback run_engine wrong
r2="$(rp_facts) $(outcome)"
[ "$r2" = "FAILED replans=0 lastreplan=False diagnoses=False STALLED" ] && ok "V6 R2: with the knob unset the stall ends as today (STALLED, receipt FAILED), no re-plan event and no diagnoses key ($r2)" || bad "V6 R2 gave: $r2"
LOKI_E10_REPLAN=1 run_engine wrong
r3="$(rp_facts) $(outcome)"
case "$r3" in *" replans=1 "*" STALLED") ok "V6 R3: a replan that does not move leaves the run STALLED after exactly one re-plan ($r3)" ;; *) bad "V6 R3 gave: $r3" ;; esac
RPU="$(cd "$ROOT/loki-ts" && bun -e '
import { replanDue, replanMax, replanOn } from "./src/engine10/types.ts"; import { buildFixBrief, fixChain, stepBackBlock } from "./src/engine10/stages/fix.ts";
const prior = { fix: { session_id: "s-fix", model: "m-fix" }, implement: { session_id: "s-imp", model: "m-imp" } } as never;
console.log("R1b", JSON.stringify(fixChain(prior, true, "m-act", "m-run")), JSON.stringify(fixChain(prior, false, "m-act", "m-run")), JSON.stringify(fixChain({} as never, false, "m-act", "m-run")));
const st = { replans: 0, roundsRan: 1, fatal: false, capHit: false, stopped: "stalled", stillRounds: 0, failures: true, wallOnly: false, suiteOnly: false, fixExit: undefined, implementExit: "done", verifyStoppedAt: undefined };
const on = { LOKI_E10_REPLAN: "1" }, due = (o: object, e: object = on) => replanDue({ ...st, ...o } as never, e as never);
console.log("R4", replanMax({ LOKI_E10_REPLAN_MAX: "0" } as never), due({}, { ...on, LOKI_E10_REPLAN_MAX: "0" }), replanMax({} as never), replanMax({ LOKI_E10_REPLAN_MAX: "x" } as never), replanMax({ LOKI_E10_REPLAN_MAX: "2" } as never), due({ replans: 1 }, { ...on, LOKI_E10_REPLAN_MAX: "2" }));
console.log("R6", due({}), due({ wallOnly: true }), "R7", due({ suiteOnly: true }), "R8", due({ fixExit: "spec_conflict" }), "R9", due({ stopped: null, stillRounds: 0 }), due({ stopped: null, stillRounds: 1 }), "off", due({}, {}), replanOn({ LOKI_E10_REPLAN: "yes" } as never));
const g = [{ signature: "bun:calc.test.ts", count: 1, sample: "expected 12 got 7" }] as never;
const sb = buildFixBrief("t", g, "diff", { priorDiagnosis: "d", stepBack: ["a", "b"] });
console.log("R5", sb.includes(stepBackBlock(["a", "b"])), sb.includes("1. a") && sb.includes("2. b"), sb.includes("Fix the whole class of each failure"), !sb.includes("ESCALATED ROUND"));
const esc = buildFixBrief("t", g, "diff", { priorDiagnosis: "d" }), none = buildFixBrief("t", g, "diff", undefined);
console.log("R5b", esc.includes("ESCALATED ROUND: the same failure repeated after your previous fix. Re-read the full failure output above, find the root cause, and do not repeat the earlier approach.\nYour previous diagnosis: d"), !esc.includes("STEP BACK"), !none.includes("ESCALATED ROUND") && !none.includes("STEP BACK"));
' 2>&1)"
has "V6 R1b: fixChain starts a replan round fresh on the round's model, and keeps today's chain otherwise" "$RPU" 'R1b {"sessionId":null,"model":"m-act"} {"sessionId":"s-fix","model":"m-fix"} {"sessionId":null,"model":"m-run"}'
has "V6 R4: LOKI_E10_REPLAN_MAX 0 allows none, unset and garbage read 1, 2 allows a second" "$RPU" "R4 0 false 1 1 2 true"
has "V6 R6 to R9: a stalled state re-plans; a Wall-only, full-suite-only or spec-conflict stop, a last round that moved, or the knob off never does" "$RPU" "R6 true false R7 false R8 false R9 false true off false true"
has "V6 R5: a replan brief carries both summaries numbered and the class sentence, in place of the ESCALATED ROUND paragraph" "$RPU" "R5 true true true true"
has "V6 R5: without stepBack the ESCALATED ROUND paragraph is today's text, and an ordinary brief has neither block" "$RPU" "R5b true true true"

# VERIFY-PLAN V8 FLAKY QUARANTINE (LOKI_E10_FLAKY_QUARANTINE, off by default; observe keeps the per-repo list and reports, enforce applies it). A flaky test the
# change did not touch is run three times on the base tree; one pass and one fail there quarantines it in ~/.loki/cache/v10/<repo key>/flaky-quarantine.json
# (each engine cell below gets its own HOME). The fixture's flaky.test.ts flips on a counter in $T, on the base too; headonly.test.ts fails once, on its first
# run with multiply() present (head), and always passes on base. Plants (each reverted): quarantine a check that flips only on head (Q4b quarantined); quarantine the change's own edited test file (Qc); drop the
# deadline guard (Q5); keep the `not run:` line under enforce (Q3 enforce); observe applies to the label (Q3 observe reads VERIFIED); pruneQuarantine never
# removes (Q2); default read as observe (Q3 off runs base commands).
q_prep() { # q_prep <repo>: a flaky test the change never touches, committed in the base
    local ctr="$T/q.ctr"; rm -f "$ctr"
    printf 'import { expect, test } from "bun:test";\nimport { add } from "./calc";\nimport { existsSync, readFileSync, writeFileSync } from "node:fs";\nconst p = "%s", n = existsSync(p) ? Number(readFileSync(p, "utf8")) : 0;\nwriteFileSync(p, String(n + 1));\ntest("flaky", () => {\n  expect(add(1, 1)).toBe(2);\n  expect((n + 1) %% 2).toBe(0);\n});\n' "$ctr" > "$1/flaky.test.ts"
    git -C "$1" add flaky.test.ts; git -C "$1" commit -q --amend -m base; rm -f "$ctr"
}
q_prep_head() { # q_prep_head <repo>: a test that flips only once multiply() exists (head), stable on base
    local ctr="$T/q.ctr"; rm -f "$ctr"
    printf 'import { expect, test } from "bun:test";\nimport * as calc from "./calc";\nimport { existsSync, writeFileSync } from "node:fs";\nconst p = "%s", first = "multiply" in calc && !existsSync(p);\nif (first) writeFileSync(p, "1");\ntest("head only", () => {\n  expect(calc.add(1, 1)).toBe(2);\n  expect(first).toBe(false);\n});\n' "$ctr.head" > "$1/headonly.test.ts"
    git -C "$1" add headonly.test.ts; git -C "$1" commit -q --amend -m base; rm -f "$ctr" "$ctr.head"
}
q_facts() { python3 -I - "$RUNDIR/events.jsonl" "$RUNDIR/receipt.json" "$1" <<'PY'
import json, sys, glob
ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip().startswith("{")]
vd = [e.get("data") or {} for e in ev if e.get("stage") == "verify" and e["type"] == "stage.completed"]
v = vd[-1] if vd else {}
try: rec = json.load(open(sys.argv[2]))
except Exception: rec = {}
np = rec.get("not_proven") or []
lst = [json.load(open(p)) for p in glob.glob(sys.argv[3] + "/.loki/cache/v10/*/flaky-quarantine.json")]
ent = [o["would_label"] for o in rec.get("observe") or [] if o.get("rule") == "LOKI_E10_FLAKY_QUARANTINE"]
print(rec.get("verdict"), "q=" + ",".join(v.get("flaky_quarantine") or []), "base=" + ",".join("%s:%d/%d" % (k, b["pass"], b["fail"]) for k, b in (v.get("flaky_base") or {}).items()),
      "list=" + ",".join(sorted(k for d in lst for k in d)), "entry=" + (ent[0] if ent else "none"),
      "notrun" if any(n.startswith("not run: ") and "flaky.test.ts" in n for n in np) else "no-notrun",
      "disclosed" if any(n.startswith("quarantined flaky test: bun:flaky.test.ts") and n.endswith("(disclosed, does not cap)") for n in np) else "undisclosed")
PY
}
q_run() { local h="$T/qhome-$1"; shift; rm -rf "$h"; mkdir -p "$h"; HOME="$h" LOKI_E10_LOW_TIER_FULL_SUITE=0 run_engine done "$@"; }
E2E_PREP=q_prep LOKI_E10_FLAKY_QUARANTINE=observe q_run obs; qo="$(q_facts "$T/qhome-obs")"; qo_n="$(cat "$T/q.ctr")"
[ "$qo" = "PARTIAL q=bun:flaky.test.ts base=bun:flaky.test.ts:1/2 list=bun:flaky.test.ts entry=VERIFIED notrun undisclosed" ] && ok "V8 Q4/Q3 observe: an untouched test that flips on head and on base is quarantined in the per-repo list; the label stays PARTIAL and the receipt says it would be VERIFIED ($qo)" || bad "V8 Q4/Q3 observe gave: $qo"
E2E_PREP=q_prep LOKI_E10_FLAKY_QUARANTINE=enforce q_run enf; qe="$(q_facts "$T/qhome-enf")"
[ "$qe" = "VERIFIED q=bun:flaky.test.ts base=bun:flaky.test.ts:1/2 list=bun:flaky.test.ts entry=none no-notrun disclosed" ] && ok "V8 Q3 enforce: the quarantined test is left out of the label (VERIFIED), disclosed, and has no 'not run:' open item ($qe)" || bad "V8 Q3 enforce gave: $qe"
E2E_PREP=q_prep q_run off; qf="$(q_facts "$T/qhome-off")"; qf_n="$(cat "$T/q.ctr")"
[ "$qf" = "PARTIAL q= base= list= entry=none notrun undisclosed" ] && [ "$((qo_n - qf_n))" = 3 ] && ok "V8 Q3/Q4 off (default): PARTIAL as today, no list, no entry, and no base run (the counter shows 3 fewer runs than observe: $qo_n vs $qf_n)" || bad "V8 Q3/Q4 off gave: $qf (counter observe $qo_n, off $qf_n)"
E2E_PREP=q_prep_head LOKI_E10_FLAKY_QUARANTINE=observe q_run head; qh="$(q_facts "$T/qhome-head") $(python3 -I -c 'import json, sys; ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip().startswith("{")]; v = [e["data"] for e in ev if e.get("stage") == "verify" and e["type"] == "stage.completed"][-1]; print("flaky=" + ",".join(c["name"] for c in v["checks"] if c["result"] == "flaky"))' "$RUNDIR/events.jsonl")"
case "$qh" in "PARTIAL q= base= list= "*" flaky=bun:headonly.test.ts") ok "V8 Q4b: a test that flips only on the change passes three times on base and is never quarantined (a real regression is not hidden) ($qh)" ;; *) bad "V8 Q4b gave: $qh" ;; esac
QU="$(cd "$ROOT/loki-ts" && bun -e '
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
import { pruneQuarantine, readQuarantine, writeQuarantine, QUARANTINE_CLEAN_RUNS } from "./src/util/failure_memory.ts"; import { flakyCandidates, flakyOnBase } from "./src/engine10/stages/verify.ts";
const d = mkdtempSync(join(tmpdir(), "q1-")), e = { first_run: "r1", last_run: "r1", base: "1 pass, 2 fail of 3 on the base commit", clean: 0 };
writeQuarantine(d, { "bun:a.test.ts": e }); const back = readQuarantine(d);
writeFileSync(join(d, "flaky-quarantine.json"), "{not json"); const bad = readQuarantine(d);
writeFileSync(join(d, "flaky-quarantine.json"), JSON.stringify({ "bun:a.test.ts": e, "bun:b.test.ts": { first_run: "r1", base: "x", clean: 0 } })); const part = readQuarantine(d);
console.log("Q1", JSON.stringify(back) === JSON.stringify({ "bun:a.test.ts": e }), JSON.stringify(bad), Object.keys(part).join(","));
let q = { "bun:a.test.ts": e } as Record<string, typeof e>;
for (let i = 0; i < QUARANTINE_CLEAN_RUNS; i++) q = pruneQuarantine(q, ["bun:a.test.ts"], [], {}, "r" + (i + 2));
const r = pruneQuarantine({ "bun:a.test.ts": { ...e, clean: 2 } }, [], ["bun:a.test.ts"], {}, "r9"), n = pruneQuarantine({}, [], [], { "bun:n.test.ts": "2 pass, 1 fail of 3 on the base commit" }, "r5");
console.log("Q2", JSON.stringify(q), r["bun:a.test.ts"]!.clean, r["bun:a.test.ts"]!.last_run, JSON.stringify(n["bun:n.test.ts"]));
const c = (name: string) => ({ name, result: "flaky" }), opts = { wall: new Set(["bun:loki_wall_x.test.ts"]), target: new Set(["bun:task.test.ts"]), changed: ["edited.test.ts"], testNames: new Set(["bun:untouched.test.ts", "bun:edited.test.ts", "bun:task.test.ts", "bun:loki_wall_x.test.ts", "bun:held.test.ts"]), hold: (x: { name: string }) => x.name === "bun:held.test.ts" };
console.log("Qc", flakyCandidates([c("bun:untouched.test.ts"), c("bun:edited.test.ts"), c("bun:task.test.ts"), c("bun:loki_wall_x.test.ts"), c("bun:held.test.ts"), c("full suite: bun test"), { name: "bun:untouched.test.ts", result: "fail" }], opts).map((x) => x.name).join(","), "end");
let ran = 0; const now = 1_000_000, run = async () => { ran++; return { ok: true, cut: false, missing: false, out: "1 pass\n0 fail\nRan 1 tests across 1 files." }; };
const near = await flakyOnBase(run, now + 1000, () => now), ranNear = ran, far = await flakyOnBase(run, now + 60_000, () => now);
console.log("Q5", near, ranNear, JSON.stringify(far));
rmSync(d, { recursive: true, force: true });
' 2>&1)"
has "V8 Q1: the quarantine list round-trips; corrupt JSON reads empty; an entry missing a field is dropped" "$QU" "Q1 true {} bun:a.test.ts"
has "V8 Q2: three clean first-try passes remove an entry; a flaky run resets clean; a new name is added with its base text" "$QU" 'Q2 {} 0 r9 {"first_run":"r5","last_run":"r5","base":"2 pass, 1 fail of 3 on the base commit","clean":0}'
has "V8 Qc: only an untouched test check is a candidate (never the change's edited file, a task-named test, the Wall, holdout or a full suite)" "$QU" "Qc bun:untouched.test.ts end"
has "V8 Q5: with the deadline inside the suite margin no base run is made and nothing can be quarantined; with time left it runs three times" "$QU" 'Q5 null 0 {"pass":3,"fail":0,"not_run":0}'

# VERIFY-PLAN V10 CHECKLIST (LOKI_E10_CHECKLIST, observe by default). A tracked .loki-checklist.json read only from the base commit; an item fires when the diff
# matches its trigger. K4 runs the engine on the stub with a base checklist whose forbid_added item fires on the multiply() line the done change adds.
# Plants (each reverted): read the working-tree file instead of the base (K3 edit cell); fire on context lines (K1); an invalid regex matches everything (K3);
# enforce writes no check (K4 enforce reads VERIFIED); observe changes the label (K4 observe); a cmd failure that also fails on base counted as fail (K5);
# cmd items run with the knob unset (K5 cmdOn cell); read tracked diffs only, no new-file branch in addedLines (K6 new-file cell reads pass and fires none); read the whole tracked file (K6 old.sh reads old.sh:1 and four lines).
k_prep() { # k_prep <repo>: a base checklist that forbids adding an exported multiply
    printf '{"version": 1, "items": [{"id": "no-multiply", "trigger": {"paths": ["*.ts"]}, "check": {"forbid_added": "export function multiply"}, "why": "stub", "taught_by": "k4"}]}\n' > "$1/.loki-checklist.json"
    git -C "$1" add .loki-checklist.json; git -C "$1" commit -q --amend -m base
}
k_facts() { python3 -I -c 'import json, sys
r = json.load(open(sys.argv[1]))
np = r.get("not_proven") or []
e = [o["would_label"] for o in r.get("observe") or [] if o.get("rule") == "LOKI_E10_CHECKLIST"]
line = [n for n in np if n.startswith("checklist item no-multiply failed:")]
print(r["verdict"], "entry=" + (e[0] if e else "none"), ("line-observe" if line[0].endswith("(observe mode: disclosed, does not cap)") else "line-enforce") if line else "no-line", "checkfail" if any(c["name"] == "checklist" and c["result"] == "fail" for c in r["checks"]) else "nocheck")' "$RUNDIR/receipt.json" 2>&1; }
E2E_PREP=k_prep run_engine done; k_obs="$(k_facts)"
E2E_PREP=k_prep LOKI_E10_CHECKLIST=enforce run_engine done; k_enf="$(k_facts)"
E2E_PREP=k_prep LOKI_E10_CHECKLIST=0 run_engine done; k_off="$(k_facts)"
[ "$k_obs" = "VERIFIED entry=FAILED line-observe nocheck" ] && ok "V10 K4 observe (default): the label stays VERIFIED, the receipt says it would be FAILED and lists the item as a disclosed line ($k_obs)" || bad "V10 K4 observe gave: $k_obs"
[ "$k_enf" = "FAILED entry=none line-enforce checkfail" ] && ok "V10 K4 enforce: a failing item is a failing check named checklist and the label is FAILED ($k_enf)" || bad "V10 K4 enforce gave: $k_enf"
[ "$k_off" = "VERIFIED entry=none no-line nocheck" ] && ok "V10 K4 off: no item is read ($k_off)" || bad "V10 K4 off gave: $k_off"
KG="$(mktemp -d "$T/k3.XXXXXX")"; git -C "$KG" init -q -b main; git -C "$KG" config user.name t; git -C "$KG" config user.email t@example.invalid
printf '{"version": 1, "items": [{"id": "base-item", "trigger": {}, "check": {"forbid_added": "x"}, "why": "w", "taught_by": "t"}]}\n' > "$KG/.loki-checklist.json"; printf 'a\n' > "$KG/f.txt"
git -C "$KG" add -A; git -C "$KG" commit -q -m base; KB="$(git -C "$KG" rev-parse HEAD)"
printf '{"version": 1, "items": [{"id": "edited-item", "trigger": {}, "check": {"forbid_added": "x"}, "why": "w", "taught_by": "t"}]}\n' > "$KG/.loki-checklist.json"
KN="$(mktemp -d "$T/k3n.XXXXXX")"; git -C "$KN" init -q -b main; git -C "$KN" config user.name t; git -C "$KN" config user.email t@example.invalid; printf 'a\n' > "$KN/f.txt"; git -C "$KN" add -A; git -C "$KN" commit -q -m base; KNB="$(git -C "$KN" rev-parse HEAD)"
printf '{"version": 1, "items": []}\n' > "$KN/.loki-checklist.json"
KJ="$(mktemp -d "$T/k3j.XXXXXX")"; git -C "$KJ" init -q -b main; git -C "$KJ" config user.name t; git -C "$KJ" config user.email t@example.invalid
printf '{not json\n' > "$KJ/.loki-checklist.json"; git -C "$KJ" add -A; git -C "$KJ" commit -q -m bad; KJB="$(git -C "$KJ" rev-parse HEAD)"
printf '{"version": 1, "items": [{"id": "r", "trigger": {"added": "("}, "check": {"forbid_added": "x"}, "why": "w", "taught_by": "t"}]}\n' > "$KJ/.loki-checklist.json"; git -C "$KJ" add -A; git -C "$KJ" commit -q -m badre; KJR="$(git -C "$KJ" rev-parse HEAD)"
KA="$(mktemp -d "$T/k6.XXXXXX")"; git -C "$KA" init -q -b main; git -C "$KA" config user.name t; git -C "$KA" config user.email t@example.invalid
printf 'grep -q base\na\nb\n' > "$KA/old.sh"; git -C "$KA" add -A; git -C "$KA" commit -q -m base; KAB="$(git -C "$KA" rev-parse HEAD)"
printf 'grep -q base\na\nb\ngrep -q x\n' > "$KA/old.sh"; printf 'echo hi\ncurl -s z\ngrep -q y\n' > "$KA/new.sh"; printf 'grep -q outside\n' > "$T/k6-outside.sh"; ln -s "$T/k6-outside.sh" "$KA/link.sh"
KU="$(cd "$ROOT/loki-ts" && bun -e '
import { addedLines, checklistCmdOn, firedItems, readChecklist, runChecklist } from "./src/features/checklist.ts";
const [kg, kb, kn, knb, kj, kjb, kjr, ka, kab] = process.argv.slice(1);
const it = (id: string, trigger: object, check: object) => ({ id, trigger, check, why: "w", taught_by: "t" }) as never;
const added: Record<string, string[]> = { "src/a.ts": ["const x = 1;", "grep -q ok proof"], "lib/deep/b.ts": ["y"], "docs/c.md": ["z"] }, al = (f: string) => added[f] ?? [];
const names = (xs: { id: string }[]) => xs.map((x) => x.id).join(",") || "none";
console.log("K1", names(firedItems([it("glob-hit", { paths: ["src/*.ts"] }, {}), it("glob-miss", { paths: ["test/*.ts"] }, {}), it("deep", { paths: ["lib/**/*.ts"] }, {}), it("added-hit", { paths: ["src/*.ts"], added: "grep -q" }, {}), it("context-only", { paths: ["src/*.ts"], added: "never added" }, {}), it("any", {}, {})], Object.keys(added), al)), "end");
const fa = it("no-grep-q", { paths: ["src/*.ts"] }, { forbid_added: "grep -q" }), no = async () => ({ ok: true, cut: false, missing: false, out: "" });
const k2 = await runChecklist([fa], al, { cmdOn: false, changed: ["src/a.ts"], lineNo: (f, i) => [10, 11][i], run: no, runBase: async () => null });
const k2b = await runChecklist([fa], (f) => (f === "src/a.ts" ? ["const x = 1;"] : []), { cmdOn: false, changed: ["src/a.ts"], run: no, runBase: async () => null });
console.log("K2", k2[0].result, k2[0].detail.includes("src/a.ts:11"), k2b[0].result);
console.log("K3", names(readChecklist(kg, kb).items), names(readChecklist(kn, knb).items), readChecklist(kn, knb).problem ?? "noproblem", names(readChecklist(kj, kjb).items), readChecklist(kj, kjb).problem ? "problem" : "noproblem", readChecklist(kj, kjr).problem ? "re-problem" : "re-ok", "end");
const ci = it("cmd", {}, { cmd: "false" });
let runs = 0, bases = 0; const r = (ok: boolean) => async () => { runs++; return { ok, cut: false, missing: false, out: "" }; }, b = (v: boolean | null) => async () => { bases++; return v === null ? null : { ok: v, cut: false, missing: false, out: "" }; };
const c0 = await runChecklist([ci], al, { cmdOn: false, changed: [], run: r(false), runBase: b(true) }); const c0runs = runs;
const c1 = await runChecklist([ci], al, { cmdOn: true, changed: [], run: r(false), runBase: b(true) });
const c2 = await runChecklist([ci], al, { cmdOn: true, changed: [], run: r(false), runBase: b(false) });
const c3 = await runChecklist([ci], al, { cmdOn: true, changed: [], run: r(false), runBase: b(null) });
bases = 0; const c4 = await runChecklist([ci], al, { cmdOn: true, changed: [], run: r(true), runBase: b(true) });
console.log("K5", c0[0].result, c0runs, c1[0].result, c2[0].result, c2[0].detail.includes("fails on the base commit too"), c3[0].result, c3[0].detail.startsWith("not compared"), c4[0].result, bases);
console.log("K5c", checklistCmdOn({} as never), checklistCmdOn({ LOKI_E10_CHECKLIST: "observe" } as never), checklistCmdOn({ LOKI_E10_CHECKLIST: "0" } as never));
const ch = ["old.sh", "new.sh", "link.sh"], alg = (f: string) => addedLines(ka, kab, f).lines;
const k6 = await runChecklist([it("no-grep-q-old", { paths: ["old.sh"] }, { forbid_added: "grep -q" }), it("no-grep-q-new", { paths: ["new.sh"] }, { forbid_added: "grep -q" })], alg, { cmdOn: false, changed: ch, lineNo: (f, i) => addedLines(ka, kab, f).nos[i], run: no, runBase: async () => null });
console.log("K6", k6[0].result, k6[0].detail.includes("old.sh:4: grep -q x"), JSON.stringify(addedLines(ka, kab, "old.sh")), k6[1].result, k6[1].detail.includes("new.sh:3: grep -q y"), names(firedItems([it("trig-new", { paths: ["*.sh"], added: "curl -s" }, { forbid_added: "x" })], ch, alg)), JSON.stringify(addedLines(ka, kab, "new.sh").nos), alg("link.sh").length, "end");
' "$KG" "$KB" "$KN" "$KNB" "$KJ" "$KJB" "$KJR" "$KA" "$KAB" 2>&1)"
has "V10 K1 firedItems: a path glob hit and miss, ** across directories, an added-line regex on added lines only (a context-only pattern never fires), and no paths fires on any file" "$KU" "K1 glob-hit,deep,added-hit,any end"
has "V10 K2 forbid_added: an added matching line fails naming file:line; the same text on an unchanged line passes" "$KU" "K2 fail true pass"
has "V10 K3 readChecklist: the base commit's file is read and a working-tree edit ignored; a file only in the change reads as none; bad JSON and a bad regex are problems, never a throw" "$KU" "K3 base-item none noproblem none problem re-problem end"
has "V10 K5 cmd: not run without the knob (never run); fails on head and passes on base fails; fails on both is not run; no base tree is not run; passes on head never runs base" "$KU" "K5 not_run 0 fail not_run true not_run true pass 0"
has "V10 K5 checklistCmdOn: unset false, observe true, 0 false" "$KU" "K5c false true false"
has "V10 K6 addedLines (real git): a modified tracked file fails at its diff line; an untracked file the change creates counts every line as added (fails at new.sh:3, a trigger.added item fires on it, lines numbered 1-3 with no phantom trailing line); an untracked symlink is never read" "$KU" 'K6 fail true {"lines":["grep -q x"],"nos":[4]} fail true trig-new [1,2,3] 0 end'
# K7 one reader: the -U0 hunk numbering and the per-file added-lines read live only in features/self_review.ts (cold review of V10). Plant (reverted): a hunk
# loop copied back into checklist.ts, or addedLineNumbers defined again in deep.ts, reads "K7 dup".
k7_defs="$(grep -rl 'function addedLineNumbers' "$ROOT/loki-ts/src" | sed "s#^$ROOT/##" | tr '\n' ' ')"
if [ "$k7_defs" = "loki-ts/src/features/self_review.ts " ] && ! grep -qE '"diff"|@@' "$ROOT/loki-ts/src/features/checklist.ts" && grep -q 'addedLinesOf' "$ROOT/loki-ts/src/features/checklist.ts" && ! grep -q 'stages/deep' "$ROOT/loki-ts/src/features/checklist.ts"; then k7="K7 one"; else k7="K7 dup ($k7_defs)"; fi
[ "$k7" = "K7 one" ] && ok "V10 K7: addedLineNumbers is defined once (features/self_review.ts); checklist.ts reads added lines through addedLinesOf, runs no diff of its own and never imports deep.ts" || bad "V10 K7 gave: $k7"

# VERIFY-PLAN V11 CASCADE-INTRODUCED (LOKI_E10_CASCADE_INTRODUCED, off by default, only with LOKI_E10_CASCADE_V0=1): the cascade also starts on a failure the
# calibrated verify attributes to the change (closure.ts failureClasses), and the next attempt's brief carries check-failures.txt under its own lead. The Wall is
# off (LOKI_E10_WALL=0), so the Wall oracle cannot start it. Plants (each reverted): cascadeIntroducedOn ignores CASCADE_V0 (X3 starts an attempt); machine
# reads pre_existing instead of introduced (X1 no attempt); the introduced tail uses CASCADE_LEAD (X1 brief).
x_att() { python3 -I -c 'import json, sys
n = [json.loads(l) for l in open(sys.argv[1]) if l.strip().startswith("{")]
s = [e for e in n if e["type"] == "attempts.selected"]
print("attempts=%s" % ((s[0].get("data") or {}).get("total") if s else "none"))' "$RUNDIR/events.jsonl"; }
x_brief() { python3 -I -c 'import sys, glob
t = "".join(open(p).read() for p in glob.glob(sys.argv[1] + ".*"))
print("lead" if "The previous attempt at this task left these checks failing, and Loki attributes them to the change." in t else "nolead", "oldlead" if "The previous attempt at this task failed these acceptance tests" in t else "noold", "tail" if "calc.test.ts" in t.split("Loki attributes them to the change. Their failing output:")[-1] else "notail")' "$T/x.prompt"; }
rm -f "$T"/x.prompt*; E2E_STUB_PROMPT_LOG="$T/x.prompt" LOKI_E10_CASCADE_V0=1 LOKI_E10_WALL=0 LOKI_E10_CASCADE_INTRODUCED=1 LOKI_SESSION_MODEL=haiku run_engine wrong; x1="$(x_att) $(x_brief)"
[ "$x1" = "attempts=2 lead noold tail" ] && ok "V11 X1: with cascade v0 and the knob, an introduced failure starts one more attempt whose brief carries check-failures.txt under its own lead, not the Wall's ($x1)" || bad "V11 X1 gave: $x1"
LOKI_E10_CASCADE_V0=1 LOKI_E10_WALL=0 LOKI_SESSION_MODEL=haiku run_engine wrong; x2="$(x_att)"
[ "$x2" = "attempts=none" ] && ok "V11 X2: with the knob unset nothing cascades without a Wall failure (today)" || bad "V11 X2 gave: $x2"
LOKI_E10_WALL=0 LOKI_E10_CASCADE_INTRODUCED=1 LOKI_SESSION_MODEL=haiku run_engine wrong; x3="$(x_att)"
[ "$x3" = "attempts=none" ] && ok "V11 X3: the knob without LOKI_E10_CASCADE_V0 starts nothing" || bad "V11 X3 gave: $x3"
XU="$(cd "$ROOT/loki-ts" && bun -e '
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
import { cascadeIntroducedTail } from "./src/features/attempts.ts"; import { cascadeIntroducedOn } from "./src/util/wall_knobs.ts";
const d = mkdtempSync(join(tmpdir(), "x4-")), body = "a".repeat(1000) + "b".repeat(6000); writeFileSync(join(d, "check-failures.txt"), body);
const t = cascadeIntroducedTail(d), e = mkdtempSync(join(tmpdir(), "x4e-"));
console.log("X4", t?.length, t === body.slice(-6000), cascadeIntroducedTail(e), cascadeIntroducedOn({ LOKI_E10_CASCADE_INTRODUCED: "1" } as never), cascadeIntroducedOn({ LOKI_E10_CASCADE_INTRODUCED: "1", LOKI_E10_CASCADE_V0: "1" } as never));
rmSync(d, { recursive: true, force: true }); rmSync(e, { recursive: true, force: true });
' 2>&1)"
has "V11 X4: cascadeIntroducedTail keeps the last 6000 characters and reads null for a missing file; the knob needs cascade v0" "$XU" "X4 6000 true null false true"

att_ev() { python3 -I -c '
import json, sys
for l in open(sys.argv[1]):
    e = json.loads(l)
    if e["type"] == "attempts.selected": d = e["data"]; print("winner=%s total=%s early=%s launched=%s" % (d.get("winner"), d.get("total"), d.get("early_accept"), d.get("launched"))); break
else: print("none")
' "$RUNDIR/events.jsonl" 2>/dev/null; }
E2E_STUB_RIGHT=2 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 run_engine attempts
[ "$(outcome)" = "VERIFIED" ] && ok "attempts (bun test): the first attempt is wrong, attempt 2 is right: the run is VERIFIED" || { bad "attempts (bun test): outcome '$(outcome)', not VERIFIED"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
[ "$(att_ev)" = "winner=x2 total=3 early=True launched=2" ] && ok "attempts (bun test): the receipt journal names attempt 2 as the winner of 3 total attempts (2 extra), early accept ($(att_ev))" || bad "attempts (bun test): attempts.selected is '$(att_ev)'"
git -C "$REPO" show HEAD:calc.ts | grep -A1 'function multiply' | grep -q 'a \* b' && ok "attempts (bun test): the committed multiply() is the right one" || bad "attempts (bun test): the committed calc.ts holds the wrong multiply()"
[ "$(verify_run)" = "0 VERIFIED" ] && ok "attempts (bun test): loki verify agrees ($(verify_run))" || bad "attempts (bun test): loki verify says '$(verify_run)'"
att_rc() { python3 -I -c 'import json,sys; a=json.load(open(sys.argv[1])).get("attempts"); print("none" if a is None else "%d|%s" % (len(a), a[-1]))' "$RUNDIR/receipt.json" 2>/dev/null; }
case "$(att_rc)" in *"|selected attempt 3 (x2) of "*" scored (3 requested): early accept"*) ok "attempts (bun test): the signed receipt records every attempt and the selection reason ($(att_rc))" ;; *) bad "attempts (bun test): receipt attempts is '$(att_rc)'" ;; esac
[ "$(git -C "$REPO" worktree list | wc -l | tr -d ' ')" = 1 ] && ok "attempts (bun test): no worktree registration is left in the repo" || bad "attempts (bun test): git worktree list shows a leftover"

E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 run_engine attempts
[ "$(outcome)" = "FAILED" ] && ok "attempts (bun test): every attempt wrong: the repo's checks stay red, so the run is FAILED (a red check is never PARTIAL or VERIFIED)" || { bad "attempts (bun test): all wrong gave outcome '$(outcome)'"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
case "$(att_ev)" in winner=*" total=3 early=False launched=2") ok "attempts (bun test): all wrong: the best partial is kept without an early accept ($(att_ev))" ;; *) bad "attempts (bun test): all-wrong attempts.selected is '$(att_ev)'" ;; esac
git -C "$REPO" show HEAD:calc.ts | grep -q 'export function multiply' && ok "attempts (bun test): all wrong: the best partial is on loki/<run>" || bad "attempts (bun test): all wrong: no partial on loki/<run>"

fix_rounds() { grep -c '"type":"fix.round"' "$RUNDIR/events.jsonl" 2>/dev/null; }
# EXP-0010 early: LOKI_E10_ATTEMPTS_EARLY=1 runs the attempts before any fix round (Haiku only) and skips the fix rounds when one goes green.
E2E_STUB_RIGHT=1 LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS_EARLY=1 run_engine attempts
[ "$(outcome)" = "VERIFIED" ] && [ "$(att_ev)" = "winner=x1 total=2 early=True launched=1" ] && [ "$(fix_rounds)" = 0 ] && ok "attempts early: a wrong first attempt, a right second: VERIFIED with no fix round ($(att_ev))" || { bad "attempts early: outcome '$(outcome)', attempts '$(att_ev)', fix rounds '$(fix_rounds)'"; printf '%s\n' "$OUT" | tail -6 | sed 's/^/    | /'; }
E2E_STUB_RIGHT=2 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 run_engine attempts
[ "$(att_ev)" != none ] && [ "$(fix_rounds)" -ge 1 ] && ok "attempts early: without the switch the fix round runs first ($(fix_rounds) round(s)), then the attempts" || bad "attempts early: switch off gave attempts '$(att_ev)', fix rounds '$(fix_rounds)'"
E2E_STUB_RIGHT=2 LOKI_E10_ATTEMPTS_EARLY=1 run_engine attempts
[ "$(att_ev)" = none ] && ok "attempts early: not on Haiku, the switch starts no attempt" || bad "attempts early: a non-Haiku run started attempts ('$(att_ev)')"
E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS_EARLY=1 run_engine attempts
[ "$(outcome)" != "VERIFIED" ] && [ "$(att_ev)" != none ] && [ "$(fix_rounds)" -ge 1 ] && ok "attempts early: every attempt wrong: the fix rounds still run afterwards, not VERIFIED ($(outcome), $(fix_rounds) round(s))" || bad "attempts early: all wrong gave '$(outcome)', attempts '$(att_ev)', fix rounds '$(fix_rounds)'"
E2E_STUB_NEWFILE=1 E2E_STUB_RIGHT=2 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 run_engine attempts
rid="$(basename "$RUNDIR")"; files="$(git -C "$REPO" ls-tree -r --name-only "loki/$rid" 2>/dev/null | tr '\n' ' ')"
[ "$(outcome)" = "VERIFIED" ] && ok "attempts (new files): attempt 2 wins when every attempt creates new files: VERIFIED" || { bad "attempts (new files): outcome '$(outcome)'"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
case " $files " in *" new_2.ts "*) case " $files " in *" shared_new.ts "*) ok "attempts (new files): the winner's own new file and the file every attempt created are committed" ;; *) bad "attempts (new files): shared_new.ts missing: $files" ;; esac ;; *) bad "attempts (new files): new_2.ts missing: $files" ;; esac
case " $files " in *" new_0.ts "*|*" new_1.ts "*|*" new_3.ts "*) bad "attempts (new files): a losing attempt's new file leaked into the winner's tree: $files" ;; *) ok "attempts (new files): no losing attempt's new file is in the winner's tree" ;; esac
E2E_STUB_WEAKEN=1 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 run_engine attempts
case "$(att_ev)" in winner=x1*) bad "attempts (bun test): an attempt that deleted the failing assertion won ($(att_ev))" ;; *) [ "$(outcome)" != "VERIFIED" ] && ok "attempts (bun test): an attempt that loosens an existing test never wins by passing it ($(att_ev), $(outcome))" || bad "attempts (bun test): a weakened test reached VERIFIED" ;; esac
E2E_STUB_RIGHT=2 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=0 run_engine attempts
[ "$(att_ev)" = none ] && [ "$(outcome)" = "STALLED" ] && ok "attempts: LOKI_E10_ATTEMPTS=0 turns it off (no extra session; the fix rounds' stall stands)" || bad "attempts: LOKI_E10_ATTEMPTS=0 gave '$(att_ev)' / '$(outcome)'"
E2E_STUB_RIGHT=2 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku run_engine attempts
[ "$(att_ev)" = none ] && ok "attempts: opt-in, so unset starts none even on Haiku" || bad "attempts: an unset LOKI_E10_ATTEMPTS started attempts ('$(att_ev)')"
E2E_STUB_RIGHT=1 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=on run_engine attempts
[ "$(att_ev)" = "winner=x1 total=2 early=True launched=1" ] && ok "attempts: LOKI_E10_ATTEMPTS=on is 2 total attempts (one extra) ($(att_ev))" || bad "attempts: =on gave '$(att_ev)'"
E2E_STUB_RIGHT=1 E2E_STUB_FIX=noprogress LOKI_E10_ATTEMPTS=2 run_engine attempts
[ "$(att_ev)" = "winner=x1 total=2 early=True launched=1" ] && [ "$(outcome)" = "VERIFIED" ] && ok "attempts: LOKI_E10_ATTEMPTS=2 is 2 total attempts on any model (it meant 2 extra before 11.140) ($(att_ev))" || bad "attempts: LOKI_E10_ATTEMPTS=2 gave '$(att_ev)' / '$(outcome)'"
LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 run_engine done
[ "$(att_ev)" = none ] && [ "$(att_rc)" = none ] && [ "$(outcome)" = "VERIFIED" ] && ok "attempts: a clean first attempt (verify green, nothing NOT PROVEN) starts no extra session even with LOKI_E10_ATTEMPTS=3" || bad "attempts: a green first attempt gave '$(att_ev)' / '$(outcome)'"

if python3 -m pytest --version >/dev/null 2>&1; then
    PY_MODE=attempts E2E_STUB_RIGHT=1 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 py_engine calc.py
    [ "$(outcome)" = "VERIFIED" ] && ok "attempts (pytest): attempt 1 is right after a wrong first attempt: VERIFIED" || { bad "attempts (pytest): outcome '$(outcome)'"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
    rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
    git -C "$REPO" show "loki/$rid:calc.py" 2>/dev/null | grep -A1 'def multiply' | grep -q 'a \* b' && ok "attempts (pytest): the committed multiply() is the right one" || bad "attempts (pytest): the committed calc.py holds the wrong multiply()"
    PY_MODE=attempts E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 py_engine calc.py
    [ -n "$(outcome)" ] && [ "$(outcome)" != "VERIFIED" ] && ok "attempts (pytest): every attempt wrong: not VERIFIED ($(outcome))" || bad "attempts (pytest): all wrong gave '$(outcome)'"
elif [ "${CI:-}" = "true" ]; then
    bad "attempts: pytest is not installed on the CI runner"
else
    echo "SKIP: attempts pytest legs (pytest not installed)"
fi

# real vitest in a temp fixture (skips cleanly offline; LOKI_STACKS_REQUIRE=1 makes a missing install a failure)
vt_attempts() { # vt_attempts <right: 2|none> -> REPO, RUNDIR, OUT
    local d="$T/vt-att-$1"; REPO="$d/repo"; mkdir -p "$REPO"
    printf '{"name":"vt","private":true,"type":"module"}\n' > "$REPO/package.json"
    printf 'export function add(a: number, b: number): number {\n  return a + b;\n}\n' > "$REPO/calc.ts"
    printf 'import { expect, test } from "vitest";\nimport * as calc from "./calc";\n\ntest("add", () => {\n  expect(calc.add(2, 3)).toBe(5);\n});\n\ntest("multiply", () => {\n  const m = (calc as unknown as { multiply?: (a: number, b: number) => number }).multiply;\n  if (m) expect(m(3, 4)).toBe(12);\n});\n' > "$REPO/calc.test.ts"
    printf 'node_modules\n' > "$REPO/.gitignore"
    git -C "$REPO" init -q -b main; git -C "$REPO" config user.name e2e; git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add -A .; git -C "$REPO" commit -q -m base
    cp -R "$VTNM" "$REPO/node_modules"
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" E2E_STUB_MODE=attempts E2E_STUB_RIGHT="$1" E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 \
        LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$d/k.pem" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "add a multiply(a, b) function to calc.ts" --no-pr 2>&1)"
    local rid; rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"; RUNDIR="$REPO/.loki/runs/$rid"
    [ -n "$rid" ] && git -C "$REPO" rev-parse -q --verify "refs/heads/loki/$rid" >/dev/null && git -C "$REPO" checkout -q "loki/$rid"
}
VTDIR="$T/vt-install"; mkdir -p "$VTDIR"; printf '{"private":true}\n' > "$VTDIR/package.json"; VTNM="$VTDIR/node_modules"
if (cd "$VTDIR" && ${TO[@]+"${TO[@]}"} npm install vitest@2 --no-audit --no-fund --silent >/dev/null 2>&1) && [ -x "$VTNM/.bin/vitest" ]; then
    vt_attempts 2
    [ "$(outcome)" = "VERIFIED" ] && [ "$(att_ev)" = "winner=x2 total=3 early=True launched=2" ] && ok "attempts (real vitest 2): attempt 2 is right after a wrong first attempt: VERIFIED, winner x2" || { bad "attempts (real vitest 2): outcome '$(outcome)', attempts '$(att_ev)'"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
    vt_attempts none
    [ -n "$(outcome)" ] && [ "$(outcome)" != "VERIFIED" ] && ok "attempts (real vitest 2): every attempt wrong: not VERIFIED ($(outcome))" || bad "attempts (real vitest 2): all wrong gave '$(outcome)'"
elif [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then
    bad "attempts: vitest@2 could not be installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"
else
    echo "SKIP: attempts vitest legs (vitest@2 could not be installed, offline?)"
fi

# Unit: the N rule (LOKI_E10_ATTEMPTS is the TOTAL count; before 11.140 it was the extra count), the rank order (verify green, then no spec conflict, then fewer NOT PROVEN lines;
# pre red lines never count; a disqualified attempt never wins), the PICK parser, and the order-swapped tie review (it counts only when both orders name the same attempt).
U="$(cd "$ROOT/loki-ts" && bun -e '
const a = await import("./src/features/attempts.ts"), s = await import("./src/e10ext/select.ts"), { FINISH_LINE } = await import("./src/engine10/types.ts");
const sig = (red, np, conflict = false) => ({ red, conflict, notProven: Array.from({ length: np }, (_, i) => `n${i}`) });
const cand = (index, g, o = {}) => ({ index, killedOrErrored: !!o.killed, diff: o.empty ? "" : "@@ -1 +1 @@\n-a\n+b\n", alreadyDoneEvidence: false, weakensTest: !!o.weak, ...(g ? { signal: g } : {}) });
const pick = (...c) => s.rankAttempts(c).index;
const out = [];
out.push(`total=${[undefined, "on", "0", "1", "3", "9", "x", "-1", "2.5"].map((v) => a.attemptsTotal("haiku", v === undefined ? {} : { LOKI_E10_ATTEMPTS: v })).join(",")}`);
out.push(`extra=${a.attemptsK("haiku", { LOKI_E10_ATTEMPTS: "3" })},${a.attemptsK("haiku", { LOKI_E10_ATTEMPTS_EARLY: "1" })},${a.attemptsK("haiku", { LOKI_E10_ATTEMPTS_EARLY: "1", LOKI_E10_ATTEMPTS: "0" })},${a.attemptsK("sonnet", { LOKI_E10_ATTEMPTS_EARLY: "1" })}`);
out.push(`green_first=${pick(cand(0, sig(true, 0)), cand(1, sig(false, 3)))}`);
out.push(`no_conflict_second=${pick(cand(0, sig(false, 1, true)), cand(1, sig(false, 4)))}`);
out.push(`fewer_np=${pick(cand(0, sig(true, 3)), cand(1, sig(true, 1)))}`);
const t = s.rankAttempts([cand(1, sig(true, 2)), cand(0, sig(true, 2)), cand(2, sig(true, 5))]);
out.push(`tie=${t.index}:${t.tied.join("+")}`);
out.push(`weak_out=${pick(cand(0, sig(false, 0), { weak: true }), cand(1, sig(true, 9)))} empty_out=${pick(cand(0, sig(false, 0), { empty: true }), cand(1, sig(true, 9)))} unverified_out=${pick(cand(0, undefined), cand(1, sig(true, 9)))}`);
out.push(`prered=${a.signalNotProven(["pre red: x", "a", "a", ""]).join("+")} clean=${a.isClean(sig(false, 0))},${a.isClean(sig(false, 1))},${a.isClean(sig(true, 0))},${a.isClean(sig(false, 0, true))}`);
out.push(`parse=${a.parsePick("why\nPICK: B", 2)},${a.parsePick("PICK: C", 2)},${a.parsePick("no pick", 2)},${a.parsePick("PICK: A\nPICK: **B**", 3)}`);
const ctx = { issue: "i", conventions: [], tree: [], prefix: [] }, tied = [{ index: 0, diff: "bad" }, { index: 2, diff: "GOOD" }];
const byContent = async (sys, p) => { const m = /CANDIDATE ([A-Z]) \(unified diff against the pre-fix code\):\nGOOD/.exec(p); return { text: m ? `PICK: ${m[1]}` : "PICK: A", usd: 0, outcome: "ok" }; };
const alwaysA = async () => ({ text: "PICK: A", usd: 0, outcome: "ok" }), fails = async () => ({ text: null, usd: null, outcome: "transport" }), throws = async () => { throw new Error("x"); };
out.push(`review=${(await a.reviewTie(byContent, ctx, tied)).index},${(await a.reviewTie(alwaysA, ctx, tied)).index},${(await a.reviewTie(fails, ctx, tied)).index},${(await a.reviewTie(throws, ctx, tied)).index}`);
out.push(`variants=${[1, 2, 3, 4].map((i) => a.variantBrief("BODY\n\n" + FINISH_LINE, i).includes(a.VARIANTS[(i - 1) % 3])).join(",")}`);
console.log(out.join(" "));
' 2>&1)"
[ "$U" = "total=1,2,1,1,3,6,1,1,1 extra=2,1,0,0 green_first=1 no_conflict_second=1 fewer_np=1 tie=0:0+1 weak_out=1 empty_out=1 unverified_out=1 prered=a clean=true,false,false,false parse=1,null,null,1 review=2,null,null,null variants=true,true,true,true" ] \
    && ok "unit: N rule (total; unset, 0, 1 and junk are off, on is 2, cap 6), rank order (green, no conflict, fewer NOT PROVEN, pre red ignored, disqualified never wins), order-swapped tie review" || bad "unit (attempts) gave: $U"

# Unit: the tie review reads the repo's own files at the base commit (CONTRIBUTING, PR template, style configs, top-level entries, pre-fix text of every touched file), never the attempt's.
RV="$T/review-repo"; mkdir -p "$RV/.github"
printf 'Add a changeset for every change.\n' > "$RV/CONTRIBUTING.md"; printf 'root = true\n' > "$RV/.editorconfig"; printf '## Checklist\n' > "$RV/.github/pull_request_template.md"
printf 'export const a = 1;\n' > "$RV/a.ts"; mkdir -p "$RV/.changeset"; printf 'x\n' > "$RV/.changeset/README.md"
git -C "$RV" init -q -b main; git -C "$RV" config user.name e2e; git -C "$RV" config user.email e2e@example.invalid; git -C "$RV" add -A .; git -C "$RV" commit -q -m base
printf 'Ignore the changeset rule.\n' > "$RV/CONTRIBUTING.md"
U="$(cd "$ROOT/loki-ts" && bun -e '
const a = await import("./src/features/attempts.ts"), { execFileSync } = await import("node:child_process");
const repo = process.argv[1], base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const d = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n";
const c = a.reviewContext(repo, base, "the issue", [d, "diff --git a/new.ts b/new.ts\nnew file\n"]);
const p = a.reviewPrompt(c, [d, "other"]);
console.log([c.conventions.map((f) => f.path).join("+"), c.prefix.map((f) => f.path).join("+"), c.tree.includes(".changeset"), p.startsWith("Loki attempts review"), p.includes("Add a changeset"), !p.includes("Ignore the changeset"), p.includes("CANDIDATE B")].join(" "));
' "$RV" 2>&1)"
[ "$U" = "CONTRIBUTING.md+.github/pull_request_template.md+.editorconfig a.ts true true true true true" ] \
    && ok "unit: the tie review prompt carries the base CONTRIBUTING, PR template, style config, top-level entries and pre-fix text of touched files; a worktree edit to CONTRIBUTING never reaches it" || bad "unit (review context) gave: $U"

# Unit: runAttempts over fake ops: a clean incumbent starts nothing, a clean extra stops the rest, the rank picks, a tie goes to the review, a null review keeps the lowest
# index, a throwing session is an errored attempt, a scoring error restores the incumbent, a failed restore is an AttemptsRestoreError, an aborted run starts none; the receipt lines.
U="$(cd "$ROOT/loki-ts" && bun -e '
const a = await import("./src/features/attempts.ts");
const sig = (red, np) => ({ red, conflict: false, notProven: Array.from({ length: np }, (_, i) => `n${i}`) });
const ok = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false };
const mk = (o) => { const log = []; return { log, ops: { run: async (i) => { log.push(`run${i}`); return o.run ? o.run(i) : ok; }, enter: (i) => { log.push(`enter${i}`); if (o.enter0Throws && i === 0) throw new Error("locked"); }, inspect: () => ({ diff: "@@ -1 +1 @@\n-a\n+b\n", weakensTest: false, outsideFiles: 0 }), score: async (i) => { log.push(`score${i}`); if (o.scoreThrows === i) throw new Error("boom"); return o.sig(i); }, ...(o.review ? { review: async (t) => { log.push(`review${t.map((x) => x.index).join("+")}`); return o.review(t); } } : {}) } }; };
let last = null;
const run = async (o, k = 1, sg = new AbortController().signal) => { const m = mk(o), r = await a.runAttempts(m.ops, k, sg, {}); last = r; return `${r.winner}/${r.launched}/${m.log.join(",")}`; };
const out = [];
out.push(`clean=${await run({ sig: () => sig(false, 0) })}`);
out.push(`early=${await run({ sig: (i) => (i === 0 ? sig(false, 2) : sig(false, 0)) })}`);
out.push(`rank=${await run({ sig: (i) => [sig(true, 2), sig(true, 3), sig(true, 1)][i] }, 2)}`);
out.push(`tie_review=${await run({ sig: () => sig(true, 2), review: async () => ({ index: 1, reason: "picked" }) })}:${/review: picked/.test(last.reason)}`);
out.push(`tie_null=${await run({ sig: () => sig(true, 2), review: async () => ({ index: null, reason: "disagreed" }) })}`);
out.push(`receipt=${a.attemptsReceiptLines(last, 2).length}:${a.attemptsReceiptLines(last, 2).at(-1).startsWith("selected attempt 1 (first) of 2 scored (2 requested): tie")}`);
out.push(`throws=${await run({ sig: (i) => sig(true, 1), run: () => { throw new Error("spawn failed"); } }, 2)}`);
out.push(`score_error=${await run({ sig: () => sig(true, 1), scoreThrows: 1 })}`);
out.push(`restore_fail=${await run({ sig: () => sig(true, 1), scoreThrows: 1, enter0Throws: true }).catch((e) => e.name)}`);
const ac = new AbortController(); ac.abort();
out.push(`aborted=${await run({ sig: () => sig(true, 1) }, 2, ac.signal)}`);
out.push(`no_receipt_when_none=${a.attemptsReceiptLines({ launched: 0, scored: [], winner: 0, reason: "" }, 3).length}`);
console.log(out.join(" "));
' 2>&1)"
[ "$U" = "clean=0/0/score0 early=1/1/score0,run1,enter1,score1 rank=2/2/score0,run1,run2,enter1,score1,enter2,score2 tie_review=1/1/score0,run1,enter1,score1,review0+1:true tie_null=0/1/score0,run1,enter1,score1,review0+1,enter0 receipt=3:true throws=0/2/score0,run1,run2 score_error=0/1/score0,run1,enter1,score1,enter0 restore_fail=AttemptsRestoreError aborted=0/0/score0 no_receipt_when_none=0" ] \
    && ok "unit: attempts over fake ops (clean first starts none, clean extra stops the rest, rank picks, a tie goes to the review, a null review keeps the first, errored and aborted keep it, receipt lines)" || bad "unit (attempts ops) gave: $U"

# ---------------------------------------------------------------- PR-BASE begin (FireLater#19, pull request 70): the label describes exactly what the pull request merges
# A run started on feature/issue-24 (tip not in main) measured 12 files against that tip and opened a pull request into main that merged 40.
# Local bare origin, stub provider. Every leg compares the user's branch tip, main, the checked-out ref, the status and an untracked file
# before and after. Mutations (each leg read red under its own):
#   50. util/base_guard.ts prBasePlan: return keep(t.ref) in place of the target-tip plan (leg a: no "starting from" line, the receipt base is
#       the feature tip, the label is PARTIAL and the pushed branch holds other.txt).
#   51. util/base_guard.ts prBasePlan: drop the o.baseCurrent branch (leg b: the pull request targets main, no "Stacked on" line; leg c1 runs a session).
#   52. util/base_guard.ts prBasePlan: hit = [] (leg c2: a session runs or the checkout fails inside the run, the stub log is not empty).
#   53. stages/seal.ts: drop ...prScopeSeal.notes from openNotes (leg d: a detached start seals VERIFIED).
#   54. stages/pr.ts prScopeGate: return verdict sealed and no notes on a mismatch (unit leg: gate=VERIFIED for a moved base).
#   60. util/base_guard.ts finishDeferredRun: drop the start_sha baseSha (leg d: the checkout stays on loki/<run> after the deep verify).
#   59. stages/pr.ts prScopeGate: after = capped (ignore sealMeasured) (unit leg: gate_unmeasured carries the sealed-before sentence).
#   55. util/base_guard.ts prBasePlan: anc() always false (leg e: a run from main prints the start sentence and its header names origin/main as the base).
#   56. supervisor.ts: join the header lines with ", " (leg e: the header is one line, longer than 130 characters).
#   58. util/base_guard.ts prBasePlan: skip the dirty-tree branch (leg c3: the start sentence prints for a run intake then refuses).
#   57. stages/intake.ts: ignore LOKI_E10_START_FROM (leg a: the receipt base is the feature tip, the label is PARTIAL, other.txt is pushed).
# prb_run <label> <setup: tip|pushed|collide|detached|main> [flags...] -> D, REPO, OUT, RC, RUNDIR, PRB_BEFORE, PRB_AFTER
prb_state() { # the user's side of the checkout: nothing here may differ after a run
    printf 'head=%s ref=%s feature=%s main=%s note=%s collide=%s status=%s\n' \
        "$(git -C "$1" rev-parse HEAD)" "$(git -C "$1" symbolic-ref -q --short HEAD || echo detached)" \
        "$(git -C "$1" rev-parse -q --verify refs/heads/feature/x || echo none)" "$(git -C "$1" rev-parse refs/heads/main)" \
        "$(git -C "$1" hash-object "$1/scratch-note.txt")" "$([ -f "$1/collide.txt" ] && git -C "$1" hash-object "$1/collide.txt" || echo none)" \
        "$(git -C "$1" status --porcelain --untracked-files=all | grep -v '\.loki/' | tr '\n' '|')"
}
prb_run() {
    local label="$1" setup="$2" i pid; shift 2
    D="$T/prb-$label"; REPO="$D/repo"; mkdir -p "$D"
    git init -q --bare -b main "$D/origin.git"
    cp -R "$FIX/repo" "$REPO"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e
    git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add calc.ts calc.test.ts bunfig.toml
    git -C "$REPO" commit -q -m base
    git -C "$REPO" remote add origin "$D/origin.git"
    git -C "$REPO" push -q origin main
    if [ "$setup" != main ]; then # the other branch: one commit, two files, not in main (the head of somebody else's open pull request)
        git -C "$REPO" checkout -q -b feature/x
        mkdir -p "$REPO/extra"; echo "other work" > "$REPO/other.txt"; echo "notes" > "$REPO/extra/notes.md"
        git -C "$REPO" add other.txt extra/notes.md
        git -C "$REPO" commit -q -m "other work, not in main"
    fi
    case "$setup" in
        pushed) git -C "$REPO" push -q origin feature/x ;;
        collide) # origin/main moved on and tracks collide.txt; the user's tree holds an untracked file of that name
            git -C "$REPO" checkout -q main; echo "tracked on main" > "$REPO/collide.txt"; git -C "$REPO" add collide.txt
            git -C "$REPO" commit -q -m "main moves on"; git -C "$REPO" push -q origin main
            git -C "$REPO" checkout -q feature/x; printf 'my own notes\n' > "$REPO/collide.txt" ;;
        detached) git -C "$REPO" checkout -q --detach feature/x ;;
        dirty) printf '// my uncommitted edit\n' >> "$REPO/calc.test.ts" ;;
    esac
    printf 'uncommitted and untracked, mine\n' > "$REPO/scratch-note.txt"
    PRB_BEFORE="$(prb_state "$REPO")"
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u GH_TOKEN -u GITHUB_TOKEN \
        -u LOKI_REVIEW_PROVIDER -u LOKI_REVIEW_DEFAULT -u LOKI_XVENDOR_DEFAULT -u LOKI_RISK_TIER -u LOKI_PR_DRAFT -u LOKI_PR_BASE -u LOKI_BASE_CURRENT -u LOKI_E10_BASE \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" GH_CONFIG_DIR="$D/ghcfg" \
        E2E_STUB_MODE=done E2E_STUB_LOG="$D/stub.log" LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$D/k.pem" \
        ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" ${PRB_VERB:+"$PRB_VERB"} "$TASK" "$@" 2>&1)"
    RC=$?
    RUNDIR="$REPO/.loki/runs/$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
    if [ -f "$RUNDIR/events.jsonl" ] && grep -q '"pr.opened"' "$RUNDIR/events.jsonl"; then # the detached deep verify holds the checkout until it ends
        for i in $(seq 1 90); do [ -f "$RUNDIR/receipt-addendum-1.json" ] && break; sleep 1; done
        pid="$(python3 -I -c 'import json,sys; print(next((json.loads(l)["data"]["pid"] for l in open(sys.argv[1]) if "\"deep.started\"" in l), ""))' "$RUNDIR/events.jsonl" 2>/dev/null)"
        for i in $(seq 1 30); do [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || break; sleep 1; done
        for i in $(seq 1 20); do [ "$(git -C "$REPO" symbolic-ref -q --short HEAD)" = "loki/$(basename "$RUNDIR")" ] || break; sleep 1; done
    fi
    PRB_AFTER="$(prb_state "$REPO")"
}
# prb_facts -> "<receipt verdict> <pr.opened count> <draft> <receipt base is origin main: yes|no> <pr_base.mode> <pr_base.target> <pr_files>/<measured_files> <commits pushed past the target> <other.txt pushed: yes|no> <sessions>"
prb_facts() {
    python3 -I - "$REPO" "$RUNDIR" "$D" "${1:-main}" <<'PY'
import json, os, subprocess, sys
repo, rd, d, tgt = sys.argv[1:5]
g = lambda *a: subprocess.run(["git", "-C", os.path.join(d, "origin.git"), *a], capture_output=True, text=True).stdout.strip()
ev = [json.loads(l) for l in open(os.path.join(rd, "events.jsonl")) if l.strip().startswith("{")] if os.path.exists(os.path.join(rd, "events.jsonl")) else []
rec = json.load(open(os.path.join(rd, "receipt.json"))) if os.path.exists(os.path.join(rd, "receipt.json")) else {}
pr = [e for e in ev if e.get("type") == "pr.opened"]
pb = rec.get("pr_base") or {}
br = "loki/" + os.path.basename(rd)
pushed = g("rev-list", "--count", "%s..%s" % (tgt, br)) or "none"
files = g("diff", "--name-only", "%s...%s" % (tgt, br)).split()
stub = os.path.join(d, "stub.log")
print(rec.get("verdict", "none"), len(pr), bool(pr and pr[0]["data"].get("draft")), "yes" if rec.get("base_sha") == g("rev-parse", "main") else "no",
      pb.get("mode", "none"), pb.get("target", "none"), "%s/%s" % (pb.get("pr_files"), pb.get("measured_files")), pushed,
      "yes" if "other.txt" in files else "no", sum(1 for _ in open(stub)) if os.path.exists(stub) else 0)
PY
}
prb_same() { [ "$PRB_BEFORE" = "$PRB_AFTER" ] && ok "$1: the user's branch, its commits, main, the checked-out ref and the untracked file are identical before and after" || { bad "$1: the user's checkout changed"; printf '    | before %s\n    | after  %s\n' "$PRB_BEFORE" "$PRB_AFTER"; }; }
PRB_LINE="starting from origin/main, not from your branch feature/x, so the pull request holds only this change (use --base-current to build on your branch)"

# leg a: a branch whose tip is not in the target, clean tree, no flag: the run starts from the target tip and the pull request holds only its own commits and files
prb_run a tip
f="$(prb_facts)"; set -- $f
[ "$(grep -cxF "$PRB_LINE" <<< "$OUT")" = 1 ] && ok "PR-BASE a: the run says once, in one plain line, that it starts from origin/main and names --base-current" || { bad "PR-BASE a: the start sentence is printed $(grep -cxF "$PRB_LINE" <<< "$OUT") times"; sed -n '1,6s/^/    | /p' <<< "$OUT"; }
[ "$(awk -v l="$PRB_LINE" 'index($0, l) { print NR; exit }' <<< "$OUT")" -le 5 ] 2>/dev/null \
    && ok "PR-BASE a: the sentence is among the run's first lines, before any stage output" || bad "PR-BASE a: the sentence is not among the first five lines"
has "PR-BASE a: the header names the target as the base" "$OUT" "Loki 10 engine, PR target: origin/main, base: origin/main"
[ "$1 $2 $3" = "VERIFIED 1 False" ] && ok "PR-BASE a: the run is VERIFIED and its pull request opens ready" || { bad "PR-BASE a: facts $f (rc $RC)"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
[ "$4 $5 $6" = "yes target-tip origin/main" ] && ok "PR-BASE a: the receipt's base is the origin/main tip and it records the target and the mode" || bad "PR-BASE a: receipt base facts: $f"
[ "$8" = 1 ] && [ "$9" = no ] && [ "$7" = "1/1" ] && ok "PR-BASE a: the pushed branch holds one commit past main and one file, the same count the receipt measured; other.txt is not in it" || bad "PR-BASE a: pushed $8 commit(s), other.txt pushed: $9, files pr/measured $7"
grep -q '^Base and target: built from ' "$RUNDIR/pr-body.md" 2>/dev/null && ok "PR-BASE a: the pull request body states the base and the target in one line" || bad "PR-BASE a: no 'Base and target:' line in the pull request body"
prb_same "PR-BASE a"

# leg b: --base-current with the branch on the remote: the pull request targets that branch (a stacked pull request) and holds only the run's commits
PRB_VERB=start prb_run b pushed --base-current # through `loki start`, the command the measured run used: the flag crosses route.sh and commands/start.ts
f="$(prb_facts feature/x)"; set -- $f
has "PR-BASE b: the run says it builds on the branch and targets it" "$OUT" "building on your branch feature/x: the pull request targets feature/x, not main (stacked pull request)"
has "PR-BASE b: the header names the branch as target and base" "$OUT" "Loki 10 engine, PR target: origin/feature/x, base: feature/x"
grep -qF 'Stacked on `feature/x`' "$RUNDIR/pr-body.md" 2>/dev/null && ok "PR-BASE b: the push is asked to open the pull request into feature/x (the body's stacked line)" || bad "PR-BASE b: the body has no 'Stacked on feature/x' line"
[ "$1 $2 $3" = "VERIFIED 1 False" ] && [ "$5 $6" = "current-branch origin/feature/x" ] && [ "$8" = 1 ] && [ "$7" = "1/1" ] \
    && ok "PR-BASE b: VERIFIED, and against feature/x the pushed branch holds one commit and one file, as measured" || { bad "PR-BASE b: facts $f (rc $RC)"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
[ "$(grep -cF "$PRB_LINE" <<< "$OUT")" = 0 ] && ok "PR-BASE b: no start-from-main sentence with --base-current" || bad "PR-BASE b: the start-from-main sentence printed with --base-current"
prb_same "PR-BASE b"

# leg c1: --base-current with the branch not on the remote: nothing can be reconciled, so the run stops with the choice before any session
prb_run c1 tip --base-current
[ "$RC" -eq 2 ] && [ ! -s "$D/stub.log" ] && [ ! -d "$REPO/.loki/runs" ] && ok "PR-BASE c1: --base-current on a branch origin does not have exits 2 before any session or run record" || { bad "PR-BASE c1: rc $RC, stub log $(wc -l < "$D/stub.log" 2>/dev/null || echo 0) line(s), runs dir $([ -d "$REPO/.loki/runs" ] && echo present || echo absent)"; printf '%s\n' "$OUT" | tail -5 | sed 's/^/    | /'; }
has "PR-BASE c1: the refusal counts the commits the pull request would carry" "$OUT" "your branch feature/x is not on origin, so the pull request would go into main and carry 1 other commit. Nothing was run."
has "PR-BASE c1: the refusal gives the push command" "$OUT" "git push -u origin feature/x, then rerun with --base-current"
[ -z "$(git -C "$D/origin.git" for-each-ref --format='%(refname)' refs/heads | grep -v '^refs/heads/main$')" ] && ok "PR-BASE c1: nothing was pushed" || bad "PR-BASE c1: origin has $(git -C "$D/origin.git" for-each-ref --format='%(refname)' refs/heads | tr '\n' ' ')"
prb_same "PR-BASE c1"

# leg c2: starting from the target would overwrite an untracked file: refused before any session, with the two commands that work
prb_run c2 collide
[ "$RC" -eq 2 ] && [ ! -s "$D/stub.log" ] && [ ! -d "$REPO/.loki/runs" ] && ok "PR-BASE c2: a base that cannot be reconciled exits 2 before any session or run record" || { bad "PR-BASE c2: rc $RC, stub log $(wc -l < "$D/stub.log" 2>/dev/null || echo 0) line(s), runs dir $([ -d "$REPO/.loki/runs" ] && echo present || echo absent)"; printf '%s\n' "$OUT" | tail -5 | sed 's/^/    | /'; }
has "PR-BASE c2: the refusal names the file" "$OUT" "would overwrite 1 file in your working tree that feature/x does not track (collide.txt). Nothing was run."
has "PR-BASE c2: first command" "$OUT" "Either: git push -u origin feature/x, then rerun with --base-current (pull request into feature/x)"
has "PR-BASE c2: second command" "$OUT" "; or: git worktree add ../repo-main origin/main, then rerun there (pull request into main)"
[ "$(cat "$REPO/collide.txt")" = "my own notes" ] && ok "PR-BASE c2: the untracked file keeps its bytes" || bad "PR-BASE c2: collide.txt now reads '$(cat "$REPO/collide.txt" 2>&1)'"
prb_same "PR-BASE c2"

# leg c3: a dirty tracked tree on the diverged branch keeps today's refusal: no start from the target, no session, the edit untouched
prb_run c3 dirty
PRB_EDIT="$(git -C "$REPO" hash-object "$REPO/calc.test.ts")"
has "PR-BASE c3: the dirty tracked tree is refused as before" "$OUT" "dirty tracked tree: M calc.test.ts; loki never stashes or commits your edits"
[ "$(grep -cF "$PRB_LINE" <<< "$OUT")" = 0 ] && [ ! -s "$D/stub.log" ] && [ "$RC" -ne 0 ] && ok "PR-BASE c3: no start from the target and no session on a dirty tree (rc $RC)" || { bad "PR-BASE c3: rc $RC, stub log $(wc -l < "$D/stub.log" 2>/dev/null || echo 0) line(s)"; printf '%s\n' "$OUT" | tail -5 | sed 's/^/    | /'; }
[ "$(tail -1 "$REPO/calc.test.ts")" = "// my uncommitted edit" ] && [ "$PRB_EDIT" = "$(git -C "$REPO" hash-object "$REPO/calc.test.ts")" ] && ok "PR-BASE c3: the uncommitted edit keeps its bytes" || bad "PR-BASE c3: the uncommitted edit changed"
prb_same "PR-BASE c3"

# leg d: a base that stays outside the target (a detached HEAD keeps its start commit) is never sealed or opened green: the seal holds the label
prb_run d detached
f="$(prb_facts)"; set -- $f
PRB_WHY="the pull request would merge 2 files the label did not measure"
has "PR-BASE d: the run says before any session that the label will be held" "$OUT" "is not in origin/main: the pull request would carry 1 other commit, so the label is held at PARTIAL and the pull request opens as a draft"
[ "$1" = PARTIAL ] && grep -qF "$PRB_WHY" "$RUNDIR/receipt.json" && ok "PR-BASE d: the receipt is sealed PARTIAL with the reason" || { bad "PR-BASE d: verdict $1, reason in receipt: $(grep -cF "$PRB_WHY" "$RUNDIR/receipt.json" 2>/dev/null)"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
[ "$2 $3" = "1 True" ] && ok "PR-BASE d: the pull request opens as a draft" || bad "PR-BASE d: pr.opened $2, draft $3"
[ "$7" = "3/1" ] && [ "$4" = no ] && ok "PR-BASE d: the receipt records 3 files in the pull request against 1 measured" || bad "PR-BASE d: files pr/measured $7, base is main: $4"
grep -qF "$PRB_WHY" "$RUNDIR/pr-body.md" && grep -q '^## Not proven' "$RUNDIR/pr-body.md" && ok "PR-BASE d: the pull request body leads with the reason" || bad "PR-BASE d: the body does not carry the reason under Not proven"
grep -Eq '^Outcome:[[:space:]]+PARTIAL' <<< "$OUT" && ok "PR-BASE d: the console outcome is PARTIAL, the same as the receipt" || bad "PR-BASE d: console outcome: $(grep -m1 '^Outcome:' <<< "$OUT")"
prb_same "PR-BASE d" # a detached start returns to its commit, detached, after the background deep verify too (branch.json start_sha)

# unit: the measurement and the pull request stage's own check (the backstop for a change between the seal and the push)
U="$(cd "$ROOT/loki-ts" && PRB_T="$T/prb-unit" bun --no-env-file --config=/dev/null -e '
import { execFileSync } from "node:child_process"; import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path";
const bg = await import("./src/util/base_guard.ts"), pr = await import("./src/engine10/stages/pr.ts");
const d = process.env.PRB_T!; mkdirSync(d, { recursive: true });
const g = (...a: string[]) => execFileSync("git", ["-C", d, ...a], { stdio: "pipe" }).toString().trim();
const put = (f: string, msg: string) => { writeFileSync(join(d, f), msg + "\n"); g("add", f); g("commit", "-q", "-m", msg); return g("rev-parse", "HEAD"); };
g("init", "-q", "-b", "main"); g("config", "user.name", "u"); g("config", "user.email", "u@example.invalid");
const m0 = put("a.txt", "base"); g("checkout", "-q", "-b", "feature"); put("f1.txt", "other one"); const f = put("f2.txt", "other two");
g("checkout", "-q", "-b", "loki/from-main", m0); put("run.txt", "the run"); g("checkout", "-q", "-b", "loki/from-feature", f); put("run.txt", "the run");
g("checkout", "-q", "main"); put("later.txt", "main moves forward");
process.env.LOKI_E10_NO_FETCH = "1"; delete process.env.LOKI_PR_BASE;
const s1 = bg.prScope(d, { target: "main", baseSha: m0, head: "loki/from-main" }), s2 = bg.prScope(d, { target: "main", baseSha: f, head: "loki/from-feature" }), s3 = bg.prScope(d, { target: "nope", baseSha: m0, head: "loki/from-main" });
const ctx = (branch: string, base: string) => ({ repoDir: d, branch, baseSha: base, outputs: () => ({ intake: { base_sha: base } }) }) as never;
const gOk = pr.prScopeGate(ctx("loki/from-main", m0), "VERIFIED", [], true), gBad = pr.prScopeGate(ctx("loki/from-feature", f), "VERIFIED", [], true), gSealed = pr.prScopeGate(ctx("loki/from-feature", f), "PARTIAL", [s2.reason!], true), gNoRec = pr.prScopeGate(ctx("loki/from-feature", f), "VERIFIED", [], false);
console.log([`forward=${s1.ok}:${s1.pr_files}/${s1.measured_files}:${s1.pr_commits}/${s1.measured_commits}`, `other=${s2.ok}:${s2.pr_files}/${s2.measured_files}:${s2.pr_commits}/${s2.measured_commits}:${s2.reason!.startsWith("the pull request would merge 2 files the label did not measure")}`,
  `unreadable=${s3.ok}`, `gate_ok=${gOk.verdict}:${gOk.notProven.length}:${gOk.line.trim().startsWith("Base and target: built from ")}`,
  `gate=${gBad.verdict}:${gBad.notProven.length}:${/sealed before the target or the branch changed/.test(gBad.notProven[0] ?? "")}:${/The receipt was sealed before/.test(gBad.line)}`, `gate_sealed=${gSealed.verdict}:${gSealed.notProven.length}`, `gate_unmeasured=${gNoRec.verdict}:${gNoRec.notProven.length}:${/sealed before/.test(gNoRec.notProven.join(" ") + gNoRec.line)}`].join(" "));
' 2>&1)"
[ "$U" = "forward=true:1/1:1/1 other=false:3/1:3/1:true unreadable=false gate_ok=VERIFIED:0:true gate=PARTIAL:1:true:true gate_sealed=PARTIAL:0 gate_unmeasured=PARTIAL:1:false" ] \
    && ok "PR-BASE unit: a target that only moved forward measures the same; a base outside the target is never green at the pull request stage (PARTIAL, the reason, the sealed-before line); an unreadable target is never green; a reason the seal already holds is not repeated; a receipt with no pr_base is capped without the sealed-before sentence" || bad "PR-BASE unit: $U"

# leg e: a normal run from main is unchanged: no base sentence, the same stages, VERIFIED, a ready pull request; the header is at most three short lines
prb_run e main
f="$(prb_facts)"; set -- $f
grep -qE 'starting from |building on your branch|is not in origin/main' <<< "$OUT" && bad "PR-BASE e: a run from main printed a base sentence" || ok "PR-BASE e: a run from main prints no base sentence"
[ "$1 $2 $3" = "VERIFIED 1 False" ] && [ "$4 $5 $6" = "yes head origin/main" ] && [ "$7" = "1/1" ] && [ "$8" = 1 ] \
    && ok "PR-BASE e: VERIFIED, a ready pull request of one commit and one file, the receipt records base and target with equal counts" || { bad "PR-BASE e: facts $f (rc $RC)"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
PRB_STAGES="$(python3 -I -c 'import json,sys; print(",".join(json.loads(l)["stage"] for l in open(sys.argv[1]) if "\"stage.completed\"" in l))' "$RUNDIR/events.jsonl" 2>/dev/null)"
[ "$PRB_STAGES" = "intake,plan,implement,verify,commit,seal" ] && ok "PR-BASE e: the stages are the ones a run from main always had ($PRB_STAGES)" || bad "PR-BASE e: stages: $PRB_STAGES"
grep -q '^## Reviewer brief' "$RUNDIR/pr-body.md" && grep -q '^## What changed and why' "$RUNDIR/pr-body.md" && grep -q '^## Receipt' "$RUNDIR/pr-body.md" && ! grep -q 'Stacked on\|sealed before' "$RUNDIR/pr-body.md" && ok "PR-BASE e: the pull request body keeps its sections and gains no stacked or sealed-before line" || bad "PR-BASE e: pull request body changed shape"
PRB_HEAD="$(awk '/^(Loki 10 engine|model |cap |estimate:)/ && !done { print; next } { done = 1 }' <<< "$OUT")"
[ "$(grep -c '' <<< "$PRB_HEAD")" -le 3 ] && [ "$(head -1 <<< "$PRB_HEAD")" = "Loki 10 engine, PR target: origin/main, base: main" ] && [ "$(sed -n 2p <<< "$PRB_HEAD" | cut -c1-6)" = "model " ] && ! grep -q 'no dollar cap\|downgrade:' <<< "$PRB_HEAD" \
    && ok "PR-BASE e: the header is at most three lines: target and base, then the model; the no-cap note and downgrades are not in it" || { bad "PR-BASE e: header:"; printf '%s\n' "$PRB_HEAD" | sed 's/^/    | /'; }
[ "$(awk '{ if (length($0) > m) m = length($0) } END { print (m <= 130) ? "short" : m }' <<< "$PRB_HEAD")" = short ] && ok "PR-BASE e: no header line is longer than 130 characters" || bad "PR-BASE e: a header line is too long"
prb_same "PR-BASE e"
# ---------------------------------------------------------------- PR-BASE end
# ---------------------------------------------------------------- DEEP-POST (FireLater#24 PRs #40 to #43): the poster, not the credential-less worker, posts the deep-verify status
cat > "$T/fl24-deeppost.ts" <<'TS'
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
const root = process.argv[2]!, T = process.argv[3]!;
const dp = await import(root + "/loki-ts/src/engine10/stages/deep.ts"), sup = await import(root + "/loki-ts/src/engine10/supervisor.ts");
const res = (name: string, pass: boolean) => console.log((pass ? "OK " : "NO ") + name);
const R = join(T, "dpost"); rmSync(R, { recursive: true, force: true });
const id = "e10-20261114T215737Z-c8f5", run = join(R, ".loki/runs", id); mkdirSync(run, { recursive: true });
const stub = join(R, "push.sh"), log = join(R, "push.log");
writeFileSync(stub, '#!/bin/bash\nprintf "%s|" "$@" >> "$STUB_LOG"; printf "pinned=%s\\n" "$_LOKI_PINNED_ORIGIN" >> "$STUB_LOG"\n');
const sha = "c1be166dcccfd3cf1f425a54f8115599a837a24a";
writeFileSync(join(run, "receipt.json"), JSON.stringify({ run_id: id, head_sha: sha }));
writeFileSync(join(run, "events.jsonl"), JSON.stringify({ type: "pr.opened", data: { url: "https://github.com/o/r/pull/40" } }) + "\n");
const cwd0 = process.cwd(); process.chdir(R);
const sleeper = (s: number) => spawn("sleep", [String(s)], { stdio: "ignore" });
try {
  // the worker is still running: the poster waits for it, then reads the addendum it wrote
  const w = sleeper(1); setTimeout(() => writeFileSync(join(run, "receipt-addendum-1.json"), JSON.stringify({ run_id: id, status_state: "success", checks: [{ name: "full suite: api", result: "pass" }], not_proven: [] })), 300);
  const t0 = Date.now(), rc = await dp.deepPost([id, String(w.pid), "https://github.com/o/r.git"], { pushScriptPath: stub, pushExtraEnv: { STUB_LOG: log }, pollMs: 100 });
  const l = readFileSync(log, "utf8");
  res("DEEP-POST waits for the worker pid before posting", Date.now() - t0 >= 800);
  res("DEEP-POST posts the comment to the PR from the pr.opened event", l.includes("comment|40|") && existsSync(join(run, "deep-comment.md")) && readFileSync(join(run, "deep-comment.md"), "utf8").includes("deep verify: success"));
  res("DEEP-POST posts the final status for the sealed head sha with the addendum's state", l.includes(`status|${sha}|success|`) && rc === 0);
  res("DEEP-POST passes the pinned origin to the push script", l.includes("pinned=https://github.com/o/r.git"));
  // the worker died without an addendum: the status is error, never left pending
  rmSync(join(run, "receipt-addendum-1.json")); writeFileSync(log, "");
  const w2 = sleeper(0); await new Promise((r) => w2.on("exit", r));
  await dp.deepPost([id, String(w2.pid), "https://github.com/o/r.git"], { pushScriptPath: stub, pushExtraEnv: { STUB_LOG: log }, pollMs: 50 });
  res("DEEP-POST a worker that wrote no addendum gets status error, not pending", readFileSync(log, "utf8").includes(`status|${sha}|error|`));
  writeFileSync(join(run, "receipt-addendum-1.json"), JSON.stringify({ run_id: "e10-other", status_state: "success", checks: [] })); writeFileSync(log, "");
  await dp.deepPost([id, String(w2.pid), "https://github.com/o/r.git"], { pushScriptPath: stub, pushExtraEnv: { STUB_LOG: log }, pollMs: 50 });
  res("DEEP-POST an addendum of another run is never trusted (error)", readFileSync(log, "utf8").includes(`status|${sha}|error|`));
  res("DEEP-POST bad arguments exit 2 and post nothing", (await dp.deepPost(["../x", "1", ""], {})) === 2);
  // NO-DEFAULT-BUDGET (fable-planner review): with no cap the wait still ends. An unrelated long-lived process on the pid, with the worker's addendum written, posts after the grace.
  writeFileSync(join(run, "receipt-addendum-1.json"), JSON.stringify({ run_id: id, status_state: "success", checks: [], not_proven: [] })); writeFileSync(log, "");
  const other = sleeper(60), tq = Date.now(); await dp.deepPost([id, String(other.pid), "https://github.com/o/r.git"], { pushScriptPath: stub, pushExtraEnv: { STUB_LOG: log }, pollMs: 50, waitCapMs: Infinity, addendumGraceMs: 300 }); other.kill();
  res("DEEP-POST with no wait cap a pid that never exits is left once the addendum has existed for the grace, and the status is posted", Date.now() - tq < 10_000 && readFileSync(log, "utf8").includes(`status|${sha}|success|`));
} finally { process.chdir(cwd0); }
const a = sup.deepPostArgv(["/bun", "--smol", "/cli.ts", "engine10", "deep-worker", id, "claude", "sonnet"], "https://github.com/o/r.git", 4242);
res("DEEP-POST argv reuses the runtime and CLI with run id, worker pid and origin", JSON.stringify(a) === JSON.stringify(["/bun", "--smol", "/cli.ts", "engine10", "deep-post", id, "4242", "https://github.com/o/r.git"]));
{ const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [], ev: { type: string; data: Record<string, unknown> }[] = [];
  const fake = (cmd: string, args: string[], o: { env: NodeJS.ProcessEnv }) => { calls.push({ cmd, args, env: o.env }); return 100 + calls.length; };
  const worker = { GH_TOKEN: "ghp_LOKIWITHHELDsentinelX", PATH: "/bin" }, real = { GH_TOKEN: "real-token", PATH: "/bin" };
  const np = sup.spawnDeep(["/bun", "/cli.ts", "engine10", "deep-worker", id, "claude", "sonnet"], "https://github.com/o/r.git", { workerEnv: worker, env: real, repoDir: R, append: (e) => ev.push(e), spawn: fake as never });
  const w = calls.find((c) => c.args.includes("deep-worker")), p = calls.find((c) => c.args.includes("deep-post"));
  res("DEEP-POST the worker gets the withheld env plus LOKI_E10_DEEP_POSTER=1; the poster gets the supervisor env", !!w && w.env.GH_TOKEN === worker.GH_TOKEN && w.env.LOKI_E10_DEEP_POSTER === "1" && !!p && p.env.GH_TOKEN === "real-token" && p.args.includes(String(101)) && np.length === 0);
  const ds = ev.filter((e) => e.type === "deep.started");
  res("DEEP-POST deep.started is recorded for the worker, then for the poster last", ds.length === 2 && ds[0]!.data.pid === 101 && ds[1]!.data.pid === 102 && ds[1]!.data.poster === true);
  calls.length = 0; ev.length = 0;
  sup.spawnDeep(["/bun", "/cli.ts", "engine10", "deep-worker", id, "claude", "sonnet"], "o", { workerEnv: worker, env: { ...real, LOKI_E10_DEEP_POST: "0" }, repoDir: R, append: (e) => ev.push(e), spawn: fake as never });
  res("DEEP-POST =0 spawns the worker alone without the poster flag", calls.length === 1 && calls[0]!.env.LOKI_E10_DEEP_POSTER === undefined && ev.filter((e) => e.type === "deep.started").length === 1); }
res("DEEP-POST on by default, =0 opts out", sup.deepPostOn({}) && !sup.deepPostOn({ LOKI_E10_DEEP_POST: "0" }));
rmSync(R, { recursive: true, force: true });
TS
out="$(cd "$ROOT/loki-ts" && bun "$T/fl24-deeppost.ts" "$ROOT" "$T" 2>&1; echo "EXIT $?")"
grep -q '^EXIT 0$' <<< "$out" || bad "fl24-deeppost unit script crashed or exited non-zero"
[ "$(printf '%s\n' "$out" | grep -c '^OK ')" = 13 ] || bad "fl24-deeppost unit script produced $(printf '%s\n' "$out" | grep -c '^OK ') passing legs, want 13"
while IFS= read -r line; do
    case "$line" in "OK "*) ok "${line#OK }" ;; "NO "*) bad "${line#NO }" ;; esac
done <<< "$out"

# ---------------------------------------------------------------- RUN-DEADLINE (dev4 cap kills): an outer deadline becomes the fixed run cap, and the run seals before it
cat > "$T/deadline.ts" <<'TS'
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = process.argv[2]!;
const rc = await import(root + "/loki-ts/src/util/run_cap.ts"), mc = await import(root + "/loki-ts/src/engine10/machine.ts");
const res = (name: string, pass: boolean) => console.log((pass ? "OK " : "NO ") + name);
const d = mkdtempSync(join(tmpdir(), "dl-"));
try {
  res("RUN-DEADLINE unset changes nothing (the sized default cap)", rc.deadlineCapS({}, 5) === undefined && rc.resolveRunCapS(d, true, {}).fixedS === undefined);
  res("RUN-DEADLINE the cap is the time left of the deadline minus the margin", rc.deadlineCapS({ LOKI_RUN_DEADLINE_S: "1200" }, 5) === 1165);
  const r = rc.resolveRunCapS(d, true, { LOKI_RUN_DEADLINE_S: "1200" });
  res("RUN-DEADLINE it is a fixed cap and the ceiling (never resized past it)", r.fixedS !== undefined && r.fixedS <= 1170 && r.ceilingS === r.fixedS && r.capS === r.fixedS);
  res("RUN-DEADLINE a smaller explicit cap wins; a larger one is held to the deadline", rc.resolveRunCapS(d, true, { LOKI_RUN_DEADLINE_S: "1200", LOKI_E10_CAP_S: "600" }).capS === 600 && rc.resolveRunCapS(d, true, { LOKI_RUN_DEADLINE_S: "1200", LOKI_E10_CAP_S: "3000" }).capS <= 1170);
  res("RUN-DEADLINE the soft cap seals at least a minute before the deadline", mc.softCapS(1165) <= 1200 - 60);
  res("RUN-DEADLINE a bad value is ignored (warned), a tiny one keeps the minimum cap", rc.deadlineCapS({ LOKI_RUN_DEADLINE_S: "soon" }, 0) === undefined && rc.deadlineCapS({ LOKI_RUN_DEADLINE_S: "20" }, 0) === rc.DEADLINE_MIN_CAP_S);
} finally { rmSync(d, { recursive: true, force: true }); }
TS
out="$(cd "$ROOT/loki-ts" && bun "$T/deadline.ts" "$ROOT" 2>&1; echo "EXIT $?")"
grep -q '^EXIT 0$' <<< "$out" || bad "deadline unit script crashed or exited non-zero"
[ "$(printf '%s\n' "$out" | grep -c '^OK ')" = 6 ] || bad "deadline unit script produced $(printf '%s\n' "$out" | grep -c '^OK ') passing legs, want 6"
while IFS= read -r line; do
    case "$line" in "OK "*) ok "${line#OK }" ;; "NO "*) bad "${line#NO }" ;; esac
done <<< "$out"
# End to end: a 95 s deadline with an implement session that would sleep 200 s. The run must seal a receipt (cap.hit) and exit before the deadline.
DLTO=(${TO[@]+"${TO[@]}"}); DL0=$(date +%s); TO=(LOKI_RUN_DEADLINE_S=95 E2E_STUB_SLEEP=200 ${DLTO[@]+"${DLTO[@]}"}); run_engine done; TO=(${DLTO[@]+"${DLTO[@]}"}); DLW=$(( $(date +%s) - DL0 ))
[ "$DLW" -lt 95 ] && ok "RUN-DEADLINE the run ended inside its 95 s deadline (${DLW}s)" || bad "RUN-DEADLINE the run took ${DLW}s against a 95 s deadline"
[ -n "$RUNDIR" ] && [ -f "$RUNDIR/receipt.json" ] && ok "RUN-DEADLINE a receipt was sealed when time ran out" || { bad "RUN-DEADLINE no receipt at the deadline"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
[ -n "$RUNDIR" ] && grep -q '"cap.hit"' "$RUNDIR/events.jsonl" 2>/dev/null && ok "RUN-DEADLINE cap.hit recorded (time ran out, not a kill)" || bad "RUN-DEADLINE no cap.hit event"
# ---------------------------------------------------------------- WATCHDOG (dev4 gitoxide): a silence with no worker event is recorded, naming the running processes
cat > "$T/wd.ts" <<'TS'
import { spawn } from "node:child_process";
const root = process.argv[2]!;
const sv = await import(root + "/loki-ts/src/engine10/supervisor.ts");
const res = (name: string, pass: boolean) => console.log((pass ? "OK " : "NO ") + name);
const w = sv.silenceWatch(120, 0);
w.event("implement", "session.ended", 10_000);
res("WATCHDOG nothing is due before 120 s of silence", w.due(129_000) === null);
const d = w.due(131_000);
res("WATCHDOG one event is due at 120 s of silence, naming the last stage and event", !!d && d.stage === "implement" && d.lastType === "session.ended" && d.silentS === 121);
res("WATCHDOG the next one is due one interval later, not every tick", w.due(140_000) === null && w.due(252_000) !== null);
w.event("verify", "stage.started", 300_000);
res("WATCHDOG a worker event resets the silence", w.due(400_000) === null);
res("WATCHDOG 0 turns it off; the default is 120 s", sv.silenceWatch(0, 0).due(10_000_000) === null && sv.watchdogSilentS({}) === 120 && sv.watchdogSilentS({ LOKI_E10_WATCHDOG_SILENT_S: "0" }) === 0);
const child = spawn("sleep", ["5"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 200));
const names = sv.descendantNames(process.pid);
child.kill();
res("WATCHDOG it names the processes running under the supervisor, without arguments", names.includes("sleep") && !names.some((n: string) => n.includes(" ")));
TS
out="$(cd "$ROOT/loki-ts" && bun "$T/wd.ts" "$ROOT" 2>&1; echo "EXIT $?")"
grep -q '^EXIT 0$' <<< "$out" || bad "wd unit script crashed or exited non-zero"
[ "$(printf '%s\n' "$out" | grep -c '^OK ')" = 6 ] || bad "wd unit script produced $(printf '%s\n' "$out" | grep -c '^OK ') passing legs, want 6"
while IFS= read -r line; do
    case "$line" in "OK "*) ok "${line#OK }" ;; "NO "*) bad "${line#NO }" ;; esac
done <<< "$out"
# End to end: a 20 s implement session with no heartbeat yet and a 2 s watchdog: the log carries watchdog.silent naming processes, and the run still delivers.
WDTO=(${TO[@]+"${TO[@]}"}); TO=(LOKI_E10_WATCHDOG_SILENT_S=2 E2E_STUB_SLEEP=20 ${WDTO[@]+"${WDTO[@]}"}); run_engine done; TO=(${WDTO[@]+"${WDTO[@]}"})
wd="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys
ev=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
w=[e for e in ev if e.get("type")=="watchdog.silent"]
print(len(w), w[0]["stage"] if w else "-", len(w[0]["data"].get("processes") or []) if w else 0)' "$RUNDIR/events.jsonl" 2>/dev/null)"
case "$wd" in 0*|"") bad "WATCHDOG no watchdog.silent event in a 20 s silent session: '$wd'" ;; *) set -- $wd; [ "$2" = implement ] && [ "$3" -gt 0 ] && ok "WATCHDOG the silent implement session is recorded ($1 event(s)) with the processes running" || bad "WATCHDOG event facts: $wd" ;; esac
[ "$(outcome)" = VERIFIED ] && ok "WATCHDOG recording a silence changes nothing else (VERIFIED)" || { bad "WATCHDOG outcome is '$(outcome)'"; printf '%s\n' "$OUT" | tail -6 | sed 's/^/    | /'; }

# ---------------------------------------------------------------- BACKSTOP-SEAL (dev4 gitoxide on 11.141.5): a worker the backstop kills before it seals still leaves a receipt
# A 95 s deadline (cap about 64 s) and a worker whose event loop is blocked for 120 s after its implement session, so its own soft cap never fires: the supervisor's
# backstop kills it, then one seal pass seals the current tree as PARTIAL "time ran out", inside the deadline. =0 keeps the old no-receipt ending.
BSTO=(${TO[@]+"${TO[@]}"}); BS0=$(date +%s); TO=(LOKI_RUN_DEADLINE_S=95 LOKI_E10_TEST_BLOCK_AFTER_SESSION_MS=120000 ${BSTO[@]+"${BSTO[@]}"}); run_engine done; TO=(${BSTO[@]+"${BSTO[@]}"}); BSW=$(( $(date +%s) - BS0 ))
[ "$BSW" -lt 95 ] && ok "BACKSTOP-SEAL the run ended inside its 95 s deadline (${BSW}s)" || bad "BACKSTOP-SEAL the run took ${BSW}s against a 95 s deadline"
if [ -n "$RUNDIR" ] && [ -f "$RUNDIR/receipt.json" ]; then
    ok "BACKSTOP-SEAL a receipt exists after the backstop kill"
    bsv="$(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["verdict"], any(n.startswith("time ran out") for n in r.get("not_proven",[])))' "$RUNDIR/receipt.json")"
    [ "$bsv" = "PARTIAL True" ] && ok "BACKSTOP-SEAL the receipt is PARTIAL with the time-ran-out reason" || bad "BACKSTOP-SEAL receipt facts: $bsv"
    grep -q 'export function multiply' "$REPO/calc.ts" 2>/dev/null || git -C "$REPO" show HEAD:calc.ts 2>/dev/null | grep -q 'export function multiply' && ok "BACKSTOP-SEAL the sealed tree holds the session's change" || bad "BACKSTOP-SEAL the change is missing from the sealed tree"
else bad "BACKSTOP-SEAL no receipt after the backstop kill"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; fi

# ---- RW-03 VERIFIED FLAG on the stub (unit 2 step 2) ----
# `--verified` reaches the engine through bin/loki and the route: the start line says verified mode is on, the receipt carries verified_mode, and the
# label and exit code are those of the same run without the flag. Without the flag the start line and the receipt carry nothing of it.
# Planted defects (each reverted): autonomy/route.sh drops --verified from the engine flags (the `loki start` run exits 2 with no receipt);
# supervisor.ts ignores --verified (unknown flag, exit 2); seal.ts drops verifiedReceiptBlock (no verified_mode on the flagged run).
rw3_vm() { python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); v=r.get("verified_mode"); print(r.get("verdict"), "block" if v else "none", (v or {}).get("bounds", {}).get("rounds", "-"))' "$RUNDIR/receipt.json" 2>/dev/null || echo "no-receipt"; }
run_engine done --verified
RW3V="$RC $(rw3_vm) $(grep -c 'verified mode: ' <<< "$OUT")"
run_engine done
RW3P="$RC $(rw3_vm) $(grep -c 'verified mode: ' <<< "$OUT")"
LOKI_VERIFIED=1 run_engine done
RW3E="$RC $(rw3_vm) $(grep -c 'verified mode: ' <<< "$OUT")"
E2E_VERB=start run_engine done --verified # through `loki start`, where autonomy/route.sh decides which flags reach the engine
RW3S="$RC $(rw3_vm) $(grep -c 'verified mode: ' <<< "$OUT")"
# NO-DEFAULT-BUDGET: the --verified bounds have no default (closure.ts verifiedBounds), so the block records rounds as null (None), never Loki's old 3.
[ "$RW3V" = "0 VERIFIED block None 1" ] && [ "$RW3P" = "0 VERIFIED none - 0" ] && [ "$RW3E" = "0 VERIFIED block None 1" ] && [ "$RW3S" = "0 VERIFIED block None 1" ] \
    && ok "rw-03: --verified and LOKI_VERIFIED=1 are said on the start line and recorded in the receipt; label and exit code are those of the plain run; a plain run carries nothing of it" \
    || bad "rw-03 verified flag: flag '$RW3V' plain '$RW3P' env '$RW3E' start '$RW3S'"
unset -f rw3_vm
# ---- end RW-03 step 2 ----

# ---- RW-02 ONE ROAD: a text task that carries its own acceptance list takes the proof and acceptance road an issue takes ------------------------------
# Stub runs, no model. The wrapper below is the fixture stub plus what a real session does on this road: it leaves $LOKI_SCRATCH/loki-proof.sh (a file named
# proof.sh in the leg's config directory), and, for the guard leg, cuts its own copy of the acceptance lines down to one.
#   no-script:  a text task with an acceptance list whose session leaves no proof script is never VERIFIED, even when the acceptance check, a model reading
#               the diff and the reply, marks every line MET.
#   proved:     the same task with a proof script whose checks pass in Loki's own run is VERIFIED, each line met by count.
#   failing:    one failing check in Loki's own run, beside a passing check for the same line, keeps the label below VERIFIED and that line unmet.
#   guard:      the lines are fixed before the session starts: a session that rewrites $LOKI_SCRATCH/acceptance.txt to one line and proves only that one
#               still faces both lines, and is not VERIFIED.
#   prose:      the same text with no list stays on the plain road exactly as before (no lines, no proof brief, no plan, the sessions it had). Only under
#               LOKI_E10_ONE_ROAD=all does it take the road, with the title line as item 1 and no plan session; a stand-in line never holds a label.
#   short:      a task at or under the small bar keeps the fast road.
#   spec:       a file that sizes large by structure (a spec with several deliverables) keeps the road it had.
#   issue json: LOKI_E10_ISSUE_JSON with a title and body (beside a positional file, and beside a short positional task) gives the issue's own lines and the
#               issue time cap rule; with a prose body, the title line.
#   cap:        a text task on the road is resized to the issue floor (2400 s); every other text task stays at 900 s.
#   resume:     a road run cut in implement and started again is still on the road.
# Model calls per run, read from the stub's log by the legs below (implement = one implement turn; linecheck = one tool-less acceptance check; review = the
# independent review session):
#   plain road (prose, short, opt-outs):            implement implement                                    2 calls, as on main
#   listed text task, proof script left, passing:   implement linecheck review implement linecheck         5 calls: +1 review session, +2 checks
#   listed text task, no proof script:              implement implement implement linecheck                4 calls: +1 implement turn (the request for the script), +1 check
#   listed text task, one check failing:            implement x5, linecheck                                6 calls: +3 implement turns (the hand-backs), +1 check
#   prose issue, no proof script, stand-in on/off:  implement x3 linecheck / implement x3                  the stand-in adds 1 check
#   prose issue, proof script left, stand-in on:    implement linecheck review implement linecheck         against implement implement with it off: +1 review session, +2 checks
# Plants (each makes the named leg fail):
#   R1. proof_rerun.ts noOwnProofNotes: return [] always (no-script reads VERIFIED).
#   R2. proof_rerun.ts ruleStatus: `e.proved > 0 && e.failed === 0` -> `e.proved > 0` in both tests (failing reads line 2 met). This is the count rule on
#       main; the leg shows a listed text task is under it.
#   R3. supervisor.ts workRoad: drop `deliverables(task, []).large` (spec reads road work); drop the small bar (short reads road work); drop the list test
#       (prose reads road work).
#   R4. run_cap.ts issueCapRule: drop `workRoadOn(env)` (cap reads none for the text task); drop the LOKI_E10_ISSUE_JSON test (issue json reads no cap).
#   R5. intake.ts: `source === "issue" ? issueAcceptance(task) : []` as before (no-script and proved read 0 lines).
#   R6. proof_rerun.ts fallbackLines: plan lines only (prose =all and issue json prose read no line).
#   R8. types.ts issueRunBrief: `source === "text"` without the run's flag (short, spec, prose, off read the proof brief).
#   R11. supervisor.ts runSupervisor: drop the line that sets the worker's flag from run.started's road (the resumed half reads no proof re-run).
#   R13. supervisor.ts workRoad: drop the provider and prove-by-running test (prove-by-running off reads road work and PARTIAL).
RWD="$T/rw02"; mkdir -p "$RWD/bin" "$RWD/cfg"
cat > "$RWD/bin/claude" <<RWSTUB
#!/bin/bash
if [ "\${LOKI_E10_STAGE:-}" = implement ] && [ -n "\${LOKI_SCRATCH:-}" ] && [ -d "\$LOKI_SCRATCH" ]; then
  [ -f "$RWD/cfg/proof.sh" ] && cp "$RWD/cfg/proof.sh" "\$LOKI_SCRATCH/loki-proof.sh"
  if [ -f "$RWD/cfg/shrink" ] && [ -f "\$LOKI_SCRATCH/acceptance.txt" ]; then head -1 "\$LOKI_SCRATCH/acceptance.txt" > "\$LOKI_SCRATCH/acceptance.new" && mv "\$LOKI_SCRATCH/acceptance.new" "\$LOKI_SCRATCH/acceptance.txt"; fi
fi
exec "$FIX/bin/claude" "\$@"
RWSTUB
chmod +x "$RWD/bin/claude"
RW_PAD="$(printf 'The function must live beside add() in calc.ts and follow the same style. %.0s' 1 2 3 4 5 6 7 8 9)"
RW_HEAD="# Add a multiply(a, b) function to calc.ts"
RW_PROBLEM="calc.ts has add() but no way to multiply two numbers, and callers loop over add() instead. $RW_PAD"
printf '%s\n\n## Problem\n\n%s\n\n## Acceptance criteria\n\n- multiply(2, 3) returns 6\n- multiply(-2, 3) returns -6\n' "$RW_HEAD" "$RW_PROBLEM" > "$RWD/list.md"
printf '%s\n\n## Problem\n\n%s\n' "$RW_HEAD" "$RW_PROBLEM" > "$RWD/prose.md"
printf '# Calculator product\n\n%s\n\n## Requirements\n\n- a multiply function\n- a divide function\n- a subtract function\n- a power function\n\n## Acceptance criteria\n\n- [ ] multiply works\n- [ ] divide works\n- [ ] subtract works\n- [ ] power works\n' "$RW_PROBLEM" > "$RWD/spec.md"
python3 -I -c 'import json, sys; json.dump({"title": "Add a multiply(a, b) function to calc.ts", "body": "## Problem\n\n" + sys.argv[2] + "\n\n## Acceptance criteria\n\n- multiply(2, 3) returns 6\n- multiply(-2, 3) returns -6\n"}, open(sys.argv[1], "w"))' "$RWD/issue.json" "$RW_PROBLEM"
printf 'MET 1: the diff adds multiply to calc.ts\nMET 2: the diff adds multiply to calc.ts\n' > "$RWD/met.txt"
rw_proof() { # rw_proof <check for item 1> <check for item 2 or -> [second check for item 2]: the session's proof script for the next run; rw_proof - removes it
    rm -f "$RWD/cfg/proof.sh" "$RWD/cfg/shrink"; [ "$1" = "-" ] && return 0
    { printf '#!/bin/bash\n. "$LOKI_SCRATCH/loki-check.sh"\nloki_cmd 1 "item one" %s\n' "$1"; [ "${2:--}" = "-" ] || printf 'loki_cmd 2 "item two" %s\n' "$2"; [ -z "${3:-}" ] || printf 'loki_cmd 2 "item two, second check" %s\n' "$3"; } > "$RWD/cfg/proof.sh"
}
rw_engine() { # rw_engine <name> <task or file> [VAR=value...] -> RWOUT, RWRUN (run dir), RWP (prompt log prefix)
    local name="$1" task="$2" d; shift 2
    if [ -n "${RW_REUSE:-}" ]; then d="$RW_REUSE"; else # RW_REUSE=<an earlier run's directory>: the same repository again (the resume leg)
        d="$(mktemp -d "$T/rw.$name.XXXXXX")"; cp -R "$FIX/repo" "$d/repo"
        git -C "$d/repo" init -q -b main; git -C "$d/repo" config user.name e2e; git -C "$d/repo" config user.email e2e@example.invalid
        git -C "$d/repo" add calc.ts calc.test.ts bunfig.toml; git -C "$d/repo" commit -q -m base
    fi
    RWDIR="$d"; RWP="$d/prompt"
    # LOKI_E10_DEFAULT_BUDGETS=1 below: the RW-02 legs read the issue cap rule (cap=2400), which sizes only a run cap; with no budget there is none (NO-DEFAULT-BUDGET)
    RWOUT="$(cd "$d/repo" && env -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_E10_ISSUE_JSON -u LOKI_E10_WORK_ROAD LOKI_E10_DEFAULT_BUDGETS=1 LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$RWD/bin/claude" PATH="$FIX/bin:$PATH" \
        E2E_STUB_MODE=done E2E_STUB_LOG="$d/stub.log" E2E_STUB_PROMPT_LOG="$RWP" E2E_STUB_LINECHECK_FILE="$RWD/met.txt" LOKI_RECEIPT_SIGNING_KEY_FILE="$d/k.pem" "$@" \
        ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" start "$task" --no-pr </dev/null 2>&1)"
    RWRUN="$(dirname "$(ls "$d"/repo/.loki/runs/*/events.jsonl 2>/dev/null | head -1)")"; RWSTAGES="$(tr '\n' ' ' < "$d/stub.log" 2>/dev/null)"
    echo "    sessions $name: $RWSTAGES"
}
rw_facts() { python3 -I - "$RWRUN" <<'RWPY'
import json, os, sys
rd = sys.argv[1]
try: ev = [json.loads(l) for l in open(os.path.join(rd, "events.jsonl"))]
except Exception: print("no events"); sys.exit(0)
try: r = json.load(open(os.path.join(rd, "receipt.json")))
except Exception: r = {}
def first(t, st=None): return next((e["data"] for e in ev if e["type"] == t and (st is None or e.get("stage") == st)), {})
started, intake, plan = first("run.started"), first("stage.completed", "intake"), first("stage.completed", "plan")
ia = r.get("issue_acceptance") or []
cap = [e["data"].get("cap_s") for e in ev if e["type"] == "cap.sized"]
print(" ".join([
    str(r.get("verdict")), "road=" + str(started.get("road")), "source=" + str(intake.get("source")), "lines=" + str(len(intake.get("issue_acceptance") or [])),
    "receipt=" + ",".join(str(x.get("status")) for x in ia) if ia else "receipt=none", "own=" + str(sum(1 for x in ia if str(x.get("evidence", "")).startswith("Loki's own run"))),
    "reruns=" + ("yes" if any(e["type"] == "proof.rerun" for e in ev) else "no"), "noscript=" + ("yes" if any(n.startswith("no proof script:") for n in r.get("not_proven", [])) else "no"),
    "plan=" + ("ran" if plan else "skipped"), "src=" + str(r.get("issue_acceptance_source")), "cap=" + (str(cap[-1]) if cap else "none"),
]))
RWPY
}
rw_proof -
rw_engine noscript "$RWD/list.md"; RWF="$(rw_facts)"
[ "$RWF" = "PARTIAL road=work source=text lines=2 receipt=met,met own=0 reruns=no noscript=yes plan=skipped src=issue cap=2400" ] \
&& [ "$RWSTAGES" = "implement implement implement linecheck " ] \
    && ok "RW-02 no-script: a text task whose session leaves no proof script is PARTIAL with the reason, though the acceptance check marked both lines MET; it is on the road (2 lines from its own list, cap 2400); 4 model calls ($RWSTAGES)" || bad "RW-02 no-script gave: $RWF; sessions '$RWSTAGES'"
grep -q 'loki-proof.sh' "$RWP.implement0" && grep -q 'acceptance.txt' "$RWP.implement0" && ok "RW-02 no-script: the implement brief carries the proof script instructions an issue run gets" || bad "RW-02 no-script: the implement brief lacks the proof script instructions"
rw_proof 'grep -q "export function multiply" calc.ts' 'grep -q "export function multiply" calc.ts'
rw_engine proved "$RWD/list.md"; RWF="$(rw_facts)"
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22. R2-5: the proof script only reads calc.ts (a change to code), so the run reads PARTIAL.
[ "$RWF" = "PARTIAL road=work source=text lines=2 receipt=met,met own=2 reruns=yes noscript=no plan=skipped src=issue cap=2400" ] \
&& [ "$RWSTAGES" = "implement linecheck review implement linecheck " ] \
    && ok "RW-02 proved: the same text task with a proof script that passes in Loki's own run is PARTIAL (the script only reads calc.ts), both lines met by Loki's own count; 5 model calls ($RWSTAGES)" || bad "RW-02 proved gave: $RWF; sessions '$RWSTAGES' ($(grep -E '^(Outcome|NOT PROVEN)' <<< "$RWOUT" | tr '\n' ' ' | cut -c1-600))"
rw_proof 'grep -q "export function multiply" calc.ts' 'grep -q "export function multiply" calc.ts' 'false' # line 2 has one passing and one failing check
rw_engine failing "$RWD/list.md"; RWF="$(rw_facts)"
[ "$RWF" = "PARTIAL road=work source=text lines=2 receipt=met,unmet own=1 reruns=yes noscript=no plan=skipped src=issue cap=2400" ] \
    && ok "RW-02 failing: one failing check in Loki's own run keeps a text task below VERIFIED and its line unmet" || bad "RW-02 failing gave: $RWF"
rw_proof 'grep -q "export function multiply" calc.ts' -; : > "$RWD/cfg/shrink"
rw_engine guard "$RWD/list.md"; RWF="$(rw_facts)"
[ "$RWF" = "PARTIAL road=work source=text lines=2 receipt=met,unmet own=1 reruns=yes noscript=no plan=skipped src=issue cap=2400" ] \
    && ok "RW-02 guard: a session that cuts its copy of the acceptance lines to one and proves only that one still faces both lines and is not VERIFIED" || bad "RW-02 guard gave: $RWF"
rw_proof 'grep -q "export function multiply" calc.ts' -
rw_engine prose "$RWD/prose.md"; RWF="$(rw_facts)"
[ "$RWF" = "VERIFIED road=text source=text lines=0 receipt=none own=0 reruns=no noscript=no plan=skipped src=None cap=none" ] && ! grep -q 'loki-proof.sh' "$RWP.implement0" && [ "$RWSTAGES" = "implement implement " ] \
    && ok "RW-02 prose: a text task with no list stays on the plain road: no lines, no proof brief, no plan, cap unchanged, the two sessions it had ($RWSTAGES)" || bad "RW-02 prose gave: $RWF; sessions '$RWSTAGES'"
rw_engine prose-all "$RWD/prose.md" LOKI_E10_ONE_ROAD=all; RWF="$(rw_facts)"
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22. R2-5: the proof script only reads calc.ts (a change to code), so the run reads PARTIAL.
[ "$RWF" = "PARTIAL road=work source=text lines=0 receipt=met own=1 reruns=yes noscript=no plan=skipped src=title cap=2400" ] && ! grep -q plan <<< "$RWSTAGES" \
    && ok "RW-02 prose, LOKI_E10_ONE_ROAD=all: the title stands in as item 1 with no plan session, and Loki's own run counts for it (PARTIAL: the script only reads calc.ts)" || bad "RW-02 prose (=all) gave: $RWF; sessions '$RWSTAGES' ($(grep -E '^(Outcome|NOT PROVEN)' <<< "$RWOUT" | tr '\n' ' ' | cut -c1-600))"
rw_engine prose-all-off "$RWD/prose.md" LOKI_E10_ONE_ROAD=all LOKI_E10_TITLE_ACCEPTANCE=0; RWF="$(rw_facts)"
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22. R2-5: the proof script only reads calc.ts (a change to code), so the run reads PARTIAL.
[ "$RWF" = "PARTIAL road=work source=text lines=0 receipt=none own=0 reruns=yes noscript=no plan=skipped src=None cap=2400" ] \
    && ok "RW-02 prose, =all: LOKI_E10_TITLE_ACCEPTANCE=0 gives no stand-in line" || bad "RW-02 prose (=all, stand-in off) gave: $RWF"
rw_proof -
rw_engine prose-all-noscript "$RWD/prose.md" LOKI_E10_ONE_ROAD=all; RWF="$(rw_facts)"
[ "$RWF" = "VERIFIED road=work source=text lines=0 receipt=met own=0 reruns=no noscript=no plan=skipped src=title cap=2400" ] \
    && ok "RW-02 prose, =all, no proof script: a stand-in line never holds the label; the run keeps the label its checks gave it" || bad "RW-02 prose (=all, no script) gave: $RWF"
rw_proof -
rw_engine short "add a multiply(a, b) function to calc.ts"; RWF="$(rw_facts)"
[ "$RWF" = "VERIFIED road=text source=text lines=0 receipt=none own=0 reruns=no noscript=no plan=skipped src=None cap=none" ] && ! grep -q 'loki-proof.sh' "$RWP.implement0" \
    && ok "RW-02 short: a task under the small bar keeps the fast road: no lines, no proof brief, no plan, cap unchanged, VERIFIED as before" || bad "RW-02 short gave: $RWF"
rw_engine spec "$RWD/spec.md"; RWF="$(rw_facts)"
case "$RWF" in *" road=text source=text lines=0 receipt=none own=0 reruns=no noscript=no "*"src=None cap=none") ! grep -q 'loki-proof.sh' "$RWP.implement0" && ok "RW-02 spec: a file that sizes large by structure keeps the road it had (no lines, no proof brief, no issue cap)" || bad "RW-02 spec: the implement brief carries the proof instructions" ;; *) bad "RW-02 spec gave: $RWF" ;; esac
rw_engine off "$RWD/list.md" LOKI_E10_ONE_ROAD=0; RWF="$(rw_facts)"
[ "$RWF" = "VERIFIED road=text source=text lines=0 receipt=none own=0 reruns=no noscript=no plan=skipped src=None cap=none" ] && ok "RW-02 off: LOKI_E10_ONE_ROAD=0 keeps a text task on the plain road" || bad "RW-02 off gave: $RWF"
rw_proof 'grep -q "export function multiply" calc.ts' 'grep -q "export function multiply" calc.ts'
rw_engine json-file "$RWD/prose.md" LOKI_E10_ISSUE_JSON="$RWD/issue.json"; RWF="$(rw_facts)"
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22. R2-5: the proof script only reads calc.ts (a change to code), so the run reads PARTIAL.
[ "$RWF" = "PARTIAL road=issue source=issue lines=2 receipt=met,met own=2 reruns=yes noscript=no plan=skipped src=issue cap=2400" ] \
    && ok "RW-02 issue json: LOKI_E10_ISSUE_JSON beside a positional file gives the issue's two lines, the issue cap rule, and PARTIAL on Loki's own run (the script only reads calc.ts)" || bad "RW-02 issue json (file) gave: $RWF"
rw_engine json-short "add multiply to calc.ts" LOKI_E10_ISSUE_JSON="$RWD/issue.json"; RWF="$(rw_facts)"
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22. R2-5: the proof script only reads calc.ts (a change to code), so the run reads PARTIAL.
[ "$RWF" = "PARTIAL road=issue source=issue lines=2 receipt=met,met own=2 reruns=yes noscript=no plan=skipped src=issue cap=2400" ] \
    && ok "RW-02 issue json: the same with a short positional task" || bad "RW-02 issue json (short) gave: $RWF"
# The shape of the recorded run playwright 44124 "loki-haiku-issue-road" (11.152.0): a positional file plus LOKI_E10_ISSUE_JSON holding only a title and a prose
# body. There the plan was skipped, the run had no line, Loki's own proof run passed 2 checks that counted for nothing (proof.rerun statuses []), and the
# receipt had no acceptance table. Now the title line from intake's record is the one item (no plan session is added), and the passing check is counted for it.
python3 -I -c 'import json, sys; json.dump({"title": "Add a multiply(a, b) function to calc.ts", "body": "## Problem\n\n" + sys.argv[2]}, open(sys.argv[1], "w"))' "$RWD/issue-prose.json" "$RW_PROBLEM"
rw_proof 'grep -q "export function multiply" calc.ts' -
rw_engine json-prose "$RWD/prose.md" LOKI_E10_ISSUE_JSON="$RWD/issue-prose.json"; RWF="$(rw_facts)"
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22. R2-5: the proof script only reads calc.ts (a change to code), so the run reads PARTIAL.
[ "$RWF" = "PARTIAL road=issue source=issue lines=0 receipt=met own=1 reruns=yes noscript=no plan=skipped src=title cap=2400" ] && ! grep -q plan <<< "$RWSTAGES" \
    && ok "RW-02 issue json, prose: an issue file with no list has its title as the one line, with no plan session added, and Loki's own passing check is counted for it (PARTIAL: the script only reads calc.ts)" || bad "RW-02 issue json (prose) gave: $RWF"
rw_proof -
rw_engine json-prose-noscript "$RWD/prose.md" LOKI_E10_ISSUE_JSON="$RWD/issue-prose.json"; RWF="$(rw_facts)"; RWS_ON="$RWSTAGES"
rw_engine json-prose-off "$RWD/prose.md" LOKI_E10_ISSUE_JSON="$RWD/issue-prose.json" LOKI_E10_TITLE_ACCEPTANCE=0; RWF0="$(rw_facts)"; RWS_OFF="$RWSTAGES"
[ "$RWF" = "VERIFIED road=issue source=issue lines=0 receipt=met own=0 reruns=no noscript=no plan=skipped src=title cap=2400" ] && [ "$RWF0" = "VERIFIED road=issue source=issue lines=0 receipt=none own=0 reruns=no noscript=no plan=skipped src=None cap=2400" ] \
    && [ "$RWS_ON" = "implement implement implement linecheck " ] && [ "$RWS_OFF" = "implement implement implement " ] \
    && ok "RW-02 issue json, prose, no proof script: the stand-in line is read by the acceptance check and never holds the label; it adds one check call to the run ($RWS_ON against $RWS_OFF)" || bad "RW-02 issue json (prose, no script) gave: on '$RWF' [$RWS_ON] off '$RWF0' [$RWS_OFF]"
rw_engine prove-off "$RWD/list.md" LOKI_E10_PROVE_BY_RUNNING=0; RWF="$(rw_facts)"
[ "$RWF" = "VERIFIED road=text source=text lines=0 receipt=none own=0 reruns=no noscript=no plan=skipped src=None cap=none" ] && ! grep -q 'loki-proof.sh' "$RWP.implement0" \
    && ok "RW-02 prove-by-running off: a run that is never asked for a proof script is not on the road, gets no lines and is not held for leaving none" || bad "RW-02 prove-by-running off gave: $RWF"
# resume: a road run cut by a usage limit in implement, then started again, is still on the road in the resumed worker (lines counted, cap rule, VERIFIED on
# Loki's own run). Plant R11: supervisor.ts runSupervisor: drop the line that sets the worker's flag from run.started's road (the resumed half reads no lines).
rw_proof 'grep -q "export function multiply" calc.ts' 'grep -q "export function multiply" calc.ts'
rw_engine resume "$RWD/list.md" E2E_STUB_LIMIT=implement E2E_STUB_LIMIT_MARK="$T/rw-resume.mark"; RWCUT="$(grep -E '^Outcome:' <<< "$RWOUT" | tr -s ' ')"
RW_REUSE="$RWDIR" rw_engine resume2 "$RWD/list.md" E2E_STUB_LIMIT=implement E2E_STUB_LIMIT_MARK="$T/rw-resume.mark"; RWF="$(rw_facts)"
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22. R2-5: the proof script only reads calc.ts (a change to code), so the run reads PARTIAL.
[ "$RWCUT" = "Outcome: CANCELLED" ] && [ "$(ls "$RWDIR"/repo/.loki/runs | wc -l | tr -d ' ')" = 1 ] && [ "$RWF" = "PARTIAL road=work source=text lines=2 receipt=met,met own=2 reruns=yes noscript=no plan=skipped src=issue cap=2400" ] \
    && ok "RW-02 resume: a road run cut in implement and started again resumes the same run on the road and is PARTIAL on Loki's own count (the script only reads calc.ts)" || bad "RW-02 resume gave: cut '$RWCUT', runs $(ls "$RWDIR"/repo/.loki/runs 2>/dev/null | wc -l | tr -d ' '), $RWF ($(grep -E '^(Outcome|Reason|engine10:)' <<< "$RWOUT" | tr '\n' ' ' | cut -c1-500))"
rw_proof -
# ---- end RW-02 ----

# ---------------------------------------------------------------- NO-DEFAULT-BUDGET (founder 2026-11-18): Loki sets no time, round, turn, test-count or dollar budget
# by default; a run ends when it is done or makes no progress, always with a draft PR of what is done. Planted defects (each shown red, then reverted):
#   NB1. util/run_cap.ts resolveRunCapS: drop the no-limit return (the default cap comes back): "no user limit means no cap" goes red.
#   NB2. engine10/types.ts armTimer: drop the non-finite early return: the Infinity timer fires at once.
#   NB3. runner/watchdog.ts sessionKillsS: `noLimit ? SILENCE_KILL_S : 0` -> 0: the no-limit default leg goes red (the e2e stuck leg sets
#        LOKI_E10_STALL_KILL_S=20, so it tests the override and stayed green under the old plant).
#   NB4. engine10/machine.ts fix loop: drop the `stillRounds++`: the no-progress fix loop never ends (unit) .
#   NB5. e10ext/budget_cap.ts resolveCap: return DEFAULT_MAX_COST_USD with an API key: the no-default-dollar-cap leg goes red.
#   NB6. autonomy/route.sh: drop the --max-time arm: the --max-time dry-run leg goes red.
#   NB7. util/shell.ts: drop the implied silence guard for a non-finite timeout: the silent command is never stopped.
#   NB8. stages/seal.ts verdictOf: drop `&& !unattributedRed(o, c)`: the LIMIT-NOT-FAILED leg reads FAILED.
#   NB11. runner/repo_profile.ts baselineCmdS: drop the defaultBudgetsOn guard on the 300 s line (always 300): the intake-limit leg goes red.
#   NB12. runner/repo_profile.ts shellRunner: drop the no-limit branch (spawnSync with an Infinity timeout): the silent intake command is never stopped.
#   NB13. stages/prove.ts proveBudgetS: default 600 again: the prove leg goes red.  NB14. features/no_regression.ts nrdBudgetS: default 120 again: the NRD leg.
#   NB15. engine10/types.ts deepCapS: always DEEP_CAP_S: the worker-cap leg.  NB16. engine10/closure.ts boundOf: dflt always: the RW-03 bounds line.
#   NB17. util/conflict_resume.ts outstandingWords: keep the whole text as one item (no normalization): the rephrase leg goes red.
#   NB18. util/conflict_resume.ts continueMoved: drop `o.treeChanged &&`: the reason-only sequence reads moved.  NB19. drop the number comparison: the counts read no.
#   NB21. continueMoved: compare with the previous reply only (`seenNums` holds just the last tuple): the oscillating counts read moved every round.
#   NB20. stages/deep.ts deepPost: drop the addendum grace: the no-cap DEEP-POST leg waits out the 60 s sleeper.
#   G5-3. engine10/machine.ts newFailingIds: count base-red checks too: the new-ids leg goes red.
#   G5-6. engine10/machine.ts suiteOnlyStop: stop whenever only full suites are red (the old rule): the falling-ids case reads stop.
#   G5-9. util/conflict_resume.ts resumeToFinish: words never count once a measurement exists: the stepping leg ends at 2.
#   G5-11. engine10/machine.ts fixRoundMoved: drop the ran term: a round that makes a check run reads no progress.
#   G5-5. util/check_result.ts suiteSkipHolds: always true: the base-red-only suite holds again.
#   G5-4. util/conflict_resume.ts resumeToFinish: ignore o.measure (always the words rule): the measured-count leg goes red.
#   NB9. runner/repo_profile.ts asyncShellRunner: setTimeout(stop, timeoutMs) again: the no-limit base run is cut at once.
cat > "$T/nobudget.ts" <<'TS'
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = process.argv[2]!;
const ty = await import(root + "/loki-ts/src/engine10/types.ts"), rc = await import(root + "/loki-ts/src/util/run_cap.ts"), mc = await import(root + "/loki-ts/src/engine10/machine.ts");
const vf = await import(root + "/loki-ts/src/engine10/stages/verify.ts"), cr = await import(root + "/loki-ts/src/util/conflict_resume.ts"), sr = await import(root + "/loki-ts/src/features/self_review.ts");
const ep = await import(root + "/loki-ts/src/contrib/effort_policy.ts"), bc = await import(root + "/loki-ts/src/e10ext/budget_cap.ts"), sh = await import(root + "/loki-ts/src/util/shell.ts");
const wk = await import(root + "/loki-ts/src/engine10/worker.ts"), sv = await import(root + "/loki-ts/src/engine10/supervisor.ts"), wp = await import(root + "/loki-ts/src/runner/worker_proc.ts"), wd = await import(root + "/loki-ts/src/runner/watchdog.ts");
const res = (name: string, pass: boolean) => console.log((pass ? "OK " : "NO ") + name);
const B = { LOKI_E10_DEFAULT_BUDGETS: "1" };
const d = mkdtempSync(join(tmpdir(), "nb-"));
try {
  const r0 = rc.resolveRunCapS(d, true, {}), rb = rc.resolveRunCapS(d, true, B), ru = rc.resolveRunCapS(d, true, { LOKI_E10_CAP_S: "600" }), rbad = rc.resolveRunCapS(d, true, { LOKI_E10_CAP_S: "soon" });
  res("NO-DEFAULT-BUDGET no user limit means no cap and no ceiling; the control knob restores 900 s; a user cap is fixed; an unusable one fails closed to 900 s", r0.capS === Infinity && r0.ceilingS === Infinity && r0.fixedS === undefined && rb.capS === 900 && ru.capS === 600 && ru.fixedS === 600 && rbad.capS === 900);
  res("NO-DEFAULT-BUDGET the worker cap: unset is no limit, a set cap is that cap, --deep has no 2700 s cap unless budgets are on", wk.workerCapS(false, {}) === Infinity && wk.workerCapS(false, { LOKI_E10_CAP_S: "700" }) === 700 && wk.workerCapS(true, {}) === Infinity && wk.workerCapS(true, B) === ty.DEEP_CAP_S && ty.deepCapS({}) === Infinity && wk.workerCapS(false, B) === 900);
  const env: Record<string, string> = { LOKI_E10_CAP_S: "900", LOKI_E10_CAP_FIXED_S: "900" }; sv.applyCapEnv(env, Infinity, { fixedS: undefined });
  res("NO-DEFAULT-BUDGET no limit reaches the worker as an unset cap, never the string Infinity", !("LOKI_E10_CAP_S" in env) && !("LOKI_E10_CAP_FIXED_S" in env));
  let fired = 0; const t1 = ty.armTimer(() => fired++, Infinity), t2 = ty.armTimer(() => fired++, 2 ** 31 + 5), t3 = ty.armTimer(() => fired += 10, 5);
  await Bun.sleep(80); t1.clear(); t2.clear(); t3.clear();
  res("NO-DEFAULT-BUDGET armTimer: Infinity arms nothing, a delay past 2^31-1 ms does not fire at once (Bun fires a raw one after 1 ms), a short one fires", fired === 10);
  res("NO-DEFAULT-BUDGET verify has no maximum of Loki's own: none with no run cap, only the time left under a user's run cap, the user's LOKI_E10_VERIFY_MAX_S when set; the control knob restores 900 s", mc.verifyLimitFor(120, Infinity, 50, {}) === Infinity && mc.verifyLimitFor(120, Infinity, 50, { LOKI_E10_VERIFY_MAX_S: "77" }) === 77 && mc.verifyLimitFor(120, 99999, 0, {}) === 99999 - 150 && mc.verifyLimitFor(120, 99999, 0, B) === mc.VERIFY_MAX_S);
  res("NO-DEFAULT-BUDGET the suite timeout: none by default, 300 s with budgets, the user's value when set", vf.suiteTimeoutFor(undefined, 0, {}) === Infinity && vf.suiteTimeoutFor(undefined, 0, B) === 300_000 && vf.suiteTimeoutFor(undefined, 0, { LOKI_E10_SUITE_TIMEOUT_S: "42" }) === 42_000);
  res("NO-DEFAULT-BUDGET counts and turn caps are opt-in: continues, the continue dollar line, coverage, self-review and verified-finish turns", cr.continueMax({}) === Infinity && cr.continueMaxUsd({}) === Infinity && cr.coverageMaxTurns({}) === 0 && sr.selfReviewMaxTurns({}) === 0 && sr.verifiedFinishMaxTurns({}) === 0 && cr.continueMax(B) === 4 && cr.continueMaxUsd(B) === 5 && cr.coverageMaxTurns(B) === 10 && sr.selfReviewMaxTurns(B) === 12 && sr.verifiedFinishMaxTurns(B) === 8 && cr.continueMax({ LOKI_E10_CONTINUE_MAX: "2" }) === 2);
  const hi = ep.sessionCaps("implement", "claude-haiku-5-5", {}), hf = ep.sessionCaps("fix", "claude-haiku-5-5", {}), hb = ep.sessionCaps("implement", "claude-haiku-5-5", B);
  res("NO-DEFAULT-BUDGET the Haiku turn and token caps are opt-in; the fix session's no-edit rule (a no-progress stop) stays", hi === undefined && hf?.noEditByTurn === 8 && hf.turns === undefined && hb?.turns === 45);
  const e2: Record<string, string> = {}; wp.clampBashTimeoutEnv(e2, Infinity);
  res("NO-DEFAULT-BUDGET a session with no time limit gets no derived turn cap and keeps Claude's own Bash timeouts", !("LOKI_E10_MAX_TURNS" in e2) && e2["BASH_MAX_TIMEOUT_MS"] === "600000" && e2["BASH_DEFAULT_TIMEOUT_MS"] === "120000");
  const nf = mc.newFailingIds({ checks: [{ name: "pytest:a", result: "fail", ids: ["t1", "t2"] }, { name: "pytest:b", result: "fail" }, { name: "pytest:old", result: "fail", ids: ["t9"] }, { name: "pytest:env", result: "fail", owner: "harness" }, { name: "full suite: x", result: "fail", ids: ["s1"] }, { name: "pytest:c", result: "pass" }, { name: "pytest:d", result: "not_run" }], pre_red_checks: ["pytest:old"], holdout_failed: 1 });
  res("G5 fix-loop progress counts only NEW failing ids: base-red and harness-owned failures are left out, an id-less failing check counts once, each held-out failure once; the suite-only view keeps the full suite", nf.size === 5 && nf.has("pytest:a::t1") && nf.has("pytest:b") && !nf.has("pytest:old::t9") && !nf.has("pytest:env") && nf.has("holdout#1") && mc.newFailingIds({ checks: [{ name: "full suite: x", result: "fail", ids: ["s1"] }, { name: "pytest:a", result: "fail" }] }, true).size === 1);
  { const cr5 = await import(root + "/loki-ts/src/util/check_result.ts"), suite = (ids: string[], pre: string[]) => ({ checks: [{ name: "full suite: npm", result: "fail", ids }, { name: "pytest:t", result: "pass", n: 3 }], pre_red: pre });
    res("G5 the suite-skip note holds a run only when the skipped full-suite red has a NEW failing id: red only on base ids does not hold (oc63960), one new id does", !cr5.suiteSkipHolds(suite(["a", "b"], ["a", "b"])) && cr5.suiteSkipHolds(suite(["a", "c"], ["a"])) && !cr5.suiteSkipHolds({ ...suite(["a"], []), base_red_checks: ["full suite: npm"] })); }
  res("G5 the full-suite-only stop fires from round 2 only when the suite's new failing ids did not shrink: falling ids get the next round, flat or rising ids stop, round 1 is never stopped here", !mc.suiteOnlyStop(2, true, 3, 5) && mc.suiteOnlyStop(2, true, 5, 5) && mc.suiteOnlyStop(3, true, 6, 5) && !mc.suiteOnlyStop(1, true, 5, 5) && !mc.suiteOnlyStop(2, false, 5, 5));
  const ck = bc.resolveCap(null, d, { ANTHROPIC_API_KEY: "x" }), cs = bc.resolveCap(null, d, {}), cbad = bc.resolveCap(null, d, { LOKI_BUDGET_LIMIT: "lots" }), cflag = bc.resolveCap("5", d, { ANTHROPIC_API_KEY: "x" });
  res("NO-DEFAULT-BUDGET no default dollar cap with an API key; the start line says how to set one; a user cost limit is kept and an unusable one fails closed", "usd" in ck && ck.usd === 0 && bc.capNote(ck.usd, ck.source) === bc.NO_COST_LIMIT_NOTE && "usd" in cs && cs.usd === 0 && "error" in cbad && "usd" in cflag && cflag.usd === 5);
  const t0 = Date.now(), quiet = await sh.run(["sh", "-c", "sleep 20"], { timeoutMs: Infinity, silenceMs: 300 });
  const chatty = await sh.run(["sh", "-c", "for i in 1 2 3 4 5 6 7 8; do echo $i; sleep 0.1; done"], { timeoutMs: Infinity, silenceMs: 400 });
  const prevSil = process.env.LOKI_E10_CMD_SILENCE_S; process.env.LOKI_E10_CMD_SILENCE_S = "0.3"; const tImp = Date.now(), implied = await sh.run(["sh", "-c", "sleep 20"], { timeoutMs: Infinity }); if (prevSil === undefined) delete process.env.LOKI_E10_CMD_SILENCE_S; else process.env.LOKI_E10_CMD_SILENCE_S = prevSil;
  res("NO-DEFAULT-BUDGET a command with no time limit is stopped after its silence window (given, or implied by Infinity: LOKI_E10_CMD_SILENCE_S), while a command that keeps printing runs to its end", quiet.silent === true && quiet.timedOut === true && Date.now() - t0 < 10_000 && implied.silent === true && Date.now() - tImp < 10_000 && chatty.exitCode === 0 && !chatty.silent && chatty.stdout.includes("8"));
  const kInf = wd.sessionKillsS(Infinity, {}), kLim = wd.sessionKillsS(480, {}), kEnv = wd.sessionKillsS(Infinity, { LOKI_E10_STALL_KILL_S: "20", LOKI_E10_LOOP_KILL_S: "40" });
  res("NO-DEFAULT-BUDGET a session with no time limit ends on 1800 s of silence or 3600 s of output with no tree change by default (env unset); one with a limit keeps no kill; the env values win", kInf.stallS === 1800 && kInf.loopS === 3600 && kLim.stallS === 0 && kLim.loopS === 0 && kEnv.stallS === 20 && kEnv.loopS === 40);
  let now = 0; const w = wd.createWatchdog(() => now, 10_000); w.tick(10, "d1"); now = 5_000; w.tick(20, "d1"); now = 9_000; const tk = w.tick(30, "d1");
  res("NO-DEFAULT-BUDGET the loop guard sees output with no tree change (diffIdleS grows while output streams)", tk.diffIdleS === 9 && tk.cls !== "stalled");
  const hung = await wp.spawnWorker([process.execPath, "-e", "setTimeout(() => {}, 20000)"], { PATH: process.env.PATH ?? "" }, d, Infinity, 500, () => {}, { silenceS: 0.4, lastEventMs: () => 0 });
  res("NO-DEFAULT-BUDGET the supervisor's hang guard stops a silent worker that runs no process, and says it was hung (no backstop is armed)", hung.killed === true && hung.hung === true);
  const crw = await import(root + "/loki-ts/src/util/conflict_resume.ts"), said0 = crw.outstandingWords("Progress made. Still outstanding: the docs for multiply.");
  res("NO-DEFAULT-BUDGET a continue reply that only rephrases the outstanding work an earlier one named names nothing new (no progress); one that names more does", !crw.namesNewWork(crw.outstandingWords("Remaining work: multiply docs."), said0) && !crw.namesNewWork(crw.outstandingWords("Next: write the docs for multiply"), said0) && crw.namesNewWork(crw.outstandingWords("Still outstanding: the docs for multiply, and a divide() test."), said0));
  const seq = (texts: string[], tree: boolean): string => { const named = crw.outstandingWords(texts[0]), seen = new Set([crw.outstandingNumbers(texts[0]).join(",")]); const out: string[] = []; for (const t of texts.slice(1)) { const w = crw.outstandingWords(t), n = crw.outstandingNumbers(t); out.push(crw.continueMoved({ left: 0, fewestMissing: 0, treeChanged: tree, words: w, named, nums: n, seenNums: seen }) ? "moved" : "no"); for (const x of w) named.add(x); seen.add(n.join(",")); } return out.join(","); };
  res("NO-DEFAULT-BUDGET continue progress (fable-planner review): a count that falls is progress, a new reason with an unchanged tree is not, and a count that only oscillates back to one already seen is not", seq(["items 5 to 10 remain", "items 7 to 10 remain", "items 9 to 10 remain"], true) === "moved,moved" && seq(["12 of 40 tests still fail", "8 of 40 tests still fail", "3 of 40 tests still fail"], true) === "moved,moved" && seq(["the docs for multiply remain", "multiply documentation is blocked", "multiply docs await a network retry", "multiply docs paused until rate limit clears"], false) === "no,no,no" && seq(["12 of 40 tests still fail", "13 of 40 tests still fail", "12 of 40 tests still fail", "13 of 40 tests still fail"], true) === "moved,no,no");
  { const says = ["13 of 40 tests still fail", "12 of 40 tests still fail", "13 of 40 tests still fail", "12 of 40 tests still fail", "13 of 40 tests still fail"]; let tree = 0, k = 0;
    const fx = { provider: "claude", repoDir: d, runDir: d, runId: "e10-x", emit: () => {}, sessions: { run: async () => { await Bun.sleep(1); tree++; return { exit: 0, killed: false, durationS: 1, markers: { done: true, alreadyDone: null, specConflict: null, finishLine: null }, summary: says[k++ % says.length] }; } } } as never; // the sleep lets the abort timer fire
    const first = { exit: 0, killed: false, durationS: 1, markers: { done: true, alreadyDone: null, specConflict: null, finishLine: null }, summary: "12 of 40 tests still fail" } as never;
    const osc = await crw.resumeToFinish(fx, { iterationId: "it", brief: "B" } as never, first, { fingerprint: () => String(tree), spentUsd: () => null, compactions: () => null, signal: AbortSignal.timeout(5000), env: {} }); // bounded: a loop that never stops ends "aborted" and reads red, never hangs this file
    res("NO-DEFAULT-BUDGET an S1b loop whose count only oscillates (12, 13, 12 of 40) while the tree keeps changing ends as no progress", osc.record.ended === "no progress" && osc.iterationIds.length === 3); }
  { // G5: where a measurement exists (Loki's own proof script), a continue's progress is its failing count, not the reply's words
    const run = async (says: string[], counts: (number | null)[]): Promise<{ ended: string; n: number }> => { let tree = 0, k = 0, m = 0;
      const fx = { provider: "claude", repoDir: d, runDir: d, runId: "e10-x", emit: () => {}, sessions: { run: async () => { await Bun.sleep(1); tree++; return { exit: 0, killed: false, durationS: 1, markers: { done: true, alreadyDone: null, specConflict: null, finishLine: null }, summary: says[k++ % says.length] }; } } } as never;
      const first = { exit: 0, killed: false, durationS: 1, markers: { done: true, alreadyDone: null, specConflict: null, finishLine: null }, summary: says[0] } as never;
      const r = await crw.resumeToFinish(fx, { iterationId: "it", brief: "B" } as never, first, { fingerprint: () => String(tree), spentUsd: () => null, compactions: () => null, signal: AbortSignal.timeout(5000), env: {}, measure: async () => counts[Math.min(m++, counts.length - 1)] ?? null });
      return { ended: r.record.ended, n: r.iterationIds.length }; };
    const falling = await run(["the docs for multiply remain"], [5, 4, 3, 2, 1, 0, 0, 0]), stuck = await run(["the docs for multiply remain"], [3, 3, 3, 3, 3]);
    const steps = await run(["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"], [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
    res("G5 continue progress where a measurement exists: a count that falls keeps going although the words never change; a flat count with the same work ends at 2; a flat count while the tree changes and each reply names new work goes on (no extra cap) and ends only when the words repeat", falling.n >= 5 && stuck.ended === "no progress" && stuck.n === 2 && steps.ended === "no progress" && steps.n >= 12); }
  res("G5 fix-loop progress: fewer new failing ids, or a check that now runs (more checks ran than ever before), is progress; the same ids with the same checks is not (summary-parse D3)", mc.fixRoundMoved(2, 5, 3, 5) && mc.fixRoundMoved(3, 6, 3, 5) && mc.fixRoundMoved(5, 6, 3, 5) && !mc.fixRoundMoved(3, 5, 3, 5) && !mc.fixRoundMoved(4, 4, 3, 5) && mc.checksRan({ checks: [{ result: "pass" }, { result: "fail" }, { result: "not_run" }] }) === 2);
  const pv = await import(root + "/loki-ts/src/engine10/stages/prove.ts"), nr = await import(root + "/loki-ts/src/features/no_regression.ts");
  res("NO-DEFAULT-BUDGET the prove stage has no 600 s budget and its listing no 3-turn cap unless set (the knob or LOKI_E10_PROVE_BUDGET_S / LOKI_E10_PROVE_LIST_TURNS); a user cap still reserves 600 s for it when sizing implement", pv.proveBudgetS({}) === Infinity && pv.proveBudgetS(B) === 600 && pv.proveBudgetS({ LOKI_E10_PROVE_BUDGET_S: "45" }) === 45 && pv.proveReserveOfS({}) === 600 && pv.proveListTurns({}) === undefined && pv.proveListTurns(B) === 3 && pv.proveListTurns({ LOKI_E10_PROVE_LIST_TURNS: "5" }) === 5);
  res("NO-DEFAULT-BUDGET the no-regression differential has no 120 s wall budget unless set; the knob restores it", nr.nrdBudgetS({}) === Infinity && nr.nrdBudgetS(B) === 120 && nr.nrdBudgetS({ LOKI_E10_NRD_BUDGET_S: "30" }) === 30);
  const rp = await import(root + "/loki-ts/src/runner/repo_profile.ts"), base = await rp.asyncShellRunner()("sleep 0.3; echo base-ran", d, Infinity);
  res("NO-DEFAULT-BUDGET intake baselines have no 300 s limit of Loki's own: none by default, a third of a user's run cap, the user's LOKI_E10_BASELINE_CMD_S; the knob restores 300 s; the shared suite budget likewise", rp.baselineCmdS(Infinity, {}) === Infinity && rp.baselineCmdS(600, {}) === 200 && rp.baselineCmdS(Infinity, { LOKI_E10_BASELINE_CMD_S: "50" }) === 50 && rp.baselineCmdS(Infinity, B) === 300 && rp.suiteBaselineBudgetS({}) === Infinity && rp.suiteBaselineBudgetS(B) === 300);
  const prevSil2 = process.env.LOKI_E10_CMD_SILENCE_S; process.env.LOKI_E10_CMD_SILENCE_S = "0.3"; const tSr = Date.now(), srOk = rp.shellRunner("sleep 0.2; echo intake-ran", d, Infinity), srQuiet = rp.shellRunner("sleep 20", d, Infinity), srWall = Date.now() - tSr; if (prevSil2 === undefined) delete process.env.LOKI_E10_CMD_SILENCE_S; else process.env.LOKI_E10_CMD_SILENCE_S = prevSil2;
  res("NO-DEFAULT-BUDGET an intake baseline command with no limit runs to its end, and one silent past LOKI_E10_CMD_SILENCE_S is stopped as timed out (the sync runner had no guard)", srOk.code === 0 && srOk.out.includes("intake-ran") && srQuiet.timedOut === true && srWall < 10_000);
  res("NO-DEFAULT-BUDGET a base suite run with no limit runs to its end (a raw Infinity timer cut it at once: fl24 base run incomplete)", base.code === 0 && base.timedOut === false && base.out.includes("base-ran"));
  const se = await import(root + "/loki-ts/src/engine10/stages/seal.ts"), red = [{ name: "pytest:tests/old_test.py", cmd: "x", result: "fail", duration_s: 1, provenance: "exogenous" }, { name: "pytest:tests/new_test.py", cmd: "x", result: "pass", duration_s: 1, provenance: "agent_authored", n: 1 }] as never[];
  const oCut = { implement: { exit: "done" }, verify: { stopped_at: "limit" } }, oFull = { implement: { exit: "done" }, verify: {} };
  const own = [{ name: "pytest:tests/new_test.py", cmd: "x", result: "fail", duration_s: 1, provenance: "agent_authored" }] as never[], lint = [{ name: "lint:ruff", cmd: "x", result: "fail", duration_s: 1, provenance: "exogenous" }] as never[];
  res("LIMIT-NOT-FAILED a verify stopped by Loki's own limit or cap seals PARTIAL on an unattributed pre-existing red test, never FAILED; a full verify, the run's own test or lint red is still FAILED (hm155462)", se.verdictOf(oCut as never, red, false, false, false, true) === "PARTIAL" && se.verdictOf({ ...oCut, verify: { stopped_at: "cap" } } as never, red, false, false, false, true) === "PARTIAL" && se.verdictOf(oFull as never, red, false, false, false, true) === "FAILED" && se.verdictOf(oCut as never, own, false, false, false, true) === "FAILED" && se.verdictOf(oCut as never, lint, false, false, false, true) === "FAILED");
} finally { rmSync(d, { recursive: true, force: true }); }
TS
out="$(cd "$ROOT/loki-ts" && bun "$T/nobudget.ts" "$ROOT" 2>&1; echo "EXIT $?")"
grep -q '^EXIT 0$' <<< "$out" || { bad "no-default-budget unit script crashed or exited non-zero"; printf '%s\n' "$out" | tail -8 | sed 's/^/    | /'; }
[ "$(printf '%s\n' "$out" | grep -c '^OK ')" = 28 ] || bad "no-default-budget unit script produced $(printf '%s\n' "$out" | grep -c '^OK ') passing legs, want 28"
while IFS= read -r line; do
    case "$line" in "OK "*) ok "${line#OK }" ;; "NO "*) bad "${line#NO }" ;; esac
done <<< "$out"
# End to end, no limit set: the default run is VERIFIED with no cap anywhere (no LOKI_E10_CAP_S in the session, no derived turn cap, no time note, no cap.hit).
NBTO=(${TO[@]+"${TO[@]}"}); TO=(${NBTO[@]+"${NBTO[@]}"}); run_engine done
NBF="$(python3 -I - "$RUNDIR" "$STUBENV" <<'PY'
import json, os, sys
rd, envlog = sys.argv[1], sys.argv[2]
ev = [json.loads(l) for l in open(os.path.join(rd, "events.jsonl")) if l.strip().startswith("{")]
st = next(e["data"] for e in ev if e["type"] == "run.started")
imp = [l.split() for l in open(envlog) if l.startswith("implement BUDGET ")]
print(json.load(open(os.path.join(rd, "receipt.json"))).get("verdict"), st.get("cap_s"), sum(e["type"] in ("cap.hit", "cap.sized") for e in ev), len(imp) > 0 and all(x[2:] == ["CAP=", "TURNS=", "TIMENOTE=0"] for x in imp))
PY
)"
[ "$NBF" = "VERIFIED None 0 True" ] && ok "NO-DEFAULT-BUDGET a run with no limit set is VERIFIED with no cap: run.started cap_s null, no cap event, the session got no cap, no turn cap and no time note" || { bad "NO-DEFAULT-BUDGET default run facts: $NBF"; printf '%s\n' "$OUT" | tail -6 | sed 's/^/    | /'; }
# A stuck session (silent after its edit) with no limit set still ends, and the run delivers a draft PR of what was done.
TO=(LOKI_E10_STALL_KILL_S=20 E2E_STUB_SLEEP=900); command -v timeout >/dev/null 2>&1 && TO+=(timeout 400)
NB0=$(date +%s); run_pr nb-stuck none LOKI_RISK_TIER=medium; NBW=$(( $(date +%s) - NB0 ))
NBF="$(python3 -I - "$RUNDIR" <<'PY'
import json, os, sys
rd = sys.argv[1]
ev = [json.loads(l) for l in open(os.path.join(rd, "events.jsonl")) if l.strip().startswith("{")]
pr = [e for e in ev if e.get("type") == "pr.opened"]
ended = [e["data"] for e in ev if e["type"] == "session.ended" and e.get("stage") == "implement"]
print(json.load(open(os.path.join(rd, "receipt.json"))).get("verdict"), len(pr), bool(pr and pr[0]["data"].get("draft")), any("stalled" in str(x.get("cause", "")) or x.get("killed") for x in ended), sum(e["type"] == "cap.hit" for e in ev))
PY
)"
[ "$NBW" -lt 400 ] && [ "${NBF%% *}" != VERIFIED ] && [ "$(cut -d' ' -f2-5 <<< "$NBF")" = "1 True True 0" ] && ok "NO-DEFAULT-BUDGET a stuck session with no limit ends on its silence (${NBW}s), the run is not VERIFIED and opens a draft PR of what was done ($NBF)" || { bad "NO-DEFAULT-BUDGET stuck run (${NBW}s): $NBF"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
# A limit the user set that is hit still ends in a draft PR of what was done.
TO=(LOKI_RUN_DEADLINE_S=95 E2E_STUB_SLEEP=200); command -v timeout >/dev/null 2>&1 && TO+=(timeout 300)
run_pr nb-deadline none LOKI_RISK_TIER=medium
NBF="$(python3 -I - "$RUNDIR" <<'PY'
import json, os, sys
rd = sys.argv[1]
ev = [json.loads(l) for l in open(os.path.join(rd, "events.jsonl")) if l.strip().startswith("{")]
pr = [e for e in ev if e.get("type") == "pr.opened"]
print(json.load(open(os.path.join(rd, "receipt.json"))).get("verdict"), sum(e["type"] == "cap.hit" for e in ev) > 0, len(pr), bool(pr and pr[0]["data"].get("draft")))
PY
)"
[ "$(cut -d' ' -f2- <<< "$NBF")" = "True 1 True" ] && [ "${NBF%% *}" != VERIFIED ] && ok "NO-DEFAULT-BUDGET a user time limit that is hit ends the run with cap.hit and a draft PR of what was done ($NBF)" || { bad "NO-DEFAULT-BUDGET user-limit run: $NBF"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
TO=(${NBTO[@]+"${NBTO[@]}"})
# --max-time is the opt-in outer limit (LOKI_RUN_DEADLINE_S); with neither it nor --max-duration the dry run names no time limit.
NBD="$(mktemp -d "$T/nbdry.XXXXXX")"; git -C "$NBD" init -q -b main; git -C "$NBD" commit -q --allow-empty -m base
NBO="$(cd "$ROOT/loki-ts" && bun -e '
const st = await import("./src/commands/start.ts"), rc = await import("./src/util/run_cap.ts");
const env = {}, set = (k, v) => { env[k] = v; }, errs = [];
const ok = st.parseStartArgs(["add a multiply function", "--max-time", "2m", "--verify-max-time=90"], (e) => errs.push(e), () => {}, set);
const bad = st.parseStartArgs(["add a multiply function", "--max-time", "soon"], (e) => errs.push(e), () => {}, () => {});
const none = {}; st.parseStartArgs(["add a multiply function"], () => {}, () => {}, (k, v) => { none[k] = v; });
console.log([typeof ok === "object", env.LOKI_RUN_DEADLINE_S, env.LOKI_E10_VERIFY_MAX_S, bad, "LOKI_RUN_DEADLINE_S" in none, rc.parseDurationS("90m"), String(rc.parseDurationS("0")), st.START_USAGE.includes("--max-time DUR") && st.START_USAGE.includes("--verify-max-time DUR")].join(" "));' 2>&1)"
[ "$NBO" = "true 120 90 2 false 5400 null true" ] && ok "NO-DEFAULT-BUDGET loki start --max-time 2m sets a 120 s outer limit and --verify-max-time=90 a 90 s verify limit; a bad duration is refused; without them nothing is set; both are in --help" || bad "NO-DEFAULT-BUDGET start time flags gave: $NBO"
NBE="$(cd "$NBD" && bash -c '. "$1/autonomy/route.sh" 2>/dev/null; loki_route_resolve start "add a multiply function" --max-time 90m >/dev/null 2>&1; printf "%s" "${R_DEADLINE_S:-}"' _ "$ROOT" 2>/dev/null)"
[ "$NBE" = 5400 ] && ok "NO-DEFAULT-BUDGET --max-time 90m resolves to a 5400 s deadline" || bad "NO-DEFAULT-BUDGET --max-time 90m resolved to '$NBE'"
# A user's own --max-duration is never capped by Loki (it was clamped to 3600 s). Plant NB10: restore the clamp in route.sh; this reads 3600.
NBM="$(cd "$NBD" && bash -c '. "$1/autonomy/route.sh" 2>/dev/null; loki_route_resolve start "add a multiply function" --max-duration 3h >/dev/null 2>&1; printf "%s|%s" "${R_E10_CAP_S:-}" "${R_NOTICE:-}"' _ "$ROOT" 2>/dev/null)"
[ "$NBM" = "10800|" ] && ok "NO-DEFAULT-BUDGET --max-duration 3h stays 10800 s with no clamp notice" || bad "NO-DEFAULT-BUDGET --max-duration 3h resolved to '$NBM'"
# ---- end NO-DEFAULT-BUDGET ----

finish
