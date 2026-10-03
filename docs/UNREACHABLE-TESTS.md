# Unreachable Tests

This document is an honest log of test scenarios that the project cannot exercise in CI today, why each one is blocked, and what (if anything) substitutes for the missing coverage.

The intent is to keep this list short and embarrassing so the gaps stay visible. If a row here can be closed, close it.

---

## Real Claude / Codex / Gemini API calls

**What we cannot test in CI:** end-to-end runs that actually invoke a hosted Claude, OpenAI Codex, or Google Gemini agent loop with real credentials.

**Blocker:**

- Per-call cost. A full PRD run can rack up double-digit dollars per provider; running on every PR is not affordable.
- Auth. Storing real provider tokens in CI gives any contributor on a fork-PR an attack surface to exfiltrate them. We do not pass secrets to fork PRs by policy.
- Agent-loop safety. A real provider call has full tool-use authority and can take destructive actions (file writes, shell commands) that are unsafe to run unattended in CI.

**Manual procedure that closes the gap:**

Run the relevant `tests/integration/` script locally with real credentials in a sandbox container or VM.

**Partial substitute we ship:**

- Provider loader unit tests under `tests/test-provider-loader.sh` cover flag selection, model name mapping, and fallback wiring without invoking the provider.
- The Bun test suite uses recorded fixtures for `build_prompt` and the runner state machine.

---

## Windows runtime

**What we cannot test in CI:** Loki Mode running natively on Windows (PowerShell or cmd, or Windows-native bash).

**Blocker:** No Windows host in the CI pool. The runtime relies heavily on POSIX bash semantics; Windows bash via WSL is the only realistic path and we have not provisioned a runner for it.

**Manual procedure that closes the gap:**

Install on a Windows host with WSL2 + Ubuntu, run `loki doctor` and the smoke commands, file an issue with the output. Document any divergence in the issue, and see `docs/INSTALLATION.md` and `docs/alternative-installations.md` for supported install paths.

**Partial substitute we ship:**

None. Windows is not a supported platform today.

---

## Real ARM64 runtime

**What we cannot test in CI:** the published Docker image actually starting up and answering `loki version` on a real ARM64 host.

**Blocker:** GitHub Actions provides ARM64 emulation via QEMU under buildx, but we do not have an ARM64 runner in the pool. Buildx can produce the image; it cannot meaningfully exercise the runtime.

**Manual procedure that closes the gap:**

See `docs/ARM64-VERIFICATION.md` for the manual verification procedure on an Apple Silicon Mac or another ARM64 host.

**Partial substitute we ship:**

- `buildx` produces the multi-arch image and verifies the build does not fail.
- The same TypeScript/Bun runtime ships unchanged across architectures, so x86_64 unit tests cover most of the runtime logic.

---

## Real PRD end-to-end

**What we cannot test in CI:** a real PRD running through the full RARV loop to completion, with provider calls, code generation, tests, and deploy artifacts.

**Blocker:**

- Cost (see "Real Claude / Codex / Gemini API calls" above).
- Nondeterminism. The provider's output varies, so an end-to-end pass/fail signal is noisy.
- Wall-clock duration. A standard PRD takes 30-90 minutes; CI runners time out long before.

**Manual procedure that closes the gap:**

Maintainer runs the templated PRDs under `templates/` against the current build before a release and inspects the output. This is captured in the release checklist informally.

**Partial substitute we ship:**

- Unit tests against recorded provider outputs for the prompt builder and council voter.
- Smoke tests of the runner state machine that exercise every phase transition without invoking a provider.

---

## 1-hour-plus stress runs

**What we cannot test in CI:** sessions that run for an hour or more to surface memory leaks, file-descriptor leaks, or queue churn under sustained load.

**Blocker:** GitHub-hosted runner minutes. A one-hour test on every PR would consume the project's monthly minute allocation in a few days.

**Manual procedure that closes the gap:**

Run `./benchmarks/run-benchmarks.sh` on a self-hosted machine for the full duration and capture process metrics with `ps`/`top` / a simple sampling script. Record findings under `.loki/metrics/`.

**Partial substitute we ship:**

- The completion council circuit breaker and budget breaker are unit-tested for trigger logic.
- The dashboard tracks per-iteration cost and context usage; large regressions show up in `.loki/metrics/efficiency/`.

---

## Brew install via the real tap

**What we cannot test in CI:** `brew tap asklokesh/tap && brew install loki-mode` against the real tap and a real macOS host.

**Blocker:**

- Running `brew install` on a CI runner mutates the runner's Homebrew prefix. This interferes with subsequent jobs on the same runner (GitHub-hosted runners are ephemeral, but the side effects still apply for the remainder of the job).
- Cross-tap mutation in CI risks accidentally publishing a broken formula if the install path is reused for verification.

**Manual procedure that closes the gap:**

Maintainer runs the brew install on a clean macOS host (or a fresh VM) after every release and checks `loki version` plus a smoke command. Verification is captured in the release checklist.

**Partial substitute we ship:**

- The `homebrew-tap` repository's CI lints the formula on every update.
- Tarball validation in `CLAUDE.md` "Pre-Publish Validation" exercises the npm path, which shares most of the same artifacts.

---

## How to use this document

When you discover a new untestable scenario, add it here. When you close a gap, remove the row. Keep the document short.
