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
    *"remote MCP server"*"foo -> mcp.example.com"*)
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
    *'"mcp_remote:foo"'*)
        ok "doctor --airgap --json carries the mcp_remote:foo egress entry" ;;
    *)
        bad "doctor --airgap --json omits the remote MCP egress entry" ;;
esac
# A userinfo password in the URL is a secret: the audit shows the host only.
mcp_ui="$(LOKI_MCP_USERINFO_URL=https://svc:SECRETPW@user.example.com/x blocked "$LOKI" doctor --airgap 2>&1 || true)"
mcp_ui_json="$(LOKI_MCP_USERINFO_URL=https://svc:SECRETPW@user.example.com/x blocked "$LOKI" doctor --airgap --json 2>&1 || true)"
case "$mcp_ui" in
    *"userinfo -> user.example.com"*) ok "the userinfo URL is listed by host" ;;
    *) bad "the userinfo URL was not listed by host" ;;
esac
case "$mcp_ui$mcp_ui_json" in
    *SECRETPW*|*svc:*) bad "the audit leaked URL userinfo (user:password) into its output" ;;
    *) ok "the audit output carries no URL userinfo" ;;
esac
# A backslash splits the host between parsers: the audit must not list evil.example or 127.0.0.1 for it.
mcp_bs="$(LOKI_MCP_BSLASH_URL='http://evil.example\@127.0.0.1/mcp' blocked "$LOKI" doctor --airgap 2>&1 || true)"
case "$mcp_bs" in
    *evil.example*|*bslash*) bad "the audit listed a backslash URL the runner refuses" ;;
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

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
