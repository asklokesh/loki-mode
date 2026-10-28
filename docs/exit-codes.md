# Exit codes

Every code below was read from the source, not from a help text. If a command
is absent from this page it returns only the shell defaults (0 on success,
nonzero on failure) and you should not build a gate on anything finer.

## The one rule

**Severity rises with the code.** `[ $rc -ge 2 ]` means "worse than the
level-1 outcome" for every command on this page except the `loki start` run
outcome ladder, where 6 (PARTIAL) is a milder result than 3, 4 and 5 and the
only safe test is `[ $rc -eq 0 ]` for "verified". Elsewhere, a bigger number is
never better news.

## `loki start`

Two contracts, and which one you get depends on an environment variable. This
is the part most likely to surprise a script author.

### Default (local, CI)

The run outcome and its exit code are in the "Run outcomes" table below. Usage
errors are distinct from run outcomes: `loki start` with an unknown option exits
64, and `loki quick` with no task description exits 64 (they were 1 and 2). A
missing provider CLI exits 2 before any spend, and so does a working directory
that is not a repository (`engine10: not inside a git repository`). A PRD path
that does not exist also exits 2 (`PRD file not found`). A gate that needs to
tell "crashed" from "failed the quality gate" in a platform job can also opt
into the durable contract further down.

### Run outcomes (engine10, the default engine)

`loki start` on the default engine ends in exactly one outcome and exits with the code below. PARTIAL (the work is done but not fully proven) has its own code so a CI gate can tell it from FAILED. `[ $rc -eq 0 ]` is still the only safe test for "verified".

| Code | Outcome | Meaning |
|---|---|---|
| 0 | VERIFIED, ALREADY_SATISFIED | Done and proven (or nothing to change) |
| 1 | FAILED | The run failed, or its event log was modified |
| 2 | (preflight) | Usage, missing provider CLI or not a repository, before any spend |
| 3 | BUDGET_STOP | A cost or time cap ended the run |
| 4 | BLOCKED | Contradictory spec (SPEC_CONFLICT) |
| 5 | STALLED | The same failure three times |
| 6 | PARTIAL | Done but not fully proven; before this release PARTIAL exited 1 like FAILED |
| 130 | CANCELLED | SIGINT or SIGTERM during a run (143 for SIGTERM) |

A gate that treated every nonzero code as failure keeps working. A gate that tested `-eq 1` for "failed or partial" must now also accept 6.

### With `LOKI_DURABLE_STATE=1` (the platform contract)

Written for a Kubernetes Job, an ECS task, or a systemd unit that has to decide
whether retrying is worth anything. The distinction it draws is **will running
this again produce a different result**.

| Code | Meaning | Should the platform retry? |
|---|---|---|
| 0 | Completed, or a human stopped it (council approved, completion promise, force-stop, paused, interrupted, stopped) | No. It is done, or a person is driving. |
| 20 | Deterministic terminal failure (failed a gate, max iterations, max retries, **budget exceeded**, **wall-clock cap reached**, policy blocked, contradictory spec) | **No.** The same inputs fail the same way; a retry only spends money to arrive here again. |
| any other nonzero | Crash (SIGKILL, eviction, node loss) | Yes. The restarted run resumes from the durable volume. |

`budget_exceeded` sits with the failures deliberately. It used to exit 0 on the
reasoning that a human would raise the cap and resume, which is true at a
terminal and false inside a Job: there is no human, so a build stopped mid-work
by the cost breaker was reported as a success. Exit 0 must mean the work is
finished or a person chose to stop it.

Helm wires this up for you: `worker.exitCodes.terminalFailure` (default 20)
feeds the Job's `podFailurePolicy`, so a deterministic failure fails the Job
immediately instead of burning `backoffLimit`. Requires Kubernetes 1.31+.

Both the bash runner and the Bun runner (`LOKI_SDK_LOOP`) implement this
identically; a parity test asserts they agree status for status.

The default engine honors the same opt-in: with `LOKI_DURABLE_STATE=1` a run that
ends FAILED, PARTIAL, BUDGET_STOP, BLOCKED (spec conflict) or STALLED exits 20
instead of 1, 3, 4, 5 or 6, and a success still exits 0. A signal cancel (130, or 143
for SIGTERM) stays nonzero and retryable. Without the variable the ladder above is
unchanged.

