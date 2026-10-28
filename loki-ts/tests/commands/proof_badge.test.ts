// HLW-5: shareable "Verified by Loki" Evidence Receipt badge.
//
// These tests pin the anti-fake-green discipline of renderProofBadge: the badge
// color/text derive ONLY from the honest headline, green is reachable ONLY from
// the exact string "VERIFIED", and an absent/empty/unknown headline yields NO
// badge (null) rather than a fabricated verdict.
//
// renderProofBadge is a pure, exported function, so these are fast in-process
// unit checks (no gh, no gist, no spawn). The `badge` subcommand is covered via
// runProof against a seeded proof dir.
//
// RED/GREEN: this feature is net-new, so the pre-fix "red" is a trivial missing
// export. The discriminating teeth are the amber/red/absent assertions: a naive
// implementation that always returns a green badge FAILS them. That is what the
// requirement is really protecting, so those cases are the meaningful test.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderProofBadge, runProof } from "../../src/commands/proof.ts";
import { SupervisorLog } from "../../src/engine10/supervisor.ts";
import { receiptSha256, signReceipt } from "../../src/engine10/stages/seal.ts";

describe("renderProofBadge: headline -> badge mapping (anti-fake-green)", () => {
  it("VERIFIED -> green 'Verified by Loki'", () => {
    const md = renderProofBadge("VERIFIED");
    expect(md).not.toBeNull();
    expect(md).toContain("brightgreen");
    expect(md).toContain("Verified%20by%20Loki");
    // The message segment is the load-bearing signal.
    expect(md).toContain("img.shields.io/badge/");
    // No other color leaks in.
    expect(md).not.toContain("yellow");
    expect(md).not.toContain("-red");
  });

  it("VERIFIED WITH GAPS -> amber 'Verified with gaps' (NEVER green)", () => {
    const md = renderProofBadge("VERIFIED WITH GAPS");
    expect(md).not.toBeNull();
    expect(md).toContain("yellow");
    expect(md).toContain("Verified%20with%20gaps");
    expect(md).not.toContain("brightgreen");
  });

  it("NOT VERIFIED -> red 'Not verified' (NEVER green)", () => {
    const md = renderProofBadge("NOT VERIFIED");
    expect(md).not.toBeNull();
    expect(md).toContain("-red");
    expect(md).toContain("Not%20verified");
    expect(md).not.toContain("brightgreen");
  });

  it("absent/empty headline -> NO badge (null), never a fabricated green", () => {
    expect(renderProofBadge("")).toBeNull();
    expect(renderProofBadge("   ")).toBeNull();
    expect(renderProofBadge(undefined)).toBeNull();
    expect(renderProofBadge(null)).toBeNull();
  });

  it("unknown non-empty headline -> NO badge (null), never defaults to green", () => {
    // A value that is not one of the three exact strings must not render green
    // (or any) badge. This guards a naive default-to-green implementation.
    expect(renderProofBadge("PASSED")).toBeNull();
    expect(renderProofBadge("verified")).toBeNull(); // wrong case is not VERIFIED
    expect(renderProofBadge("VERIFIED-ISH")).toBeNull();
  });

  it("only the EXACT string 'VERIFIED' produces green", () => {
    // Case/spacing variants must not be green -- exact match only.
    expect(renderProofBadge("VERIFIED")).toContain("brightgreen");
    expect(renderProofBadge(" VERIFIED ")).toContain("brightgreen"); // trimmed
    expect(renderProofBadge("Verified")).toBeNull();
    expect(renderProofBadge("VERIFIED WITH GAPS")).not.toContain("brightgreen");
  });

  it("links the badge image to the shared URL when supplied", () => {
    const md = renderProofBadge("VERIFIED", "https://gist.github.com/x/abc");
    expect(md).toBe(
      "[![Verified by Loki](https://img.shields.io/badge/Loki-Verified%20by%20Loki-brightgreen)](https://gist.github.com/x/abc)",
    );
  });

  it("renders an image-only badge when no link is supplied", () => {
    const md = renderProofBadge("NOT VERIFIED");
    expect(md).toBe(
      "![Verified by Loki](https://img.shields.io/badge/Loki-Not%20verified-red)",
    );
  });
});

