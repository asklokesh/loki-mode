# Control

Mission: ship correct, reviewed, verified slices to npm continuously, faster
than drift can accumulate.

Priority order when anything conflicts: moat > seal accuracy > delivered
accuracy > cost > speed. Never trade a higher one for a lower one.

## Decisions (one line each; full text and Why/Reverse in DECISIONS.md)

- D12: unanimous APPROVE required; a reproduced blocking finding always
  vetoes; a bucket-(b) pre-existing gap the diff doesn't worsen is a new
  slice, never a veto (D21).
- D13: every review agent pins its model, never inherits the session's.
- D14-D17: root-caused session terminations to an unscoped `pkill -f`;
  fixed by scoping to the process group; the regression test itself
  twice reintroduced the bug (unsafe decoys, shared process group) until
  self-recorded PIDs, unique tokens, and self-isolation closed it.
- D18: a hot file was emptied by a scripted write with no read-back
  guard; Read-then-Edit or diff-verify before any scripted hot-file write.
- D19: a "confirmed solid" verdict only covers what was tested.

## Velocity targets

- Releases (D37): a cut at :00, :20 and :40 whenever main is green and
  a merged-unreleased slice exists; trains overlap after publish-npm.
- Ready slices: at least 8 at all times.
- Active builders: at least 6 while ready slices exist.
- Review-pending age: fix or escalate past 45 minutes.
- Merged-but-unreleased age: cut a release past 30 minutes while CI is
  green.

## Rule

The first action of every turn addresses the top VIOLATION from
`scripts/v10-pulse.sh`, before anything else.