## `loki quick`

| Code | Meaning |
|---|---|
| 0 | The run completed and its diff did not weaken the tests |
| 3 | The diff weakened the tests (a skip marker added in a test file, a test runner config changed, or an existing test file deleted or renamed). The receipt headline is NOT VERIFIED and names what was weakened, for example `NOT VERIFIED (tests weakened: skip added in sum.test.js)` |
| 2 | Not a git repository (engine10 preflight, before any spend), or a missing provider CLI |
| 64 | Usage error: no task description, or an unknown leading `--option` (from 11.5.0; before that it was taken as task text and started a paid run) |
| other nonzero | The run itself failed; this code is passed through unchanged (a 6 means PARTIAL, see the `loki start` run outcomes table) |

`loki quick` has no `--json` flag; its structured result is `loki why --json`, schema: `schemas/why-result.schema.json` (`state.lastExitCode` carries the ladder above).

Code 3 only ever raises an exit of 0, in quiet and `LOKI_VERBOSE=1` modes alike;
it never lowers another nonzero code. Edited assertion lines are disclosed in
the receipt (`tests_integrity:assertions_edited`) and keep exit 0. A NOT VERIFIED
headline caused by unproven gates alone also keeps exit 0. The signal is the
`tests_integrity` item in the proof's `honesty.degraded`, not the headline text.

## `loki verify`

| Code | Verdict |
|---|---|
| 0 | VERIFIED |
| 1 | CONCERNS (findings below the block threshold, or inconclusive evidence) |
| 2 | BLOCKED (findings at or above the block threshold), or not a git directory |
| 3 | Verifier error: it could not complete, and never silently passes (also an empty diff) |
| 64 | Usage error: unknown option or unexpected argument |

`loki verify` has no `--json` flag. `loki status --json` schema: `schemas/status-result.schema.json`.

Code 3 matters more than it looks. A verifier that cannot run is not a pass,
so `[ $rc -eq 0 ]` is the only safe test for "verified" -- `[ $rc -ne 2 ]`
would treat a broken verifier as acceptable.

### UNSIGNED receipts (D47)

An UNSIGNED receipt (no attestation, so its integrity is not attested) is never
a pass, on either engine, with or without a local key. A stripped receipt must
not rank above UNCHECKED.

| Engine | UNSIGNED without the flag | With `--allow-unsigned` or `LOKI_VERIFY_ALLOW_UNSIGNED=1` |
|---|---|---|
| Engine10 (`loki-ts`, `verify_cmd.ts`) | exit 3, `attestation: UNSIGNED, integrity not attested; refusing (pass --allow-unsigned to accept)` | exit 0, `attestation: UNSIGNED (accepted by --allow-unsigned; integrity not attested)` |
| Legacy shell (`autonomy/verify.sh`) | BLOCKED (non-zero) | the receipt line passes with the same accepted line |

### UNCHECKED attestations and a missing run-id pointer on legacy (D76)

Legacy `loki verify` (`autonomy/verify.sh`) no longer passes a receipt whose
attestation it cannot evaluate. A well-formed token whose kid matches no local key
(and no `LOKI_RECEIPT_RETIRED_PUBKEYS` entry) prints `attestation: UNCHECKED`,
exits 2 (BLOCKED) and the `VERDICT:` line is not VERIFIED, matching engine10.
Anyone can mint a token with a foreign kid, so exit 0 was a downgrade path. The
output names the honest cross-machine path: `loki verify --pubkey FILE <run-id>`
checks a Loki 10 run receipt against the signer's public key, but it does not read
a legacy `.loki/proofs/<id>/proof.json`; for a legacy receipt signed elsewhere, add
the signer's public key (PEM) to `LOKI_RECEIPT_RETIRED_PUBKEYS`. A token signed by
the local key still verifies with exit 0.

Run standalone (`bash autonomy/verify.sh`, outside the `loki` CLI), the script
has no attestation verdict helper, so every receipt prints
`attestation: UNCHECKED (run via loki verify)` and the receipt check fails. This
holds even with `--allow-unsigned`, which accepts only a receipt the CLI has
classified as UNSIGNED. Run `loki verify` to evaluate the attestation.

