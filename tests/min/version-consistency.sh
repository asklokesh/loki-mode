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
# Reverted afterwards. Second planted defect: SDK_BUNDLED_CLAUDE_CODE back to 2.1.314 with the 0.3.316
# pin; the SDK_BUNDLED_CLAUDE_CODE case must fail. Third: docker/Dockerfile agent SDK back to 0.3.314 with the
# 0.3.318 pin; the Dockerfile case must fail.

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

# The Agent SDK pin: both package.json files name one version, and SDK_BUNDLED_CLAUDE_CODE (advisor probing on the
# SDK route, runner/providers.ts) equals that SDK's claudeCodeVersion, so a bump that forgets the constant fails here.
sdk_root="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["optionalDependencies"]["@anthropic-ai/claude-agent-sdk"])' package.json)"
sdk_ts="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["dependencies"]["@anthropic-ai/claude-agent-sdk"])' loki-ts/package.json)"
[ -n "$sdk_root" ] && [ "$sdk_root" = "$sdk_ts" ] && ok "both package.json files pin claude-agent-sdk $sdk_root" || bad "claude-agent-sdk pins differ: package.json $sdk_root, loki-ts/package.json $sdk_ts"
sdk_meta="loki-ts/node_modules/@anthropic-ai/claude-agent-sdk/package.json"
if [ -f "$sdk_meta" ]; then
    sdk_inst="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["version"], d["claudeCodeVersion"])' "$sdk_meta")"
    bundled="$(sed -n 's/^export const SDK_BUNDLED_CLAUDE_CODE = "\(.*\)";$/\1/p' loki-ts/src/runner/providers.ts)"
    [ "$sdk_inst" = "$sdk_ts $bundled" ] && ok "SDK_BUNDLED_CLAUDE_CODE $bundled matches the installed SDK $sdk_ts" || bad "installed SDK (version, claudeCodeVersion) is '$sdk_inst', want '$sdk_ts $bundled' (pin or SDK_BUNDLED_CLAUDE_CODE stale; run bun install --cwd loki-ts)"
else
    bad "$sdk_meta is missing (run bun install --cwd loki-ts --frozen-lockfile)"
fi
# Every other pin site of the two npm SDKs names the loki-ts/package.json version: the image install line
# (docker/Dockerfile, which pinned 0.3.314 / 1.3.0 while package.json moved on) and both lockfiles.
sdk_api="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["dependencies"]["@anthropic-ai/sdk"])' loki-ts/package.json)"
expect docker/Dockerfile "@anthropic-ai/claude-agent-sdk@$sdk_ts " 1
expect docker/Dockerfile "@anthropic-ai/sdk@$sdk_api " 1
expect loki-ts/bun.lock "\"@anthropic-ai/claude-agent-sdk@$sdk_ts\"" 1
expect loki-ts/bun.lock "\"@anthropic-ai/sdk@$sdk_api\"" 1
lock_pair="$(python3 -c 'import json,sys; p=json.load(open(sys.argv[1]))["packages"]; print(p["node_modules/@anthropic-ai/claude-agent-sdk"]["version"], p["node_modules/@anthropic-ai/sdk"]["version"])' package-lock.json)"
[ "$lock_pair" = "$sdk_ts $sdk_api" ] && ok "package-lock.json resolves claude-agent-sdk $sdk_ts and sdk $sdk_api" || bad "package-lock.json resolves '$lock_pair', want '$sdk_ts $sdk_api'"

# The freshness guard (scripts/dep-inventory.py --sdk-freshness, run daily by sdk-freshness.yml) is offline-testable:
# its self-test covers the grace, the dist-tag latest bound and the bundled Claude Code pin.
python3 scripts/dep-inventory.py --self-test >"$T/di.out" 2>&1 && ok "scripts/dep-inventory.py --self-test" || bad "scripts/dep-inventory.py --self-test: $(grep -E 'FAIL' "$T/di.out" | head -3 | tr '\n' ' ')"

bash tests/test-server-json-current.sh >"$T/sj.out" 2>&1 && ok "tests/test-server-json-current.sh" || bad "tests/test-server-json-current.sh: $(tail -3 "$T/sj.out" | tr '\n' ' ')"
bash tests/test-plugin-json-current.sh >"$T/pj.out" 2>&1 && ok "tests/test-plugin-json-current.sh" || bad "tests/test-plugin-json-current.sh: $(tail -3 "$T/pj.out" | tr '\n' ' ')"

finish
