#!/usr/bin/env bash
# release.yml refuses to publish without usable notes, so scripts/release-notes.sh must
# (a) extract a complete section for the current VERSION from the real CHANGELOG.md and
# (b) refuse a missing heading, an empty section, a section without a subsection or
# bullet, and placeholder text. (b) runs on fixture files in the temp dir.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. CHANGELOG.md: rename the heading "## v<VERSION> (date)" to "## v<VERSION>x":
#      the real-section case must fail.
#   2. scripts/release-notes.sh: delete the has_placeholder gate (the `if
#      has_placeholder "$body"` block): the placeholder fixture case must fail.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT" || exit 2

echo "TEST: release notes extraction"

RN="$ROOT/scripts/release-notes.sh"

out="$(bash "$RN" "$VERSION_NOW" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "CHANGELOG.md has a complete section for $VERSION_NOW" || bad "release-notes failed on the real CHANGELOG.md for $VERSION_NOW: $out"
has "extracted body has a subsection" "$out" "### "

F="$T/cl.md"
good='- Real change written for users.'
mk() { printf '# Changelog\n\n%s\n\n## v0.0.1 (2020-01-01)\n\n### Added\n\n- old\n' "$1" > "$F"; }

mk "## v9.9.9 (2026-01-01)

### Added

$good"
bash "$RN" 9.9.9 --file "$F" >/dev/null 2>&1 && ok "fixture with a complete section passes" || bad "fixture with a complete section was refused"

mk "## v9.9.8 (2026-01-01)

### Added

$good"
bash "$RN" 9.9.9 --file "$F" >/dev/null 2>&1 && bad "a missing heading was accepted" || ok "missing heading is refused"

mk "## v9.9.9 (2026-01-01)
"
bash "$RN" 9.9.9 --file "$F" >/dev/null 2>&1 && bad "an empty section was accepted" || ok "empty section is refused"

mk "## v9.9.9 (2026-01-01)

Release v9.9.9"
bash "$RN" 9.9.9 --file "$F" >/dev/null 2>&1 && bad "a section with no subsection or bullet was accepted" || ok "section with no subsection or bullet is refused"

mk "## v9.9.9 (2026-01-01)

### Added

- TODO: write the notes"
bash "$RN" 9.9.9 --file "$F" >/dev/null 2>&1 && bad "placeholder text was accepted" || ok "TODO placeholder is refused"

mk "## v9.9.9 (2026-01-01)

### Added

- Build a todo app template"
bash "$RN" 9.9.9 --file "$F" >/dev/null 2>&1 && ok "the word todo inside a real line is accepted" || bad "a real line containing 'todo' was refused"

finish