A missing `.loki/state/last-proof-id.txt` no longer skips the receipt check. If
proofs exist under `.loki/proofs` the run is `receipt: NOT VERIFIED` (exit 2); a
pointer naming a missing proof is the same. A tree that never recorded a proof
prints `receipt: NONE (no proof was recorded in this tree; no receipt was checked)`
and is not failed for it, because there is nothing to verify; that line is not a
receipt pass.

Engine10 `loki verify [run-id]` exits: 0 verified, 1 tampered, 2 unchecked,
3 unsigned (refused), 4 run outcome not verified (a sealed receipt of a FAILED or
otherwise unverified run), 66 no runs. The outcome check runs before the UNSIGNED
branch, so the flag never changes exit 4, TAMPERED or UNCHECKED,
and verify never creates a signing key.

`loki verify --pubkey FILE <receipt.json|run-id>` (v10 only) checks the signature
against the supplied Ed25519 public key (JWK from `loki keys export`, or PEM) and
never the local JWKS. Exits: 0 VERIFIED, 1 TAMPERED, 2 UNCHECKED (kid does not
match the key, or the key file is unusable), 3 UNSIGNED (a receipt with no
signature is refused even with `--allow-unsigned`, because the caller asked for a
signature check), 4 run outcome not verified (checked before UNSIGNED).

`loki verify <run-id|receipt.json> --export-dsse` (v10 only) exits 0 after
printing the envelope, 1 TAMPERED, an envelope given as input, or an envelope
under a run id whose `predicate.run_id` differs, 2 UNSIGNED, UNCHECKED or an
unreadable receipt, 4 a verified receipt whose run outcome is not VERIFIED or
ALREADY_SATISFIED, 66 no signing key (or no runs). Refusals print nothing on stdout.

`loki verify <run-id> --require-exogenous` (or `LOKI_VERIFY_REQUIRE_EXOGENOUS=1`, v10 only) prints an `agent-independent: k of n passing checks` line for a VERIFIED receipt and exits 4 when k is 0 or the receipt records no check provenance. TAMPERED, UNCHECKED and UNSIGNED verdicts are unchanged.
`--pubkey` may come before or after the run-id and may be written `--pubkey=FILE`; `--pubkey` with no file or an empty `--pubkey=`, a repeated `--pubkey`, an unknown option, or more than one run-id exits 2.

An early draft spec listed `1=BLOCKED, 2=CONCERNS`. That ordering was rejected:
it is not used anywhere, it has no consumers, and it inverts the
severity-rises-with-the-code rule that every other command follows.

### Contract enforced from v11.4.0

This is a deliberate contract change for the 11.4.0 minor release. Three inputs
that used to return a misleading code now return the table's value:

| Input | Command | Exit | Note |
|---|---|---|---|
| Empty diff (a repo with no changes vs base) | `loki verify` | 3 | Nothing to check is a verifier error, never a pass. VERDICT line still reads CONCERNS. |
| Not a git directory | `loki verify` | 2 | Could not check. VERDICT line still reads CONCERNS. |
| Unknown option or unexpected argument | `loki verify --no-such-flag` | 64 | Usage error, as in `proof verify`. |

A real finding keeps precedence: an empty diff that also carries a below-threshold
finding (for example spec drift) still exits 1, and a blocking finding still exits 2.
CI gates that tested `[ $rc -eq 1 ]` for these inputs must move to `[ $rc -ne 0 ]`.
The moat case `P2.verify-exit-contract` is no longer pending and is enforced.

### `loki verify --fast`

| Code | Meaning |
|---|---|
| 0 | PASS: files were scanned and nothing blocking was found |
| 1 | FAIL: a blocking finding |
| 2 | The root directory does not exist |
| 3 | INCONCLUSIVE: nothing was scanned (0 files) |
| 64 | Unknown option (`--path DIR` and `--help` are supported; `--help` exits 0) |

## `loki proof verify <id>`

Re-checks one Evidence Receipt against the repo (tamper and drift). The same
codes on the Bun route and the bash route (`LOKI_LEGACY_BASH=1`).

