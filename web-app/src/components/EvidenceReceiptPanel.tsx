import { useEffect, useState } from 'react';
import { api, type ProofSummary, type ProofDetail, type ProofsSummary } from '../api/client';

/**
 * The Evidence Receipt, surfaced in the UI.
 *
 * WHY THIS EXISTS. The backend has served /api/proofs since it shipped and
 * nothing in the web app ever called it. A measured audit of six installed
 * competitor CLIs (including Factory's droid) found none exposing an
 * output-verification command -- so the one thing nobody else has was visible
 * only to people using the terminal.
 *
 * THE HONESTY RULE THIS PANEL FOLLOWS. Every state comes from a verdict the
 * SERVER COMPUTED (integrity_check on GET /api/proofs/<id>, which runs the CLI
 * verifier's integrity checks), never from what the receipt merely carries:
 *
 *   VERIFIED      the hash was recomputed and matches AND the gpg signature verified
 *   UNSIGNED      the hash was recomputed and matches, no signature to check
 *   UNCHECKED     the hash matches, a signature exists but was not evaluated here
 *   TAMPERED      the recomputed hash does not match the contents
 *   FAILED        a check ran and said no (bad signature, self-contradiction)
 *   NOT VERIFIED  nothing was checked here (no hash, or no server verdict)
 *
 * Collapsing UNCHECKED into UNSIGNED would understate what exists; collapsing
 * UNSIGNED into VERIFIED would claim proof we do not have. Both are the same
 * error pointed in opposite directions, and either one makes the receipt worth
 * less than no receipt at all -- a verification artifact people learn to
 * distrust is worse than none, because it still gets cited.
 */

type Provenance = 'verified' | 'unsigned' | 'unchecked' | 'tampered' | 'failed' | 'not_verified';

const PROVENANCE: Record<Provenance, {
  badge: string; dot: string; label: string; proven: string; notProven: string;
}> = {
  verified: {
    badge: 'bg-success/10 text-success border-success/20',
    dot: 'bg-success',
    label: 'Verified',
    proven: 'The server recomputed the integrity hash and it matches, and the gpg signature verified against its keyring.',
    notProven: 'That the code is correct, or that the recorded diff still matches your repo. A receipt records which checks ran, not that the result is right.',
  },
  unsigned: {
    badge: 'bg-warning/10 text-warning border-warning/20',
    dot: 'bg-warning',
    label: 'Unsigned',
    proven: 'The server recomputed the integrity hash and it matches these receipt bytes.',
    notProven: 'Who produced it. An unsigned receipt is forgeable: whoever controls the builder can rewrite the facts and recompute the hash.',
  },
  unchecked: {
    badge: 'bg-warning/10 text-warning border-warning/20',
    dot: 'bg-warning',
    label: 'Not checked',
    proven: 'The server recomputed the integrity hash and it matches.',
    notProven: 'Provenance. A signature is present but was not evaluated here, which is not the same as a bad signature.',
  },
  tampered: {
    badge: 'bg-danger/10 text-danger border-danger/20',
    dot: 'bg-danger',
    label: 'Tampered',
    proven: 'Nothing. The server recomputed the integrity hash and it does not match the contents.',
    notProven: 'Anything at all. This receipt was edited after it was written. Do not trust this build.',
  },
  failed: {
    badge: 'bg-danger/10 text-danger border-danger/20',
    dot: 'bg-danger',
    label: 'Failed verification',
    proven: 'Nothing. A verification check ran on the server and said no.',
    notProven: 'Anything the receipt claims. Read the reason below.',
  },
  not_verified: {
    badge: 'border-muted/20 text-muted',
    dot: 'bg-muted/40',
    label: 'Not verified here',
    proven: 'Nothing. No verification result was computed for this receipt here.',
    notProven: 'Integrity or provenance. Run the command below to check it yourself.',
  },
};

/**
 * Map the server's computed integrity_check onto a provenance state.
 *
 * The browser recomputes nothing and evaluates no signature, so every positive
 * state here needs the server's `status: 'verified'` behind it. No result (an
 * older server, a receipt with no hash) is NOT VERIFIED, never a pass.
 */
function classify(detail: ProofDetail | null): Provenance {
  const check = detail?.integrity_check;
  const v = detail?.verification;
  if (!check) return 'not_verified';
  if (check.status === 'tampered') return 'tampered';
  if (check.status === 'failed') return 'failed';
  if (check.status !== 'verified') return 'not_verified';
  if (check.gpg_ok === true) return 'verified';
  // A signature is present but was not evaluated (a JWKS attestation always;
  // a gpg signature when gpg is absent on the server).
  if (v?.attestation || v?.gpg_signature) return 'unchecked';
  return 'unsigned';
}

