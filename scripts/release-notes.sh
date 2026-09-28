#!/usr/bin/env bash
# Prints the CHANGELOG.md section for one version's release notes (E-88).
#
# WHY THIS EXISTS. The release.yml extraction step used to be
#   awk "/^## v$VERSION\$/{flag=1; next} /^## v/{flag=0} flag" CHANGELOG.md
# Two bugs: (1) CHANGELOG headings are "## vX.Y.Z (YYYY-MM-DD)", not a bare
# "## vX.Y.Z" line, so the anchored regex never matched; (2) VERSION was
# spliced into an ERE unescaped, so its dots match ANY character -- "10.2.1"
# as a pattern also matches a literal heading like "10a2a1". Both bugs
# silently fell back to a one-line "Release vX.Y.Z" body. v9.80.1, v9.81.0,
# v10.0.1, v10.1.0, v10.1.1 and v10.2.1 shipped that way and were hand-fixed
# after the fact. This script uses literal string matching (no regex) and
# refuses to emit an incomplete section instead of falling back.
#
# Usage: release-notes.sh <version> [--file CHANGELOG.md] [--include v1,v2,...]
#                          [--npm-versions-file published-versions.json]
set -uo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    echo "usage: release-notes.sh <version> [--file CHANGELOG.md] [--include v1,v2,...] [--npm-versions-file FILE]" >&2
    exit 1
fi
shift

FILE="CHANGELOG.md"
INCLUDE=""
NPM_VERSIONS_FILE=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --file) FILE="$2"; shift 2 ;;
        --file=*) FILE="${1#--file=}"; shift ;;
        --include) INCLUDE="$2"; shift 2 ;;
        --include=*) INCLUDE="${1#--include=}"; shift ;;
        --npm-versions-file) NPM_VERSIONS_FILE="$2"; shift 2 ;;
        --npm-versions-file=*) NPM_VERSIONS_FILE="${1#--npm-versions-file=}"; shift ;;
        *) echo "release-notes: unknown argument: $1" >&2; exit 1 ;;
    esac
done

if [ ! -f "$FILE" ]; then
    echo "release-notes: $FILE not found" >&2
    exit 1
fi

# Extract the body between the literal "## v<want>" heading and the next
# "## " heading of ANY kind (not just another "## v" one -- a section also
# ends at "## Unreleased" or any other top-level heading). Comparisons use
# quoted parameter expansion (literal) or a quoted case pattern (a fixed
# "## " prefix we control), never VERSION spliced into a regex/glob.
#
# Each line has a trailing \r stripped before any comparison. Without this,
# a CRLF-terminated file's undated heading line ("## v1.2.3\r") fails BOTH
# match branches below (it is not exactly "## v1.2.3", and stripping the
# "## v1.2.3 " prefix -- which requires a real space right after the
# version -- leaves the \r in place too), so the heading is never found:
# CRLF made a real section look absent instead of degrading gracefully.
extract_section() {
    local want="$1" file="$2" prefix line in_section=0 found=0
    prefix="## v${want}"
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        if [ "$in_section" = 1 ]; then
            case "$line" in
                "## "*)
                    in_section=0
                    # Section already closed by hitting the next heading --
                    # nothing past it can still belong to $want, so stop
                    # reading rather than scanning the rest of a 32k-line file.
                    break
                    ;;
                *)
                    printf '%s\n' "$line"
                    continue
                    ;;
            esac
        fi
        if [ "$line" = "$prefix" ] || [ "${line#"$prefix" }" != "$line" ]; then
            in_section=1
            found=1
        fi
    done < "$file"
    [ "$found" = 1 ]
}

# Every "## " heading, in file order (CRLF-safe, same strip as
# extract_section). A "## vX.Y.Z..." heading is emitted as "v<token>"; any
# OTHER "## " heading (e.g. "## Unreleased", or an old "## [X.Y.Z] - ..."
# bracket-style heading from the pre-v7 era of this file) is emitted as a
# bare empty line -- an opaque boundary auto_carry_candidates' walk breaks
# on, the same rule extract_section uses to end a section. Without this, a
# non-"## v" heading between two real version headings would be silently
# invisible to the walk and could bridge over it as if the versions on
# either side were still contiguous.
list_heading_versions() {
    local file="$1" line token
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        case "$line" in
            "## v"[0-9]*)
                token="${line#"## v"}"
                token="${token%% *}"
                printf 'v%s\n' "$token"
                ;;
            "## "*)
                printf '\n'
                ;;
        esac
    done < "$file"
}

# True (rc 0) if dotted-numeric version $1 sorts strictly below $2, padding
# missing trailing components with 0. A non-numeric component loses the
# compare (rc 1) rather than erroring -- CHANGELOG headings are X.Y.Z... in
# practice, and this is only ever asked about heading tokens already matched
# by list_heading_versions above.
version_lt() {
    local a="$1" b="$2"
    [ "$a" != "$b" ] || return 1
    local a_parts b_parts i n ai bi
    IFS=. read -r -a a_parts <<<"$a"
    IFS=. read -r -a b_parts <<<"$b"
    n="${#a_parts[@]}"
    [ "${#b_parts[@]}" -gt "$n" ] && n="${#b_parts[@]}"
    for ((i = 0; i < n; i++)); do
        ai="${a_parts[i]:-0}"
        bi="${b_parts[i]:-0}"
        case "$ai" in *[!0-9]*) return 1 ;; esac
        case "$bi" in *[!0-9]*) return 1 ;; esac
        [ "$ai" -lt "$bi" ] && return 0
        [ "$ai" -gt "$bi" ] && return 1
    done
    return 1
}