| Code | Meaning |
|---|---|
| 0 | Clean: the integrity hash matches and the recorded diff still matches the repo (and, with `--jwks`, the attestation is VERIFIED) |
| 1 | Tampered, or genuinely drifted (the working tree really changed since the recorded base); or, with `--jwks`, the attestation FAILED, or is ABSENT (the receipt is unsigned while a key set was supplied) |
| 2 | Could not check: the receipt is present but unusable (malformed JSON), the verifier itself is missing, drift could not be re-derived (verified outside a git tree, or the recorded base ref no longer resolves, with every other check passing) rather than genuinely found, or, with `--jwks`, the attestation is NOT CHECKED (key set unreadable, empty, or a verifier dependency missing) |
| 64 | Usage error: no proof id, more than one proof id, an unknown option (a mistyped `--jwk` must never skip the check), `--jwks` with no value or an empty one, or `-h`/`--help` (verify never exits 0 without a verdict; full help is `loki proof help`). `--` ends options, so `loki proof verify -- <id>` checks an id that begins with `-` |
| 66 | Input missing: no `.loki/proofs/<id>/proof.json` for that id |

64 and 66 are not verdicts. They say the question was never asked, so neither
one is a pass, and neither one accuses the receipt the way 1 does. Before this
contract a missing id exited 2 and an unknown id exited 1, which made a typo
look like "could not check" and a wrong id look like a tampered receipt. An
empty `--jwks` value used to skip the attestation check and exit 0.

`proof verify` ranks 1 above 2: when the receipt fails one check and another
could not run (a drift finding plus an unreadable `--jwks` key set, say), it
exits 1, because a definite failure of this one receipt is never softened into
"could not check". `proof chain` ranks 2 above 1 on
purpose: it rolls up many stages, and an operator who fixes the named FAILED
stage and re-runs would see green while still blind on the stage that never
ran (`tools/verify-chain.py`, rule 4).

## `loki start --remote` receipt check (not a verify command)

This is a documented DIVERGENCE from `proof verify`, not a bug. `loki start
--remote <url>` submits a build to a deployed cluster (`loki_remote_submit`,
`autonomy/loki`), and after the job finishes it fetches the Evidence Receipt
and runs an internal check (`loki_remote_verify_receipt`) that prints one of
several verdict words also used elsewhere in `loki proof`: VERIFIED, UNSIGNED,
NOT CHECKED, TAMPERED, plus its own NOT VERIFIED when the verifier itself is
unavailable (a fifth, distinct string -- see the last row below). Despite the
shared vocabulary, this is not the `proof verify` contract and does not return
its codes.

`loki_remote_verify_receipt` is an internal helper, never a standalone
command. Its return value feeds `_receipt_rc` inside `loki_remote_submit` via
`loki_remote_fetch_receipt` (`autonomy/loki`), whose own last statement is the
verify call with no `||` to reset the status -- so the helper's return code
propagates out unchanged. `loki_remote_submit` then checks `_receipt_rc`
BEFORE ever looking at job status:

| Receipt verdict | Helper return | Process exit |
|---|---|---|
| VERIFIED (gpg or attestation) | 0 | Governed by the job status below |
| UNSIGNED | 0 | Governed by the job status below |
| NOT CHECKED -- gpg unavailable on this machine, or an attestation present but unreachable/uncheckable (JWKS unreachable, crypto missing) | 0 | Governed by the job status below |
| NOT CHECKED -- signed, but the signing key is not in the verifier's keyring (gpg `nopubkey`), and no valid attestation covers it | 1 | 1, unconditionally |
| NOT VERIFIED -- the local verifier itself is unavailable (no python3, or `lib/proof-verify.py` missing) | 0 | Governed by the job status below |
| TAMPERED (bad hash, bad gpg signature, bad attestation) | 1 | 1, unconditionally |

The exit code `loki start --remote` actually returns is gated on the job's own
terminal status (`passed` / `failed` / `unknown`) in most cases, but there are
TWO deliberate overrides that fail the whole submit regardless of job status,
not one:

- **TAMPERED** (bad hash, bad gpg signature, bad attestation): an accusation
  that the receipt itself was altered.
