# Adoption plan: Tier 0 split (A-03)

Architect: opus. Source: the founder directive (2026-09-30, from building to proving), wf3-verdict.txt, firstrun-repro/ (run1.log legacy `loki quick`, run2.log `LOKI_ENGINE=v10`), BOARD rows A-01 to A-04 and E-125, DECISIONS D12, D13, D33, D42, D44. Base: main 6ce04b0c.

## 0. Rules for every card

- Gate assertions (A-02 `scripts/first-run-gate.sh`, bugrepo from firstrun-repro/bugrepo-original). Cards cite these IDs:
  - G1 exit 0 only if `npm test` is fully green afterwards.
  - G2 no new committed files outside the fix, except under .loki/.
  - G3 the printed receipt digest equals the one `loki verify` checks. The format must be agreed with A-02: v10 prints only a 12-hex prefix today.
  - G4 `loki verify` returns OK and exits 0.
  - G5 the receipt is signed.
  - G6 at most 15 lines of output without `--verbose`.
  - G7 wall time is recorded (target under 30s).
- Line budget (D33): `loki-ts/tests/engine10/budget.test.ts` is the only measure, not `wc`. It counts `split("\n").length`, so a new core file costs one extra line. Core is 4,955 on main and 4,998 on slice-E-125 (cap 4,999). A card that adds core lines must cut the same number in its own file set, or it is re-sliced. Deleting comments on Seal, Wall, verify or Rule of Two logic is not an offset.
- Tiers per D12:
  - Seal, verify, signing, receipt, outcomes and auth are HIGH: opus reviewers, unanimous, and a reproduced finding blocks.
  - D13: every reviewer's model is pinned explicitly.
- One writer per file. A file that appears in two cards is written by one card at a time, in the order under "Depends".
- Engine scope. Until item 4, the README default is legacy `loki quick`/`loki quickstart`, so the gate needs both routes.
  - v10 gets the real fixes.
  - Legacy gets default changes only. Build no new machinery on run.sh, which item 4 demotes to `loki legacy`.
- Every card starts by reproducing its defect on current main in a clean HOME. The firstrun receipts are gone (/private/tmp/claude-501/loki-firstrun is empty), so step 1 rebuilds them from run1.sh and run2.sh.

## 1. Root causes found in code (evidence for the cards)

- R-a TAMPERED: there are two canonicalizers.
  - `stages/seal.ts` `canonicalJson` escapes non-ASCII to `\uXXXX` (Python ensure_ascii) and drops undefined keys.
  - `verify_cmd.ts` keeps a private copy, `canonicalJson` at lines 19-28, which does neither.
  - So any receipt carrying a non-ASCII character fails `loki verify` with "receipt_sha256 mismatch". The run2 receipt had a model-written `spec_conflict_reason`, which `sanitizeReason` passes through with non-ASCII intact.
  - The mismatch string is verify_cmd.ts's own message, so the founder hit the v10 route.
  - This is still a hypothesis until A-101 step 1 reproduces it.
- R-b A red suite exits 0: `supervisor.ts` main ends with `return res.verdict === "FAILED" ? 1 : 0`, so PARTIAL and SPEC_CONFLICT exit 0.
- R-c Broken Wall test committed:
  - `RunnerName` (types.ts:84) has no node:test. On the bugrepo testmap sees only the coarse `npm` runner.
  - `wall.ts` `guessRunner` returns null for a .js file unless vitest, jest or bun is present, so the Wall file is unselectable and never run.
  - The brief says only "the framework named in repomap.txt".
  - The file is still copied into the tree, and `commitStage` (seal.ts) runs `git add -A`.
  - Plan logged "small task", yet the Wall ran for 17s: `hasRelevantTests` found no impacted test under the `npm` runner. To be confirmed in A-102.
- R-d Printed receipt differs from the verified one (legacy):
  - In run1.log the printed Evidence Receipt shows Base sha == Head sha (1b537540), so it was rendered before `commit_session_changes` (run.sh ~11065).
  - The HANDOFF.md write (run.sh 29334-29356, LOKI_HANDOFF default 1) and the USAGE regen (run.sh 20981) run after it.
  - USAGE.md is forced by `USAGE_DOC_REQUIRED` (run.sh 22427, mirrored in loki-ts/src/runner/build_prompt.ts plus 60 fixtures).
