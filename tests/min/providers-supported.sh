#!/usr/bin/env bash
# Supported providers are claude (Claude Code CLI, or an Anthropic API key on the
# bundled Agent SDK) and opencode (any model, OpenRouter included). codex, cline,
# aider and gemini were removed. Asserts:
#   removed:  each removed name exits 2 with the one migration line, through
#             --provider X, --provider=X, LOKI_PROVIDER=X, `loki provider show|info|models X`
#             and `loki estimate --provider X`; api/ and web-app/ restate the same lists and message; the bash and Bun messages are
#             byte-identical; an unknown name still gets the supported list.
#   saved:    a removed name saved in .loki/state/provider gets the same line plus how to clear it
#             (`loki provider set claude`) from `loki start`, `loki quick`, `--engine engine10`, `loki route`
#             and `loki provider [show]` (Bun and bash), exit 2; the hint is byte-identical on both sides; after
#             `loki provider set claude` the project shows claude, exit 0.
#   claude:   an engine10 run on the stub claude CLI ends VERIFIED.
#   opencode: an engine10 run with --provider opencode --model
#             openrouter/deepseek/deepseek-v3.2 and OPENROUTER_API_KEY reaches the
#             stub opencode as `run --auto -m openrouter/deepseek/deepseek-v3.2`
#             with the key in its environment, and the stub's change lands.
#   saved engine: `loki provider set opencode` is honored by the engine: `loki start` and a bare `loki "task"` with
#             opencode saved run every session on opencode; `start --dry-run` names the saved provider, and LOKI_PROVIDER
#             still wins over it; a bare `loki "task"` with a removed name saved gets the migration line and the hint
#             (exit 2); a CRLF-saved name reads as the name; `loki failover --chain claude,bogus` names bogus.
#   no key:   the same opencode run without OPENROUTER_API_KEY or an opencode
#             OpenRouter login is refused before any session, naming the key.
#   toolless: toolLessCall (sdk_invoker.ts), on a stub client and a stub Agent SDK query(): no tools on either route; thinking off is
#             {type:"disabled"}, low is adaptive at effort low; the subscription route sends tools [], maxTurns 1, no setting sources,
#             no session file, a fixed title and CLAUDE_CODE_MAX_OUTPUT_TOKENS=maxTokens; each call is one priced child-ledger line (run_id, thinking tokens); an unreadable
#             result is an unmeasured line; LOKI_E10_MAX_COST_USD bounds the query (maxBudgetUsd) and a reached cap sends nothing.
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
#   6. autonomy/route.sh: drop the removed-provider check after _route_provider (the saved start legs read the
#      generic "is not supported" refusal).
#   7. loki-ts/src/commands/provider.ts: drop the saved removed-provider check in runProviderShow (saved show leg
#      prints "Provider: codex", exit 0).
#   8. providers/loader.sh: change one word of loki_removed_saved_provider_hint (the byte-identical hint leg fails).
#  10. loki-ts/src/engine10/supervisor.ts: drop the resolveRunProvider saved check (the saved-opencode runs go to claude,
#      and the bare saved-codex leg runs instead of refusing).
#  11. autonomy/route.sh _route_provider: drop the trailing-whitespace strip (the CRLF codex leg prints 'codex\r').
#  12. providers/loader.sh validate_provider: drop `p` from the local list (the failover leg names opencode).
#  13. autonomy/loki cmd_provider_show: put ${saved_provider} before ${LOKI_PROVIDER} again (bashshow leg names opencode).
#  14. loki-ts/src/commands/provider.ts defaultProvider (show) or runProviderList: saved before env (bunshow, bunlist legs).
#  15. autonomy/loki cmd_status: saved before env (bashstatus leg). 16. loki-ts/src/contrib/plan_cmd.ts: back to
#      `LOKI_PROVIDER || "claude"` (the plan leg's opencode log stays empty). 17. cost_preview.ts runEstimate: same
#      (the estimate-saved-codex leg runs instead of refusing). 18. autonomy/route.sh: drop the saved hint on the
#      unsupported-provider message (the bogus saved leg).
#  19. sdk_invoker.ts toolLessThinking: off no longer disabled; drop `tools: []`; drop the ledger append on the SDK route; drop the cap
#      refusal; drop maxBudgetUsd; drop the fixed title; drop the max-output env; meter a cap without a run id (each fails the toolless leg).
#   9. tests/min/providers-supported.sh run_engine: keep XDG_CONFIG_HOME from the caller and give the no-key leg an
#      opencode.json with provider.openrouter there (the no-key leg starts a session; proves the isolation matters).

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
    for form in flag eq env show info infojson models estimate; do
        case "$form" in
            flag) out="$(cd "$T/empty" && bash "$ROOT/bin/loki" start --provider "$p" "add a function" </dev/null 2>&1)"; rc=$? ;;
            eq) out="$(cd "$T/empty" && bash "$ROOT/bin/loki" start "--provider=$p" ./prd.md </dev/null 2>&1)"; rc=$? ;;
            env) out="$(cd "$T/empty" && LOKI_PROVIDER="$p" bash "$ROOT/bin/loki" status </dev/null 2>&1)"; rc=$? ;;
            show) out="$(cd "$T/empty" && bash "$ROOT/bin/loki" provider show "$p" </dev/null 2>&1)"; rc=$? ;;
            info) out="$(cd "$T/empty" && bash "$ROOT/bin/loki" provider info "$p" </dev/null 2>&1)"; rc=$? ;;
            infojson) out="$(cd "$T/empty" && bash "$ROOT/bin/loki" provider info "$p" --json </dev/null 2>&1)"; rc=$? ;;
            models) out="$(cd "$T/empty" && bash "$ROOT/bin/loki" provider models "$p" </dev/null 2>&1)"; rc=$? ;;
            estimate) out="$(cd "$T/empty" && bash "$ROOT/bin/loki" estimate --provider "$p" </dev/null 2>&1)"; rc=$? ;;
        esac
        if [ "$rc" -eq 2 ] && [ "$out" = "$want" ]; then ok "$p ($form): exit 2, one migration line"
        else bad "$p ($form): rc=$rc out=$(printf '%s' "$out" | head -3)"; fi
    done
