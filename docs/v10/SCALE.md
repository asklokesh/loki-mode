# SCALE: what the plan sustains and what 50 engineers would need (G-03, D39)

Written 2026-09-28 by the CTO (opus). Every number is either MEASURED (command and window
given), PUBLISHED (source URL given) or ESTIMATE (basis given). Billing is the founder's call.

## 1. Measured burn (MEASURED, local jsonl only)

Source: `~/.claude/projects/**/*.jsonl`, assistant rows with a `usage` field, window ending
2026-09-28 17:47Z. Local transcripts miss cloud and remote agents, so every figure is a lower bound.

Counting method matters. Claude Code writes one jsonl row per content block and repeats the
same `usage` on each row. Two methods, same hour:

| Last 1h (17:47Z)           | Raw sum of rows (D39 method) | Deduplicated (max per message id + requestId) |
|----------------------------|------------------------------|-----------------------------------------------|
| Output tokens              | 2.07M                        | 1.87M (sonnet 1.62M, opus 0.24M, haiku 0.005M) |
| Cache-read tokens          | 1.17B                        | 0.634B (sonnet 552M, opus 81M)                |
| Cache-write tokens         | not summed                   | 6.51M (sonnet 5.03M, opus 1.40M); 92% 5-minute TTL |
| Uncached input tokens      | not summed                   | 6.3K                                          |
| API requests               | 5,824 rows                   | 3,119 (peak 114 per minute)                   |

- The deduplicated count is the basis below. The D39 cache-read figure (1.15B) double counts
  about 1.8x; D39 and METRICS.md should carry the deduplicated numbers.
- Last 5h, deduplicated: output 6.01M (sonnet 5.21M, opus 0.80M), cache read 1.85B.
- Models seen in the last hour: claude-sonnet-5 (2,808 requests), claude-opus-5-5 (305),
  claude-haiku-4-5 (6). Opus share of output: 13%.
- Concurrency, measured: distinct transcript files with at least one request per 5-minute slot
  over the hour: 11, 11, 8, 12, 9, 12, 11, 21, 18, 20, 17, 17 (average 13.9). The stated
  16 to 19 agents matches the last 25 minutes.
- Peak minute (deduplicated): 66K output tokens, 561K ITPM-counted input (uncached input plus
  cache writes; cache reads do not count toward ITPM), 114 requests.

## 2. API-equivalent cost of the measured hour (PUBLISHED prices)

Prices from https://platform.claude.com/docs/en/about-claude/pricing (fetched 2026-09-28):

| Model            | Input | 5m cache write | 1h cache write | Cache read | Output |
|------------------|-------|----------------|----------------|------------|--------|
| claude-sonnet-5  | $2    | $2.50          | $4             | $0.20      | $10    |
| claude-opus-5-5  | $4    | $5             | $8             | $0.20      | $20    |
| claude-haiku-4-5 | $1    | $1.25          | $2             | $0.10      | $5     |

(USD per million tokens. Sonnet 5 $2/$10 is now the standard price, per the pricing page footnote.)

Measured hour at list price (cache writes priced at the 5-minute rate; the 1h share adds under $1):
- Sonnet: cache read $110.49 + output $16.25 + cache write $12.59 = $139.34
- Opus: cache read $16.26 + cache write $6.99 + output $4.75 = $28.00
- Haiku: $0.14. Total: $167.5 per hour, of which cache reads are 76% and output 12%.
- Upper bound with the raw D39 counting: about $275 per hour.

Per engineer-hour (ESTIMATE): $167.5 / 13.9 measured agents = $12.0; $167.5 / 17.5 stated agents
= $9.6. Range $9.6 to $12.0 per engineer-hour, $230 to $289 per engineer-day.

## 3. What the Max 20x plan sustains around the clock (ESTIMATE, uncalibrated)

The conversion from tokens to plan percent is NOT calibrated. G-01 fits it from founder
readings of the 5-hour and weekly meters. Until then, this is a range with its basis, not a number.

- Window ceiling: on 2026-09-27 about 16 agents took the 5-hour window from low to 91%. At the
  D39 target of 85% at window end, that is 15 to 17 agents for one window, if the 9-27 mix
  (tokens per agent, opus share) matches today.
- Weekly bound: 24/7 is 33.6 five-hour windows per week. If the weekly cap equals W full
  windows, sustainable 24/7 headcount = window ceiling x min(1, W / 33.6). W is unknown; it is
  exactly what G-01 must measure.
- ESTIMATE: 5 to 16 engineers around the clock. 16 holds only if the weekly cap is not binding;
  the low end assumes the weekly cap is about 10 full windows. Neither end is a measurement.
- Calibration input for G-01: use API-equivalent dollars per agent-hour (section 2), not raw
  tokens, as the regressor. It weights opus against sonnet the way the plan meter likely does,
  and it collapses four token kinds into one number.
- The API value of what the plan is delivering today is about $4,000 per day at list price.

