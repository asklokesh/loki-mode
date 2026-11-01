# Testing

Loki Mode keeps one small, hermetic test set under `tests/min/`. Every test is offline, calls no model, runs in seconds, and records in its header the defect it was proven to catch.

## Run it

```bash
bash scripts/local-ci.sh                                   # all tests, cheap ones first
LOCAL_CI_ONLY=hygiene,pack-contents bash scripts/local-ci.sh   # a subset
```

`npm test` runs the same command. The same script runs in GitHub Actions (`.github/workflows/pr-fast.yml`). One-time setup for `dist-freshness`: `bun install --cwd loki-ts --frozen-lockfile`.

## What each test guards

| Test | Guards |
| --- | --- |
| `syntax` | `bash -n` on every shipped shell script, a Python parse of every shipped module, `node --check` on the JS entrypoints |
| `hygiene` | no emoji and no en or em dashes in any tracked or new text file; every repo path named in README, SKILL, skills, references, docs and wiki markdown exists |
| `version-consistency` | VERSION agrees with package.json, server.json, the plugin manifest, SKILL.md, both Dockerfiles, the Helm charts, dashboard and MCP package versions, and the committed Bun bundle |
| `release-notes` | `scripts/release-notes.sh` extracts a complete CHANGELOG section for VERSION and refuses a missing, empty, unfinished or placeholder one |
| `docker-and-zip-sources` | every Docker COPY source and every path the release zip step copies exists in git |
| `pack-contents` | `npm pack --dry-run` lists every runtime file and no test code, bytecode or stale doc tree |
| `cli-entrypoints` | `bin/loki`, the Bun bundle, the bash CLI and the npm launcher report the same version offline; `doctor --json`, `mcp --help` and the completions load |
| `newcomer-path` | `loki tour` prints VERIFIED, then TAMPERED on a one-byte copy of the bundled receipt |
| `receipt-roundtrip` | VERIFIED, TAMPERED, UNSIGNED and UNCHECKED verdicts on the demo receipt, and the JWKS attestation (tamper and `alg: none` refused) |
| `redaction` | `redactSecrets` removes a GitHub token, an Anthropic key and an AWS key and stays linear (growth from 25k to 100k characters under 8x) |
| `typecheck` | `bunx tsc --noEmit` in `loki-ts` is clean |
| `detect-gates` | the five `tests/detect-*.sh` quality gates that `autonomy/run.sh` executes pass a clean fixture and fail a defective one |
| `dist-freshness` | the committed `loki-ts/dist` bundles equal a fresh build of `loki-ts/src`; `web-app/dist/index.html` references only assets that exist |
| `engine10-e2e-stub` | the real engine, end to end on a stub provider: VERIFIED run, tampered run reads TAMPERED, the agent session never receives the GitHub token |
| `scope-and-fix` | implement and fix stages on the stub provider: an edit to a pre-existing test is restored (kept when the task names the file), an out-of-scope edit is listed on the receipt, a fix-round spec conflict starts no retry, a fix round with no progress stops fixing |

## Adding a test

Extend an existing file when the concern is already owned by one. A new file needs a one-line reason that none of the above owns the concern. Source `tests/min/lib.sh` (hermetic HOME, run-owned temp dir removed on exit, `ok`, `bad`, `finish`), keep it under a few seconds, and put the planted defect you proved it against in the header comment.