- R-e UNSIGNED by default:
  - v10 signs only when `LOKI_RECEIPT_SIGNING_KEY` or `_FILE` is set (seal.ts `signReceipt`, preflight.ts:25-27).
  - Legacy has two layers: GPG through `LOKI_PROOF_GPG_KEY` (proof-generator.py:2158, 51 references) and Ed25519 through `LOKI_RECEIPT_SIGNING_KEY*` (proof-generator.py:2185).
  - Both Ed25519 paths go through `python3 -I` plus `cryptography`, which a clean macOS python3 does not ship.
- R-f `loki verify --help` under v10: verify_cmd.ts `main` treats `--help` as a run id, prints "receipt not found" and exits 2. The bash route (autonomy/verify.sh) documents `--help`. A-101 asserts both routes.

## 2. Slice cards

### A-101 Receipt canonicalization and verify help (item 1)
- Goal:
  - Seal-then-verify always matches.
  - `loki verify --help` prints usage and exits 0 on both routes.
  - Step 1: seal a receipt whose `spec_conflict_reason` contains U+2192, write it through the real `JSON.stringify(receipt, null, 2)` path, verify it through verify_cmd.ts and the bash route, and record the rc (expect TAMPERED on main).
- Files: loki-ts/src/engine10/verify_cmd.ts, loki-ts/tests/engine10/verify_cmd.test.ts, loki-ts/tests/engine10/seal_verify_roundtrip.test.ts (new, the CI test run by the Bun test job), autonomy/verify.sh (only if its --help is red).
- Fix:
  - Delete verify_cmd.ts's private `canonicalJson` and import `canonicalJson`/`receiptSha256` from seal.ts, so there is one canonicalizer.
  - Add a `--help`/`-h` branch in `main`.
  - Print the full `receipt_sha256` so G3 compares like with like.
- Wall check:
  - The round-trip test is red on main (the non-ASCII fixture) and green after.
  - `loki verify --help` exits 0 with "Usage".
  - Gate: G3, G4.
- Commands: `cd loki-ts && bun test tests/engine10/verify_cmd.test.ts tests/engine10/seal_verify_roundtrip.test.ts tests/engine10/seal.test.ts tests/engine10/budget.test.ts`
- Tier: HIGH. Budget: core about -8 (the duplicate is removed).
- Depends: none. Wave 1.

### A-102 Test-runner detection: node:test plus a fixture for all six runners (item 1)
- Goal:
  - Detect node:test (`scripts.test` of `node --test`, or `require('node:test')`/`from 'node:test'` in test files) as its own runner with per-file selection `node --test <files>`.
  - Prove detection for jest, vitest, pytest, go test and cargo with one fixture each.
  - Step 1: confirm why sizing did not take the lean path on the bugrepo (R-c).
- Files: loki-ts/src/engine10/testmap.ts, loki-ts/src/engine10/types.ts (`RunnerName` gains "node"), loki-ts/src/engine10/stages/verify.ts (`runnerCmd` case only), loki-ts/tests/engine10/testmap.test.ts.
- Wall check:
  - On the bugrepo, testmap reports `runners == ["node"]` and sum.test.js is impacted by sum.js.
  - `smallTaskPath` returns "lean" for the gate task, so the gate skips the Wall and saves about 17s (G7).
  - The six runner fixtures each detect exactly their runner.
