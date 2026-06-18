// Tests for src/runner/prd_reuse.ts (FEAT-PRD-REUSE, Bun route, W4 batch).
//
// Source-of-truth (bash parity):
//   decide_generated_prd_action()      autonomy/run.sh:4892
//   persist_prd_signature_if_present() autonomy/run.sh:4983
//   user-PRD persistence branch        autonomy/run.sh run_autonomous (Agent C)
//
// Hermetic: each test creates a fresh tmpdir, passes it via lokiDirOverride/cwd,
// and cleans up in afterEach. LOKI_PRD_REGEN / LOKI_DIR env are restored too.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  resolvePrdForRun,
  decideGeneratedPrdAction,
  readPrdSignature,
} from "../src/runner/prd_reuse.ts";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

let tmp: string;
let cwd: string;
let lokiDir: string;
let savedRegen: string | undefined;
let savedLokiDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loki-prdreuse-test-"));
  cwd = tmp;
  lokiDir = join(tmp, ".loki");
  mkdirSync(lokiDir, { recursive: true });
  savedRegen = process.env["LOKI_PRD_REGEN"];
  savedLokiDir = process.env["LOKI_DIR"];
  delete process.env["LOKI_PRD_REGEN"];
  // Force the helper to use our explicit lokiDirOverride, not a stale LOKI_DIR.
  delete process.env["LOKI_DIR"];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedRegen === undefined) delete process.env["LOKI_PRD_REGEN"];
  else process.env["LOKI_PRD_REGEN"] = savedRegen;
  if (savedLokiDir === undefined) delete process.env["LOKI_DIR"];
  else process.env["LOKI_DIR"] = savedLokiDir;
});

const genPath = () => join(lokiDir, "generated-prd.md");
const sigPath = () => join(lokiDir, "state", "prd-signature.json");

describe("resolvePrdForRun: user file persistence", () => {
  it("persists a user file to .loki/generated-prd.md byte-equal with source=user", () => {
    const userPrd = join(tmp, "my-prd.md");
    const body = "# My PRD\n\nBuild a thing.\nWith UTF-8: cafe, naive.\n";
    writeFileSync(userPrd, body);

    const res = resolvePrdForRun({
      prdPath: userPrd,
      cwd,
      lokiDirOverride: lokiDir,
    });

    // Returns the canonical generated path, not the original file.
    expect(res.prdPath).toBe(genPath());
    expect(res.action).toBe("user_persist");

    // Content is byte-equal.
    expect(existsSync(genPath())).toBe(true);
    expect(readFileSync(genPath(), "utf8")).toBe(body);

    // Signature records source=user + origin_path + a non-empty prd_sha.
    const sig = readPrdSignature(lokiDir);
    expect(sig).not.toBeNull();
    expect(sig!.source).toBe("user");
    expect(sig!.origin_path).toBe(userPrd);
    expect(sig!.prd_path).toBe(".loki/generated-prd.md");
    expect(typeof sig!.prd_sha).toBe("string");
    expect(sig!.prd_sha.length).toBe(16);
    expect(typeof sig!.generated_at).toBe("string");
    expect(sig!.generated_at.endsWith("Z")).toBe(true);
  });

  it("persists a UTF-8 PRD with multi-byte characters byte-for-byte (no latin1 corruption)", () => {
    // Regression: persistUserPrd previously round-tripped the file through
    // Buffer.toString("binary") (latin1) and wrote it back as utf8, corrupting
    // any non-ASCII content. Use smart quotes, an accented char, an emoji, and
    // CJK so a latin1 mangle is unambiguous. Compare bytes, not decoded strings.
    const userPrd = join(tmp, "utf8-prd.md");
    const body =
      "# PRD\n\nFeature: café with smart quote “hello” and emoji \u{1F600} CJK 你好\n";
    writeFileSync(userPrd, body, "utf8");
    const srcBytes = readFileSync(userPrd); // Buffer, exact bytes

    const res = resolvePrdForRun({
      prdPath: userPrd,
      cwd,
      lokiDirOverride: lokiDir,
    });
    expect(res.action).toBe("user_persist");
    expect(res.prdPath).toBe(genPath());

    // Byte-for-byte identical -- the load-bearing assertion. A latin1 mangle
    // inflates the byte length and changes the content.
    const dstBytes = readFileSync(genPath());
    expect(dstBytes.equals(srcBytes)).toBe(true);
    expect(readFileSync(genPath(), "utf8")).toBe(body);

    // And the recorded prd_sha must match a fresh hash of the persisted file,
    // so a same-spec rerun is correctly classified as reuse (not user_owned
    // due to a phantom "hand edit" introduced by the corruption).
    const sig = readPrdSignature(lokiDir);
    expect(sig).not.toBeNull();
    const reHash = createHash("sha256").update(dstBytes).digest("hex").slice(0, 16);
    expect(sig!.prd_sha).toBe(reHash);
  });

  it("a new file over an existing persisted PRD overwrites it and keeps source=user", () => {
    // First user PRD.
    const first = join(tmp, "first.md");
    writeFileSync(first, "# First\n");
    resolvePrdForRun({ prdPath: first, cwd, lokiDirOverride: lokiDir });
    expect(readFileSync(genPath(), "utf8")).toBe("# First\n");

    // Second (different) user PRD over the top.
    const second = join(tmp, "second.md");
    const secondBody = "# Second\n\nNew brownfield spec.\n";
    writeFileSync(second, secondBody);
    const res = resolvePrdForRun({
      prdPath: second,
      cwd,
      lokiDirOverride: lokiDir,
    });

    expect(res.action).toBe("user_persist");
    expect(res.prdPath).toBe(genPath());
    // Overwritten byte-equal with the second file.
    expect(readFileSync(genPath(), "utf8")).toBe(secondBody);

    const sig = readPrdSignature(lokiDir);
    expect(sig!.source).toBe("user");
    expect(sig!.origin_path).toBe(second);
  });
});

