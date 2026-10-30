// Bash-vs-Bun parity tests for `loki proof` (R1, SLICE B).
//
// The bin/loki shim allowlist includes "proof" (bin/loki line ~119), so when
// bun is installed the Bun route (loki-ts/src/commands/proof.ts) is LIVE. The
// bash cmd_proof (autonomy/loki) is the fallback for no-bun systems and the
// LOKI_LEGACY_BASH=1 escape hatch. Divergences between the two are user-visible,
// so this file asserts byte-equal stdout + matching exit codes for `list` and
// equivalent JSON for `show`, including these edge cases the council flagged:
//   - empty proofs dir: BOTH print "No proofs found" with NO header row.
//   - null fields (final_verdict/cost.usd/count): BOTH render "-", not "None".
//
// Parity is taken over the source routes (bun src/cli.ts vs autonomy/loki),
// not the dist build, so a stale dist/loki.js cannot mask a source regression.
// NO_COLOR=1 is set for both spawns: both routes honor it (colors.ts:9,
// autonomy/loki:37) so the colored "No proofs found" line is byte-comparable.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { SupervisorLog } from "../../src/engine10/supervisor.ts";
import { receiptSha256, signReceipt } from "../../src/engine10/stages/seal.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { run } from "../../src/util/shell.ts";
import { runProof } from "../../src/commands/proof.ts";
import { buildReceiptBundle } from "../../src/util/receipt_bundle.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const BUN_CLI = resolve(REPO_ROOT, "loki-ts", "src", "cli.ts");
const BASH_CLI = resolve(REPO_ROOT, "autonomy", "loki");

let scratch = "";
let originalLokiDir: string | undefined;

// Both routes resolve the proofs dir from LOKI_DIR. An absolute scratch path
// means the spawned subprocesses' cwd is irrelevant.
function bunRoute(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(["bun", BUN_CLI, ...argv], {
    env: { LOKI_DIR: scratch, NO_COLOR: "1" },
    timeoutMs: 30000,
  });
}

function bashRoute(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run([BASH_CLI, ...argv], {
    env: { LOKI_DIR: scratch, NO_COLOR: "1" },
    timeoutMs: 30000,
  });
}

