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
#   3. scripts/release.sh ship_require_ci_green: skip the awk "not success" filter (the CI-green leg reads 0 for a red HEAD).
#   5. scripts/release.sh: restore a non-empty default workflow list (the default leg reads 6 with a failing gh).
#   4. scripts/release.sh run_ship: drop the ship_require_ci_green call (the --ship wiring leg fails).
#   6. scripts/release.sh ship_require_calibration: invert the presence test (CAL1 reads 0).
#   7. ship_require_calibration: drop the comparison (CAL3 reads 0).
#   8. ship_require_calibration: drop the valid-run check (CAL6 reads SHIP_CALIBRATION_WORSE).
#   9. ship_require_calibration: drop the base resolve (CAL7 reads SHIP_NO_CALIBRATION).
#  10. scripts/release.sh run_ship: drop the ship_require_calibration call (CAL5 fails).

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


# CI-GREEN (scripts/release.sh --check-ci, run by --ship before any write). Default: no workflow is listed, no CI run is
# required, gh is never called. With LOKI_RELEASE_CI_WORKFLOWS set, a red, missing or unreadable result on the commit being
# released refuses with exit 6. A faked gh answers per commit: HEAD's result, else the parent's, for the "PR fast tier"
# workflow; "required-ci" does not exist in the fake (no runs, not a failure).
FG="$(mktemp -d "$T/fakegh.XXXXXX")"
cat > "$FG/gh" <<'GH'
#!/usr/bin/env bash
if [ "$1 $2" = "workflow view" ]; then [ "$3" = "PR fast tier" ]; exit $?; fi
[ "$1 $2" = "run list" ] || exit 2
wf="" sha=""; while [ $# -gt 0 ]; do case "$1" in --workflow) wf="$2"; shift ;; --commit) sha="$2"; shift ;; esac; shift; done
[ "$wf" = "PR fast tier" ] || exit 1
if [ "$sha" = "$(git rev-parse HEAD)" ]; then r="$FAKE_HEAD"; else r="$FAKE_PARENT"; fi
case "$r" in none) exit 0 ;; hang) sleep 20; exit 0 ;; error) exit 1 ;; *) printf '%s\t4242\n' "$r" ;; esac
GH
chmod +x "$FG/gh"
ci() { (cd "$ROOT" && PATH="$FG:$PATH" FAKE_HEAD="$1" FAKE_PARENT="$2" LOKI_RELEASE_CI_TIMEOUT_S="${3:-30}" LOKI_RELEASE_CI_WORKFLOWS="PR fast tier,required-ci" bash scripts/release.sh --check-ci >/dev/null 2>&1; echo $?); }
r0="$(cd "$ROOT" && env -u LOKI_RELEASE_CI_WORKFLOWS PATH="$FG:$PATH" FAKE_HEAD=error FAKE_PARENT=error bash scripts/release.sh --check-ci >/dev/null 2>&1; echo $?)"
[ "$r0" = 0 ] && ok "release CI-green: with no workflow listed (the default) no CI run is required, even when gh fails" || bad "release CI-green default: exit $r0 with no workflow listed (want 0)"
r="$(ci success failure) $(ci failure success) $(ci none success) $(ci none failure) $(ci none none) $(ci error success) $(ci hang success 1) $(ci cancelled success)"
[ "$r" = "0 6 0 6 6 6 6 6" ] && ok "release CI-green: success on HEAD ships; red on HEAD, a red parent when HEAD has no run, no run at all, a gh error, a gh timeout and a cancelled run each refuse with exit 6 ($r)" || bad "release CI-green exit codes: $r (want 0 6 0 6 6 6 6 6)"
awk '/^run_ship\(\)/{f=1} f && /ship_require_ci_green/{c=NR} f && /ship_phase "bump version files"/{b=NR; exit} END{exit !(c && b && c < b)}' "$ROOT/scripts/release.sh" && ok "release CI-green: --ship runs the CI check before its first write (the version bump)" || bad "release CI-green: --ship does not run ship_require_ci_green before the bump"


