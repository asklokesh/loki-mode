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

An early draft spec listed `1=BLOCKED, 2=CONCERNS`. That ordering was rejected:
it is not used anywhere, it has no consumers, and it inverts the
severity-rises-with-the-code rule that every other command follows.

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