- **NOT CHECKED / nopubkey** (signed, but the verifying machine does not hold
  the signing public key, and no attestation proves it another way): per the
  code's own comment at this branch (`autonomy/loki:1081-1084`), this is
  "Non-zero: a caller who asked for a signed receipt did not get proof, and in
  CI that must not pass silently." It is explicitly NOT an accusation of
  tampering -- the message says plainly that nothing is wrong with the
  contents -- but it still fails the submit, because a signed remote build
  whose signature could never be checked is exactly the case this override
  exists to catch. Concretely: a build can be genuinely signed, actually pass,
  and still make `loki start --remote` exit 1, if the verifying machine simply
  never imported the publisher's key and no JWKS attestation is available to
  cover the gap.

Every other outcome -- VERIFIED by either gpg or attestation, UNSIGNED, the
gpg-unavailable/attestation-uncheckable NOT CHECKED case, and the
verifier-unavailable NOT VERIFIED case -- returns 0 from the helper and
defers entirely to job status, because none of those contradicts the job's
reported outcome.

This is why remote NOT CHECKED can exit 0 in some branches and 1 in others,
while `loki proof verify`'s NOT CHECKED always exits 2: they answer different
questions. `proof verify` IS the verdict -- its only output is "was this
receipt proven", so an unproven result can never exit 0. The remote helper's
verdict is a secondary integrity check bolted onto a job-status command whose
primary question is "did the build pass"; most unprovable outcomes do not
change that answer, but the nopubkey case is carved out by the code itself as
a hard failure, and TAMPERED always is. (`_deploy_receipt_verdict`'s own
header comment, elsewhere in `autonomy/loki`, makes the same point about this
helper for the UNSIGNED case specifically -- "that function returns 0 for
UNSIGNED, which is right for its caller (submit) and wrong here (integrity is
not provenance)" -- it does not speak to NOT CHECKED, whose nopubkey behavior
is documented at its own branch as cited above.)

To get the `proof verify` exit-code contract (0/1/2/64/66) against a receipt
fetched from a remote build, run `loki proof verify <job-id>` afterward
against the written `.loki/proofs/<job-id>/proof.json` -- that is a genuine
verify call and returns the codes documented above, not the ones in this
section.

## `loki proof chain [workspace]`

Runs the whole verification chain (`tools/verify-chain.py`) and passes its exit
code through unchanged.

| Code | Meaning |
|---|---|
| 0 | Every stage was checked and passed |
| 1 | A stage FAILED |
| 2 | A stage could not be evaluated (UNAVAILABLE outranks FAILED) |
| 3 | Nothing to check anywhere: zero receipts is not a pass |
| 64 | Usage error: an unknown flag, or `-h`/`--help` (a verifier never exits 0 without a verdict; full help is `loki proof help`) |
| 66 | The workspace does not exist |

## `loki ci`

| Code | Meaning |
|---|---|
| 0 | Passed, or all findings are below `--fail-on` |
| 1 | Findings exceed the `--fail-on` threshold |
| 2 | Error: missing tools or invalid arguments |

Machine-readable output is `--format json` here, not `--json`.

## `loki doctor`

| Code | Meaning |
|---|---|
| 0 | Every required check passed. Optional warnings do not fail the command. |
| nonzero | At least one required check failed; the output names which |

The contract is identical for human-readable output and `--json`. JSON is
still emitted in full before the command exits nonzero, so automation can save
or parse the report while also using the process status as a readiness gate.

Safe as a preflight gate in an init container or pipeline step:

```sh
loki doctor || { echo "host is not ready"; exit 1; }
```

An absent optional provider CLI is a warning, not a blocker, so this will not
refuse to start over a tool you were never going to use.

## Security scan

| Code | Meaning |
|---|---|
| 0 | No high or critical findings |
| 1 | At least one HIGH |
| 2 | At least one CRITICAL |

## Signals

`loki start` handles the usual terminating signals conventionally: 130 for
SIGINT (Ctrl-C), 143 for SIGTERM. Under the durable contract these are crashes
in the retryable sense -- a pod terminated by the scheduler resumes rather than
being treated as a completed build.

## Writing a gate

```sh
# Block a merge unless verification is clean. Note -ne 0, not -eq 2:
# a verifier ERROR (3) must not pass.
loki verify || { echo "not verified"; exit 1; }

# Kubernetes: let the platform decide whether to retry.
LOKI_DURABLE_STATE=1 loki start ./prd.md
rc=$?
case $rc in
  0)  echo "complete" ;;
  20) echo "terminal failure -- fix the spec or raise the budget, then re-submit" ;;
  *)  echo "crashed (rc=$rc) -- resume is safe" ;;
esac
```

