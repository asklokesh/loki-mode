#!/usr/bin/env bash
# Validate MiniMax model metadata and the existing compatible adapter paths.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CATALOG="$REPO_ROOT/providers/model_catalog.json"
PROVIDER_DOCS="$REPO_ROOT/wiki/Providers.md"

PASS=0
FAIL=0

ok() { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

if python3 -E - "$CATALOG" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    catalog = json.load(handle)

provider = catalog["providers"]["minimax"]
assert provider["latest_planning"] == "MiniMax-M3"
assert provider["latest_development"] == "MiniMax-M2.7"
assert provider["latest_fast"] == "MiniMax-M2.7"
assert provider["tier_fallback"] == {"fast": "development"}

endpoints = {item["region"]: item for item in provider["endpoints"]}
assert endpoints == {
    "global_en": {
        "region": "global_en",
        "openai_base_url": "https://api.minimax.io/v1",
        "anthropic_base_url": "https://api.minimax.io/anthropic",
        "docs_root": "https://platform.minimax.io/docs",
    },
    "cn_zh": {
        "region": "cn_zh",
        "openai_base_url": "https://api.minimaxi.com/v1",
        "anthropic_base_url": "https://api.minimaxi.com/anthropic",
        "docs_root": "https://platform.minimaxi.com/docs",
    },
}
assert all(item["anthropic_base_url"].endswith("/anthropic") for item in endpoints.values())

models = {item["id"]: item for item in provider["models"]}
assert list(models)[:2] == ["MiniMax-M3", "MiniMax-M2.7"]

m3 = models["MiniMax-M3"]
assert m3["context_window"] == 1_000_000
assert m3["input_modalities"] == ["text", "image", "video"]
assert m3["thinking"] == ["adaptive", "disabled"]
assert m3["pricing_usd_per_million_tokens"] == {
    "input": 0.3,
    "output": 1.2,
    "cache_read": 0.06,
    "cache_write": None,
}
assert m3["pricing_tiers_usd_per_million_tokens"] == [
    {
        "service_tier": "standard",
        "input_tokens_lte": 512_000,
        "input": 0.3,
        "output": 1.2,
        "cache_read": 0.06,
        "cache_write": None,
    },
    {
        "service_tier": "standard",
        "input_tokens_gt": 512_000,
        "input": 0.6,
        "output": 2.4,
        "cache_read": 0.12,
        "cache_write": None,
    },
    {
        "service_tier": "priority",
        "input_tokens_lte": 512_000,
        "input": 0.45,
        "output": 1.8,
        "cache_read": 0.09,
        "cache_write": None,
    },
    {
        "service_tier": "priority",
        "input_tokens_gt": 512_000,
        "input": 0.9,
        "output": 3.6,
        "cache_read": 0.18,
        "cache_write": None,
    },
]

m27 = models["MiniMax-M2.7"]
assert m27["context_window"] == 204_800
assert m27["input_modalities"] == ["text"]
assert m27["thinking"] == ["always_on"]
assert m27["pricing_usd_per_million_tokens"] == {
    "input": 0.3,
    "output": 1.2,
    "cache_read": 0.06,
    "cache_write": 0.375,
}
PY
then
    ok "catalog preserves model, endpoint, context, capability, and pricing metadata"
else
    bad "catalog metadata does not match the supported MiniMax configuration"
fi

docs_ok=true
for text in \
    'https://api.minimax.io/anthropic' \
    'https://api.minimaxi.com/anthropic' \
    'https://api.minimax.io/v1' \
    'https://api.minimaxi.com/v1' \
    'ANTHROPIC_BASE_URL' \
    'ANTHROPIC_API_KEY' \
    'LOKI_MODEL_OVERRIDE' \
    'OPENAI_API_BASE' \
    'OPENAI_API_KEY' \
    'LOKI_AIDER_MODEL' \
    'MiniMax-M3' \
    'MiniMax-M2.7'; do
    grep -Fq "$text" "$PROVIDER_DOCS" || docs_ok=false
done
if [ "$docs_ok" = true ]; then
    ok "provider documentation covers both regions, protocols, and models"
else
    bad "provider documentation is missing required MiniMax configuration"
fi

# The quoted script is expanded by the nested shell, not this test process.
# shellcheck disable=SC2016
anthropic_model="$({
    env -i HOME="$HOME" PATH="$PATH" \
        ANTHROPIC_BASE_URL="https://api.minimax.io/anthropic" \
        LOKI_MODEL_OVERRIDE="MiniMax-M3" \
        bash -c 'cd "$1"; . providers/claude.sh; resolve_model_for_tier development' _ "$REPO_ROOT"
} 2>/dev/null)"
if [ "$anthropic_model" = "MiniMax-M3" ]; then
    ok "Anthropic-compatible adapter resolves the configured model"
else
    bad "Anthropic-compatible adapter resolved '$anthropic_model'"
fi

# The quoted script is expanded by the nested shell, not this test process.
# shellcheck disable=SC2016
aider_model="$({
    env -i HOME="$HOME" PATH="$PATH" \
        OPENAI_API_BASE="https://api.minimax.io/v1" \
        OPENAI_API_KEY="test-key" \
        LOKI_AIDER_MODEL="openai/MiniMax-M2.7" \
        bash -c 'cd "$1"; . providers/aider.sh; printf "%s" "$AIDER_DEFAULT_MODEL"' _ "$REPO_ROOT"
} 2>/dev/null)"
if [ "$aider_model" = "openai/MiniMax-M2.7" ]; then
    ok "OpenAI-compatible adapter resolves the configured model"
else
    bad "OpenAI-compatible adapter resolved '$aider_model'"
fi

printf '\nTotal: %s  Passed: %s  Failed: %s\n' "$((PASS + FAIL))" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
