# Upgrading

This document covers upgrade and rollback guidance for the bash-to-Bun runtime migration. For features unrelated to the runtime migration, see `CHANGELOG.md`.

The Bash runtime under `autonomy/` remains the source of truth through Phase 5. The Bun runtime under `loki-ts/` ports a subset of read-only commands. The shim at `bin/loki` decides which runtime handles a given invocation.

---

## Running parallel BMAD stories

By default Loki uses `.loki/` in the current working directory as a singleton state directory. Two `loki start` invocations in the same repo will collide on `.loki/loki.pid`, `.loki/STATUS.txt`, and the queue files.

To run multiple stories in parallel, give each session its own state directory via `LOKI_DIR`:

```bash
# Terminal 1
LOKI_DIR=.loki-story-A loki start prd-story-A.md

# Terminal 2
LOKI_DIR=.loki-story-B loki start prd-story-B.md
```

Each `LOKI_DIR` gets its own pid lock, queue, checkpoints, memory, and event stream. The dashboard reads whichever `LOKI_DIR` you point it at via the same env var.

For stronger isolation (separate working trees as well as state), pair `LOKI_DIR` with `git worktree add` so each session also has its own checkout. See `skills/parallel-workflows.md` for the worktree pattern.

---

## BMAD per-epic / per-story scope (v7.4.19+)

When a BMAD plan contains many epics or stories, Loki injects the full tree into every iteration prompt by default. To narrow the working scope to a single epic or story, set `LOKI_BMAD_STORY_ID`:

```bash
# Match by story id, key, name, story_id, or epic_id (case-insensitive substring)
LOKI_BMAD_STORY_ID=epic-2 loki start prd.md
LOKI_BMAD_STORY_ID="story-3.1" loki start prd.md
```

Behavior:

- The match is a case-insensitive substring against `id`, `key`, `name`, `story_id`, and `epic_id` on every node in the BMAD tree (epics, stories, tasks, items, children).
- If a node matches, that subtree is kept in the prompt and its siblings are pruned.
- If nothing matches, Loki falls back to the full tree rather than silently emptying the plan, so a typo in the env var never hides all work.

This pairs with `LOKI_DIR` for running independent BMAD stories in parallel from the same repo.

---

## From v7.2.0 to v7.3.0

### What changed

- A new `bin/loki` shim was added at the front of the install. It routes a small set of read-only commands to the Bun runtime when `bun` is available on `PATH`.
- Routed commands: `version`, `--version`, `-v`, `status`, `stats`, `doctor`, `provider` (covers `provider show` and `provider list`), `memory` (covers `memory list` and `memory index`).
- All other commands continue to execute the existing Bash CLI at `autonomy/loki`.
- If `bun` is not on `PATH`, the shim falls through to Bash. Users without Bun installed see no behavior change.

### What to install

Bun is optional. Install it only if you want the faster route on the ported commands.

```bash
# macOS / Linux (official installer)
curl -fsSL https://bun.sh/install | bash

# macOS via Homebrew
brew install oven-sh/bun/bun
```

Recommended Bun version: 1.3.0 or newer.

### How to roll back

Set `LOKI_LEGACY_BASH=1` to force the Bash route for any single invocation:

```bash
LOKI_LEGACY_BASH=1 loki version
LOKI_LEGACY_BASH=1 loki status
```

Export the variable to make rollback persistent for a shell session:

```bash
export LOKI_LEGACY_BASH=1
```

Uninstalling Bun also forces the Bash route, since the shim falls through silently when `bun` is missing.

---

## From v7.3.0 to v7.4.x

### What changed

- Additional runner-side code paths were ported to TypeScript under `loki-ts/src/`. These remain behind the Bun route, gated by the same shim and the same rollback flag.
- The published shape of the routed commands does not change; the goal of the v7.4.x line is to extend internal coverage of the Bun runtime, not to add new user-facing commands.
- The `LOKI_LEGACY_BASH=1` rollback flag continues to work and forces all routing back to Bash.

### Status

The v7.4.x line is currently in DRAFT (PR #157 on `feat/bun-migration`) and is not yet released to npm, Docker, Homebrew, or VSCode. The line will be released after v7.3.0 completes its soak window. There is nothing for end users to do until the release ships.

### How to roll back

Same as v7.3.0:

```bash
export LOKI_LEGACY_BASH=1
```

---

## From v7.x to v8.0.0 (planned)

### What is planned

- The Bash runtime under `autonomy/` is sunset. The Bun runtime becomes the only supported runtime.
- The `LOKI_LEGACY_BASH=1` flag is removed because there is no longer a Bash route to fall back to.
- Calendar date: TBD. The cut is gated on Phase 5 of the migration completing and on a soak window across the user base. There is no committed release date.

### How to stay on the Bash runtime

Pin the last v7.x release on your install channel:

```bash
# npm
npm install -g loki-mode@7

# Homebrew (pin the formula version after install)
brew install asklokesh/tap/loki-mode
brew pin loki-mode

# Docker
docker pull asklokesh/loki-mode:7
```

Pinning to v7 keeps both runtimes available indefinitely on your machine. Note that future v7.x patch releases may continue to ship security fixes; check the changelog for that line.

---

## Troubleshooting

### "Bun not found" / shim is silently using Bash

If you intended to use the Bun route and it appears not to be active, verify:

```bash
command -v bun                # should print a path
bun --version                 # should print >= 1.3.0
```

If `bun` is missing, install it (see "What to install" above). The shim never errors on a missing `bun`; it falls through to Bash. This is intentional so existing users are not blocked.

### "Command runs slower than expected"

Confirm which route was actually taken. Today the Bun route is detectable indirectly:

- The `bin/loki` shim picks the Bun route only when `bun` is on `PATH` and `LOKI_LEGACY_BASH` is not set and one of the routed commands was invoked.
- Run `command -v bun` and `printenv LOKI_LEGACY_BASH` to rule out the obvious causes.
- Run the same command twice with and without `LOKI_LEGACY_BASH=1` and compare wall-clock time. The Bun route on the ported commands is typically several times faster than the Bash route on the same machine.

**Known gap:** `loki version` does not currently print which runtime served the invocation. If you need a definitive answer, the most reliable check today is the `LOKI_LEGACY_BASH=1` comparison above. A future release may add a runtime indicator to the version output.

### Errors that mention `loki-ts/dist/loki.js` or `loki-ts/src/cli.ts`

The shim resolves the Bun entry in this order: `LOKI_TS_ENTRY` env var, `BUN_FROM_SOURCE=1` (prefers `src/cli.ts`), `loki-ts/dist/loki.js`, `loki-ts/src/cli.ts`. On npm and Docker installs, `src/` is excluded; only `dist/loki.js` is shipped. If you set `BUN_FROM_SOURCE=1` on a published install, the shim warns once and falls back to `dist/loki.js`. To clear the warning, unset `BUN_FROM_SOURCE`.

### Forcing the Bash route per-command

```bash
LOKI_LEGACY_BASH=1 loki <command>
```

This is the supported escape hatch for any regression discovered on the Bun route through Phase 5. Please file an issue with reproduction steps so the regression can be fixed before v8.0.0.