- Commands: `cd loki-ts && bun test tests/engine10/testmap.test.ts tests/engine10/verify.test.ts tests/engine10/sizing.test.ts tests/engine10/budget.test.ts`
- Tier: HIGH (runner choice decides the Seal's checks). Budget: net 0 or less. The offset comes from folding node into the existing npm `detectFromPackageJson` branch, not from a new branch.
- Depends: none. Wave 1. This card alone removes the gate's Wall defect. A-103 is still needed for repos where the Wall runs.

### A-103 Wall never leaves a test that fails for unrelated reasons (item 1)
- Goal:
  - Build on slice-E-125 (r5 018a6e06) after its opus review merges, never on main.
  - The brief names the detected runner concretely, for example "node:test: require('node:test') and node:assert; no jest globals".
  - `guessRunner` is replaced by the runner testmap detected for the target dir.
  - A Wall file whose base result is not red (pass, or not_run for a launch or reference error) is deleted from the working tree before Implement. Its sealed copy stays under runDir/wall, and it is listed in not_proven as "wall test discarded: <path> (<class>)". This needs per-file results from `BaseTestRunner`.
- Files: loki-ts/src/engine10/stages/wall.ts, loki-ts/tests/engine10/wall.test.ts.
- Wall check:
  - A fake Wall session that writes a jest-global test into a node:test fixture: the file is absent from the tree after the Wall, and the receipt lists it as discarded.
  - A real red node:test Wall test is kept.
  - Gate: G1, G2.
- Commands: `cd loki-ts && bun test tests/engine10/wall.test.ts tests/engine10/seal.test.ts tests/engine10/budget.test.ts`
- Tier: HIGH. Budget: flat. Replacing `guessRunner` (8 lines) pays for the per-file discard. Core has 1 line of headroom on E-125.
- Depends: E-125 merged, then A-102 (RunnerName "node"). Wave 2.

### A-104 Commit only the fix (items 1 and 2, v10)
- Goal: `commitStage` in seal.ts never commits:
  - `loki_wall_*` files (the sealed copies under runDir/wall are the evidence), or
  - a lockfile that did not exist at base when no manifest changed (package-lock.json, yarn.lock, pnpm-lock.yaml, poetry.lock, Cargo.lock, go.sum).
  - `.loki/` stays excluded through .git/info/exclude, as intake already does.
- Rule for the CTO: Wall tests run in the tree but are never committed. This settles G2, which otherwise forbids even a passing Wall file.
- Files: loki-ts/src/engine10/stages/seal.ts (`commitStage` only), loki-ts/tests/engine10/seal.test.ts (commit cases).
- Wall check:
  - A fixture where implement edits sum.js, a Wall file exists, and `npm install` created package-lock.json: HEAD's diff against base is sum.js only.
  - Gate: G2.
- Commands: `cd loki-ts && bun test tests/engine10/seal.test.ts tests/engine10/e2e.test.ts tests/engine10/budget.test.ts`
- Tier: HIGH (it changes the tree that Seal hashes). Budget: net 0 or less. Offset: the `.loki` unstage round trip in `commitStage` is replaced by one pathspec list.
- Depends: none. Wave 1. seal.ts order: A-104, then A-121, then A-112.

### A-113 Stop reasons: STALLED and the fatal classifier (item 5)
- Goal:
  - The fix loop stops with `stop: "stalled"` when verify reports the same failures.ts signature 3 times. MAX_FIX_ROUNDS=2 gives exactly 3 verifies, so this can fire.
  - A session whose stderr tail classifies as `auth` or `quota_exhausted` through the existing loki-ts/src/runner/retry_class.ts `classifyFailure` stops the run immediately: no fix round, no further session, and `stop: "fatal:<class>"`.
  - A rate limit stays retryable, as retry_class already treats it.
- Files: loki-ts/src/engine10/machine.ts, loki-ts/src/engine10/session.ts, loki-ts/src/engine10/supervisor.ts (the `--resume` flag and its refusal only, lines 284-300), loki-ts/tests/engine10/machine.test.ts, loki-ts/tests/engine10/session.test.ts. It deletes loki-ts/tests/engine10/resume_e2e.test.ts and resume_cli.test.ts. types.ts is read-only for this card: `stop` travels on outputs.
- Wall check:
  - A fake provider that prints "credit balance is too low" runs exactly one session and stops fatal.
  - A fake verify that repeats one signature stops "stalled" after 3 verifies.
  - A 429 is retried.
- Commands: `cd loki-ts && bun test tests/engine10/machine.test.ts tests/engine10/session.test.ts tests/engine10/cap.test.ts tests/engine10/budget.test.ts`
- Tier: HIGH. Budget: net 0 or less. Offset: delete the engine resume path whole, in one slice so main never carries a dead flag: machine.ts `opts.prior` replay, the supervisor.ts flag, and both resume tests. It is wired and tested (E-39/E-42), but intake always records `resumed: false`, so resumed receipts misreport. harness.py never passes `--resume` (grep), and eval resume S41-18 is file-based and stays. See section 4.
- Depends: A-102 (types.ts). Wave 2.

### A-110 One named outcome, a fixed exit ladder, `--json` (items 1 and 5)
- Goal:
  - Map at the edge and keep the receipt schema: eval/loki10/harness.py:1059 reads receipt `verdict`, and pr.ts, session.ts and e10ext/context.ts read the verdict strings.
  - `outcomeOf(verdict, capHit, stop)` lives in output.ts:

    | Condition | Outcome | Exit |
    |---|---|---|
    | VERIFIED | VERIFIED | 0 |
    | ALREADY_SATISFIED | ALREADY_SATISFIED | 0 |
    | usage or preflight error | (existing) | 2 |
    | cap.hit | BUDGET_STOP | 3 |
    | SPEC_CONFLICT | BLOCKED | 4 |
    | stop "stalled" | STALLED | 5 |
    | PARTIAL or FAILED | FAILED | 1 |

  - BLOCKED posts its one question on the issue through the existing E-67 `comment` callback.
  - The "Verdict:" line becomes "Outcome:", so there is one name.
  - `--json` prints one object `{ok, outcome, stop, run_id, receipt_sha256}`, where `ok` means exit 0.
  - harness.py's rc handling is checked, and edited by this card only if a code change breaks it.
- Files: loki-ts/src/engine10/supervisor.ts, loki-ts/src/engine10/output.ts, loki-ts/tests/engine10/output.test.ts, loki-ts/tests/engine10/supervisor_backstop.test.ts.
- Wall check:
  - A fixture where the red suite ends PARTIAL exits 1 (red on main because of R-b).
  - A SPEC_CONFLICT exits 4.
  - A cap exits 3.
  - `--json` parses.
  - Gate: G1.
- Commands: `cd loki-ts && bun test tests/engine10/output.test.ts tests/engine10/supervisor_backstop.test.ts tests/engine10/e2e.test.ts tests/engine10/budget.test.ts`
- Tier: HIGH. Budget: net 0 or less. Offset: the exit ternary becomes a ladder lookup, and output.ts's Verdict label code is replaced by the Outcome line. If that is not flat, re-slice.
- Depends: A-113 (`stop` and supervisor.ts). Wave 3.

### A-111 Empty, skipped or hung checks are NOT VERIFIED (item 5)
- Goal: verify.ts parses the executed-test count per runner:
  - node TAP `# pass N`/`# fail N`
  - jest/vitest "Tests:"
  - pytest summary
  - go `ok`/`FAIL`
  - cargo "test result"
- A check that ran 0 tests, ran only skipped tests, or hit the timeout is `not_run` with a reason, never `pass`. seal.ts `verdictOf` already downgrades `not_run`.
- Files: loki-ts/src/engine10/stages/verify.ts, loki-ts/tests/engine10/verify.test.ts.
- Wall check: four fixtures (a node test file with 0 tests, jest `--passWithNoTests`, pytest all-skip, and a sleep past the timeout) each seal non-VERIFIED.
- Commands: `cd loki-ts && bun test tests/engine10/verify.test.ts tests/engine10/seal.test.ts tests/engine10/budget.test.ts`
- Tier: HIGH. Budget: net 0 or less. The count parse replaces the per-runner exit-status branches it subsumes.
- Depends: A-102 (verify.ts). Wave 2.

### A-112 Baseline subtract: judge only the delta (item 5)
- Goal:
  - verify runs the same selected checks on a pristine base checkout (`git worktree add --detach <base_sha>` in a temp dir, never a reset of the implement tree, per D42 (2)) and records the failing test ids.
  - A failure that was already red on base is `pre_red`: it goes to NOT PROVEN and never blocks VERIFIED.
  - A test that goes red to green is the fix.
  - seal.ts adds `pre red: <id>` to not_proven without routing it through `verifyNotProven`, which downgrades.
- Files: loki-ts/src/engine10/stages/verify.ts, loki-ts/src/engine10/failures.ts (per-test ids, including node TAP `not ok`), loki-ts/src/engine10/stages/seal.ts (the one not_proven line), loki-ts/tests/engine10/verify.test.ts, loki-ts/tests/engine10/failures.test.ts.
- Wall check:
  - The bugrepo plus an unrelated red test that is red before and after: the outcome is VERIFIED with "pre red" listed.
  - The target test staying red is FAILED.
- Commands: `cd loki-ts && bun test tests/engine10/verify.test.ts tests/engine10/failures.test.ts tests/engine10/seal.test.ts tests/engine10/budget.test.ts`
- Tier: HIGH. Budget: this is the largest adder, about +20. Offset: failures.ts's parse duplication with verify.ts. If it cannot be flat, it waits for A-150 or is re-sliced (D33: never raise).
- Depends: A-111 (verify.ts) and A-121 (seal.ts). Wave 3.

### A-120 One signing key, auto-generated (item 3)
- Goal:
  - `receipt_jwt.load_signing_key()` uses `LOKI_RECEIPT_SIGNING_KEY_FILE`, defaulting to `~/.loki/keys/receipt-ed25519.pem`.
  - If the key is missing, it creates it: PKCS8 PEM, mode 0600, `O_EXCL`, so a concurrent first run cannot overwrite it.
  - The inline `LOKI_RECEIPT_SIGNING_KEY` stays for now. After A-122 there is one signing family for both engines, which is what the directive requires. Deleting the inline variable touches about 10 engine10 tests plus tests/moat/p1-portable-proof.sh and is not carded.
  - preflight.ts warns only when signing is really unavailable.
  - The seal.ts `signReceipt` early exit when no env is set belongs to A-121. The proof-generator.py `if att_key:` early exit (about line 2183) belongs to A-122.
- Files: autonomy/receipt_jwt.py, loki-ts/src/engine10/preflight.ts, tests/test_receipt_attest.py, tests/test-local-receipt-attestation.sh, loki-ts/tests/engine10/preflight.test.ts, docs/SIGNED-RECEIPTS.md (the variable section only).
- Wall check:
  - With a fresh HOME and no env, `load_signing_key()` creates the file at 0600.
  - A second call returns the same kid.
  - End-to-end G5 is checked in A-121 (v10) and A-122 (legacy).
- Commands: `python3 -m pytest tests/test_receipt_attest.py -q && bash tests/test-local-receipt-attestation.sh && cd loki-ts && bun test tests/engine10/preflight.test.ts`
- Tier: HIGH. Budget: core flat or smaller (one preflight line removed).
- Depends: none. Wave 1.

### A-121 v10 signs and verifies natively (item 3)
- Goal:
  - Replace the `python3 -I` plus `cryptography` path (seal.ts `SIGN_PY`/`signReceipt`, verify_cmd.ts `checkAttestation`) with node:crypto Ed25519. It must produce the same JWT shape and kid as receipt_jwt.py, read the same key file as A-120, and create it if missing.
  - A clean macOS without `cryptography` still signs, and G5 holds on the default route.
  - The Python cross-check in seal.test.ts stays as the compatibility wall.
  - deep.ts imports `signReceipt`/`canonicalJson` and moves with it.
- Files: loki-ts/src/engine10/stages/seal.ts (signing only), loki-ts/src/engine10/verify_cmd.ts, loki-ts/src/engine10/stages/deep.ts (import and call site), loki-ts/tests/engine10/seal.test.ts, loki-ts/tests/engine10/verify_cmd.test.ts, loki-ts/tests/engine10/deep.test.ts.
- Wall check:
  - With PATH stripped of python3, the receipt is SIGNED and `loki verify` reports VERIFIED.
  - receipt_jwt.py verifies the TS token against the public JWK.
  - Flipping one receipt byte gives TAMPERED.
  - A receipt signed by a key listed in `LOKI_RECEIPT_RETIRED_PUBKEYS` still verifies, so rotation is kept.
  - With a fresh HOME and no env, the first v10 seal is SIGNED (G5).
- Commands: `cd loki-ts && bun test tests/engine10/seal.test.ts tests/engine10/verify_cmd.test.ts tests/engine10/deep.test.ts tests/engine10/budget.test.ts`
- Tier: HIGH. Budget: core about -25 (the embedded Python and the spawn plumbing are removed).
- Depends: A-101 (verify_cmd.ts), A-104 (seal.ts), A-120 (key path). Wave 2.

### A-122 Delete the GPG signing layer (item 3, deletion)
- Goal:
  - Delete `LOKI_PROOF_GPG_KEY` and GPG signing: proof-generator.py `_gpg_detached_sign` and its block, the GPG status tool, and the doctor and verify messages that name it.
  - The legacy route signs only through A-120's key. Delete the proof-generator.py `if att_key:` early exit so the default key is reached. Where `cryptography` is missing, doctor says so on one line.
  - CTO decision: old proofs with `gpg_signature` still verify for integrity, and read as UNSIGNED for provenance.
- Files: autonomy/lib/proof-generator.py, autonomy/lib/proof-template.html, autonomy/loki (signing lines 1283, 9683, 14101-14110, 14532, 36680-36683), tools/signing-status.py (delete), tests/test_signing_status.py (delete), tools/gate-status.py, tools/receipt-attest.py, tests/test-receipt-signing-discoverability.sh, tests/test-deploy-receipt-gate.sh, loki-ts/src/commands/doctor.ts (signing block 484-496 and 1113-1127), README.md (2 lines), docs/TOOLS.md, docs/VERIFICATION-COST.md, docs/SIGNED-RECEIPTS.md.
- Wall check:
  - `LOKI_PROOF_GPG_KEY` appears only in migration messages, docs/v10, tests and dist (a guard test).
  - With a fresh HOME and no env, a legacy proof carries a JWT and `loki proof verify` exits 0 (G5, legacy route).
- Commands: `bash tests/test-receipt-signing-discoverability.sh && bash tests/test-deploy-receipt-gate.sh && python3 -m pytest tests/test_receipt_attest.py -q`
- Tier: HIGH. Budget: large negative outside core.
- Depends: A-120. Wave 2. autonomy/loki order: A-122, then A-123, then A-134.

### A-123 Doctor: only the selected provider blocks, one Ready line (item 3)
- Goal:
  - Only the selected provider's CLI and skill link are `required`.
  - Other providers' CLIs and broken skill symlinks (the founder's Cline and Aider FAILs were machine artifacts) are informational and never FAIL.
  - The last line is exactly one of:
    - `Ready: <provider> (<model>), receipts signed (kid <8>)`
    - the one blocking reason.
