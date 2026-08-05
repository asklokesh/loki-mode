# v8 complexity audit: delete-list candidates

Date: 2026-07-24. Read-only. **Zero deletions performed** (founder decision).

## Why this audit exists

The competitive research corpus (source 12) proposed deleting `voice.sh`,
cockpit image rendering, `web-app/`, Managed Agents, and the "41 static roles"
to reduce single-maintainer load. VALIDATION.md marks that source's "unused"
label as an **assumption it never verified**, and the same source was already
caught undercounting `autonomy/loki` by 10k lines. So each candidate needed
positive proof, not a confident assertion.

**Method:** positive proof of non-reference. An absent grep hit is not evidence
(memory: grep-absence-false-green). A component counts as live if anything
references it, dispatches it, or ships it.

## Findings

| Candidate | Verdict | Evidence |
|---|---|---|
| `autonomy/voice.sh` (501 lines) | **ORPHANED (only true positive)** | Referenced by NOTHING except itself: a repo-wide search across `autonomy/`, `loki-ts/`, `scripts/`, `tests/`, `mcp/`, `dashboard/` returns only the file. Meanwhile `cmd_voice()` (`autonomy/loki:22751`) is dispatched (`:17884`) but is a 4-line stub that prints "Voice mode is planned for a future release" and points at issue #85. So the COMMAND is live and honest; the 501-line SCRIPT behind it is dead weight shipped in the npm tarball (`package.json` includes `autonomy/`). |
| cockpit rendering | **LIVE** | Real module with 5 source files (`loki-ts/src/cockpit/{raster,cli,capability,svg,render}.ts`). Not an orphan. Source 12 cited `loki-ts/src/commands/cockpit.ts`, which does NOT exist: its path was wrong, its conclusion untested. |
| `web-app/` | **LIVE AND SHIPPED** | 12 explicit entries in `package.json` `files` (`web-app/dist/`, `server.py`, `auth.py`, `models.py`, ...). Deleting it would break the published package. |
| Managed Agents | **NOT SUBSTANTIATED** | The claimed "NOT TESTED against live Anthropic API" marker in SKILL.md was not found. The premise of the delete recommendation could not be reproduced. |
| "41 static roles" | **MISCHARACTERIZED** | `references/agent-types.md:9` already documents these precisely: "prompt-defined specifications the orchestrator adopts per phase, **not separate processes**", with "typically 5-10 for simple projects" activated. They are a catalog, not 41 running agents. There is no static-role runtime cost to delete. |

## Conclusion

**One of five candidates survived.** Four were live, mis-pathed, unsubstantiated,
or mischaracterized. This is consistent with the pattern across this whole
planning pass: the research corpus's confident specifics do not survive contact
with the repo, and the plan's "audit before deleting anything" rule was load
bearing rather than cautious.

`autonomy/voice.sh` is a genuine 501-line orphan. Even so, **no deletion is
performed here** per the founder decision. Recommended follow-up, separately and
evidence-gated: either delete `voice.sh` and keep the honest `cmd_voice` stub, or
keep the script if issue #85 will build on it. That is a small, isolated call
with no dependents by definition.

## What this does NOT claim

This audit covers only the five named candidates. It is not a repo-wide dead-code
sweep, and it makes no claim about the rest of the tree.