done
# A removed name saved in the project: the same line plus how to clear it, on every start route and `provider show`.
hint() { printf "loki: this project saved provider '%s' in .loki/state/provider; switch it with: loki provider set claude" "$1"; }
for p in codex gemini; do
    SD="$T/saved-$p"; mkdir -p "$SD/.loki/state"; printf '%s\n' "$p" > "$SD/.loki/state/provider"
    want="$(expect_msg "$p")
$(hint "$p")"
    for form in start quick engine10 route show bare bunshow bashshow; do
        case "$form" in
            start) out="$(cd "$SD" && bash "$ROOT/bin/loki" start "add a function" </dev/null 2>&1)"; rc=$? ;;
            quick) out="$(cd "$SD" && bash "$ROOT/bin/loki" quick "add a function" </dev/null 2>&1)"; rc=$? ;;
            engine10) out="$(cd "$SD" && bash "$ROOT/bin/loki" start --engine engine10 "add a function" </dev/null 2>&1)"; rc=$? ;;
            route) out="$(cd "$SD" && bash "$ROOT/bin/loki" route start "add a function" </dev/null 2>&1)"; rc=$? ;;
            show) out="$(cd "$SD" && bash "$ROOT/bin/loki" provider show </dev/null 2>&1)"; rc=$? ;;
            bare) out="$(cd "$SD" && bash "$ROOT/bin/loki" provider </dev/null 2>&1)"; rc=$? ;;
            bunshow) out="$(cd "$SD" && bun "$LOKI_TS_ENTRY" provider show </dev/null 2>&1)"; rc=$? ;;
            bashshow) out="$(cd "$SD" && bash "$ROOT/autonomy/loki" provider show </dev/null 2>&1)"; rc=$? ;;
        esac
        if [ "$rc" -eq 2 ] && [ "$out" = "$want" ]; then ok "saved $p ($form): exit 2, migration line and the provider set hint"
        else bad "saved $p ($form): rc=$rc out=$(printf '%s' "$out" | head -3)"; fi
    done