- Files: loki-ts/src/commands/doctor.ts, autonomy/loki (cmd_doctor only, for bash parity), loki-ts/tests/commands/doctor.test.ts, tests/test-doctor-providers.sh, tests/test-doctor-optional-skill-not-blocking.sh, tests/test-doctor-single-impl.sh (replaces the deleted tests/test-doctor-blocker-parity.sh).
- Wall check:
  - A HOME with a broken ~/.cline skill symlink and LOKI_PROVIDER=claude: doctor exits 0 and prints one Ready line.
  - With claude missing, it exits non-zero and names the blocker.
- Commands: `cd loki-ts && bun test tests/commands/doctor.test.ts && cd .. && bash tests/test-doctor-providers.sh && bash tests/test-doctor-optional-skill-not-blocking.sh && bash tests/test-doctor-single-impl.sh`
- Tier: MEDIUM. Budget: net 0 or less.
- Depends: A-122 (doctor.ts, autonomy/loki). Wave 3.

### A-130 v10 quiet by default (item 2)
- Goal:
  - Default output is one start line (engine, provider, model), no stage or heartbeat lines, and the final block: Outcome, PR, Receipt (the full digest from A-101), NOT PROVEN, Cost, Time. That is at most 8 lines.
  - `--verbose` restores the stage lines.
  - The preflight UNSIGNED warning is already gone after A-120 and A-121.
