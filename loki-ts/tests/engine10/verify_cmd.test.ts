// loki-ts/tests/engine10/verify_cmd.test.ts
//
// E-22 wall check (ENGINE.md section 16). Every receipt is built in a
// per-test temp dir (mkdtempSync) and passed to verifyReceipt/main via
// deps.runsRoot -- never a checked-in fixture and never an assertion that
// some sibling path is absent, so this test says nothing about any other
// slice's files.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sealedLog } from "./log_fixture.ts";
import { createHash, generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import { kidOf } from "../../src/engine10/stages/seal.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    time: { wall_s: 0, stages: {} }, // zero stages: a receipt that records no events may carry the empty-log hash
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

describe("verifyReceipt: unrecognized schema (P12-01d)", () => {
  const rehash = (r: Record<string, unknown>) => { const { receipt_sha256: _h, verification: _v, ...rest } = r; r["receipt_sha256"] = computeReceiptHash(rest); };
  for (const [name, schema] of [["renamed", "loki.v10.receipt/2"], ["removed", undefined], ["non-string", 7], ["empty", ""], ["null", null], ["case-variant", "LOKI.V10.RECEIPT/1"]] as const) {
    test(`a correctly re-hashed unsigned receipt with a ${name} schema is TAMPERED, not UNSIGNED, and exits non-zero`, async () => {
      const dir = tmpDir();
      try {
        const path = writeUnsignedReceipt(dir, "e10-schema-" + name, (r) => { if (schema === undefined) delete r["schema"]; else r["schema"] = schema; rehash(r); });
        const result = await verifyReceipt(path);
        expect(result.verdict).toBe("TAMPERED");
        expect(result.reasons.join(" ")).toContain("unrecognized receipt schema");
        expect(await main(["e10-schema-" + name, "--allow-unsigned"], { runsRoot: join(dir, "runs") })).toBe(1); // --allow-unsigned must not waive it
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  test("a seal-shaped receipt renamed to group/1 with no group section, events_sha256 and time removed, is TAMPERED and exits non-zero", async () => {
    const dir = tmpDir();
    try {
      const path = writeUnsignedReceipt(dir, "e10-group-bypass", (r) => { r["schema"] = "loki.v10.group/1"; delete r["events_sha256"]; delete r["time"]; rehash(r); });
      const result = await verifyReceipt(path);
      expect(result.verdict).toBe("TAMPERED");
      expect(result.reasons.join(" ")).toContain("no group section");
      expect(await main(["e10-group-bypass", "--allow-unsigned"], { runsRoot: join(dir, "runs") })).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("the recognized loki.v10.receipt/1 schema still reads UNSIGNED", async () => {
    const dir = tmpDir();
    try {
      expect((await verifyReceipt(writeUnsignedReceipt(dir, "e10-schema-ok"))).verdict).toBe("UNSIGNED");
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

  test("a forged verification.kid on a signed receipt is TAMPERED, not VERIFIED", async () => {
    if (!CRYPTO_PY) {
      console.log("SKIP: no python3 has cryptography importable under -I -- attestation not measured here");
      return;
    }
    const dir = tmpDir();
    const runId = "e10-forged-kid-1";
    const savedKey = process.env["LOKI_RECEIPT_SIGNING_KEY"];
    try {
      const fields = baseReceiptFields();
      fields["run_id"] = runId;
      const hash = computeReceiptHash(fields);
      const { pem, jwt } = signWithFreshKey(hash, runId);
      const receipt = { ...fields, receipt_sha256: hash, verification: { jwt, kid: "attacker-kid" } };
      const runDir = join(dir, "runs", runId);
      mkdirSync(runDir, { recursive: true });
      const path = join(runDir, "receipt.json");
      writeFileSync(path, JSON.stringify(receipt, null, 2));
      process.env["LOKI_RECEIPT_SIGNING_KEY"] = pem;
      sealedLog(runDir, hash, runId);
      const result = await verifyReceipt(path);
      expect(result.verdict).toBe("TAMPERED");
      expect(result.reasons[0]).toContain("verification.kid differs");
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

  test("P12-01c: a receipt/1 missing events_sha256, time or time.stages is TAMPERED even with --allow-unsigned", async () => {
    const dir = tmpDir();
    try {
      const mk = (id: string, mutate: (f: Record<string, unknown>) => void): void => {
        const f = baseReceiptFields(); f["run_id"] = id; mutate(f);
        const rd = join(dir, "runs", id); mkdirSync(rd, { recursive: true });
        writeFileSync(join(rd, "receipt.json"), JSON.stringify({ ...f, receipt_sha256: computeReceiptHash(f), verification: { jwt: null, kid: null } }));
      };
      const cases: Array<[string, string, (f: Record<string, unknown>) => void]> = [
        ["nohash", "events_sha256", (f) => { delete f["events_sha256"]; }],
        ["badhash", "events_sha256", (f) => { f["events_sha256"] = "A".repeat(64); }],
        ["notime", "time", (f) => { delete f["time"]; f["stages"] = {}; }],
        ["nulltime", "time", (f) => { f["time"] = null; }],
        ["strstages", "time.stages", (f) => { f["time"] = { wall_s: 0, stages: "none" }; }],
        ["arrstages", "time.stages", (f) => { f["time"] = { wall_s: 0, stages: [] }; }],
      ];
      for (const [id, field, m] of cases) {
        mk(id, m);
        const r = await runMain([id, "--allow-unsigned"], join(dir, "runs"));
        expect(r.code).toBe(1);
        expect(r.out).toContain("verdict: TAMPERED");
        expect(r.out).toContain(field);
        expect(r.out).toContain("Re-run the task to produce a fresh receipt.");
      }
      mk("honest0", () => {}); // zero stages, real empty-log hash: stays UNSIGNED
      const ok = await verifyReceipt(join(dir, "runs", "honest0", "receipt.json"));
      expect(ok.verdict).toBe("UNSIGNED");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("P12-01b: --allow-unsigned never waives the log check: empty-hash receipt that claims stages is TAMPERED", async () => {
    const dir = tmpDir();
    try {
      const mk = (id: string, stages: Record<string, number>): void => {
        const f = baseReceiptFields(); f["run_id"] = id; f["time"] = { wall_s: 10, stages };
        const rd = join(dir, "runs", id); mkdirSync(rd, { recursive: true });
        writeFileSync(join(rd, "receipt.json"), JSON.stringify({ ...f, receipt_sha256: computeReceiptHash(f), verification: { jwt: null, kid: null } }));
      };
      mk("forged1", { intake: 10 });
      const r = await runMain(["forged1", "--allow-unsigned"], join(dir, "runs"));
      expect(r.code).toBe(1);
      expect(r.out).toContain("verdict: TAMPERED");
      expect(r.out).toContain("records stages but binds the empty-log hash");
      expect(r.out).toContain("Re-run the task");
      writeFileSync(join(dir, "runs", "forged1", "events.jsonl"), "");
      expect((await runMain(["forged1", "--allow-unsigned"], join(dir, "runs"))).code).toBe(1);
      writeFileSync(join(dir, "runs", "forged1", "events.jsonl"), JSON.stringify({ seq: 0, type: "run.started", data: {} }) + "\n");
      const r2 = await runMain(["forged1", "--allow-unsigned"], join(dir, "runs")); // empty hash + stages + non-empty log: still forged
      expect(r2.code).toBe(1);
      expect(r2.out).toContain("records stages but binds the empty-log hash");
      expect(r2.out).toContain("Re-run the task");
      writeUnsignedReceipt(dir, "zero1"); // truly zero events and stages: still accepted
      expect((await runMain(["zero1", "--allow-unsigned"], join(dir, "runs"))).code).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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

describe("main() --seal-composite", () => {
  test("help documents it, a missing or extra run dir exits 2, a dir without integration.json exits 2", async () => {
    const d = tmpDir();
    expect((await runMain(["--help"], d)).out).toContain("--seal-composite RUN_DIR");
    const err = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect((await runMain(["--seal-composite"], d)).code).toBe(2);
      expect((await runMain(["--seal-composite", d, "x"], d)).code).toBe(2);
      expect((await runMain(["--seal-composite", d], d)).code).toBe(2);
    } finally { process.stderr.write = err; }
    rmSync(d, { recursive: true, force: true });
  });
});

// V118-05: --max-age rides the signed JWT iat, checked after integrity.
describe("main() --max-age on the signed iat (V118-05)", () => {
  const SAVED = process.env["LOKI_RECEIPT_SIGNING_KEY"];
  const NOW = 1_800_000_000_000; // ms, injected clock
  let dir: string;
  let key: { publicKey: KeyObject; privateKey: KeyObject };
  beforeEach(() => {
    dir = tmpDir();
    key = generateKeyPairSync("ed25519");
    process.env["LOKI_RECEIPT_SIGNING_KEY"] = key.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  });
  afterEach(() => {
    if (SAVED === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY"]; else process.env["LOKI_RECEIPT_SIGNING_KEY"] = SAVED;
    rmSync(dir, { recursive: true, force: true });
  });
  // Signed receipt whose JWT carries the given iat (seconds), written at `sub` under dir.
  function signedAt(iat: number | undefined, sub = "runs/sg/receipt.json"): string {
    const fields = baseReceiptFields();
    const hash = computeReceiptHash(fields);
    const h = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: kidOf(key.publicKey) })).toString("base64url");
    const p = Buffer.from(JSON.stringify({ receipt_sha256: hash, ...(iat === undefined ? {} : { iat }) })).toString("base64url");
    const sig = nodeSign(null, Buffer.from(`${h}.${p}`), key.privateKey).toString("base64url");
    const path = join(dir, sub);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...fields, receipt_sha256: hash, verification: { jwt: `${h}.${p}.${sig}`, kid: kidOf(key.publicKey) } }));
    return path;
  }
  async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [], err: string[] = [];
    const w = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((c: string) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
    try { return { code: await main(args, { runsRoot: join(dir, "runs"), now: () => NOW }), out: out.join(""), err: err.join("") }; }
    finally { process.stdout.write = w; process.stderr.write = e; }
  }
  const nowS = NOW / 1000;
  test("fresh signed receipt with --max-age 1d is VERIFIED, exit 0; the =form agrees", async () => {
    const f = signedAt(nowS - 60);
    expect((await run([f, "--max-age", "1d"])).code).toBe(0);
    expect((await run([f, "--max-age=86400"])).code).toBe(0);
  });
  test("backdated iat exits 2 with the reason text", async () => {
    const r = await run([signedAt(nowS - 8 * 86400), "--max-age", "7d"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("verdict: UNCHECKED");
    expect(r.out).toContain("is older than --max-age 7d");
  });
  test("a group receipt path (.loki/groups/<gid>/receipt.json) is checked the same way", async () => {
    const f = signedAt(nowS - 8 * 3600, ".loki/groups/g1/receipt.json");
    expect((await run([f, "--max-age", "1h"])).code).toBe(2);
    expect((await run([f, "--max-age", "1d"])).code).toBe(0);
  });
  test("unsigned receipt and a signed receipt with no iat both exit 2 with the no-iat reason", async () => {
    const u = writeUnsignedReceipt(dir, "us");
    for (const f of [u, signedAt(undefined)]) {
      const r = await run([f, "--max-age", "1d", "--allow-unsigned"]);
      expect(r.code).toBe(2);
      expect(r.out).toContain("no signed iat; age cannot be checked");
    }
  });
  test("tampered receipt stays TAMPERED, exit 1", async () => {
    const f = signedAt(nowS - 10);
    const r = JSON.parse(readFileSync(f, "utf8")); r.repo = "x/y"; writeFileSync(f, JSON.stringify(r));
    expect((await run([f, "--max-age", "1d"])).code).toBe(1);
  });
  test("invalid --max-age (abc, 0, empty, missing, negative, repeated) exits 2 with invalid --max-age", async () => {
    const f = signedAt(nowS);
    for (const a of [["--max-age", "abc"], ["--max-age=0"], ["--max-age="], ["--max-age"], ["--max-age", "-5"], ["--max-age=1d", "--max-age=2d"]]) {
      const r = await run([f, ...a]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("invalid --max-age");
    }
  });
  test("iat more than 300s in the future exits 2; within skew passes", async () => {
    expect((await run([signedAt(nowS + 400), "--max-age", "1d"])).code).toBe(2);
    expect((await run([signedAt(nowS + 100), "--max-age", "1d"])).code).toBe(0);
  });
  test("without --max-age the output is unchanged", async () => {
    const r = await run([signedAt(nowS - 99 * 86400)]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("iat");
  });
  test("the help names --max-age", async () => {
    expect((await run(["--help"])).out).toContain("--max-age");
  });
});

describe("loki.deploy/1 signed deploy records", () => {
  let dir: string, keyFile: string, savedKey: string | undefined, savedInline: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deploy-rec-"));
    keyFile = join(dir, "key.pem");
    savedKey = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; savedInline = process.env["LOKI_RECEIPT_SIGNING_KEY"];
    delete process.env["LOKI_RECEIPT_SIGNING_KEY"];
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = keyFile;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; else process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = savedKey;
    if (savedInline !== undefined) process.env["LOKI_RECEIPT_SIGNING_KEY"] = savedInline;
    rmSync(dir, { recursive: true, force: true });
  });
  async function run(args: string[]): Promise<{ code: number; out: string }> {
    const out: string[] = [];
    const w = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try { return { code: await main(args, {}), out: out.join("") }; } finally { process.stdout.write = w; process.stderr.write = e; }
  }
  /** A legacy proof.json (digest = sha256 of the sorted compact body) with an attestation, plus a deploy record citing it. */
  async function fixture(signedProof = true): Promise<{ rec: string; proof: string }> {
    const { canonicalJson, signReceipt } = await import("../../src/util/receipt_signer.ts");
    const body = { schema: "proof/1", run_id: "p1", verdict: "pass" };
    const hash = createHash("sha256").update(canonicalJson(body)).digest("hex");
    const att = signedProof ? signReceipt("p1", hash).jwt : null;
    const proof = join(dir, ".loki", "proofs", "p1", "proof.json");
    mkdirSync(join(dir, ".loki", "proofs", "p1"), { recursive: true });
    writeFileSync(proof, JSON.stringify({ ...body, verification: { hash, attestation: att } }));
    const rec = join(dir, ".loki", "deploys", "d.json");
    mkdirSync(join(dir, ".loki", "deploys"), { recursive: true });
    writeFileSync(rec, JSON.stringify({ schema: "loki.deploy/1", receipt_sha256: hash, head_sha: "abc123", target: "vercel", command: "vercel --prod", health_status: "HEALTHY", health_url: "http://x/ok", rollback_attempted: false, rollback_exit: null, started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:05Z" }));
    return { rec, proof };
  }
  test("sign then verify is VERIFIED and leaves the receipt unchanged", async () => {
    const { rec, proof } = await fixture();
    const before = readFileSync(proof, "utf8");
    expect((await run(["--sign-deploy", rec])).code).toBe(0);
    const r = await run([rec]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("verdict: VERIFIED");
    expect(readFileSync(proof, "utf8")).toBe(before);
  });
  test("--max-age on a deploy record is UNCHECKED, exit 2, never VERIFIED", async () => {
    const { rec } = await fixture();
    await run(["--sign-deploy", rec]);
    for (const a of [[rec, "--max-age", "1s"], [rec, "--max-age=1s"]]) {
      const r = await run(a);
      expect(r.code).toBe(2);
      expect(r.out).toContain("verdict: UNCHECKED");
      expect(r.out).not.toContain("VERIFIED\n");
    }
  });
  test("extra arguments after a deploy record exit 2", async () => {
    const { rec } = await fixture();
    await run(["--sign-deploy", rec]);
    expect((await run([rec, rec])).code).toBe(2);
  });
  test("a flipped field is TAMPERED, exit 1", async () => {
    const { rec } = await fixture();
    await run(["--sign-deploy", rec]);
    writeFileSync(rec, readFileSync(rec, "utf8").replace('"HEALTHY"', '"FAILED_HEALTH"'));
    const r = await run([rec]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("verdict: TAMPERED");
  });
  test("an unsigned record is UNCHECKED, exit 2", async () => {
    const { rec } = await fixture();
    const r = await run([rec]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("verdict: UNCHECKED");
  });
  test("a machine without the signing key is UNCHECKED", async () => {
    const { rec } = await fixture();
    await run(["--sign-deploy", rec]);
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(dir, "absent.pem");
    expect((await run([rec])).code).toBe(2);
  });
  test("--pubkey re-checks with only the public half", async () => {
    const { rec } = await fixture();
    await run(["--sign-deploy", rec]);
    const { createPrivateKey, createPublicKey } = await import("node:crypto");
    const pub = join(dir, "pub.jwk");
    writeFileSync(pub, JSON.stringify(createPublicKey(createPrivateKey(readFileSync(keyFile))).export({ format: "jwk" })));
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(dir, "absent.pem");
    expect((await run([rec, "--pubkey", pub])).code).toBe(0);
  });
  test("--pubkey holding a non-Ed25519 key exits 2 and never prints VERIFIED", async () => {
    const { rec } = await fixture();
    await run(["--sign-deploy", rec]);
    const { generateKeyPairSync } = await import("node:crypto");
    const rsa = join(dir, "rsa.pem");
    writeFileSync(rsa, generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }));
    const r = await run([rec, "--pubkey", rsa]);
    expect(r.code).toBe(2);
    expect(r.out).not.toContain("VERIFIED");
  });
  test("a tampered cited receipt is never VERIFIED", async () => {
    const { rec, proof } = await fixture();
    await run(["--sign-deploy", rec]);
    writeFileSync(proof, readFileSync(proof, "utf8").replace('"pass"', '"fail"'));
    expect((await run([rec])).code).toBe(1);
  });
  test("an unsigned cited receipt is UNCHECKED, a missing one is UNCHECKED", async () => {
    const a = await fixture(false);
    await run(["--sign-deploy", a.rec]);
    expect((await run([a.rec])).code).toBe(2);
    rmSync(a.proof);
    expect((await run([a.rec])).code).toBe(2);
  });
});

describe("loki.provenance/1 live provenance doc", () => {
  let dir: string, keyFile: string, pub: string, savedKey: string | undefined, savedInline: string | undefined, server: ReturnType<typeof Bun.serve>, body: () => Response;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "prov-"));
    keyFile = join(dir, "key.pem");
    savedKey = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; savedInline = process.env["LOKI_RECEIPT_SIGNING_KEY"];
    delete process.env["LOKI_RECEIPT_SIGNING_KEY"];
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = keyFile;
    const { loadSigningKey } = await import("../../src/util/receipt_signer.ts");
    const { createPublicKey } = await import("node:crypto");
    pub = join(dir, "pub.jwk");
    writeFileSync(pub, JSON.stringify(createPublicKey(loadSigningKey()!).export({ format: "jwk" })));
    body = () => new Response("{}");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => body() });
  });
  afterEach(() => {
    server.stop(true);
    if (savedKey === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; else process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = savedKey;
    if (savedInline !== undefined) process.env["LOKI_RECEIPT_SIGNING_KEY"] = savedInline;
    rmSync(dir, { recursive: true, force: true });
  });
  async function run(args: string[]): Promise<{ code: number; out: string }> {
    const out: string[] = [];
    const w = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try { return { code: await main(args, {}), out: out.join("") }; } finally { process.stdout.write = w; process.stderr.write = e; }
  }
  async function signed(): Promise<Record<string, unknown>> {
    const { signProvenance } = await import("../../src/util/receipt_signer.ts");
    return signProvenance("a".repeat(40), "b".repeat(40), "c".repeat(64), "run1", "2026-10-17T00:00:00Z")!;
  }
  const url = (): string => `http://127.0.0.1:${server.port}`;
  const serve = (d: unknown): void => { body = () => new Response(JSON.stringify(d), { headers: { "content-type": "application/json" } }); };
  test("genuine doc with --pubkey is VERIFIED rc 0", async () => {
    serve(await signed());
    const r = await run(["--url", url(), "--pubkey", pub]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("verdict: VERIFIED");
  });
  test("--sign-provenance FILE signs in place and the result verifies", async () => {
    const f = join(dir, "p.json");
    writeFileSync(f, JSON.stringify({ head_sha: "a".repeat(40), tree_sha: "b".repeat(40), receipt_sha256: "c".repeat(64), run_id: "run1", built_at: "2026-10-17T00:00:00Z" }));
    expect((await run(["--sign-provenance", f])).code).toBe(0);
    serve(JSON.parse(readFileSync(f, "utf8")));
    expect((await run(["--url", url(), "--pubkey", pub])).code).toBe(0);
  });
  test("one edited byte of head_sha is TAMPERED rc 1", async () => {
    const d = await signed();
    serve({ ...d, head_sha: "d" + "a".repeat(39) });
    const r = await run(["--url", url(), "--pubkey", pub]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("verdict: TAMPERED");
  });
  test("an unknown kid is UNCHECKED rc 2", async () => {
    const d = await signed();
    serve({ ...d, signature: { ...(d["signature"] as object), kid: "nope" } });
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(dir, "absent.pem");
    const r = await run(["--url", url()]);
    expect(r.code).toBe(2);
    expect(r.out).not.toContain("VERIFIED");
    expect(r.out).toContain("no key for kid nope");
  });
  test("a 404 that carries a genuinely signed body is UNCHECKED rc 2", async () => {
    const sdSigned = await signed();
    body = () => new Response(JSON.stringify(sdSigned), { status: 404 });
    const r = await run(["--url", url(), "--pubkey", pub]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("HTTP 404");
    expect(r.out).not.toContain("VERIFIED");
  });
  test("a redirect is never followed, even to a genuinely signed doc", async () => {
    const good = JSON.stringify(await signed());
    body = () => new Response(null, { status: 302, headers: { location: `${url()}/elsewhere` } });
    server.reload({ fetch: (req: Request) => (new URL(req.url).pathname === "/elsewhere" ? new Response(good) : body()) });
    const r0 = await run(["--url", url(), "--pubkey", pub]);
    expect(r0.code).toBe(2);
    expect(r0.out).not.toContain("verdict: VERIFIED");
  });
  test("--max-age on an old built_at is never VERIFIED (rc 2); within max-age is VERIFIED", async () => {
    const { signProvenance } = await import("../../src/util/receipt_signer.ts");
    serve(signProvenance("a".repeat(40), "b".repeat(40), "c".repeat(64), "run1", "2020-01-01T00:00:00Z"));
    const old = await run(["--url", url(), "--pubkey", pub, "--max-age", "1s"]);
    expect(old.code).toBe(2);
    expect(old.out).toContain("older than --max-age 1s");
    expect(old.out).not.toContain("verdict: VERIFIED");
    serve(signProvenance("a".repeat(40), "b".repeat(40), "c".repeat(64), "run1", new Date().toISOString()));
    const fresh = await run(["--url", url(), "--pubkey", pub, "--max-age", "1h"]);
    expect(fresh.code).toBe(0);
    expect(fresh.out).toContain("verdict: VERIFIED");
  });
  test("--max-age with a missing or unparseable built_at is UNCHECKED rc 2; a tampered doc stays TAMPERED rc 1", async () => {
    const { signDeployRecord, PROVENANCE_SCHEMA } = await import("../../src/util/receipt_signer.ts");
    const base = { schema: PROVENANCE_SCHEMA, head_sha: "a".repeat(40), tree_sha: "b".repeat(40), receipt_sha256: "c".repeat(64), run_id: "r" };
    serve(signDeployRecord({ ...base }));
    expect((await run(["--url", url(), "--pubkey", pub, "--max-age", "1h"])).code).toBe(2);
    serve(signDeployRecord({ ...base, built_at: "not a date" }));
    expect((await run(["--url", url(), "--pubkey", pub, "--max-age", "1h"])).code).toBe(2);
    const d = await signed();
    serve({ ...d, head_sha: "d" + "a".repeat(39) });
    expect((await run(["--url", url(), "--pubkey", pub, "--max-age", "1h"])).code).toBe(1);
  });
  test("--max-age is refused (rc 2) with --seal-composite and --export-dsse rather than ignored", async () => {
    expect((await run(["--seal-composite", dir, "--max-age", "1h"])).code).toBe(2);
    expect((await run(["--export-dsse", "--max-age", "1h"])).code).toBe(2);
  });
  test("a non-JSON body and a doc over 64KB are UNCHECKED rc 2", async () => {
    body = () => new Response("<html>");
    expect((await run(["--url", url(), "--pubkey", pub])).code).toBe(2);
    serve({ ...(await signed()), pad: "x".repeat(70000) });
    const r = await run(["--url", url(), "--pubkey", pub]);
    expect(r.code).toBe(2);
    expect(r.out).not.toContain("VERIFIED");
  });
  test("a fetch failure is UNCHECKED rc 2", async () => {
    const u = url();
    server.stop(true);
    expect((await run(["--url", u, "--pubkey", pub])).code).toBe(2);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => body() });
  });
  test("--expect-sha must equal head_sha: match VERIFIED, mismatch TAMPERED", async () => {
    serve(await signed());
    expect((await run(["--url", url(), "--pubkey", pub, "--expect-sha", "a".repeat(40)])).code).toBe(0);
    expect((await run(["--url", url(), "--pubkey", pub, "--expect-sha", "f".repeat(40)])).code).toBe(1);
  });
  test("a cited receipt passed with --receipt that is tampered is never VERIFIED", async () => {
    const { canonicalJson, signReceipt, signProvenance } = await import("../../src/util/receipt_signer.ts");
    const pbody = { schema: "proof/1", run_id: "p1", verdict: "pass" };
    const hash = createHash("sha256").update(canonicalJson(pbody)).digest("hex");
    const proof = join(dir, "proof.json");
    writeFileSync(proof, JSON.stringify({ ...pbody, verification: { hash, attestation: signReceipt("p1", hash).jwt } }));
    serve(signProvenance("a".repeat(40), "b".repeat(40), hash, "p1", "2026-10-17T00:00:00Z"));
    expect((await run(["--url", url(), "--pubkey", pub, "--receipt", proof])).code).toBe(0);
    writeFileSync(proof, readFileSync(proof, "utf8").replace('"pass"', '"fail"'));
    expect((await run(["--url", url(), "--pubkey", pub, "--receipt", proof])).code).toBe(1);
  });
});

// P12-01: the seal is checked against the workspace it describes (intent, head) and against its own log (fabricated success).
describe("seal drift (P12-01)", () => {
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  const vcs = (cwd: string, ...a: string[]): string => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd }).stdout.toString().trim();
  let saved: Record<string, string | undefined>;
  beforeEach(() => { saved = { f: process.env["LOKI_VERIFY_TASK_FILE"], a: process.env["LOKI_VERIFY_ALLOW_HEAD_DRIFT"] }; delete process.env["LOKI_VERIFY_TASK_FILE"]; delete process.env["LOKI_VERIFY_ALLOW_HEAD_DRIFT"]; });
  afterEach(() => { for (const [k, v] of [["LOKI_VERIFY_TASK_FILE", saved["f"]], ["LOKI_VERIFY_ALLOW_HEAD_DRIFT", saved["a"]]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  // A receipt at <repo>/.loki/runs/<id>/receipt.json; `fields` overrides are applied before hashing so the receipt stays intact.
  function seal(repo: string, id: string, fields: Record<string, unknown>, log?: string): string {
    const f: Record<string, unknown> = { ...baseReceiptFields(), run_id: id, ...fields };
    const runDir = join(repo, ".loki", "runs", id);
    mkdirSync(runDir, { recursive: true });
    if (log !== undefined) { writeFileSync(join(runDir, "events.jsonl"), log); f["events_sha256"] = sha(log); }
    writeFileSync(join(runDir, "receipt.json"), JSON.stringify({ ...f, receipt_sha256: computeReceiptHash(f), verification: { jwt: null, kid: null } }));
    return runDir;
  }
  async function verify(repo: string, id: string): Promise<{ code: number; out: string }> {
    const out: string[] = [], w = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
    try { return { code: await main([id, "--allow-unsigned"], { runsRoot: join(repo, ".loki", "runs") }), out: out.join("") }; } finally { process.stdout.write = w; }
  }
  const ev = (seq: number, type: string, data: Record<string, unknown>, stage: string | null = null): string => JSON.stringify({ v: 1, seq, ts: "2026-10-15T00:00:00.000Z", run: "r", type, stage, data }) + "\n";

  test("intent changed after seal: issue.json no longer matches the sealed task sha256", async () => {
    const repo = tmpDir();
    try {
      const raw = JSON.stringify({ title: "add x", body: "do x" });
      const dir = seal(repo, "r-intent", { task: { source: "issue", sha256: sha(raw) } });
      writeFileSync(join(dir, "issue.json"), raw);
      expect((await verify(repo, "r-intent")).code).toBe(0); // control: unchanged spec
      writeFileSync(join(dir, "issue.json"), JSON.stringify({ title: "add y", body: "do y" }));
      const r = await verify(repo, "r-intent");
      expect(r.code).toBe(2);
      expect(r.out.includes("intent drift")).toBe(true);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("intent changed after seal: text task file differs from the sealed sha256", async () => {
    const repo = tmpDir();
    try {
      seal(repo, "r-text", { task: { source: "text", sha256: sha("build x") } });
      const tf = join(repo, "task.txt");
      process.env["LOKI_VERIFY_TASK_FILE"] = tf;
      writeFileSync(tf, "build x");
      expect((await verify(repo, "r-text")).code).toBe(0);
      writeFileSync(tf, "build y instead");
      expect((await verify(repo, "r-text")).code).toBe(2);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("receipt claims pass with no test log: a bound log lacking the test.result pass is TAMPERED", async () => {
    const repo = tmpDir();
    try {
      const checks = [{ name: "unit", cmd: "bun test", result: "pass", duration_s: 1 }];
      seal(repo, "r-fab", { checks }, ev(0, "run.started", {}) + ev(1, "stage.started", { }, "verify"));
      const r = await verify(repo, "r-fab");
      expect(r.code).toBe(1);
      expect(r.out.includes("claims pass")).toBe(true);
      seal(repo, "r-ok", { checks }, ev(0, "run.started", {}) + ev(1, "test.result", { name: "unit", result: "pass" }, "verify"));
      expect((await verify(repo, "r-ok")).code).toBe(0); // control: the log recorded the pass
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("head drift: head_sha differs from the repo HEAD fails; LOKI_VERIFY_ALLOW_HEAD_DRIFT=1 accepts", async () => {
    const repo = tmpDir();
    try {
      vcs(repo, "init", "-q"); writeFileSync(join(repo, "a"), "1"); vcs(repo, "add", "a"); vcs(repo, "commit", "-qm", "one");
      seal(repo, "r-head", { head_sha: vcs(repo, "rev-parse", "HEAD") });
      expect((await verify(repo, "r-head")).code).toBe(0); // control: head matches
      writeFileSync(join(repo, "a"), "2"); vcs(repo, "commit", "-qam", "two");
      const r = await verify(repo, "r-head");
      expect(r.code).toBe(2);
      expect(r.out.includes("head drift")).toBe(true);
      process.env["LOKI_VERIFY_ALLOW_HEAD_DRIFT"] = "1";
      expect((await verify(repo, "r-head")).code).toBe(0);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe("seal drift review fixes (P12-01)", () => {
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  const vcs = (cwd: string, ...a: string[]): string => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd }).stdout.toString().trim();
  let savedDrift: string | undefined;
  beforeEach(() => { savedDrift = process.env["LOKI_VERIFY_ALLOW_HEAD_DRIFT"]; delete process.env["LOKI_VERIFY_ALLOW_HEAD_DRIFT"]; });
  afterEach(() => { if (savedDrift === undefined) delete process.env["LOKI_VERIFY_ALLOW_HEAD_DRIFT"]; else process.env["LOKI_VERIFY_ALLOW_HEAD_DRIFT"] = savedDrift; });
  function seal(repo: string, id: string, fields: Record<string, unknown>, log?: string): string {
    const f: Record<string, unknown> = { ...baseReceiptFields(), run_id: id, ...fields };
    const runDir = join(repo, ".loki", "runs", id);
    mkdirSync(runDir, { recursive: true });
    if (log !== undefined) { writeFileSync(join(runDir, "events.jsonl"), log); f["events_sha256"] = sha(log); }
    writeFileSync(join(runDir, "receipt.json"), JSON.stringify({ ...f, receipt_sha256: computeReceiptHash(f), verification: { jwt: null, kid: null } }));
    return runDir;
  }
  async function verify(runsRoot: string, id: string): Promise<{ code: number; out: string }> {
    const out: string[] = [], w = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
    try { return { code: await main([id, "--allow-unsigned"], { runsRoot }), out: out.join("") }; } finally { process.stdout.write = w; }
  }
  const ev = (seq: number, type: string, data: Record<string, unknown>, stage: string | null = null): string => JSON.stringify({ v: 1, seq, ts: "2026-10-15T00:00:00.000Z", run: "r", type, stage, data }) + "\n";
  const unit = { name: "unit", cmd: "bun test", result: "pass", duration_s: 1 };

  test("an honest receipt with a full-suite check and its test.result event is not TAMPERED", async () => {
    const repo = tmpDir();
    try {
      const full = { name: "full suite: bun", cmd: "bun test", result: "pass", duration_s: 2 };
      seal(repo, "r-full", { checks: [unit, full] }, ev(0, "run.started", {}) + ev(1, "test.result", unit, "verify") + ev(2, "test.result", full, "verify"));
      expect((await verify(join(repo, ".loki", "runs"), "r-full")).code).toBe(0);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("a test.result line appended after the sealed prefix does not launder a fabricated pass", async () => {
    const repo = tmpDir();
    try {
      const dir = seal(repo, "r-app", { checks: [unit] }, ev(0, "run.started", {}) + ev(1, "stage.started", {}, "verify"));
      expect((await verify(join(repo, ".loki", "runs"), "r-app")).code).toBe(1);
      writeFileSync(join(dir, "events.jsonl"), readFileSync(join(dir, "events.jsonl"), "utf8") + ev(2, "test.result", unit, "verify"));
      const r = await verify(join(repo, ".loki", "runs"), "r-app");
      expect(r.code).toBe(1);
      expect(r.out.includes("claims pass")).toBe(true);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("a log with no verify-stage trace is not compared (the narrowing stays)", async () => {
    const repo = tmpDir();
    try {
      seal(repo, "r-nov", { checks: [unit] }, ev(0, "run.started", {}));
      expect((await verify(join(repo, ".loki", "runs"), "r-nov")).code).toBe(0);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("a ./ segment or a symlinked run dir in the receipt path still reaches the head check", async () => {
    const repo = tmpDir();
    try {
      vcs(repo, "init", "-q"); writeFileSync(join(repo, "a"), "1"); vcs(repo, "add", "a"); vcs(repo, "commit", "-qm", "one");
      const dir = seal(repo, "r-path", { head_sha: vcs(repo, "rev-parse", "HEAD") });
      writeFileSync(join(repo, "a"), "2"); vcs(repo, "commit", "-qam", "two");
      expect((await verify(join(repo, ".loki", "runs"), "r-path")).code).toBe(2); // control: plain path
      expect((await verify("unused", `${repo}/.loki/./runs/r-path/receipt.json`)).code).toBe(2);
      const lnk = join(repo, "lnk");
      symlinkSync(dir, lnk);
      expect((await verify("unused", join(lnk, "receipt.json"))).code).toBe(2);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  const runs = (repo: string): string => join(repo, ".loki", "runs");
  const verifyLog = (extra: string): string => ev(0, "run.started", {}) + ev(1, "stage.started", {}, "verify") + extra;

  test("a test.result with result fail does not count as a pass", async () => {
    const repo = tmpDir();
    try {
      seal(repo, "r-failev", { checks: [unit] }, verifyLog(ev(2, "test.result", { ...unit, result: "fail" }, "verify")));
      expect((await verify(runs(repo), "r-failev")).code).toBe(1);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("a test.result from another stage does not count as a verify pass", async () => {
    const repo = tmpDir();
    try {
      seal(repo, "r-stage", { checks: [unit] }, verifyLog(ev(2, "test.result", unit, "deep")));
      expect((await verify(runs(repo), "r-stage")).code).toBe(1);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("a pass recorded after log.sealed does not count even inside the hashed prefix", async () => {
    const repo = tmpDir();
    try {
      seal(repo, "r-after", { checks: [unit] }, verifyLog(ev(2, "log.sealed", {}) + ev(3, "test.result", unit, "verify")));
      expect((await verify(runs(repo), "r-after")).code).toBe(1);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("receipt.json as a file symlink to a copy elsewhere still gets the log and head checks", async () => {
    const repo = tmpDir(), away = tmpDir();
    try {
      vcs(repo, "init", "-q"); writeFileSync(join(repo, "a"), "1"); vcs(repo, "add", "a"); vcs(repo, "commit", "-qm", "one");
      const head = vcs(repo, "rev-parse", "HEAD");
      const dir = seal(repo, "r-fsym", { head_sha: head, checks: [unit] }, verifyLog(ev(2, "test.result", unit, "verify")));
      const real = join(away, "receipt.json");
      renameSync(join(dir, "receipt.json"), real);
      symlinkSync(real, join(dir, "receipt.json"));
      expect((await verify(runs(repo), "r-fsym")).code).toBe(0); // control: honest and at HEAD
      writeFileSync(join(repo, "a"), "2"); vcs(repo, "commit", "-qam", "two");
      expect((await verify(runs(repo), "r-fsym")).code).toBe(2); // head drift still seen through the symlink
      const dir2 = seal(repo, "r-fsym2", { head_sha: vcs(repo, "rev-parse", "HEAD"), checks: [unit] }, verifyLog(""));
      const real2 = join(away, "receipt2.json");
      renameSync(join(dir2, "receipt.json"), real2);
      symlinkSync(real2, join(dir2, "receipt.json"));
      expect((await verify(runs(repo), "r-fsym2")).code).toBe(1); // fabricated pass still seen through the symlink
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(away, { recursive: true, force: true }); }
  });
});

// TEN-GATES-03: agent-independent evidence line and --require-exogenous.
describe("main() agent-independent evidence (TEN-GATES-03)", () => {
  const prev: Record<string, string | undefined> = {};
  const ENV = ["HOME", "LOKI_RECEIPT_SIGNING_KEY", "LOKI_RECEIPT_SIGNING_KEY_FILE", "LOKI_VERIFY_REQUIRE_EXOGENOUS"];
  beforeEach(() => { for (const k of ENV) prev[k] = process.env[k]; delete process.env["LOKI_VERIFY_REQUIRE_EXOGENOUS"]; delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; });
  afterEach(() => { for (const k of ENV) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
  type Chk = { name: string; cmd: string; result: string; duration_s: number; provenance?: string };
  const chk = (name: string, provenance?: string, result = "pass"): Chk => ({ name, cmd: "x", result, duration_s: 1, ...(provenance ? { provenance } : {}) });
  // Writes a receipt signed with a fresh test key (VERIFIED under that key); returns the temp dirs.
  function signed(runId: string, checks: Chk[], tamper = false): { dir: string; home: string; runs: string } {
    const dir = tmpDir(), home = tmpDir();
    const fields = baseReceiptFields();
    fields["run_id"] = runId; fields["checks"] = checks;
    const hash = computeReceiptHash(fields);
    const { pem, jwt, kid } = signWithFreshKey(hash, runId);
    const runDir = join(dir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    const body: Record<string, unknown> = { ...fields, receipt_sha256: hash, verification: { jwt, kid } };
    if (tamper) body["provider"] = "tampered";
    writeFileSync(join(runDir, "receipt.json"), JSON.stringify(body));
    process.env["HOME"] = home; process.env["LOKI_RECEIPT_SIGNING_KEY"] = pem;
    return { dir, home, runs: join(dir, "runs") };
  }
  const done = (...ds: string[]) => ds.forEach((d) => rmSync(d, { recursive: true, force: true }));

  test("only agent_authored checks: line shows 0 of 1, --require-exogenous exits 4, without the flag exits 0", async () => {
    if (!CRYPTO_PY) { console.log("SKIP: no python3 with cryptography"); return; }
    const s = signed("gx1", [chk("bun:tests/new.test.ts", "agent_authored")]);
    try {
      const plain = await runMain(["gx1"], s.runs);
      expect(plain.code).toBe(0);
      expect(plain.out).toContain("agent-independent: 0 of 1 passing checks (wall/holdout/pre-existing/static/probe); advisory: 1");
      const req = await runMain(["gx1", "--require-exogenous"], s.runs);
      expect(req.code).toBe(4);
      process.env["LOKI_VERIFY_REQUIRE_EXOGENOUS"] = "1";
      expect((await runMain(["gx1"], s.runs)).code).toBe(4);
    } finally { done(s.dir, s.home); }
  });

  test("one exogenous pass beside agent_authored and llm_judge exits 0 with the flag", async () => {
    if (!CRYPTO_PY) { console.log("SKIP: no python3 with cryptography"); return; }
    const s = signed("gx2", [chk("bun:tests/new.test.ts", "agent_authored"), chk("typecheck", "exogenous"), chk("council", "llm_judge")]);
    try {
      const r = await runMain(["gx2", "--require-exogenous"], s.runs);
      expect(r.code).toBe(0);
      expect(r.out).toContain("agent-independent: 1 of 3 passing checks (wall/holdout/pre-existing/static/probe); advisory: 2");
    } finally { done(s.dir, s.home); }
  });

  test("no provenance (older receipt): printed as not recorded, never as zero; flag exits 4, no flag exits 0", async () => {
    if (!CRYPTO_PY) { console.log("SKIP: no python3 with cryptography"); return; }
    const s = signed("gx3", [chk("unit")]);
    try {
      const plain = await runMain(["gx3"], s.runs);
      expect(plain.code).toBe(0);
      expect(plain.out).toContain("agent-independent: provenance not recorded");
      expect(plain.out).not.toContain("0 of");
      expect((await runMain(["gx3", "--require-exogenous"], s.runs)).code).toBe(4);
    } finally { done(s.dir, s.home); }
  });

  test("tampered receipt still exits 1 with the flag", async () => {
    if (!CRYPTO_PY) { console.log("SKIP: no python3 with cryptography"); return; }
    const s = signed("gx4", [chk("typecheck", "exogenous")], true);
    try {
      const r = await runMain(["gx4", "--require-exogenous"], s.runs);
      expect(r.code).toBe(1);
      expect(r.out).not.toContain("agent-independent");
    } finally { done(s.dir, s.home); }
  });
});
