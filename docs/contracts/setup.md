# Setup contract (LM-001)

This is the authoritative statement of what Loki Mode needs to run a first task. It is checked by tests against one shared table, `autonomy/lib/setup-requirements.json`. `loki doctor`, `loki doctor --requirements`, `loki doctor --json` (key `requirements`), `loki setup`, and the runtime "provider CLI missing" errors all read that table, so wording and fixes match.

Normal repository build dependencies (the toolchain of the project you point Loki at) are not Loki overhead and are not listed.

## How to read your machine

```
loki doctor --requirements   # per path: ready or not ready, each item required or optional, present or missing, one-line fix
loki doctor --json           # same data under "requirements", plus "first_task_ready"
```

A first task is ready when every required "All paths" item is present and at least one execution path is ready. `first_task_ready` in the JSON reports exactly that. It checks presence on this machine; it does not prove that a provider login is valid or that an API key is accepted.

## Execution paths

- Claude Code CLI path: the default. `loki start` runs the `claude` binary you installed and logged in with `claude auth login`. `loki chat` (with the claude provider) and `loki edit` call the `claude` CLI directly.
- Anthropic API-key path (Agent SDK, no `claude` CLI): opt-in. It needs `LOKI_SDK_MODE=full` (resolved to `LOKI_SDK_LOOP=1` by `bin/loki`), Anthropic credentials, the bundled `@anthropic-ai/claude-agent-sdk` platform binary, and Bun. It runs only on the Bun route of `loki start`; commands that stay on the bash route (for example `loki demo`, `loki quick`) still need a provider CLI on PATH. Without `LOKI_SDK_MODE=full`, an API key alone does not replace the `claude` CLI for the main loop.
- Other provider CLIs: `codex` (degraded), `cline`, `aider`, `opencode`. Any one of them replaces the `claude` CLI for `loki start --provider <name>`. Loki never silently substitutes a different provider than the one requested.

## Install methods

| Install method | What it provides | What you still need |
| --- | --- | --- |
| `npm install -g loki-mode` | Loki, a bundled Bun binary and the Claude Agent SDK as npm optional dependencies | Node 20+, python3, jq, git, curl, and one execution path above |
| `npm install -g loki-mode --omit=optional` (slim) | Loki only; no bundled Bun, no Agent SDK | Everything above, plus Bun from https://bun.sh for the Bun route. Without Bun, `bin/loki` falls back to the bash CLI. The API-key path is unavailable |
| Homebrew (`brew install loki-mode`) | Loki | Same as npm, and install Bun yourself if you want the Bun route |
| git clone | Loki sources | Same as npm; see docs/alternative-installations.md for the clone steps |

Supported platforms are the `os` entries in `package.json` (darwin, linux).

## Requirements by path

The tables below are generated from the shared source. Do not edit between the markers; run `UPDATE_CONTRACT=1 bun test tests/util/requirements.test.ts` from `loki-ts` after editing the JSON, and the test fails if this block drifts.

<!-- BEGIN GENERATED REQUIREMENTS (loki-ts/tests/util/requirements.test.ts) -->

### All paths

Needed by every Loki command.

| Requirement | Level | Check | Fix |
| --- | --- | --- | --- |
| Node.js 20 or newer | required | `node` on PATH, version 20.0 or newer | install Node 20+ from https://nodejs.org |
| Python 3.8 or newer | required | `python3` on PATH, version 3.8 or newer | install python3 with your package manager (brew install python3) |
| jq | required | `jq` on PATH | install jq with your package manager (brew install jq) |
| git | required | `git` on PATH | install git with your package manager (brew install git) |
| curl | required | `curl` on PATH | install curl with your package manager (brew install curl) |
| bash 4.0 or newer | optional | `bash` on PATH, version 4.0 or newer | install a newer bash (brew install bash); macOS ships 3.2 |
| Bun 1.3 or newer (bundled by npm install) | optional | `bun` on PATH, version 1.3 or newer | reinstall without --no-optional (npm bundles @oven/bun-*) or install from https://bun.sh; without it loki falls back to the slower bash CLI |

### Claude Code CLI path (default, loki start)

Loki drives the claude binary you installed and logged in.

| Requirement | Level | Check | Fix |
| --- | --- | --- | --- |
| claude CLI on PATH (then log in: claude auth login) | required | `claude` on PATH | npm install -g @anthropic-ai/claude-code |

### Anthropic API-key path (Agent SDK, no claude CLI)

Opt-in with LOKI_SDK_MODE=full; the bundled Agent SDK runs the loop over HTTPS.

| Requirement | Level | Check | Fix |
| --- | --- | --- | --- |
| SDK loop enabled (LOKI_SDK_MODE=full) | required | `LOKI_SDK_LOOP` is `1` or `true` | export LOKI_SDK_MODE=full |
| Anthropic credentials (API key, auth token or gateway URL) | required | one of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` is set | export ANTHROPIC_API_KEY=<your key> |
| Claude Agent SDK platform binary (optional npm dependency) | required | executable `@anthropic-ai/claude-agent-sdk-<platform>/claude` in an installed node_modules | reinstall without --no-optional: npm install -g loki-mode (the SDK is an optionalDependency) |
| Bun runtime (the SDK loop runs only on the Bun route) | required | `bun` on PATH, version 1.3 or newer | reinstall without --no-optional (npm bundles @oven/bun-*) or install from https://bun.sh |

### Other provider CLIs

codex (degraded), cline, aider, opencode: any one replaces the claude CLI.

| Requirement | Level | Check | Fix |
| --- | --- | --- | --- |
| codex CLI | optional | `codex` on PATH | npm install -g @openai/codex |
| cline CLI | optional | `cline` on PATH | npm install -g cline |
| aider CLI | optional | `aider` on PATH | pip install aider-chat |
| opencode CLI | optional | `opencode` on PATH | npm install -g opencode-ai |

### When an optional dependency is missing

| Missing | Effect |
| --- | --- |
| @anthropic-ai/claude-agent-sdk (or its platform binary) | The api-key-sdk path is unavailable and doctor reports it not ready. The claude-cli path and all other providers are unaffected. |
| @oven/bun-* (Bun) | bin/loki falls back to the bash CLI (slower). The api-key-sdk path is unavailable because the SDK loop runs only on Bun. |

<!-- END GENERATED REQUIREMENTS -->

## Install smoke test

`scripts/smoke-install.sh` packs the repository, installs the tarball into a temporary prefix, and runs `loki --version`, `loki doctor --json` and `loki route "add a health endpoint" --json`. It then repeats with Bun and the optional Agent SDK hidden. It is run by hand, is not part of CI, and writes a reproducible log. A run on one machine is evidence for that machine and OS only; it is not an OS matrix.

## Known behaviors

- Bun-less fallback: when Bun is absent, `loki doctor --json` runs a minimal bash evaluator (`autonomy/lib/requirements.sh`) over the same table. It checks presence only and does not compare versions, so the Node minimum is enforced only by the Bun doctor.
- `first_task_ready` does not verify that `claude auth login` was done or that an API key is valid.
- Observed once, with npm 11.17.0 on macOS arm64 and a local tarball: `npm install -g --omit=optional` still installed `@oven/bun-*` and the Claude Agent SDK packages. The smoke test removes them after install so the second case models a machine without them. This was not checked on other npm versions or from the registry.
