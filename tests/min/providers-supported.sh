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
#   6. autonomy/route.sh: drop the removed-provider check after _route_provider (the saved start legs read the
#      generic "is not supported" refusal).
#   7. loki-ts/src/commands/provider.ts: drop the saved removed-provider check in runProviderShow (saved show leg
#      prints "Provider: codex", exit 0).
#   8. providers/loader.sh: change one word of loki_removed_saved_provider_hint (the byte-identical hint leg fails).
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
