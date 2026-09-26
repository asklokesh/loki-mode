// Bun-route parity test for `loki proof verify` (Loop 6 / Slice C / C2).
//
// SCOPE (the L6 finding, held against any reviewer who tries to expand it):
// `loki start` is NOT a Bun-ported command -- it falls through to bash
// autonomy/loki -> run.sh. So the PR-creation + Evidence Receipt render path is
// BASH-ONLY on the default route already; there is NO TypeScript PR body to
// port. The ONE thing parity actually requires is that the verify-yourself
// command the PR body cites -- `loki proof verify <id>` -- works on the Bun
// route with the SAME exit contract as bash. This file proves exactly that and
// nothing more: it does not test a TS PR-body renderer (none exists) and adds
// no CLI subcommand.
//
// WHY THIS IS A REAL PARITY TEST (one source of truth): the Bun wrapper
// (loki-ts/src/commands/proof.ts verifyProof, reached via runProof(["verify",
// id])) shells out to the SAME autonomy/lib/proof-verify.py the bash route uses
// (autonomy/loki cmd_proof). We assert the Bun wrapper passes the python
// verifier's exit code through faithfully: 0 clean / 1 tamper-drift / 2
// unusable. REPO_ROOT resolves to the real repo's proof-verify.py -- that is the
// parity anchor; we do not stub it.
//
// EXIT-CODE CONTRACT, as it actually behaves through the Bun wrapper (verified
// against proof.ts:429-453 and proof-verify.py:314-479):
//   0 = CLEAN: integrity hash matches AND recorded diff still matches the repo.
//       Fixture: a temp git repo where base_sha == HEAD (empty diff) and the
//       recorded facts.git.diff is the empty stat, with a correctly computed
//       verification.hash. The verifier re-derives `git diff base HEAD` (empty),
//       matches the recorded stat + diff_sha256, and reports ok -> exit 0.
//   1 = TAMPER: a hashed field is mutated WITHOUT recomputing verification.hash,
//       so proof-verify.py's hash_ok is False -> ok False -> exit 1. We mutate
//       cost.usd (NOT a diff field) so the failure is isolated to the integrity
//       hash mismatch alone, not drift -- the cleanest 1-case to attribute.
//   2 = UNUSABLE: a malformed-but-PRESENT proof.json (invalid JSON). It must be
//       present-on-disk: the Bun wrapper has its OWN guard (proof.ts:435-438)
//       that returns 66 for a TRULY-MISSING proof BEFORE it ever shells to
//       python. So a missing file gives 66 from the wrapper (proves nothing about
//       the verifier); only a present-but-malformed file reaches python and
//       returns 2 (ProofLoadError -> _cli returns 2). This divergence is the
//       finding documented in the slice return notes.
//
// SAFETY: everything runs against a temp HOME-independent LOKI_DIR + a temp git
// repo created under tmpdir(). No network. The real ~/.loki is never read or
// written (we set LOKI_DIR to the scratch dir; verifyProof reads proofs from
// lokiDir() and the verifier diffs TARGET_DIR, both pointed at scratch). The
// integrity hash + diff_sha256 are computed by python3 with the SAME _canonical
// (json.dumps sort_keys=True, compact separators, default ensure_ascii) the
// verifier uses, so JS JSON.stringify key-order/separator/unicode/float
// divergences cannot corrupt the fixture.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { run } from "../../src/util/shell.ts";
import { noBashResultCode, runProof } from "../../src/commands/proof.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const VERIFIER = resolve(REPO_ROOT, "autonomy", "lib", "proof-verify.py");

let lokiScratch = "";
let repoScratch = "";
let originalLokiDir: string | undefined;
let originalTargetDir: string | undefined;