describe("resolvePrdForRun: no-file reuse", () => {
  it("empty prdPath + persisted source=user returns the generated path (reuse, never undefined) and action user_owned", () => {
    // Seed a user PRD first.
    const userPrd = join(tmp, "user.md");
    writeFileSync(userPrd, "# User owned\n");
    resolvePrdForRun({ prdPath: userPrd, cwd, lokiDirOverride: lokiDir });

    // Now rerun with NO file arg.
    const res = resolvePrdForRun({
      prdPath: undefined,
      cwd,
      lokiDirOverride: lokiDir,
    });

    // Must reuse the persisted PRD, NOT drop to analysis mode.
    expect(res.prdPath).toBe(genPath());
    expect(res.prdPath).not.toBeUndefined();
    // LOCK 2: user PRD is user_owned, never update.
    expect(res.action).toBe("user_owned");

    // The decision table agrees independently.
    expect(decideGeneratedPrdAction({ cwd, lokiDirOverride: lokiDir })).toBe(
      "user_owned",
    );
  });

  it("a user-owned PRD stays user_owned even after the codebase changes (never update)", () => {
    const userPrd = join(tmp, "user.md");
    writeFileSync(userPrd, "# User owned\n");
    resolvePrdForRun({ prdPath: userPrd, cwd, lokiDirOverride: lokiDir });

    // Mutate the tree (would flip a source=generated PRD to update).
    writeFileSync(join(tmp, "new-source-file.ts"), "export const x = 1;\n");

    expect(decideGeneratedPrdAction({ cwd, lokiDirOverride: lokiDir })).toBe(
      "user_owned",
    );
    const res = resolvePrdForRun({ cwd, lokiDirOverride: lokiDir });
    expect(res.action).toBe("user_owned");
    expect(res.prdPath).toBe(genPath());
  });

  it("--fresh-prd / LOKI_PRD_REGEN overrides a user-owned PRD -> generate (undefined)", () => {
    const userPrd = join(tmp, "user.md");
    writeFileSync(userPrd, "# User owned\n");
    resolvePrdForRun({ prdPath: userPrd, cwd, lokiDirOverride: lokiDir });

    process.env["LOKI_PRD_REGEN"] = "1";
    expect(decideGeneratedPrdAction({ cwd, lokiDirOverride: lokiDir })).toBe(
      "generate",
    );
    const res = resolvePrdForRun({ cwd, lokiDirOverride: lokiDir });
    expect(res.action).toBe("generate");
    expect(res.prdPath).toBeUndefined();
  });
});

describe("resolvePrdForRun: analysis mode + generated provenance", () => {
  it("empty prdPath + no persisted PRD returns { prdPath: undefined } (analysis mode)", () => {
    const res = resolvePrdForRun({
      prdPath: undefined,
      cwd,
      lokiDirOverride: lokiDir,
    });
    expect(res.prdPath).toBeUndefined();
    expect(res.action).toBe("none");
  });

  it("generated PRD without a signature file -> update (reconcile), returns generated path", () => {
    // Simulate a generated PRD with no provenance file.
    writeFileSync(genPath(), "# Generated\n");
    expect(decideGeneratedPrdAction({ cwd, lokiDirOverride: lokiDir })).toBe(
      "update",
    );
    const res = resolvePrdForRun({ cwd, lokiDirOverride: lokiDir });
    expect(res.prdPath).toBe(genPath());
    expect(res.action).toBe("update");
  });

  it("generated PRD with a matching generated signature -> reuse", () => {
    // Persist via the user path first to get a real signature, then rewrite it
    // as source=generated with a matching codebase signature and prd_sha so the
    // decision is reuse (not user_owned).
    const userPrd = join(tmp, "seed.md");
    writeFileSync(userPrd, "# Seed\n");
    resolvePrdForRun({ prdPath: userPrd, cwd, lokiDirOverride: lokiDir });

    const sig = readPrdSignature(lokiDir)!;
    // Flip to generated provenance, keep prd_sha + signature matching current.
    sig.source = "generated";
    delete sig.origin_path;
    writeFileSync(sigPath(), JSON.stringify(sig));

    expect(decideGeneratedPrdAction({ cwd, lokiDirOverride: lokiDir })).toBe(
      "reuse",
    );
    const res = resolvePrdForRun({ cwd, lokiDirOverride: lokiDir });
    expect(res.prdPath).toBe(genPath());
    expect(res.action).toBe("reuse");
  });
});
