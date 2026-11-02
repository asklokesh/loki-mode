#!/usr/bin/env bash
# Supported providers are claude (Claude Code CLI, or an Anthropic API key on the
# bundled Agent SDK) and opencode (any model, OpenRouter included). codex, cline,
# aider and gemini were removed. Asserts:
#   removed:  each removed name exits 2 with the one migration line, through
#             --provider X, --provider=X, LOKI_PROVIDER=X, `loki provider show X`
#             and `loki estimate --provider X`; the bash and Bun messages are
#             byte-identical; an unknown name still gets the supported list.
#   claude:   an engine10 run on the stub claude CLI ends VERIFIED.
#   opencode: an engine10 run with --provider opencode --model
#             openrouter/deepseek/deepseek-v3.2 and OPENROUTER_API_KEY reaches the
#             stub opencode as `run --auto -m openrouter/deepseek/deepseek-v3.2`
#             with the key in its environment, and the stub's change lands.
#   no key:   the same opencode run without OPENROUTER_API_KEY or an opencode
#             OpenRouter login is refused before any session, naming the key.
#   grep:     no removed provider name in shipped code paths, apart from the
#             migration lists/message and model-family price or key rows.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. bin/loki: drop the removed-provider guard (the --provider codex leg reads
#      the engine's own refusal, not the migration line).
#   2. loki-ts/src/runner/types.ts: change one word of removedProviderMessage
#      (the byte-identical leg fails).
#   3. bin/loki: send openrouter/* to LOKI_MODEL_ROUTE even for opencode (the
#      stub sees no -m and the argv leg fails).
#   4. loki-ts/src/commands/doctor.ts: drop the openrouter credential check (the
#      no-key run starts a session).
#   5. add `case "codex":` back to loki-ts/src/runner/providers.ts (the grep leg fails).

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
cd "$ROOT" || exit 2

echo "TEST: supported providers (claude, opencode) and removed-provider refusal"

export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 180)
FIX="$ROOT/tests/min/fixtures/e2e"
OCBIN="$ROOT/tests/min/fixtures/opencode/bin"
expect_msg() { printf "loki: provider '%s' is no longer supported. Supported providers: claude (Claude Code CLI, or an Anthropic API key through the Agent SDK) and opencode (any model, including OpenRouter via OPENROUTER_API_KEY). Switch with --provider claude or --provider opencode, or unset LOKI_PROVIDER." "$1"; }

# --- removed providers ------------------------------------------------------
mkdir -p "$T/empty"
for p in codex cline aider gemini; do
    want="$(expect_msg "$p")"
    for form in flag eq env show estimate; do
        case "$form" in
            flag) out="$(cd "$T/empty" && bash "$ROOT/bin/loki" start --provider "$p" "add a function" </dev/null 2>&1)"; rc=$? ;;
            eq) out="$(cd "$T/empty" && bash "$ROOT/bin/loki" start "--provider=$p" ./prd.md </dev/null 2>&1)"; rc=$? ;;
            env) out="$(cd "$T/empty" && LOKI_PROVIDER="$p" bash "$ROOT/bin/loki" status </dev/null 2>&1)"; rc=$? ;;
            show) out="$(cd "$T/empty" && bash "$ROOT/bin/loki" provider show "$p" </dev/null 2>&1)"; rc=$? ;;
            estimate) out="$(cd "$T/empty" && bash "$ROOT/bin/loki" estimate --provider "$p" </dev/null 2>&1)"; rc=$? ;;
        esac
        if [ "$rc" -eq 2 ] && [ "$out" = "$want" ]; then ok "$p ($form): exit 2, one migration line"
        else bad "$p ($form): rc=$rc out=$(printf '%s' "$out" | head -3)"; fi
    done
done
# The Bun entry on its own (no bin/loki guard in front) refuses with the same line.
out="$(cd "$T/empty" && bun "$LOKI_TS_ENTRY" start --provider codex "add a function" </dev/null 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && [ "$out" = "$(expect_msg codex)" ] && ok "Bun start --provider codex (no wrapper): exit 2, migration line" || bad "Bun start --provider codex: rc=$rc out=$out"
out="$(cd "$T/empty" && LOKI_PROVIDER=aider bun "$LOKI_TS_ENTRY" estimate </dev/null 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && [ "$out" = "$(expect_msg aider)" ] && ok "Bun LOKI_PROVIDER=aider estimate (no wrapper): exit 2, migration line" || bad "Bun LOKI_PROVIDER=aider estimate: rc=$rc out=$out"
# The Bun side (direct callers: the control plane, `bun loki-ts/src/cli.ts`) says the same bytes.
ts="$(cd "$ROOT/loki-ts" && bun -e 'const t = await import("./src/runner/types.ts"); process.stdout.write(["codex","cline","aider","gemini"].map((p) => t.removedProviderMessage(p)).join(""))' 2>&1)"
sh="$(bash -c '. "$1/providers/loader.sh"; for p in codex cline aider gemini; do loki_removed_provider_message "$p"; done' _ "$ROOT")"
[ "$ts" = "$sh" ] && ok "Bun and bash removed-provider messages are byte-identical" || bad "messages differ: ts=[$ts] sh=[$sh]"
ts_list="$(cd "$ROOT/loki-ts" && bun -e 'const t = await import("./src/runner/types.ts"); console.log([...t.VALID_PROVIDERS].join(" ") + "|" + [...t.REMOVED_PROVIDERS].join(" "))' 2>&1)"
sh_list="$(bash -c '. "$1/providers/loader.sh"; echo "${SUPPORTED_PROVIDERS[*]}|${REMOVED_PROVIDERS[*]}"' _ "$ROOT")"
[ "$ts_list" = "$sh_list" ] && [ "$sh_list" = "claude opencode|codex cline aider gemini" ] && ok "one provider list on both sides: $sh_list" || bad "lists differ: ts=$ts_list sh=$sh_list"
out="$(cd "$T/empty" && bash "$ROOT/bin/loki" estimate --provider foo </dev/null 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "use one of: claude, opencode" && ok "unknown provider: the supported list (estimate exit 1)" || bad "unknown provider: rc=$rc out=$out"

