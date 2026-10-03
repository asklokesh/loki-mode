# R5: Auto-wiki + Cited Codebase Q&A (Loki's DeepWiki) -- Design Note

Status: implemented in worktree (do not commit to main). Target release: R5 of the
competitive-stickiness arc. NO version bump in this worktree.

## Goal

A persistent, queryable per-project wiki generated from the codebase, surfaced in
the dashboard, with cited answers. Loki's answer to Devin DeepWiki. Sections cite
the real source files they were built from; `loki wiki ask` returns a grounded,
cited answer (citations = `file:line`). Generation is incremental: it skips when
the codebase has not changed (reuses the R1 codebase-signature idea).

## What already exists (verified against source, 2026-06-03)

| Asset | File | Reused? |
|---|---|---|
| `loki docs generate` (LLM-written README/ARCHITECTURE/...) | `autonomy/loki:20577` (`cmd_docs`) | Patterns reused: `_docs_scan_project`, `_docs_build_context`, `_docs_invoke_provider`, `_docs_write_manifest`. Not the command itself -- docs has no citations and no Q&A. |
| Proof-of-run generator (Python core, thin CLI readers) | `autonomy/lib/proof-generator.py`, bash `cmd_proof`, `loki-ts/src/commands/proof.ts` | Architecture precedent reused exactly: Python core does the heavy work; bash + Bun are thin readers; dashboard exposes read APIs. |
| PII redaction | `autonomy/lib/proof_redact.py` (`redact_tree`, `_redact_paths`) | Reused: wiki output is normalized to repo-relative paths and passed through the redactor so no `/Users/<name>/...` leaks. |
| Org knowledge graph | `memory/knowledge_graph.py` (`OrganizationKnowledgeGraph`) | Token-overlap scoring idea reused (`_tokenize` / `query_patterns`). NOT a codebase index -- it aggregates `.loki/memory/semantic/*.json` patterns across projects, keyed on `~/.loki/knowledge`. See "Honest reuse" below. |
| Memory retrieval | `memory/retrieval.py` (`MemoryRetrieval`) | Inspected. It retrieves memory entries (episodic/semantic/procedural), NOT source code. Not a code indexer. Not reused for code retrieval. |
| Dashboard read-API + traversal-safety | `dashboard/server.py:7191` (`_safe_proof_run_dir`) | Pattern reused for the wiki section/path param (`_safe_wiki_section`). |
| Dashboard web components | `legacy-ui/components/*.js` (Web Components) | New `loki-wiki-browser.js` follows the same `LokiElement` convention; registered in `index.js`. |

### Honest reuse statement

The task says "reuse memory/knowledge_graph.py and memory/retrieval.py." Both were
read. Neither is a *codebase* index: `knowledge_graph.py` aggregates cross-project
*memory patterns* (`.loki/memory/semantic`), and `retrieval.py` retrieves *memory
entries*, not source files. There was no existing per-file code index to query for
grounded citations. So R5 adds a new lightweight, dependency-free code index
(`autonomy/lib/wiki_index.py`) and reuses the parts that genuinely fit: the
token-overlap retrieval scoring (ported from `knowledge_graph._tokenize` /
`query_patterns`), the docs scanner, the proof manifest/signature idea, and the
redactor. Reuse is stated where real; not fabricated to satisfy a constraint.

ChromaDB (`tools/index-codebase.py`, MEMORY.md) is an OPTIONAL future backend. The
core deliberately does NOT depend on it: it needs Docker + python3.12 and is not
CI-safe. Default retrieval is deterministic and dependency-light.

## The grounding contract (the part that must be right)

Fabricated citations are made structurally impossible, not merely prompt-discouraged:

1. **Index**: `wiki_index.py` scans source files (git-tracked when available, else a
   filtered `find`), splits each into line-anchored chunks
   `{file, start_line, end_line, text}` where `file` is REPO-RELATIVE.
2. **Retrieve** (`ask`): deterministic token-overlap scoring (no LLM, no network)
   selects the top-K chunks for the question. Each is a record we own.
3. **Prompt**: the LLM sees NUMBERED chunks `[1]..[K]` and is told to cite by chunk
   index only (`[1]`, `[2]`). It never emits raw paths.
4. **Map + validate**: indices in the answer are mapped back to `{file, start_line}`
   from the retrieval records. Every citation is then validated against the
   filesystem (file exists AND start_line <= file length). Non-resolving citations
   are DROPPED. The LLM can only reference chunks we supplied, and only ones that
   resolve on disk -- so a fabricated citation cannot survive.
