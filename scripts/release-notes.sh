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
set -uo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    echo "usage: release-notes.sh <version> [--file CHANGELOG.md] [--include v1,v2,...]" >&2
    exit 1
fi
shift

FILE="CHANGELOG.md"
INCLUDE=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --file) FILE="$2"; shift 2 ;;
        --file=*) FILE="${1#--file=}"; shift ;;
        --include) INCLUDE="$2"; shift 2 ;;
        --include=*) INCLUDE="${1#--include=}"; shift ;;
        *) echo "release-notes: unknown argument: $1" >&2; exit 1 ;;
    esac
done

if [ ! -f "$FILE" ]; then
    echo "release-notes: $FILE not found" >&2
    exit 1
fi

# Extract the body between the literal "## v<want>" heading and the next
# "## v" heading. Comparisons use quoted parameter expansion (literal) or a
# quoted case pattern (a fixed "## v" prefix we control), never VERSION
# spliced into a regex/glob.
extract_section() {
    local want="$1" file="$2" prefix line in_section=0 found=0
    prefix="## v${want}"
    while IFS= read -r line || [ -n "$line" ]; do
        if [ "$in_section" = 1 ]; then
            case "$line" in
                "## v"*)
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
if printf '%s\n' "$body" | grep -qE '(^|[^A-Za-z])(TODO|TBD)([^A-Za-z]|$)'; then
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
# best-effort auto-detect fires when the body says outright that it carries
# a version that never reached npm, and pulls every "vX.Y.Z" token out of
# the free text as a candidate. That text is prose, not a caller-checked
# list, so a candidate with no matching heading (a stray mention, not a
# real carried version) is skipped with a warning instead of blocking the
# release -- only an explicit --include name is worth failing over.
EXPLICIT_INCLUDE=1
if [ -z "$INCLUDE" ]; then
    EXPLICIT_INCLUDE=0
    if printf '%s\n' "$body" | grep -qE 'never (reached npm|published)'; then
        INCLUDE="$(printf '%s\n' "$body" | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | sed 's/^v//' | grep -v -x -F "$VERSION" | awk '!seen[$0]++' | paste -sd, -)"
    fi
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
