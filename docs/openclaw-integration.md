# OpenClaw Integration

**Status: skeleton. Not a shipped feature.**

An earlier version of this page documented an OpenClaw coordination protocol
with `loki openclaw` subcommands, `/api/openclaw/*` REST endpoints,
`LOKI_OPENCLAW_*` environment variables, a `.loki/config.yaml` `openclaw:`
block, and `loki_openclaw_*` Prometheus metrics. **None of that exists in the
source.** It has been removed rather than left in place:

- `grep -c openclaw autonomy/loki` returns `0` -- there is no `loki openclaw`
  command in the CLI dispatch, and no `--openclaw` flag anywhere in
  `autonomy/` or `loki-ts/src/`.
- `grep -rn "api/openclaw" dashboard/server.py loki-ts/src/` returns nothing --
  none of the documented REST endpoints are implemented.
- No `LOKI_OPENCLAW_*` variable is read by any runtime code.

## What actually exists

Two real things, neither of which is a Loki CLI feature:

**1. A file-watching bridge skeleton** at `integrations/openclaw/bridge/`. It
watches a `.loki` directory, maps Loki events to an OpenClaw gateway message
shape (`schema_map.py`), and prints the mapped JSON to stdout. Its own module
docstring states the limitation plainly:

> NOTE: This is a foundation/skeleton. The WebSocket gateway client is not yet
> implemented. Currently logs mapped events to stdout as JSON for testing.
> The --gateway flag is accepted but has no effect until the WebSocket client
> is built in a future phase.

Run it directly, not through `loki`:

```bash
python -m integrations.openclaw.bridge --loki-dir .loki
```

**2. An OpenClaw skill package** at `integrations/openclaw/`, which you copy
into an OpenClaw workspace so an OpenClaw agent can invoke the ordinary
`loki start` / `loki status --json` CLI on your behalf. See
[`integrations/openclaw/README.md`](../integrations/openclaw/README.md) for the
install steps and the two helper scripts (`poll-status.sh`,
`format-progress.sh`).

## If you need real multi-agent coordination today

Use the surfaces that are actually implemented and tested:

- The MCP server (`loki mcp`) exposes Loki's tools to any MCP client.
- `.loki/events.jsonl` is the durable event stream the bridge skeleton reads;
  anything that can tail a JSONL file can consume it.
- `loki status --json` is the supported programmatic status surface.