// Build a proof.json with a CORRECT verification.hash by shelling to python3
// and using the same canonicalization the verifier checks. We hand python a
// proof body (sans verification) and the recorded diff stat to hash for
// diff_sha256; python writes the final proof.json (with verification.hash) to
// outPath. Returns nothing; throws if python fails so a broken fixture is loud.
async function writeProofWithHash(
  outPath: string,
  baseSha: string,
  headSha: string,
): Promise<void> {
  // The diff stat for an empty diff (base == head). _diff_sha256 in the
  // generator hashes the canonical {count,insertions,deletions,files} object;
  // the verifier recomputes the same from the live `git diff` (also empty), so
  // they match and drift is False.
  const py = `
import hashlib, json, sys

out_path = sys.argv[1]
base_sha = sys.argv[2]
head_sha = sys.argv[3]

def _canonical(obj):
    # MUST match proof-generator._canonical and proof-verify._canonical exactly.
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))

empty_stat = {"count": 0, "insertions": 0, "deletions": 0, "files": []}
diff_sha256 = hashlib.sha256(_canonical(empty_stat).encode("utf-8")).hexdigest()

proof = {
    # schema_version is what proof-verify.py enforces (SUPPORTED_SCHEMA_MAJOR);
    # a receipt without it fails closed, and no real generator emits one --
    # proof-generator.py:1329 always writes it. Omitting it here made this
    # "CLEAN, unmodified proof" fixture unrepresentable in production.
    "schema_version": "1.1",
    "run_id": "run-parity-clean",
    "generated_at": "2026-06-20T00:00:00Z",
    "facts": {
        "git": {
            "base_sha": base_sha,
            "head_sha": head_sha,
            "diff": empty_stat,
            "diff_sha256": diff_sha256,
        },
    },
    # Headline must match what the facts re-derive to. This fixture records an
    # EMPTY diff (base == head) and NO tests facts, so the honest headline is
    # NOT VERIFIED (an empty-diff, test-less run cannot be VERIFIED). v7.111.0
    # added headline-consistency re-derivation to proof-verify, so a fixture that
    # hand-claimed VERIFIED over test-less facts is now correctly flagged as an
    # inconsistent edit. This test proves the INTEGRITY + no-drift path exits 0
    # on an untampered proof; that holds for a consistent NOT VERIFIED headline.
    "honesty": {"headline": "NOT VERIFIED", "degraded": []},
    "cost": {"usd": "0.10"},
}

# Hash is computed over the canonical proof with verification removed, exactly
# as the generator does (and as the verifier recomputes).
unsigned = dict(proof)
unsigned.pop("verification", None)
proof["verification"] = {
    "hash": hashlib.sha256(_canonical(unsigned).encode("utf-8")).hexdigest(),
}

with open(out_path, "w") as f:
    json.dump(proof, f, indent=2)
`;
  const r = await run(["python3", "-c", py, outPath, baseSha, headSha], {
    timeoutMs: 30000,
  });
  if (r.exitCode !== 0) {
    throw new Error(`fixture python3 failed (${r.exitCode}): ${r.stderr}`);
  }
}

function gitCommitEmptyRepo(dir: string): string {
  // A deterministic, isolated git repo. We make ONE commit; base == HEAD so the
  // recorded diff is empty and re-deriving it yields the same empty stat.
  // Local user.* config keeps it independent of the host's global git identity.
  const sh = [
    `cd ${JSON.stringify(dir)}`,
    "git init -q",
    "git config user.email parity@example.com",
    "git config user.name parity",
    "git config commit.gpgsign false",
    "echo seed > seed.txt",
    "git add seed.txt",
    "git commit -q -m seed",
  ].join(" && ");
  return sh;
}

beforeEach(() => {
  originalLokiDir = process.env["LOKI_DIR"];
  originalTargetDir = process.env["TARGET_DIR"];
  lokiScratch = mkdtempSync(join(tmpdir(), "loki-proof-verify-parity-"));
  repoScratch = mkdtempSync(join(tmpdir(), "loki-proof-verify-repo-"));
  // verifyProof reads proofs from lokiDir() (LOKI_DIR) and diffs TARGET_DIR.
  process.env["LOKI_DIR"] = lokiScratch;
  process.env["TARGET_DIR"] = repoScratch;
});

afterEach(() => {
  if (originalLokiDir === undefined) delete process.env["LOKI_DIR"];
  else process.env["LOKI_DIR"] = originalLokiDir;
  if (originalTargetDir === undefined) delete process.env["TARGET_DIR"];
  else process.env["TARGET_DIR"] = originalTargetDir;
  if (lokiScratch && existsSync(lokiScratch)) {
    rmSync(lokiScratch, { recursive: true, force: true });
  }
  if (repoScratch && existsSync(repoScratch)) {
    rmSync(repoScratch, { recursive: true, force: true });
  }
});

