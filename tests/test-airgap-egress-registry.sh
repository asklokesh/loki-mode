#!/usr/bin/env bash
# doctor --airgap derives its optional-egress rows from one declared registry
# (loki-ts/data/egress-registry.json), and a scan guard keeps the registry
# complete. FC-AIRGAP-AUDIT-HAND-LIST-MISSES-ENV-DECLARED-EGRESS.
#
# New file: no existing airgap test owns registry derivation or the reader scan.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
REGISTRY="$REPO_ROOT/loki-ts/data/egress-registry.json"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

audit_json() {  # env assignments... -> audit JSON on stdout
    env -u OLLAMA_HOST -u OPENAI_BASE_URL -u OPENROUTER_API_KEY \
        LOKI_PROVIDER=opencode LOKI_OPENCODE_MODEL=ollama/qwen2.5-coder \
        LOKI_DIR="$WORK/.loki" "$@" "$LOKI" doctor --airgap --json 2>/dev/null
}

names_for() {  # <json> -> "name:host:enabled" lines of the egress array
    printf '%s' "$1" | python3 -c '
import json, sys
for e in json.load(sys.stdin)["egress"]:
    print("%s|%s|%s|%s" % (e["name"], e.get("host"), e.get("enabled"), bool(e.get("disable"))))
' 2>/dev/null
}

# 1. Two env-declared hosts must both be named, with a disable hint.
out="$(audit_json LOKI_MIROFISH_URL=https://mirofish.example.com LOKI_WEBHOOK_URL=https://hooks.example.com/x)"
rows="$(names_for "$out")"
case "$rows" in *"mirofish_market_validation|https://mirofish.example.com|True|True"*) ok "audit names LOKI_MIROFISH_URL with its host and a disable hint" ;; *) bad "audit missed LOKI_MIROFISH_URL: $rows" ;; esac
case "$rows" in *"webhook_notifications|https://hooks.example.com|True|True"*) ok "audit names LOKI_WEBHOOK_URL by scheme and host with the path stripped and a disable hint" ;; *) bad "audit missed LOKI_WEBHOOK_URL: $rows" ;; esac
case "$rows" in *"linear_writeback|https://api.linear.app/graphql|False|True"*) ok "unset variable is listed as not enabled with its default host" ;; *) bad "unset Linear row missing or wrong: $rows" ;; esac

# 2. Every declared registry row (except the telemetry rows shown by their own
# row) reaches the audit, and every row carries a disable hint.
missing="$(printf '%s' "$out" | REG="$REGISTRY" python3 -c '
import json, os, sys
reg = json.load(open(os.environ["REG"]))
got = {e["name"] for e in json.load(sys.stdin)["egress"]}
print(" ".join(sorted({d["name"] for d in reg["declared"]} - got - {"telemetry"})))
')"
[ -z "$missing" ] && ok "every declared registry row appears in the audit" || bad "declared rows absent from the audit: $missing"

# 3. LOKI_EGRESS_REGISTRY can only ADD rows: a registry that drops the Mirofish row must not
# drop it from the audit (an environment value must never be able to empty the audit), and a
# row it adds must appear.
python3 - "$REGISTRY" "$WORK/mut.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
r["declared"] = [d for d in r["declared"] if d["var"] != "LOKI_MIROFISH_URL"]
r["declared"].append({"name": "extra_row", "var": "LOKI_EXTRA_ROW_URL", "reader": "x", "disable": "unset LOKI_EXTRA_ROW_URL", "note": "added by a downstream registry"})
json.dump(r, open(sys.argv[2], "w"))
PY
mut_rows="$(names_for "$(audit_json LOKI_EGRESS_REGISTRY="$WORK/mut.json" LOKI_MIROFISH_URL=https://mirofish.example.com LOKI_EXTRA_ROW_URL=https://extra.example.com/p)")"
case "$mut_rows" in *mirofish_market_validation*) ok "a shrunken override registry cannot drop a shipped row from the audit" ;; *) bad "override registry removed the Mirofish row: $mut_rows" ;; esac
case "$mut_rows" in *"extra_row|https://extra.example.com|True|True"*) ok "an override registry adds its own row" ;; *) bad "override registry row not added: $mut_rows" ;; esac

