// CW-12: `loki "<intent>" --seal-existing <patch>` seals changes an external client already made. Real engine, stub
// claude (no billed calls). The Wall is authored from the intent alone (information barrier, #208), the patch is applied
// only afterwards, no implement or fix session ever runs, and the receipt verifies.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyReceipt } from "../../src/engine10/verify_cmd.ts";

const LOKI_TS = resolve(import.meta.dir, "../..");
const BIN_LOKI = resolve(LOKI_TS, "../bin/loki");
const FIX = join(import.meta.dir, "fixtures", "e2e");
const ENTRY = process.env.E2E_LOKI_TS_ENTRY ?? join(LOKI_TS, "src", "cli.ts");
const INTENT = "add a multiply(a, b) function to calc.ts";
const temps: string[] = [];
afterAll(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

interface Sealed { code: number; out: string; patch: string; prompts: { wall: string; other: string }; calls: string[]; envLog: string; receiptPath: string; receipt: { verdict: string; jwt?: string | null; signature?: { jwt?: string | null } | null; checks: { name: string; result: string }[]; not_proven: string[]; task: { source: string; sha256: string }; implement?: { exit?: string } }; keyFile: string; repo: string; }

/** body is the multiply() the external client wrote; the patch is its diff against the committed base. */
function seal(body: string): Sealed {
  if (!existsSync(ENTRY)) throw new Error(`engine entry missing: ${ENTRY}`);
  const tmp = mkdtempSync(join(tmpdir(), "loki-cw12-")); temps.push(tmp);
  const keyDir = mkdtempSync(join(tmpdir(), "loki-cw12-key-")); temps.push(keyDir);
  const repo = join(tmp, "repo");
  cpSync(join(FIX, "repo"), repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.name", "e2e"); git(repo, "config", "user.email", "e2e@example.invalid");
  git(repo, "add", "calc.ts", "calc.test.ts", "bunfig.toml"); git(repo, "commit", "-q", "-m", "base");
  const calc = join(repo, "calc.ts"), base = readFileSync(calc, "utf8");
  writeFileSync(calc, `${base}\nexport function multiply(a: number, b: number): number {\n  return ${body};\n}\n`);
  const patch = join(tmp, "external.patch");
  writeFileSync(patch, git(repo, "diff", "HEAD", "--binary"));
  git(repo, "checkout", "--", "calc.ts"); // the engine starts on the clean base, exactly as the MCP tool's scratch clone does
  const prompts = join(tmp, "prompts"), stubLog = join(tmp, "stub.log"), envLog = join(tmp, "stub-env.log");
  const env: Record<string, string | undefined> = {
    ...process.env, LOKI_TS_ENTRY: ENTRY, LOKI_E10_INVOKER: "cli", LOKI_CLAUDE_CLI: join(FIX, "bin", "claude"),
    PATH: `${join(FIX, "bin")}:${process.env.PATH ?? ""}`, E2E_STUB_MODE: "wallcolor", E2E_STUB_LOG: stubLog, E2E_STUB_PROMPT_LOG: prompts, E2E_STUB_ENV_LOG: envLog,
    LOKI_NO_BROWSER: "1", LOKI_E10_PLAN: "1", LOKI_RECEIPT_SIGNING_KEY_FILE: join(keyDir, "k.pem"),
  };
  for (const k of ["LOKI_LEGACY_BASH", "LOKI_MODEL_OVERRIDE", "LOKI_RECEIPT_SIGNING_KEY", "LOKI_E10_SEAL_EXISTING_PATCH"]) delete env[k];
  const r = Bun.spawnSync(["bash", BIN_LOKI, INTENT, "--seal-existing", patch], { cwd: repo, env, timeout: 90_000 });
  const marker = JSON.parse(readFileSync(join(repo, ".loki", "engine.json"), "utf8")) as { run_id: string };
  const receiptPath = join(repo, ".loki", "runs", marker.run_id, "receipt.json");
  const rd = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
  return {
    code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString(), patch: readFileSync(patch, "utf8"),
    prompts: { wall: rd(`${prompts}.other1`), other: rd(`${prompts}.plan0`) + rd(`${prompts}.implement0`) },
    envLog: rd(envLog), calls: rd(stubLog).split("\n").filter(Boolean), receiptPath, receipt: JSON.parse(readFileSync(receiptPath, "utf8")), keyFile: join(keyDir, "k.pem"), repo,
  };
}

const diffBytes = (patch: string): string[] => patch.split("\n").filter((l) => /^[+-][^+-]/.test(l)).map((l) => l.slice(1).trim()).filter((l) => l.length > 3);

describe("CW-12 --seal-existing", () => {
  test("a correct external change seals VERIFIED with no implement or fix session; the receipt verifies", async () => {
    const s = seal("a * b");
    if (s.receipt.verdict !== "VERIFIED") console.error(s.out);
    expect(s.receipt.verdict).toBe("VERIFIED");
    expect(s.calls).not.toContain("implement");
    expect(s.receipt.task.source).toBe("text");
    expect(s.receipt.checks.some((c) => c.name === "bun:loki_wall_multiply.test.ts" && c.result === "pass")).toBe(true);
    expect(readFileSync(join(s.repo, ".loki", "runs", s.receiptPath.split("/").slice(-2)[0]!, "events.jsonl"), "utf8")).toContain('"exit":"external"');
    expect(JSON.stringify(s.receipt)).toMatch(/"[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{40,}"/); // a signed JWT is on the receipt
    const prev = process.env.LOKI_RECEIPT_SIGNING_KEY_FILE; process.env.LOKI_RECEIPT_SIGNING_KEY_FILE = s.keyFile;
    try { expect((await verifyReceipt(s.receiptPath)).verdict).toBe("VERIFIED"); } finally { if (prev === undefined) delete process.env.LOKI_RECEIPT_SIGNING_KEY_FILE; else process.env.LOKI_RECEIPT_SIGNING_KEY_FILE = prev; }
  }, 120_000);

  test("B2: the patch path reaches no session env (the Wall author's child env has it empty), while the diff is still applied", () => {
    const s = seal("a * b");
    expect(s.envLog.trim().length).toBeGreaterThan(0); // positive control: the stub did log its env
    for (const l of s.envLog.split("\n").filter(Boolean)) expect(l).toMatch(/SEAL_PATCH=$/);
    expect(s.receipt.not_proven).toContain("Wall author not filesystem-isolated from the external diff");
  }, 120_000);

  test("B3: the receipt records implement exit external with the patch hash and names no implementing model", () => {
    const s = seal("a * b");
    const r = s.receipt as unknown as { implement?: { exit: string; patch_sha256: string }; model: string };
    expect(r.implement).toEqual({ exit: "external", patch_sha256: createHash("sha256").update(s.patch).digest("hex") });
    expect(r.model).toBe("external (no Loki implement session)");
    expect(JSON.stringify(s.receipt)).not.toContain("claude (provider default)");
  }, 120_000);

  test("the Wall author prompt contains none of the diff bytes", () => {
    const s = seal("a * b");
    expect(s.prompts.wall.length).toBeGreaterThan(0);
    const lines = diffBytes(s.patch);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(s.prompts.wall.includes(l)).toBe(false);
    expect(s.prompts.wall).toContain(INTENT);
  }, 120_000);

  test("a wrong external change fails its Wall and never seals VERIFIED (no false green, no fix session rewrites it)", () => {
    const s = seal("a + b");
    expect(s.receipt.verdict).not.toBe("VERIFIED");
    expect(s.receipt.checks.some((c) => c.result === "fail")).toBe(true);
    expect(s.calls).not.toContain("implement");
    expect(readFileSync(join(s.repo, "calc.ts"), "utf8")).toContain("return a + b;"); // the client's change is sealed as-is, not rewritten
  }, 120_000);

  test("a missing patch file is refused with exit 2 before any run state exists", () => {
    const s = seal("a * b");
    const r = Bun.spawnSync(["bash", BIN_LOKI, INTENT, "--seal-existing", join(s.repo, "missing.patch")], { cwd: s.repo, env: { ...process.env, LOKI_TS_ENTRY: ENTRY, LOKI_E10_INVOKER: "cli" }, timeout: 60_000 });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("--seal-existing patch not found");
  }, 180_000);
});
