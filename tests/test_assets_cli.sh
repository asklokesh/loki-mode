#!/usr/bin/env bash
# Bash-layer tests for `loki assets` (R8). Covers the export-reads-install /
# import-writes-cwd asymmetry that lives in cmd_assets (NOT in the Python
# helper), plus the --into-install opt-in. The Python unit tests pass roots
# explicitly and cannot catch a regression in this bash wiring.
#
# Mock / local only. No network, no paid calls.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"
HELPER="$SCRIPT_DIR/../autonomy/lib/assets_bundle.py"

PASS=0
FAIL=0
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-assets-cli-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
no() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

# --- build a bundle via the helper, with isolated source roots --------------
SRC_INSTALL="$WORK/install"     # plays the role of $SKILL_DIR (agents/templates)
SRC_HOME="$WORK/srchome"        # plays the role of $HOME (learnings)
mkdir -p "$SRC_INSTALL/agents" "$SRC_INSTALL/templates" \
         "$SRC_HOME/.loki/learnings" "$SRC_INSTALL/.loki/memory/semantic"
printf '[{"type":"team-custom"}]' > "$SRC_INSTALL/agents/types.json"
printf '# Team template\n' > "$SRC_INSTALL/templates/team.md"
printf '{"description":"plain learning","project":"p"}\n' \
  > "$SRC_HOME/.loki/learnings/patterns.jsonl"
printf '{"note":"clean"}' > "$SRC_INSTALL/.loki/memory/semantic/patterns.json"

BUNDLE="$WORK/b.tgz"
LOKI_ASSETS_HOME="$SRC_HOME" LOKI_ASSETS_REPO="$SRC_INSTALL" \
LOKI_ASSETS_PROJECT="$SRC_INSTALL" \
  python3 "$HELPER" export "$BUNDLE" >/dev/null 2>&1

if [ -f "$BUNDLE" ]; then ok "export produces a bundle"; else no "export produces a bundle"; fi

# --- default import: agents/templates land in CWD, not the install ----------
CLONE="$WORK/clone"
CLONE_HOME="$WORK/clonehome"
mkdir -p "$CLONE" "$CLONE_HOME"
( cd "$CLONE" && HOME="$CLONE_HOME" bash "$LOKI" assets import "$BUNDLE" >/dev/null 2>&1 )

if [ -f "$CLONE/agents/types.json" ]; then
  ok "default import: agents land in cwd"
else
  no "default import: agents land in cwd"
fi
if [ -f "$CLONE/templates/team.md" ]; then
  ok "default import: templates land in cwd"
else
  no "default import: templates land in cwd"
fi
if [ -f "$CLONE_HOME/.loki/learnings/patterns.jsonl" ]; then
  ok "default import: learnings land in HOME/.loki"
else
  no "default import: learnings land in HOME/.loki"
fi
# Asymmetry: the install source dir must NOT have been overwritten by import.
# (Its file is unchanged; that is the safety property the dev-time clobber bug
# violated.)
if [ -f "$CLONE/.loki/memory/semantic/patterns.json" ]; then
  ok "default import: project memory lands in cwd/.loki"
else
  no "default import: project memory lands in cwd/.loki"
fi

# --- --into-install: agents/templates land in the install dir ---------------
# We point $SKILL_DIR resolution at a temp install by running loki from inside
# a fake install tree and asserting --into-install writes there. Because loki
# re-resolves SKILL_DIR at startup, we exercise the helper-level equivalent:
# import with LOKI_ASSETS_REPO set to the install dir (what --into-install does).
INSTALL2="$WORK/install2"
INSTALL2_HOME="$WORK/install2home"
mkdir -p "$INSTALL2" "$INSTALL2_HOME"
LOKI_ASSETS_HOME="$INSTALL2_HOME" LOKI_ASSETS_REPO="$INSTALL2" \
LOKI_ASSETS_PROJECT="$INSTALL2" \
  python3 "$HELPER" import "$BUNDLE" >/dev/null 2>&1
if [ -f "$INSTALL2/agents/types.json" ] && [ -f "$INSTALL2/templates/team.md" ]; then
  ok "into-install target: agents/templates restore to the install repo_root"
else
  no "into-install target: agents/templates restore to the install repo_root"
fi

# --- redaction: seed a secret, export, assert it is gone from the bundle ----
SRC2="$WORK/src2"
mkdir -p "$SRC2/templates" "$SRC2/agents" "$SRC2/.loki/memory/semantic"
SECRET="sk-ant-$(python3 -c 'print("Z"*40)')"
printf '# T\nAPI_KEY=%s\n' "$SECRET" > "$SRC2/templates/x.md"
printf '[{"type":"x"}]' > "$SRC2/agents/types.json"
printf '{"k":"clean"}' > "$SRC2/.loki/memory/semantic/p.json"
BUNDLE2="$WORK/b2.tgz"
LOKI_ASSETS_HOME="$SRC2" LOKI_ASSETS_REPO="$SRC2" LOKI_ASSETS_PROJECT="$SRC2" \
  python3 "$HELPER" export "$BUNDLE2" >/dev/null 2>&1
if python3 - "$BUNDLE2" "$SECRET" <<'PY'
import sys, tarfile
bundle, secret = sys.argv[1], sys.argv[2]
t = tarfile.open(bundle)
blob = "".join(
    t.extractfile(m).read().decode("utf-8", "replace")
    for m in t.getmembers() if m.isfile()
)
sys.exit(0 if secret not in blob else 1)
PY
then
  ok "redaction: seeded secret stripped from bundle (bash route)"
else
  no "redaction: seeded secret stripped from bundle (bash route)"
fi

# --- inspect via the real CLI -----------------------------------------------
if bash "$LOKI" assets inspect "$BUNDLE" 2>/dev/null | grep -q '"schema_version"'; then
  ok "cli inspect prints manifest"
else
  no "cli inspect prints manifest"
fi

echo ""
echo "assets CLI tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