# 3b. Only scheme://host[:port] is printed for every URL variable, in text and JSON: a webhook
# token in the path and userinfo credentials never reach the output.
secret_env=(LOKI_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T0000/B0000/XXXXSECRETXXXX
            LOKI_JIRA_URL=https://bot:hunter2pass@hooks.example.com:8443/x?token=QQQQ#frag
            ANTHROPIC_BASE_URL=https://svc:gwpass99@gw.example.com/v1/KEYPATH LOKI_POSTHOG_HOST=https://ph:phpass77@ph.example.com/i
            LOKI_WEBHOOK_URL='https://evil.example\@127.0.0.1/p')
sj="$(audit_json "${secret_env[@]}" LOKI_PROVIDER=claude)"
st="$(env -u OLLAMA_HOST "${secret_env[@]}" LOKI_PROVIDER=claude LOKI_DIR="$WORK/.loki" "$LOKI" doctor --airgap 2>&1)"
for needle in XXXXSECRETXXXX hunter2pass bot: QQQQ frag gwpass99 KEYPATH phpass77 'services/T0000'; do
    case "$sj$st" in *"$needle"*) bad "airgap output leaked '$needle'" ;; *) ok "airgap text and JSON omit '$needle'" ;; esac
done
sr="$(names_for "$sj")"
case "$sr" in *"slack_webhook|https://hooks.slack.com|"*|*"|https://hooks.slack.com|True|"*) ok "the Slack webhook is listed as scheme://host only" ;; *) bad "slack row not scheme://host: $sr" ;; esac
case "$sr" in *"|https://hooks.example.com:8443|True|"*) ok "userinfo, path, query and fragment are stripped, the port kept" ;; *) bad "jira row not scheme://host:port: $sr" ;; esac
case "$sj$st" in *evil.example*) bad "a backslash URL was shown with a host the client may not connect to" ;; *) ok "a backslash URL is not shown" ;; esac

# 4. A missing registry must fail loudly, never report a clean audit.
audit_json LOKI_EGRESS_REGISTRY="$WORK/does-not-exist.json" >"$WORK/miss.out"
rc=$?
if [ "$rc" -ne 0 ] && ! grep -q airgap_ready "$WORK/miss.out"; then ok "missing registry fails the audit instead of reporting ready"; else bad "missing registry produced rc=$rc out=$(cat "$WORK/miss.out")"; fi

# 5. Reader scan guard: every LOKI_*_URL / _HOST / _ENDPOINT reader in
# autonomy, loki-ts/src and dashboard is declared or on the not-egress list,
# and every declared variable is still read in its named reader file.
scan="$(cd "$REPO_ROOT" && REG="$REGISTRY" python3 - <<'PY'
import json, os, re, subprocess
reg = json.load(open(os.environ["REG"]))
known = {d["var"] for d in reg["declared"]} | {n["var"] for n in reg["not_egress"]}
pat = re.compile(r"(?<![A-Za-z0-9_])LOKI_[A-Z0-9_]*_(?:URL|HOST|ENDPOINT)\b")
files = subprocess.run(["git", "ls-files", "autonomy", "loki-ts/src", "dashboard"], capture_output=True, text=True).stdout.split()
skip = ("dashboard/static/", "dashboard/frontend/", ".md", ".lock")
found = {}
for f in files:
    if any(s in f for s in skip) or not os.path.isfile(f):
        continue
    try:
        text = open(f, encoding="utf-8").read()
    except Exception:
        continue
    for m in pat.finditer(text):
        found.setdefault(m.group(0), f)
for v, f in sorted(found.items()):
    if v not in known:
        print("UNDECLARED %s (read in %s)" % (v, f))
for d in reg["declared"]:
    if d["var"] not in open(d["reader"], encoding="utf-8").read():
        print("STALE %s (not found in %s)" % (d["var"], d["reader"]))
for n in reg["not_egress"]:
    if not n.get("reason"):
        print("NOREASON %s" % n["var"])
PY
)"
[ -z "$scan" ] && ok "every env-declared URL/HOST/ENDPOINT reader is in the registry or the not-egress list" || bad "registry scan: $scan"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
