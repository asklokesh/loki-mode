// CPE-26: PR risk. Wraps `loki review --risk --json`; an unmeasured or unparseable result reads "not measured", never 0.
import { useState } from "react";
import { authToken } from "../../api";
import { Badge, Button, Card, Input, KpiTile, Spinner, Table } from "../../design/primitives";
import type { Tone } from "../../design/primitives";

const base = (): string => (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";

export interface Risk { score: number; level: string; source: string; files: number | null; factors: Array<{ factor: string; points: number; max: number; detail: string }> }
type Resp = ({ measured: true } & Risk) | { measured: false; reason?: string };
type Mode = "pr" | "staged" | "since";

const tone = (level: string): Tone => (level === "low" ? "success" : level === "medium" ? "warning" : level === "high" || level === "critical" ? "error" : "neutral");

export function RiskPage() {
  const [mode, setMode] = useState<Mode>("pr");
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Resp | null>(null);

  const ready = mode === "staged" || (mode === "pr" ? /^[0-9]{1,7}$/.test(val) : /^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,99}$/.test(val));
  const measure = async () => {
    setBusy(true);
    const q = mode === "staged" ? "staged=1" : `${mode}=${encodeURIComponent(val)}`;
    try {
      const t = authToken();
      const r = await fetch(`${base()}/v1/review/risk?${q}`, { headers: t ? { authorization: `Bearer ${t}` } : {} });
      const j = (await r.json().catch(() => null)) as (Partial<Risk> & { measured?: boolean; reason?: string; error?: string }) | null;
      setRes(r.ok && j && j.measured === true && typeof j.score === "number" ? (j as Resp) : { measured: false, reason: j?.error ?? j?.reason ?? `HTTP ${r.status}` });
    } catch (e) { setRes({ measured: false, reason: e instanceof Error ? e.message : String(e) }); }
    setBusy(false);
  };

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
      <h1 style={{ margin: 0, fontSize: "var(--cp-text-xl, 20px)" }}>PR risk</h1>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select aria-label="Diff source" value={mode} onChange={(e) => { setMode(e.target.value as Mode); setVal(""); setRes(null); }}>
          <option value="pr">Pull request</option>
          <option value="staged">Staged changes</option>
          <option value="since">Since a ref</option>
        </select>
        {mode !== "staged" ? <Input aria-label={mode === "pr" ? "PR number" : "Git ref"} placeholder={mode === "pr" ? "PR number" : "HEAD~5"} value={val} onChange={(e) => setVal(e.target.value)} /> : null}
        <Button disabled={!ready || busy} onClick={measure}>Measure risk</Button>
        {busy ? <Spinner label="Scoring" /> : null}
      </div>
      {res && res.measured ? (
        <>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <KpiTile label="Risk score" value={`${res.score}/100`} />
            <Badge tone={tone(res.level)}>{res.level}</Badge>
            <small>{res.source}</small>
            <small>{typeof res.files === "number" ? `${res.files} files` : "files: not measured"}</small>
          </div>
          <Table caption="Risk factors" columns={["Factor", "Points", "Detail"]} rows={res.factors.map((f) => [f.factor, `${f.points}/${f.max}`, f.detail])} />
        </>
      ) : res ? (
        <Card><strong>Risk score: not measured</strong><br /><small>{res.reason ?? "no reason reported"}</small></Card>
      ) : null}
    </div>
  );
}

export const page = { id: "risk", path: "/risk", title: "PR risk", component: RiskPage };
