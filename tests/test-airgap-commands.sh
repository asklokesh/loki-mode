#!/usr/bin/env bash
# The read-only evaluation path must work with NO egress.
#
# WHY THIS MATTERS COMMERCIALLY. Verified from vendor docs 2026-07-31: no
# competitor in this category runs disconnected. Devin has the strongest
# enterprise packaging of the four -- single-tenant VPC, AWS PrivateLink,
# customer-managed KMS, a federal docs tree -- and still cannot, because
# "Devin's brain... always resides within Cognition's Cloud." That is a
# structural property of a hosted control plane.
#
# So the evaluate-before-you-buy path running air-gapped is genuinely
# differentiated ground, and it is worth a gate: a future change that quietly
# adds a network call to `doctor`, `plan`, or `assess` would take it away
# without anyone noticing, because on a connected developer machine everything
# would still pass.
#
# HOW EGRESS IS SEVERED: outbound HTTP is forced through an unroutable proxy
# (127.0.0.1:9, the discard port). Any real network attempt fails. This is a
# measurement, not a flag we trust.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

blocked() {
    env http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 \
        HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 \
        no_proxy="" NO_PROXY="" \
        "$@" </dev/null
}

# 1. Core read-only commands must complete without egress. Doctor is a
# readiness gate, so a disconnected host may legitimately exit nonzero while
# still emitting its complete local report.
if blocked "$LOKI" version >/dev/null 2>&1; then
    ok "loki version works with no egress"
else
    bad "loki version FAILED with no egress -- the air-gapped claim is broken"
fi

doctor_json="$(blocked "$LOKI" doctor --json 2>/dev/null)"
doctor_rc=$?
doctor_verdict="$(printf '%s' "$doctor_json" | python3 -c '
import json, sys
try:
    summary = json.load(sys.stdin)["summary"]
    expected = 0 if summary["ok"] else 1
    print("OK" if expected == int(sys.argv[1]) else "BAD_EXIT")
except Exception:
    print("UNPARSEABLE")
' "$doctor_rc" 2>/dev/null)"
case "$doctor_verdict" in
    OK) ok "loki doctor --json emits a truthful local readiness report with no egress" ;;
    BAD_EXIT) bad "loki doctor --json report and exit code disagree with no egress" ;;
    *) bad "loki doctor --json did not emit a complete report with no egress" ;;
esac

# 2. `plan` is the one that matters for evaluation: a buyer estimates cost
#    before spending anything, and that must not require a network call.
cat > "$WORK/spec.md" <<'SPEC'
# Todo App
Build a todo list with add, complete, and delete.
SPEC
if blocked "$LOKI" plan "$WORK/spec.md" --json >/dev/null 2>&1; then
    ok "loki plan works with no egress (cost preview without a network call)"
else
    bad "loki plan FAILED with no egress -- evaluation now requires connectivity"
fi

# 3. `heal --assess` is the brownfield entry point and the strongest
#    air-gapped differentiator: assess a legacy codebase with nothing leaving.
command -v git >/dev/null 2>&1 || { printf 'SKIP: git unavailable for the assess check\n'; }
if command -v git >/dev/null 2>&1; then
    repo="$WORK/legacy"; mkdir -p "$repo"
    ( cd "$repo" && git init -q . && git config user.email t@example.com \
      && git config user.name t && git config commit.gpgsign false ) >/dev/null 2>&1
    printf '{"name":"old","dependencies":{"express":"^4.16.0"}}\n' > "$repo/package.json"
    ( cd "$repo" && git add -A && git commit -qm x ) >/dev/null 2>&1

    assess_out="$( cd "$repo" && blocked "$LOKI" heal . --assess --json 2>/dev/null )"
    verdict="$(printf '%s' "$assess_out" | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
except Exception:
    print("UNPARSEABLE"); raise SystemExit
mr = d.get("maintenance_risk", {})
print("OK:" + str(mr.get("dependency_staleness")))
' 2>/dev/null)"

    case "$verdict" in
        OK:unknown)
            ok "heal --assess works offline AND keeps staleness 'unknown' (never guessed)" ;;
        OK:*)
            bad "staleness became '${verdict#OK:}' with no network -- a fabricated value" ;;
        *)
            bad "heal --assess did not produce parseable JSON with egress severed" ;;
    esac
fi

