# Loki Mode Privacy and Telemetry

This document is an honest, complete disclosure of what Loki Mode collects, what
it never collects, and how to turn collection off. If anything here does not
match the code, the code is the bug; please open an issue.

## Summary

- Anonymous diagnostics are ON BY DEFAULT for an ordinary individual install,
  and AUTO-OFF in enterprise, CI, and air-gapped contexts. This covers the CLI
  (session and command events), the dashboard, and the welcome page form. What is
  ever sent is ONLY anonymous diagnostics (operating system, architecture, Loki
  version, error type, and sanitized stack signatures). It NEVER includes your
  code, prompts, PRDs, file paths, environment values, API keys, repository
  names, emails, or IP addresses. (This statement scopes to telemetry and
  diagnostics; provider CLIs you configure, such as Claude or Codex, make their
  own network calls under your own credentials and are governed by their vendors.)
- Enterprise / CI / air-gapped deployments are safe out of the box: collection
  AUTO-DISABLES (no opt-out needed) when any of these is detected -- CI
  (CI/GITHUB_ACTIONS/GITLAB_CI/BUILDKITE/JENKINS_URL/TEAMCITY_VERSION/
  CONTINUOUS_INTEGRATION), an enterprise/air-gapped marker
  (LOKI_ENTERPRISE=true / LOKI_AIRGAP=true), or a non-interactive session (no
  TTY: scripts, pipes, cron, detached/container runs). In those contexts an
  untouched install sends us nothing. GDPR / FedRAMP deployments stay clean.
- Disclosure is never covert: the first-run welcome screen states (once) that
  anonymous diagnostics are on and how to turn them off, and this document is the
  canonical reference.
- Opt out anytime, and opt-out ALWAYS wins: `loki telemetry off` /
  `LOKI_TELEMETRY=off` / `LOKI_TELEMETRY_DISABLED=true` / `DO_NOT_TRACK=1` /
  `~/.loki/config: TELEMETRY_DISABLED=true`. Conversely `loki telemetry on`
  force-enables even inside CI/enterprise if you want to send us diagnostics.
- Crash reporting (Phase 0) is local-only with zero network egress regardless,
  and is gated by the same switch, so an opted-out (or auto-off) install writes
  nothing at all.

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

### 2. Usage telemetry (anonymous, on by default for individuals)

Loki Mode sends anonymous usage telemetry via PostHog. It is ON by default for an
ordinary individual install, and AUTO-OFF in enterprise, CI, air-gapped, and
non-interactive contexts (see the precedence below). It is gated by the same
switch as crash reporting, so a single opt-out (`loki telemetry off` /
`DO_NOT_TRACK=1`) disables everything, and it never sends your code, prompts,
paths, keys, or repo names -- only anonymous diagnostics.

- Endpoint: `https://us.i.posthog.com/capture/` (override with
  `LOKI_TELEMETRY_ENDPOINT`). The PostHog project key is a public ingest key.
- Events: `install` (on `npm install`), `session_start`, `session_end`,
  `cli_command`, and `dashboard_start`.
- Exact payload (every event): `os` (uname system), `arch` (CPU arch),
  `version` (Loki Mode version), `channel` (npm / docker / homebrew / skill /
  source), and a random per-machine `distinct_id` (a uuid4 stored in
  `~/.loki-telemetry-id`, never an email or name). The `install` event also adds
  `node_version` and `providers_installed` (which provider CLIs were detected,
  e.g. "claude,codex"). Some events add a small free-of-PII property such as the
  command name. No code, prompts, paths, keys, repo names, emails, or IPs.

### 3. Welcome page form (anonymous, explicit submit, opt-in)

The `loki welcome` page (`assets/welcome/welcome.html`) shows an optional form.
It NEVER sends anything on page load and is rendered inert unless you have opted
in. If you have opted in AND you choose to fill in and submit the form, it sends
these additional self-reported fields to PostHog: your role, company size, and
the tools you use, plus the same anonymous `distinct_id`. It still never sends
your name, email, or IP. In headless / Docker / CI environments there is no
browser, so this path never runs.

