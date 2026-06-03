# R8: Shareable Team Assets - Design Note

Status: implemented in this worktree (isolated; not committed to main).
Goal (per arc): turn individual setup into org lock-in / network effects by
making a team's invested assets EXPORTABLE and IMPORTABLE across a team or org,
so setup compounds into shared value (the skills-marketplace stickiness dynamic).

## 1. Inventory of existing machinery (verified against real source)

Before writing anything, the existing export/import/share + memory machinery
was read in full. Findings:

| Mechanism | Location | What it actually does | Reused? |
|---|---|---|---|
| `cmd_export` | `autonomy/loki:6254` | Per-run SESSION SNAPSHOT: json / markdown / csv / timeline of one `.loki/` run. Not portable across teams, not redacted. | Reused its `_export_check_overwrite` guard. |
| `cmd_import` | `autonomy/loki:4722` | Imports GitHub ISSUES into `.loki/queue/`. Unrelated to assets. | Not applicable (different domain). |
| `cmd_share` | `autonomy/loki:25147` | Uploads a session REPORT as a GitHub gist. | Not applicable (report, not assets). |
| `cmd_memory` | `autonomy/loki:14475` | Lists/show cross-project learnings in `~/.loki/learnings/*.jsonl`. No tarball export. | Same source dir reused as an asset category. |
| `proof_redact.py` | `autonomy/lib/proof_redact.py` | Single redaction chokepoint (R1). `redact_tree(obj)`, `redact_value(s)`, `set_context()`, `RULES_VERSION`. | REUSED as-is. No second redactor written. |
| agent registry | `agents/types.json` | 41 shipped agent types. `cmd_agent` (`autonomy/loki:19509`) reads it from the install dir. | Bundled as the `agents` category. |
| PRD templates | `templates/*.md` | 21 templates; read from `$SKILL_DIR/templates` at runtime (`autonomy/loki:9781`, `8840`). | Bundled as `templates`. |
| council config | `<project>/.loki/council/*.json` | `config.json` / `state.json` (`autonomy/loki:16688`, `autonomy/run.sh:3643`). | Bundled as `council`. |
| project memory | `<project>/.loki/memory/{episodic,semantic,skills,...}` (`autonomy/run.sh:3183`) | Per-project episodic/semantic/procedural memory. | Bundled as `memory`. |
| R5 wiki | `<project>/.loki/wiki/**` (`autonomy/loki:22881`) | Cited per-project wiki. | Bundled as `wiki` (opt-in). |

Key negative finding: there is NO separate per-user "custom agent" store.
"Custom agents" == the `agents/types.json` registry. We do not invent one
(that would be the parallel-machinery trap the task forbids).

## 2. Why `loki assets` is NOT a duplicate of `cmd_export`

- `cmd_export` = per-run session snapshot, one format at a time, not redacted,
  not portable. Scope: "what happened in this run".
- `loki assets` = portable, redacted, multi-category TEAM-ASSET tarball.
  Scope: "the reusable setup a team invested in", designed to travel to
  another clone/org. Different scope, different artifact, different lifetime.

Concrete reuse (not a fork): `_export_check_overwrite` (overwrite guard) and
the `proof_redact` chokepoint. No new redactor, no parallel exporter.

## 3. Asset map and the deliberate export/import asymmetry

| Category | Export source | Bundle path | Import restore root |
|---|---|---|---|
| learnings | `~/.loki/learnings/*.jsonl` | `learnings/` | `$HOME/.loki/learnings` |
| memory | `<project>/.loki/memory/**` | `memory/` | `<cwd>/.loki/memory` |
| agents | `$SKILL_DIR/agents/types.json` | `agents/` | `<cwd>/agents` |
| templates | `$SKILL_DIR/templates/*.md` | `templates/` | `<cwd>/templates` |
| council | `<project>/.loki/council/*.json` | `council/` | `<cwd>/.loki/council` |
| wiki (opt-in) | `<project>/.loki/wiki/**` | `wiki/` | `<cwd>/.loki/wiki` |

The export and import repo_root values are DELIBERATELY DIFFERENT (enforced in
`cmd_assets`, not in the Python helper):

