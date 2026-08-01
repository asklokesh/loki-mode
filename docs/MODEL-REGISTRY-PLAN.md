# One JSON file to update when a provider ships a model

Founder ask (2026-08-01): a simple JSON we define at packaging time, so
updating for new model releases is easy.

## The shape

`providers/model_registry.json` -- ONE file, flat, no cross-references. To adopt
a new model you edit one line.

```json
{
  "registry_version": "2026-08-01.1",
  "_howto": "Edit a value below and ship. Nothing else needs to change.",

  "tiers": {
    "frontier": {
      "anthropic": "opus",
      "openai":    "gpt-5.6",
      "google":    "gemini-3.1-pro-preview"
    },
    "balanced": {
      "anthropic": "sonnet",
      "openai":    "gpt-5.6-terra",
      "google":    "gemini-3.6-flash"
    },
    "fast": {
      "anthropic": "haiku",
      "openai":    "gpt-5.6-luna",
      "google":    "gemini-flash-latest"
    }
  },

  "pinned": {
    "_comment": "Optional. Set to override an alias with an exact snapshot.",
    "anthropic": {},
    "openai": {},
    "google": {}
  }
}
```

That is the whole contract. Three tiers x three providers.

## The one design decision that matters: ALIAS, not snapshot

The `anthropic` column holds `opus` / `sonnet` / `haiku`, not
`claude-opus-5` / `claude-sonnet-5` / `claude-haiku-4-5`.

**Verified against the live CLI on 2026-08-01:**

| passed | resolves to | note |
|---|---|---|
| `opus` | `claude-opus-5` | tracks latest automatically |
| `best` | `claude-fable-5` | Anthropic's most capable GA model |
| `haiku` | `claude-haiku-4-5-20251001` | |
| `claude-haiku-4-6` | **REJECTED** | "may not exist or you may not have access" |

Two facts fall out of that table, and both argue for aliases:

1. **Aliases self-update.** When Anthropic ships Opus 6, `opus` follows it with
   zero edits to this file. A snapshot id would need a release to track it --
   which is exactly how our catalog ended up pinned to `claude-opus-4-8` while
   Opus 5 shipped (fixed in v8.31.0).
2. **Snapshot ids are account-scoped.** `claude-haiku-4-6` may exist on the API
   and still be unreachable on a given account/CLI. Hardcoding it ships a
   broken default to whoever lacks access.

That second point is not theoretical. We already have a scar:
`tests/test-codex-model-trusted.sh` records that pinning `gpt-5.3-codex` broke
**every ChatGPT-account user**, because codex-cli rejects it on that tier -- and
Codex ships free with every ChatGPT plan. The safe landing spot was "send no
model and let the provider choose."

**Rule: prefer a provider alias. Use an exact id only in `pinned`, only
deliberately.**

## Why `pinned` exists

Anthropic's docs are explicit that Claude 4.6-generation dateless identifiers
are still **pinned snapshots, not evergreen pointers**. And Claude Code's
`best` / `opus` / `sonnet` are *Claude Code routing aliases* -- not a portable
contract in the raw Messages API.

So: aliases are right for the CLI providers we drive, and `pinned` is the escape
hatch for anyone who needs reproducibility or is calling an API directly.
Empty by default.

## What "frontier" maps to for Anthropic

`best` resolves to `claude-fable-5` today, and Anthropic positions Fable as most
capable generally, with `claude-opus-5` aimed specifically at complex agentic
coding and enterprise work.

**We map `frontier` -> `opus`, not `best`.** Our workload IS agentic coding, and
`fable` is advisory-only in this codebase: the runner collapses it to opus, so
offering it as an execution model would be a cost surprise. That reasoning
predates this file and is unchanged.

## What this replaces, and what it does not

`providers/model_catalog.json` stays. It carries per-provider metadata this file
deliberately does not (validation prefixes, tier fallbacks, aider's litellm
strings, the `models[]` ordering that the resolver depends on).

`model_registry.json` is the **editable surface**: the file a human opens when a
provider ships something. The catalog becomes derived where they overlap, and
`tests/test-model-catalog-single-source.sh` already fails when derived mirrors
disagree with their source -- that mechanism extends to cover this.

## Rollout, matching the lifecycle in the founder's note

The note's recommended lifecycle is right, and one step already exists here:

```
provider release detected      <- tools/probe-model-catalog.py (exists, reads live docs)
        v
add as frontier candidate      <- edit model_registry.json
        v
run coding-agent eval suite    <- benchmarks/ (exists)
        v
canary                         <- NOT built; needs traffic splitting we do not have
        v
promote alias                  <- edit one line
        v
keep previous as fallback      <- pinned{} holds the old id
```

**Honest gap:** we have no traffic-splitting layer, so 5% canary is not
implementable today. Do not put it in a release note as though it were.
Aliases blunt the need -- the provider is the one rolling the model forward,
and our eval suite plus the previous id in `pinned` is the realistic control.

## Resolution order (must stay identical on both routes)

```
LOKI_<PROVIDER>_MODEL        (trusted verbatim -- fine-tunes, org models)
  -> pinned[provider][tier]  (deliberate snapshot)
  -> tiers[tier][provider]   (the alias -- the normal path)
  -> provider default        (may legitimately be EMPTY: see codex/ChatGPT)
```

The last line is load-bearing. Empty means "send no `--model` and let the
provider pick," which is correct whenever we cannot know an id is valid for that
account. Never replace it with a guess.

## Acceptance

- Adding a model is a one-line edit to `model_registry.json`.
- `tests/test-model-catalog-current-flagship.sh` (v8.31.0) already fails when a
  tier points at a superseded same-family model; extend it to this file.
- A mutation flipping any alias back to a hardcoded snapshot must turn a test
  red.
- No test may assert an exact snapshot id that this account cannot dispatch --
  the `claude-haiku-4-6` result above is the reason.
