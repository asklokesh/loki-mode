// loki-ts/src/engine10/verify_cmd.ts
//
// E-22: `loki verify [run-id]` (ENGINE.md section 11; schema in section 9
// "Seal and receipt"). Reached through cli.ts's TABLE ("verify" ->
// verify_cmd.ts main), which loads this module lazily. Deliberately
// independent of the state machine (machine.ts/supervisor.ts, seal.ts: all
// still in rework, not on main): it reads receipt.json straight off disk and
// needs no RunContext, only the Receipt shape from types.ts (E-01).
//
// Three checks, cheapest and most-decisive first:
//   1. TAMPER: recompute receipt_sha256 over the canonical JSON with
//      `verification` AND `receipt_sha256` itself removed (a hash cannot
//      cover its own recorded value), compare to what is on disk.
//   2. SIGNATURE: when verification.jwt is set, verify it through
//      autonomy/receipt_jwt.py's verify_attestation against a JWKS built from
//      whatever signing key material this host has configured right now
//      (load_signing_key for the active key, load_retired_public_keys for
//      keys that rotated out but must still verify old receipts), then check
//      the JWT's own receipt_sha256 claim matches the recomputed hash.
//   3. UNSIGNED: jwt is null -> reported as UNSIGNED, never presented as
//      attested. This is receipt_jwt.py's own contract, not a weaker check.
//
// The python step runs through findIsolatedPython3() (util/python.ts) with
// -I ONLY, never -S: -S drops site-packages, so `cryptography` never imports
// and every receipt would read as UNCHECKED regardless of whether it was
// actually signed. -I already excludes user site and PYTHON* env, which is
// the isolation ENGINE.md section 9 specifies for this exact interpreter
// call ("Do NOT add -S ... -I already excludes user site and PYTHON* env").
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { lokiDir, REPO_ROOT } from "../util/paths.ts";
import { findIsolatedPython3 } from "../util/python.ts";
import { run } from "../util/shell.ts";
import type { ShellResult } from "../util/shell.ts";

export type Verdict = "VERIFIED" | "UNSIGNED" | "TAMPERED" | "UNCHECKED";

export interface VerifyResult {
  verdict: Verdict;
  reasons: string[];
}

// --- canonical JSON (mirrors Python's json.dumps(sort_keys=True, separators=(",", ":"))) ---
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** The hash seal.ts (E-10) is specified to write into receipt.json:
 *  canonical JSON with `verification` removed. `receipt_sha256` itself is
 *  also removed: a field cannot record its own hash's input. */
export function computeReceiptHash(receipt: Record<string, unknown>): string {
  const { verification: _verification, receipt_sha256: _hash, ...rest } = receipt;
  return sha256Hex(canonicalJson(rest));
}

type PyRunner = (argv: readonly string[], opts?: { timeoutMs?: number }) => Promise<ShellResult>;

export interface VerifyDeps {
  runsRoot?: string; // overrides lokiDir()/runs, for tests
  findPython?: () => Promise<string | null>;
  runPython?: PyRunner;
}

interface AttestationOutcome {
  status: "verified" | "tampered" | "unchecked";
  reason: string | null;
}

