# loki-ts -- TypeScript orchestrator (Bun)

**Status:** alpha v0.1.0-alpha.1. Phase 1 of the bash->Bun migration. NOT
the production loki binary; that still lives at `autonomy/loki`.

See [`docs/architecture/ADR-001-runtime-migration.md`](../docs/architecture/ADR-001-runtime-migration.md)
for the full analysis, including honest cold-start benchmarks (Bun is
1.7x SLOWER than bash on trivial commands; only Go beats bash).

## What ships in this scaffold

- `src/cli.ts` -- minimal CLI dispatcher (1 real command: `version`)
- `src/version.ts` -- reads `../VERSION` (mirrors bash `cat VERSION`)
- `tests/version.test.ts` -- 3 tests using `bun:test`
- `scripts/bench.ts` -- side-by-side benchmark vs `autonomy/loki`

## Quickstart

```bash
# Install Bun (Anthropic-owned as of Dec 2025)
brew install oven-sh/bun/bun

# Run the prototype
cd loki-ts
bun src/cli.ts version

# Run tests
bun test

# Run side-by-side benchmark vs the production bash binary
bun run bench
```

## What this proves

1. Bun toolchain works end-to-end on this codebase.
2. Side-by-side coexistence with bash is feasible (no conflicts).
3. We can measure the real cost honestly before committing further.

## What this does NOT do

- Replace `autonomy/loki`. Production users are unaffected.
- Touch any other file outside `loki-ts/`.
- Bump versions or trigger any release.

## Next steps (per ADR-001 phases)

- Phase 2: port `loki provider show`, `loki status`, `loki stats` (read-only)
- Phase 3: replace npm publish + CI tooling with Bun equivalents
- Phase 4: port `build_prompt` (the 360-line bash function)
- Phase 5: port completion-council + run_code_review
- Phase 6: sunset bash (only after 30 days clean)

Each phase ships independently with rollback flags.