- Files: loki-ts/src/engine10/supervisor.ts (the `live` printer and flag parse), loki-ts/src/engine10/output.ts, loki-ts/tests/engine10/output.test.ts.
- Wall check: the e2e fixture's stdout is at most 15 lines without `--verbose`, and shows the stage lines with it (G6).
- Commands: `cd loki-ts && bun test tests/engine10/output.test.ts tests/engine10/e2e.test.ts tests/engine10/budget.test.ts`
- Tier: MEDIUM. Budget: negative (printing lines move behind one flag).
- Depends: A-110 (the same two files). Wave 4.

### A-132 Legacy: no HANDOFF.md, USAGE.md or lockfile in a fix commit (item 2)
- Goal, on existing-repo runs (`loki quick` and issue fixes):
  - HANDOFF.md is written to .loki/HANDOFF.md, not the repo root.
  - `USAGE_DOC_REQUIRED` and the USAGE regen (a haiku call) are skipped.
  - `commit_session_changes` excludes a lockfile that did not exist at base when no manifest changed.
  - New-project (PRD) builds keep today's behaviour.
- The prompt gate keys on the PRD path `.loki/quick-prd-<pid>.md`, which only cmd_quick writes (autonomy/loki:16351). So autonomy/loki is not in this card, and the 60 build_prompt fixtures stay byte-identical. One new fixture covers the gated case. Also fix run.sh:23628, which still matches the old `quick-prd.md` name.
- Files: autonomy/run.sh (HANDOFF target, USAGE instruction gate, regen skip, commit exclude), loki-ts/src/runner/build_prompt.ts (mirror of the gate), loki-ts/tests/fixtures/build_prompt/fixture-61/ (new), tests/test-quick-artifacts.sh (new).
- Wall check:
  - A stub-provider `loki quick` on the bugrepo: `git show --stat HEAD` lists sum.js only.
  - The 60 existing fixtures are unchanged (G2).