## 4. What 50 parallel engineers would need (ESTIMATE on PUBLISHED prices)

Assumptions: measured mix of section 1 (sonnet 87% of output, opus 13%); caching as today
(99% of input from cache); 24 hours a day; list prices, no volume discount; no US-only
inference (`inference_geo: "us"` adds 1.1x); local-only burn, so real cost is at least this.

| Engineers | Per day           | Per 30 days          | Fits under (API spend cap)            |
|-----------|-------------------|----------------------|---------------------------------------|
| 16        | $3,675 to $4,627  | $110K to $139K       | Scale ($200K per month)               |
| 25        | $5,742 to $7,230  | $172K to $217K       | Scale at the low end; over it at high |
| 50        | $11,484 to $14,460| $345K to $434K       | Custom tier only (no cap; via sales)  |

Rate limits are not the binding constraint; the spend cap is. Source:
https://platform.claude.com/docs/en/api/rate-limits (fetched 2026-09-28).
- Monthly spend caps: Start $500, Build $1,000, Scale $200,000, Custom none. At 16 engineers the
  Start cap lasts about 3 hours and the Build cap about 6 hours. Tier placement is automatic
  from account history; new orgs may start in a lower Evaluation tier.
- Peak minute scaled from 13.9 to 50 agents: 238K output per minute, 2.0M ITPM-counted input,
  410 requests per minute. Sonnet 5 limits: Start 2M ITPM / 400K OTPM / 1,000 RPM; Build 5M /
  1M / 5,000; Scale 10M / 2M / 10,000. Opus 5.5 has its own bucket at the same numbers. So
  Build clears 50 agents on rate limits; Start is at its ITPM edge.
- Cache reads do not count toward ITPM on these models, which is why 99% cached input keeps
  the fleet far under the limits.
- The rate-limit page warns of acceleration limits on sharp ramps: step headcount up, never jump.

Plans (https://claude.com/pricing, fetched 2026-09-28; limits UNVERIFIED beyond the page text):
- Team: standard seat $20 to $25, premium seat $100 to $125 per month, "5x more usage than
  standard seats". Seat usage limits apply per seat; published numbers for agent-hours per
  seat were not found. UNVERIFIED for a 50-agent fleet.
- Enterprise: "seat price + usage at API rates", $20 per seat per month billed annually. Economics
  equal the API table above plus seat fees; custom limits and volume discounts are negotiated.
- Stacking several subscriptions to multiply limits for one automated fleet is not proposed;
  any such question goes to Anthropic.

## 5. Ramp gates (D39)

Headcount rises one step per hour, and only when all three hold for the last full hour:
1. Governor allows: projected 5-hour window at or under 85% at window end and weekly at or
   under 90% by the Wednesday 13:00 ET reset (on API billing: projected month under the tier cap
   and any workspace spend limit).
2. Merged slices per hour rose versus the previous step.
3. Merged work per token did not fall: merged slices per million output tokens is no more than
   10% below the previous step.
Step size: +4 engineers (never more than +25%). Any gate failing: hold. Two failing hours in a
row: step back one. The cut order in D39 applies (cloud, then MEDIUM and LOW local, then opus
reviewers down to the HIGH minimum; never the Release Manager or a P0).

What to measure first, this week: merged slices per million tokens.
- Numerator: distinct slice IDs (BOARD row IDs such as E-88 or DEP-05) whose commits became
  ancestors of origin/main in the window. Not commit count: 933 commits reached main in 7 days,
  which says nothing about slices.
- Denominator: deduplicated output tokens in millions, reported alongside API-equivalent
  dollars. Not total tokens: those are 99% cache reads and would make the ratio noisy and tiny.
- Record hourly in METRICS.md with the headcount of that hour. This is the baseline every
  ramp step is judged against; without it gate 3 cannot be evaluated and the ramp stays shut.

## 6. The founder's decision

| Option | What it is | Headcount | Cost (ESTIMATE) |
|--------|-----------|-----------|-----------------|
| A. Max 20x only | Governor-limited, as today | 5 to 16 around the clock (uncalibrated) | Current plan fee only |
| B. Max core + API overflow | Max for the core; API key with a workspace spend limit for engineers above the Max ceiling | Core + N | $230 to $289 per extra engineer-day; +10 = $2.3K to $2.9K per day |
| C. API only, Scale tier | All engineers on API billing | Up to about 25 inside the $200K cap | 16: $110K to $139K per month; 25: $172K to $217K |
| D. Enterprise or Custom tier | Sales-negotiated limits and discount | 50 | $345K to $434K per month at list, less any discount |

CTO recommendation: A now; G-01 calibrates within the week. Move to B only after the section 5
baseline exists and gate 3 holds at the Max ceiling, because extra engineers are worth buying
only if merged work per token does not fall as headcount rises. Open the sales conversation for
D before any plan to exceed 25, since Custom limits are not self-serve.
