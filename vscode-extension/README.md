# Loki Mode for VS Code

> **DEPRECATED.** This extension is no longer maintained. The Loki Mode product
> is now the CLI. Install it with `npm install -g loki-mode` (or Bun, Docker,
> Homebrew) and run it from your terminal, or use the built-in web dashboard
> with `loki dashboard start`.
>
> This Marketplace listing is kept only as a pointer for people who find it by
> search. It will not receive feature updates. The `vscode-extension/` source
> remains in the repository for reference, but no further functional releases
> are planned.
>
> Get started: [autonomi.dev](https://autonomi.dev) -
> [github.com/asklokesh/loki-mode](https://github.com/asklokesh/loki-mode)

## What Loki Mode is now

Loki Mode by Autonomi is an autonomous spec-to-product build system: give it a
spec (a PRD, a GitHub issue, an OpenAPI doc) and it runs an autonomous build
loop to a working, tested result. Its distinguishing feature is the verification
layer: it does not mark work complete until it passes deterministic quality
gates, a multi-reviewer completion council, and an evidence gate that requires
proof the tests and build actually ran and passed.

It runs as a CLI and ships with a web dashboard. There is no longer a maintained
VS Code extension surface.

## Use the CLI instead

```bash
# Install (pick one)
npm install -g loki-mode
bun install -g loki-mode
brew install asklokesh/tap/loki-mode

# Build from a spec
loki start ./prd.md            # from a PRD file
loki start owner/repo#123      # from a GitHub issue

# Check your environment
loki doctor

# Open the web dashboard (the modern replacement for this extension's panels)
loki dashboard start
```

### Docker

```bash
docker pull asklokesh/loki-mode
loki docker start ./prd.md
```

## Providers

- **Claude Code** (recommended) - full features: subagents, parallel execution,
  Task tool, MCP integration.
- **OpenAI Codex CLI** - degraded mode (sequential only).
- **Cline** and **Aider** - additional fallbacks.

Note: Google Gemini support was deprecated and its runtime removed in a later
release. It is no longer a supported provider.

## License

Source-available under the Business Source License 1.1 (BUSL-1.1): free to use
and self-host, converts to Apache-2.0 at the change date. See the `LICENSE` file.

## Links

- [Autonomi](https://autonomi.dev)
- [Loki Mode on GitHub](https://github.com/asklokesh/loki-mode)
- [Documentation](https://github.com/asklokesh/loki-mode#readme)
- [Report Issues](https://github.com/asklokesh/loki-mode/issues)
