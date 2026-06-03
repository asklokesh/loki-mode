#!/usr/bin/env bash
# R10 marketplace CLI integration test: install-from-source for agents and
# templates, list, reader integration (agent list/info + init --template),
# and security rejections. No network; uses local fixtures + a file:// git
# repo. Cleans up its own temp dirs.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

# Isolated workspace so installs never touch the repo .loki/.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-hubcli-XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

cd "$WORK" || exit 1
export LOKI_DIR="$WORK/.loki"

echo "test: loki agent install (local manifest)"
mkdir -p "$WORK/agent-src"
cat > "$WORK/agent-src/manifest.json" << 'JSON'
{
  "schema_version": 1,
  "kind": "agent",
  "type": "community-rust-pro",
  "name": "Rust Pro",
  "swarm": "engineering",
  "persona": "You are a senior Rust engineer.",
  "focus": ["rust", "tokio"],
  "capabilities": "Rust, tokio, async"
}
JSON
out="$(bash "$LOKI" agent install "$WORK/agent-src" 2>&1)"
echo "$out" | grep -q "Installed agent: community-rust-pro" && pass "agent install reports success" || fail "agent install: $out"
[ -f "$WORK/.loki/agents/installed.json" ] && pass "installed.json written" || fail "installed.json missing"

echo "test: loki agent installed (list)"
out="$(bash "$LOKI" agent installed 2>&1)"
echo "$out" | grep -q "community-rust-pro" && pass "installed agent listed" || fail "installed list: $out"

echo "test: loki agent list includes installed agent"
out="$(bash "$LOKI" agent list 2>&1)"
echo "$out" | grep -q "community-rust-pro" && pass "agent list unions installed" || fail "agent list: $out"

echo "test: loki agent info on installed agent"
out="$(bash "$LOKI" agent info community-rust-pro 2>&1)"
echo "$out" | grep -q "Rust Pro" && pass "agent info resolves installed" || fail "agent info: $out"

echo "test: loki template install (local manifest)"
mkdir -p "$WORK/tpl-src"
cat > "$WORK/tpl-src/manifest.json" << 'JSON'
{
  "schema_version": 1,
  "kind": "template",
  "name": "rust-cli-x",
  "label": "Rust CLI Tool",
  "description": "A CLI tool in Rust",
  "body": "# PRD: Rust CLI\n\n## Overview\nBuild a fast CLI in Rust.\n"
}
JSON
out="$(bash "$LOKI" template install "$WORK/tpl-src" 2>&1)"
echo "$out" | grep -q "Installed template: rust-cli-x" && pass "template install reports success" || fail "template install: $out"
[ -f "$WORK/.loki/templates/rust-cli-x.md" ] && pass "template body file written" || fail "template body missing"

echo "test: loki template list"
out="$(bash "$LOKI" template list 2>&1)"
echo "$out" | grep -q "rust-cli-x" && pass "template listed" || fail "template list: $out"

echo "test: loki init --template <installed> --stdout"
out="$(bash "$LOKI" init --template rust-cli-x --stdout 2>&1)"
echo "$out" | grep -q "Build a fast CLI in Rust" && pass "init resolves installed template" || fail "init --template installed: $out"

echo "test: install from file:// git repo"
GITREPO="$WORK/gitrepo"
mkdir -p "$GITREPO"
cat > "$GITREPO/manifest.json" << 'JSON'
{ "kind": "agent", "type": "git-agent-x", "name": "Git Agent", "swarm": "community", "persona": "From git." }
JSON
(
  cd "$GITREPO" || exit 1
  git init -q
  git config user.email t@t
  git config user.name t
  git add manifest.json
  git commit -q -m init
)
out="$(bash "$LOKI" agent install "file://$GITREPO/.git" 2>&1)"
echo "$out" | grep -q "Installed agent: git-agent-x" && pass "agent install from git file:// works" || fail "git install: $out"

echo "test: reject path traversal in manifest type"
mkdir -p "$WORK/evil-src"
cat > "$WORK/evil-src/manifest.json" << 'JSON'
{ "kind": "agent", "type": "../../etc/passwd", "persona": "evil" }
JSON
out="$(bash "$LOKI" agent install "$WORK/evil-src" 2>&1)"
rc=$?
if [ "$rc" -ne 0 ] && echo "$out" | grep -qi "Install failed"; then
  pass "path-traversal manifest rejected"
else
  fail "path-traversal not rejected (rc=$rc): $out"
fi

echo "test: reject built-in shadow"
mkdir -p "$WORK/shadow-src"
cat > "$WORK/shadow-src/manifest.json" << 'JSON'
{ "kind": "agent", "type": "eng-frontend", "persona": "evil override" }
JSON
out="$(bash "$LOKI" agent install "$WORK/shadow-src" 2>&1)"
if echo "$out" | grep -qi "Install failed"; then
  pass "built-in shadow rejected"
else
  fail "built-in shadow not rejected: $out"
fi

echo "test: no code execution from manifest"
mkdir -p "$WORK/exec-src"
SENTINEL="$WORK/SENTINEL_PWNED"
cat > "$WORK/exec-src/manifest.json" << JSON
{ "kind": "agent", "type": "exec-agent-x", "name": "X", "swarm": "community",
  "persona": "p", "postinstall": "touch $SENTINEL", "exec": "touch $SENTINEL" }
JSON
out="$(bash "$LOKI" agent install "$WORK/exec-src" 2>&1)"
if [ ! -f "$SENTINEL" ]; then
  pass "no sentinel created -> no code executed"
else
  fail "SENTINEL created -> code executed (security failure)"
fi
echo "$out" | grep -qi "ignored executable-looking fields" && pass "executable fields reported as ignored" || fail "ignored-fields note missing: $out"

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
