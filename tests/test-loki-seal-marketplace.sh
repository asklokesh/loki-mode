#!/usr/bin/env bash
# D48 row 10: the root marketplace must make loki-seal installable via
# /plugin marketplace add asklokesh/loki-mode + /plugin install loki-seal@loki-mode.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
M="${LOKI_MARKETPLACE_JSON:-$REPO_ROOT/.claude-plugin/marketplace.json}"
python3 - "$M" "$REPO_ROOT" <<'PY'
import json, os, sys
m, root = sys.argv[1], sys.argv[2]
d = json.load(open(m))
t = 0
def ok(c, msg):
    global t
    t += 1
    if not c:
        print("FAIL: " + msg); sys.exit(1)
    print("PASS: " + msg)
ok(d.get("name") == "loki-mode", "marketplace name is loki-mode")
ok(isinstance(d.get("owner"), dict) and d["owner"].get("name"), "owner.name present")
ps = {p.get("name"): p for p in d.get("plugins", [])}
ok("loki-seal" in ps, "plugins[] lists loki-seal")
for n, p in ps.items():
    src = p.get("source")
    ok(isinstance(src, str) and src.startswith("./"), n + " source is a relative path")
    ok(os.path.isfile(os.path.join(root, src, ".claude-plugin", "plugin.json")), n + " source contains .claude-plugin/plugin.json")
ok(ps["loki-seal"]["source"] == "./packages/loki-seal", "loki-seal source is ./packages/loki-seal")
print("%d passed, 0 failed" % t)
PY
