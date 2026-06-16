# Spec-Independent Invariant Checks (P1-4)

Deterministic invariant assertions over the produced source code that hold
regardless of what the spec says. They catch the "spec was silent and the model
guessed wrong" failure mode: code that ships a hardcoded secret or logs PII is
wrong no matter what the PRD asked for.

Implementation: `tests/detect-invariant-violations.sh`
Tests: `tests/test-invariant-detector.sh`

## What this is (and is not)

This is NOT a property-based test generator. The "Kiro Pattern" documented in
`skills/testing.md` (fast-check / hypothesis) generates randomized property
tests; that is a separate, larger feature and remains unimplemented. This
detector instead makes a small set of SOLID deterministic invariant ASSERTIONS
over the produced code. The design choice is explicit: a small set of solid
deterministic checks beats a large set of flaky ones.

## Checks

### Deterministic (blocking under `--strict`)

| # | Invariant | Severity | How |
|---|-----------|----------|-----|
| 1 | No committed secrets in source/logs | CRITICAL | Known credential prefixes: AWS access keys (`AKIA`/`ASIA`), PEM private-key blocks, GitHub tokens (`ghp_`/`gho_`/`ghs_`/`github_pat_`), Slack (`xox[baprs]-`), Google (`AIza`), Anthropic (`sk-ant-`), Stripe (`sk_live_`/`rk_live_`). Near-zero false positives. |
| 2 | No PII (email) in logs | HIGH | An email-shaped string literal passed to a log/print call (`console.*`, `logger.*`, `print(`, `fmt.Print*`, `echo`, `System.out.print`, `log.*`). |

### Advisory (never blocks)

| # | Invariant | Severity | How |
|---|-----------|----------|-----|
| 3 | Generic secret-like assignment | MEDIUM | A variable named secret/token/password/apikey assigned a long opaque literal (and not env-var indirection). FP-prone, so advisory only. |
| 4 | Logged email-bearing variable | LOW | A `.email` / `userEmail` style variable referenced inside a log/print call. Cannot prove PII statically. |

### Deferred (honestly NOT implemented)

These two requested categories are deferred because a static grep cannot do them
deterministically without becoming flaky. They are documented here, not faked:

- **No unhandled-error path on the happy route.** A grep cannot do control-flow
  analysis; a "no try/catch near await" heuristic is noise. This belongs to a
  real analysis pass (LSP diagnostics / typed exhaustiveness checking), tracked
  separately as the LSP-in-verification work.
- **Idempotency / round-trip invariants.** Not statically detectable in any
  deterministic way worth shipping. It requires executing generated tests (the
  larger fast-check / metamorphic-testing feature). Deferred, not faked.

## False-positive avoidance

Generated code legitimately contains placeholders. The detector skips them:

- Placeholder allowlist on the matched line: `EXAMPLE`, `example.com`, `your-`,
  `xxxx`, `placeholder`, `changeme`, `REPLACE`, `<...>`, `dummy`, `sample`,
  `redact`, `sk-test-`, `fake`, `FIXME`, `TODO`, `****`. This covers AWS's own
  documented `AKIAIOSFODNN7EXAMPLE` and `your-api-key-here`.
- Illustration files skipped for secret checks: `*.md`, `*.example`, `*.sample`,
  `*.template`, `*.dist` (they routinely show fake credentials on purpose).
- Env-var indirection (`process.env`, `os.environ`, `getenv`, `ENV[`) is not a
  hardcoded literal and is skipped for the generic check.

## Scan surface

Source files only. Extensions: ts, tsx, js, jsx, py, go, rb, java, rs, php, sh,
env, yml, yaml, json, plus `*.log`. Excludes `node_modules`, `.git`, `dist`,
`build`, `vendor`, `coverage`, and Loki's own `.loki/` telemetry.

Test files are OUT OF SCOPE for all checks (consistent with the "source/logs"
framing of this invariant). The exclusion covers every common ecosystem's test
convention, not just the JS glob: `*.test.*` / `*.spec.*`, `test_*.py` /
`*_test.py`, `test-*.sh`, `*_test.go`, and anything under an anchored
`tests/` / `__tests__/` / `spec/` directory. Security/redaction test fixtures
routinely embed realistic fake credentials on purpose, so scanning them would be
pure noise. Comprehensive secret scanning of generated TESTS (and pre-write
scanning) is a separate, larger feature tracked as P3-4 (#634), not this gate.

## Usage

```bash
# Advisory run (prints findings, exits 0)
tests/detect-invariant-violations.sh

# CI / gate run (exits 1 iff CRITICAL or HIGH)
tests/detect-invariant-violations.sh --strict

# Scan a target project (the gate wrapper sets this)
LOKI_SCAN_DIR=/path/to/target tests/detect-invariant-violations.sh --strict
```

Exit-code contract mirrors `tests/detect-mock-problems.sh`: `--strict` exits 1
iff CRITICAL or HIGH findings exist; MEDIUM/LOW never block. Every HIGH (and
CRITICAL) prints a `[HIGH]` / `[CRITICAL]` token on stdout, so a wrapper can grep
as an alternative to relying on the exit code.

## Wiring as a gate

The detector is NOT wired into `autonomy/run.sh` yet. To wire it, add an
`enforce_invariant_integrity()` wrapper next to `enforce_mock_integrity()`
(`autonomy/run.sh:7932`) and call it where `enforce_mock_integrity` is called
(`autonomy/run.sh:14676`). The full wrapper is documented in the header of
`tests/detect-invariant-violations.sh`. It:

- honors `LOKI_SCAN_DIR=TARGET_DIR` (the detector scans the target, not loki-mode)
- treats detector-not-found and timeout (exit 124) as inconclusive (does not block)
- persists findings to `${TARGET_DIR}/.loki/quality/invariant-findings.txt`
- opts out with `LOKI_GATE_INVARIANT=false`

After wiring, add a gate row to `skills/quality-gates.md` and cross-reference
this check from the Kiro Pattern section of `skills/testing.md`.
