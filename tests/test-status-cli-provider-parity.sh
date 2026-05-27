#!/usr/bin/env bash
# v7.7.12 UT2-13 parity test: both bash AND bun routes must report
# provider_source="cli" when .loki/state/cli-provider is present.
# Without this fix the bun route silently downgraded to "default",
# breaking the UT2-13 feature for npm-installed users.
set -u

LOKI_BIN_DIR=/Users/lokesh/git/loki-mode/bin
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

TEST=/tmp/loki-ut213-parity
rm -rf "$TEST"; mkdir -p "$TEST/.loki/state"
cd "$TEST" || exit 1

FRESH_TS=$(date +%s)
printf 'codex:%s:%s\n' "$FRESH_TS" "$$" > .loki/state/cli-provider

# bash route
BASH_OUT=$(LOKI_DIR=.loki LOKI_LEGACY_BASH=1 bash "$LOKI_BIN_DIR/loki" status --json 2>/dev/null)
BASH_PROV=$(echo "$BASH_OUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('provider',''))" 2>/dev/null)
BASH_SRC=$(echo "$BASH_OUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('provider_source',''))" 2>/dev/null)

# bun route (from local source so VERSION reads live)
BUN_OUT=$(LOKI_DIR=.loki BUN_FROM_SOURCE=1 bash "$LOKI_BIN_DIR/loki" status --json 2>/dev/null)
BUN_PROV=$(echo "$BUN_OUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('provider',''))" 2>/dev/null)
BUN_SRC=$(echo "$BUN_OUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('provider_source',''))" 2>/dev/null)

[ "$BASH_PROV" = "codex" ] && ok "bash: provider=codex" || bad "bash: provider='$BASH_PROV' expected codex"
[ "$BASH_SRC" = "cli" ] && ok "bash: provider_source=cli" || bad "bash: source='$BASH_SRC' expected cli"
[ "$BUN_PROV" = "codex" ] && ok "bun: provider=codex" || bad "bun: provider='$BUN_PROV' expected codex"
[ "$BUN_SRC" = "cli" ] && ok "bun: provider_source=cli" || bad "bun: source='$BUN_SRC' expected cli"
[ "$BASH_PROV" = "$BUN_PROV" ] && [ "$BASH_SRC" = "$BUN_SRC" ] && ok "bash+bun PARITY on cli-provider" || bad "bash+bun parity MISMATCH"

# Invalid provider name in marker -> both routes ignore
printf 'xyz:%s:%s\n' "$FRESH_TS" "$$" > .loki/state/cli-provider
BASH_SRC2=$(LOKI_DIR=.loki LOKI_LEGACY_BASH=1 bash "$LOKI_BIN_DIR/loki" status --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('provider_source',''))" 2>/dev/null)
BUN_SRC2=$(LOKI_DIR=.loki BUN_FROM_SOURCE=1 bash "$LOKI_BIN_DIR/loki" status --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('provider_source',''))" 2>/dev/null)
[ "$BASH_SRC2" != "cli" ] && ok "bash: invalid provider 'xyz' ignored" || bad "bash: accepted invalid xyz"
[ "$BUN_SRC2" != "cli" ] && ok "bun: invalid provider 'xyz' ignored" || bad "bun: accepted invalid xyz"

# Dead PID in marker -> both routes ignore
printf 'codex:%s:999999\n' "$FRESH_TS" > .loki/state/cli-provider
BASH_SRC3=$(LOKI_DIR=.loki LOKI_LEGACY_BASH=1 bash "$LOKI_BIN_DIR/loki" status --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('provider_source',''))" 2>/dev/null)
BUN_SRC3=$(LOKI_DIR=.loki BUN_FROM_SOURCE=1 bash "$LOKI_BIN_DIR/loki" status --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('provider_source',''))" 2>/dev/null)
[ "$BASH_SRC3" != "cli" ] && ok "bash: dead PID 999999 ignored" || bad "bash: accepted dead PID"
[ "$BUN_SRC3" != "cli" ] && ok "bun: dead PID 999999 ignored" || bad "bun: accepted dead PID"

cd / && rm -rf "$TEST"
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
