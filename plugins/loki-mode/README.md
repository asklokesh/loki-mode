# Loki Mode plugin for Claude Code

Loki Mode is the autonomous spec-to-product build system with a built-in trust
layer (RARV-C closure loop, 8 quality gates, completion council). This plugin
brings Loki's spec-hardening, drift-detection, and deterministic PR verification
into Claude Code as slash commands, and wires up the Loki MCP server.

Homepage: https://github.com/asklokesh/loki-mode

## Install

The plugin is published through the Autonomi marketplace, which lives in this
same repository.

1. Add the marketplace (one time):

   ```
   /plugin marketplace add asklokesh/loki-mode
   ```

2. Install the plugin:

   ```
   /plugin install loki-mode@loki-mode
   ```

That is it. The commands below become available immediately.

## What you get

Slash commands (namespaced as `loki-mode:<command>`):

- `loki-mode:loki-grill` - interrogate a spec with Loki's Devil's-Advocate
  grill before building, and summarize the hardest questions it surfaces.
- `loki-mode:loki-spec-status` - check whether the spec has drifted from its
  lock using deterministic living-spec drift detection.
- `loki-mode:loki-verify` - run Loki's deterministic PR verification on the
  current change and summarize the evidence verdict.

MCP server (`loki-mode`): exposes Loki's tools (memory, task queue, code
search, build management) to Claude Code.

## Requirement: the loki-mode CLI must be installed

The slash commands run `loki ...` subcommands, and the MCP server is launched
via `loki mcp`. Both require the `loki` binary to be on your PATH. Install it
once:

```
npm install -g loki-mode
```

or with Homebrew:

```
brew install asklokesh/tap/loki-mode
```

The plugin ships the commands, MCP wiring, and an optional guard hook. It does
not bundle the Loki runtime itself, because a marketplace plugin is copied into
an isolated cache and cannot reach the rest of the repository. The CLI on PATH
is what provides the runtime.

On the MCP server's first launch, if the Python MCP SDK is not present, the
bundled config sets `LOKI_MCP_AUTO_BOOTSTRAP=1` as written, in-advance consent
so the server can create a project-local virtualenv at `.loki/mcp-venv` and
install its dependencies non-interactively. Remove that env var from
`.mcp.json` if you prefer to bootstrap manually (run `loki mcp` once in a
terminal and follow the printed instructions).

## Optional Bash guard hook (off by default)

The plugin ships a `PreToolUse` hook for the Bash tool that is a no-op unless
you opt in. Set `LOKI_GUARD=1` in your environment to enable it. When enabled it
blocks a small set of clearly destructive Bash commands that have bitten Loki
runs before:

- `rm -rf` on `/tmp/loki-*` while a live Loki run may be staging files there
- `rm -rf` of a filesystem or `$HOME` root
- `git add -A` / `git add .` (Loki convention: stage files individually)

With `LOKI_GUARD` unset the hook always allows the command through, so it never
interferes unless you ask it to.

## License

SEE LICENSE IN LICENSE (BUSL-1.1, source-available). See the LICENSE file at the
repository root.
