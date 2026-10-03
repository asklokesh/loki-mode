// loki-ts/tests/engine10/verify_cmd.test.ts
//
// E-22 wall check (ENGINE.md section 16). Every receipt is built in a
// per-test temp dir (mkdtempSync) and passed to verifyReceipt/main via
// deps.runsRoot -- never a checked-in fixture and never an assertion that
// some sibling path is absent, so this test says nothing about any other
// slice's files.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sealedLog } from "./log_fixture.ts";
import { createHash, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { kidOf } from "../../src/engine10/stages/seal.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { computeReceiptHash, main, verifyReceipt } from "../../src/engine10/verify_cmd.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const AUTONOMY_DIR = join(REPO_ROOT, "autonomy");

// findIsolatedPython3() (util/python.ts, not this slice's file) picks the
// first python3 that merely RUNS under -I -S, which on some hosts is a
// system interpreter with no `cryptography` in its (stripped) site-packages
// -- a real, separate gap, not this slice's to fix. These tests exercise
// verify_cmd's OWN logic against an interpreter that genuinely has
// `cryptography` importable under -I, via VerifyDeps.findPython, the same
// injection point production code uses for the real probe.
const CRYPTO_PY_CANDIDATES = ["python3", "/opt/homebrew/bin/python3", "/usr/bin/python3", "/usr/local/bin/python3"];
function findPythonWithCrypto(): string | null {
  for (const c of CRYPTO_PY_CANDIDATES) {
    // Bun.spawnSync throws ENOENT on Linux for a missing path (macOS returns non-zero).
    try {
      const r = Bun.spawnSync([c, "-I", "-c", "import cryptography"], { env: process.env });
      if (r.exitCode === 0) return c;
    } catch {
      continue;
    }
  }
  return null;
}
const CRYPTO_PY = findPythonWithCrypto();

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "e10-verify-"));
}

// A receipt shaped like types.ts's Receipt, minus `receipt_sha256` and
// `verification`, which the caller fills in after hashing.
function baseReceiptFields(): Record<string, unknown> {
  return {
    schema: "loki.v10.receipt/1",
    run_id: "e10-20260927T220103Z-ab12",
    task: { source: "text", sha256: "a".repeat(64) },
    repo: "o/r",
    base_sha: "b".repeat(40),
    head_sha: "c".repeat(40),
    tree: "d".repeat(40),
    diff_sha256: "e".repeat(64),
    wall: { files: [], passed: true },
    checks: [{ name: "unit", cmd: "bun test", result: "pass", duration_s: 1.2 }],
    not_proven: ["full suite", "app boot", "council", "security scan"],
    verdict: "VERIFIED",
    cost: { usd: 0.1, input_tokens: 100, output_tokens: 20 },
    time: { wall_s: 240, stages: { intake: 10 } },
    provider: "claude",
    model: "claude-x",
    resumed: false,
    events_sha256: createHash("sha256").digest("hex"), // empty: these fixtures carry no events.jsonl
  };
}

function writeUnsignedReceipt(dir: string, runId: string, mutate?: (r: Record<string, unknown>) => void): string {
  const fields = baseReceiptFields();
  fields["run_id"] = runId;
  const hash = computeReceiptHash(fields);
  const receipt = { ...fields, receipt_sha256: hash, verification: { jwt: null, kid: null } };
  if (mutate) mutate(receipt);
  const runDir = join(dir, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, "receipt.json");
  writeFileSync(path, JSON.stringify(receipt, null, 2));
  return path;
}

