# SDK Mode: one-switch Anthropic SDK activation (v8.1)

Loki's engine can run its model calls through the Anthropic SDKs instead of
spawning the `claude` CLI. This is the enterprise / SaaS deploy path: a container
or worker runs with just `ANTHROPIC_API_KEY`, no interactive `claude` login and
no user-managed CLI version drift.

Everything here is OPT-IN and DEFAULT-OFF. With nothing set, the engine is
byte-identical to the bash `claude` route.

## The one knob: `LOKI_SDK_MODE`

| Value | What turns on | Use when |
|---|---|---|
| `off` (default) | nothing (byte-identical to v7/v8 bash route) | default |
| `judges` | the 7 one-shot JUDGE/TEXT sites (done-recognition, council-v2, code-review, completion-council VOTE, voter-agents, grill, prd-enrich). The RARV loop stays OFF. | recommended scale tier: no `claude` binary needed for judging, loop unchanged |
| `full` | all of `judges` PLUS the RARV main loop (`LOKI_SDK_LOOP`) | pre-flight only this release; requires `bun` (the loop runs on the Bun runner). The loop default-flip is a later release |

Alias: `LOKI_SDK=1` == `judges`; `LOKI_SDK=full` == `full`.

```bash
# Scale tier: judges on the SDK, loop on the existing route.
LOKI_SDK_MODE=judges loki start ./prd.md

# Pre-flight the full SDK engine (needs bun).
LOKI_SDK_MODE=full loki start ./prd.md

# See what one switch turned on.
LOKI_SDK_MODE_DEBUG=1 LOKI_SDK_MODE=judges loki start ./prd.md
# stderr: loki: SDK mode=judges -> judges on, loop=0
```

## Rollback: `LOKI_LEGACY_BASH=1`

Forces the legacy bash `claude` route for every command, overriding any
`LOKI_SDK_MODE` / `LOKI_SDK_*` setting. Honored at the `bin/loki` shim AND inside
the Bun provider resolver, so it wins even if the Bun route is reached another
way. This is the always-available escape hatch; today the loop is default-off, so
it is a no-op for the loop and only matters once the loop opts on.

```bash
LOKI_LEGACY_BASH=1 loki start ./prd.md   # legacy bash claude route, SDK off
```

## Advanced: the per-site flags (rollback appendix)

`LOKI_SDK_MODE` is a convenience that sets the default for eight per-site flags.
Set any of these EXPLICITLY to override the mode for one site (an explicit value,
even `=0`, always wins over the mode):

| Flag | Site |
|---|---|
| `LOKI_SDK_DONE_RECOG` | done-recognition judge |
| `LOKI_SDK_COUNCIL_V2` | council-v2 judge |
| `LOKI_SDK_CODE_REVIEW` | code-review reviewer |
| `LOKI_SDK_COUNCIL_VOTE` | completion-council member + contrarian VOTE |
| `LOKI_SDK_VOTER_AGENTS` | voter-agents council |
| `LOKI_SDK_GRILL` | grill (free-form text) |
| `LOKI_SDK_PRD_ENRICH` | prd-enrich (free-form text) |
| `LOKI_SDK_LOOP` | the RARV main loop (Bun runner) |

```bash
# Everything on the SDK EXCEPT code review (keep that on the bash claude route):
LOKI_SDK_MODE=full LOKI_SDK_CODE_REVIEW=0 loki start ./prd.md
```

## Guarantees

- **Fail-closed.** Any SDK miss (no key, transport error, refusal, malformed
  output, timeout, empty) falls through to the existing `claude` / deterministic
  path. A quality gate or completion council can never fake-PASS or fake-APPROVE
  via an SDK path.
- **Parity.** The bash and Bun/TypeScript routes resolve the same mode -> flags
  table (bound to a shared test fixture), so the two routes never diverge.
- **Requires a key.** The SDK route needs `ANTHROPIC_API_KEY` (or a gateway /
  Bedrock / Vertex base URL). Without it, every SDK site fail-closes to the bash
  route. `full` additionally requires `bun` for the loop; on a bun-less host every
  mode degrades to the legacy route.

Implementation: `autonomy/lib/sdk-mode.sh` (bash), `loki-ts/src/runner/sdk_mode.ts`
(TypeScript). Shared parity fixture: `loki-ts/test/fixtures/sdk-mode-table.json`.

## Dev-only OAuth auth (`LOKI_SDK_OAUTH_DEV`)

For local development you can drive the SDK JUDGE path with your existing `claude`
login instead of a standalone `ANTHROPIC_API_KEY`. Set `LOKI_SDK_OAUTH_DEV=1` with
NO `ANTHROPIC_API_KEY` present: the raw-SDK client (`sdk_invoker.ts`) reads the
freshest claude.ai OAuth access token (macOS Keychain `Claude Code-credentials`
first, then `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json`) and calls the
Messages API with a Bearer token plus the required `anthropic-beta:
oauth-2025-04-20` header.

```bash
# judges on the SDK, authenticated by your `claude` login (no API key):
LOKI_SDK_OAUTH_DEV=1 LOKI_SDK_MODE=judges loki start ./prd.md
```

DEV ONLY, and deliberately gated so it can never affect production:
- Activates only when the flag is set AND `ANTHROPIC_API_KEY` is ABSENT (an API
  key always wins).
- The token expires ~hourly and is NOT refreshed here; when it lapses mid-run the
  SDK site fail-closes to the deterministic/bash fallback, same as a missing key.
- Only wired for the JUDGE path (`sdk_invoker.ts`), not the agentic RARV loop.

Implementation: `loki-ts/src/runner/oauth_dev.ts`. Gate tests:
`loki-ts/test/runner/oauth_dev.test.ts`.