done
ts="$(cd "$ROOT/loki-ts" && bun -e 'const t = await import("./src/runner/types.ts"); process.stdout.write(t.removedSavedProviderHint("codex"))' 2>&1)"
sh="$(bash -c '. "$1/providers/loader.sh"; loki_removed_saved_provider_hint codex' _ "$ROOT")"
[ "$ts" = "$sh" ] && [ "$sh" = "$(hint codex)" ] && ok "Bun and bash saved-provider hints are byte-identical" || bad "hints differ: ts=[$ts] sh=[$sh]"
SD="$T/saved-codex"
out="$(cd "$SD" && bash "$ROOT/bin/loki" provider set claude </dev/null 2>&1 && bash "$ROOT/bin/loki" provider show </dev/null 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && [ "$(cat "$SD/.loki/state/provider")" = "claude" ] && printf '%s' "$out" | grep -q 'Provider:.* claude' \
    && ok "loki provider set claude clears the saved removed provider (show exits 0, claude)" || bad "provider set claude: rc=$rc out=$(printf '%s' "$out" | head -3)"
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
# Restatements in files that ship without loki-ts/src or providers/ (api/, web-app/): same lists, same bytes.
# Read from source without importing (the servers start on import): the TS/JS template and the Python function via ast.
rest="$(python3 -I - "$ROOT" "$sh_list" "$sh" <<'PY'
import ast, re, sys
root, want_list, want_msg = sys.argv[1], sys.argv[2], sys.argv[3]
names = ["codex", "cline", "aider", "gemini"]
def arr(src, name):
    m = re.search(r"const %s(?:: string\[\])? = \[([^\]]*)\]" % name, src)
    return " ".join(re.findall(r"['\"]([a-z]+)['\"]", m.group(1))) if m else "?"
out = []
for f in ("api/routes/sessions.ts", "api/server.js"):
    src = open(f"{root}/{f}").read()
    m = re.search(r"removedProviderMessage = \(\w+(?:: string)?\)(?:: string)? =>\s*`([^`]*)`", src)
    msg = "".join(re.sub(r"\$\{\w+\}", n, m.group(1)) + "\n" for n in names) if m else "?"
    lst = arr(src, "SUPPORTED_PROVIDERS" if f.endswith(".ts") else "VALID_PROVIDERS") + "|" + arr(src, "REMOVED_PROVIDERS")
    out.append(f"{f}: list={'ok' if lst == want_list else lst} msg={'ok' if msg.rstrip(chr(10)) == want_msg.rstrip(chr(10)) else 'DIFF'}")
tree = ast.parse(open(f"{root}/web-app/server.py").read())
keep = [n for n in tree.body if (isinstance(n, ast.Assign) and any(getattr(t, "id", "") in ("_SUPPORTED_PROVIDERS", "_REMOVED_PROVIDERS") for t in n.targets)) or (isinstance(n, ast.FunctionDef) and n.name == "_check_provider")]
ns = {}; exec(compile(ast.Module(body=keep, type_ignores=[]), "web-app/server.py", "exec"), ns)
msg = ""
for n in names:
    try: ns["_check_provider"](n)
    except ValueError as e: msg += str(e) + "\n"
lst = " ".join(ns.get("_SUPPORTED_PROVIDERS", ())) + "|" + " ".join(ns.get("_REMOVED_PROVIDERS", ()))
out.append(f"web-app/server.py: list={'ok' if lst == want_list else lst} msg={'ok' if msg.rstrip(chr(10)) == want_msg.rstrip(chr(10)) else 'DIFF'}")
print("\n".join(out))
PY
)"
[ "$(printf '%s\n' "$rest" | grep -c 'list=ok msg=ok')" -eq 3 ] && ok "api/ and web-app/ restate the same lists and byte-identical message" || { bad "restated provider lists or message drifted:"; printf '%s\n' "$rest" | sed 's/^/    | /'; }
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
    if [ -n "${SAVED_PROVIDER:-}" ]; then mkdir -p "$REPO/.loki/state"; printf '%s\n' "$SAVED_PROVIDER" > "$REPO/.loki/state/provider"; fi
    local verb=(start); [ -n "${BARE:-}" ] && verb=()
    local envs=()
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
    shift
    # The opencode credential sources are cleared too (OPENCODE_CONFIG*, and XDG dirs pointed at empty paths so the
    # ~/.config and ~/.local/share fallbacks are not read either): a dev machine's own opencode setup cannot make the
    # no-key leg start a session. A leg that needs a source passes it in envs, which come later (cfgkey).
    OUT="$(cd "$REPO" && env -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_PROVIDER -u OPENROUTER_API_KEY -u LOKI_OPENCODE_MODEL \
        -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT XDG_CONFIG_HOME="$D/xdg-config" XDG_DATA_HOME="$D/xdg-data" \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" E2E_STUB_MODE=done E2E_STUB_LOG="$D/stub.log" \
        LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$D/k.pem" ${envs[@]+"${envs[@]}"} \
        ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" ${verb[@]+"${verb[@]}"} "add a multiply(a, b) function to calc.ts" --no-pr "$@" </dev/null 2>&1)"
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

