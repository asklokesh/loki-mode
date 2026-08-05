# Dashboard 9.12: what was measured before any code was written

Every number here was measured on 2026-08-03 against the working tree at
`76e42773`. Commands are included so each can be re-run rather than trusted.

## The premise, corrected

An earlier pass in this session measured "is the dashboard rendering fabricated
data" and answered mostly no: 38 of 43 components call a real API, and only two
files contain `Math.random`. That measurement was sound and it answered the
wrong question.

The founder directive does not ask whether data is fabricated. It asks whether
**every metric shows source, freshness, unknown, and error state**. That is a
different property, and it is where the work is.

## The finding

The Python readers were built with strict envelope discipline: an empty result
carries a `reason`, an unmeasured number reads `None` rather than `0`, and
`source` names the files consulted. The UI discards most of that.

| Envelope field | Components consuming it | What its absence means |
|---|---|---|
| `freshness_s` | **0 of 43** | A 40-minute-old poll renders identically to a fresh one |
| `measured` | **0 of 43** | A real cost observation is indistinguishable from an absent one |
| `reason` | 6 of 43 | "no runs" and "could not read runs" render the same in 37 components |
| `source` | 10 of 43 | Most rows cannot be audited back to the file they came from |

```bash
cd dashboard-ui
grep -l "freshness_s" components/*.js core/*.js | wc -l   # 0
grep -l "measured"    components/*.js core/*.js | wc -l   # 0
```

### Absent rendered as zero

```bash
grep -o '|| 0' components/*.js | wc -l    # 116
grep -l '|| 0' components/*.js | wc -l    # 23 of 43 components
grep -o '?? 0' components/*.js | wc -l    # 8
```

116 occurrences across 23 components. This is the exact violation
`record_is_measured()` exists to prevent, expressed in the UI layer: an absent
measurement rendered as the number zero. From an operator's chair it is
indistinguishable from fabricated data, because a fabricated zero and an
unmeasured zero look the same.

### No staleness signal exists

`stale` appears 112 times but collapses to a SINGLE distinct usage:

```bash
grep -h -o ".\{45\}stale.\{25\}" components/*.js | sort -u
# >${st.status === 'running' || st.status === 'stale' ? ...
```

It is a server-supplied status enum value, never a client-side computation
over data age. There are no `isStale`, `staleness`, or `stale_s` identifiers.
Nothing in the UI derives freshness from a timestamp.

## The one genuine fabrication

`components/loki-session-timeline.js:_buildPhasesFromStatus` synthesizes a
timeline and renders it as history. Its own comment says so:

```js
// Simulate a multi-phase timeline based on iteration count
const phaseOrder = ['planning', 'building', 'testing', 'reviewing'];
const duration = segmentDuration * (0.8 + Math.random() * 0.4);
```

Phase NAMES come from a fixed rotation and durations are randomized. Neither is
measured. An operator reads plausible phase boundaries for work that never
happened at those times.

The other `Math.random` (`loki-log-stream.js:267`) is benign: a unique key for
a real log entry.

**Fix direction** follows `version_is_ahead`: not a better estimate, an explicit
"phase history not recorded". Whether real phase transitions can be read from
`trust-events.jsonl` must be checked against that file rather than inferred
from the component.

## What this means for scope

The redesign is not a rewrite of 31,924 lines of working component code. It is
making the UI carry the honesty contract the backend already has:

1. Every metric renders `unknown` rather than `0` when unmeasured.
2. Every panel shows data age, and marks itself stale past a threshold.
3. Every empty state states its `reason` and names its `source`.
4. Nothing is synthesized and presented as measured.

Items 1-3 are the founder's four required states (source, freshness, unknown,
error) applied to surfaces that already fetch real data. Item 4 is one bug.