describe("loki proof badge: subcommand output", () => {
  let scratch = "";
  let originalLokiDir: string | undefined;
  let captured = { stdout: "", stderr: "" };
  let restore: () => void = () => {};

  function captureOutput(): void {
    captured = { stdout: "", stderr: "" };
    const oOut = process.stdout.write.bind(process.stdout);
    const oErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: unknown): boolean => {
      captured.stdout += String(c);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown): boolean => {
      captured.stderr += String(c);
      return true;
    }) as typeof process.stderr.write;
    restore = () => {
      process.stdout.write = oOut;
      process.stderr.write = oErr;
    };
  }

  function seedProof(id: string, proof: Record<string, unknown>): void {
    const dir = join(scratch, "proofs", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "proof.json"), JSON.stringify(proof, null, 2));
  }

  beforeEach(() => {
    originalLokiDir = process.env["LOKI_DIR"];
    scratch = mkdtempSync(join(tmpdir(), "loki-badge-"));
    process.env["LOKI_DIR"] = scratch;
  });

  afterEach(() => {
    if (originalLokiDir === undefined) delete process.env["LOKI_DIR"];
    else process.env["LOKI_DIR"] = originalLokiDir;
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  it("VERIFIED proof: prints green markdown badge, exit 0", async () => {
    seedProof("run-green", {
      run_id: "run-green",
      honesty: { headline: "VERIFIED" },
    });
    captureOutput();
    const code = await runProof(["badge", "run-green"]);
    restore();
    expect(code).toBe(0);
    expect(captured.stdout).toContain("brightgreen");
    expect(captured.stdout).toContain("Verified%20by%20Loki");
  });

  it("VERIFIED WITH GAPS proof: prints amber badge, exit 0", async () => {
    seedProof("run-amber", {
      run_id: "run-amber",
      honesty: { headline: "VERIFIED WITH GAPS" },
    });
    captureOutput();
    const code = await runProof(["badge", "run-amber"]);
    restore();
    expect(code).toBe(0);
    expect(captured.stdout).toContain("yellow");
    expect(captured.stdout).not.toContain("brightgreen");
  });

  it("proof with no headline: prints honest 'No badge' note, exit 0 (no fake-green)", async () => {
    seedProof("run-nohead", { run_id: "run-nohead" });
    captureOutput();
    const code = await runProof(["badge", "run-nohead"]);
    restore();
    expect(code).toBe(0);
    expect(captured.stdout).not.toContain("brightgreen");
    expect(captured.stdout).toContain("No badge");
  });

  it("missing proof id: exit 2", async () => {
    captureOutput();
    const code = await runProof(["badge"]);
    restore();
    expect(code).toBe(2);
  });

  it("unknown proof id: exit 1 with not-found (not 'Unknown subcommand')", async () => {
    captureOutput();
    const code = await runProof(["badge", "does-not-exist"]);
    restore();
    expect(code).toBe(1);
    expect(captured.stderr).toContain("not found");
  });

  it("badge appears in proof --help", async () => {
    captureOutput();
    const code = await runProof(["--help"]);
    restore();
    expect(code).toBe(0);
    expect(captured.stdout).toContain("badge");
  });
});