# The project's saved provider reaches the engine: every session (the stub opencode hands each to the stub claude, so the
# claude log counts all sessions) went through opencode, on `loki start` and on a bare `loki "task"`.
for form in start bare; do
    SAVED_PROVIDER=opencode BARE="$([ "$form" = bare ] && echo 1)" run_engine "saved-$form" PATH="$OCBIN:$FIX/bin:$PATH" \
        OPENROUTER_API_KEY=sk-or-test-not-a-key E2E_OPENCODE_LOG="$T/saved-$form/oc.log" --
    oc="$(wc -l < "$T/saved-$form/oc.log" 2>/dev/null | tr -d ' ')"; all="$(wc -l < "$T/saved-$form/stub.log" 2>/dev/null | tr -d ' ')"
    [ "$RC" -eq 0 ] && [ "${oc:-0}" -gt 0 ] && [ "$oc" = "$all" ] && ok "saved opencode ($form): all $all sessions ran on opencode" \
        || { bad "saved opencode ($form): rc=$RC opencode=${oc:-0} of ${all:-0} sessions"; printf '%s\n' "$OUT" | tail -6 | sed 's/^/    | /'; }
done
G="$T/saved-git"; mkdir -p "$G" && git -C "$G" init -q -b main && git -C "$G" config user.name e && git -C "$G" config user.email e@x.invalid \
    && printf 'x\n' > "$G/a.txt" && git -C "$G" add a.txt && git -C "$G" commit -q -m base && mkdir -p "$G/.loki/state"
printf 'opencode\n' > "$G/.loki/state/provider"
out="$(cd "$G" && env -u LOKI_PROVIDER OPENROUTER_API_KEY=sk-or-test-not-a-key PATH="$OCBIN:$PATH" bash "$ROOT/bin/loki" start --dry-run "add a function" </dev/null 2>&1)"
printf '%s' "$out" | grep -q 'dry-run: provider opencode,' && ok "start --dry-run names the saved provider (opencode)" || bad "dry-run saved: $(printf '%s' "$out" | tail -2)"
out="$(cd "$G" && LOKI_PROVIDER=claude PATH="$FIX/bin:$PATH" bash "$ROOT/bin/loki" start --dry-run "add a function" </dev/null 2>&1)"
printf '%s' "$out" | grep -q 'dry-run: provider claude,' && ok "LOKI_PROVIDER wins over the saved provider (dry-run claude)" || bad "dry-run env over saved: $(printf '%s' "$out" | tail -2)"
printf 'codex\n' > "$G/.loki/state/provider"
out="$(cd "$G" && env -u LOKI_PROVIDER bash "$ROOT/bin/loki" "add a function" --no-pr </dev/null 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && [ "$out" = "$(expect_msg codex)
$(hint codex)" ] && ok "bare loki \"task\" with codex saved: exit 2, migration line and hint" || bad "bare saved codex: rc=$rc out=$(printf '%s' "$out" | head -3)"
out="$(cd "$G" && env -u LOKI_PROVIDER bash "$ROOT/bin/loki" start --dry-run "add a function" </dev/null 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && [ "$out" = "$(expect_msg codex)
$(hint codex)" ] && ok "start --dry-run with codex saved: exit 2, migration line and hint" || bad "dry-run saved codex: rc=$rc out=$(printf '%s' "$out" | head -3)"
printf 'codex\r\n' > "$G/.loki/state/provider"
out="$(cd "$G" && env -u LOKI_PROVIDER bash "$ROOT/bin/loki" start "add a function" </dev/null 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && [ "$out" = "$(expect_msg codex)
$(hint codex)" ] && ok "a CRLF-saved codex reads as codex (start: migration line and hint)" || bad "CRLF saved: rc=$rc out=$(printf '%s' "$out" | od -c | head -3)"
out="$(cd "$T/empty" && bash "$ROOT/bin/loki" failover --chain claude,bogus </dev/null 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "invalid provider 'bogus' in chain" && ok "failover --chain claude,bogus names bogus" || bad "failover chain: rc=$rc out=$out"