- Commands: `bash tests/test-quick-artifacts.sh && cd loki-ts && bun test tests/runner/build_prompt.test.ts`
- Tier: MEDIUM. Budget: run.sh flat or smaller.
- Depends: none. Wave 1. run.sh order: A-132, then A-134.

### A-133 Legacy: skip Council evidence probes on a trivial diff (item 2)
- Goal:
  - `council_evidence_gate` (completion-council.sh:1868) skips the app-boot, persistence, auth and tenant probes when the diff touches at most 2 non-test files, has no new route or auth file, and has at most 20 changed lines.
  - It records "skipped: trivial diff" as not proven, never as a pass.
  - `cmd_quick --help` already claims "no quality council".
- Files: autonomy/completion-council.sh, tests/test-council-trivial-diff.sh (new).
- Wall check:
  - The bugrepo one-line fix prints no `[Council] Evidence gate` lines, and the proof lists the skip.
  - A diff that adds a route still runs the probes.
- Commands: `bash tests/test-council-trivial-diff.sh && bash tests/test-completion-council-affirmative-evidence.sh`
- Tier: HIGH (it touches the auth evidence gate). Budget: flat.
- Depends: none. Wave 1.

### A-134 Legacy: the printed receipt comes after the final commit, and setup chatter goes behind --verbose (item 2)
- Goal:
  - Render and print the Evidence Receipt only after `commit_session_changes` and the HANDOFF write, so the printed diff sha equals what `loki proof verify` checks (R-d).
  - Setup and log_info lines print only with `--verbose` on `loki quick`. The default shows the start line, the result and the receipt, at most 15 lines.
