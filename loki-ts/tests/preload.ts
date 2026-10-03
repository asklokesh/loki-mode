// E-154: no bun test may write the real ~/.loki/keys. Default the signing key
// file to a throwaway dir unless the caller already set one.
// E-154b: bun test never fires process "exit", so cleanup hangs off a bun:test
// afterAll; the dir is removed again (idempotent) after every file.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECEIPT_SIGNER_BASENAME } from "../src/util/receipt_signer.ts";

// C2-F: runs ship to a discovered local Control Plane by default; no test may reach a developer's live instance.
if (process.env["LOKI_CONTROL"] === undefined) process.env["LOKI_CONTROL"] = "0";

// EL-W1-01: intake runs a model discovery session; no test may spend one (project_model tests call it directly).
if (process.env["LOKI_E10_PROJECT_MODEL"] === undefined) process.env["LOKI_E10_PROJECT_MODEL"] = "0";

if (!process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]) {
  const dir = mkdtempSync(join(tmpdir(), "loki-test-key-"));
  process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(dir, RECEIPT_SIGNER_BASENAME);
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}
