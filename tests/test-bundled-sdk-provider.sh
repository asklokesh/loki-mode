#!/usr/bin/env bash
# test-bundled-sdk-provider.sh -- the bundled Claude Agent SDK counts as a
# provider ONLY when it is genuinely usable.
#
# Guards the fail-open hazard: a green doctor followed by a failed first build is
# a worse first run than an honest blocker. detect_bundled_sdk_provider must
# return 0 only when ALL THREE hold (extracted binary + credentials + SDK loop
# active) and must fall back to today's behavior on any doubt.
#
# All cases run against a FIXTURE node_modules tree via the test-only
# LOKI_SDK_NODE_MODULES seam, so the real node_modules is never mutated and the
# result does not depend on what happens to be installed on the host.

set -uo pipefail

HELPER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/autonomy/provider-offer.sh"
pass=0; fail=0
ok()  { printf 'ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf 'FAIL %s\n' "$1"; fail=$((fail + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Fixture 1: a USABLE SDK -- platform package with an executable claude binary.
SDK_OK="$TMP/usable/node_modules"
mkdir -p "$SDK_OK/@anthropic-ai/claude-agent-sdk-testplat"
printf '#!/bin/sh\n' > "$SDK_OK/@anthropic-ai/claude-agent-sdk-testplat/claude"
chmod +x "$SDK_OK/@anthropic-ai/claude-agent-sdk-testplat/claude"

# Fixture 2: the --no-optional / unsupported-platform shape. The JS entrypoint is
# present (so a naive "does the package exist" probe would say yes) but NO
# platform package and therefore no runnable binary.
SDK_NOBIN="$TMP/nobin/node_modules"
mkdir -p "$SDK_NOBIN/@anthropic-ai/claude-agent-sdk"
printf 'export const query = 1;\n' > "$SDK_NOBIN/@anthropic-ai/claude-agent-sdk/sdk.mjs"

# probe <node_modules> <env assignments...> -- run the predicate in a clean env.
probe() {
    local nm="$1"; shift
    env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
        -u LOKI_SDK_LOOP -u LOKI_SDK_MODE \
        LOKI_SDK_NODE_MODULES="$nm" "$@" \
        bash "$HELPER" detect-sdk
}

# ---------- 1. SDK usable + key + loop active -> AVAILABLE ----------
if probe "$SDK_OK" LOKI_SDK_LOOP=1 ANTHROPIC_API_KEY=sk-test; then
    ok "SDK binary + ANTHROPIC_API_KEY + loop active -> provider available"
else
    bad "SDK binary + ANTHROPIC_API_KEY + loop active -> should be available"
fi

# A gateway base URL is a legitimate credential path (no raw key needed).
if probe "$SDK_OK" LOKI_SDK_LOOP=1 ANTHROPIC_BASE_URL=https://gw.example/v1; then
    ok "SDK binary + ANTHROPIC_BASE_URL + loop active -> provider available"
else
    bad "SDK binary + ANTHROPIC_BASE_URL + loop active -> should be available"
fi

# LOKI_SDK_MODE=full is the documented one-switch form. bin/loki resolves it into
# LOKI_SDK_LOOP before doctor runs, so assert on the resolved flag the same way.
if probe "$SDK_OK" LOKI_SDK_LOOP=true ANTHROPIC_API_KEY=sk-test; then
    ok "LOKI_SDK_LOOP=true (LOKI_SDK_MODE=full resolved) -> provider available"
else
    bad "LOKI_SDK_LOOP=true should be honored like =1"
fi

# ---------- 2. SDK usable, NO credentials -> STILL BLOCKED ----------
if probe "$SDK_OK" LOKI_SDK_LOOP=1; then
    bad "SDK binary with NO credentials must stay blocked (fail-open!)"
else
    ok "SDK binary + no credentials -> still blocked (fail-closed)"
fi

# ---------- 3. SDK NOT resolvable -> STILL BLOCKED ----------
if probe "$SDK_NOBIN" LOKI_SDK_LOOP=1 ANTHROPIC_API_KEY=sk-test; then
    bad "sdk.mjs present but NO platform binary must stay blocked (fail-open!)"
else
    ok "SDK declared but no runnable binary -> still blocked (fail-closed)"
fi

if probe "$TMP/absent/node_modules" LOKI_SDK_LOOP=1 ANTHROPIC_API_KEY=sk-test; then
    bad "absent node_modules must stay blocked (fail-open!)"
else
    ok "SDK not installed at all -> still blocked (fail-closed)"
fi

# ---------- 4. SDK usable + key, but the SDK loop is NOT active -> BLOCKED ----
# The easy-to-miss case: without LOKI_SDK_MODE/LOKI_SDK_LOOP, `loki start` never
# forks to the Bun SDK route (bin/loki) and dies on the bash route. A PASS here
# would be a green doctor followed by a failed build.
if probe "$SDK_OK" ANTHROPIC_API_KEY=sk-test; then
    bad "SDK+key but loop INACTIVE must stay blocked (fail-open!)"
else
    ok "SDK + key but SDK loop not active -> still blocked (fail-closed)"
fi

# REGRESSION (found by the T1 verify council, with a working repro): the
# truthy set here MUST match bin/loki:255 exactly, which forks to the Bun SDK
# loop only on "1" or "true". An earlier draft accepted the truthy() spellings
# yes/on/YES/On/... -- 8 of 10 accepted values were in the broken set. With
# LOKI_SDK_LOOP=yes doctor printed PASS while the next `loki start` stayed on
# the bash route and exited 2 at the provider gate: green doctor, dead build.
for _spelling in yes on YES ON True Yes On true1 ""; do
    if probe "$SDK_OK" LOKI_SDK_LOOP="$_spelling" ANTHROPIC_API_KEY=sk-test; then
        bad "LOKI_SDK_LOOP='$_spelling' is not honored by bin/loki:255 and must stay blocked (fail-open!)"
    fi
done
ok "only bin/loki's exact truthy set (1, true) opens the gate"

# The Bun runtime must exist. bin/loki:200-203 silently execs the BASH CLI when
# bun is absent, and the bash route needs a binary on PATH.
if PATH="/usr/bin:/bin" probe "$SDK_OK" LOKI_SDK_LOOP=1 ANTHROPIC_API_KEY=sk-test; then
    bad "bun absent must stay blocked (bin/loki falls back to bash) (fail-open!)"
else
    ok "bun absent -> still blocked (fail-closed)"
fi

if probe "$SDK_OK" LOKI_SDK_LOOP=0 ANTHROPIC_API_KEY=sk-test; then
    bad "explicit LOKI_SDK_LOOP=0 must stay blocked (fail-open!)"
else
    ok "explicit LOKI_SDK_LOOP=0 -> still blocked (fail-closed)"
fi

# ---------- 5. npm HOISTED layout is found ----------
# npm installs loki-mode to <tree>/node_modules/loki-mode but HOISTS the SDK up
# to <tree>/node_modules/@anthropic-ai/... (verified by packing this repo and
# installing the tarball). If the predicate only searched the package's own
# node_modules it would return 1 for every npm-installed user -- the feature
# would be dead for exactly the audience it targets. Simulate that layout by
# copying the helper into a fake installed package and NOT setting the seam.
HOIST="$TMP/hoisted/node_modules"
mkdir -p "$HOIST/loki-mode/autonomy" \
         "$HOIST/@anthropic-ai/claude-agent-sdk-testplat"
cp "$HELPER" "$HOIST/loki-mode/autonomy/provider-offer.sh"
printf '#!/bin/sh\n' > "$HOIST/@anthropic-ai/claude-agent-sdk-testplat/claude"
chmod +x "$HOIST/@anthropic-ai/claude-agent-sdk-testplat/claude"
if env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u LOKI_SDK_NODE_MODULES \
    LOKI_SDK_LOOP=1 ANTHROPIC_API_KEY=sk-test \
    bash "$HOIST/loki-mode/autonomy/provider-offer.sh" detect-sdk; then
    ok "npm-hoisted SDK layout is found (not dead for npm installs)"
else
    bad "npm-hoisted SDK layout MISSED -- feature dead for npm-installed users"
fi

# ---------- 6. detect_any_provider stays PATH-only ----------
# cmd_demo and cmd_quick run on the BASH route even under LOKI_SDK_MODE=full, so
# they genuinely need a binary. If the SDK predicate ever leaks into
# detect_any_provider, those pre-flight gates open onto a runner that cannot
# invoke anything.
STUB="$TMP/stubbin"; mkdir -p "$STUB"
if env -i PATH="$STUB:/usr/bin:/bin" LOKI_SDK_NODE_MODULES="$SDK_OK" \
    LOKI_SDK_LOOP=1 ANTHROPIC_API_KEY=sk-test \
    bash "$HELPER" detect; then
    bad "detect_any_provider must stay PATH-only (demo/quick fail-open!)"
else
    ok "detect_any_provider stays PATH-only even when the SDK is usable"
fi

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
