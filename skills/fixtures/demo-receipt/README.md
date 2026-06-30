# Demo Evidence Receipt fixture

`proof.json` here is a real Loki Mode Evidence Receipt, copied from an actual
build and sanitized (no machine paths, no secrets). It is bundled so that
`loki demo --offline` (and `loki tour`) can show a newcomer a real receipt with
zero provider, zero key, zero spend, and zero network.

What is real: the headline (`VERIFIED WITH GAPS`), the test result, the security
findings, the cost, and the diff stats are the genuine recorded results of that
build.

What is changed for sanitization: `run_id`, `loki_version`, timestamps, the
spec brief, and `verification.hash` are neutralized. `verification.hash` is set
to `sample-not-reproducible` on purpose so this replay fixture is never mistaken
for a locally-reproducible run. It is for display only.

This is a SAMPLE (a replay of a past real build), not a verdict on the user's
own code. The CLI labels it as such.
