// Receipt verify and public key (CPE-16). Calls the engine's own verifyReceipt in process (loki-ts verify_cmd.ts), never reimplements the crypto.
// Read-only: it reads <repo>/.loki/runs/<run>/receipt.json (and events.jsonl beside it) and writes nothing. Loopback-only (on `act`), same path containment as the artifacts route.
import { readFileSync, realpathSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { join, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import { localRepos, runs } from "../../db/schema.ts";
import { verifyReceipt } from "../../../../../loki-ts/src/engine10/verify_cmd.ts";
import { kidOf, loadSigningKey } from "../../../../../loki-ts/src/engine10/stages/seal.ts";
import { outcomeOf, runIdGuard } from "../../../../../loki-ts/src/features/receipt_dsse.ts";
import { audit } from "../audit.ts";
import type { RouteCtx } from "./index.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const safeId = (s: string) => ID.test(s) && !s.includes("..");

export function mount(ctx: RouteCtx): void {
  const { act, db } = ctx;

  act.post("/v1/runs/:source/:run/verify", async (c) => {
    const source = c.req.param("source"), run = c.req.param("run");
    const target = `${source}/${run}`;
    const done = (status: 403 | 404, error: string, result: string) => { audit(db, { kind: "receipt.verify", target, result, detail: error }); return c.json({ error }, status); };
    if (!ctx.local(c)) return done(403, "loopback only", "refused");
    if (!safeId(source) || !safeId(run)) return done(404, "run not found", "not_found");
    const known = db.select({ r: runs.runId }).from(runs).where(and(eq(runs.sourceId, source), eq(runs.runId, run))).get();
    if (!known) return done(404, "run not found", "not_found");
    const repo = db.select({ p: localRepos.realpath }).from(localRepos).where(eq(localRepos.sourceId, source)).get();
    if (!repo) return done(404, "receipt not available", "not_found");
    let runDir: string, file: string;
    try {
      const root = realpathSync(join(repo.p, ".loki", "runs"));
      runDir = realpathSync(join(root, run));
      if (runDir !== join(root, run)) return done(404, "receipt not found", "not_found");
      file = realpathSync(join(runDir, "receipt.json"));
    } catch { return done(404, "receipt not found", "not_found"); }
    if (!file.startsWith(runDir + sep)) return done(404, "receipt not found", "not_found");
    // Same order as `loki verify <run-id>`: the envelope must describe this run, then integrity, then the run outcome.
    let integrity: string, reasons: string[], sha: string | null = null, outcome = "UNREADABLE";
    try {
      const bad = runIdGuard(file, run);
      if (bad) { integrity = "TAMPERED"; reasons = [bad]; }
      else { const r = await verifyReceipt(file); integrity = r.verdict; reasons = r.reasons; sha = r.receiptSha256 ?? null; }
      try { outcome = outcomeOf(JSON.parse(readFileSync(file, "utf8"))); } catch { outcome = "UNREADABLE"; }
    } catch (e) {
      integrity = "UNCHECKED"; reasons = [`verifier error: ${(e as Error).message}`];
    }
    // Intact does not mean passing: an intact receipt of a run that did not verify is NOT_VERIFIED, as in the CLI (exit 4).
    const intact = integrity === "VERIFIED" || integrity === "UNSIGNED";
    const passing = outcome === "VERIFIED" || outcome === "ALREADY_SATISFIED";
    let verdict = integrity;
    if (intact && !passing) { verdict = "NOT_VERIFIED"; reasons = [`run outcome ${outcome}; receipt integrity ${integrity === "UNSIGNED" ? "unattested" : "intact"}`, ...reasons]; }
    audit(db, { kind: "receipt.verify", target, result: verdict.toLowerCase(), detail: reasons[0] });
    return c.json({ run, verdict, integrity, outcome, reasons, receipt_sha256: sha, verified_at: new Date().toISOString() });
  });

  // The public half of the receipt signer as a JWK. The private key never leaves loadSigningKey.
  act.get("/v1/keys", (c) => {
    if (!ctx.peerIsLoopback(c)) { audit(db, { kind: "keys.read", result: "refused", detail: "loopback only" }); return c.json({ error: "loopback only" }, 403); }
    const priv = loadSigningKey(false);
    if (!priv) { audit(db, { kind: "keys.read", result: "no_key" }); return c.json({ error: "no signing key on this machine (run a sealed build first or set LOKI_RECEIPT_SIGNING_KEY_FILE)" }, 404); }
    const pub = createPublicKey(priv), { kty, crv, x } = pub.export({ format: "jwk" });
    audit(db, { kind: "keys.read", result: "ok" });
    return c.json({ kty, crv, x, kid: kidOf(pub), alg: "EdDSA", use: "sig" });
  });
}
