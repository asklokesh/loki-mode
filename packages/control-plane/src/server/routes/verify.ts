// Receipt verify and public key (CPE-16). Calls the engine's own verifyReceipt in process (loki-ts verify_cmd.ts), never reimplements the crypto.
// Read-only: it reads <repo>/.loki/runs/<run>/receipt.json (and events.jsonl beside it) and writes nothing. Loopback-only (on `act`), same path containment as the artifacts route.
import { realpathSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { join, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import { localRepos, runs } from "../../db/schema.ts";
import { verifyReceipt } from "../../../../../loki-ts/src/engine10/verify_cmd.ts";
import { kidOf, loadSigningKey } from "../../../../../loki-ts/src/engine10/stages/seal.ts";
import { audit } from "../audit.ts";
import type { RouteCtx } from "./index.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const safeId = (s: string) => ID.test(s) && !s.includes("..");

export function mount(ctx: RouteCtx): void {
  const { act, db } = ctx;

  act.post("/v1/runs/:source/:run/verify", async (c) => {
    if (!ctx.local(c)) return c.json({ error: "loopback only" }, 403);
    const source = c.req.param("source"), run = c.req.param("run");
    if (!safeId(source) || !safeId(run)) return c.json({ error: "run not found" }, 404);
    const known = db.select({ r: runs.runId }).from(runs).where(and(eq(runs.sourceId, source), eq(runs.runId, run))).get();
    if (!known) return c.json({ error: "run not found" }, 404);
    const repo = db.select({ p: localRepos.realpath }).from(localRepos).where(eq(localRepos.sourceId, source)).get();
    if (!repo) return c.json({ error: "receipt not available" }, 404);
    let runDir: string, file: string;
    try {
      const root = realpathSync(join(repo.p, ".loki", "runs"));
      runDir = realpathSync(join(root, run));
      if (runDir !== join(root, run)) return c.json({ error: "receipt not found" }, 404);
      file = realpathSync(join(runDir, "receipt.json"));
    } catch { return c.json({ error: "receipt not found" }, 404); }
    if (!file.startsWith(runDir + sep)) return c.json({ error: "receipt not found" }, 404);
    const r = await verifyReceipt(file);
    audit(db, { kind: "receipt.verify", target: `${source}/${run}`, result: r.verdict.toLowerCase() });
    return c.json({ run, verdict: r.verdict, reasons: r.reasons, receipt_sha256: r.receiptSha256 ?? null, verified_at: new Date().toISOString() });
  });

  // The public half of the receipt signer as a JWK. The private key never leaves loadSigningKey.
  act.get("/v1/keys", (c) => {
    if (!ctx.peerIsLoopback(c)) return c.json({ error: "loopback only" }, 403);
    const priv = loadSigningKey(false);
    if (!priv) return c.json({ error: "no signing key on this machine (run a sealed build first or set LOKI_RECEIPT_SIGNING_KEY_FILE)" }, 404);
    const pub = createPublicKey(priv), { kty, crv, x } = pub.export({ format: "jwk" });
    return c.json({ kty, crv, x, kid: kidOf(pub), alg: "EdDSA", use: "sig" });
  });
}
