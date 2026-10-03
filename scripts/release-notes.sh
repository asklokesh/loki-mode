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
# Carrying another version's notes forward (e.g. a version that never
# reached npm) happens ONLY via an explicit "--include v1,v2,..." list
# (E-88a). An earlier revision auto-detected candidates to carry from the
# section's own prose; that guessed wrong in ways two rounds of review
# caught (a higher, already-published version named only for context, and
# an over-broad npm-confirmation check), so auto-detect is gone entirely.
# release.yml passes no --include; the Release Manager writes any carried
# section into the CHANGELOG entry by hand instead (as done for 10.0.1 and
# 10.2.1).
#
# Usage: release-notes.sh <version> [--file CHANGELOG.md] [--include v1,v2,...]
set -uo pipefail

USAGE="usage: release-notes.sh <version> [--file CHANGELOG.md] [--include v1,v2,...]"
case "${1:-}" in
    -h|--help) echo "$USAGE"; exit 0 ;;
esac

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    echo "$USAGE" >&2
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

# Trim leading/trailing blank lines.
trim_blank() {
    sed -e '/./,$!d' -e ':a' -e '/^\n*$/{$d;N;ba' -e '}'
}

# True (rc 0) if $1 contains placeholder text: a TODO/TBD used as a marker
# (followed by ":" or end of line, e.g. "TODO: fill this in" or a bare
# "TODO" line) or a line that is ONLY a todo/tbd bullet (optionally
# wrapped in markdown emphasis, e.g. "- TODO" or "*TBD*"). Deliberately
# narrower than a bare substring match: "build a todo app" is a real,
# shippable changelog line and must pass.
#
# Uses a herestring, never `printf | grep -q`: grep -q exits the instant it
# finds a match, and on input bigger than one pipe buffer that closes the
# read end out from under a still-writing printf on the other end of a real
# pipeline, which gets SIGPIPE (128+13=141). Under this script's
# `set -o pipefail` that makes the WHOLE PIPELINE look like a failure even
# though grep found exactly the match it was looking for -- inverting
# "found it" into "not found" for large input. A herestring is not a
# pipeline (there is no second process to signal), so this is immune.
# Reproduced directly on a >100KB fixture body.
has_placeholder() {
    grep -qiE '(^|[^A-Za-z])(TODO|TBD)(:|[[:space:]]*$)' <<<"$1" && return 0
    grep -qiE '^[[:space:]]*(-[[:space:]]*)?[*_]*(todo|tbd)[*_]*\.?[[:space:]]*$' <<<"$1" && return 0
    return 1
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
if [ "${#body}" -gt 100000 ]; then
    echo "release-notes: section for v${VERSION} exceeds the 100,000 character cap (${#body} chars)" >&2
    exit 1
fi
if ! grep -q '^### ' <<<"$body"; then
    echo "release-notes: section for v${VERSION} is not fully written (no '### ' subsection)" >&2
    exit 1
fi
if ! grep -q '^- ' <<<"$body"; then
    echo "release-notes: section for v${VERSION} is not fully written (no '- ' bullet)" >&2
    exit 1
fi
if has_placeholder "$body"; then
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
# instead of just a one-line explanation. Explicit only -- a bad name is a
# fatal usage error, never a silent skip.
if [ -n "$INCLUDE" ]; then
    old_ifs="$IFS"
    IFS=','
    for v in $INCLUDE; do
        IFS="$old_ifs"
        [ -n "$v" ] || continue
        [ "$v" != "$VERSION" ] || continue
        if ! inc_body="$(extract_section "$v" "$FILE")"; then
            echo "release-notes: --include v${v} has no '## v${v}' heading in $FILE" >&2
            exit 1
        fi
        inc_body="$(printf '%s\n' "$inc_body" | trim_blank)"
        [ -n "$inc_body" ] || continue
        if has_placeholder "$inc_body"; then
            echo "release-notes: --include v${v} contains placeholder text (TODO/TBD)" >&2
            exit 1
        fi
        out="$(printf '%s\n\n## v%s changes (first published in v%s)\n\n%s' "$out" "$v" "$VERSION" "$inc_body")"
    done
    IFS="$old_ifs"
fi

# The cap above only bounds VERSION's own section; --include can push the
# combined, emitted notes back over it (GitHub's release-body limit is
# ~125,000 chars). Checked here too so an oversized combination fails before
# `gh release create`, not after -- the same "never burn a version number"
# reasoning as the cap on body itself.
if [ "${#out}" -gt 100000 ]; then
    echo "release-notes: combined output for v${VERSION} (with --include) exceeds the 100,000 character cap (${#out} chars)" >&2
    exit 1
fi

printf '%s\n' "$out"