# --- claude and opencode on stubs ------------------------------------------
# run_engine <name> [env...] -- [loki args...] -> REPO, RC, OUT, D
run_engine() {
    local name="$1"; shift
    D="$T/$name"; REPO="$D/repo"; mkdir -p "$D"
    cp -R "$FIX/repo" "$REPO"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e
    git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add calc.ts calc.test.ts bunfig.toml
    git -C "$REPO" commit -q -m base
    local envs=()
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
    shift
    OUT="$(cd "$REPO" && env -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_PROVIDER -u OPENROUTER_API_KEY -u LOKI_OPENCODE_MODEL \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" E2E_STUB_MODE=done E2E_STUB_LOG="$D/stub.log" \
        LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$D/k.pem" ${envs[@]+"${envs[@]}"} \
        ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" start "add a multiply(a, b) function to calc.ts" --no-pr "$@" </dev/null 2>&1)"
    RC=$?
    local rid
    rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
    [ -n "$rid" ] && git -C "$REPO" rev-parse -q --verify "refs/heads/loki/$rid" >/dev/null && git -C "$REPO" checkout -q "loki/$rid"
}

run_engine claude PATH="$FIX/bin:$PATH" --
[ "$RC" -eq 0 ] && printf '%s\n' "$OUT" | grep -Eq '^Outcome:[[:space:]]+VERIFIED' && ok "claude on the stub: exit 0, Outcome VERIFIED" \
    || { bad "claude on the stub: rc=$RC"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; }

run_engine opencode PATH="$OCBIN:$FIX/bin:$PATH" OPENROUTER_API_KEY=sk-or-test-not-a-key E2E_OPENCODE_LOG="$T/opencode/oc.log" \
    -- --provider opencode --model openrouter/deepseek/deepseek-v3.2
if [ -s "$T/opencode/oc.log" ]; then
    grep -qx 'argv=--auto -m openrouter/deepseek/deepseek-v3.2.* key=set' "$T/opencode/oc.log" \
        && ! grep -qv 'argv=--auto -m openrouter/deepseek/deepseek-v3.2.* key=set' "$T/opencode/oc.log" \
        && ok "opencode on the stub: every session ran 'opencode run --auto -m openrouter/deepseek/deepseek-v3.2' with OPENROUTER_API_KEY" \
        || { bad "opencode argv or key wrong:"; sed 's/^/    | /' "$T/opencode/oc.log" | head -5; }
else
    bad "opencode on the stub: the stub never ran (rc=$RC)"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'
fi
grep -q 'export function multiply' "$REPO/calc.ts" && ok "opencode on the stub: the implement session's change landed" \
    || { bad "opencode on the stub: calc.ts has no multiply() (rc=$RC)"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; }
[ "$RC" -eq 0 ] && ok "opencode on the stub: exit 0" || bad "opencode on the stub exited $RC"

run_engine nokey PATH="$OCBIN:$FIX/bin:$PATH" E2E_OPENCODE_LOG="$T/nokey/oc.log" -- --provider opencode --model openrouter/deepseek/deepseek-v3.2
[ "$RC" -ne 0 ] && [ ! -s "$T/nokey/oc.log" ] && printf '%s\n' "$OUT" | grep -q 'export OPENROUTER_API_KEY' \
    && ok "opencode openrouter model with no key: refused before any session, names OPENROUTER_API_KEY" \
    || { bad "no-key run: rc=$RC sessions=$(wc -l < "$T/nokey/oc.log" 2>/dev/null || echo 0)"; printf '%s\n' "$OUT" | tail -6 | sed 's/^/    | /'; }

# --- no removed provider name in shipped code ------------------------------
# Allowed: the removed lists and message, GEMINI.md (an agent-rules file name), and model-family price/key rows
# that opencode reaches through OpenRouter (gemini models, GEMINI_API_KEY).
# Plain grep -w (BSD and GNU agree on it; git grep -E has no \b on macOS), plus the LOKI_<NAME>_ env vars -w cannot see.
SHIPPED=(action.yml bin providers autonomy loki-ts/src loki-ts/data/child-env.json mcp dashboard packages web-app/src web-app/server.py
         scripts tools api magic src completions docker deploy integrations sdk schemas learning agents)
hits="$( { grep -rnIiwE 'codex|cline|aider|gemini' "${SHIPPED[@]}"; grep -rnIE 'LOKI_(CODEX|CLINE|AIDER|GEMINI)_' "${SHIPPED[@]}"; } 2>/dev/null \
    | grep -vE '^[^:]*(/dist/|/node_modules/|\.md:|dashboard/static/|__pycache__)' \
    | grep -vE 'REMOVED_PROVIDERS|loki_removed_provider|is no longer supported|GEMINI\.md|GEMINI_API_KEY|"GEMINI_"|gemini": \{ input|removed_provider|_check_provider' || true)"
[ -z "$hits" ] && ok "no removed provider name in shipped code paths" || { bad "removed provider names remain:"; printf '%s\n' "$hits" | head -20 | sed 's/^/    | /'; }

finish