- Files: autonomy/run.sh (proof and print ordering, log gating), autonomy/loki (cmd_quick `--verbose` flag), tests/test-quick-receipt-order.sh (new).
- Wall check:
  - Stub-provider `loki quick`: the printed Head sha equals `git rev-parse HEAD`, and the printed diff sha256 equals the proof.json value.
  - stdout is at most 15 lines (G3, G6).
- Commands: `bash tests/test-quick-receipt-order.sh && bash tests/test-quick-artifacts.sh`
- Tier: HIGH (receipt). Budget: flat.
- Depends: A-132 (run.sh), A-123 (autonomy/loki). Wave 3.

Time (G7): the directive targets under 30s. v10 run2 took 59s (Wall 17s, implement 42s), and raw `claude -p` took 10s. A-102's lean path removes the Wall on the gate repo. If G7 still misses, profile with S41-19 stage timing and open a cut slice named by the result. No speculative speed slice is carded here.

## 3. Item 4 cards: BLOCKED until the gate passes on items 1 to 3 (A-02 green in real-provider mode)

### A-140 v10 lean is the default for every entry point (BLOCKED)
- Goal:
  - The bare task, issue ref, `loki quick`, quickstart and the plugin commands route to v10.
  - Print one start line: engine, provider, model.
- Files: bin/loki, autonomy/loki (dispatch and cmd_quick), autonomy/quickstart.sh, the plugin commands directory, README.md (engine flags).
- Wall check: the gate passes with no env set, and a stub `loki quick` shows `engine10` in the start line.
- Tier: HIGH. Budget: negative.

### A-141 Delete LOKI_ENGINE, LOKI_SDK_LOOP and the silent fallbacks (BLOCKED)
- Goal:
  - Delete the env switches (bin/loki:275, :374) and the fallbacks: a one-word task to legacy, and missing bun to bash. Missing bun becomes an error with the install line.
  - `loki legacy ...` is the only escape hatch.