Do not read an exit code through a pipe. `$?` after a pipeline reports the last
stage, so `loki verify | tee log` gives you `tee`'s status and always looks
successful. Use `${PIPESTATUS[0]}` in bash, or capture first and test after.

## `loki edit`

One provider pass, no loop.

| Code | Meaning |
|---|---|
| 0 | Edit done (or nothing to change, or `--dry-run` plan printed) |
| 1 | Provider pass failed, or `--verify` failed (nothing is committed) |
| 2 | Usage or setup error (no change text, not a git repo, claude or python3 missing, unsupported provider) |

## `loki run` (deprecated alias of `loki start <issue-ref>`)

Not changed. `loki run` with an unknown option exits 1 (it predates the 64 usage
contract and keeps its code); with no issue reference it exits 2. New scripts
should call `loki start` instead. `loki route` input errors (a missing PRD file,
or `--engine engine10` combined with a flag engine10 cannot honor) exit 2.

## Contract cases

Each row is executed against the real CLI by `tests/test-exit-codes-documented.sh`,
which fails if an observed code differs from the Exit column. Every case stops
before any provider spend. An empty diff is a distinct code only for `loki verify`
(3). `loki edit` treats it as "nothing to change" (exit 0, see above); `loki quick`,
`loki start` and `loki run` have no empty-diff exit code, and none is asserted.

| Case | Command and setup | Exit | Meaning |
|---|---|---|---|
| `verify-empty-diff` | `loki verify` in a repo with no diff vs base | 3 | Verifier error: nothing to check is never a pass |
| `verify-not-git` | `loki verify` outside a git repository | 2 | Could not check |
| `verify-unknown-flag` | `loki verify --no-such-flag` | 64 | Usage error |
| `run-unknown-flag` | `loki run --no-such-flag` | 1 | Legacy alias keeps its pre-64 code |
| `run-no-issue-ref` | `loki run` with no argument | 2 | Issue reference required |
| `quick-unknown-flag` | `loki quick --no-such-flag` | 64 | Usage error (from 11.5.0) |
| `quick-no-task` | `loki quick` with no argument | 64 | Usage error |
| `quick-not-git` | `loki quick fix the bug now` outside a git repository | 2 | engine10 preflight, before spend |
| `edit-unknown-flag` | `loki edit --no-such-flag` | 2 | Usage error |
| `edit-no-change` | `loki edit` with no change text | 2 | Usage error |
| `edit-not-git` | `loki edit "change x"` outside a git repository | 2 | Setup error |
| `start-unknown-flag` | `loki start --no-such-flag` | 64 | Usage error |
| `start-missing-prd` | `loki start missing-prd.md` | 2 | PRD file not found |
| `start-not-git` | `loki start fix the bug now` outside a git repository | 2 | engine10 preflight, before spend |

Migration note (11.5.0): `loki quick --some-typo` used to run a paid task whose text
was the flag. It now exits 64 before any spend. Task text that starts with `--` must
be rephrased or put after other words.

## Routing contract

Authoritative contract for which engine and adapter `loki start` and `loki quick` use for each input form. Inspect any call without running it:

```sh
loki route start <args> --json
loki route quick <args> --json
loki --explain-route <flag-first args>
```

The JSON carries `engine`, `adapter`, `provider`, `model`, `input_type`, `input`, `reason` and `capability_differences`. `capability_differences` is an empty list only for the full Claude Code path on the Loki 10 engine. Any compatibility route (the legacy bash loop, or a provider other than Claude) lists at least one difference.

### Rules

- Argument order never changes the route: flags first or last, `--prd FILE` or a positional file, `--provider X` or `LOKI_PROVIDER=X`, `--engine X` or `LOKI_ENGINE=X` all resolve identically (the flag wins over the env var).
- Default engine is `engine10` for a PRD file (`.md`, `.json`, `.yaml`), an issue reference (`owner/repo#N` or an issue URL), a multi-word task and a one-word brief.
- The legacy engine runs only on `--engine legacy` or `LOKI_ENGINE=legacy`, for one call when a flag engine10 does not support is present (a notice is printed), for a provider with no engine10 invoker, or for a PRD larger than 100000 bytes.
- `--engine engine10` with an unsupported flag is refused (exit 2) instead of rerouted.
- A missing PRD file path is a usage error (exit 2).
- Adapter is `<engine>:<provider>`, with the legacy engine written `legacy-bash:<provider>`.
- Claude Code is the primary provider. The `loki chat` surface does not use this router; it is a separate interactive entry point.

