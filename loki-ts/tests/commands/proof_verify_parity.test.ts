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
//       that returns 1 for a TRULY-MISSING proof BEFORE it ever shells to
//       python. So a missing file gives 1 from the wrapper (proves nothing about
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
import { join, resolve } from "node:path";

import { run } from "../../src/util/shell.ts";
import { runProof } from "../../src/commands/proof.ts";

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
    "honesty": {"headline": "VERIFIED", "degraded": []},
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
    // The Bun wrapper guards a TRULY-MISSING proof with its own `return 1`
    // (proof.ts:435-438) BEFORE shelling to python, so a missing file gives 1,
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

  it("missing proof -> exit 1 from the Bun wrapper (documented divergence)", async () => {
    // Pins the wrapper-level behavior that forces the malformed-file choice for
    // the 2-case above: a truly-missing proof short-circuits to 1 in the Bun
    // wrapper and never reaches the python verifier (which would say 2). This is
    // a real parity finding, not a bug -- both the bash and Bun front-ends treat
    // "no such proof id" as a user-facing not-found (1), reserving 2 for an
    // input that is present but unusable.
    const code = await runProof(["verify", "run-parity-does-not-exist"]);
    expect(code).toBe(1);
  });
});
