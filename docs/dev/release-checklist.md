# Release checklist and local CI

Release steps and local CI details for maintainers.

## Local CI Before Every Push

GitHub CI is the gate. Before pushing, run only syntax checks (`bash -n`, `py_compile`) plus the
change's own tests, capped at 60 seconds. `.githooks/pre-push` enforces the
repo-identity check, `bash -n` on `autonomy/run.sh` and `autonomy/loki`, and
the red-main warning only; a push is not "done" until `git ls-remote origin
refs/heads/main` matches `git rev-parse HEAD`. `scripts/local-ci.sh` remains
available for diagnosis on a quiet cycle -- it is no longer a push
precondition, fast tier or full.

Slice gate (run before reporting a slice built; a reviewer reruns the same command):
`bash scripts/select-tests.sh --gate [--suite tests/test-foo.sh]... [--no-loki-ts]`.
It checks that HEAD contains the current origin/main (and names how far behind
it is, never rebasing for you), runs exactly the `--guards-only` row set (the
`scripts/global-guards.tsv` rows plus the marker-only walkers, from one shared emitter) one
at a time and names any red row, runs each `--suite`, then runs full engine10
(`bun run test:engine10` in loki-ts, through the slot queue when the tree has that script) unless `--no-loki-ts` says the slice
touched no loki-ts source. Every row, suite and the engine10 run is bounded by
`timeout -k 15` (`LOKI_GATE_ROW_TIMEOUT`, `LOKI_GATE_SUITE_TIMEOUT`, `LOKI_GATE_ENGINE10_TIMEOUT`);
a timeout, an empty guard list, a failed fetch (unless `--no-fetch`) or a missing
`bun` fails the gate. It prints a pass/fail summary per step and exits
non-zero on any failure.

After a release ships, run post-release distribution validation:
- npm: `npm pack loki-mode@<VERSION>`, untar, run `bash package/bin/loki version`
- Docker: `docker pull asklokesh/loki-mode:<VERSION>`, `docker run --rm <img> version`,
  `doctor --json`, `status --json`
- Brew: WebFetch the live formula, verify version + sha256
- Both routes (Bun + LOKI_LEGACY_BASH=1) on each channel

Cleanup after every local-ci run and post-release validation uses
`loki_run_tmp_cleanup` (see `docs/dev/tmp-cleanup.md`).

## Release Workflow

**Step 0 (always first): syntax checks + the change's own tests, 60s cap.**
See "Local CI Before Every Push" above.

### 1. Version Bump - ALL Files

```
VERSION                                  # Single line: X.Y.Z
package.json                             # "version": "X.Y.Z"
SKILL.md                                 # Header (line ~6) AND footer (last line)
Dockerfile                               # LABEL version= AND org.opencontainers.image.version (both, or it drifts)
docker/Dockerfile.sandbox                # Same two labels
plugins/loki-mode/.claude-plugin/plugin.json  # "version": "X.Y.Z" (marketplace.json carries no version)
server.json                              # "version" AND packages[loki-mode].version (MCP registry manifest; enforced by tests/test-server-json-current.sh)
vscode-extension/package.json            # DEPRECATED v7.2.0, no longer published; bump only if vendoring
CLAUDE.md                                # Version pointer, if present
dashboard/__init__.py                    # __version__ = "X.Y.Z"
mcp/__init__.py                          # __version__ = "X.Y.Z"
CHANGELOG.md                             # Add new version entry at top
docs/INSTALLATION.md                     # Version header
wiki/Home.md, wiki/_Sidebar.md, wiki/API-Reference.md
README.md, docker/docker-compose.yml            # Docker image tags (MAJOR/MINOR bumps)
```

The CHANGELOG.md entry must be a full section, not a one-line placeholder:
a summary line, one or more `### ` subsections (Added, Fixed, etc.)
with a `- ` bullet for every user-visible change, and, if this version
republishes a version that never reached npm, that version's own section
carried forward too. `scripts/release-notes.sh <version>` extracts and
validates this section the same way release.yml does; `.githooks/pre-push`
runs it on any push whose remote ref is `refs/heads/main` and whose VERSION
actually changes there, and release.yml refuses to publish the release if
the section is missing, empty, or not fully written. release.yml runs this
extraction BEFORE tagging, so a notes failure never burns a version
number.

