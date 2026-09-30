// E-154: no bun test may write the real ~/.loki/keys. Default the signing key
// file to a throwaway dir unless the caller already set one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]) {
  const dir = mkdtempSync(join(tmpdir(), "loki-test-key-"));
  process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(dir, "receipt-ed25519.pem");
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
}