describe("loki proof verify: Bun-route exit-code parity (Slice C / C2)", () => {
  it("the shared verifier exists at the parity anchor path", () => {
    // If this is missing, the Bun wrapper returns 2 and so does bash -- but the
    // whole parity claim collapses. Assert the single source of truth is there.
    expect(existsSync(VERIFIER)).toBe(true);
  });

  it("CLEAN, unmodified proof -> exit 0 (hash matches + no drift)", async () => {
    // 1) A real, isolated git repo with one commit. base == HEAD so the diff is
    //    empty and re-deriving it reproduces the recorded empty stat.
    const setup = await run(["sh", "-c", gitCommitEmptyRepo(repoScratch)], {
      timeoutMs: 30000,
    });
    expect(setup.exitCode).toBe(0);
    const headRes = await run(
      ["git", "-C", repoScratch, "rev-parse", "HEAD"],
      { timeoutMs: 30000 },
    );
    expect(headRes.exitCode).toBe(0);
    const head = headRes.stdout.trim();
    expect(head.length).toBeGreaterThan(0);

    // 2) A proof keyed at base_sha == head_sha (empty diff), with a correct
    //    integrity hash computed by python with the verifier's canonicalization.
    const id = "run-parity-clean";
    const dir = join(lokiScratch, "proofs", id);
    mkdirSync(dir, { recursive: true });
    await writeProofWithHash(join(dir, "proof.json"), head, head);

    const code = await runProof(["verify", id]);
    expect(code).toBe(0);
  });

  it("TAMPERED proof (hashed field mutated) -> exit 1 (integrity hash mismatch)", async () => {
    // Same clean repo + proof, then mutate a HASHED field (cost.usd) WITHOUT
    // recomputing verification.hash. proof-verify.py recomputes the canonical
    // hash, finds a mismatch (hash_ok False -> ok False), and the Bun wrapper
    // passes its exit 1 through. cost.usd is NOT a diff field, so the failure is
    // attributable purely to the tamper (integrity) check, not drift.
    const setup = await run(["sh", "-c", gitCommitEmptyRepo(repoScratch)], {
      timeoutMs: 30000,
    });
    expect(setup.exitCode).toBe(0);
    const headRes = await run(
      ["git", "-C", repoScratch, "rev-parse", "HEAD"],
      { timeoutMs: 30000 },
    );
    expect(headRes.exitCode).toBe(0);
    const head = headRes.stdout.trim();

    const id = "run-parity-tamper";
    const dir = join(lokiScratch, "proofs", id);
    mkdirSync(dir, { recursive: true });
    const pj = join(dir, "proof.json");
    await writeProofWithHash(pj, head, head);

    // Mutate a hashed field post-hoc, leaving verification.hash stale.
    const tampered = JSON.parse(
      await Bun.file(pj).text(),
    ) as Record<string, unknown>;
    (tampered["cost"] as Record<string, unknown>)["usd"] = "999.99";
    writeFileSync(pj, JSON.stringify(tampered, null, 2));

    const code = await runProof(["verify", id]);
    expect(code).toBe(1);
  });

  it("UNUSABLE input (malformed-but-present proof.json) -> exit 2", async () => {
    // The Bun wrapper guards a TRULY-MISSING proof with its own `return 66`
    // (proof.ts:435-438) BEFORE shelling to python, so a missing file gives 66,
    // not 2. To exercise the verifier's 2 (ProofLoadError on malformed JSON) we
    // must write a present-but-invalid proof.json. This is the documented
    // wrapper-vs-verifier divergence for the missing-file case.
    const id = "run-parity-malformed";
    const dir = join(lokiScratch, "proofs", id);
    mkdirSync(dir, { recursive: true });
    // Invalid JSON: a lone opening brace triggers json.JSONDecodeError.
    writeFileSync(join(dir, "proof.json"), "{");

    const code = await runProof(["verify", id]);
    expect(code).toBe(2);
  });

  it("missing proof -> exit 66 from the Bun wrapper (input missing)", async () => {
    // Pins the wrapper-level behavior that forces the malformed-file choice for
    // the 2-case above: a truly-missing proof short-circuits in the Bun wrapper
    // and never reaches the python verifier (which would say 2). Both the bash
    // and Bun front-ends report "no such proof id" as 66 (input missing, per
    // docs/exit-codes.md), keeping 1 for tamper/drift and 2 for an input that is
    // present but unusable. It was 1, which read as a tampered receipt.
    const code = await runProof(["verify", "run-parity-does-not-exist"]);
    expect(code).toBe(66);
  });

  it("missing proof id -> exit 64 (usage)", async () => {
    const code = await runProof(["verify"]);
    expect(code).toBe(64);
  });
});