# CALIBRATION (VERIFY-PLAN V1, scripts/release.sh --check-calibration, run by --ship before any write). A range from the last tag
# that changes a label file needs a calibration-*.json committed in it, no worse than the previous one. Temp repos in $T.
calrepo() { # calrepo <name>: a fresh repo with one base commit; prints its path
    local d="$T/cal-$1"; mkdir -p "$d/loki-ts/src/engine10/stages" "$d/benchmarks/h2h/results"
    git -C "$d" init -q -b main; git -C "$d" config user.name t; git -C "$d" config user.email t@example.invalid; git -C "$d" config commit.gpgsign false
    printf 'seal\n' > "$d/loki-ts/src/engine10/stages/seal.ts"; printf 'readme\n' > "$d/README.md"
    git -C "$d" add -A; git -C "$d" commit -q -m base; printf '%s\n' "$d"
}
calcommit() { local d="$1" m="$2"; git -C "$d" add -A; git -C "$d" commit -q -m "$m"; }
caljson() { printf '{"calibration": {"n": %s, "false_verified": %s, "verifier_right": %s}}\n' "$2" "$3" "$4" > "$1"; }
calrun() { # calrun <repo> <from>: prints "<exit> <refusal code or none>"
    local out rc; out="$(cd "$ROOT" && LOKI_RELEASE_CAL_REPO="$1" LOKI_RELEASE_CAL_FROM="$2" bash scripts/release.sh --check-calibration 2>&1)"; rc=$?
    printf '%s %s\n' "$rc" "$(printf '%s' "$out" | grep -oE 'SHIP_(NO_CALIBRATION|CALIBRATION_[A-Z_]+)' | head -1 || true)"
}
c1="$(calrepo c1)"; f1="$(git -C "$c1" rev-parse HEAD)"; printf 'seal 2\n' > "$c1/loki-ts/src/engine10/stages/seal.ts"; calcommit "$c1" edit
r="$(calrun "$c1" "$f1")"; [ "$r" = "4 SHIP_NO_CALIBRATION" ] && ok "release calibration CAL1: a label-file change with no calibration file refuses (SHIP_NO_CALIBRATION)" || bad "release calibration CAL1: got '$r' (want 4 SHIP_NO_CALIBRATION)"
caljson "$c1/benchmarks/h2h/results/calibration-a.json" 32 0 20; calcommit "$c1" cal
r="$(calrun "$c1" "$f1")"; [ "$r" = "0 " ] && ok "release calibration CAL2: the first calibration file passes on presence" || bad "release calibration CAL2: got '$r' (want 0)"
c3="$(calrepo c3)"; caljson "$c3/benchmarks/h2h/results/calibration-a.json" 32 0 20; calcommit "$c3" cal-a; f3="$(git -C "$c3" rev-parse HEAD)"
printf 'seal 2\n' > "$c3/loki-ts/src/engine10/stages/seal.ts"; caljson "$c3/benchmarks/h2h/results/calibration-b.json" 32 1 20; calcommit "$c3" cal-b
r="$(calrun "$c3" "$f3")"; [ "$r" = "4 SHIP_CALIBRATION_WORSE" ] && ok "release calibration CAL3: one more false VERIFIED than the previous file refuses (SHIP_CALIBRATION_WORSE)" || bad "release calibration CAL3: got '$r' (want 4 SHIP_CALIBRATION_WORSE)"
c4="$(calrepo c4)"; f4="$(git -C "$c4" rev-parse HEAD)"; printf 'readme 2\n' > "$c4/README.md"; calcommit "$c4" readme
r="$(calrun "$c4" "$f4")"; [ "$r" = "0 " ] && ok "release calibration CAL4: a range that changes no label file needs no calibration" || bad "release calibration CAL4: got '$r' (want 0)"
c6="$(calrepo c6)"; caljson "$c6/benchmarks/h2h/results/calibration-a.json" 32 0 20; calcommit "$c6" cal-a; f6="$(git -C "$c6" rev-parse HEAD)"
printf 'seal 2\n' > "$c6/loki-ts/src/engine10/stages/seal.ts"; caljson "$c6/benchmarks/h2h/results/calibration-b.json" 30 0 20; calcommit "$c6" cal-b
r="$(calrun "$c6" "$f6")"; [ "$r" = "4 SHIP_CALIBRATION_FEWER_RUNS" ] && ok "release calibration CAL6: fewer valid runs than the previous file refuses as FEWER_RUNS, not WORSE" || bad "release calibration CAL6: got '$r' (want 4 SHIP_CALIBRATION_FEWER_RUNS)"
r="$(calrun "$c1" v0.0.0-missing)"; [ "$r" = "4 SHIP_CALIBRATION_NO_BASE" ] && ok "release calibration CAL7: a last tag that does not resolve refuses (SHIP_CALIBRATION_NO_BASE), never reads as no file" || bad "release calibration CAL7: got '$r' (want 4 SHIP_CALIBRATION_NO_BASE)"
awk '/^run_ship\(\)/{f=1} f && /ship_require_calibration/{c=NR} f && /ship_phase "bump version files"/{b=NR; exit} END{exit !(c && b && c < b)}' "$ROOT/scripts/release.sh" && ok "release calibration CAL5: --ship runs the calibration check before its first write (the version bump)" || bad "release calibration CAL5: --ship does not run ship_require_calibration before the bump"

finish