- EXPORT reads agents/templates from the loki install (`$SKILL_DIR`), because
  that is where a team's edited registry/templates live and are read at
  runtime.
- IMPORT writes agents/templates under the caller's cwd (the target clone
  root) BY DEFAULT, NEVER silently back into the install. Writing into
  `$SKILL_DIR` would clobber the live install with redacted copies (this was
  caught and fixed during development: a bash smoke test that used `$SKILL_DIR`
  on import overwrote the worktree's real `agents/types.json` and templates;
  default restore root changed to cwd, damage reverted).
- `loki assets import --into-install` opts back into `$SKILL_DIR` for
  agents/templates only, so a GLOBAL-INSTALL user (the primary install path per
  CLAUDE.md) gets them read at runtime. This is the symmetric round-trip
  (export reads $SKILL_DIR, import --into-install writes $SKILL_DIR). It is
  opt-in because the default cwd target is non-destructive.

memory/learnings/council/wiki restore to `$HOME/.loki` or `<cwd>/.loki` and
take effect immediately regardless of the flag.

## 4. Redaction (single chokepoint, all file types)

`autonomy/lib/assets_bundle.py` calls `proof_redact.set_context(home, repo)`
then dispatches by extension before any byte is written into the tarball:
- `.json` -> parse -> `redact_tree` -> reserialize
- `.jsonl` -> per-line parse -> `redact_tree` -> reserialize
- `.md` / `.txt` / other -> `redact_value` on the whole string

Originals on disk are never modified (verified by test). Secrets seeded into
each of md, jsonl, and json are all stripped (verified by test + live leak
scan).

Scope of redaction (honest): proof_redact strips SECRETS / KEYS / TOKENS /
connection-string credentials / absolute home+repo PATHS, per its frozen
`RULES_VERSION`. It does NOT do general PII (emails, author names, free text).
The accurate claim for this feature is "no secrets/keys/home-paths leak," not
"no PII." The authoritative evidence is the leak-scan test
(`test_imported_assets_contain_no_secrets`), not the manifest count.

## 5. Honest gaps / limitations

- agents/templates restore relative to cwd by default; loki reads them from its
  install at runtime, so a global-install user should pass `--into-install` (or
  copy the restored `agents/` + `templates/` into their install). Documented in
  `--help` and the module docstring. memory/learnings/council/wiki are
  effective immediately.
- Round-trip is SEMANTICALLY FAITHFUL but REFORMATTED, not byte-identical:
  JSON files come back `indent=2`, and JSONL merge canonicalizes lines
  (sort_keys). Content/semantics are preserved; whitespace/key-order are not.
- The export-reads-install / import-writes-cwd asymmetry lives in the bash
  `cmd_assets`, not the Python helper. The Python tests pass roots explicitly
  so they cover the helper mechanics; the bash asymmetry is covered by
  `tests/test_assets_cli.sh` (export with SKILL_DIR=A, import from cwd=B,
  assert agents land in B).
- The manifest `redactions` count covers structured (json/jsonl) redactions
  only; `redact_value` (md/text) and path collapses are not counted (the
  redaction still HAPPENS). The authoritative no-PII evidence is the
  `test_imported_assets_contain_no_secrets` leak-scan test, not the count.
- `agents/types.json` and `templates/*.md` are repo-shipped defaults; a bundle
  from a fresh checkout re-ships the stock set. Value = captured team DELTAS
  travelling with the baseline.
- The placement tests assert files land at the mapped path; they do not assert
  the importing loki reads them at runtime (that is the global-install gap
  above).

## 6. bash + Bun parity

`assets` is NOT in the `bin/loki` Bun allowlist (`bin/loki:119`), so it falls
through the shim's default branch to the bash CLI (`bin/loki:145`), exactly like
`bench`. Parity is free via fall-through; no Bun command is needed or added.

## 7. Files

- `autonomy/lib/assets_bundle.py` (new) - bundler/redactor/restorer helper.
- `autonomy/loki` (modified) - `cmd_assets` + dispatch case.
- `tests/test_assets_bundle.py` (new) - 13 tests.
- `docs/R8-SHAREABLE-TEAM-ASSETS-PLAN.md` (this note).
