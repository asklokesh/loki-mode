// E-154: no bun test may write the real ~/.loki/keys. Default the signing key
// file to a throwaway dir unless the caller already set one.
// E-154b: bun test never fires process "exit", so cleanup hangs off a bun:test
// afterAll; the dir is removed again (idempotent) after every file.
import { afterAll, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECEIPT_SIGNER_BASENAME } from "../src/util/receipt_signer.ts";

// C2-F: runs ship to a discovered local Control Plane by default; no test may reach a developer's live instance.
if (process.env["LOKI_CONTROL"] === undefined) process.env["LOKI_CONTROL"] = "0";

// FC-07 / D86: no bun test may touch the real ~/.loki (control, dashboard registry, keys,
// answers) or ~/.gitconfig. HOME becomes a run-owned temp dir unless a parent entry point
// (run-all-tests.sh, local-ci.sh) already isolated it. The real HOME stays readable as
// LOKI_REAL_HOME, and toolchain homes stay pinned so nothing re-downloads.
if (process.env["LOKI_HERMETIC_HOME"] === undefined || process.env["HOME"] !== process.env["LOKI_HERMETIC_HOME"]) {
  // Never trust an inherited LOKI_REAL_HOME: HOME is not hermetic here, so HOME is the real home.
  const realHome = process.env["HOME"] ?? "";
  if (realHome) {
    process.env["LOKI_REAL_HOME"] = realHome;
    process.env["BUN_INSTALL"] ??= join(realHome, ".bun");
    process.env["CARGO_HOME"] ??= join(realHome, ".cargo");
    process.env["RUSTUP_HOME"] ??= join(realHome, ".rustup");
    process.env["GOPATH"] ??= join(realHome, "go");
    process.env["npm_config_cache"] ??= join(realHome, ".npm");
    const hermetic = mkdtempSync(join(tmpdir(), "loki-test-home-"));
    const seedHome = (): void => {
      mkdirSync(hermetic, { recursive: true, mode: 0o700 });
      writeFileSync(join(hermetic, ".gitconfig"), "[user]\n\tname = loki-test\n\temail = loki-test@example.invalid\n");
    };
    seedHome();
    process.env["LOKI_HERMETIC_HOME"] = hermetic;
    process.env["HOME"] = hermetic;
    process.env["GIT_CONFIG_GLOBAL"] = join(hermetic, ".gitconfig");
    // Same lifecycle as the key dir below: removed after every file, recreated before the next.
    beforeAll(seedHome);
    afterAll(() => {
      rmSync(hermetic, { recursive: true, force: true });
    });
  }
}

if (!process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]) {
  const dir = mkdtempSync(join(tmpdir(), "loki-test-key-"));
  process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(dir, RECEIPT_SIGNER_BASENAME);
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}
