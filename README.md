Your agent says done. Loki proves it.

An autonomous software factory that knows what it is supposed to deliver, and proves it did.

<!-- 20-second loki-seal GIF: placeholder until recorded. Script: packages/loki-seal/demo/demo.tape -->
[loki-seal demo script](packages/loki-seal/demo/demo.tape)

## Install

```bash
claude plugin marketplace add ./packages/loki-seal   # then /plugin in Claude Code, install loki-seal
npx loki-mode tour                                   # zero-key replay of a real Evidence Receipt
```

loki-seal is a Claude Code Stop hook: when your agent tries to finish, it runs your repo's real test suite and refuses "done" if tests newly fail or if tests or CI config were deleted, skipped or weakened. Details: [packages/loki-seal/README.md](packages/loki-seal/README.md).

The Seal is the verdict loki-seal prints on every stop attempt: PASS with a receipt, or a block with the reason.

## What Loki Mode does

Hand it a PRD, GitHub issue, OpenAPI doc or one-line brief. It derives a delivery contract (the acceptance criteria), builds against it with a Reason, Act, Reflect, Verify loop, and ends with an Evidence Receipt that states what was proven and what was not. If the contract cannot be derived, it stops and asks one question instead of guessing.

```bash
npm install -g loki-mode      # or: bun install -g loki-mode
loki quickstart               # guided first build
loki start ./prd.md           # build from a PRD
loki start owner/repo#123     # build from an issue
```

Works with Claude Code (full support), Cline, OpenAI Codex CLI, Aider and opencode.

## Full reference

The previous long README moved, unchanged apart from link paths, to [docs/README-FULL.md](docs/README-FULL.md). It holds:

- Install methods (Bun, npm, Homebrew, Docker), the Claude Code plugin, and first-build commands
- Try it without installing, and read-only brownfield mode
- The Evidence Receipt, verification and Proven PR sections
- Architecture, quality gates, memory, dashboard and the enterprise layer
- Comparisons with other tools, the CLI reference and configuration
- Loki 10 engine preview, limitations and research foundation

More: [Installation](docs/INSTALLATION.md) | [Documentation](wiki/Home.md) | [Comparison](docs/COMPARISON.md) | [Changelog](CHANGELOG.md) | [Contributing](CONTRIBUTING.md) | [Website](https://www.autonomi.dev/)

[![npm version](https://img.shields.io/npm/v/loki-mode?style=for-the-badge&logo=npm&logoColor=white&color=553DE9)](https://www.npmjs.com/package/loki-mode)
[![License](https://img.shields.io/badge/License-BUSL--1.1-36342E?style=for-the-badge)](LICENSE)

License: [BUSL-1.1](LICENSE).
