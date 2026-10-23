#!/usr/bin/env bash
# Move npm dist-tags latest and next to the highest published version of
# loki-mode, never backwards (FC-DIST-TAG-MOVED-BACKWARDS).
#
# The target is max(published versions, current latest, current next, VERSION),
# so a lagging tag read can never pick a lower version, and a run for an older
# release converges to the highest version instead of its own. Tags are
# re-read after every write; a tag the registry applied late (an overtaken
# write) is re-asserted until both tags settle or the tries run out.
#
# Usage: npm-dist-tags.sh <version>
# Env: LOKI_DISTTAG_PKG (default loki-mode; loki-mode-sdk for the SDK), LOKI_DISTTAG_TRIES (default 8), LOKI_DISTTAG_SLEEP seconds (default 15)
set -uo pipefail

VERSION="${1:-}"
[ -n "$VERSION" ] || { echo "usage: npm-dist-tags.sh <version>" >&2; exit 1; }
PKG="${LOKI_DISTTAG_PKG:-loki-mode}"
TRIES="${LOKI_DISTTAG_TRIES:-8}"
NAP="${LOKI_DISTTAG_SLEEP:-15}"

# Highest stable semver among the arguments (prereleases are ignored).
highest() {
    printf '%s\n' "$@" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n1
}

# Both readers fail (non-zero) on a registry error or an empty answer, so a
# view outage can never look like "nothing is published".
published_versions() {
    local out
    out="$(npm view "$PKG" versions --json --prefer-online 2>/dev/null)" || return 1
    out="$(printf '%s\n' "$out" | tr ',' '\n' | tr -d '[]\" ' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$')" || return 1
    printf '%s\n' "$out"
}

tag_of() {
    local out
    out="$(npm view "$PKG" "dist-tags.$1" --prefer-online 2>/dev/null)" || return 1
    [ -n "$out" ] || return 1
    printf '%s\n' "$out"
}

refuse() {
    echo "::error::$1; refusing to move latest (fail closed). $VERSION stays published under next."
    exit 1
}

i=0
while [ "$i" -lt "$TRIES" ]; do
    i=$((i + 1))
    # Read everything first; any failed or empty read refuses before ANY write.
    LATEST_NOW="$(tag_of latest)" || refuse "cannot read dist-tags.latest"
    NEXT_NOW="$(tag_of next)" || refuse "cannot read dist-tags.next"
    ALL="$(published_versions)" || refuse "cannot read the published versions"
    # shellcheck disable=SC2086 # versions are plain tokens
    TARGET="$(highest "$VERSION" "$LATEST_NOW" "$NEXT_NOW" $ALL)"
    [ -n "$TARGET" ] || { echo "::error::cannot determine the highest version"; exit 1; }
    for tag in latest next; do
        cur="$(tag_of "$tag")"
        if [ "$cur" = "$TARGET" ]; then continue; fi
        if [ "$TARGET" != "$VERSION" ]; then
            echo "SKIP: $VERSION is lower than $TARGET; re-asserting $tag=$TARGET (was '${cur}')"
        fi
        npm dist-tag add "$PKG@$TARGET" "$tag" || echo "dist-tag add $tag failed (try $i)"
    done
    # Re-read after the writes; settled only when both tags read the target.
    if [ "$(tag_of latest)" = "$TARGET" ] && [ "$(tag_of next)" = "$TARGET" ]; then
        # A late-applied lower write can land after this read, so confirm once more.
        sleep "$NAP"
        if [ "$(tag_of latest)" = "$TARGET" ] && [ "$(tag_of next)" = "$TARGET" ]; then
            echo "dist-tags settled: latest=$TARGET next=$TARGET (run version $VERSION)"
            exit 0
        fi
        echo "dist-tags moved after the write; re-asserting"
    else
        sleep "$NAP"
    fi
done
echo "::error::dist-tags did not settle on the highest version after $TRIES tries"
exit 1
