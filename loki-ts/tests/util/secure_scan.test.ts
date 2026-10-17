import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSecureScan } from "../../src/util/secure_scan.ts";

const dir = mkdtempSync(join(tmpdir(), "secure-scan-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fake(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

const FINDING = { rule: "debug-in-prod", file: "a.env", line: 3, severity: "MEDIUM", message: "m", fix: "f" };

describe("runSecureScan", () => {
  it("pass: exit 0 gives ok with no findings", async () => {
    const s = fake("pass.py", 'import json\nprint(json.dumps({"findings":[]}))\n');
    const r = await runSecureScan(dir, { scriptPath: s });
    expect(r).toEqual({ ok: true, findings: [] });
  });

  it("findings: exit 1 gives ok with typed findings", async () => {
    const s = fake("find.py", `import json,sys\nprint(json.dumps({"findings":[${JSON.stringify(FINDING)}]}))\nsys.exit(1)\n`);
    const r = await runSecureScan(dir, { scriptPath: s });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([FINDING]);
  });

  it("crash: traceback with non-JSON output is an error, not a pass", async () => {
    const s = fake("crash.py", 'raise RuntimeError("boom")\n');
    const r = await runSecureScan(dir, { scriptPath: s });
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([]);
    expect(r.error).toContain("boom");
  });

  it("bad input: exit 2 surfaces the script error message", async () => {
    const s = fake("bad.py", 'import json,sys\nprint(json.dumps({"error":"nope"}))\nsys.exit(2)\n');
    const r = await runSecureScan(dir, { scriptPath: s });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nope");
  });

  it("timeout: slow script is killed and reported", async () => {
    const s = fake("slow.py", "import time\ntime.sleep(30)\n");
    const r = await runSecureScan(dir, { scriptPath: s, timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("timed out");
  });

  it("missing script is an error", async () => {
    const r = await runSecureScan(dir, { scriptPath: join(dir, "absent.py") });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
  });

  it("real script on a clean dir passes", async () => {
    const r = await runSecureScan(dir);
    expect(r.ok).toBe(true);
  });
});
