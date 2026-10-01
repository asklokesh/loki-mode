# R10: Agent + Template Marketplace (install-from-source)

Status: implemented in this worktree (isolated; not committed to main).
Scope: the install MECHANISM + a manifest format. There is NO hosted
central registry. This is honest install-from-source (git / local / url).
A central hub server is future work.

## Goal

Network effects: let users install community agents and PRD templates from
a shared source, the way Claude Code installs skills/plugins. Pairs with R8
(R8 exports shareable assets; R10 installs them). Shared assets become a
network effect that keeps users in the ecosystem.

## What already exists (verified, reused -- NOT rebuilt)

- `agents/types.json` -- a JSON ARRAY of 41 built-in agent objects. Fields
  (union): `type`, `name`, `swarm`, `persona`, `focus` (list), `capabilities`.
  Swarms: business, data, engineering, growth, operations, orchestration,
  product, review.
- `agents/managed_registry.py` -- a DIFFERENT registry: it materializes
  Managed Agent IDs via the Anthropic beta SDK, gated on managed-memory.
  It treats `types.json` as read-only source of truth. NOT related to
  install-from-source; no collision. We did not touch it.
- `cmd_agent()` (`autonomy/loki`) -- subcommands `list`, `info`, `run`,
  `start`, `review`. Each reads `types.json` directly in inline python
  blocks (5 sites).
- `templates/` -- 21 built-in PRD templates as `*.md` files (plus README).
- `cmd_init()` (`autonomy/loki`) -- `loki init --template <name>` is the
  consumer of templates: it validates `<name>` against a hardcoded
  `TEMPLATE_NAMES` array, resolves `$SKILL_DIR/templates/<name>.md` (or
  `examples/`), and writes a `prd.md`. `--stdout` prints the body.
- `cmd_quick()` -- generates an ad-hoc PRD; does not read `templates/`.
- Bun route (`loki-ts/src/cli.ts` + `bin/loki` shim): only ~12 high-traffic
  commands run on Bun; `agent` and `template` are NOT among them, so the
  shim execs the bash CLI for both. Parity is automatic and identical.
- R8 asset-export bundle format: NOT present in this tree yet. R10 defines
  the install side and a manifest format R8 can target. (Coordinate: R8
  exports a manifest of the same shape; R10 installs it.)

## What R10 adds (enhance-in-place)

### New module: `agents/hub_install.py`
Single source of truth for manifest validation + install. Importable for
tests; also a small CLI (`python3 hub_install.py <cmd> [source]`) used by
the bash CLI via env-passed JSON. DATA-ONLY: it never eval/imports/runs
anything from a source. For git/url it reads the manifest file only and
never runs build hooks, npm install, make, or scripts in the tree.

### Manifest format (JSON, `schema_version: 1`)

Agent:
```json
{
  "schema_version": 1,
  "kind": "agent",
  "type": "community-rust-pro",
  "name": "Rust Pro",
  "swarm": "engineering",
  "persona": "You are a senior Rust engineer...",
  "focus": ["rust", "tokio"],
  "capabilities": "Rust, tokio, async"
}
```

Template:
```json
{
  "schema_version": 1,
  "kind": "template",
  "name": "rust-cli",
  "label": "Rust CLI Tool",
  "description": "A CLI tool in Rust",
  "body": "# PRD: Rust CLI\n..."
}
```
(`body_file: "prd.md"` may be used instead of `body` for local/git sources;
the sibling markdown file is inlined, with traversal-safe name validation.)

### Store layout (project-local, under `.loki/`)
- `.loki/agents/installed.json` -- list of installed agent manifests
- `.loki/templates/<name>.md` -- installed template body
- `.loki/templates/installed.json` -- index of installed templates

Rationale: project-local keeps installs scoped and never writes into the
read-only package `agents/` or `templates/` dirs (those are wiped on
npm/Docker upgrade and would dirty cherry-pick). A user-global `~/.loki`
store is a natural future extension; not implemented here.

### CLI surface
- `loki agent install <source>` / `loki agent installed`
- `loki template install <source>` / `loki template list`
- `<source>` = local path | dir containing `manifest.json` | git repo URL
  (cloned shallow to temp, manifest read, temp discarded) | raw http(s)
  manifest URL.

### Reader integration (avoids write-only)
- `cmd_agent list / info / run / start / review`: union built-in
  `types.json` with `.loki/agents/installed.json` at read time, so installed
  agents are immediately visible to the existing consumers.
- `cmd_init --template <name>`: also resolves an installed template body
  (`.loki/templates/<name>.md`) and accepts the name as valid. Built-in
  templates and `init --list` are unchanged.

## Security model (no arbitrary code execution)

Validation rejects, BEFORE any write:
- Path traversal in `type` / template `name`: `..`, `/`, `\`, absolute
  paths, null bytes; names must match `^[a-z0-9][a-z0-9-]{0,79}$`.
- Built-in shadowing: a manifest claiming a built-in agent `type` or a
  built-in template `name` is rejected (cannot silently replace the
  security-reviewer persona, etc.).
- Wrong field types, oversized fields (persona/body/focus caps), manifest
  size cap, wrong `kind`, unsupported `schema_version`.
- Executable-looking fields (`postinstall`, `preinstall`, `scripts`,
  `exec`, `command`, `cmd`, `hooks`, `run`, `shell`, `eval`) are IGNORED,
  never run, stripped from the stored entry, and reported to the operator.
- Git clone is shallow, `--no-tags`, `GIT_TERMINAL_PROMPT=0`; only files
  are read. URL fetch uses urllib (no shell), with a size cap.

## Tests
- `tests/test_hub_install.py` -- 34 module assertions (install agent/template
  local + body_file, install from file:// git repo, malformed rejection,
  path-traversal rejection, built-in-shadow rejection, no-code-execution
  sentinel, unknown-source rejection, merged/installed read paths).
- `tests/cli/test-hub-install.sh` -- 14 end-to-end CLI assertions through
  `autonomy/loki` (install, list, agent list/info union, init --template
  resolves installed, git file:// source, security rejections, no-exec
  sentinel). No network.

## Honesty / gaps
- No hosted central marketplace server. Help text and this note say so.
- Store is project-local only (user-global `~/.loki` is future).
- No uninstall/update subcommand yet (re-install replaces in place).
- R8 export side is not in this tree; R10 defines the manifest shape R8
  should target.
- Dashboard UI for browsing/installing is out of scope for this pass.
