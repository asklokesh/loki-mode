# Model Catalog Probe Report

Automated weekly probe of provider docs found new model IDs that
are not yet in `providers/model_catalog.json`. Review and decide
whether to adopt each candidate.

## Findings

### claude

- `claude-haiku-4-5-20251001`
- `claude-opus-4`
- `claude-opus-4-0`
- `claude-opus-4-1`
- `claude-opus-4-1-20250805`
- `claude-opus-4-20250514`
- `claude-opus-4-5`
- `claude-opus-4-5-20251101`
- `claude-opus-4-6`
- `claude-sonnet-4`
- `claude-sonnet-4-0`
- `claude-sonnet-4-20250514`
- `claude-sonnet-4-5`
- `claude-sonnet-4-5-20250929`

### codex

- (none)

### gemini

- `gemini-2.0-flash`
- `gemini-2.5-flash`
- `gemini-2.5-flash-preview`
- `gemini-2.5-pro`
- `gemini-2.5-pro-preview`
- `gemini-3-flash`
- `gemini-3-pro`
- `gemini-3.1-flash`
- `gemini-3.1-pro`
- `gemini-3.1-pro-preview`

## How to adopt

1. Edit `providers/model_catalog.json` -- bump the relevant
   `latest_<tier>` entry and add the model to the `models[]` array.
2. Verify with: `python3 tools/probe-model-catalog.py` -- the
   candidate should disappear.
3. Test the new model end-to-end before merging.
