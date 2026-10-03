// Receipts: finished runs, an in-place Verify (the engine's own verifier, run read-only on this machine), the public key, and the verified-rate trend.
import { useEffect, useState } from "react";
import { listRuns, type RunRow } from "../../api";
import { Badge, Button, Card, EmptyState, KpiTile, Spinner, Table, VerdictBadge, isVerified } from "../../design/primitives";
import { getPublicKey, verifiedTrend, verifyRun, type PublicKey, type VerifyResult } from "./api";

const key = (r: RunRow) => `${r.source_id}/${r.run_id}`;

export function Receipts() {
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, VerifyResult | { error: string } | "pending">>({});
  const [pub, setPub] = useState<PublicKey | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    listRuns().then((r) => live && setRows(r.runs), (e: Error) => live && setError(e.message));
    getPublicKey().then((k) => live && setPub(k), () => live && setPub(null));
    return () => { live = false; };
  }, []);

  const verify = async (r: RunRow) => {
    setResults((p) => ({ ...p, [key(r)]: "pending" }));
    try { const v = await verifyRun(r.source_id, r.run_id); setResults((p) => ({ ...p, [key(r)]: v })); }
    catch (e) { setResults((p) => ({ ...p, [key(r)]: { error: (e as Error).message } })); }
  };

  if (error) return <EmptyState title="Receipts unavailable" hint={error} />;
  if (!rows) return <Spinner label="Loading receipts" />;
  const finished = rows.filter((r) => r.verdict);
  const trend = verifiedTrend(finished);
  const overall = finished.length ? Math.round((finished.filter((r) => isVerified(r)).length / finished.length) * 100) : null;

  return (
    <div data-testid="receipts" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        <KpiTile label={`Verified rate (${finished.length} finished run${finished.length === 1 ? "" : "s"}, by run outcome)`} value={overall === null ? "not measured" : `${overall}%`} series={trend.map((t) => t.rate)} trend={trend.length > 1 ? `${trend.length} days` : undefined} />
        <Card style={{ padding: "14px 16px" }} data-testid="public-key">
          <div style={{ fontSize: "var(--cp-text-sm)", color: "var(--cp-text-2)" }}>Public key (Ed25519)</div>
          {pub === undefined ? <Spinner size={12} /> : pub === null ? (
            <div>not measured: no signing key on this machine yet</div>
          ) : (
            <div style={{ fontFamily: "var(--cp-font-mono)", fontSize: 12, wordBreak: "break-all" }}>
              <div data-testid="key-kid">kid {pub.kid}</div>
              <div data-testid="key-x">x {pub.x}</div>
            </div>
          )}
        </Card>
      </div>
      {finished.length === 0 ? <EmptyState title="No finished runs yet" hint="A receipt appears here when a run completes." /> : (
        <Table
          caption="Receipts"
          columns={["Run", "Outcome", "Started", "Verify"]}
          rows={finished.map((r) => {
            const res = results[key(r)];
            return [
              <span key="run" style={{ fontFamily: "var(--cp-font-mono)" }}>{r.run_id}</span>,
              <VerdictBadge key="out" run={r} />,
              r.started_at ?? "not measured",
              <span key="v" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <Button size="sm" variant="secondary" disabled={res === "pending"} onClick={() => void verify(r)} data-testid="verify-btn">{res === "pending" ? "Verifying" : "Verify"}</Button>
                {res && res !== "pending" ? (
                  "error" in res
                    ? <Badge tone="error" data-testid="verify-result">{res.error}</Badge>
                    : <span data-testid="verify-result" data-verdict={res.verdict}><VerdictBadge run={{ verdict: res.verdict, tampered: r.tampered }} />{res.reasons[0] ? <span style={{ marginLeft: 8, color: "var(--cp-text-2)", fontSize: 12 }}>{res.reasons[0]}</span> : null}</span>
                ) : null}
              </span>,
            ];
          })}
        />
      )}
    </div>
  );
}
