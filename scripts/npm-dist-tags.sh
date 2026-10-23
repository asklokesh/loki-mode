#!/usr/bin/env bash
# Move npm dist-tags latest and next to the highest published version of
# loki-mode, re-reading instead of writing when a tag is already higher
# (FC-DIST-TAG-MOVED-BACKWARDS). npm has no compare-and-set, so a window of
# milliseconds between the last read and a write remains.
#
# The target is max(published versions, current latest, current next, VERSION),
# so a lagging tag read can never pick a lower version, and a run for an older
# release converges to the highest version instead of its own. Tags are
# re-read after every write. Each tag is written once; a write still unapplied
# at half the read window (SETTLE_S/2) is treated as lost and rewritten once,
# loudly (DISTTAG-WRITE-NOT-APPLIED). Both tags must read the target or the
# window ends (fatal at LAG_FATAL=1).
#
# Tags are read with `npm dist-tag ls` (the uncached dist-tags endpoint), never
# from the packument: the packument is a CDN-cached document that kept the
# previous tags for minutes after the writes were applied
# (FC-DISTTAG-SETTLE-READS-CACHED-PACKUMENT). The run's own version is read from
# its version document (an uncached GET of registry/pkg/version; `npm view
# pkg@version` reads the cached packument and is not that document), and no tag
# is written until that document returns 200.
#
# Two callers (FC-DISTTAG-SETTLE-READS-CACHED-PACKUMENT). publish-npm holds the
# release-npm lock, so it runs LOKI_DISTTAG_LAG_FATAL=0 with a short window: one
# write per tag, a rejected write fails, a tag that has not applied yet is a named
# ::warning:: and exit 0. verify-npm-registry runs outside the lock with the
# default LAG_FATAL=1: the long read window, the single rewrite, exit 1 if unsettled.
#
# Usage: npm-dist-tags.sh <version>
# Env: LOKI_DISTTAG_PKG (default loki-mode; loki-mode-sdk for the SDK), LOKI_DISTTAG_SETTLE_S (read window, default 840),
#   LOKI_DISTTAG_TRIES (default SETTLE_S / SLEEP + 1), LOKI_DISTTAG_SLEEP seconds (default 15), LOKI_DISTTAG_MATERIALIZE_S wait for the version document (default 420),
#   LOKI_DISTTAG_LAG_FATAL (default 1; 0 = warn and exit 0 on lag, one write per tag, rejected write still fails)
set -uo pipefail

VERSION="${1:-}"
[ -n "$VERSION" ] || { echo "usage: npm-dist-tags.sh <version>" >&2; exit 1; }
PKG="${LOKI_DISTTAG_PKG:-loki-mode}"
SETTLE_S="${LOKI_DISTTAG_SETTLE_S:-840}"
NAP="${LOKI_DISTTAG_SLEEP:-15}"
TRIES="${LOKI_DISTTAG_TRIES:-$((SETTLE_S / (NAP > 0 ? NAP : 1) + 1))}"
MATERIALIZE_S="${LOKI_DISTTAG_MATERIALIZE_S:-420}"
LAG_FATAL="${LOKI_DISTTAG_LAG_FATAL:-1}"
REGISTRY="${LOKI_DISTTAG_REGISTRY:-https://registry.npmjs.org}"

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
    out="$(npm dist-tag ls "$PKG" 2>/dev/null | awk -F': ' -v t="$1" '$1 == t { print $2 }')" || return 1
    [ -n "$out" ] || return 1
    printf '%s\n' "$out"
}

refuse() {
    echo "::error::$1; refusing to move latest (fail closed). $VERSION stays published under next."
    exit 1
}