# 4. The egress inventory must exist and must NAME the required point. A page
#    claiming air-gapped support without disclosing what still needs the network
#    is the overclaim that loses a procurement conversation.
airgap_out="$(blocked "$LOKI" doctor --airgap 2>&1 || true)"
case "$airgap_out" in
    *REQUIRED*)
        ok "doctor --airgap names the REQUIRED egress point" ;;
    *)
        bad "doctor --airgap does not disclose a required egress point" ;;
esac
case "$airgap_out" in
    *inference*|*ANTHROPIC_BASE_URL*)
        ok "the required point is identified as model inference, with the workaround" ;;
    *)
        bad "the egress inventory does not identify model inference" ;;
esac

# 4b. Remote MCP servers (#315): LOKI_MCP_<NAME>_URL is outbound egress. The audit must list
#     it from the same parser the runner uses, never claim a clean air-gap past it, and say
#     how to turn it off. A URL the parser rejects (plain http, not loopback) is not egress.
mcp_out="$(LOKI_MCP_FOO_URL=https://mcp.example.com/path LOKI_MCP_BAD_URL=http://plain.example.com/x blocked "$LOKI" doctor --airgap 2>&1 || true)"
case "$mcp_out" in
    *"remote MCP server foo (LOKI_MCP_FOO_URL) -> mcp.example.com"*)
        ok "doctor --airgap lists the LOKI_MCP_FOO_URL server and its host" ;;
    *)
        bad "doctor --airgap does not list LOKI_MCP_FOO_URL egress" ;;
esac
case "$mcp_out" in
    *"unset LOKI_MCP_FOO_URL"*)
        ok "the MCP row names how to disable it" ;;
    *)
        bad "the MCP row has no disable instruction" ;;
esac
case "$mcp_out" in
    *plain.example.com*)
        bad "a URL the runner rejects (http, non-loopback) was listed as egress" ;;
    *)
        ok "a URL the runner parser rejects is not listed" ;;
esac
mcp_json="$(LOKI_MCP_FOO_URL=https://mcp.example.com/path blocked "$LOKI" doctor --airgap --json 2>/dev/null || true)"
case "$mcp_json" in
    *'"remote MCP server foo (LOKI_MCP_FOO_URL)"'*)
        ok "doctor --airgap --json carries the remote MCP server foo egress entry" ;;
    *)
        bad "doctor --airgap --json omits the remote MCP egress entry" ;;
esac
# A userinfo password in the URL is a secret: the audit shows the host only.
mcp_ui="$(LOKI_MCP_USERINFO_URL=https://svc:SECRETPW@user.example.com/x blocked "$LOKI" doctor --airgap 2>&1 || true)"
mcp_ui_json="$(LOKI_MCP_USERINFO_URL=https://svc:SECRETPW@user.example.com/x blocked "$LOKI" doctor --airgap --json 2>&1 || true)"
case "$mcp_ui" in
    *"userinfo (LOKI_MCP_USERINFO_URL) -> user.example.com"*) ok "the userinfo URL is listed by host" ;;
    *) bad "the userinfo URL was not listed by host" ;;
esac
case "$mcp_ui$mcp_ui_json" in
    *SECRETPW*|*svc:*) bad "the audit leaked URL userinfo (user:password) into its output" ;;
    *) ok "the audit output carries no URL userinfo" ;;
esac
# A backslash splits the host between parsers: the audit must not list evil.example or 127.0.0.1 for it.
mcp_bs="$(LOKI_MCP_BSLASH_URL='http://evil.example\@127.0.0.1/mcp' blocked "$LOKI" doctor --airgap 2>&1 || true)"
case "$mcp_bs" in
    *evil.example*|*"remote MCP server bslash"*) bad "the audit listed a backslash URL the runner refuses" ;;
    *) ok "a backslash URL is refused by the runner and not listed" ;;
esac
# The model-endpoint row goes through the same origin sanitizer: a backslash value must show as unparseable, never as 127.0.0.1.
mcp_model="$(ANTHROPIC_BASE_URL='http://evil.example\@127.0.0.1/x' LOKI_PROVIDER=claude blocked "$LOKI" doctor --airgap 2>&1 || true)"
case "$mcp_model" in
    *"model inference -> (unparseable value, not shown)"*) ok "a backslash model endpoint is shown as unparseable" ;;
    *) bad "a backslash model endpoint was resolved to a host by the audit" ;;
esac
case "$(blocked "$LOKI" doctor --airgap 2>&1 || true)" in
    *"remote MCP server"*)
        bad "the MCP row appeared with no LOKI_MCP_*_URL set" ;;
    *)
        ok "no MCP row when none is declared" ;;
