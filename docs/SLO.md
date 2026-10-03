# Service Level Objectives

This document records baseline targets for the user-visible behavior of the CLI and the runner. These are honest first-pass targets. **No SLI/SLO infrastructure is shipped yet.** Tracking is manual, via soak-window observation.

The targets below should be treated as goals, not contracts. They will be revised as measurement infrastructure is built out.

---

## Latency

| Command | Route | p99 target | Source of measurement |
|---------|-------|------------|----------------------|
| `loki version` | Bun | < 100 ms | `.loki/metrics/migration_bench_soak.jsonl` (recorded p95 ~30 ms; p99 not recorded but headroom is large) |
| `loki version` | Bash | < 200 ms | `.loki/metrics/migration_bench_soak.jsonl` (recorded p95 ~141 ms) |
| `loki status` | either route | < 500 ms | not currently measured in CI; manual observation only |

**Caveats:**

- The soak file records p50 and p95, not p99. The p99 targets above assume modest tail behavior on top of the recorded p95. They should be tightened or loosened once a proper p99 measurement is in place.
- All numbers are wall-clock cold starts measured via `hyperfine` on developer hardware. Latency on slower machines (low-end CI runners, ARM64 emulated, containers under heavy load) will be worse.

---

## Parity

| Property | Target | Measurement |
|----------|--------|-------------|
| Byte-divergence between Bash and Bun routes for the ported commands | 0 divergences | `tests/test-bash-bun-parity.sh` and the per-command parity suites (run on demand and in the Tests workflow) |

The eight commands currently in scope: `version`, `status`, `stats`, `doctor`, `provider show`, `provider list`, `memory list`, `memory index`.

---

## Reliability

| Metric | Target | Status |
|--------|--------|--------|
| `loki start` completion rate on standard PRDs | 99% | aspirational; no automated measurement yet |
| Dashboard availability when invoked from `loki start` | 99.9% per session | aspirational; no automated measurement yet |
| Pre-publish tarball validation pass rate before any release | 100% | enforced manually per `CLAUDE.md` "Pre-Publish Validation"; failure blocks release |

The reliability numbers above are explicitly aspirational. The system does not currently emit a "completion / non-completion" signal that could be aggregated into a reliability number across users. The 99% target represents what the maintainer wants to be true, not what is currently measured.

---

## Notes on measurement

- There is no continuous parity SLI shipping today; parity is checked by test suites only.
- Latency measurements are recorded in `.loki/metrics/migration_bench_soak.jsonl` when a benchmark run is performed; they are not collected continuously.
- Reliability is tracked by manual review during the v7.3.0 soak window.

These are baseline targets. They will be revised when SLI/SLO infrastructure ships.