# Every entry point reads the order flag > LOKI_PROVIDER > saved > claude: show, list and status name the env value, and
# `loki plan` and `loki estimate` use the saved project choice instead of claude.
printf 'opencode\n' > "$G/.loki/state/provider"
for form in bashshow bunshow bashlist bunlist bashstatus; do
    case "$form" in
        bashshow) out="$(cd "$G" && LOKI_PROVIDER=claude bash "$ROOT/autonomy/loki" provider show </dev/null 2>&1)"; want='Provider:.* claude$' ;;
        bunshow) out="$(cd "$G" && LOKI_PROVIDER=claude bun "$LOKI_TS_ENTRY" provider show </dev/null 2>&1)"; want='Provider:.* claude$' ;;
        bashlist) out="$(cd "$G" && LOKI_PROVIDER=claude bash "$ROOT/autonomy/loki" provider list </dev/null 2>&1)"; want='^ *claude .*\(current\)' ;;
        bunlist) out="$(cd "$G" && LOKI_PROVIDER=claude bun "$LOKI_TS_ENTRY" provider list </dev/null 2>&1)"; want='^ *claude .*\(current\)' ;;
        bashstatus) out="$(cd "$G" && LOKI_PROVIDER=claude bash "$ROOT/autonomy/loki" status </dev/null 2>&1)"; want='Provider:.* claude \(' ;;
    esac
    clean="$(printf '%s' "$out" | sed $'s/\x1b\\[[0-9;]*m//g')"
    if printf '%s\n' "$clean" | grep -qE "$want" && ! printf '%s\n' "$clean" | grep -E '^ *opencode .*\(current\)' >/dev/null; then ok "LOKI_PROVIDER=claude over saved opencode ($form): shows claude"
    else bad "env over saved ($form): $(printf '%s' "$clean" | head -4)"; fi
done
out="$(cd "$G" && env -u LOKI_PROVIDER bash "$ROOT/autonomy/loki" provider show </dev/null 2>&1)"
printf '%s' "$out" | grep -q 'Provider:.* opencode' && ok "saved opencode with no LOKI_PROVIDER: provider show names opencode" || bad "show saved: $(printf '%s' "$out" | head -3)"
mkdir -p "$T/plan"; rm -f "$T/plan/oc.log"
out="$(cd "$G" && rm -rf .loki/specs && env -u LOKI_PROVIDER OPENROUTER_API_KEY=sk-or-test-not-a-key PATH="$OCBIN:$FIX/bin:$PATH" E2E_OPENCODE_LOG="$T/plan/oc.log" "${TO[@]}" bash "$ROOT/bin/loki" plan "add a function" --spec </dev/null 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && [ -s "$T/plan/oc.log" ] && ok "loki plan --spec with opencode saved runs its session on opencode" || bad "plan saved opencode: rc=$rc sessions=$(wc -l < "$T/plan/oc.log" 2>/dev/null || echo 0) out=$(printf '%s' "$out" | tail -2)"
printf 'codex\n' > "$G/.loki/state/provider"
out="$(cd "$G" && env -u LOKI_PROVIDER bun "$LOKI_TS_ENTRY" estimate </dev/null 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && [ "$out" = "$(expect_msg codex)
$(hint codex)" ] && ok "loki estimate with codex saved: exit 2, migration line and hint" || bad "estimate saved codex: rc=$rc out=$(printf '%s' "$out" | head -3)"
printf 'bogus\n' > "$G/.loki/state/provider"
out="$(cd "$G" && env -u LOKI_PROVIDER bash "$ROOT/bin/loki" route start "add a function" </dev/null 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "saved provider 'bogus' in .loki/state/provider" && ok "route: an unknown saved provider says it is the saved one and how to clear it" || bad "route unknown saved: rc=$rc out=$(printf '%s' "$out" | head -3)"
printf 'opencode\n' > "$G/.loki/state/provider"