async function checkAttestation(
  jwt: string,
  expectedHash: string,
  findPython: () => Promise<string | null>,
  runPython: PyRunner,
): Promise<AttestationOutcome> {
  const py = await findPython();
  if (!py) return { status: "unchecked", reason: "no isolated python3 passed the -I probe" };

  const autonomyDir = resolve(REPO_ROOT, "autonomy");
  // sys.argv[1] carries the token: argv, never string interpolation, so a
  // JWT containing quote-like bytes cannot break out of the script.
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(autonomyDir)})
from receipt_jwt import load_signing_key, load_retired_public_keys, build_jwks, verify_attestation
priv, _kid = load_signing_key()
jwks = build_jwks(private_key=priv, retired_public_keys=load_retired_public_keys())
ok, payload = verify_attestation(sys.argv[1], jwks)
print(json.dumps({"ok": ok, "payload": payload if ok else None, "reason": None if ok else str(payload)}))
`;

  let r: ShellResult;
  try {
    r = await runPython([py, "-I", "-c", code, jwt], { timeoutMs: 10000 });
  } catch (e) {
    return { status: "unchecked", reason: `could not run the verifier: ${String((e as Error).message ?? e)}` };
  }
  if (r.exitCode > 128) {
    return { status: "unchecked", reason: `verifier was killed (exit ${r.exitCode})` };
  }
  if (r.exitCode !== 0) {
    return { status: "unchecked", reason: r.stderr.trim() || `verifier exited ${r.exitCode}` };
  }
  let parsed: { ok: boolean; payload: { receipt_sha256?: string } | null; reason: string | null };
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch {
    return { status: "unchecked", reason: "verifier produced no parseable output" };
  }
  // Not installed is "could not check", never "tampered" (the honesty rule
  // this codebase already applies in autonomy/lib/proof-verify.py).
  if (parsed.reason === "cryptography is not installed") {
    return { status: "unchecked", reason: parsed.reason };
  }
  if (!parsed.ok) {
    return { status: "tampered", reason: parsed.reason ?? "signature does not verify" };
  }
  if (parsed.payload?.receipt_sha256 !== expectedHash) {
    return { status: "tampered", reason: "attestation binds a different receipt hash" };
  }
  return { status: "verified", reason: null };
}

export async function verifyReceipt(receiptPath: string, deps: VerifyDeps = {}): Promise<VerifyResult> {
  if (!existsSync(receiptPath)) {
    return { verdict: "UNCHECKED", reasons: [`receipt not found: ${receiptPath}`] };
  }
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch {
    return { verdict: "UNCHECKED", reasons: ["receipt.json is not valid JSON"] };
  }

  const recorded = receipt["receipt_sha256"];
  const computed = computeReceiptHash(receipt);
  if (typeof recorded !== "string" || recorded !== computed) {
    return {
      verdict: "TAMPERED",
      reasons: [`receipt_sha256 mismatch: recorded ${JSON.stringify(recorded)}, computed ${computed}`],
    };
  }

  const verification = (receipt["verification"] ?? {}) as { jwt?: string | null };
  const jwt = verification.jwt ?? null;
  if (!jwt) {
    return { verdict: "UNSIGNED", reasons: [] };
  }

  const outcome = await checkAttestation(
    jwt,
    computed,
    deps.findPython ?? findIsolatedPython3,
    deps.runPython ?? run,
  );
  if (outcome.status === "unchecked") return { verdict: "UNCHECKED", reasons: [outcome.reason ?? "attestation not checked"] };
  if (outcome.status === "tampered") return { verdict: "TAMPERED", reasons: [outcome.reason ?? "attestation invalid"] };
  return { verdict: "VERIFIED", reasons: [] };
}

function latestRunId(runsRoot: string): string | null {
  if (!existsSync(runsRoot)) return null;
  const dirs = readdirSync(runsRoot).filter((d) => {
    try {
      return statSync(join(runsRoot, d)).isDirectory();
    } catch {
      return false;
    }
  });
  if (dirs.length === 0) return null;
  // Run ids are e10-<ISO-ish timestamp>-<suffix>, so lexicographic order is
  // chronological order.
  dirs.sort();
  return dirs[dirs.length - 1] ?? null;
}

const EXIT_BY_VERDICT: Record<Verdict, number> = {
  VERIFIED: 0,
  UNSIGNED: 0,
  TAMPERED: 1,
  UNCHECKED: 2,
};

export async function main(args: readonly string[], deps: VerifyDeps = {}): Promise<number> {
  const runsRoot = deps.runsRoot ?? join(lokiDir(), "runs");
  const runId = args[0] ?? latestRunId(runsRoot) ?? undefined;
  if (!runId) {
    process.stderr.write("loki verify: no runs found\n");
    return 66;
  }
  const receiptPath = join(runsRoot, runId, "receipt.json");
  const result = await verifyReceipt(receiptPath, deps);

  process.stdout.write(`run: ${runId}\nverdict: ${result.verdict}\n`);
  for (const reason of result.reasons) process.stdout.write(`  ${reason}\n`);
  if (result.verdict === "UNSIGNED") {
    process.stdout.write("attestation: UNSIGNED (no signing key was configured when this receipt was sealed)\n");
  } else if (result.verdict === "VERIFIED") {
    process.stdout.write("attestation: VERIFIED against the local JWKS\n");
  }
  return EXIT_BY_VERDICT[result.verdict];
}