esac

# 5. The doc must state the limit rather than only the win.
doc="$REPO_ROOT/docs/air-gapped.md"
if [ -f "$doc" ] && grep -q "model endpoint is required" "$doc"; then
    ok "docs/air-gapped.md states the model-endpoint limit plainly"
else
    bad "the air-gapped doc omits the required-model limit -- that is the overclaim"
fi

# 6. FC-EGRESS-AUDIT-HAND-LISTED: the audit names every configured outbound host.
# 6a. Each registry name, set to a host, makes the audit name that host. Env is cleared
#     so nothing ambient leaks in; the registry is read from autonomy/loki itself.
registry="$(awk '/^_LOKI_AIRGAP_EGRESS_ENV=\(/{f=1;next} f&&/^\)/{f=0} f{gsub(/^ *"|\|.*$/,"");print}' "$LOKI")"
notegress="$(awk '/^_LOKI_AIRGAP_EGRESS_NOT=\(/{f=1;next} f&&/^\)/{f=0} f{gsub(/^ *"|\|.*$/,"");print}' "$LOKI")"
[ -n "$registry" ] && ok "the egress registry is readable from autonomy/loki ($(printf '%s\n' "$registry" | wc -l | tr -d ' ') names)" || bad "the egress registry is empty or unreadable"
miss=""
for n in $registry; do
    out="$(env -i PATH="$PATH" HOME="$WORK" "$n=https://${n}.example.invalid/secret-path" bash "$LOKI" doctor --airgap 2>&1 || true)"
    case "$out" in *"${n}.example.invalid"*) ;; *) miss="$miss $n" ;; esac
    case "$out" in *secret-path*) miss="$miss $n(leaks-path)" ;; esac
done
[ -z "$miss" ] && ok "every registry name set to a host is named in the audit, host only" || bad "audit does not name:$miss"

# 6b. JSON carries the same rows, and nothing configured means no extra rows with exit 0 or 1 by the model only.
json_out="$(env -i PATH="$PATH" HOME="$WORK" LOKI_WEBHOOK_URL=https://hooks.example.invalid/x bash "$LOKI" doctor --airgap --json 2>/dev/null || true)"
case "$json_out" in *'"host": "hooks.example.invalid"'*) ok "doctor --airgap --json lists the webhook host" ;; *) bad "doctor --airgap --json omits the webhook host" ;; esac
clean_out="$(env -i PATH="$PATH" HOME="$WORK" LOKI_PROVIDER=opencode LOKI_OPENCODE_MODEL=ollama/qwen2.5-coder LOKI_NO_UPDATE_CHECK=1 bash "$LOKI" doctor --airgap 2>&1)"; clean_rc=$?
case "$clean_out" in *"(LOKI_"*"->"*|*"MCP server"*) bad "nothing set, yet the audit names a configured host" ;; *) [ "$clean_rc" -eq 0 ] && ok "positive control: nothing configured reports no configured egress, exit 0" || bad "positive control exit $clean_rc" ;; esac

# 6c. MCP: a url server is named (host only), a stdio server is not.
mkdir -p "$WORK/proj"
printf '%s' '{"mcpServers":{"remote":{"url":"https://mcp.example.invalid/sse?token=abc"},"local":{"command":"python3","args":["-m","x"]}}}' > "$WORK/proj/.mcp.json"
mcp_out="$(cd "$WORK/proj" && env -i PATH="$PATH" HOME="$WORK" bash "$LOKI" doctor --airgap 2>&1 || true)"
case "$mcp_out" in *"MCP server remote"*"mcp.example.invalid"*) ok "an MCP server with a url is named by host" ;; *) bad "an MCP url server is not reported" ;; esac
case "$mcp_out" in *"MCP server local"*|*token=abc*) bad "a stdio MCP server was reported, or a url query leaked" ;; *) ok "a stdio MCP server is not reported and no url query leaks" ;; esac