run_engine nokey PATH="$OCBIN:$FIX/bin:$PATH" E2E_OPENCODE_LOG="$T/nokey/oc.log" -- --provider opencode --model openrouter/deepseek/deepseek-v3.2
[ "$RC" -ne 0 ] && [ ! -s "$T/nokey/oc.log" ] && printf '%s\n' "$OUT" | grep -q 'export OPENROUTER_API_KEY' \
    && ok "opencode openrouter model with no key: refused before any session, names OPENROUTER_API_KEY" \
    || { bad "no-key run: rc=$RC sessions=$(wc -l < "$T/nokey/oc.log" 2>/dev/null || echo 0)"; printf '%s\n' "$OUT" | tail -6 | sed 's/^/    | /'; }

# opencode also takes the OpenRouter key from its config (provider.openrouter, often "{env:NAME}"): a JSONC global config
# with a comment lets the run start with no OPENROUTER_API_KEY.
mkdir -p "$T/cfg/opencode"
printf '{\n  // OpenRouter via config, key from another env var\n  "provider": { "openrouter": { "options": { "apiKey": "{env:MY_OR_KEY}" } } },\n}\n' > "$T/cfg/opencode/opencode.jsonc"
run_engine cfgkey PATH="$OCBIN:$FIX/bin:$PATH" XDG_CONFIG_HOME="$T/cfg" E2E_OPENCODE_LOG="$T/cfgkey/oc.log" -- --provider opencode --model openrouter/deepseek/deepseek-v3.2
[ -s "$T/cfgkey/oc.log" ] && ! printf '%s\n' "$OUT" | grep -q 'needs OpenRouter credentials' \
    && ok "opencode openrouter key in opencode.jsonc (provider.openrouter): the run starts" \
    || { bad "config-file key: refused or no session (rc=$RC)"; printf '%s\n' "$OUT" | tail -6 | sed 's/^/    | /'; }
# Every other source, straight against the preflight check: only "no source at all" refuses; an unreadable config warns.
mkdir -p "$T/src/home" "$T/src/proj" "$T/src/bad"
printf '{"provider":{"openrouter":{}}}' > "$T/src/proj/opencode.json"
printf '{"provider": {"openrouter": ' > "$T/src/bad/opencode.json"
printf '{"provider":{"openrouter":{"options":{"apiKey":"sk-or-SECRETVALUE"}}}}' > "$T/src/explicit.json"
srcs="$(cd "$ROOT/loki-ts" && T="$T" bun -e '
const { providerLoginIssue } = await import("./src/commands/doctor.ts");
const T = process.env.T, base = { HOME: `${T}/src/home`, LOKI_OPENCODE_MODEL: "openrouter/deepseek/deepseek-v3.2" };
const kind = (env, repo) => { const r = providerLoginIssue("opencode", "opencode", { ...base, ...env }, repo); return r?.fatal ? "fatal" : r?.warn ? "warn" : "ok"; };
const all = JSON.stringify([providerLoginIssue("opencode", "opencode", { ...base, OPENCODE_CONFIG: `${T}/src/explicit.json` })]);
console.log([kind({}), kind({ OPENCODE_CONFIG_CONTENT: "{\"provider\":{\"openrouter\":{\"options\":{\"apiKey\":\"sk-or-SECRETVALUE\"}}}}" }),
  kind({ OPENCODE_CONFIG: `${T}/src/explicit.json` }), kind({}, `${T}/src/proj`), kind({}, `${T}/src/bad`),
  kind({ OPENCODE_CONFIG_CONTENT: "{\"provider\":{\"anthropic\":{}}}" }), all.includes("SECRETVALUE") ? "leak" : "noleak"].join(" "));' 2>&1)"