function seedProof(id: string, proof: Record<string, unknown>): void {
  const dir = join(scratch, "proofs", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proof.json"), JSON.stringify(proof, null, 2));
}

// A full proof with only ASCII strings, integers, and a clean decimal. Avoids
// the python-str-vs-JS-String divergences (booleans -> True/true, floats like
// 1.0 -> "1.0"/"1") that would break byte-equality of the `list` row.
const FULL_PROOF = {
  run_id: "run-20260603-abc123",
  generated_at: "2026-06-03T12:00:00Z",
  council: { final_verdict: "APPROVE" },
  cost: { usd: "0.42" },
  files_changed: { count: 7 },
  redaction: { applied: "true", rules_version: "1", redactions_count: 3 },
};

// A degraded proof with explicitly-null fields. Pre-fix, bash rendered these
// as "None" (str(None)) while Bun rendered "-". Both must now render "-".
const NULL_PROOF = {
  run_id: "run-20260603-null01",
  generated_at: "2026-06-03T13:00:00Z",
  council: { final_verdict: null },
  cost: { usd: null },
  files_changed: { count: null },
};

beforeEach(() => {
  originalLokiDir = process.env["LOKI_DIR"];
  scratch = mkdtempSync(join(tmpdir(), "loki-proof-parity-"));
});

afterEach(() => {
  if (originalLokiDir === undefined) delete process.env["LOKI_DIR"];
  else process.env["LOKI_DIR"] = originalLokiDir;
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

describe("loki proof: bash vs Bun parity (list)", () => {
  it("empty proofs dir: both print 'No proofs found' with NO header, exit 0", async () => {
    mkdirSync(join(scratch, "proofs"), { recursive: true });
    const a = await bunRoute(["proof", "list"]);
    const b = await bashRoute(["proof", "list"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain("No proofs found");
    expect(a.stdout).not.toContain("RUN_ID");
    expect(b.stdout).not.toContain("RUN_ID");
  });

  it("missing proofs dir: both print 'No proofs found', exit 0", async () => {
    // No proofs/ dir created at all.
    const a = await bunRoute(["proof", "list"]);
    const b = await bashRoute(["proof", "list"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain("No proofs found");
  });

  it("full proof: both render identical header + row, exit 0", async () => {
    seedProof("run-20260603-abc123", FULL_PROOF);
    const a = await bunRoute(["proof", "list"]);
    const b = await bashRoute(["proof", "list"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain("RUN_ID");
    expect(a.stdout).toContain("run-20260603-abc123");
    expect(a.stdout).toContain("APPROVE");
  });

  it("null fields: both render '-' (not 'None'), identical output, exit 0", async () => {
    seedProof("run-20260603-null01", NULL_PROOF);
    const a = await bunRoute(["proof", "list"]);
    const b = await bashRoute(["proof", "list"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).not.toContain("None");
    expect(b.stdout).not.toContain("None");
    // run_id (non-null) followed by null verdict/cost/count all as "-".
    expect(a.stdout).toContain("run-20260603-null01");
    expect(a.stdout).toMatch(/-\s+-\s+-/);
  });

  it("multiple proofs (full + null): identical sorted output, exit 0", async () => {
    seedProof("run-20260603-abc123", FULL_PROOF);
    seedProof("run-20260603-null01", NULL_PROOF);
    const a = await bunRoute(["proof", "list"]);
    const b = await bashRoute(["proof", "list"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });
});

describe("loki proof: bash vs Bun parity (show)", () => {
  it("valid id: both emit equivalent JSON, exit 0", async () => {
    seedProof("run-20260603-abc123", FULL_PROOF);
    const a = await bunRoute(["proof", "show", "run-20260603-abc123", "--json"]);
    const b = await bashRoute(["proof", "show", "run-20260603-abc123", "--json"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    // Compare structurally: bash uses jq (if present) else python json.dumps,
    // Bun uses JSON.stringify. All emit 2-space-indented JSON of the same data,
    // but deep-equal is robust to any whitespace/key-order formatting drift.
    expect(JSON.parse(a.stdout)).toEqual(JSON.parse(b.stdout));
    expect(JSON.parse(a.stdout)).toEqual(FULL_PROOF);
  });

  it("default output is the compact summary on both routes (LM-005)", async () => {
    seedProof("run-20260603-abc123", FULL_PROOF);
    const a = await bunRoute(["proof", "show", "run-20260603-abc123"]);
    const b = await bashRoute(["proof", "show", "run-20260603-abc123"]);
    expect(a.exitCode).toBe(b.exitCode);
    expect(a.stdout.trim().split("\n").length).toBeLessThanOrEqual(14);
    expect(a.stdout).not.toContain('"schema_version"');
    // Both routes call the one shared summarizer, so the label line agrees.
    expect(a.stdout.split("\n")[0]).toBe(b.stdout.split("\n")[0]);
    expect(a.stdout).toContain("integrity:");
  });

  it("missing id: both exit 1 with not-found message", async () => {
    seedProof("run-20260603-abc123", FULL_PROOF);
    const a = await bunRoute(["proof", "show", "does-not-exist"]);
    const b = await bashRoute(["proof", "show", "does-not-exist"]);
    expect(a.exitCode).toBe(1);
    expect(b.exitCode).toBe(1);
    expect(a.stderr + a.stdout).toContain("not found");
    expect(b.stderr + b.stdout).toContain("not found");
  });

  it("no id arg: both exit 2", async () => {
    const a = await bunRoute(["proof", "show"]);
    const b = await bashRoute(["proof", "show"]);
    expect(a.exitCode).toBe(2);
    expect(b.exitCode).toBe(2);
  });
});

// In-process Bun unit checks (fast, no spawn) for the str()/listProofs edge
// cases, mirroring the existing command-test style (rollback.test.ts).
describe("loki proof: Bun in-process edge cases", () => {
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

  beforeEach(() => {
    process.env["LOKI_DIR"] = scratch;
  });

  it("empty proofs dir prints no header", async () => {
    mkdirSync(join(scratch, "proofs"), { recursive: true });
    captureOutput();
    const code = await runProof(["list"]);
    restore();
    expect(code).toBe(0);
    expect(captured.stdout).toContain("No proofs found");
    expect(captured.stdout).not.toContain("RUN_ID");
  });

  it("null fields render '-' not 'None'", async () => {
    seedProof("run-20260603-null01", NULL_PROOF);
    captureOutput();
    const code = await runProof(["list"]);
    restore();
    expect(code).toBe(0);
    expect(captured.stdout).not.toContain("None");
    expect(captured.stdout).toContain("-");
  });

  it("help exits 0, no-arg exits 1", async () => {
    captureOutput();
    const help = await runProof(["help"]);
    const bare = await runProof([]);
    restore();
    expect(help).toBe(0);
    expect(bare).toBe(1);
  });
});

// F47 regression: `loki proof verify` must exist on the Bun (default) route and
// behave identically to the bash route. The finish-and-own doc (loki own) tells
// users to run exactly this command, so a missing-on-default-route gap is a
// trust-breaking dead end. Both routes shell out to autonomy/lib/proof-verify.py.
describe("loki proof: verify is routed on Bun + parity with bash (F47)", () => {
  it("Bun route knows 'verify' (NOT 'Unknown subcommand') and reports it in help", async () => {
    const help = await bunRoute(["proof", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("verify");
  });

  // Exit contract (docs/exit-codes.md): 64 usage, 66 input missing. These were
  // 2 and 1, which collided with "could not check" and "tamper/drift".
  it("missing id: both routes exit 64 (usage) with the same message", async () => {
    const a = await bunRoute(["proof", "verify"]);
    const b = await bashRoute(["proof", "verify"]);
    expect(a.exitCode).toBe(64);
    expect(b.exitCode).toBe(64);
  });

  it("unknown proof id: both routes exit 66 (input missing, not 'Unknown subcommand')", async () => {
    const a = await bunRoute(["proof", "verify", "does-not-exist"]);
    const b = await bashRoute(["proof", "verify", "does-not-exist"]);
    expect(a.exitCode).toBe(66);
    expect(b.exitCode).toBe(66);
    expect(a.stderr).not.toContain("Unknown subcommand");
    expect(a.stderr).toContain("not found");
  });

  it("a seeded proof: both routes produce byte-identical verifier output + exit code", async () => {
    // Minimal proof the verifier can load; it will report a base-unresolvable
    // drift (no base_sha) deterministically and identically on both routes.
    seedProof("run-verify-parity", {
      run_id: "run-verify-parity",
      generated_at: "2026-06-20T00:00:00Z",
      honesty: { headline: "VERIFIED WITH GAPS", degraded: [] },
      facts: { git: { diff: { count: 1, insertions: 1, deletions: 0 } } },
    });
    const a = await bunRoute(["proof", "verify", "run-verify-parity"]);
    const b = await bashRoute(["proof", "verify", "run-verify-parity"]);
    expect(a.stdout).toBe(b.stdout);
    expect(a.exitCode).toBe(b.exitCode);
  });
});

// F51 regression: proof list VERDICT must read honesty.headline (the honest
// verdict), falling back to legacy council.final_verdict for old proofs.
describe("loki proof list: VERDICT reads honesty.headline (F51)", () => {
  it("renders the honesty headline in the verdict column", async () => {
    seedProof("run-headline", {
      run_id: "run-headline",
      generated_at: "2026-06-20T00:00:00Z",
      honesty: { headline: "VERIFIED WITH GAPS" },
      cost: { usd: "0.10" },
      files_changed: { count: 1 },
    });
    const a = await bunRoute(["proof", "list"]);
    expect(a.exitCode).toBe(0);
    expect(a.stdout).toContain("VERIFIED WITH GAPS");
  });
});

// F47: `loki receipt` is a friendly alias for `loki proof` on the Bun route too
// (parity with the bash proof|receipt dispatch). own/docs may reference either.
describe("loki receipt: Bun alias for proof (F47)", () => {
  it("receipt --help shows the proof help including verify", async () => {
    const r = await bunRoute(["receipt", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("verify");
  });
  it("receipt list behaves like proof list (empty dir, exit 0)", async () => {
    const r = await bunRoute(["receipt", "list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No proofs found");
  });
});

// TEN-ADOPTION-13: share --dry-run scans and lists, never publishes.
describe("loki proof share --dry-run", () => {
  function seedPage(id: string, html: string): void {
    seedProof(id, { run_id: id, redaction: { applied: true } });
    writeFileSync(join(scratch, "proofs", id, "index.html"), html);
  }
  // A fake gh on PATH that records every call, so "publishes nothing" is observable.
  function fakeGh(): { bin: string; log: string } {
    const bin = join(scratch, "fakebin");
    const log = join(scratch, "gh.log");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`, { mode: 0o755 });
    return { bin, log };
  }
  function share(argv: string[], bin: string) {
    return run(["bun", BUN_CLI, "proof", "share", ...argv], {
      env: { LOKI_DIR: scratch, NO_COLOR: "1", PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      timeoutMs: 60000,
    });
  }

  it("clean page: lists the file, exit 0, gh never called", async () => {
    seedPage("p-clean", "<html>hello</html>");
    const g = fakeGh();
    const r = await share(["p-clean", "--dry-run"], g.bin);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Would publish:");
    expect(r.stdout).toContain("index.html");
    expect(r.stdout).toContain("redaction scan: 0 findings");
    expect(existsSync(g.log)).toBe(false);
  });

  it("page with a token: exit 1, finding reported, gh never called", async () => {
    seedPage("p-dirty", `<html>ghp_aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5</html>`);
    const g = fakeGh();
    const r = await share(["p-dirty", "--dry-run", "--yes"], g.bin);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("share would be refused");
    expect(existsSync(g.log)).toBe(false);
  });

  it("unknown id still fails with --dry-run", async () => {
    const g = fakeGh();
    const r = await share(["nope", "--dry-run"], g.bin);
    expect(r.exitCode).toBe(1);
  });

  it("gist visibility: secret by default and with --private, public only with --public", async () => {
    seedPage("p-vis", "<html>hello</html>");
    const g = fakeGh();
    const gistLines = (): string[] =>
      readFileSync(g.log, "utf8").split("\n").filter((l) => l.startsWith("gist create"));
    for (const argv of [["p-vis", "--yes"], ["p-vis", "--yes", "--private"]]) {
      rmSync(g.log, { force: true });
      const r = await share(argv, g.bin);
      expect(r.exitCode).toBe(0);
      expect(gistLines().length).toBe(1);
      expect(gistLines()[0]).not.toContain("--public");
      expect(r.stderr).not.toContain("PUBLIC and visible");
    }
    rmSync(g.log, { force: true });
    const pub = await share(["p-vis", "--yes", "--public"], g.bin);
    expect(pub.exitCode).toBe(0);
    expect(gistLines()[0]).toContain("--public");
    expect(pub.stderr).toContain("PUBLIC and visible to anyone with the URL");
  });
});

// TEN-ADOPTION-14: list --json prints the index as a machine-readable array.
describe("loki proof list --json", () => {
  it("prints [{id, verdict, created}] newest first through the CLI", async () => {
    seedProof("run-old", { run_id: "run-old", generated_at: "2026-06-01T00:00:00Z", council: { final_verdict: "APPROVE" } });
    seedProof("run-new", { run_id: "run-new", generated_at: "2026-06-09T00:00:00Z", honesty: { headline: "VERIFIED WITH GAPS" } });
    seedProof("run-none", {});
    const r = await bunRoute(["proof", "list", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      { id: "run-new", verdict: "VERIFIED WITH GAPS", created: "2026-06-09T00:00:00Z" },
      { id: "run-old", verdict: "APPROVE", created: "2026-06-01T00:00:00Z" },
      { id: "run-none", verdict: null, created: null },
    ]);
  });

  it("text output is unchanged without --json", async () => {
    seedProof("run-t", { run_id: "run-t", generated_at: "2026-06-01T00:00:00Z" });
    const r = await bunRoute(["proof", "list"]);
    expect(r.stdout).toContain("RUN_ID");
    expect(r.stdout.trimStart().startsWith("[")).toBe(false);
  });

  it("empty or missing proofs dir prints []", async () => {
    const r = await bunRoute(["proof", "list", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });
});

describe("loki proof bundle --audit <from>..<to>", () => {
  const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  let repo = "";
  let prevCwd = "";
  const saved: Record<string, string | undefined> = {};
  const heads: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
    for (const k of ["LOKI_DIR", "LOKI_RECEIPT_SIGNING_KEY_FILE", "LOKI_RECEIPT_SIGNING_KEY"]) saved[k] = process.env[k];
    repo = mkdtempSync(join(tmpdir(), "loki-audit-"));
    process.env["LOKI_RECEIPT_SIGNING_KEY"] = "";
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(repo, "k.pem");
    process.env["LOKI_DIR"] = join(repo, ".loki");
    git(repo, ["init", "-q", "-b", "main"]);
    heads.length = 0;
    for (let i = 0; i <= 6; i++) {
      writeFileSync(join(repo, "f.txt"), `v${i}\n`);
      git(repo, ["add", "f.txt"]);
      git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `c${i}`]);
      heads.push(git(repo, ["rev-parse", "HEAD"]).stdout.trim());
      if (i === 0) git(repo, ["tag", "base"]);
    }
    for (let i = 1; i <= 6; i++) seedRun(`run-${i}`, heads[i]!);
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(repo, { recursive: true, force: true });
  });

  function seedRun(id: string, head: string | null, verdict = "VERIFIED", lokiRoot = ".loki"): void {
    const dir = join(repo, lokiRoot, "runs", id);
    const ev = join(dir, "events.jsonl");
    mkdirSync(dir, { recursive: true });
    const log = new SupervisorLog(ev, id);
    log.append("run.started", null, { provider: "claude" });
    const evSha = new Bun.CryptoHasher("sha256").update(readFileSync(ev)).digest("hex");
    const body = { schema: "loki.v10.receipt/1", run_id: id, verdict, ...(head === null ? {} : { head_sha: head }), events_sha256: evSha, time: { wall_s: 0, stages: {} }, log_seal: true };
    const hash = receiptSha256(body as never);
    writeFileSync(join(dir, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: hash, verification: signReceipt(id, hash) }, null, 2));
    log.append("receipt.sealed", "seal", { receipt_sha256: hash });
    log.verify();
    log.append("run.completed", null, {});
    log.sealLog();
  }

  const bundle = (out: string, range = "base..main"): Promise<number> => runProof(["bundle", "--audit", range, "--out", out]);
  function extract(archive: string): string {
    const dest = join(repo, "x");
    mkdirSync(dest, { recursive: true });
    expect(spawnSync("tar", ["-xzf", archive, "-C", dest]).status).toBe(0);
    return dest;
  }
  const runScript = (dest: string, args: string[] = [], env: Record<string, string> = {}) =>
    spawnSync("sh", [join(dest, "verify.sh"), ...args], { encoding: "utf8", env: { ...process.env, LOKI_AUDIT_VERIFIER: `bun ${BUN_CLI} engine10 verify`, ...env } });
  const kidOfRun = (dest: string, id: string): string => JSON.parse(readFileSync(join(dest, "receipts", id, "pubkey.jwk"), "utf8")).kid as string;

  it("archive holds 6 receipts and a 6-row CSV index", async () => {
    const out = join(repo, "audit.tgz");
    expect(await bundle(out)).toBe(0);
    const dest = extract(out);
    const rows = readFileSync(join(dest, "index.csv"), "utf8").trim().split("\n");
    expect(rows[0]).toBe("run_id,commit,verdict,date");
    expect(rows.length).toBe(7);
    for (let i = 1; i <= 6; i++) {
      expect(existsSync(join(dest, "receipts", `run-${i}`, "receipt.json"))).toBe(true);
      expect(rows.some((r) => r.startsWith(`run-${i},${heads[i]},VERIFIED,`))).toBe(true);
    }
    expect(existsSync(join(dest, "verify.sh"))).toBe(true);
  });

  it("bundled verify.sh exits 0 with an explicit verifier", async () => {
    const out = join(repo, "audit.tgz");
    expect(await bundle(out)).toBe(0);
    const r = runScript(extract(out));
    expect(r.stdout).toContain("6 receipt(s) checked");
    expect(r.status).toBe(0);
  }, 60000);

  it("tampering with one receipt makes verify.sh exit non-zero and name it", async () => {
    const out = join(repo, "audit.tgz");
    expect(await bundle(out)).toBe(0);
    const dest = extract(out);
    const rp = join(dest, "receipts", "run-3", "receipt.json");
    writeFileSync(rp, readFileSync(rp, "utf8").replace('"VERIFIED"', '"FAILED"'));
    const r = runScript(dest);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("FAIL run-3");
    expect(r.stdout).not.toContain("FAIL run-2");
  }, 60000);

  it("range refs are data: option-like and malformed ranges are refused, no archive written", async () => {
    for (const bad of ["--output=x..main", "base..main;touch pwned", "base", "..main", "base..$(id)"]) {
      expect(await bundle(join(repo, "bad.tgz"), bad)).not.toBe(0);
    }
    expect(existsSync(join(repo, "bad.tgz"))).toBe(false);
    expect(existsSync(join(repo, "pwned"))).toBe(false);
  });

  it("index.csv carries each receipt's own signed verdict and verify.sh prints its verifier first", async () => {
    seedRun("run-7", heads[6]!, "PARTIAL");
    const out = join(repo, "audit.tgz");
    expect(await bundle(out)).toBe(0);
    const dest = extract(out);
    expect(readFileSync(join(dest, "index.csv"), "utf8")).toContain(`run-7,${heads[6]},PARTIAL,`);
    const r = runScript(dest);
    expect(r.stdout.split("\n")[0]).toContain("verifier: ");
    expect(r.stdout).toContain("OUTCOME run-7: integrity OK, run outcome not verified");
    expect(r.stdout).not.toContain("FAIL run-7");
    expect(r.status).toBe(4);
  }, 60000);

  it("editing an index.csv verdict or commit makes verify.sh exit non-zero", async () => {
    const out = join(repo, "audit.tgz");
    expect(await bundle(out)).toBe(0);
    const dest = extract(out);
    const idx = join(dest, "index.csv");
    const orig = readFileSync(idx, "utf8");
    writeFileSync(idx, orig.replace(`run-2,${heads[2]},VERIFIED`, `run-2,${heads[2]},FAILED`));
    let r = runScript(dest);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("run-2: index verdict 'FAILED' differs from signed verdict 'VERIFIED'");
    writeFileSync(idx, orig.replace(`run-2,${heads[2]}`, `run-2,${heads[3]}`));
    r = runScript(dest);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("run-2: index commit");
  }, 60000);

  it("a deleted receipt directory fails, with or without its index row; an unlisted one fails too", async () => {
    const out = join(repo, "audit.tgz");
    expect(await bundle(out)).toBe(0);
    const dest = extract(out);
    const idx = join(dest, "index.csv");
    const orig = readFileSync(idx, "utf8");
    rmSync(join(dest, "receipts", "run-4"), { recursive: true });
    let r = runScript(dest);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("run-4: receipt missing");
    writeFileSync(idx, orig.split("\n").filter((l) => !l.startsWith("run-4,")).join("\n"));
    r = runScript(dest);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("archive was built with 6");
    mkdirSync(join(dest, "receipts", "run-ghost"), { recursive: true });
    writeFileSync(idx, orig);
    r = runScript(dest);
    expect(r.stdout).toContain("run-ghost: receipt directory has no index.csv row");
    expect(r.status).toBe(1);
  }, 60000);

  it("prints each key id; a forged receipt under a second key in a genuine archive fails; pinning works", async () => {
    const out = join(repo, "audit.tgz");
    expect(await bundle(out)).toBe(0);
    const dest = extract(out);
    const good = kidOfRun(dest, "run-1");
    let r = runScript(dest);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`OK   run-1 (kid ${good})`);
    expect(r.stdout).toContain("internally consistent only");
    r = runScript(dest, ["--expect-kid", good]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`key id pinned to ${good}`);
    r = runScript(dest, [], { LOKI_AUDIT_EXPECT_KID: "not-the-key" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("is not the pinned key id");
    // forge run-2 under a second key, valid on its own
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(repo, "k2.pem");
    seedRun("run-2", heads[2]!, "VERIFIED", ".loki2");
    const forged = join(repo, "forged");
    expect((await buildReceiptBundle(join(repo, ".loki2", "runs", "run-2"), forged)).ok).toBe(true);
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(repo, "k.pem");
    rmSync(join(dest, "receipts", "run-2"), { recursive: true });
    cpSync(forged, join(dest, "receipts", "run-2"), { recursive: true });
    r = runScript(dest);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("mixes 2 different signing keys");
  }, 60000);

  it("refuses, listing every run whose receipt cannot be read (unparseable or DSSE), writing no archive", async () => {
    mkdirSync(join(repo, ".loki", "runs", "run-bad"), { recursive: true });
    writeFileSync(join(repo, ".loki", "runs", "run-bad", "receipt.json"), "{ not json");
    mkdirSync(join(repo, ".loki", "runs", "run-dsse"), { recursive: true });
    writeFileSync(join(repo, ".loki", "runs", "run-dsse", "receipt.json"), JSON.stringify({ payloadType: "application/vnd.in-toto+json", payload: "e30=", signatures: [] }));
    const errs: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => (errs.push(String(c)), true)) as typeof process.stderr.write;
    let rc: number;
    try { rc = await bundle(join(repo, "audit.tgz")); } finally { process.stderr.write = orig; }
    expect(rc).not.toBe(0);
    expect(errs.join("")).toContain("run-bad");
    expect(errs.join("")).toContain("run-dsse");
    expect(existsSync(join(repo, "audit.tgz"))).toBe(false);
  });

  describe("forged archives the sed-based verify.sh accepted", () => {
    // A genuine same-key receipt for a commit outside base..main (heads[0] is base itself).
    async function outsideBundle(): Promise<string> {
      seedRun("run-x", heads[0]!, "VERIFIED", ".lokix");
      const dir = join(repo, "outside");
      rmSync(dir, { recursive: true, force: true });
      expect((await buildReceiptBundle(join(repo, ".lokix", "runs", "run-x"), dir)).ok).toBe(true);
      return dir;
    }
    const swapIn = (dest: string, id: string, src: string) => { rmSync(join(dest, "receipts", id), { recursive: true }); cpSync(src, join(dest, "receipts", id), { recursive: true }); };
    const insertBefore = (file: string, needle: string, text: string) => { const t = readFileSync(file, "utf8"); expect(t).toContain(needle); writeFileSync(file, t.replace(needle, `${text}\n${needle}`)); };
    const archive = async () => { const out = join(repo, "audit.tgz"); expect(await bundle(out)).toBe(0); return extract(out); };

    it("B5: a retry receipt copied over a sibling run that shares its commit is refused", async () => {
      seedRun("run-2b", heads[2]!, "VERIFIED");
      const dest = await archive();
      expect(readFileSync(join(dest, "index.csv"), "utf8")).toContain("run-2b,");
      swapIn(dest, "run-2", join(dest, "receipts", "run-2b"));
      const r = runScript(dest, ["--expect-kid", kidOfRun(dest, "run-1")]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("run-2: signed run_id 'run-2b' differs from the index run id");
      expect(r.stdout).toContain("two rows hold the same signed receipt");
      expect(r.stdout).not.toContain("RESULT: OK");
    }, 60000);

    it("B6: a genuine same-key receipt of another run id cannot replace an in-range row", async () => {
      const dest = await archive();
      seedRun("run-ci", heads[2]!, "VERIFIED", ".lokix");
      const foreign = join(repo, "foreign");
      expect((await buildReceiptBundle(join(repo, ".lokix", "runs", "run-ci"), foreign)).ok).toBe(true);
      swapIn(dest, "run-2", foreign);
      const r = runScript(dest, ["--expect-kid", kidOfRun(dest, "run-1")]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("run-2: signed run_id 'run-ci' differs from the index run id");
      expect(r.stdout).toContain("run-2: signed receipt hash");
      expect(r.stdout).not.toContain("RESULT: OK");
    }, 60000);

    it("B5: coverage of the baked receipt hash set must equal its size", async () => {
      const dest = await archive();
      const vs = join(dest, "verify.sh");
      const t = readFileSync(vs, "utf8");
      expect(t).toContain("NSHAS=6");
      writeFileSync(vs, t.replace("NSHAS=6", "NSHAS=7"));
      const r = runScript(dest, ["--expect-kid", kidOfRun(dest, "run-1")]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("rows hold 6 distinct signed receipt(s), archive was built with 7");
    }, 60000);

    it("a bundled pubkey.jwk that does not verify its receipt is FAILED, not UNCHECKED", async () => {
      const dest = await archive();
      process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(repo, "k4.pem");
      seedRun("run-2", heads[2]!, "VERIFIED", ".loki4");
      const other = join(repo, "other");
      expect((await buildReceiptBundle(join(repo, ".loki4", "runs", "run-2"), other)).ok).toBe(true);
      process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(repo, "k.pem");
      cpSync(join(other, "pubkey.jwk"), join(dest, "receipts", "run-2", "pubkey.jwk"));
      const r = runScript(dest);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("run-2: the bundled pubkey.jwk does not verify this receipt");
      expect(r.stdout).not.toContain("RESULT: UNCHECKED");
    }, 60000);

    it("B1: a duplicate head_sha line placed before the signed one is refused", async () => {
      const dest = await archive();
      swapIn(dest, "run-2", await outsideBundle());
      insertBefore(join(dest, "receipts", "run-2", "receipt.json"), '  "head_sha"', `  "head_sha": "${heads[2]}",`);
      const r = runScript(dest, ["--expect-kid", kidOfRun(dest, "run-1")]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("run-2");
      expect(r.stdout).not.toContain("RESULT: OK");
    }, 60000);

    it("B1: a duplicate verdict line placed before the signed one is refused", async () => {
      const dest = await archive();
      seedRun("run-p", heads[2]!, "PARTIAL", ".lokix");
      const pd = join(repo, "partial");
      expect((await buildReceiptBundle(join(repo, ".lokix", "runs", "run-p"), pd)).ok).toBe(true);
      swapIn(dest, "run-2", pd);
      insertBefore(join(dest, "receipts", "run-2", "receipt.json"), '  "verdict"', '  "verdict": "VERIFIED",');
      const r = runScript(dest, ["--expect-kid", kidOfRun(dest, "run-1")]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("run-2: index verdict 'VERIFIED' differs from signed verdict 'PARTIAL'");
    }, 60000);

    it("B2: an attacker-key receipt with a spoofed kid line and a spoofed pubkey.jwk kid field is refused", async () => {
      const dest = await archive();
      const legit = kidOfRun(dest, "run-1");
      process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(repo, "k3.pem");
      seedRun("run-2", heads[2]!, "VERIFIED", ".loki3");
      const evil = join(repo, "evil");
      expect((await buildReceiptBundle(join(repo, ".loki3", "runs", "run-2"), evil)).ok).toBe(true);
      process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(repo, "k.pem");
      swapIn(dest, "run-2", evil);
      insertBefore(join(dest, "receipts", "run-2", "receipt.json"), '  "verification": {', `  "verification": {\n    "kid": "${legit}"\n  },`);
      const jwk = join(dest, "receipts", "run-2", "pubkey.jwk");
      writeFileSync(jwk, `${JSON.stringify({ ...JSON.parse(readFileSync(jwk, "utf8")), kid: legit })}\n`);
      const r = runScript(dest, ["--expect-kid", legit]);
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain("RESULT: OK");
      expect(r.stdout).toMatch(/thumbprint|not the pinned key id/);
    }, 60000);

    it("B3: a genuine receipt for a commit outside the range cannot replace an in-range row", async () => {
      const dest = await archive();
      swapIn(dest, "run-2", await outsideBundle());
      const idx = join(dest, "index.csv");
      writeFileSync(idx, readFileSync(idx, "utf8").replace(`run-2,${heads[2]}`, `run-2,${heads[0]}`));
      const r = runScript(dest, ["--expect-kid", kidOfRun(dest, "run-1")]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("run-2: commit");
      expect(r.stdout).toContain("not in the audited range");
      expect(r.stdout).not.toMatch(/^OK   run-2/m);
    }, 60000);

    it("a verifier reporting a signing kid that is not the bundled key's thumbprint is refused", async () => {
      const dest = await archive();
      const wrap = join(repo, "wrap.sh");
      writeFileSync(wrap, `#!/bin/sh\nbun ${BUN_CLI} engine10 verify "$@" | sed 's/"signing_kid":"[^"]*"/"signing_kid":"zzz"/'\n`, { mode: 0o755 });
      const r = runScript(dest, [], { LOKI_AUDIT_VERIFIER: wrap });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("signing key id 'zzz' is not the bundled key");
    }, 60000);

    it("a pubkey.jwk whose kid is not the RFC 7638 thumbprint of its key is refused", async () => {
      const dest = await archive();
      const jwk = join(dest, "receipts", "run-3", "pubkey.jwk");
      writeFileSync(jwk, `${JSON.stringify({ ...JSON.parse(readFileSync(jwk, "utf8")), kid: "not-the-thumbprint" })}\n`);
      const r = runScript(dest);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("run-3: pubkey.jwk kid");
      expect(r.stdout).not.toMatch(/^OK   run-3/m);
    }, 60000);

    it("a receipt with no head_sha is refused and listed, not silently skipped", async () => {
      seedRun("run-nohead", null);
      const errs: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((c: string | Uint8Array) => (errs.push(String(c)), true)) as typeof process.stderr.write;
      let rc: number;
      try { rc = await bundle(join(repo, "audit.tgz")); } finally { process.stderr.write = orig; }
      expect(rc).not.toBe(0);
      expect(errs.join("")).toContain("run-nohead");
      expect(errs.join("")).toContain("head_sha");
      expect(existsSync(join(repo, "audit.tgz"))).toBe(false);
    });

    it("an unlisted dot directory under receipts/ fails", async () => {
      const dest = await archive();
      mkdirSync(join(dest, "receipts", ".hidden"), { recursive: true });
      const r = runScript(dest);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(".hidden: receipt directory has no index.csv row");
    }, 60000);

    it("a malformed receipt prints FAIL only, never an OK line for the same run", async () => {
      const dest = await archive();
      writeFileSync(join(dest, "receipts", "run-1", "receipt.json"), "{ not json");
      const r = runScript(dest);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("FAIL run-1");
      expect(r.stdout).not.toMatch(/^OK   run-1/m);
    }, 60000);
  });

  describe("default verifier path (no LOKI_AUDIT_VERIFIER)", () => {
    function fakeBin(name: string): { dir: string; log: string } {
      const dir = join(repo, `fakebin-${name}`);
      mkdirSync(dir, { recursive: true });
      const log = join(dir, "calls.log");
      writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
      return { dir, log };
    }
    const noOverride = (dest: string, bin: string) => {
      const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
      delete env["LOKI_AUDIT_VERIFIER"];
      return spawnSync("sh", [join(dest, "verify.sh")], { encoding: "utf8", env: env as NodeJS.ProcessEnv });
    };
    it("uses an installed loki when present", async () => {
      const out = join(repo, "audit.tgz");
      expect(await bundle(out)).toBe(0);
      const f = fakeBin("loki");
      const r = noOverride(extract(out), f.dir);
      expect(r.status).toBe(2); // a verifier that prints no --json identity cannot back the index: UNCHECKED, never OK
      expect(r.stdout.split("\n")[0]).toBe('verifier: "loki verify"');
      expect(readFileSync(f.log, "utf8")).toContain("loki verify --json --pubkey pubkey.jwk receipt.json");
    }, 60000);
    it("has no npx fallback: without an installed loki the result is UNCHECKED (exit 2) and nothing is fetched", async () => {
      const out = join(repo, "audit.tgz");
      expect(await bundle(out)).toBe(0);
      const dest = extract(out);
      const f = fakeBin("npx");
      const r = noOverride(dest, f.dir);
      expect(r.status).toBe(2);
      expect(r.stdout).toContain("RESULT: UNCHECKED");
      expect(existsSync(f.log)).toBe(false);
      expect(readFileSync(join(dest, "verify.sh"), "utf8")).not.toMatch(/npx|offline|registry/i);
    }, 60000);
    it("a verifier that exits 2 is UNCHECKED, not FAILED", async () => {
      const out = join(repo, "audit.tgz");
      expect(await bundle(out)).toBe(0);
      const f = fakeBin("loki");
      writeFileSync(join(f.dir, "loki"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
      const r = noOverride(extract(out), f.dir);
      expect(r.status).toBe(2);
      expect(r.stdout).toContain("RESULT: UNCHECKED");
      expect(r.stdout).not.toContain("RESULT: FAILED");
    }, 60000);
  });
});
