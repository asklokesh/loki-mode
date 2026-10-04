# C3: Reproducible environments

## Problem
Build outputs depend on local environment state: npm versions, Go compiler, Python packages. Runs fail or diverge when run elsewhere.
- Nondeterministic outputs break verification receipts
- Requires environment lockfiles for Node, Go, Python, etc.
- CI builds differ from local development

## Current state
- `package.json` and `go.mod` are source-of-truth (no pinned lock files shipped)
- `scripts/local-ci.sh` does not enforce lockfile generation
- Docker builds use untagged base images (always latest)
- `Dockerfile` line 3 uses `FROM node:20` (no SHA pin)

## Proposed v1 scope
- Mandate `npm ci` (not `npm install`) in all build scripts
- Pin Go 1.22.x in `go.mod` + `go.sum` required
- Pin Python dependencies in `requirements.txt` or `uv.lock`
- Dockerfile uses SHA-pinned base images: `FROM node:20@sha256:abc123...`
- Build script emits `_environment.json` with tool versions
- Receipt validation includes environment hash

## Open questions
- Which lockfile format per language? (npm ci, Poetry, pip-compile?)
- How often to refresh pins? (monthly, per release, never?)
- Should CI enforce `git diff --check` on lockfiles?
- How to handle transitive dependencies that vary per OS?

## Why deferred from 11.0.0
Design work needed: pin strategy, validation rules. No current receipt validation.
