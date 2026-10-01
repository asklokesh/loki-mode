# Exit codes

Every code below was read from the source, not from a help text. If a command
is absent from this page it returns only the shell defaults (0 on success,
nonzero on failure) and you should not build a gate on anything finer.

## The one rule

**Severity rises with the code.** `[ $rc -ge 2 ]` always means "worse than the
level-1 outcome" for any command on this page. If you remember nothing else,
remember that a bigger number is never better news.

## `loki start`

Two contracts, and which one you get depends on an environment variable. This
is the part most likely to surprise a script author.

### Default (local, CI)

| Code | Meaning |
|---|---|
| 0 | The run completed |
| nonzero | Something went wrong |

There is no finer signal. A gate that needs to tell "failed the quality gate"
from "crashed" must opt into the durable contract below.

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

## `loki verify`

| Code | Verdict |
|---|---|
| 0 | VERIFIED |
| 1 | CONCERNS (findings below the block threshold, or inconclusive evidence) |
| 2 | BLOCKED (findings at or above the block threshold) |
| 3 | Verifier error: it could not complete, and never silently passes |

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

Engine10 `loki verify [run-id]` exits: 0 verified, 1 tampered, 2 unchecked,
3 unsigned (refused), 66 no runs. The flag never changes TAMPERED or UNCHECKED,
and verify never creates a signing key.

An early draft spec listed `1=BLOCKED, 2=CONCERNS`. That ordering was rejected:
it is not used anywhere, it has no consumers, and it inverts the
severity-rises-with-the-code rule that every other command follows.

### Known gaps until v10.0.0

The table above is the target. On the current release, four inputs do not
return what it implies. Measured on this checkout:

| Input | Command | Exit today | Target |
|---|---|---|---|
| Empty diff (a git repo with no changes vs base) | `loki verify` | 1 (CONCERNS) | 3 |
| Not a git directory | `loki verify` | 1 (CONCERNS) | 2 |
| Unknown flag | `loki verify --no-such-flag` | 3 | 64 |
| `--fast` with nothing scanned (0 files) | `loki verify --fast <empty-dir> --no-cache` | 0 | nonzero |

`loki verify --fast` (`autonomy/lib/fast_verify.py`) also exits 0 for a
nonexistent root and silently ignores unknown flags. Until v10.0.0, do not
trust exit 0 from `--fast` alone: check stdout for `INCONCLUSIVE`, which it
prints when nothing was scanned.

Both gaps are tracked as pending moat cases, milestone v10.0.0, in
`tests/moat/pending.txt`: P2.verify-exit-contract (the first three rows)
and P2.fast-verify-inconclusive-not-zero (the `--fast` row).

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