# True (rc 0) if $1 is a quoted token in NPM_VERSIONS_FILE (the file is
# whatever shape `npm view <pkg> versions --json` produces: a JSON array of
# quoted version strings). Exact, quote-delimited match, so "9.1.0" cannot
# false-match "19.1.0" or "9.1.0-beta". With no file at all, every version
# is treated as NOT confirmed unpublished (see auto_carry_candidates).
npm_has_version() {
    [ -n "$NPM_VERSIONS_FILE" ] || return 1
    grep -qF "\"$1\"" "$NPM_VERSIONS_FILE"
}

# Called only when $1's own body says outright that it carries a version
# that never reached npm (the same trigger phrase the old code used) --
# auto-detect stays opt-in on the release's own words, never a blanket scan
# of "is there any unpublished version nearby". Once triggered, this is the
# contiguous run of headings directly below $1's own heading that are each:
# a real version heading (not "## Unreleased" or an old bracket-style
# heading, which list_heading_versions turns into an opaque break), strictly
# lower than the previous one in the run, and confirmed NOT published on
# npm. Stops at the first heading that breaks any of those. With no
# --npm-versions-file, nothing is confirmed unpublished, so this emits
# nothing at all -- carry nothing automatically without real npm data;
# --include is required instead (E-88 B1).
#
# This replaced a version that, once triggered, pulled every "vX.Y.Z" token
# mentioned anywhere in $1's own prose as a candidate: v9.22.13's body says
# "v9.24.0 is the next version on npm", a HIGHER version mentioned only for
# context, and the old code appended v9.24.0's whole section to v9.22.13's
# notes. Walking real headings below VERSION, in order, can never reach
# v9.24.0 -- it is a newer release and its heading sits ABOVE v9.22.13's in
# the file.
auto_carry_candidates() {
    local version="$1" file="$2" body="$3" floor="$1" seen=0 raw h
    [ -n "$NPM_VERSIONS_FILE" ] || return 0
    printf '%s\n' "$body" | grep -qE 'never (reached npm|published)' || return 0
    while IFS= read -r raw; do
        if [ "$seen" = 0 ]; then
            [ "$raw" = "v$version" ] && seen=1
            continue
        fi
        case "$raw" in
            v*) h="${raw#v}" ;;
            *) break ;;    # opaque non-version heading: contiguity broken
        esac
        version_lt "$h" "$floor" || break
        npm_has_version "$h" && break
        printf '%s\n' "$h"
        floor="$h"
    done < <(list_heading_versions "$file")
}

# Trim leading/trailing blank lines.
trim_blank() {
    sed -e '/./,$!d' -e ':a' -e '/^\n*$/{$d;N;ba' -e '}'
}

body="$(extract_section "$VERSION" "$FILE")" || {
    echo "release-notes: no '## v${VERSION}' heading found in $FILE" >&2
    exit 1
}
body="$(printf '%s\n' "$body" | trim_blank)"

if [ -z "$body" ]; then
    echo "release-notes: section for v${VERSION} is empty" >&2
    exit 1
fi

if ! printf '%s\n' "$body" | grep -q '^### '; then
    echo "release-notes: section for v${VERSION} is not fully written (no '### ' subsection)" >&2
    exit 1
fi
if ! printf '%s\n' "$body" | grep -q '^- '; then
    echo "release-notes: section for v${VERSION} is not fully written (no '- ' bullet)" >&2
    exit 1
fi
if printf '%s\n' "$body" | grep -qiE '(^|[^A-Za-z])(TODO|TBD)([^A-Za-z]|$)'; then
    echo "release-notes: section for v${VERSION} contains placeholder text (TODO/TBD)" >&2
    exit 1
fi
if [ "$body" = "Release v${VERSION}" ]; then
    echo "release-notes: section for v${VERSION} is only the old fallback placeholder" >&2
    exit 1
fi

out="$body"

# --include: append the named versions' own sections, each under its own
# "## vX.Y.Z changes (first published in <version>)" heading, so a release
# that republishes prior unpublished versions carries their real notes
# instead of just a one-line explanation.
#
# --include is explicit (a usage error on a bad name is fatal). Without it,
# auto_carry_candidates fires only when the body itself says it carries a
# never-published version, then walks the real CHANGELOG headings directly
# below VERSION's own (see its comment for why that replaced prose-scanning).
EXPLICIT_INCLUDE=1
if [ -z "$INCLUDE" ]; then
    EXPLICIT_INCLUDE=0
    INCLUDE="$(auto_carry_candidates "$VERSION" "$FILE" "$body" | paste -sd, -)"
fi

if [ -n "$INCLUDE" ]; then
    old_ifs="$IFS"
    IFS=','
    for v in $INCLUDE; do
        IFS="$old_ifs"
        [ -n "$v" ] || continue
        [ "$v" != "$VERSION" ] || continue
        if ! inc_body="$(extract_section "$v" "$FILE")"; then
            if [ "$EXPLICIT_INCLUDE" = 1 ]; then
                echo "release-notes: --include v${v} has no '## v${v}' heading in $FILE" >&2
                exit 1
            fi
            echo "release-notes: WARNING: auto-detected mention of v${v} has no '## v${v}' heading; skipping it" >&2
            continue
        fi
        inc_body="$(printf '%s\n' "$inc_body" | trim_blank)"
        [ -n "$inc_body" ] || continue
        out="$(printf '%s\n\n## v%s changes (first published in v%s)\n\n%s' "$out" "$v" "$VERSION" "$inc_body")"
    done
    IFS="$old_ifs"
fi

printf '%s\n' "$out"