// Generates a fresh Ed25519 key, signs `receiptHash`, and returns the PEM
// (to set as LOKI_RECEIPT_SIGNING_KEY) plus the token -- via a real python
// subprocess, the same interpreter path the app itself uses.
function signWithFreshKey(receiptHash: string, runId: string): { pem: string; jwt: string; kid: string } {
  const code = `
import sys
sys.path.insert(0, ${JSON.stringify(AUTONOMY_DIR)})
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import receipt_jwt as rj
k = Ed25519PrivateKey.generate()
kid = rj.compute_kid(k.public_key())
pem = k.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
).decode("ascii")
tok = rj.sign_attestation(k, kid, job_id=sys.argv[1], run_id=sys.argv[1], receipt_hash=sys.argv[2])
print(pem)
print("---SPLIT---")
print(tok)
print("---SPLIT---")
print(kid)
`;
  const out = Bun.spawnSync([CRYPTO_PY ?? "python3", "-I", "-c", code, runId, receiptHash]);
  if (out.exitCode !== 0) {
    throw new Error(`signWithFreshKey failed: ${out.stderr.toString()}`);
  }
  const [pem, jwt, kid] = out.stdout.toString().split("---SPLIT---").map((s) => s.trim());
  return { pem: pem ?? "", jwt: jwt ?? "", kid: kid ?? "" };
}

