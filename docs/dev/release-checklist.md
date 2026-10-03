# Release checklist and local CI

Moved out of CLAUDE.md (S-78) to keep the root file short. Updated in this
pass to remove two items that `docs/v10/DECISIONS.md` D25 and
`docs/LOKI-10-BUILD-PROMPT.md` section 1 have superseded:
- `git add -A` in step 4 is replaced with staging by name (repo rule, always).
- Per-merge pushing is replaced by the release-train model (D25): batch
  approved merges locally, push once per train, freeze main until Tests, Bun
  Parity and Security Audit are all green on that exact SHA, then release.
  "Wait for user approval before commit" from the old workflow is superseded
  by the standing authorization in `docs/LOKI-10-BUILD-PROMPT.md` section 1
  for sessions operating under that program; outside it, ask as normal.

## Local CI Before Every Push

**Superseded by D27 (`docs/v10/DECISIONS.md`).** The FAST-tier-before-every-push
mandate that used to live in this section is retired: GitHub CI is the gate.
Before pushing, run only syntax checks (`bash -n`, `py_compile`) plus the
slice's own tests, capped at 60 seconds. `.githooks/pre-push` enforces the
repo-identity check, `bash -n` on `autonomy/run.sh` and `autonomy/loki`, and
the red-main warning only; a push is not "done" until `git ls-remote origin
refs/heads/main` matches `git rev-parse HEAD`. `scripts/local-ci.sh` remains
available for diagnosis on a quiet cycle -- it is no longer a push
precondition, fast tier or full.

After a release ships, run post-release distribution validation:
- npm: `npm pack loki-mode@<VERSION>`, untar, run `bash package/bin/loki version`
- Docker: `docker pull asklokesh/loki-mode:<VERSION>`, `docker run --rm <img> version`,
  `doctor --json`, `status --json`
- Brew: WebFetch the live formula, verify version + sha256
- Both routes (Bun + LOKI_LEGACY_BASH=1) on each channel

Cleanup after every local-ci run and post-release validation uses
`loki_run_tmp_cleanup` (see `docs/dev/tmp-cleanup.md`).

## Release Workflow

**Step 0 (always first, D27): syntax checks + the slice's own tests, 60s cap.**
See "Local CI Before Every Push" above.

### 1. Version Bump - ALL Files

```
VERSION                                  # Single line: X.Y.Z
package.json                             # "version": "X.Y.Z"
SKILL.md                                 # Header (line ~6) AND footer (last line)
Dockerfile                               # LABEL version= AND org.opencontainers.image.version (both, or it drifts)
Dockerfile.sandbox                       # Same two labels
plugins/loki-mode/.claude-plugin/plugin.json  # "version": "X.Y.Z" (marketplace.json carries no version)
server.json                              # "version" AND packages[loki-mode].version (MCP registry manifest; enforced by tests/test-server-json-current.sh)
vscode-extension/package.json            # DEPRECATED v7.2.0, no longer published; bump only if vendoring
CLAUDE.md                                # Version pointer, if present
dashboard/__init__.py                    # __version__ = "X.Y.Z"
mcp/__init__.py                          # __version__ = "X.Y.Z"
CHANGELOG.md                             # Add new version entry at top
docs/INSTALLATION.md                     # Version header
wiki/Home.md, wiki/_Sidebar.md, wiki/API-Reference.md
README.md, docker-compose.yml            # Docker image tags (MAJOR/MINOR bumps)
```

The CHANGELOG.md entry must be a full section, not a one-line placeholder
(E-88): a summary line, one or more `### ` subsections (Added, Fixed, etc.)
with a `- ` bullet for every user-visible change, and, if this version
republishes a version that never reached npm, that version's own section
carried forward too. `scripts/release-notes.sh <version>` extracts and
validates this section the same way release.yml does; `.githooks/pre-push`
runs it on any push whose remote ref is `refs/heads/main` and whose VERSION
actually changes there, and release.yml refuses to publish the release if
the section is missing, empty, or not fully written. release.yml runs this
extraction BEFORE tagging (D36), so a notes failure never burns a version
number.