Carrying another version's notes forward is explicit only:
`--include v1,v2,...` names the versions to append, each under its own
"## vX.Y.Z changes (first published in vNEW)" heading; release.yml itself
passes no `--include`, so a version that never reached npm gets its
section written directly into the new CHANGELOG entry by hand (as done for
10.0.1 and 10.2.1). An earlier revision auto-detected candidates from the
section's own prose and an npm-published check; two rounds of review found
it could still pull in a HIGHER, already-published version named only for
context (the v9.22.13 bug: its body says "v9.24.0 is the next version on
npm") or over-carry on a stale npm read, so auto-detect was removed
entirely rather than patched again.

### 2. Build Web App

```bash
cd web-app && npm ci && npm run build && cd ..
ls -la web-app/dist/index.html
```
`npm publish`'s `prepublishOnly` also triggers this build automatically. The legacy dashboard UI was removed; the browser UI is the Control Plane (`packages/control-plane`).

### 3. Run Tests

```bash
bash -n autonomy/run.sh
bash -n autonomy/loki
python3 -c "import ast, os; [ast.parse(open(f'dashboard/{f}').read()) for f in os.listdir('dashboard') if f.endswith('.py')]"
python3 -c "import json; json.load(open('package.json')); print('JSON OK')"
```

### 3a. Pre-Publish Validation (MANDATORY)

```bash
npm pack --dry-run 2>&1 | grep -E "web-app/dist" || echo "FAIL: expected files missing"
git ls-files web-app/dist/index.html | grep -q . || echo "FAIL: web-app/dist/ not tracked"
npm pack && npm install -g ./loki-mode-*.tgz
loki --version
loki web --no-open &
sleep 3
curl -s http://127.0.0.1:57374/ | grep -q "Loki" && echo "PASS: web app serves" || echo "FAIL"
curl -s http://127.0.0.1:57374/api/status | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null && echo "PASS: API responds" || echo "FAIL"
loki web stop
npm install -g loki-mode
rm -f loki-mode-*.tgz
```
If any check fails, do not release; fix the root cause first.

### 4. Commit and land

Stage files by name (never `git add -A` or `git add .`). A VERSION push to main publishes to npm under `latest` and `next` at once; the
`publish-npm` job needs only `pack-npm` and never waits on Tests, Security Audit, nightly or the backstop.
For a manual push (`git push origin main`), run `bash scripts/local-ci.sh` first. GitHub Actions publishes
npm, then creates the tag and GitHub Release, builds/pushes Docker (including `:latest`), and updates the Homebrew tap. Do not manually
create tags.

Run the full Bun suite (including `tests/engine10`) only through `cd loki-ts && bun run test` or `bun run test:engine10`: both go through `scripts/test-slot.sh`, which allows at most 2 full runs per machine (`LOKI_ENGINE10_SLOTS` overrides; slots live in `~/.cache/loki-test-slots`, override `LOKI_TEST_SLOT_DIR`). A third run prints "waiting for a test slot" and starts when one frees; it is never killed, and a slot whose holder PID is dead is reclaimed. Filtered runs (`bun run test <file>`) take no slot. Never start the suite with a bare `bun test` for a full run. Test: `tests/test-test-slot.sh`.

Before pushing the release commit, run `bash scripts/release.sh --check-clean`: it exits 1 naming any tracked file (for example a stamped `loki-ts/dist/loki.js.map`) the commit left modified; `--bump-only` prints the "stage these files:" list.

### 5. Verify ALL Distribution Channels

```bash
gh run list --limit 1 && gh run watch <run-id>
npm view loki-mode version
npm pack loki-mode --dry-run 2>&1 | grep web-app/dist
docker pull asklokesh/loki-mode:X.Y.Z && docker run --rm asklokesh/loki-mode:X.Y.Z loki version
brew update && brew info loki-mode
gh release view vX.Y.Z
```

### Publish check
Wait for the Release workflow publish-npm job to land (seconds after the push). `latest` and `next` are set together by that job; do not move them by hand, and never unpublish (npm deprecate is allowed).

### Distribution Channel Checklist

| Channel | Dashboard API | Web App | Memory System | Skills/References |
|---------|--------------------------|------------------------------|---------------|-------------------|
| npm     | `dashboard/*.py`         | `web-app/dist/index.html` | `memory/`     | `skills/`, `references/` |
| Docker  | `COPY dashboard/`        | Built in Dockerfile | `memory/` | `skills/`, `references/` |
| Homebrew| Full tarball             | Full tarball                 | Full tarball  | Full tarball |
| VSCode  | DEPRECATED v7.2.0 -- no longer published | -- | -- | -- |
| Release | Skill-only zip           | N/A                          | N/A           | `references/` |

### Credentials (GitHub Secrets)
`NPM_TOKEN`, `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`, `HOMEBREW_TAP_TOKEN`.

## Testing

```bash
npm test
```
