# pub-humanize-174 provenance (not given to arms)

- fix_pr: python-humanize/humanize#272
- merge_sha: 3dca143f7884b928632f68449423d914531ca267
- EV-2 review fix: removed 3 upstream rows that require ties-to-even rounding (naturaldelta 2h30m -> 2 hours; naturaltime and naturaltime_nomonths 22.5 -> 22 seconds ago). Issue #174 states no tie convention. A round-half-up fix now passes (see hidden/GREEN.txt).