Carrying another version's notes forward (E-88a) is explicit only:
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

### 2. Build Dashboard Frontend

```bash
cd dashboard-ui && npm ci && npm run build:all && cd ..
ls -la dashboard/static/index.html   # verify >100KB
```
`npm publish`'s `prepublishOnly` also triggers this build automatically.

### 3. Run Tests

```bash
bash -n autonomy/run.sh
bash -n autonomy/loki
python3 -c "import ast, os; [ast.parse(open(f'dashboard/{f}').read()) for f in os.listdir('dashboard') if f.endswith('.py')]"
python3 -c "import json; json.load(open('package.json')); print('JSON OK')"
cd dashboard-ui && npx playwright test && cd ..   # requires dashboard on 57374
```

### 3a. Pre-Publish Validation (MANDATORY)

```bash
npm pack --dry-run 2>&1 | grep -E "web-app/dist|dashboard/static" || echo "FAIL: expected files missing"
git ls-files web-app/dist/index.html | grep -q . || echo "FAIL: web-app/dist/ not tracked"
git ls-files dashboard/static/index.html | grep -q . || echo "FAIL: dashboard/static/ not tracked"
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

### 4. Commit and land (release-train model, D25)

Stage files by name (never `git add -A` or `git add .`), commit with the
repo-local `asklokesh` identity, no co-author. Batch approved merges locally;
push once per train (`git push origin main`); wait for Tests, Bun Parity and
Security Audit to go green on that exact SHA before bumping VERSION and
releasing. GitHub Actions then creates the tag, the GitHub Release, publishes
npm, builds/pushes Docker, and updates the Homebrew tap. Do not manually
create tags.

Before pushing the release commit, run `bash scripts/release.sh --check-clean` (E-151): it exits 1 naming any tracked file (for example a stamped `loki-ts/dist/loki.js.map`) the commit left modified; `--bump-only` prints the "stage these files:" list.

### 5. Verify ALL Distribution Channels

```bash
gh run list --limit 1 && gh run watch <run-id>
npm view loki-mode version
npm pack loki-mode --dry-run 2>&1 | grep dashboard/static
docker pull asklokesh/loki-mode:X.Y.Z && docker run --rm asklokesh/loki-mode:X.Y.Z loki version
brew update && brew info loki-mode
gh release view vX.Y.Z
```

### Train cycle: previous release must be on npm
`scripts/train-cycle.sh` (phase C) refuses to cut release N+1 until the previous `release: vX` version is visible on npm (`npm_has_version`). While it is missing, the cycle logs `PREV_NOT_ON_NPM X` and returns 0 (waiting is not a failure). An unreachable registry fails closed and adds `reason=NPM_UNREACHABLE`. After `LOKI_TC_NPM_WAIT_MIN` minutes (default 45) since the previous release commit the log becomes `PREV_NOT_ON_NPM_STALE ... refusing release, needs a human`; the release stays refused either way.

Operator action: wait for the Release workflow publish to land and for the D49 auto-promote to run. Never manually promote or move the `latest` dist-tag, and never unpublish. If the STALE line appears, investigate the failed or stuck publish run rather than bypassing the check.

### Distribution Channel Checklist

| Channel | Dashboard API | Dashboard Frontend | Memory System | Skills/References |
|---------|--------------------------|------------------------------|---------------|-------------------|
| npm     | `dashboard/*.py`         | `dashboard/static/index.html`| `memory/`     | `skills/`, `references/` |
| Docker  | `COPY dashboard/`        | Built in Dockerfile or committed | `memory/` | `skills/`, `references/` |
| Homebrew| Full tarball             | Full tarball                 | Full tarball  | Full tarball |
| VSCode  | DEPRECATED v7.2.0 -- no longer published | -- | -- | -- |
| Release | Skill-only zip           | N/A                          | N/A           | `references/` |

### Credentials (GitHub Secrets)
`NPM_TOKEN`, `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`, `HOMEBREW_TAP_TOKEN`.

## Testing

```bash
npm test
```
