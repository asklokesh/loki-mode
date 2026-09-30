// E-154: no bun test may write the real ~/.loki/keys. Default the signing key
// file to a throwaway dir unless the caller already set one.
// E-154b: bun test never fires process "exit", so cleanup hangs off a bun:test
// afterAll; the dir is removed again (idempotent) after every file.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]) {
  const dir = mkdtempSync(join(tmpdir(), "loki-test-key-"));
  process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(dir, "receipt-ed25519.pem");
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}
