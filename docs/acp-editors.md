# Loki in VS Code and JetBrains via ACP

`loki acp` speaks the Agent Client Protocol (newline-delimited JSON-RPC over
stdio). It supports `initialize`, `session/new`, `session/prompt` and
`session/cancel`. Each prompt runs `loki quick "<prompt>"` in the session's
working directory and streams the output back. A non-zero exit is reported as
"NOT VERIFIED"; nothing is claimed that did not run. Loki never receives editor
credentials, and no network listener is opened.

## JetBrains (AI Assistant with ACP support)

Edit `~/.jetbrains/acp.json`:

    {"agent_servers": {"Loki": {"command": "loki", "args": ["acp"]}}}

## Zed

In settings.json:

    {"agent_servers": {"Loki": {"command": "loki", "args": ["acp"]}}}

## VS Code

Use any ACP client extension and register a custom agent with command `loki`
and args `acp`.

## Smoke test

    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | loki acp
