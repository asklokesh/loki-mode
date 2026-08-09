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
 * THE HONESTY RULE THIS PANEL FOLLOWS. Four provenance states, never collapsed:
 *
 *   VERIFIED    integrity holds AND provenance is proven
 *   UNSIGNED    integrity holds, provenance is NOT proven
 *   UNCHECKED   a signature exists but could not be evaluated here
 *   TAMPERED    the recorded hash does not match the contents
 *
 * Collapsing UNCHECKED into UNSIGNED would understate what exists; collapsing
 * UNSIGNED into VERIFIED would claim proof we do not have. Both are the same
 * error pointed in opposite directions, and either one makes the receipt worth
 * less than no receipt at all -- a verification artifact people learn to
 * distrust is worse than none, because it still gets cited.
 */

type Provenance = 'verified' | 'unsigned' | 'unchecked' | 'tampered';

const PROVENANCE: Record<Provenance, {
  badge: string; dot: string; label: string; proven: string; notProven: string;
}> = {
  verified: {
    badge: 'bg-success/10 text-success border-success/20',
    dot: 'bg-success',
    label: 'Verified',
    proven: 'These receipt bytes are unaltered, and they were signed by the holder of the signing key.',
    notProven: 'That the code is correct. A receipt records which checks ran, not that the result is right.',
  },
  unsigned: {
    badge: 'bg-warning/10 text-warning border-warning/20',
    dot: 'bg-warning',
    label: 'Unsigned',
    proven: 'The receipt is internally consistent with its own integrity hash.',
    notProven: 'Who produced it. An unsigned receipt is forgeable: whoever controls the builder can rewrite the facts and recompute the hash.',
  },
  unchecked: {
    badge: 'bg-warning/10 text-warning border-warning/20',
    dot: 'bg-warning',
    label: 'Not checked',
    proven: 'The integrity hash matches, so nothing is wrong with the contents.',
    notProven: 'Provenance. A signature is present but was not evaluated here, which is not the same as a bad signature.',
  },
  tampered: {
    badge: 'bg-danger/10 text-danger border-danger/20',
    dot: 'bg-danger',
    label: 'Tampered',
    proven: 'Nothing. The recorded hash does not match the contents.',
    notProven: 'Anything at all. This receipt was edited after it was written. Do not trust this build.',
  },
};

/**
 * Classify provenance from what the receipt actually carries.
 *
 * Deliberately NOT a full cryptographic verification: the browser cannot check
 * a gpg signature, and claiming to have done so would be the exact dishonesty
 * this panel exists to prevent. A present-but-unevaluated signature is reported
 * as UNCHECKED, with the CLI named as the way to actually verify it.
 */
function classify(detail: ProofDetail | null): Provenance {
  const v = detail?.verification;
  if (!v || !v.hash) return 'unsigned';
  // A signature of either kind is present but not evaluated in-browser.
  if (v.attestation || v.gpg_signature) return 'unchecked';
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
        <span className="text-sm font-medium flex-1 truncate">
          {proof.headline || proof.run_id}
        </span>
        {proof.final_verdict && (
          <span className="text-xs font-mono uppercase tracking-wider flex-shrink-0 text-muted">
            {proof.final_verdict}
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
                     confident wrong number this artifact exists to prevent. */
                  value={
                    typeof detail.cost_usd === 'number'
                      ? `$${detail.cost_usd.toFixed(2)}`
                      : 'unknown'
                  }
                />
                <Field
                  label="Files changed"
                  value={
                    typeof detail.files_changed === 'number'
                      ? String(detail.files_changed)
                      : 'unknown'
                  }
                />
                {detail.verification?.hash && (
                  <Field label="Integrity hash" value={detail.verification.hash} />
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
              </div>

              {/* The browser cannot evaluate a signature, so it names the
                  command that can rather than implying it already did. */}
              {(detail.verification?.attestation || detail.verification?.gpg_signature) && (
                <p className="text-xs text-muted">
                  Verify it yourself:{' '}
                  <code className="font-mono">
                    loki proof verify {detail.run_id}
                    {detail.verification?.attestation ? ' --jwks <url|file>' : ''}
                  </code>
                </p>
              )}

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