/**
 * Verdict distribution across every receipt in the project.
 *
 * `unknown` IS RENDERED, ALWAYS, and that is the point of this strip. The
 * endpoint deliberately refuses to count a receipt as verified when it cannot
 * prove it was (schema v1.0 proofs carry no honesty block), so hiding that
 * bucket in the UI would launder "we do not know" into an implied pass and
 * undo the one guarantee the aggregate makes.
 *
 * It also does NOT re-verify anything: these are the headlines the generator
 * recorded. On the unsigned path the generator is trusted, so the footnote says
 * so rather than letting a green count imply adversarial proof.
 */
const BUCKETS: Array<{ key: keyof ProofsSummary; label: string; bar: string; text: string }> = [
  { key: 'verified', label: 'Verified', bar: 'bg-success', text: 'text-success' },
  { key: 'with_gaps', label: 'With gaps', bar: 'bg-warning', text: 'text-warning' },
  { key: 'not_verified', label: 'Not verified', bar: 'bg-danger', text: 'text-danger' },
  { key: 'unknown', label: 'Unknown', bar: 'bg-muted/40', text: 'text-muted' },
];

function SummaryStrip({ summary }: { summary: ProofsSummary }) {
  const total = summary.total_receipts;
  if (!total) return null;

  return (
    <div className="space-y-2">
      <div className="flex h-1.5 rounded-full overflow-hidden bg-muted/10">
        {BUCKETS.map(({ key, bar }) => {
          const n = summary[key];
          if (!n) return null;
          return (
            <div
              key={key}
              className={bar}
              style={{ width: `${(n / total) * 100}%` }}
              title={`${n} ${key}`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {BUCKETS.map(({ key, label, text }) => {
          const n = summary[key];
          if (!n) return null;
          return (
            <span key={key} className={text}>
              <span className="font-semibold">{n}</span> {label.toLowerCase()}
            </span>
          );
        })}
      </div>
      {/* Stated, never implied. A count of "verified" here is the generator's
          own recorded headline; adversarial non-forgeability needs the signed
          record, which only `loki proof verify` can actually check. */}
      <p className="text-muted text-xs">
        Recorded verdicts across {total} receipt{total === 1 ? '' : 's'}, not re-verified here.
      </p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="text-muted w-28 flex-shrink-0">{label}</span>
      <span className="font-mono truncate" title={value}>{value}</span>
    </div>
  );
}

function ReceiptRow({ proof }: { proof: ProofSummary }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ProofDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || detail || error) return;
    let cancelled = false;
    api.getProof(proof.run_id)
      .then((d) => { if (!cancelled) setDetail(d); })
      // Named, never swallowed: a receipt that fails to load must not render as
      // an absent one. "No receipt" and "could not read the receipt" are
      // different facts and the user needs to know which they are looking at.
      .catch((e) => { if (!cancelled) setError(e?.message || 'could not load this receipt'); });
    return () => { cancelled = true; };
  }, [open, proof.run_id, detail, error]);

  const prov = PROVENANCE[classify(detail)];
  const when = proof.generated_at
    ? new Date(proof.generated_at).toLocaleString()
    : 'unknown';

  return (
    <div className={`border rounded-card overflow-hidden ${detail ? prov.badge : 'border-muted/20'}`}>
      <button
        type="button"
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${detail ? prov.dot : 'bg-muted/40'}`} />
        {/* Recorded values, labelled as such: the computed verdict is the
            badge inside, fetched when the row opens. */}
        <span className="text-sm font-medium flex-1 truncate">
          {proof.headline ? `Recorded: ${proof.headline}` : proof.run_id}
        </span>
        {proof.final_verdict && (
          <span className="text-xs font-mono uppercase tracking-wider flex-shrink-0 text-muted">
            council {proof.final_verdict}
          </span>
        )}
        <span className="text-muted text-xs flex-shrink-0">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-current/10 pt-3">
          {error && (
            <p className="text-xs text-danger">
              Could not load this receipt: {error}
            </p>
          )}
          {!error && !detail && <p className="text-xs text-muted">Loading receipt…</p>}

          {detail && (
            <>
              <div className="space-y-1">
                <Field label="Run" value={detail.run_id} />
                <Field label="Generated" value={when} />
                <Field label="Loki version" value={detail.loki_version || 'unknown'} />
                <Field
                  label="Cost"
                  /* An absent cost reads UNKNOWN, never $0.00 -- a fabricated
                     zero in a verification surface is precisely the kind of
                     confident wrong number this artifact exists to prevent.
                     GET /api/proofs/<run_id> returns the raw proof.json, where
                     cost is nested as cost.usd (see autonomy/lib/proof-generator.py
                     and loki-ts/src/commands/proof.ts), not a flat cost_usd --
                     that flat field only exists on the /api/proofs summary rows.
                     A partly priced run's cost is a lower bound (cost_partial,
                     efficiency_cost.py), so it reads "at least", like cost.html. */
                  value={
                    typeof detail.cost?.usd === 'number'
                      ? `${detail.cost.cost_partial === true ? 'at least ' : ''}$${detail.cost.usd.toFixed(2)}`
                      : 'unknown'
                  }
                />
                <Field
                  label="Files changed"
                  /* Same nesting: files_changed is an object with a `count`
                     field in the raw proof.json (files_changed.count), not a
                     flat number. ProofDetail has no typed shape for this
                     nested object, so it is narrowed locally. */
                  value={
                    typeof (detail.files_changed as unknown as { count?: number } | null)?.count === 'number'
                      ? String((detail.files_changed as unknown as { count: number }).count)
                      : 'unknown'
                  }
                />
                {detail.verification?.hash && (
                  <Field label="Recorded hash" value={detail.verification.hash} />
                )}
              </div>

              <div className={`rounded-card border px-3 py-2 ${prov.badge}`}>
                <p className="text-xs font-semibold uppercase tracking-wider mb-1">
                  {prov.label}
                </p>
                <p className="text-xs mb-1">
                  <span className="font-semibold">Proven: </span>{prov.proven}
                </p>
                <p className="text-xs opacity-80">
                  <span className="font-semibold">Not proven: </span>{prov.notProven}
                </p>
                {(detail.integrity_check?.reasons || []).slice(0, 2).map((r) => (
                  <p key={r} className="text-xs opacity-80 mt-1">{r}</p>
                ))}
              </div>

              {/* Always named: the server never re-derives the diff, and the
                  browser evaluates no signature. The CLI does both. */}
              <p className="text-xs text-muted">
                Verify it yourself (also re-derives the diff against your repo):{' '}
                <code className="font-mono">
                  loki proof verify {detail.run_id}
                  {detail.verification?.attestation ? ' --jwks <url|file>' : ''}
                </code>
              </p>

              {proof.pr_url && (
                <a
                  href={proof.pr_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-xs text-primary underline"
                >
                  View the pull request
                </a>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function EvidenceReceiptPanel() {
  const [proofs, setProofs] = useState<ProofSummary[] | null>(null);
  const [summary, setSummary] = useState<ProofsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listProofs()
      .then((r) => { if (!cancelled) setProofs(r.proofs || []); })
      .catch((e) => { if (!cancelled) setError(e?.message || 'could not load receipts'); });
    // Fetched independently: a failing summary must not blank the list, which
    // is the more useful of the two. Its failure is silent because the list
    // below already carries every verdict -- the strip is an at-a-glance
    // convenience, not the source of truth.
    api.proofsSummary()
      .then((s) => { if (!cancelled) setSummary(s); })
      .catch(() => { /* strip is omitted; the list still renders */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Evidence Receipts</h2>
        <p className="text-muted text-xs mt-1">
          What each build actually checked, recorded so you can verify it yourself.
        </p>
      </div>

      {error && <p className="text-xs text-danger">Could not load receipts: {error}</p>}
      {!error && proofs === null && <p className="text-xs text-muted">Loading…</p>}

      {summary && <SummaryStrip summary={summary} />}

      {/* An empty state that explains itself. "No receipts" with no reason
          reads like a broken panel, and a user cannot tell that apart from a
          project that simply has not built anything yet. */}
      {proofs !== null && proofs.length === 0 && (
        <p className="text-xs text-muted">
          No receipts yet. One is written at the end of each run
          (set <code className="font-mono">LOKI_PROOF=0</code> to opt out).
        </p>
      )}

      <div className="space-y-2">
        {proofs?.map((p) => <ReceiptRow key={p.run_id} proof={p} />)}
      </div>
    </section>
  );
}