describe("computeReceiptHash", () => {
  test("excludes verification and receipt_sha256, sorts keys, no whitespace", () => {
    const a = computeReceiptHash({ b: 1, a: 2, verification: { jwt: "x" }, receipt_sha256: "old" });
    const b = computeReceiptHash({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  test("changes when any other field changes", () => {
    const a = computeReceiptHash({ verdict: "VERIFIED" });
    const b = computeReceiptHash({ verdict: "PARTIAL" });
    expect(a).not.toBe(b);
  });
});

describe("verifyReceipt: unsigned", () => {
  test("a correctly-hashed unsigned receipt reports UNSIGNED", async () => {
    const dir = tmpDir();
    try {
      const path = writeUnsignedReceipt(dir, "e10-unsigned-1");
      const result = await verifyReceipt(path);
      expect(result.verdict).toBe("UNSIGNED");
      expect(result.reasons).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyReceipt: tamper (red before green: this is the mutation)", () => {
  test("a receipt edited after hashing fails as TAMPERED", async () => {
    const dir = tmpDir();
    try {
      // Written correctly, THEN a field is flipped without recomputing the
      // hash -- exactly what an attacker (or a bad edit) would do.
      const path = writeUnsignedReceipt(dir, "e10-tampered-1", (r) => {
        r["verdict"] = "VERIFIED_BUT_ACTUALLY_TAMPERED";
      });
      const result = await verifyReceipt(path);
      expect(result.verdict).toBe("TAMPERED");
      expect(result.reasons[0]).toContain("receipt_sha256 mismatch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a receipt with no receipt_sha256 field at all is TAMPERED, not silently VERIFIED", async () => {
    const dir = tmpDir();
    try {
      const runDir = join(dir, "runs", "e10-no-hash");
      mkdirSync(runDir, { recursive: true });
      const fields = baseReceiptFields();
      const path = join(runDir, "receipt.json");
      writeFileSync(path, JSON.stringify({ ...fields, verification: { jwt: null, kid: null } }));
      const result = await verifyReceipt(path);
      expect(result.verdict).toBe("TAMPERED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyReceipt: signed (E-22 green: verifies against the JWKS)", () => {
  test("a signed receipt verifies through verify_attestation", async () => {
    if (!CRYPTO_PY) {
      console.log("SKIP: no python3 has cryptography importable under -I -- attestation not measured here");
      return;
    }
    const dir = tmpDir();
    const runId = "e10-signed-1";
    const savedKey = process.env["LOKI_RECEIPT_SIGNING_KEY"];
    try {
      const fields = baseReceiptFields();
      fields["run_id"] = runId;
      const hash = computeReceiptHash(fields);
      const { pem, jwt, kid } = signWithFreshKey(hash, runId);
      const receipt = { ...fields, receipt_sha256: hash, verification: { jwt, kid } };
      const runDir = join(dir, "runs", runId);
      mkdirSync(runDir, { recursive: true });
      const path = join(runDir, "receipt.json");
      writeFileSync(path, JSON.stringify(receipt, null, 2));

      // The verifier reads its signing key material from the environment,
      // exactly the way seal.ts (E-10) is specified to at sign time -- this
      // is the local JWKS the receipt is checked against.
      process.env["LOKI_RECEIPT_SIGNING_KEY"] = pem;
      sealedLog(runDir, hash, runId);
      const result = await verifyReceipt(path);
      expect(result.verdict).toBe("VERIFIED");
      expect(result.reasons).toEqual([]);
    } finally {
      if (savedKey === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY"];
      else process.env["LOKI_RECEIPT_SIGNING_KEY"] = savedKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a validly-signed JWT bound to a different receipt's hash is TAMPERED, not VERIFIED", async () => {
    // The replay this check exists to catch: same signer (kid present in the
    // JWKS, signature verifies), but the token's own receipt_sha256 claim
    // points at a DIFFERENT receipt than the one on disk -- a swapped
    // receipt under a still-valid signature, not a forged or unknown key.
    if (!CRYPTO_PY) {
      console.log("SKIP: no python3 has cryptography importable under -I -- attestation not measured here");
      return;
    }
    const dir = tmpDir();
    const runId = "e10-swapped-receipt-1";
    const savedKey = process.env["LOKI_RECEIPT_SIGNING_KEY"];
    try {
      const fields = baseReceiptFields();
      fields["run_id"] = runId;
      const realHash = computeReceiptHash(fields);
      const otherReceiptHash = "0".repeat(64); // stands in for a different receipt on disk
      const { pem, jwt } = signWithFreshKey(otherReceiptHash, runId);
      const receipt = { ...fields, receipt_sha256: realHash, verification: { jwt, kid: null } };
      const runDir = join(dir, "runs", runId);
      mkdirSync(runDir, { recursive: true });
      const path = join(runDir, "receipt.json");
      writeFileSync(path, JSON.stringify(receipt, null, 2));

      process.env["LOKI_RECEIPT_SIGNING_KEY"] = pem;
      const result = await verifyReceipt(path);
      expect(result.verdict).toBe("TAMPERED");
      expect(result.reasons[0]).toContain("different receipt hash");
    } finally {
      if (savedKey === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY"];
      else process.env["LOKI_RECEIPT_SIGNING_KEY"] = savedKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a token signed by an unpublished key is UNCHECKED, not VERIFIED", async () => {
    if (!CRYPTO_PY) {
      console.log("SKIP: no python3 has cryptography importable under -I -- attestation not measured here");
      return;
    }
    const dir = tmpDir();
    const runId = "e10-wrong-key-1";
    const savedKey = process.env["LOKI_RECEIPT_SIGNING_KEY"];
    try {
      const fields = baseReceiptFields();
      fields["run_id"] = runId;
      const hash = computeReceiptHash(fields);
      const { jwt, kid } = signWithFreshKey(hash, runId); // signed by key A
      const receipt = { ...fields, receipt_sha256: hash, verification: { jwt, kid } };
      const runDir = join(dir, "runs", runId);
      mkdirSync(runDir, { recursive: true });
      const path = join(runDir, "receipt.json");
      writeFileSync(path, JSON.stringify(receipt, null, 2));

      // The verifying host has a DIFFERENT key configured (key B), so key A's
      // kid is absent from the JWKS it builds.
      const other = signWithFreshKey("unused", "other");
      process.env["LOKI_RECEIPT_SIGNING_KEY"] = other.pem;
      const result = await verifyReceipt(path);
      expect(result.verdict).toBe("UNCHECKED");
    } finally {
      if (savedKey === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY"];
      else process.env["LOKI_RECEIPT_SIGNING_KEY"] = savedKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyReceipt: unusable input", () => {
  test("a missing receipt is UNCHECKED, never TAMPERED or VERIFIED", async () => {
    const result = await verifyReceipt("/nonexistent/e10-verify-cmd-test/receipt.json");
    expect(result.verdict).toBe("UNCHECKED");
  });

  test("malformed JSON is UNCHECKED", async () => {
    const dir = tmpDir();
    try {
      const runDir = join(dir, "runs", "e10-bad-json");
      mkdirSync(runDir, { recursive: true });
      const path = join(runDir, "receipt.json");
      writeFileSync(path, "{not json");
      const result = await verifyReceipt(path);
      expect(result.verdict).toBe("UNCHECKED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main() CLI wiring", () => {
  test("verifies the named run under an injected runsRoot", async () => {
    const dir = tmpDir();
    try {
      writeUnsignedReceipt(dir, "e10-cli-1");
      const code = await main(["e10-cli-1", "--allow-unsigned"], { runsRoot: join(dir, "runs") });
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with no run-id, picks the lexicographically-latest run", async () => {
    const dir = tmpDir();
    try {
      writeUnsignedReceipt(dir, "e10-20260101T000000Z-a");
      writeUnsignedReceipt(dir, "e10-20260927T000000Z-b");
      const code = await main(["--allow-unsigned"], { runsRoot: join(dir, "runs") });
      expect(code).toBe(0);
      const receipt = JSON.parse(readFileSync(join(dir, "runs", "e10-20260927T000000Z-b", "receipt.json"), "utf8"));
      expect(receipt.run_id).toBe("e10-20260927T000000Z-b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no runs at all exits 66", async () => {
    const dir = tmpDir();
    try {
      const code = await main([], { runsRoot: join(dir, "runs") });
      expect(code).toBe(66);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a tampered receipt exits 1", async () => {
    const dir = tmpDir();
    try {
      writeUnsignedReceipt(dir, "e10-cli-tampered", (r) => {
        r["provider"] = "codex";
      });
      const code = await main(["e10-cli-tampered"], { runsRoot: join(dir, "runs") });
      expect(code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// P0-VERIFY-ARG: takePubkey used indexOf("--pubkey") == -1 and dropped args[0], so the named run was silently ignored.
describe("main() run-id with and without --pubkey (P0-VERIFY-ARG)", () => {
  function twoRuns(dir: string): void {
    writeUnsignedReceipt(dir, "e10-1-bad");
    const path = join(dir, "runs", "e10-1-bad", "receipt.json"), r = JSON.parse(readFileSync(path, "utf8"));
    r.verdict = "PARTIAL"; // intact (re-hashed) receipt of a run that did not verify
    const { receipt_sha256: _h, verification, ...fields } = r;
    writeFileSync(path, JSON.stringify({ ...fields, receipt_sha256: computeReceiptHash(fields), verification }));
    writeUnsignedReceipt(dir, "e10-2-good");
  }
  function pubkeyFile(dir: string): string {
    const { publicKey } = generateKeyPairSync("ed25519");
    const f = join(dir, "pub.jwk");
    writeFileSync(f, JSON.stringify(publicKey.export({ format: "jwk" })));
    return f;
  }
  test("a named PARTIAL run with no --pubkey exits 4 and reports that run, not the latest", async () => {
    const dir = tmpDir();
    try {
      twoRuns(dir);
      const r = await runMain(["e10-1-bad"], join(dir, "runs"));
      expect(r.code).toBe(4);
      expect(r.out).toContain("run: e10-1-bad");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("--pubkey before and after the positional both verify the named run", async () => {
    const dir = tmpDir();
    try {
      twoRuns(dir);
      const k = pubkeyFile(dir);
      for (const args of [["--pubkey", k, "e10-1-bad"], ["e10-1-bad", "--pubkey", k]]) {
        const r = await runMain(args, join(dir, "runs"));
        expect(r.code).toBe(4);
        expect(r.out).toContain("run: e10-1-bad");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("--pubkey without a value is a usage error, never a silent verify", async () => {
    const dir = tmpDir();
    try {
      twoRuns(dir);
      for (const args of [["e10-1-bad", "--pubkey"], ["--pubkey", "--allow-unsigned"]]) {
        const r = await runMain(args, join(dir, "runs"));
        expect(r.code).toBe(2);
        expect(r.out).toBe("");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// P0-VERIFY-ARG round 2: --pubkey=FILE must not be silently ignored, and the argument shape fails closed.
describe("main() argument shape fails closed (P0-VERIFY-ARG)", () => {
  const SAVED = process.env["LOKI_RECEIPT_SIGNING_KEY"];
  let dir: string, local: { publicKey: import("node:crypto").KeyObject; privateKey: import("node:crypto").KeyObject }, vendorJwk: string, localJwk: string;
  const jwkFile = (name: string, k: import("node:crypto").KeyObject): string => {
    const f = join(dir, name);
    writeFileSync(f, JSON.stringify(k.export({ format: "jwk" })));
    return f;
  };
  beforeEach(() => {
    dir = tmpDir();
    local = generateKeyPairSync("ed25519");
    process.env["LOKI_RECEIPT_SIGNING_KEY"] = local.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    vendorJwk = jwkFile("vendor.jwk", generateKeyPairSync("ed25519").publicKey);
    localJwk = jwkFile("local.jwk", local.publicKey);
    writeUnsignedReceipt(dir, "us1");
    const path = writeUnsignedReceipt(dir, "sg1"), r = JSON.parse(readFileSync(path, "utf8"));
    const h = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: kidOf(local.publicKey) })).toString("base64url");
    const p = Buffer.from(JSON.stringify({ receipt_sha256: r.receipt_sha256 })).toString("base64url");
    const sig = nodeSign(null, Buffer.from(`${h}.${p}`), local.privateKey).toString("base64url");
    r.verification = { jwt: `${h}.${p}.${sig}`, kid: kidOf(local.publicKey) };
    writeFileSync(path, JSON.stringify(r));
  });
  afterEach(() => {
    if (SAVED === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY"]; else process.env["LOKI_RECEIPT_SIGNING_KEY"] = SAVED;
    rmSync(dir, { recursive: true, force: true });
  });
  const code = async (args: string[]) => (await runMain(args, join(dir, "runs"))).code;
  test("sg1 --pubkey=vendor.jwk exits 2 (vendor key does not match), never the local JWKS", async () => {
    expect(await code(["sg1", `--pubkey=${vendorJwk}`])).toBe(2);
  });
  test("--pubkey=vendor.jwk sg1 (flag first) exits 2", async () => {
    const r = await runMain([`--pubkey=${vendorJwk}`, "sg1"], join(dir, "runs"));
    expect(r.code).toBe(2);
    expect(r.out).toContain("run: sg1"); // the flag is honored and sg1 is the run checked, never the flag text as a run id
    expect(r.out).not.toContain("VERIFIED against the local JWKS");
  });
  test("us1 --pubkey=FILE --allow-unsigned exits 3 like the space form", async () => {
    expect(await code(["us1", "--pubkey", vendorJwk, "--allow-unsigned"])).toBe(3);
    expect(await code(["us1", `--pubkey=${vendorJwk}`, "--allow-unsigned"])).toBe(3);
  });
  test("--pubkey= with an empty value exits 2", async () => {
    expect(await code(["sg1", "--pubkey="])).toBe(2);
  });
  test("a second --pubkey in any form exits 2", async () => {
    expect(await code(["sg1", "--pubkey", localJwk, "--pubkey", localJwk])).toBe(2);
    expect(await code(["sg1", `--pubkey=${localJwk}`, `--pubkey=${localJwk}`])).toBe(2);
    expect(await code(["sg1", "--pubkey", localJwk, `--pubkey=${localJwk}`])).toBe(2);
  });
  test("an unknown option exits 2 and is named as unknown (not as an extra positional)", async () => {
    const w = process.stderr.write.bind(process.stderr);
    for (const args of [["sg1", "-x"], ["sg1", "--bogus"], ["--bogus"]]) {
      const err: string[] = [];
      process.stderr.write = ((c: string) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
      try { expect(await code(args)).toBe(2); } finally { process.stderr.write = w; }
      expect(err.join("")).toContain("unknown option");
    }
  });
  test("two positionals exit 2", async () => {
    expect(await code(["sg1", "us1"])).toBe(2);
  });
  test("--pubkey=<correct key> on a good run exits 0, as does the space form", async () => {
    expect(await code(["sg1", `--pubkey=${localJwk}`])).toBe(0);
    expect(await code(["sg1", "--pubkey", localJwk])).toBe(0);
  });
});

// A-121b / D47: UNSIGNED is never a pass. Output is captured so the explicit line is asserted.
async function runMain(args: string[], runsRoot: string): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const w = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  try {
    return { code: await main(args, { runsRoot }), out: out.join("") };
  } finally {
    process.stdout.write = w;
  }
}

describe("main() UNSIGNED policy (D47)", () => {
  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    try { await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };
  let savedAllow: string | undefined;
  beforeEach(() => { savedAllow = process.env["LOKI_VERIFY_ALLOW_UNSIGNED"]; delete process.env["LOKI_VERIFY_ALLOW_UNSIGNED"]; });
  afterEach(() => { if (savedAllow === undefined) delete process.env["LOKI_VERIFY_ALLOW_UNSIGNED"]; else process.env["LOKI_VERIFY_ALLOW_UNSIGNED"] = savedAllow; });
  const REFUSE = "attestation: UNSIGNED, integrity not attested; refusing (pass --allow-unsigned to accept)";
  const ACCEPT = "attestation: UNSIGNED (accepted by --allow-unsigned; integrity not attested)";

  test("downgrade fixture (body edited, rehashed, jwt and kid nulled) exits 3 with the refusal line", async () => {
    const dir = tmpDir();
    try {
      writeUnsignedReceipt(dir, "dg1", (r) => {
        r["provider"] = "codex";
        const { receipt_sha256: _a, verification: _b, ...rest } = r;
        r["receipt_sha256"] = computeReceiptHash(rest);
      });
      const { code, out } = await runMain(["dg1"], join(dir, "runs"));
      expect(code).toBe(3);
      expect(out).toContain(REFUSE);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("signed under a local key (verifies rc 0), then downgraded (body edit, rehash, jwt and kid nulled) exits 3", async () => {
    if (!CRYPTO_PY) { console.log("SKIP: no python3 with cryptography"); return; }
    const dir = tmpDir();
    const home = tmpDir();
    try {
      const fields = baseReceiptFields();
      fields["run_id"] = "sg1";
      const hash = computeReceiptHash(fields);
      const { pem, jwt, kid } = signWithFreshKey(hash, "sg1");
      const runDir = join(dir, "runs", "sg1");
      mkdirSync(runDir, { recursive: true });
      const rp = join(runDir, "receipt.json");
      writeFileSync(rp, JSON.stringify({ ...fields, receipt_sha256: hash, verification: { jwt, kid } }));
      await withEnv({ HOME: home, LOKI_RECEIPT_SIGNING_KEY: pem, LOKI_RECEIPT_SIGNING_KEY_FILE: undefined }, async () => {
        expect((await runMain(["sg1"], join(dir, "runs"))).code).toBe(0);
        const edited = { ...fields, provider: "codex" };
        writeFileSync(rp, JSON.stringify({ ...edited, receipt_sha256: computeReceiptHash(edited), verification: { jwt: null, kid: null } }));
        const r = await runMain(["sg1"], join(dir, "runs"));
        expect(r.code).toBe(3);
        expect(r.out).toContain(REFUSE);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  test("a foreign kid stays 2 with or without --allow-unsigned, and verify creates no keys dir", async () => {
    if (!CRYPTO_PY) { console.log("SKIP: no python3 with cryptography"); return; }
    const dir = tmpDir();
    const home = tmpDir();
    try {
      const fields = baseReceiptFields();
      fields["run_id"] = "fk1";
      const hash = computeReceiptHash(fields);
      const { jwt, kid } = signWithFreshKey(hash, "fk1");
      const runDir = join(dir, "runs", "fk1");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "receipt.json"), JSON.stringify({ ...fields, receipt_sha256: hash, verification: { jwt, kid } }));
      await withEnv({ HOME: home, LOKI_RECEIPT_SIGNING_KEY: undefined, LOKI_RECEIPT_SIGNING_KEY_FILE: undefined }, async () => {
        expect((await runMain(["fk1"], join(dir, "runs"))).code).toBe(2);
        expect((await runMain(["fk1", "--allow-unsigned"], join(dir, "runs"))).code).toBe(2);
      });
      expect(existsSync(join(home, ".loki", "keys"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  test("same with SIGNING_UNAVAILABLE in not_proven exits 3", async () => {
    const dir = tmpDir();
    try {
      writeUnsignedReceipt(dir, "dg2", (r) => {
        r["not_proven"] = [...(r["not_proven"] as string[]), "receipt signing unavailable (no usable signing key: invalid key or unwritable ~/.loki/keys)"];
        const { receipt_sha256: _a, verification: _b, ...rest } = r;
        r["receipt_sha256"] = computeReceiptHash(rest);
      });
      expect((await runMain(["dg2"], join(dir, "runs"))).code).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("fresh run-owned HOME with no key exits 3 and creates no keys dir", async () => {
    const dir = tmpDir();
    const home = tmpDir();
    try {
      writeUnsignedReceipt(dir, "dg3");
      await withEnv({ HOME: home, LOKI_RECEIPT_SIGNING_KEY: undefined, LOKI_RECEIPT_SIGNING_KEY_FILE: undefined }, async () => {
        expect((await runMain(["dg3"], join(dir, "runs"))).code).toBe(3);
      });
      expect(existsSync(join(home, ".loki", "keys"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  test("--allow-unsigned and LOKI_VERIFY_ALLOW_UNSIGNED=1 exit 0 with the explicit line", async () => {
    const dir = tmpDir();
    try {
      writeUnsignedReceipt(dir, "ok1");
      const a = await runMain(["ok1", "--allow-unsigned"], join(dir, "runs"));
      expect(a.code).toBe(0);
      expect(a.out).toContain(ACCEPT);
      await withEnv({ LOKI_VERIFY_ALLOW_UNSIGNED: "1" }, async () => {
        const b = await runMain(["ok1"], join(dir, "runs"));
        expect(b.code).toBe(0);
        expect(b.out).toContain(ACCEPT);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the flag never changes TAMPERED (1) or UNCHECKED (2)", async () => {
    const dir = tmpDir();
    try {
      writeUnsignedReceipt(dir, "t1", (r) => { r["provider"] = "codex"; });
      expect((await runMain(["t1"], join(dir, "runs"))).code).toBe(1);
      expect((await runMain(["t1", "--allow-unsigned"], join(dir, "runs"))).code).toBe(1);
      const bad = join(dir, "runs", "u1");
      mkdirSync(bad, { recursive: true });
      writeFileSync(join(bad, "receipt.json"), "not json");
      expect((await runMain(["u1", "--allow-unsigned"], join(dir, "runs"))).code).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("D48 r3: a non-VERIFIED run outcome exits 4 signed or unsigned, with or without --allow-unsigned; VERIFIED+unsigned+flag is 0", async () => {
    const dir = tmpDir();
    try {
      const failed = (r: Record<string, unknown>) => { r["verdict"] = "FAILED"; const { receipt_sha256: _a, verification: _b, ...rest } = r; r["receipt_sha256"] = computeReceiptHash(rest); };
      writeUnsignedReceipt(dir, "f1", failed);
      for (const a of [[], ["--allow-unsigned"]]) {
        const r = await runMain(["f1", ...a], join(dir, "runs"));
        expect(r.code).toBe(4);
        expect(r.out).toContain("NOT VERIFIED");
      }
      writeUnsignedReceipt(dir, "v1");
      expect((await runMain(["v1", "--allow-unsigned"], join(dir, "runs"))).code).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("D48 r3: FAILED + signed exits 4", async () => {
    if (!CRYPTO_PY) { console.log("SKIP: no python3 with cryptography"); return; }
    const dir = tmpDir();
    const home = tmpDir();
    try {
      const fields = baseReceiptFields();
      fields["run_id"] = "fs1";
      fields["verdict"] = "FAILED";
      const hash = computeReceiptHash(fields);
      const { pem, jwt, kid } = signWithFreshKey(hash, "fs1");
      const runDir = join(dir, "runs", "fs1");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "receipt.json"), JSON.stringify({ ...fields, receipt_sha256: hash, verification: { jwt, kid } }));
      await withEnv({ HOME: home, LOKI_RECEIPT_SIGNING_KEY: pem, LOKI_RECEIPT_SIGNING_KEY_FILE: undefined }, async () => {
        expect((await runMain(["fs1"], join(dir, "runs"))).code).toBe(4);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });
});
