/**
 * Loki Mode Data Freshness
 *
 * THE GAP THIS CLOSES. The Python readers (dashboard/api_runs.py,
 * api_tests.py, api_evidence.py, api_releases.py) all compute `freshness_s`:
 * the age in seconds of the newest FILE that actually contributed to the
 * answer. Every one of them hands it to the UI, and the UI threw it away --
 * consumed by 0 of 43 components. A forty-minute-old poll rendered identically
 * to one that landed a second ago.
 *
 * WHY THE SERVER'S NUMBER WINS. Client receive time answers "when did this
 * response arrive", which is not the question. A dashboard that polls every
 * 5s always receives fresh RESPONSES; what goes stale is the state underneath
 * them. If the runner died an hour ago, every poll since has been a prompt
 * delivery of hour-old facts. `freshness_s` measures the file, so it is the
 * only one of the two that can say so. Client receive time is the fallback for
 * a payload that carries no envelope, and it is labelled as such -- the caller
 * can always tell which question was answered.
 *
 * ABSENT IS NOT ZERO. A payload with no `freshness_s` and no recorded receive
 * time yields `{ known: false, ageS: null }`, never `{ ageS: 0 }`. Zero means
 * "measured, and it is current", which is the single most misleading thing
 * this file could say about data it never measured. Callers render the unknown
 * case as UNKNOWN.
 */

/**
 * Default staleness threshold in seconds. Chosen against the dashboard's own
 * cadence: components poll on 3s-60s intervals, so a minute of age is normal
 * and two minutes means something upstream stopped writing.
 */
export const DEFAULT_STALE_AFTER_S = 120;

/**
 * Pull a server-supplied freshness from a payload.
 *
 * Accepts the envelope shape every reader emits ({..., freshness_s}) and the
 * per-row shape api_runs._row emits, since a caller often holds one run rather
 * than the whole envelope. Anything that is not a finite non-negative number
 * is treated as absent -- a null `freshness_s` is the readers' deliberate "I
 * could not measure this", and coercing it to a number would erase exactly the
 * distinction they went to the trouble of preserving.
 *
 * @param {any} payload
 * @returns {number|null} seconds, or null when the payload carries none
 */
export function serverFreshnessS(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const v = payload.freshness_s;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v;
}

/**
 * The freshest server-supplied age across a list of rows.
 *
 * MINIMUM, not first. The readers define freshness_s as the age of the NEWEST
 * file that contributed, so asking the same question one level up over a list
 * means taking the smallest age, not whichever row happens to sort first.
 * dashboard/api_runs.list_runs sorts by `started_at` descending, which orders
 * runs by when they BEGAN and says nothing about which one was written to most
 * recently -- a long-lived run started yesterday sorts above a short one that
 * finished a minute ago. Reading row[0] would therefore over-report staleness
 * on exactly the table that has a live run in it.
 *
 * Rows with no usable freshness_s are skipped rather than counted as 0.
 *
 * @param {Array} rows
 * @returns {number|null} seconds, or null when no row carries one
 */
export function freshestRowS(rows) {
  if (!Array.isArray(rows)) return null;
  let best = null;
  for (const row of rows) {
    const v = serverFreshnessS(row);
    if (v !== null && (best === null || v < best)) best = v;
  }
  return best;
}

/**
 * Answer the two questions: how old is this data, and is it past the
 * staleness threshold.
 *
 * @param {object} opts
 * @param {any} [opts.payload] - the response body (or one row); consulted for
 *   `freshness_s`, which wins when present.
 * @param {number|null} [opts.receivedAtMs] - Date.now() when the response
 *   landed. Fallback only.
 * @param {number} [opts.nowMs] - injectable clock for tests.
 * @param {number} [opts.staleAfterS] - threshold; defaults to
 *   DEFAULT_STALE_AFTER_S.
 * @returns {{known: boolean, ageS: number|null, source: string, isStale: boolean|null, staleAfterS: number}}
 *   `source` is 'server' (file age), 'client' (receive time) or 'none'.
 *   `isStale` is null when unknown -- not false. "I cannot tell" is not "it is
 *   fine".
 */
export function dataFreshness(opts = {}) {
  const {
    payload = null,
    receivedAtMs = null,
    nowMs = Date.now(),
    staleAfterS = DEFAULT_STALE_AFTER_S,
  } = opts;

  const fromServer = serverFreshnessS(payload);
  let ageS = null;
  let source = 'none';

  if (fromServer !== null) {
    ageS = fromServer;
    source = 'server';
  } else if (typeof receivedAtMs === 'number' && Number.isFinite(receivedAtMs)) {
    // Clamp at 0: a client clock that ticks backwards must not report a
    // negative age, and a negative age would compare as "fresh" forever.
    ageS = Math.max(0, Math.floor((nowMs - receivedAtMs) / 1000));
    source = 'client';
  }

  return {
    known: ageS !== null,
    ageS,
    source,
    isStale: ageS === null ? null : ageS >= staleAfterS,
    staleAfterS,
  };
}

/**
 * A short human label for a freshness result: "12s ago", "4m ago", "2h ago",
 * or "unknown" when it was never measured.
 *
 * ponytail: coarse buckets, not a relative-time library. Add finer granularity
 * when a surface needs it.
 *
 * @param {{known: boolean, ageS: number|null}} f - a dataFreshness() result
 * @returns {string}
 */
export function freshnessLabel(f) {
  if (!f || !f.known || typeof f.ageS !== 'number') return 'unknown';
  const s = f.ageS;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * The full operator-facing string, including the stale marker and which clock
 * answered. The `(receive time)` suffix is not noise: it tells an operator the
 * age describes when the response arrived, not when the underlying state was
 * last written, and those diverge exactly when it matters.
 *
 * @param {{known: boolean, ageS: number|null, source: string, isStale: boolean|null}} f
 * @returns {string}
 */
export function freshnessText(f) {
  if (!f || !f.known) return 'Data age unknown';
  const suffix = f.source === 'client' ? ' (receive time)' : '';
  const stale = f.isStale ? ' - STALE' : '';
  return `Updated ${freshnessLabel(f)}${suffix}${stale}`;
}

export default dataFreshness;