- Files: bin/loki, loki-ts/src/cli.ts, docs/INSTALLATION.md, tests that set LOKI_ENGINE or LOKI_SDK_LOOP.
- Wall check: `git grep -c "LOKI_ENGINE\|LOKI_SDK_LOOP"` outside CHANGELOG is 0, and `loki legacy quick --help` works.
- Tier: HIGH. Depends: A-140.

### A-142 Delete the unreachable SDK loop (BLOCKED)
- Goal:
  - Once LOKI_SDK_LOOP is gone, delete loki-ts/src/runner/ modules reachable only from autonomous.ts: recovery_policy.ts (241 lines), escalation_handoff.ts (184), intervention.ts (462), and the circuit-breaker code in providers.ts and budget.ts.
  - Move retry_class.ts to loki-ts/src/util/, because A-113 imports it.
  - Keep build_prompt.ts while run.sh parity needs it.
  - Step 1 is an import-graph audit.
- Tier: HIGH. Depends: A-141.

## 4. Explicitly cut items: status in code (deletion preferred, D33)

Partially built. Recommend deleting:
- Engine resume machinery (built, but it misreports):
  - supervisor.ts:284-300 accepts `--resume`, and machine.ts replays prior events (lines 26, 76, 164). Both are tested by resume_cli.test.ts and resume_e2e.test.ts.
  - stages/intake.ts:95 still hardcodes `resumed: false` with a stale comment claiming resume is refused, so a resumed receipt says it was not resumed.
  - seal.ts:205 adds a "resume state not recorded" not_proven entry.
  - Delete it whole in A-113. The receipt field `resumed` stays constant false, so there is no schema change.
  - eval resume (S41-18, D43 item 4) is a different thing and stays.
- New dashboards: loki-ts/src/engine10/dashboard/page.ts (95 lines) and server.ts (313), plus the cli.ts TABLE row and the registry.ts entry.
  - This is about 410 core lines, the only large core offset.
  - It backs the user-facing `loki dashboard` under v10, so it is card A-150 and needs CTO and founder sign-off before anyone starts.
  - Fallback if refused: every card above stays self-offsetting.
- Circuit breakers and escalation in the SDK loop: loki-ts/src/runner/recovery_policy.ts, escalation_handoff.ts, intervention.ts, and the breaker code in providers.ts, budget.ts and autonomous.ts. Deleted by A-142 (blocked).
- Legacy circuit breakers: autonomy/app-runner.sh, autonomy/completion-council.sh, autonomy/lib/config-map.sh, autonomy/config.example.yaml. Freeze them, do not extend them, and delete them with legacy after item 4.

Not built (zero code hits on 2026-09-30, nothing to delete):
- three-tier escalation and the advisor. The "advisor" hits are "advisory".
- the transport/capability taxonomy
- CI watch after the PR
- VERIFIED_WITH_DEBT
- per-transition refs and effect classes

Not cuts (listed so nobody deletes them by mistake):
- The engine10 sizing.ts/fix.ts sonnet-then-top-model cascade (D31, decided).
- The SIGTERM-to-SIGKILL "escalateMs" in supervisor.ts, which is process control.
- stages/deep.ts, which is deep verify, not CI watch.

## 5. Waves and one-writer map

- Wave 1 (parallel): A-101, A-102, A-104, A-120, A-132, A-133.
- Wave 2: A-103 (after E-125 and A-102), A-111, A-113, A-121, A-122.
- Wave 3: A-110, A-112, A-123, A-134.
- Wave 4: A-130.
- Then A-02 runs in real-provider mode. On green, A-140, A-141 and A-142 unblock. A-150 waits on sign-off.
- Shared files, in writer order:

  | File | Writer order |
  |---|---|
  | types.ts | A-102 |
  | verify.ts | A-102, A-111, A-112 |
  | seal.ts | A-104, A-121, A-112 |
  | verify_cmd.ts | A-101, A-121 |
  | supervisor.ts | A-113, A-110, A-130 |
  | output.ts | A-110, A-130 |
  | docs/SIGNED-RECEIPTS.md | A-120, A-122 |
  | README.md | A-122, A-140 |
  | run.sh | A-132, A-134 |
  | autonomy/loki | A-122, A-123, A-134 |
  | doctor.ts | A-122, A-123 |
  | wall.ts | E-125, A-103 |