// TEN-ADOPTION-03: a `loki start` (engine10) run has .loki/runs/<id>/receipt.json and NO .loki/proofs/<id>.
describe("loki proof badge/bundle/share: sealed engine10 run, no .loki/proofs", () => {
  let scratch = "";
  const saved: Record<string, string | undefined> = {};
  let cap = { stdout: "", stderr: "" };
  let restore: () => void = () => {};
  let n = 0;
  const KEYS = ["LOKI_DIR", "LOKI_RECEIPT_SIGNING_KEY", "LOKI_RECEIPT_SIGNING_KEY_FILE", "PATH"];

  function capture(): void {
    cap = { stdout: "", stderr: "" };
    const oOut = process.stdout.write.bind(process.stdout);
    const oErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: unknown): boolean => ((cap.stdout += String(c)), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown): boolean => ((cap.stderr += String(c)), true)) as typeof process.stderr.write;
    restore = () => {
      process.stdout.write = oOut;
      process.stderr.write = oErr;
    };
  }

  function sealRun(verdict: string, signed = true, note?: string): string {
    const id = `e10-pb-${n++}`;
    const dir = join(scratch, "runs", id);
    const ev = join(dir, "events.jsonl");
    mkdirSync(dir, { recursive: true });
    const log = new SupervisorLog(ev, id);
    log.append("run.started", null, { provider: "claude" });
    if (note) {
      // SupervisorLog.append redacts since Q17-05b; plant the raw token through the underlying writer, keeping the running hash in step, so the share-time scan is what is under test.
      const raw = log as unknown as { log: { append(t: string, s: null, d: Record<string, unknown>): unknown }; hash: { update(x: string): unknown } };
      raw.hash.update(JSON.stringify(raw.log.append("run.note", null, { note })) + "\n");
    }
    const evSha = new Bun.CryptoHasher("sha256").update(readFileSync(ev)).digest("hex");
    const body = { schema: "loki.v10.receipt/1", run_id: id, verdict, events_sha256: evSha, time: { wall_s: 0, stages: {} }, log_seal: true };
    const hash = receiptSha256(body as never);
    writeFileSync(
      join(dir, "receipt.json"),
      JSON.stringify({ ...body, receipt_sha256: hash, verification: signed ? signReceipt(id, hash) : { jwt: null, kid: null } }, null, 2),
    );
    log.append("receipt.sealed", "seal", { receipt_sha256: hash });
    log.verify();
    log.append("run.completed", null, {});
    log.sealLog();
    return id;
  }

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    scratch = mkdtempSync(join(tmpdir(), "loki-adopt03-"));
    process.env["LOKI_DIR"] = scratch;
    process.env["LOKI_RECEIPT_SIGNING_KEY"] = "";
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(scratch, "k.pem");
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  it("VERIFIED sealed run: badge prints green, exit 0", async () => {
    const id = sealRun("VERIFIED");
    expect(existsSync(join(scratch, "proofs"))).toBe(false);
    capture();
    const code = await runProof(["badge", id]);
    restore();
    expect(code).toBe(0);
    expect(cap.stdout).toContain("brightgreen");
  });

  it("ALREADY_SATISFIED sealed run: its own label, not green", async () => {
    const id = sealRun("ALREADY_SATISFIED");
    capture();
    const code = await runProof(["badge", id]);
    restore();
    expect(code).toBe(0);
    expect(cap.stdout).toContain("Already%20satisfied");
    expect(cap.stdout).not.toContain("brightgreen");
  });

  it("tampered receipt: no badge, non-zero", async () => {
    const id = sealRun("VERIFIED");
    const p = join(scratch, "runs", id, "receipt.json");
    writeFileSync(p, readFileSync(p, "utf8").replace('"wall_s": 0', '"wall_s": 1'));
    capture();
    const code = await runProof(["badge", id]);
    restore();
    expect(code).not.toBe(0);
    expect(cap.stdout).not.toContain("shields.io");
    expect(cap.stderr).toContain("TAMPERED");
  });

  it("unsigned receipt: no badge, non-zero", async () => {
    const id = sealRun("VERIFIED", false);
    capture();
    const code = await runProof(["badge", id]);
    restore();
    expect(code).not.toBe(0);
    expect(cap.stdout).not.toContain("shields.io");
  });

  it("signed but PARTIAL receipt verdict: no badge, non-zero", async () => {
    const id = sealRun("PARTIAL");
    capture();
    const code = await runProof(["badge", id]);
    restore();
    expect(code).not.toBe(0);
    expect(cap.stdout).not.toContain("shields.io");
  });

  it("receipt copied under another run id: no badge, no bundle, no share", async () => {
    const src = sealRun("VERIFIED");
    const other = "e10-pb-copied";
    mkdirSync(join(scratch, "runs", other), { recursive: true });
    for (const f of ["receipt.json", "events.jsonl"]) writeFileSync(join(scratch, "runs", other, f), readFileSync(join(scratch, "runs", src, f)));
    capture();
    const badge = await runProof(["badge", other]);
    restore();
    expect(badge).not.toBe(0);
    expect(cap.stdout).not.toContain("shields.io");
    expect(cap.stderr).toContain("TAMPERED");
    const out = join(scratch, "out-copied");
    capture();
    const bundle = await runProof(["bundle", other, "--out", out]);
    restore();
    expect(bundle).not.toBe(0);
    expect(existsSync(out)).toBe(false);
    capture();
    const share = await runProof(["share", other, "--yes", "--dry-run"]);
    restore();
    expect(share).not.toBe(0);
    expect(cap.stdout).not.toContain("Would publish");
  });

  it("path-traversal id is not resolved", async () => {
    capture();
    const code = await runProof(["badge", "../runs/x"]);
    restore();
    expect(code).toBe(1);
  });

  it("bundle writes the four files; tampered run is refused with nothing written", async () => {
    const id = sealRun("VERIFIED");
    const out = join(scratch, "out");
    capture();
    const code = await runProof(["bundle", id, "--out", out]);
    restore();
    expect(code).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["VERIFY.md", "events.jsonl", "pubkey.jwk", "receipt.json"]);

    const bad = sealRun("VERIFIED");
    const p = join(scratch, "runs", bad, "receipt.json");
    writeFileSync(p, readFileSync(p, "utf8").replace('"wall_s": 0', '"wall_s": 1'));
    const out2 = join(scratch, "out2");
    capture();
    const code2 = await runProof(["bundle", bad, "--out", out2]);
    restore();
    expect(code2).not.toBe(0);
    expect(existsSync(out2)).toBe(false);
  });

  it("share with a stubbed gh receives only bundle files, never the key or the .loki tree", async () => {
    const id = sealRun("VERIFIED");
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const log = join(scratch, "gh.log");
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = "gist" ]; then echo https://gist.github.com/x/abc; fi\nexit 0\n`);
    chmodSync(join(bin, "gh"), 0o755);
    process.env["PATH"] = `${bin}:${saved["PATH"] ?? ""}`;
    capture();
    const code = await runProof(["share", id, "--yes"]);
    restore();
    expect(cap.stderr).toBe("");
    expect(code).toBe(0);
    const line = readFileSync(log, "utf8").split("\n").find((l) => l.startsWith("gist create")) ?? "";
    const names = line.split(" ").filter((t) => t.includes("/")).map((t) => t.split("/").pop());
    expect(names.sort()).toEqual(["VERIFY.md", "events.jsonl", "pubkey.jwk", "receipt.json"]);
    expect(line).not.toContain("k.pem");
    expect(line).not.toContain(scratch + "/runs");
    expect(cap.stdout).toContain("gist.github.com/x/abc");
    expect(cap.stdout).toContain("brightgreen");
  });

  it("share refuses (even with --yes) when events.jsonl holds a GitHub token, and never calls gh gist", async () => {
    const tok = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const id = sealRun("VERIFIED", true, tok);
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const log = join(scratch, "gh.log");
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
    chmodSync(join(bin, "gh"), 0o755);
    process.env["PATH"] = `${bin}:${saved["PATH"] ?? ""}`;
    capture();
    const code = await runProof(["share", id, "--yes"]);
    restore();
    expect(code).toBe(1);
    expect(cap.stderr).toContain("Share refused");
    expect(cap.stderr).toContain("events.jsonl");
    expect(readFileSync(log, "utf8")).not.toContain("gist create");
  });
});
