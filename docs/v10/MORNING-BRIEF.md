# Morning brief, 2026-10-01 (written 10:20Z)

## Headline
- `npm install -g loki-mode` now runs the Loki 10 engine by default, using a bundled bun. `latest` = 10.5.27, gated on both a machine with bun and one without.
- 18 release tags overnight (10.5.11 to 10.5.28), 16 published. Two were not published: 10.5.18 (CodeQL) and 10.5.21 (a changelog test). Both were fixed forward.

## What shipped (on npm latest unless noted)
- Default engine flip (D48 7-9): `loki "<task>"`, issue mode and `loki quick` run Loki 10. A bare `loki verify` after a v10 run exits 4 for a non-VERIFIED outcome.
- Bundled bun 1.4.2 as an optional dependency, with a resolver and a plain line when it cannot run (P0-nobun). It adds about 62MB on macOS arm64; npm lists 79.5MB for linux-x64.
- Two-leg promote gate (E-167): `latest` moves only if the published version passes on a machine with bun (v10 checks) and one without (legacy checks plus the fallback line).
- `loki keys export` and `loki verify --pubkey` let third parties check a receipt (D48 row 2).
- Seal: a failed commit stage now ends FAILED and never seals VERIFIED (A-104b). This is in 10.5.28, which is on `next` and waiting for its promote.
- Also: Jira auto-sync wiring (E-166), provider stdin closed (A-134c), loki-seal counter fixes, CodeQL injection fix in the `/start` API, `loki` with no arguments opens the dashboard onboarding.

## D48 table (honest)
| Row | Status |
|---|---|
| 1 gaming matrix | NOT DONE: test built (de71397d), not merged; pre-red case needs a CTO call |
| 2 portable receipt | DONE: tamper detection, keys export, verify --pubkey |
| 3 quiet and fast | PARTIAL: v10 output is 7 lines (gate checks 8 or fewer); the time ratio is not measured |
| 4 commits only the fix | PARTIAL: lockfile and Wall exclusion per directory (10.5.28); no node/pytest/go matrix yet |
| 5 exit ladder plus --json schema | PARTIAL: exit 4 shipped; schema not started |
| 6 doctor --fix under 2s | NOT DONE: dropped from train/26, not reworked |
| 7-9 v10 default, non-null cost | DONE: on latest; gate leg 1 checks the start line and non-null cost |
| 10 loki-seal marketplace | DONE |

## Lift (D50): not citable yet
- The baseline had Loki+sonnet 5/10 against raw sonnet 9/10. Of the 5 losses, 1 was also a raw loss (click-3059) and 1 predates the E-164 fix (aiq-52).
- The 3 real defects: a false "already satisfied" (click-2877), an empty diff (humanize-174), and a wrong fix that verify passed (humanize-333).
- A 3-rep rerun of the 4 Loki-specific tasks on both arms is running (~/loki-ci-logs/d50-rerun-20261001T0932). Results go here when complete; no number is published before then.

## LOKI MORNING TEST
```
npm install -g loki-mode@latest && loki --version          # 10.5.27
mkdir /tmp/lmt && cd /tmp/lmt && git init -q && echo 'module.exports=(a,b)=>a-b' > sum.js && git add sum.js && git commit -qm init
loki quick "sum.js should add, not subtract"                # first line names the Loki 10 engine; 8 lines or fewer
loki verify                                                 # VERIFIED rc 0, or rc 4 if the run did not verify
loki keys export > pub.jwk && loki verify --pubkey pub.jwk <e10-run-id>  # third-party check (run id from .loki/runs)
npm install -g loki-mode@latest --omit=optional             # no bun: the plain cannot-run line, then legacy
```

## Slipped and why
- D48 rows 1, 5 and 6: review capacity went to P0s (CodeQL, the gate text drift, the no-bun flip, the Seal false-VERIFIED path).
- The slim `--omit=optional` install (30MB against 408MB) is not documented yet: the plain-line evidence on that install is still missing (E-170).
- The Homebrew formula is in the separate asklokesh/tap, which this repo cannot reach; it needs `depends_on "oven-sh/bun/bun"` (E-169).

## Usage
- Weekly projection about 92% (ceiling 90%); the governor allows about 7 engineers. The sprint ran hot and was paced down after 04:35Z.

## Founder queue (docs/v10/FOUNDER-QUEUE.md)
- Row 17: bundling bun. Decided as option B by peer relay of your 03:30Z delegation, with install size accepted. Reverse it if you disagree.
- Rows 11-16 still open: opt-in telemetry, relaunch post, repo hook paths, gitleaks scope, the real-provider gate run (needs a token from you), and the Slack test message.
