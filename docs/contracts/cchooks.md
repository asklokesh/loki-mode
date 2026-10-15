# CCHOOKS: Claude Code interop contract

Slice 1150-CCHOOKS. Loki is reachable from inside Claude Code through the
existing `plugins/loki-mode` plugin (marketplace entry in
`.claude-plugin/marketplace.json`). This slice completes it; it does not add a
parallel plugin.

## What the plugin ships

| Piece | File | Behavior |
| --- | --- | --- |
| Manifest | `.claude-plugin/plugin.json` | Unchanged (version tracks VERSION, guarded by `tests/test-plugin-json-current.sh`). |
| MCP registration | `.mcp.json` | Unchanged: `loki mcp --transport stdio` (47 tools incl. `loki_v10_run`, `loki_v10_verify`, `loki_verify_fast`). |
| `/loki-mode:start <task or file>` | `commands/start.md` | Runs `loki start --bg`, reports `loki status` and where the handoff lands. Writes free-text tasks to `.loki/handoff-task.md`. |
| `/loki-mode:verify [base]` | `commands/verify.md` | Runs `loki verify --fast --diff-base ${base:-HEAD}` and prints the compact verdict. |
| `/loki-mode:handoff` | `commands/handoff.md` | Prints `.loki/review/HANDOFF.md`, else `./HANDOFF.md`, else `loki own`. Never invents text. |
| Stop hook | `hooks/hooks.json`, `scripts/loki-stop-verify.sh` | Opt-in fast verifier gate, see below. |
| Installer | `autonomy/claude-code-setup.sh` via `loki setup-skill --claude-code` | Merges plugin config into Claude Code settings. |

Command names are namespaced by the plugin name, so they appear as
`/loki-mode:start` and not `/loki:start`. Pre-existing `/loki-mode:loki-verify`
(full PR-style gates), `loki-grill` and `loki-spec-status` are untouched.

Pre-existing and reused: the plugin, marketplace, MCP wiring, the opt-in
`loki-guard.sh` PreToolUse hook, `loki verify --fast` (`autonomy/lib/fast_verify.py`),
`loki own` (handoff renderer), `loki start --bg`, and `setup-skill`. New:
three commands, the Stop hook, the settings merger, the test.

## What Claude Code still does natively

Loki adds no model loop, permission system or sandbox here. Claude Code keeps:
tool permissions and prompts, the Stop-hook protocol and its
`stop_hook_active` flag, plugin install/enable/update, slash-command and MCP
transport, and the session itself. `/loki-mode:start` delegates to the Loki
CLI (which owns provider setup, budget and routing); the plugin only hands off
and reports.

## How the Stop hook decides

Off by default. Enabled by `LOKI_STOP_VERIFY=1` (set in the environment or in
Claude Code settings `env`; `loki setup-skill --claude-code --stop-hook` adds
it) or the plugin option env `CLAUDE_PLUGIN_OPTION_STOP_VERIFY`.

Allow (exit 0, no output) in every one of these cases:

1. Not opted in.
2. Event JSON has `stop_hook_active: true` (never loops after one block).
3. `loki`, `git`, or a git work tree is absent.
4. No uncommitted changes to tracked files (nothing the agent could have broken).
5. The verifier timed out (`LOKI_STOP_VERIFY_TIMEOUT`, default 20 s; hook
   timeout 30 s) or exited with anything other than 1 (0 PASS, 2 bad root,
   3 INCONCLUSIVE, 64 usage, 124/137 timeout). INCONCLUSIVE is not a block.

Block only when `loki verify --fast --diff-base HEAD` exits 1 (FAIL: at least
one high-severity finding). Output is
`{"decision":"block","reason":"..."}` with the first 15 verifier lines, so the
model sees the failing checks and a re-run command. The verifier is
deterministic: no model call, no network.

Limits: untracked new files are not in the diff scope (`git diff` semantics);
the fast verifier covers its detector set, not the project's own test suite.

## Installer

`loki setup-skill --claude-code [--print] [--project] [--stop-hook] [--settings FILE]`

- Merges `extraKnownMarketplaces.loki-mode`, `enabledPlugins["loki-mode@loki-mode"]`
  and, with `--stop-hook`, `env.LOKI_STOP_VERIFY`.
- Existing keys are kept as the user set them (even `false`); only missing keys
  are added. Invalid JSON is refused (exit 3) and the file is untouched.
  Writes are atomic (temp + rename). A second run reports `UNCHANGED`.
- `--print` prints the snippet and writes nothing.

## Tests

`tests/test-claude-code-plugin.sh` (registered in `tests/run-all-tests.sh` and
`tests/shard-durations.tsv`): JSON validity, hook fail-open without loki,
no-op unless opted in, block with a stub verifier, no loop on
`stop_hook_active`, allow on PASS, timeout and clean tree, settings merge,
idempotency, refusal on invalid JSON. No model calls.

## Known gaps

- Commands are `/loki-mode:*`, not `/loki:*`, unless the plugin is renamed.
- The handoff file `.loki/review/HANDOFF.md` is produced by another slice; the
  command falls back to `HANDOFF.md` and `loki own` when it is absent.
- Not exercised inside a live Claude Code session in this slice (no model
  calls); behavior is verified against the documented hook contract with stubs.