# Never write a tag for a version the registry has not materialized. A failed or
# empty read waits, bounded by MATERIALIZE_S, then refuses with zero writes.
version_materialized() {
    [ "$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' -H 'Cache-Control: no-cache' "$REGISTRY/$PKG/$VERSION" 2>/dev/null)" = 200 ]
}
materialize_deadline=$((SECONDS + MATERIALIZE_S))
until version_materialized; do
    if [ "$SECONDS" -ge "$materialize_deadline" ]; then
        if [ "$LAG_FATAL" = 0 ]; then
            echo "::warning::DISTTAG-VERSION-NOT-MATERIALIZED: $PKG@$VERSION has no version document after ${MATERIALIZE_S}s; wrote no tag (fail closed), verify-npm-registry converges it."
            exit 0
        fi
        echo "::error::$PKG@$VERSION has no version document after ${MATERIALIZE_S}s; refusing to write any tag (fail closed)."
        exit 1
    fi
    echo "waiting for the registry to materialize $PKG@$VERSION"
    sleep "$NAP"
done

# Each tag write applies on its own with a lag of minutes (measured 2026-10-23: next
# read 11.60.8 while latest still read 11.60.7, nine minutes after both writes were
# accepted). A tag is therefore written once, then only read until it moves; it is
# written again only when it changed to something other than the value read just
# before our write (an overtaking write), or when the write itself was rejected.
# The window is bounded by TRIES (default SETTLE_S / NAP); a tag still below the
# target after it exits non-zero.
W_next=""
W_latest=""
F_next=""
F_latest=""
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
    # next first: it is the tag users on @next read, and a run that dies between the
    # two writes must leave next at the new version, never behind latest.
    for tag in next latest; do
        cur="$(tag_of "$tag")"
        if [ "$cur" = "$TARGET" ]; then continue; fi
        # A fresh read above the target means another run moved the tag since the
        # first reads; never write below it, re-read everything instead.
        if [ -z "$cur" ] || [ "$(highest "$TARGET" "$cur")" != "$TARGET" ]; then
            echo "$tag is '${cur}', not at or below $TARGET; re-reading"
            sleep "$NAP"
            continue 2
        fi
        case "$tag" in next) prev="$W_next" ;; *) prev="$W_latest" ;; esac
        case "$tag" in next) forced="$F_next" ;; *) forced="$F_latest" ;; esac
        if [ "$LAG_FATAL" = 0 ] && [ -n "$prev" ]; then
            # Lock-holding caller: one write per tag; never write again, only read.
            echo "waiting: $tag still '${cur}' after an accepted write of $TARGET"
            continue
        fi
        if [ -n "$prev" ] && [ "$cur" = "$prev" ]; then
            # Late in the window an accepted write that still has not applied is treated as
            # lost (11.60.8: latest never applied and later read 11.60.9): rewrite it once,
            # loudly. A tag that still does not apply fails the job after the window.
            if [ "$i" -lt $((TRIES / 2)) ] || [ -n "$forced" ]; then
                echo "waiting: $tag still '${cur}' after an accepted write of $TARGET"
                continue
            fi
            echo "::warning::DISTTAG-WRITE-NOT-APPLIED: $tag still '${cur}' after $i reads; re-writing $TARGET once"
            case "$tag" in next) F_next=1 ;; *) F_latest=1 ;; esac
        fi
        if [ "$TARGET" != "$VERSION" ]; then
            echo "SKIP: $VERSION is lower than $TARGET; re-asserting $tag=$TARGET (was '${cur}')"
        fi
        if npm dist-tag add "$PKG@$TARGET" "$tag"; then
            case "$tag" in next) W_next="$cur" ;; *) W_latest="$cur" ;; esac
        else
            echo "dist-tag add $tag failed (try $i)"
            if [ "$LAG_FATAL" = 0 ]; then
                echo "::error::dist-tag add $PKG@$TARGET $tag was rejected"
                exit 1
            fi
        fi
    done
    # Settled only when both tags read the target.
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
if [ "$LAG_FATAL" = 0 ]; then
    echo "::warning::DISTTAG-NOT-SETTLED-YET: latest='$(tag_of latest)' next='$(tag_of next)' after $TRIES reads (about ${SETTLE_S}s plus call time); verify-npm-registry keeps reading and fails if they never settle"
    exit 0
fi
echo "::error::dist-tags did not settle on the highest version within $TRIES reads (about ${SETTLE_S}s plus call time)"
exit 1
