# Founder Decisions: trust semantics (2026-08-01)

Two questions this session surfaced that I deliberately did not answer, because
answering them changes what the word "Verified" means on a receipt. Both are
recorded with the measurement that raised them, so the decision can be made on
evidence rather than on my summary of it.

Everything else from this session shipped. These are the only open items.

## Why these are yours and not mine

`autonomy/lib/proof-generator.py` already records the rule, in the note on the
functional-verification fact:

> Making functional-satisfaction gate the green headline is a trust-semantics
> product decision (council + founder), the second half of FV-2. Recording it
> first lets the signal be seen and validated safely.

Record first, gate later. Both items below follow that pattern: the fact is now
recorded and visible on every surface, and the verdict is unchanged pending your
call.

---

## Decision 1: should a disabled trust gate demote "Verified"?

**Status today:** the gate is recorded and shown everywhere. The headline is
unchanged.

A run can disable any phase by environment variable. When code review or
security is switched off, the proof now records it (`quality_gates.disabled_phases`),
the honesty ledger carries a per-gate entry, both receipts name it, and the
plain-English owner page refuses to show a green "ready" badge.

What it does **not** do is change `honesty.headline`. A receipt with code review
disabled can still read `VERIFIED`.

**The case for demoting it:** "Verified" on a receipt with two correctness gates
switched off is defensible only if it means "verified as far as it was checked".
A reader who has not read the gaps list will not make that distinction.

**The case against:** the headline is re-derived by `proof-verify` to detect
tampering. Changing what feeds it changes what an honest proof looks like, and
older signed receipts would re-derive differently. There is also a real risk of
teaching users to ignore the headline if it moves for reasons they consider
routine.

**If you decide to demote:** the change is in `_compute_headline`, and the
disabled-gate entries must then be included in the verifier's re-derivation
rather than filtered out (`_recorded_degraded_raw`). Both halves must move
together or every honest receipt is reported as forged, which is exactly the bug
v8.19.2 fixed.

---

## Decision 2: is an unrun security scan a gap?

**Status today:** deliberately not a gap. There is a test asserting it.

Measured on a real generated proof, with a clean build and passing tests:

```
headline      : VERIFIED
gaps listed   : []
security fact : {'ran': False, 'status': 'not_run', 'high_active': 0}
```

So a receipt reads `VERIFIED` with an empty gaps list while the security scan
never ran at all.

Tests and build are both flagged as gaps when they do not run. Security is
flagged only when it **ran and found** an active HIGH finding. The asymmetry is
intentional: `tests/test_proof_generator.py::test_no_security_file_is_not_a_gap`
states it outright, "Absence of a scan is not a security gap (the gate did not
run)".

I prototyped changing it and reverted, because overriding a documented decision
with a test guarding it is not a call I should make silently.

**The case for treating it as a gap:** the honesty ledger exists so "a reader
sees exactly what was NOT verified rather than inferring it from silence"
(`_compute_degraded`'s own docstring). An unrun security scan is precisely that,
and it is the one omission a reader is least likely to notice on their own.

**The case against:** most projects have no security scanner configured, so
every receipt would carry a security gap that means nothing about that
project's quality. A gap list that is never empty is a gap list nobody reads,
and that costs more than the omission.

**A middle option:** treat it as a gap only when the project has a scanner
configured and it did not run. That distinguishes "not applicable" from
"skipped", which is the distinction the current binary answer cannot express.

---

## Context found after writing the above: it is three tiers, not two

Sweeping every fact the proof records showed the exclusion is a deliberate,
consistent pattern rather than an oversight in one place. Three facts are
recorded and never enter the honesty ledger on a clean run:

| Fact | In the ledger? | Documented as record-half? |
|---|---|---|
| `functional` | never | yes, explicitly (FV-2) |
| `healthcheck` | never | yes, explicitly |
| `security` | only on an active HIGH finding | no note, but behaves the same when unrun |

`functional` and `healthcheck` both carry a note in their collector saying they
are "NOT read by `_compute_headline` / `_compute_degraded`" and that gating on
them is founder-gated. `security` carries no such note, yet an unrun scan is
excluded exactly as they are.

That changes decision 2 from "is this an oversight?" to "should the third tier
join the first two, or move the other way?". It also means answering it in
isolation would leave the receipt inconsistent: if an unrun security scan
becomes a gap, a reader will reasonably ask why an unrun healthcheck is not.

The cheapest correct step, if you want one, is to give `security` the same
explicit record-half note the other two have, so the current behaviour is
documented where a reader will find it rather than inferred from its absence.

---

## What I would recommend, briefly

Revised after the three-tier finding above, which I had not made when I first
wrote this section.

Decision 2 should not be taken in isolation. Answering it for security alone
makes the receipt internally inconsistent, because a reader who sees an unrun
security scan flagged will reasonably ask why an unrun healthcheck is not. The
real question is what the whole record-half tier should do, and that is one
decision, not three.

Decision 1 is the larger change and depends on how you want "Verified" to read
to someone who did not run the build. It is worth deciding deliberately rather
than inheriting, and it is independent of decision 2.

Neither is blocking. Both facts are already visible to anyone who reads the
receipt.

The one change I made without asking is documentation only: `security` now
carries the same explicit record-half note that `functional` and `healthcheck`
have. That records the existing behaviour where a reader will find it. It
changes no verdict and decides nothing.