5. **generate**: per-section "sources" are CODE-DERIVED (the files the scanner read,
   the real def/class line numbers from a grep parse), not LLM-emitted. The LLM
   writes prose; the citation list comes from the index.

If the LLM is unavailable (CI, no provider), `ask` returns an EXTRACTIVE answer
(the top chunk snippets with their real citations) and `generate` writes a
template-based wiki whose citations are still the real scanned files. No fabrication
in any path.

## Mocking the LLM in CI

The Python core reads `LOKI_WIKI_LLM_STUB`:
- unset -> call the real provider via the same path `_docs_invoke_provider` uses
  (`claude -p` etc.), OR fall back to extractive/template if no provider on PATH.
- set to a file path -> read the stubbed completion from that file.
- set to any other value -> use it literally as the completion.

Tests set `LOKI_WIKI_LLM_STUB` so CI makes ZERO paid calls. This mirrors how the
proof tests fake `gh`/`open` via PATH and env.

## Storage layout (per project, generated)

```
.loki/wiki/
  wiki.json              # structured: sections[], each with title, body, citations[]
  index.md               # human-readable rendered wiki (overview + module list)
  architecture.md        # rendered architecture section
  modules.md             # rendered key-modules section
  data-flow.md           # rendered data-flow section
  wiki-manifest.json     # signature (git sha + per-file content hash), generated_at
  code-index.json        # the chunk index (file, start_line, end_line, tokens)
```

NOTE: `.loki/wiki/` (this deliverable, per-project, generated, gitignored) is a
DIFFERENT namespace from the repo-root `wiki/` (the GitHub wiki in the release
workflow). R5 never touches the latter.

## Incremental regeneration (R1 signature idea)

`wiki-manifest.json` stores a `signature` = sha256 over (git HEAD sha + sorted list
of `path:content-hash` for every scanned source file). `loki wiki generate` computes
the current signature; if it equals the stored one, it SKIPS regeneration and prints
"up to date" (unless `--force`). This is the same cheap-incremental idea as the docs
manifest and the R1 codebase signature.

## Command surface

```
loki wiki generate [path] [--force]   # build/refresh .loki/wiki/ (incremental)
loki wiki show [section]              # print rendered wiki (or one section)
loki wiki ask "<question>"           # grounded, cited answer (file:line)
```

## Build surface (mirrors the proof precedent)

- `autonomy/lib/wiki_index.py` -- scan + chunk + token-overlap retrieve + signature
  (importable module; underscore name).
- `autonomy/lib/wiki-generator.py` -- generate wiki.json + rendered md (LLM or
  template), citations code-derived; subprocess-invoked (hyphen in name, like
  proof-generator.py).
- `autonomy/lib/wiki-ask.py` -- retrieve K chunks, prompt (stub-aware), map + validate
  citations, print grounded answer. Subprocess-invoked.
- bash `cmd_wiki` in `autonomy/loki` (generate|show|ask) -- thin dispatcher to Python.
- Bun `loki-ts/src/commands/wiki.ts` -- native `show` (reads `.loki/wiki/`); `generate`
  and `ask` delegate to the bash/Python core (heavy work, provider). Added to the
  `bin/loki` allowlist and `cli.ts` switch.
- Dashboard: `GET /api/wiki` (list sections + manifest), `GET /api/wiki/{section}`,
  `POST /api/wiki/ask` -- all traversal-safe; web component `loki-wiki-browser.js`.

## Tests

- `tests/test_wiki_index.py` -- chunking is line-accurate; retrieval is deterministic;
  signature stable + changes on edit; repo-relative paths only.
- `tests/test_wiki_generator.py` -- generate on a fixture repo; citations point to REAL
  files; incremental skip when unchanged; LLM stubbed; no absolute paths (no PII).
- `tests/test_wiki_ask.py` -- `ask` returns grounded answer; every citation resolves on
  disk; a stub that emits a bogus `[99]` index is dropped (anti-fabrication).
- `tests/cli/test-wiki-command.sh` -- bash route generate/show/ask on a fixture, stubbed.
- `loki-ts/tests/commands/wiki.test.ts` -- Bun `show` parity with the rendered md.
- `tests/dashboard/test_wiki_routes.py` -- API list/get/ask + traversal rejection.