# 6c2. A server name holding a newline or a tab must not break the audit or forge a row.
mkdir -p "$WORK/proj2"
printf '%s' '{"mcpServers":{"evil\nname":{"url":"https://h.example.invalid/x"},"tab\tname":{"url":"https://t.example.invalid/x"},"fine":{"url":"https://f.example.invalid/x"}}}' > "$WORK/proj2/.mcp.json"
cc_json="$(cd "$WORK/proj2" && env -i PATH="$PATH" HOME="$WORK" bash "$LOKI" doctor --airgap --json 2>/dev/null)"; cc_rc=$?
cc_rows="$(printf '%s' "$cc_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(1 for e in d["egress"] if str(e["name"]).startswith("MCP server")), sorted(e["host"] for e in d["egress"] if str(e["name"]).startswith("MCP server")))' 2>&1)"
[ "$cc_rows" = "3 ['f.example.invalid', 'h.example.invalid', 't.example.invalid']" ] && ok "control characters in an MCP server name: --json is valid, one row per server (rc=$cc_rc)" || bad "control-char MCP names break --json: $cc_rows"
cc_txt="$(cd "$WORK/proj2" && env -i PATH="$PATH" HOME="$WORK" bash "$LOKI" doctor --airgap 2>&1 || true)"
case "$cc_txt" in *"MCP server evil?name"*"h.example.invalid"*"MCP server tab?name"*"t.example.invalid"*) ok "control characters in an MCP server name: text mode keeps one clean row per server" ;; *) bad "control-char MCP names garble the text audit" ;; esac

# 6c3. Unicode line separators (U+0085, U+2028, U+2029) in a name or a url host must not drop rows from --json: text and --json agree.
mkdir -p "$WORK/proj3"
printf '%s' '{"mcpServers":{"evil name":{"url":"https://a.example.invalid/x"},"ok":{"url":"https://b.example.invalid/y"},"ctl\u0085z":{"url":"https://c.example.invalid"},"sep\u2028q":{"url":"https://d.example.invalid"},"par\u2029r":{"url":"https://e.example.invalid"},"hid":{"url":"https://h\u2028x.example.invalid"}}}' > "$WORK/proj3/.mcp.json"
us_json="$(cd "$WORK/proj3" && env -i PATH="$PATH" HOME="$WORK" bash "$LOKI" doctor --airgap --json 2>/dev/null)"
us_n="$(printf '%s' "$us_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(1 for e in d["egress"] if str(e["name"]).startswith("MCP server")))' 2>&1)"
us_txt="$(cd "$WORK/proj3" && env -i PATH="$PATH" HOME="$WORK" bash "$LOKI" doctor --airgap 2>&1 || true)"
us_t="$(printf '%s\n' "$us_txt" | grep -c 'MCP server ')"
us_raw="$(printf '%s' "$us_json" | python3 -c 'import json,re,sys; d=json.load(sys.stdin); print(sum(1 for e in d["egress"] if re.search("[\x85\u2028\u2029]", str(e["name"]) + str(e["host"]))))' 2>&1)"
[ "$us_raw" = "0" ] && ok "no U+0085, U+2028 or U+2029 survives into a --json name or host" || bad "a unicode line separator survives into --json: $us_raw"
[ "$us_n" = "6" ] && [ "$us_t" = "6" ] && ok "unicode line separators in an MCP name or url: --json (6) and text (6) list every server" || bad "unicode separators drop or split MCP rows: json=$us_n text=$us_t (want 6 and 6)"

# 6d. The guard: every LOKI_*_(URL|HOST|ENDPOINT|WEBHOOK) name read under a tree is in the
#     registry or the non-egress list. A fixture copy with a new reader must make it red.
guard_missing() {
    local root="$1" n
    for n in $(cd "$root" && grep -rhoE 'LOKI_[A-Z_]*(URL|HOST|ENDPOINT|WEBHOOK)[A-Z_]*' --exclude='*.md' --exclude-dir=node_modules --exclude-dir=dist autonomy loki-ts/src providers 2>/dev/null | sort -u); do
        printf '%s\n%s\n' "$registry" "$notegress" | grep -qx "$n" || printf '%s ' "$n"
    done
}
unlisted="$(guard_missing "$REPO_ROOT")"
[ -z "$unlisted" ] && ok "guard: every egress-looking env reader is registered or marked non-egress" || bad "guard: unlisted egress-looking names: $unlisted"
mkdir -p "$WORK/fx/autonomy" "$WORK/fx/loki-ts/src"
printf 'const u = process.env.LOKI_FOO_URL;\n' > "$WORK/fx/loki-ts/src/foo.ts"
[ "$(guard_missing "$WORK/fx")" = "LOKI_FOO_URL " ] && ok "guard mutation: a new LOKI_FOO_URL reader in a fixture goes red" || bad "guard mutation: the guard missed a new LOKI_FOO_URL reader"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