This document and the first-run notice describe ALL paths. The model is unified:
one opt-in enables them and one opt-out (which always wins) disables them.

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

## How to turn it off (and force it on)

Anonymous diagnostics are ON by default for an ordinary individual install. To
turn them off at any time, use ANY one of the following. Opt-out always wins, so
setting one of these guarantees nothing is collected or sent:

- Run `loki telemetry off` (persists `TELEMETRY_DISABLED=true` to `~/.loki/config`)
- Set `LOKI_TELEMETRY=off`
- Set `DO_NOT_TRACK=1` (the cross-tool community convention)
- Set `LOKI_TELEMETRY_DISABLED=true`

To FORCE it on (for example to send us diagnostics from a context that would
otherwise auto-disable, like CI), use ANY one of:

- Run `loki telemetry on` (persists `TELEMETRY_ENABLED=true` to `~/.loki/config`)
- Set `LOKI_TELEMETRY=on` (exact word `on`, case-insensitive)

### Precedence (exact)

1. If any opt-out flag is set, collection is OFF (hard kill, always wins).
2. Else if an explicit opt-in (`loki telemetry on` / `LOKI_TELEMETRY=on` /
   `TELEMETRY_ENABLED=true`) is set, collection is ON (this overrides the
   enterprise/CI/air-gapped auto-off below).
3. Else if the context is enterprise / CI / air-gapped / non-interactive,
   collection is OFF (auto-off, safe out of the box). Detected via: CI /
   GITHUB_ACTIONS / GITLAB_CI / BUILDKITE / JENKINS_URL / TEAMCITY_VERSION /
   CONTINUOUS_INTEGRATION, or LOKI_ENTERPRISE=true / LOKI_AIRGAP=true, or no TTY.
4. Otherwise (an ordinary individual install), collection is ON.

In all enabled cases, if `curl` is unavailable there is no egress.

### Air-gapped and enterprise deployments

A default install in an air-gapped, CI, or non-interactive environment sends us
no telemetry or diagnostics: collection AUTO-DISABLES there (step 3 above), so
there is nothing to turn off. To make collection impossible across a fleet
regardless of context, bake `LOKI_TELEMETRY_DISABLED=true` (or `DO_NOT_TRACK=1`)
into your base image or CI environment; opt-out always wins over everything,
including a stray `loki telemetry on`.

This same gate covers ALL paths: the `npm install` event, CLI session and
command events, the dashboard event, the welcome form, and local crash capture.

### OpenTelemetry (separate, self-hosted)

`loki telemetry enable [endpoint]` and `LOKI_OTEL_ENDPOINT` configure optional
OpenTelemetry tracing to an endpoint YOU run. There is no default endpoint, so
this never egresses to us; it is opt-in by definition and points only where you
tell it to.

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

- Safe-by-default for enterprise: collection AUTO-DISABLES in enterprise, CI,
  air-gapped, and non-interactive contexts, so an untouched install in those
  environments sends us no telemetry or diagnostics (no action required). For an
  ordinary individual install it is on by default (anonymous diagnostics only),
  disclosed once on first use, and a single opt-out (`loki telemetry off` /
  `DO_NOT_TRACK=1`) always wins and disables everything.
- Anonymous by design: no PII is in the whitelist; emails and IP addresses are
  denied outright. The welcome form's role / company-size / tools fields are
  self-reported and anonymous (no name, email, or IP).
- Disclosed: this document plus a first-run notice describe collection before
  any egress occurs.
- Opt-out is persistent, friction-free, and ALWAYS wins over opt-in. It applies
  to every collection path.
- The project id is non-reversible (one-way hash).
- Deletion: you can delete local reports yourself by removing files under
  `.loki/crash/`.

## Questions

Open an issue at https://github.com/asklokesh/loki-mode/issues and we will
clarify or correct this document.
