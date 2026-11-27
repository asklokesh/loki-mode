// Defaults: read-only view of the providers on this machine and each repository's project knowledge (CLAUDE.md and notes).
import { useEffect, useState } from "react";
import { getKnowledge, getProviders, type ProviderRow, type RepoKnowledge } from "../api";

export function Defaults({ repos }: { repos: string[] }) {
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [know, setKnow] = useState<RepoKnowledge | null>(null);
  const [kerr, setKerr] = useState<string | null>(null);
  useEffect(() => { getProviders().then((p) => setRows(p.providers)).catch((e: Error) => setErr(e.message)); }, []);
  useEffect(() => { if (!repo && repos[0]) setRepo(repos[0]); }, [repos, repo]);
  useEffect(() => {
    if (!repo) return;
    setKnow(null); setKerr(null);
    getKnowledge(repo).then(setKnow).catch((e: Error) => setKerr(e.message));
  }, [repo]);
  return (
    <section className="page">
      <div className="dwrap">
        <div className="dh"><h2>Defaults</h2><div className="meta">What this machine offers for new work. Read only.</div></div>
        <div className="blk"><h4>Providers</h4>
          {err ? <div className="err">{err}</div> : rows === null ? <div className="empty">Loading</div> : (
            <div className="tw"><table><thead><tr><th>Provider</th><th>Installed</th><th>Signed in</th><th>Planning</th><th>Development</th><th>Fast</th></tr></thead>
              <tbody>{rows.map((p) => <tr key={p.id}><td>{p.id}</td><td>{p.installed ? (p.version ?? "yes") : "no"}</td><td>{p.auth_present ? "key set" : "no key in env"}</td><td>{p.tiers.planning ?? ""}</td><td>{p.tiers.development ?? ""}</td><td>{p.tiers.fast ?? ""}</td></tr>)}</tbody></table></div>
          )}
        </div>
        <div className="blk"><h4>Project knowledge</h4>
          {repos.length === 0 ? <div className="empty">No repository seen yet.</div> : (
            <>
              <label className="hint" htmlFor="kr">Repository </label>
              <select id="kr" value={repo} onChange={(e) => setRepo(e.target.value)} style={{ border: "1px solid var(--line2)", borderRadius: 8, padding: "6px 8px", background: "var(--panel)" }}>{repos.map((r) => <option key={r} value={r}>{r}</option>)}</select>
              {kerr ? <div className="err">{kerr}</div> : know === null ? <div className="empty">Loading</div> : (
                <dl className="kv" style={{ marginTop: 14 }}>
                  {know.instructions.length === 0 ? <><dt>Instructions</dt><dd>none found</dd></> : know.instructions.map((i) => <><dt key={`k${i.path}`}>Instructions</dt><dd key={i.path}>{i.path} ({i.bytes} bytes{i.truncated ? ", truncated" : ""})</dd></>)}
                  {know.notes.map((n) => <><dt key={`n${n.path}`}>Note</dt><dd key={n.path}>{n.path} ({n.bytes} bytes)</dd></>)}
                </dl>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