// --- Flags on the Bun route (--jwks, --human) --------------------------------
// runProof used to hand verifyProof only rest[0], so "verify <id> --jwks f"
// silently dropped the key set and exited 0, and "verify --jwks f <id>" read the
// flag as the proof id. Flagged invocations now delegate to the bash CLI, which
// owns flag parsing and the attestation check, so both routes give one answer.

const BUN_CLI = resolve(REPO_ROOT, "loki-ts", "src", "cli.ts");
const HAS_CRYPTO =
  Bun.spawnSync(["python3", "-c", "import cryptography"]).exitCode === 0;

async function cleanProof(id: string): Promise<string> {
  const setup = await run(["sh", "-c", gitCommitEmptyRepo(repoScratch)], {
    timeoutMs: 30000,
  });
  expect(setup.exitCode).toBe(0);
  const head = (
    await run(["git", "-C", repoScratch, "rev-parse", "HEAD"], { timeoutMs: 30000 })
  ).stdout.trim();
  const dir = join(lokiScratch, "proofs", id);
  mkdirSync(dir, { recursive: true });
  const pj = join(dir, "proof.json");
  await writeProofWithHash(pj, head, head);
  return pj;
}

// Attest proof.json with a fresh Ed25519 key over its recorded integrity hash,
// as proof-generator.py does, and write the matching key set plus an
// attacker's key set next to the proof store.
async function signProof(pj: string): Promise<{ good: string; evil: string }> {
  const good = join(lokiScratch, "jwks.json");
  const evil = join(lokiScratch, "evil-jwks.json");
  const py = `
import json, sys
sys.path.insert(0, sys.argv[1])
import receipt_jwt as rj
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
pj, good, evil = sys.argv[2], sys.argv[3], sys.argv[4]
k = Ed25519PrivateKey.generate()
kid = rj.compute_kid(k.public_key())
p = json.load(open(pj))
p["verification"]["attestation"] = rj.sign_attestation(
    k, kid, job_id="j", run_id=p["run_id"], receipt_hash=p["verification"]["hash"])
p["verification"]["attestation_kid"] = kid
json.dump(p, open(pj, "w"), indent=2)
json.dump(rj.build_jwks(private_key=k), open(good, "w"))
json.dump(rj.build_jwks(private_key=Ed25519PrivateKey.generate()), open(evil, "w"))
`;
  const r = await run(
    ["python3", "-c", py, resolve(REPO_ROOT, "autonomy"), pj, good, evil],
    { timeoutMs: 30000 },
  );
  if (r.exitCode !== 0) throw new Error(`signProof failed: ${r.stderr}`);
  return { good, evil };
}

function bunCli(argv: string[]) {
  return run(["bun", BUN_CLI, ...argv], {
    env: { LOKI_DIR: lokiScratch, TARGET_DIR: repoScratch, NO_COLOR: "1" },
    timeoutMs: 30000,
  });
}

