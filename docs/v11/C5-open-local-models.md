# C5: Open or local models

## Problem
Loki Mode ships with Claude, Codex, and Gemini APIs only. Customers want:
- Local LLM inference (Ollama, vLLM) for data privacy
- Open models (Llama 3, Mistral, Qwen) to reduce cost
- Model selection per task (Haiku for tests, Opus for planning)

## Current state
- `providers/claude.sh`, `codex.sh`, `gemini.sh` call their respective APIs
- No local model runner
- Model hardcoded in CLI config
- No OpenAI-compatible API abstraction

## Proposed v1 scope
- OpenAI-compatible interface (Ollama, vLLM, LocalAI)
- Provider: `LOKI_PROVIDER=local LOKI_LOCAL_API=http://127.0.0.1:8000`
- Model selection: `LOKI_MODEL=llama2:70b` or `mistral`
- Provider loader detects local vs remote API
- Fallback chain: try local first, fail if unreachable

## Open questions
- Which local runners to support? (Ollama primary, vLLM, LocalAI fallback?)
- Model registry: hardcoded list or discovery from endpoint?
- Context window limits: how to query max_tokens from Ollama?
- How to test CI without hosting local models?

## Why deferred from 11.0.0
Adds infrastructure cost and complexity. No tier-A demand. Requires Ollama/vLLM hosting.
