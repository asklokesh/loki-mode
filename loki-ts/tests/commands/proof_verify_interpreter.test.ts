// S-205: the Bun `loki proof verify` must not let a user-site .pth reach the
// verdict. `python3 -E` ignores PYTHON* env vars but still runs site.py, which
// processes ~/Library/Python/X.Y/.../site-packages (or ~/.local/...) and execs
// any `import` line in a .pth there. The verifier is resolved like
// _loki_snapshot_py_tool (/usr/bin/python3, /bin/python3, then absolute PATH
// dirs, each probed with -I -S -c '') and run with -I -S.
//
// Scratch HOME only: the real ~/.loki and user site are never touched.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../../src/util/shell.ts";
import * as py from "../../src/util/python.ts";
import { runProof } from "../../src/commands/proof.ts";

const saved: Record<string, string | undefined> = {};
const KEYS = ["HOME", "PATH", "LOKI_DIR", "TARGET_DIR"];
let scratch = "";

// Optional so the pre-fix module (no hook) still loads and the .pth assertion
// is what goes red, not an import error.
const setFixed = (py as Record<string, unknown>)["_setIsolatedPythonFixedForTests"] as
  | ((c: readonly string[] | null) => void)
  | undefined;

async function captureVerify(id: string): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const ow = process.stdout.write.bind(process.stdout);
  const ew = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => ((out += String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => ((err += String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await runProof(["verify", id]);
    return { code, out, err };
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  scratch = mkdtempSync(join(tmpdir(), "loki-proof-verify-interp-"));
  const home = join(scratch, "home");
  mkdirSync(home);
  mkdirSync(join(scratch, "loki", "proofs", "p1"), { recursive: true });
  // Malformed but present: the verifier alone must answer 2 (unusable).
  writeFileSync(join(scratch, "loki", "proofs", "p1", "proof.json"), "{not json");
  process.env["HOME"] = home;
  process.env["LOKI_DIR"] = join(scratch, "loki");
  process.env["TARGET_DIR"] = scratch;
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setFixed?.(null);
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

describe("loki proof verify interpreter isolation (S-205)", () => {
  it("a user-site .pth under HOME neither runs nor changes the verdict", async () => {
    const marker = join(scratch, "pth-ran");
    const pth = `import os; open(${JSON.stringify(marker)}, "w").write("x"); os._exit(0)\n`;
    // Plant the .pth in the user site of every interpreter a verifier could
    // pick: the PATH python3 (the pre-fix choice) and the fixed candidates.
    let planted = 0;
    for (const exe of ["python3", "/usr/bin/python3", "/bin/python3"]) {
      const r = await run(
        [exe, "-E", "-c", "import site; print(site.getusersitepackages())"],
        { timeoutMs: 20000 },
      ).catch(() => null);
      if (!r || r.exitCode !== 0) continue;
      const dir = r.stdout.trim();
      if (!dir.startsWith(process.env["HOME"]!)) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "zz-s205.pth"), pth);
      planted++;
    }
    expect(planted).toBeGreaterThan(0);

    // Positive control: the plant is live for a plain `python3 -E`.
    const control = await run(["python3", "-E", "-c", "print('reached')"], { timeoutMs: 20000 });
    expect(existsSync(marker)).toBe(true);
    expect(control.stdout).not.toContain("reached");
    rmSync(marker);

    const res = await captureVerify("p1");
    expect(existsSync(marker)).toBe(false);
    expect(res.code).toBe(2);
  }, 60000);

  it("no resolvable interpreter -> exit 2 NOT CHECKED", async () => {
    expect(setFixed).toBeDefined();
    const empty = join(scratch, "empty-bin");
    mkdirSync(empty);
    // A python3 that fails the -I -S probe must be skipped, and a relative
    // PATH entry must never be searched.
    const bad = join(scratch, "bad-bin");
    mkdirSync(bad);
    writeFileSync(join(bad, "python3"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bad, "python3"), 0o755);
    setFixed!([join(scratch, "nope", "python3")]);
    process.env["PATH"] = `${bad}:${empty}:.:bin`;
    const res = await captureVerify("p1");
    expect(res.code).toBe(2);
    expect(res.err).toContain("NOT CHECKED");
    expect(res.out).toBe("");
  }, 60000);

  it("the resolver probes and returns an absolute interpreter", async () => {
    const found = await py.findIsolatedPython3();
    expect(found).not.toBeNull();
    expect(found!.startsWith("/")).toBe(true);
  });
});
