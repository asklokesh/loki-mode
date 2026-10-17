# 07 Delivered quality and autonomy

Now 7.5. Winner today: Claude Code and Codex; Terminal-Bench 2.0 about 82% is the public bar; SWE-bench Verified is saturated (about 96%) and no longer differentiates.

Why we are not 10:
- Small tier (29 tasks, opus): raw 27/29 at $0.2363 p50 39s; v10 default 26/29 at $0.3946 p50 85.5s. Lean 27/29 at $0.1616 p50 40s but not default.
- Medium: no arm meets 85.7% completion at <= $0.5085 per completed. pub-werkzeug-3105 and 3271 fail in all arms.
- D50: Loki+sonnet 50% vs raw sonnet 90% (false ALREADY_SATISFIED, empty diff, BLOCKED); 2 of 4 losses real on rerun.
- Moat: P3 Wall (3 cases) and P4 model freedom (2 cases) pending; P9 regressed on main.
- A-119b: weakening via helper file or snapshot still ends VERIFIED.

Bar for 10: medium completion >= 85.7% at <= $0.5085 per completed with CI; Loki beats raw at every model tier; moat 9 of 9; public Terminal-Bench 2.0 and SWE-bench Pro numbers at or above raw Claude Code.

## QUAL-A Beat raw on medium

Acceptance: MEAS-4 run shows completion >= 85.7% and cost < $0.5085 per completed, CI reported.

Todo:
- [ ] Root-cause werkzeug-3105 and 3271 (FAILURE-CLASSES rows)
- [ ] Apply COST-B brief and SPD-A Wall changes, re-measure

## QUAL-B Close the D50 sonnet loss

Acceptance: Loki+sonnet >= raw sonnet at n=3 on the D50 set; humanize-174 and aiq-52 pass.

Todo:
- [ ] False ALREADY_SATISFIED guard in intake
- [ ] Empty-diff retry rule in implement
- [ ] Re-run D50

## QUAL-C Moat 9 of 9

Todo:
- [ ] P3: check-author step, `--freeze` interface, implementer prompt no longer authors checks (3 cases PASS)
- [ ] P4: high and small tiers resolve to distinct models (`three-setups-resolve` PASS)
- [ ] P4: floor-does-not-raise-wrong-pass PASS (needs MEAS-5)
- [ ] P9 stays PROVEN (STAB-1)
- [ ] Moat suite runs on every main push, not only full-suite (feeds STAB-2)

Acceptance: `bash tests/moat/run.sh` reports 9 of 9 PROVEN, `pending.txt` empty of P3/P4.

## QUAL-D Close A-119b weakening holes

Acceptance: A-119b repro cases (helper `eq=()=>{}`, snapshot weakening) end FAILED or PARTIAL with rc != 0.

Todo:
- [ ] `engine10/stages/verify.ts` detection
- [ ] Moat case for each repro

## QUAL-E Public benchmark numbers

Acceptance: MEAS-6 results published on the scoreboard with Loki and raw Claude Code side by side.

Todo:
- [ ] Terminal-Bench 2.0 score
- [ ] SWE-bench Pro pilot score
- [ ] Q18-03e followups: jsonc, toml, import-attributes and symlink cases in the project model
