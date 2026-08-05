# Extending the Loop

**When to load:** you want to add your own reviewer, agent, or gate to the RARV
loop without editing engine files.

Read this before writing an extension. Every claim below is cited to source, and
the one live seam is exercised by `tests/test-installed-agent-reviewer.sh`
(10 tests, wired into `tests/run-all-tests.sh:732`).

## What is actually extensible today

| Surface | Extend without editing engine files? | Mechanism |
|---|---|---|
| Code-review reviewer pool | **Yes** | `loki agent install` -> `.loki/agents/installed.json` |
| Numbered quality gates 1-8 | No | Compiled into `autonomy/run.sh` phases; opt-out flags only |
| RARV phases | No | Phase sequence lives in `run_autonomous()` (`autonomy/run.sh`) |
| MCP tools | Yes | Standard MCP server config (see `references/mcp-integration.md`) |

Only the reviewer pool has a supported, tested, data-only extension seam. The
rest are opt-out (disable) surfaces, not opt-in (add) surfaces. If you need a new
blocking gate, that is an engine change, not an extension.

## The reviewer seam (R10)

`autonomy/run.sh:14002-14036` loads user-installed agents into a dict named
`INSTALLED_SPECIALISTS` (declared at `:14013`), separate from the built-in
`SPECIALISTS` pool.

Line numbers drift. Re-anchor with
`grep -n "R10 extension seam" autonomy/run.sh` before relying on them.

### Install

Write a manifest and install it. The source may be a local path, a git repo URL,
or a raw manifest URL (`autonomy/loki:26774`).

```json
{
  "type": "a11y-auditor",
  "name": "Accessibility Auditor",
  "swarm": "review",
  "capabilities": "WCAG and screen-reader review",
  "focus": ["aria", "accessibility", "contrast", "keyboard"],
  "persona": "You audit for WCAG 2.2 AA compliance."
}
```

```bash
loki agent install ./my-agent/manifest.json
# Installed agent: a11y-auditor  (Accessibility Auditor)
# Stored in .loki/agents/installed.json
```

`focus` is load-bearing: those strings become the keywords that decide whether
your reviewer fires on a given diff. An agent with an empty `focus` is skipped
rather than made always-on (`autonomy/run.sh:14027`).

### When it fires

Your reviewer only fires when one of its `focus` keywords appears in the diff or
changed-file list, so a backend-only change does not pay for an a11y auditor.
Verified by running the real selector block extracted from `run.sh` against a
diff containing `aria-label`, `contrast`, `keyboard`:

```
REVIEWERS: ['architecture-strategist', 'maintainer-mergeability',
            'eng-frontend', 'security-sentinel', 'a11y-auditor']
```

The silent case (a diff matching none of the agent's keywords leaves it out of
the pool) is covered by the `stays silent on a diff its keywords do not match`
case in `tests/test-installed-agent-reviewer.sh`.

## Three invariants you cannot override

These are deliberate. An extension can only ADD scrutiny.

1. **Never displaces a built-in reviewer.** Installed agents are kept in a
   separate dict and APPENDED after the built-in `ranked[:want]` selection
   (`autonomy/run.sh:14011` records that an earlier version displaced
   `security-sentinel`, which is why the dicts are split). In the run above,
   `security-sentinel` is still present alongside the installed agent.
2. **Never shadows a built-in type.** An installed agent whose `type` collides
   with a built-in is skipped (`autonomy/run.sh:14022-14024`).
3. **Capped at 2 installed reviewers per run.** `_MAX_INSTALLED_REVIEWERS = 2`
   (`autonomy/run.sh:14104`). Each appended agent costs one more LLM reviewer
   call every iteration. Verified: three installed agents whose keywords all
   match one diff yield exactly two appended reviewers
   (`['a11y-one', 'a11y-two']`, the third dropped).

A corrupt or absent `installed.json` is swallowed and leaves the normal battery
intact (`autonomy/run.sh:14035-14036`) -- extensions must never be able to break
code review.

## Manifests are data, never code

`hub_install.py` stores manifest fields; it never executes anything from them.
Executable-looking fields are stripped and reported. Verified by installing a
manifest carrying a `postinstall` field:

```
{"type": "a11y-auditor", ..., "_ignored_executable_fields": ["postinstall"]}
```

The command in that field did not run. Covered by the test
`manifest postinstall field is not stored and never runs (data-only)`.

## `src/plugins/` is NOT a seam (status: unwired)

`src/plugins/` contains `GatePlugin`, `AgentPlugin`, `MCPPlugin`,
`IntegrationPlugin`, a loader and a validator, with 84 passing tests in
`tests/plugins/`.

**Status: not wired.** No engine file calls any of it, and the loop will never
call it. There is no `require` of `src/plugins` in
`autonomy/run.sh`, `autonomy/loki`, or anywhere outside its own tests, and
`tests/plugins/` is absent from the `test` script in `package.json`, from
`tests/run-all-tests.sh`, and from `scripts/local-ci.sh` -- so those 84 tests do
not run in CI.

Do not register a gate through `GatePlugin` expecting the loop to execute it.
Registration succeeds and nothing ever calls the gate. It is documented here so
the next reader does not mistake a green test suite for a working feature.

## Adding a real gate

If you need a new blocking gate, it is an engine change: add the phase to
`autonomy/run.sh`, give it an opt-out flag matching the `LOKI_GATE_*` convention
in `skills/quality-gates.md`, and mirror it on the Bun route. Follow
`skills/sdlc-fleet.md` -- a new gate is a non-trivial change and needs the
council.