### Invocation table

The table below is rendered from live `loki route --json` output by `tests/test-engine10-dispatch.sh`. The test fails if it drifts; regenerate with `bash tests/test-engine10-dispatch.sh --update-doc`.

<!-- route-table:begin (generated by tests/test-engine10-dispatch.sh --update-doc) -->
| Invocation (after `loki route`, unless it starts with `loki` or an env var) | Engine | Adapter | Capability differences | Reason |
|---|---|---|---|---|
| `start p.md` | engine10 | engine10:claude | none | default: prd input runs on engine10 regardless of flag order |
| `start p.md --provider claude` | engine10 | engine10:claude | none | default: prd input runs on engine10 regardless of flag order |
| `start --provider claude p.md` | engine10 | engine10:claude | none | default: prd input runs on engine10 regardless of flag order |
| `start --prd p.md` | engine10 | engine10:claude | none | default: prd input runs on engine10 regardless of flag order |
| `start p.json` | engine10 | engine10:claude | none | default: prd input runs on engine10 regardless of flag order |
| `start p.yaml` | engine10 | engine10:claude | none | default: prd input runs on engine10 regardless of flag order |
| `start "fix the bug"` | engine10 | engine10:claude | none | default: task input runs on engine10 regardless of flag order |
| `start fix the bug` | engine10 | engine10:claude | none | default: task input runs on engine10 regardless of flag order |
| `loki --explain-route --json "fix the bug"` | engine10 | engine10:claude | none | default: task input runs on engine10 regardless of flag order |
| `quick "fix the bug"` | engine10 | engine10:claude | none | default: task input runs on engine10 regardless of flag order |
| `quick fix the bug` | engine10 | engine10:claude | none | default: task input runs on engine10 regardless of flag order |
| `start owner/repo#5` | engine10 | engine10:claude | none | default: issue input runs on engine10 regardless of flag order |
| `start owner/repo#5 --provider claude` | engine10 | engine10:claude | none | default: issue input runs on engine10 regardless of flag order |
| `start https://github.com/owner/repo/issues/5` | engine10 | engine10:claude | none | default: issue input runs on engine10 regardless of flag order |
| `start hello` | engine10 | engine10:claude | none | default: brief input runs on engine10 regardless of flag order |
| `start p.md --provider codex` | engine10 | engine10:codex | 1 listed | default: prd input runs on engine10 regardless of flag order |
| `start --provider codex p.md` | engine10 | engine10:codex | 1 listed | default: prd input runs on engine10 regardless of flag order |
| `LOKI_PROVIDER=codex start p.md` | engine10 | engine10:codex | 1 listed | default: prd input runs on engine10 regardless of flag order |
| `start p.md --provider cline` | engine10 | engine10:cline | 1 listed | default: prd input runs on engine10 regardless of flag order |
| `start p.md --provider aider` | engine10 | engine10:aider | 1 listed | default: prd input runs on engine10 regardless of flag order |
| `start p.md --provider opencode` | engine10 | engine10:opencode | 1 listed | default: prd input runs on engine10 regardless of flag order |
| `start p.md --engine legacy` | legacy | legacy-bash:claude | 1 listed | explicit: --engine legacy or LOKI_ENGINE=legacy |
| `start --engine legacy p.md` | legacy | legacy-bash:claude | 1 listed | explicit: --engine legacy or LOKI_ENGINE=legacy |
| `LOKI_ENGINE=legacy start p.md` | legacy | legacy-bash:claude | 1 listed | explicit: --engine legacy or LOKI_ENGINE=legacy |
| `start p.md --engine engine10` | engine10 | engine10:claude | none | explicit: --engine engine10 |
| `LOKI_ENGINE=engine10 start p.md` | engine10 | engine10:claude | none | explicit: --engine engine10 |
| `start big.md` | legacy | legacy-bash:claude | 1 listed | PRD is larger than 100000 bytes (engine10 takes the task as one argument) |
<!-- route-table:end -->
