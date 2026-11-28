// Spend: cost per verified run and a per-week table, all computed from the recorded runs. Unpriced runs are counted apart, never as $0.
// Merge columns come from the pull request state GitHub reported (GET /v1/pr-state): a run with no PR link is "No PR" and is not in the rate; a PR whose state could not be read is unknown, never "not merged".
import { useEffect, useState } from "react";
import { getOutcomes, type CostPerVerified, type RunRow } from "../api";
import { mergeWeekly, weekly, type MergeWeek, type PrView } from "../lib/model";

const pct = (x: number): string => `${Math.round(x * 100)}%`;
/** The rate cell: a percentage only from PRs whose state is known; otherwise why there is none. */
function rateCell(m: MergeWeek | undefined): string {
  if (!m) return "no PR";
  if (m.rate !== null) return m.unknown + m.checking > 0 ? `${pct(m.rate)} of ${m.merged + m.open + m.closed} known` : pct(m.rate);
  return m.checking > 0 ? "checking" : m.unknown > 0 ? "unknown" : "no PR";
}

export function Spend({ runs, tick, prs }: { runs: RunRow[]; tick: number; prs: PrView | null }) {
  const [cpv, setCpv] = useState<CostPerVerified | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { getOutcomes().then((o) => { setCpv(o.cost_per_verified_usd ?? null); setErr(null); }).catch((e: Error) => setErr(e.message)); }, [tick]);
  const weeks = weekly(runs);
  const merge = mergeWeekly(runs, prs);
  const unpriced = runs.filter((r) => r.cost_usd === null).length;
  return (
    <section className="page">
      <div className="dwrap">
        <div className="dh"><h2>Spend</h2><div className="meta">What the recorded runs cost, from each run's own cost events.</div></div>
        {err ? <div className="err">{err}</div> : null}
        <div className="grid2" style={{ marginTop: 20 }}>
          <div className="card"><small>Cost per verified run</small><div className="big">{cpv && cpv.value !== null ? `$${cpv.value.toFixed(2)}` : "not measured"}</div><small>{cpv ? `${cpv.n} priced verified run${cpv.n === 1 ? "" : "s"}` : ""}</small></div>
          <div className="card"><small>Total priced spend</small><div className="big">{cpv && cpv.spend_usd !== null ? `$${cpv.spend_usd.toFixed(2)}` : "not measured"}</div><small>{cpv ? `${cpv.priced_runs} priced, ${cpv.unpriced_runs} unpriced finished runs` : ""}</small></div>
          <div className="card"><small>Runs recorded</small><div className="big">{runs.length}</div><small>{unpriced} without a full price</small></div>
        </div>
        <div className="blk"><h4>By week</h4>
          {weeks.length === 0 ? <div className="empty">No runs recorded yet.</div> : (
            <div className="tw"><table><thead><tr><th>Week</th><th className="n">Runs</th><th className="n">Verified</th><th className="n">Partial</th><th className="n">Failed</th><th className="n">Spend</th><th className="n">Unpriced</th><th className="n">Merged</th><th className="n">Open</th><th className="n">Closed unmerged</th><th className="n">No PR</th><th className="n">Merge rate</th></tr></thead>
              <tbody>{weeks.map((w) => {
                const m = merge.get(w.start), later = m ? m.unknown + m.checking : 0;
                return <tr key={w.start}><td>{w.label}</td><td className="n">{w.runs}</td><td className="n">{w.verified}</td><td className="n">{w.partial}</td><td className="n">{w.failed}</td><td className="n">${w.usd.toFixed(2)}</td><td className="n">{w.unpriced}</td>
                  <td className="n">{m?.merged ?? 0}</td><td className="n">{m?.open ?? 0}</td><td className="n">{m?.closed ?? 0}</td><td className="n">{m?.none ?? 0}</td>
                  <td className="n" title={later > 0 ? `${later} pull request${later === 1 ? "" : "s"} with no state yet (${m!.checking} checking, ${m!.unknown} unknown), not in the rate` : undefined}>{rateCell(m)}</td></tr>;
              })}</tbody></table></div>
          )}
          <p className="note">Spend sums runs whose every session was priced. A run with an unpriced session is counted under Unpriced, never as $0.</p>
          <p className="note">Merge columns count finished runs by the state GitHub reports for their pull request. The rate is merged over merged, open and closed unmerged; a run with no pull request link is under No PR and not in it, and a pull request whose state could not be read is left out, never counted as not merged.</p>
        </div>
      </div>
    </section>
  );
}
