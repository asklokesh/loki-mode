# Loki Mode Privacy and Telemetry

This document is an honest, complete disclosure of what Loki Mode collects, what
it never collects, and how to turn collection off. If anything here does not
match the code, the code is the bug; please open an issue.

## Summary

- Loki Mode collects anonymous diagnostics to help find and fix bugs.
- It NEVER collects your code, prompts, PRDs, file paths, environment values,
  API keys, repository names, emails, or IP addresses.
- In this version (crash reporting Phase 0), NOTHING is sent automatically.
  Crash reports are written to a local directory only, so you can inspect
  exactly what a future version would send.
- You can opt out at any time with a single switch. The same switch also
  disables the existing anonymous usage telemetry described below.

## Two collection paths exist

### 1. Crash reporting (Phase 0: local-only, no network)

When Loki Mode hits an unexpected error (an uncaught exception, an unhandled
promise rejection, a nonzero process exit, or an explicit friction signal such
as a retry loop, a rate-limit loop, or a quality-gate failure), it captures a
scrubbed diagnostic report.

Phase 0 behavior:

- The report is scrubbed by a shared Python module before anything is written.
  If a scrubber is not available (no python3 on the system), Loki Mode writes
  nothing and sends nothing. This is fail-closed by design.
- The scrubbed report is written locally to `.loki/crash/<id>.json` in your
  project directory.
- No network request is made. Phase 0 has zero egress.
- You can read the reports yourself:
  - `loki crash` lists local reports.
  - `loki crash show <id>` prints one report exactly as stored.
  - `loki crash submit [<id>]` prints the full scrubbed payload and a prefilled
    GitHub issue URL so you can submit it manually if you choose. Loki Mode does
    not submit anything for you in this version.

### 2. Usage telemetry (existing, anonymous)

Loki Mode already ships anonymous usage telemetry via PostHog. This predates the
crash-reporting feature and is disclosed here for completeness.

- Events: `session_start`, `session_end`, and an install-time event.
- These are anonymous and gated by the same opt-out described below.
- They never carry your code, prompts, paths, keys, or repository names.

This document and the first-run notice describe BOTH paths. The opt-out is
unified: one switch disables crash reporting AND usage telemetry together.

## What is collected (the whitelist)

Crash reports contain ONLY the following fields. Anything not on this list is
dropped, not merely redacted:

- os (operating system, e.g. Darwin, Linux)
- arch (CPU architecture, e.g. arm64, x86_64)
- loki_version (the Loki Mode version)
- runtime version (node version and/or bun version)
- error_class (e.g. TypeError, ENOENT, NonZeroExit)
- stack_signature (a short list of normalized stack frame signatures:
  function or symbol names only, with file paths, line numbers, and columns
  stripped)
- rarv_phase (which phase of the RARV cycle was active, when known)
- exit_code
- friction_kind (retry_loop, rate_limit_loop, or gate_failure) when applicable
- project_id_hash (a one-way hash, see the tradeoff note below)
- fingerprint (a dedup key derived from the error class plus the normalized
  stack signatures)
- rules_version and redactions_count (scrubber bookkeeping)
- captured_at (UTC timestamp, second precision)

## What is NEVER collected

- Your source code
- Your prompts, briefs, or PRDs
- File contents of any kind
- File paths (home paths are stripped to `~`; paths are not whitelisted)
- Environment variable values
- API keys, tokens, or other secrets
- Repository names
- Email addresses
- IP addresses

Because the report is whitelist-only (deny by default), free-text fields such as
prompts, briefs, and diffs can never reach the payload even if a redaction rule
were to miss something. Secrets are additionally scrubbed by the shared redactor
before whitelisting.

## How to opt out

Any one of the following disables BOTH crash reporting and usage telemetry:

- Set the environment variable `LOKI_TELEMETRY=off`
- Run `loki telemetry off`
- Set `DO_NOT_TRACK=1` (the cross-tool community convention)
- Set `LOKI_TELEMETRY_DISABLED=true`

To re-enable later, run `loki telemetry on` or unset the variables. Once you opt
out, the first-run notice is never shown again.

## Where reports are stored locally

Scrubbed crash reports live in `.loki/crash/` inside your project directory. You
can open these files in any text editor or use `loki crash show <id>`. In Phase 0
this directory is the only place crash data exists; it is yours to read or
delete at any time.

## The unsalted project-id tradeoff (plain language)

The `project_id_hash` is a SHA-256 hash of your git remote origin URL, after
normalizing it (scheme removed, `.git` suffix removed, trailing slash removed,
host lowercased). It does NOT hash your local filesystem path, so it carries no
`/Users/<name>/` style information.

The hash is unsalted on purpose. An unsalted hash lets two users who hit the
same bug in the same public repository collapse to a single triage entry, which
is the entire point of deduplication and occurrence counting. A per-user salt
would defeat that. The cost of leaving it unsalted is that, for a known PUBLIC
repository, someone could hash candidate repo URLs and check for a match. But
the only thing that would reveal is which public repository was involved, which
is already public information, so the privacy cost is acceptable. For a PRIVATE
repository, the origin still hashes to an opaque value that leaks no path or
name. We chose cross-user dedup over per-user unlinkability, and we are stating
that choice plainly so you can decide whether to opt out.

## Compliance posture

- Anonymous by design: no PII is in the whitelist; emails and IP addresses are
  denied outright.
- Disclosed: this document plus a first-run notice describe collection before
  any egress occurs.
- Opt-out is persistent and friction-free (see above) and applies to both
  collection paths.
- The project id is non-reversible (one-way hash).
- Deletion: you can delete local reports yourself by removing files under
  `.loki/crash/`.

## Questions

Open an issue at https://github.com/asklokesh/loki-mode/issues and we will
clarify or correct this document.