[ "$srcs" = "fatal ok ok ok warn fatal noleak" ] \
    && ok "OpenRouter sources: none refuses; OPENCODE_CONFIG_CONTENT, OPENCODE_CONFIG and project opencode.json pass; an unparseable config warns; no value printed" \
    || bad "OpenRouter sources (none content config project unparseable other-provider leak): $srcs"

# --- toolless: toolLessCall, the one tool-less completion primitive (sdk_invoker.ts) ----------------------------------
# No network: the API route runs on a stub Anthropic client, the subscription route on a stub Agent SDK query().
mkdir -p "$T/tl"
tl="$(cd "$ROOT/loki-ts" && TLDIR="$T/tl" env -u ANTHROPIC_API_KEY -u LOKI_SDK_OAUTH_DEV -u LOKI_E10_MAX_COST_USD -u LOKI_E10_SPENT_USD -u LOKI_E10_RUN_ID bun -e '
import { readFileSync, existsSync } from "node:fs";
import { toolLessCall, __setSdkClientForTests, __resetSdkClientForTests, __setToolLessQueryForTests } from "./src/runner/sdk_invoker.ts";
import { sumChildLedger } from "./src/util/child_ledger.ts";
const D = process.env.TLDIR, lines = (d) => { const f = `${D}/${d}/metrics/child-sessions.jsonl`; return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const out = [], base = { model: "claude-haiku-5-5", system: "sys", prompt: "hi", maxTokens: 300 };
// api route: a stub client records the request body
let bodies = [];
const stub = { baseURL: "https://api.anthropic.com", messages: { create: async (b) => { bodies.push(b); return { content: [{ type: "text", text: "ANS" }], stop_reason: "end_turn", model: "claude-haiku-5-5", usage: { input_tokens: 1000, output_tokens: 100 } }; } }, beta: {} };
process.env.ANTHROPIC_API_KEY = "k"; __setSdkClientForTests(stub);
const a = await toolLessCall({ ...base, thinking: "off", ledger: { lokiDir: `${D}/a`, phase: "tl-a" } });
const b = await toolLessCall({ ...base, thinking: "low", ledger: { lokiDir: `${D}/b`, phase: "tl-b" } });
out.push(`api:off=${JSON.stringify(bodies[0].thinking)}:${bodies[0].max_tokens}:${bodies[0].output_config?.effort ?? "none"}`);
out.push(`api:low=${JSON.stringify(bodies[1].thinking)}:${bodies[1].output_config?.effort}`);
out.push(`api:notools=${bodies.every((x) => x.tools === undefined && x.tool_choice === undefined)}`);
out.push(`api:res=${a.outcome.kind}:${a.outcome.value}:${a.route}`);
const la = lines("a");
out.push(`api:ledger=${la.length}:${la[0]?.phase}:${la[0]?.model}:${la[0]?.input_tokens}:${la[0]?.usd > 0}`);
__resetSdkClientForTests(); delete process.env.ANTHROPIC_API_KEY;
// subscription route: a stub query() records its options and yields a result message
let opts = null, mode = "ok";
__setToolLessQueryForTests(async function* ({ options }) {
  opts = options;
  if (mode === "none") return;
  yield { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "SUB" }] } };
  yield { type: "result", subtype: mode === "budget" ? "error_max_budget_usd" : "success", is_error: false, result: "SUB", total_cost_usd: 0.0003, usage: { input_tokens: 2, output_tokens: 416, cache_read_input_tokens: 0, cache_creation_input_tokens: 720 }, modelUsage: { "claude-haiku-5-5": { thinkingTokens: 387 } } };
});
const c = await toolLessCall({ ...base, thinking: "off", ledger: { lokiDir: `${D}/c`, phase: "tl-c" } });
out.push(`sdk:opts=${JSON.stringify(opts.tools)}:${opts.maxTurns}:${JSON.stringify(opts.thinking)}:${JSON.stringify(opts.settingSources)}:${opts.persistSession}:${opts.systemPrompt}:${opts.model}:${opts.maxBudgetUsd ?? "nocap"}:${opts.title}:${opts.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS}`);
out.push(`sdk:res=${c.outcome.kind}:${c.outcome.value}:${c.route}:${c.usd}:${c.thinkingTokens}`);
const lc = lines("c");
out.push(`sdk:ledger=${lc.length}:${lc[0]?.usd}:${lc[0]?.thinking_tokens}:${lc[0]?.source}:${lc[0]?.outcome}:${lc[0]?.max_tokens}`);
await toolLessCall({ ...base, thinking: "low", ledger: { lokiDir: `${D}/c2`, phase: "tl-c2" } });
out.push(`sdk:low=${JSON.stringify(opts.thinking)}:${opts.effort}`);
mode = "none"; const n = await toolLessCall({ ...base, thinking: "off", ledger: { lokiDir: `${D}/n`, phase: "tl-n" } }); const ln = lines("n");
out.push(`sdk:noresult=${n.outcome.kind}:${ln.length}:${ln[0]?.cost_status}`);
mode = "budget"; const bu = await toolLessCall({ ...base, thinking: "off", ledger: { lokiDir: `${D}/bu`, phase: "tl-bu" } });
out.push(`sdk:budgetstop=${bu.outcome.kind}`);
// run cap: LOKI_E10_MAX_COST_USD counts the seed and this run child ledger; a reached cap sends nothing
mode = "ok"; opts = null;
process.env.LOKI_E10_MAX_COST_USD = "0.01"; process.env.LOKI_E10_RUN_ID = "r1"; process.env.LOKI_E10_SPENT_USD = "0.004";
const k = await toolLessCall({ ...base, thinking: "off", ledger: { lokiDir: `${D}/k`, phase: "tl-k" } });
out.push(`cap:remaining=${opts.maxBudgetUsd.toFixed(4)}:${k.outcome.kind}`);
out.push(`cap:run_id=${lines("k")[0]?.run_id}:${sumChildLedger(`${D}/k`, "r1").partialUsd}`);
process.env.LOKI_E10_SPENT_USD = "0.0098"; opts = null; // 0.0098 seed + 0.0003 already in the ledger >= 0.01
const k2 = await toolLessCall({ ...base, thinking: "off", ledger: { lokiDir: `${D}/k`, phase: "tl-k2" } });
out.push(`cap:reached=${k2.outcome.kind}:${opts === null ? "nosend" : "sent"}:${lines("k").length}`);
__setSdkClientForTests(stub); process.env.ANTHROPIC_API_KEY = "k"; bodies = [];
const k3 = await toolLessCall({ ...base, thinking: "off", ledger: { lokiDir: `${D}/k`, phase: "tl-k3" } });
out.push(`cap:apireached=${k3.outcome.kind}:${bodies.length}`);
// a cap that cannot be metered (no run id) refuses instead of never tripping
delete process.env.ANTHROPIC_API_KEY; __resetSdkClientForTests(); delete process.env.LOKI_E10_RUN_ID; opts = null;
const u = await toolLessCall({ ...base, thinking: "off", ledger: { lokiDir: `${D}/u`, phase: "tl-u" } });
out.push(`cap:unmeterable=${u.outcome.kind}:${opts === null ? "nosend" : "sent"}`);
console.log(out.join("\n"));' 2>&1)"
want_tl='api:off={"type":"disabled"}:300:none
api:low={"type":"adaptive"}:low
api:notools=true
api:res=ok:ANS:api
api:ledger=1:tl-a:claude-haiku-5-5:1000:true
sdk:opts=[]:1:{"type":"disabled"}:[]:false:sys:claude-haiku-5-5:nocap:loki-toolless:300
sdk:res=ok:SUB:agent-sdk:0.0003:387
sdk:ledger=1:0.0003:387:sdk-toolless:ok:300
sdk:low={"type":"adaptive"}:low
sdk:noresult=transport:1:unmeasured
sdk:budgetstop=budget
cap:remaining=0.0060:ok
cap:run_id=r1:0.0003
cap:reached=budget:nosend:1
cap:apireached=budget:0
cap:unmeterable=budget:nosend'
[ "$tl" = "$want_tl" ] && ok "toolLessCall: no tools, thinking off/low on both routes, priced into the child ledger, run cap refuses and bounds" \
    || { bad "toolLessCall legs differ"; diff <(printf '%s\n' "$want_tl") <(printf '%s\n' "$tl") | sed 's/^/    | /'; }

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