describe("loki proof verify: flags reach the verifier on the Bun route", () => {
  it("--human is honored before or after the id (was: flag read as the id -> 1)", async () => {
    await cleanProof("run-flag-human");
    expect(await runProof(["verify", "--human", "run-flag-human"])).toBe(0);
    expect(await runProof(["verify", "run-flag-human", "--human"])).toBe(0);
  });

  it("an unsigned proof with --jwks exits 1 in any order (was: key set dropped -> 0)", async () => {
    // ABSENT is decided from the receipt before the key set is read, so this
    // needs no key set on disk and no cryptography module.
    await cleanProof("run-flag-unsigned");
    const ks = join(lokiScratch, "no-such-jwks.json");
    expect(await runProof(["verify", "run-flag-unsigned", "--jwks", ks])).toBe(1);
    expect(await runProof(["verify", "--jwks", ks, "run-flag-unsigned"])).toBe(1);
    expect(await runProof(["verify", `--jwks=${ks}`, "run-flag-unsigned"])).toBe(1);
    // The 1 must come from the attestation rule, not from a not-found id.
    const r = await bunCli(["proof", "verify", "--jwks", ks, "run-flag-unsigned"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("attestation: ABSENT");
  });

  it.skipIf(!HAS_CRYPTO)("a signed proof verifies against its key set in either order", async () => {
    const pj = await cleanProof("run-flag-signed");
    const { good } = await signProof(pj);
    for (const argv of [
      ["proof", "verify", "run-flag-signed", "--jwks", good],
      ["proof", "verify", "--jwks", good, "run-flag-signed"],
    ]) {
      const r = await bunCli(argv);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("attestation: VERIFIED");
    }
  });

  it.skipIf(!HAS_CRYPTO)("a signed proof checked against an attacker key set exits 1, never VERIFIED", async () => {
    const pj = await cleanProof("run-flag-evil");
    const { evil } = await signProof(pj);
    const r = await bunCli(["proof", "verify", "run-flag-evil", "--jwks", evil]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("attestation: FAILED");
    expect(r.stderr).not.toContain("attestation: VERIFIED");
  });
});

// --- An empty or missing --jwks value is a usage error (64) -----------------
// "--jwks ''" and "--jwks=" used to skip the attestation check and exit 0 on an
// unsigned receipt, and a later empty --jwks cancelled an earlier real one. A
// dangling "--jwks" exited 2 ("could not check"), which is not what it is.
const BASH_CLI = resolve(REPO_ROOT, "autonomy", "loki");

function bashCli(argv: string[]) {
  return run(["bash", BASH_CLI, ...argv], {
    env: { LOKI_DIR: lokiScratch, TARGET_DIR: repoScratch, NO_COLOR: "1" },
    timeoutMs: 30000,
  });
}

describe("loki proof verify: empty or missing --jwks value exits 64 on both routes", () => {
  it("every empty-value form exits 64 with the empty-value message", async () => {
    await cleanProof("run-flag-empty");
    const ks = join(lokiScratch, "no-such-jwks.json");
    // Control: without --jwks the receipt verifies clean, so 64 comes from the flag.
    expect(await runProof(["verify", "run-flag-empty"])).toBe(0);
    const forms = [["--jwks", ""], ["--jwks="], ["--jwks", ks, "--jwks", ""], ["--jwks", "", "--jwks", ks]];
    for (const flags of forms) {
      for (const cli of [bunCli, bashCli]) {
        const r = await cli(["proof", "verify", "run-flag-empty", ...flags]);
        expect(r.exitCode).toBe(64);
        expect(r.stderr).toContain("empty value");
        expect(r.stderr).not.toContain("attestation: VERIFIED");
      }
    }
  });

  it("a dangling --jwks exits 64 (was 2)", async () => {
    await cleanProof("run-flag-dangling");
    for (const cli of [bunCli, bashCli]) {
      const r = await cli(["proof", "verify", "run-flag-dangling", "--jwks"]);
      expect(r.exitCode).toBe(64);
      expect(r.stderr).toContain("--jwks needs a URL or file path");
    }
  });
});

// --- A mistyped flag or a second id is a usage error (64) --------------------
// "--jwk f" and "-jwks f" were kept as extra positionals and ignored, so an
// unsigned receipt exited 0 on both routes as if its signature were checked.
// A second id was silently dropped by verifyProof (Bun) and by bash.
describe("loki proof verify: unknown option or extra id exits 64 on both routes", () => {
  it("--jwk, -jwks and a second id each exit 64 and name the problem", async () => {
    await cleanProof("run-flag-typo");
    const ks = join(lokiScratch, "no-such-jwks.json");
    // Control: the unsigned receipt verifies clean with no flags, so 64 below
    // comes from the parser, not the receipt.
    expect(await runProof(["verify", "run-flag-typo"])).toBe(0);
    const cases: Array<[string[], string]> = [
      [["run-flag-typo", "--jwk", ks], "'--jwk'"],
      [["run-flag-typo", "-jwks", ks], "'-jwks'"],
      [["--jwk", ks, "run-flag-typo"], "'--jwk'"],
      [["run-flag-typo", "run-flag-typo"], "one proof id"],
    ];
    for (const [args, named] of cases) {
      for (const cli of [bunCli, bashCli]) {
        const r = await cli(["proof", "verify", ...args]);
        expect(r.exitCode).toBe(64);
        expect(r.stderr).toContain(named);
      }
    }
    // In-process too: runProof must not hand only rest[0] to verifyProof.
    expect(await runProof(["verify", "run-flag-typo", "run-flag-typo"])).toBe(64);
  });
});

// --- A malformed attestation is FAILED, never NOT CHECKED --------------------
// The receipt's builder controls verification.attestation. A token whose header
// decodes to [1], or a non-string attestation, crashed the check and read as
// NOT CHECKED (2), turning FAILED into "could not check". The Bun entry point
// delegates --jwks to the bash verifier, so both entry points are measured.
describe("loki proof verify: malformed attestation is refused on both entry points", () => {
  it.skipIf(!HAS_CRYPTO)("header [1] and a dict attestation exit 1 with attestation: FAILED", async () => {
    const pj = await cleanProof("run-att-bad");
    const { good } = await signProof(pj);
    const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const forged: unknown[] = [`${b([1])}.${b({ receipt_sha256: "x" })}.${b("sig")}`, { alg: "EdDSA" }];
    for (const att of forged) {
      const p = JSON.parse(await Bun.file(pj).text()) as { verification: Record<string, unknown> };
      p.verification["attestation"] = att;
      writeFileSync(pj, JSON.stringify(p, null, 2));
      // Control: the integrity hash excludes verification.*, so the base
      // verifier still accepts the receipt; only the attestation rule decides.
      expect(await runProof(["verify", "run-att-bad"])).toBe(0);
      for (const cli of [bunCli, bashCli]) {
        const r = await cli(["proof", "verify", "run-att-bad", "--jwks", good]);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("attestation: FAILED");
        expect(r.stderr).not.toContain("NOT CHECKED");
      }
    }
  });
});

describe("proofFallthroughToBash: no exit code from bash is never a tamper verdict", () => {
  it("verify maps to 2 (could not check); other subcommands keep 1", () => {
    expect(noBashResultCode("verify")).toBe(2);
    expect(noBashResultCode("chain")).toBe(2);
    expect(noBashResultCode("phases")).toBe(1);
    expect(noBashResultCode("releases")).toBe(1);
  });

  it("no python3 on PATH: verify exits 2 NOT CHECKED (was: uncaught spawn error -> 1)", async () => {
    await cleanProof("run-no-python");
    const r = await run([process.execPath, BUN_CLI, "proof", "verify", "run-no-python"], {
      env: { PATH: dirname(process.execPath), LOKI_DIR: lokiScratch, NO_COLOR: "1" },
      timeoutMs: 30000,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("NOT CHECKED");
  });

  it("a verifier killed by a signal exits 2 NOT CHECKED (was: raw 143)", async () => {
    // The 30s timeout in verifyProof ends the verifier with SIGTERM, which
    // surfaced as 143. A python3 that SIGTERMs itself reaches the same branch
    // without waiting 30s.
    await cleanProof("run-killed");
    const shim = join(lokiScratch, "shim");
    mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, "python3"), "#!/bin/sh\nkill -TERM $$\n", { mode: 0o755 });
    const r = await run([process.execPath, BUN_CLI, "proof", "verify", "run-killed"], {
      env: { PATH: `${shim}:${dirname(process.execPath)}:/usr/bin:/bin`, LOKI_DIR: lokiScratch, NO_COLOR: "1" },
      timeoutMs: 30000,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("NOT CHECKED");
    expect(r.stdout).toBe("");
  });
});
