# Autonomi Verify (embedded bundle)

This directory contains a single pre-built, dependency-free JavaScript bundle of
the Autonomi Verify deterministic verification engine.

- `embed.js` - the bundled engine (runtime: `bun`). Built from the PRIVATE
  Autonomi Verify source repository; only the built artifact is committed here.
  The TypeScript source is NOT included and is NOT part of this repository.
- `LICENSE` - the COMMERCIAL license notice covering `embed.js`. This is
  distinct from the Business Source License 1.1 that governs the rest of
  Loki Mode. `embed.js` is proprietary and is not open source.

## What it does

`embed.js` observes a local git working directory read-only and runs the
Autonomi Verify evidence gate, printing the verdict fields as one JSON object on
stdout. It performs NO network access and NEVER executes the project's tests
(that is reserved for the hosted/sandboxed Phase 2 surface).

Invocation contract:

```
bun vendor/autonomi-verify/embed.js --dir <path> [--base <ref>] [--head <ref>]
```

Output (stdout, on a produced verdict, exit 0):

```json
{
  "engine": "autonomi-verify",
  "engine_version": "<version>",
  "verified": true,
  "inconclusive": false,
  "inconclusive_reason": null,
  "evidence": {
    "diff_nonempty": true,
    "diff_files_changed": 1,
    "diff_base_sha": "<sha>",
    "tests_ran": false,
    "tests_passed": true,
    "test_runner": "none"
  }
}
```

On a genuine observation failure (git missing, path absent) it exits nonzero and
prints nothing parseable on stdout. The caller (`loki verify --hosted`) treats a
nonzero exit, a missing bundle, or a missing `bun` as "engine unusable" and
falls open to the deterministic bash verdict. It never turns an unusable engine
into a silent pass.

## How it is used by `loki verify`

`loki verify` (no flags) does NOT touch this bundle and is byte-identical to its
prior behavior. Only the opt-in `loki verify --hosted` path probes for `bun` and
this bundle and, when both are present, folds the engine's verdict fields into
`evidence.json` under a `hosted` key. The bash deterministic verdict remains
authoritative for the exit code.
