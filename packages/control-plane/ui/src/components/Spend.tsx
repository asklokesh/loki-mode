// Spend: cost per verified run and a per-week table, all computed from the recorded runs. Unpriced runs are counted apart, never as $0.
import { useEffect, useState } from "react";
import { getOutcomes, type CostPerVerified, type RunRow } from "../api";
import { weekly } from "../lib/model";

export function Spend({ runs, tick }: { runs: RunRow[]; tick: number }) {
  const [cpv, setCpv] = useState<CostPerVerified | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { getOutcomes().then((o) => { setCpv(o.cost_per_verified_usd ?? null); setErr(null); }).catch((e: Error) => setErr(e.message)); }, [tick]);
  const weeks = weekly(runs);
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
            <div className="tw"><table><thead><tr><th>Week</th><th className="n">Runs</th><th className="n">Verified</th><th className="n">Partial</th><th className="n">Failed</th><th className="n">Spend</th><th className="n">Unpriced</th></tr></thead>
              <tbody>{weeks.map((w) => <tr key={w.start}><td>{w.label}</td><td className="n">{w.runs}</td><td className="n">{w.verified}</td><td className="n">{w.partial}</td><td className="n">{w.failed}</td><td className="n">${w.usd.toFixed(2)}</td><td className="n">{w.unpriced}</td></tr>)}</tbody></table></div>
          )}
          <p className="note">Spend sums runs whose every session was priced. A run with an unpriced session is counted under Unpriced, never as $0.</p>
        </div>
      </div>
    </section>
  );
}
