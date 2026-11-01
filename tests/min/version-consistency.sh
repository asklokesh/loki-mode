#!/usr/bin/env bash
# Every file that advertises the release version agrees with VERSION: package.json,
# server.json (MCP registry, two places), the Claude plugin manifest, SKILL.md header
# and footer, both Dockerfiles, the dashboard and MCP package versions, the Helm
# charts, and the committed Bun bundle (embedded at build time). Also runs the two
# manifest freshness checks release.yml already calls.
#
# Planted defect used to prove this test can fail: set "version" in server.json to
# the previous release (the drift that left the MCP registry stale for 30 releases);
# the server.json case and tests/test-server-json-current.sh must both fail.
# Reverted afterwards.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT" || exit 2

echo "TEST: version consistency ($VERSION_NOW)"

[ -n "$VERSION_NOW" ] && ok "VERSION is $VERSION_NOW" || bad "VERSION is empty"

# expect <file> <fixed text> <min count>
expect() {
    local f="$1" text="$2" want="$3" n
    [ -f "$f" ] || { bad "$f is missing"; return; }
    n="$(grep -cF -- "$text" "$f")"
    [ "$n" -ge "$want" ] && ok "$f carries $text" || bad "$f does not carry $text (found $n line(s), want $want)"
}

expect package.json "\"version\": \"$VERSION_NOW\"" 1
expect server.json "\"version\": \"$VERSION_NOW\"" 2
expect plugins/loki-mode/.claude-plugin/plugin.json "\"version\": \"$VERSION_NOW\"" 1
expect SKILL.md "# Loki Mode v$VERSION_NOW" 1
expect SKILL.md "**v$VERSION_NOW |" 1
expect docker/Dockerfile "LABEL version=\"$VERSION_NOW\"" 1
expect docker/Dockerfile "org.opencontainers.image.version=\"$VERSION_NOW\"" 1
expect docker/Dockerfile.sandbox "LABEL version=\"$VERSION_NOW\"" 1
expect dashboard/__init__.py "__version__ = \"$VERSION_NOW\"" 1
expect mcp/__init__.py "__version__ = '$VERSION_NOW'" 1
for c in helm/loki-mode/Chart.yaml deploy/helm/autonomi/Chart.yaml deploy/helm/control-plane/Chart.yaml; do
    [ -f "$c" ] && expect "$c" "appVersion: \"$VERSION_NOW\"" 1
done

n="$(grep -c -F "\"$VERSION_NOW\"" loki-ts/dist/loki.js)"
[ "$n" -ge 1 ] && ok "loki-ts/dist/loki.js embeds $VERSION_NOW" || bad "loki-ts/dist/loki.js does not embed $VERSION_NOW (stale bundle)"

bash tests/test-server-json-current.sh >"$T/sj.out" 2>&1 && ok "tests/test-server-json-current.sh" || bad "tests/test-server-json-current.sh: $(tail -3 "$T/sj.out" | tr '\n' ' ')"
bash tests/test-plugin-json-current.sh >"$T/pj.out" 2>&1 && ok "tests/test-plugin-json-current.sh" || bad "tests/test-plugin-json-current.sh: $(tail -3 "$T/pj.out" | tr '\n' ' ')"

finish
