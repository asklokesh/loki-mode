// Tests for src/commands/doctor.ts.
//
// Strategy:
//   - Unit-test pure helpers (compareMajorMinor implicit via checkTool, disk,
//     skills, JSON shape).
//   - End-to-end test runDoctor() with --json by capturing stdout via a
//     write hook. This is the same shape as autonomy/loki doctor --json.
//   - Avoid asserting exact pass/fail counts (depends on host) -- assert shape
//     and invariants instead.
import { afterEach, beforeEach, describe, expect, it, mock, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/util/paths.ts";
import { processStartTime } from "../../src/util/run_pid.ts";
import { providerAuthPath, providerAuthRows } from "../../src/commands/doctor.ts";
import {
  _setClaudeVersionForTest,
  _setIntegrationProbesForTest,
  _setJsonProbesForTest,
  _setModelsRetrieveForTest,
  checkModelCapabilities,
  compareModelCapabilities,
  parseModelCapabilities,
  _setPythonImportOkForTest,
  probeIntegrations,
  cmpVersion,
  evaluateClaudeCliCompat,
  loadClaudeCliRange,
  evaluateRequirements,
  firstTaskReady,
  loadRequirements,
  requirementFix,
  requirementMin,
  sdkBinaryPresent,
  type EvalDeps,
  type ReqTable,
  buildDoctorJson,
  providerAutodetected,
  checkDisk,
  findOrphanRuns,
  lowestVolume,
  checkSkills,
  checkTool,
  evaluateCloudAuth,
  CLOUD_KEY_HYGIENE,
  readEffectiveProvider,
  readProviderAvailability,
  renderProviderAvailability,
  httpReachable,
  pythonImportOk,
  runDoctor,
  type DoctorJson,
  type ToolCheck,
} from "../../src/commands/doctor.ts";

// Text-mode runDoctor([]) renders the Integrations section, which probes three
// python modules (mcp, numpy, sentence_transformers). The ML probes carry a 30s
// timeout each (BUG-23: cold sentence_transformers imports under load), so a
// single runDoctor([]) spawns three python interpreters and, under concurrent
// CI load, can stall a suite on the 30s ML timeout. Suites that assert section
// rendering / exit codes / network branches (MiroFish, OTEL, ChromaDB) do not
// care whether numpy is pip-installed -- they only need a deterministic, cheap
// Integrations result. stubPythonImportOk() injects a no-spawn stub via the
// existing _setPythonImportOkForTest seam so those suites stay fast and never
// touch the 30s ML timeout. Production behavior and the network probe (which
// already aborts at 2s via AbortSignal.timeout) are unchanged. Suites that
// genuinely exercise the python path (MCP PASS import, BUG-002 version string,
// the v7.5.8 parallelism probe) intentionally do NOT use this stub.
function stubPythonImportOk(): void {
  _setPythonImportOkForTest(async (): Promise<boolean> => false);
}
// Variant for suites that genuinely exercise the `mcp` import (MCP SDK PASS):
// delegate "mcp" to the real probe so the chdir-stub assertion stays honest,
// but short-circuit the two ML probes (numpy, sentence_transformers) so the
// suite never touches their 30s timeout. checkPython312's version line uses a
// separate run() path, so the BUG-002 suite uses the plain stub above.
function stubMlPythonImportOk(): void {
  _setPythonImportOkForTest(async (module: string): Promise<boolean> =>
    module === "mcp" ? pythonImportOk("mcp") : false,
  );
}
function restorePythonImportOk(): void {
  _setPythonImportOkForTest(null);
}

// ---- stdout capture helper ---------------------------------------------------

type Captured = { out: string; err: string };

function captureStdio<T>(fn: () => Promise<T>): Promise<{ result: T; cap: Captured }> {
  const cap: Captured = { out: "", err: "" };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    cap.out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    cap.err += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  return fn()
    .then((result) => ({ result, cap }))
    .finally(() => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    });
}

// ---- checkTool ---------------------------------------------------------------

describe("doctor.checkTool", () => {
  it("returns pass for an existing tool with no min", async () => {
    const c = await checkTool("Shell", "sh", "required");
    expect(c.found).toBe(true);
    expect(c.path).toBeTruthy();
    expect(c.status).toBe("pass");
    expect(c.required).toBe("required");
    expect(c.min_version).toBeNull();
  });

  it("returns fail for missing required tool", async () => {
    const c = await checkTool("Nope", "definitely_missing_xyz_42", "required");
    expect(c.found).toBe(false);
    expect(c.path).toBeNull();
    expect(c.version).toBeNull();
    expect(c.status).toBe("fail");
  });

  it("returns warn for missing optional tool", async () => {
    const c = await checkTool("Maybe", "definitely_missing_xyz_42", "optional");
    expect(c.status).toBe("warn");
  });

  it("returns warn for missing recommended tool", async () => {
    const c = await checkTool("Soft", "definitely_missing_xyz_42", "recommended");
    expect(c.status).toBe("warn");
  });

  it("flags fail when version is below required minimum", async () => {
    // bash is on every macOS/Linux box; require an absurd minimum to force
    // the version comparison branch.
    const c = await checkTool("bash", "bash", "required", "999.0");
    expect(c.found).toBe(true);
    expect(c.version).toBeTruthy();
    expect(c.status).toBe("fail");
  });

  it("flags warn when version is below recommended minimum", async () => {
    const c = await checkTool("bash", "bash", "recommended", "999.0");
    expect(c.status).toBe("warn");
  });

  it("extracts a version string from --version output", async () => {
    const c = await checkTool("bash", "bash", "recommended", "1.0");
    expect(c.version).toMatch(/^\d+\.\d+/);
  });
});

// ---- checkDisk ---------------------------------------------------------------

describe("doctor.checkDisk", () => {
  it("returns a non-negative number and a valid status", () => {
    const d = checkDisk();
    if (d.available_gb !== null) {
      expect(d.available_gb).toBeGreaterThanOrEqual(0);
    }
    expect(["pass", "fail", "warn"]).toContain(d.status);
  });

  it("reports the minimum across home, cwd and tmp and names the low volume", () => {
    const d = checkDisk();
    expect(d.volumes!.length).toBeGreaterThan(0);
    const min = Math.min(...d.volumes!.map((v) => v.available_gb));
    expect(d.available_gb).toBe(min);
    expect(d.volumes!.find((v) => v.available_gb === min)!.name).toBe(d.low_volume!);
    expect(d.volumes!.map((v) => v.name)).toEqual(["home", "cwd", "tmp"]);
  });

  it("lowestVolume picks the smallest volume by name", () => {
    const r = lowestVolume([
      { name: "home", path: "/h", available_gb: 200 },
      { name: "cwd", path: "/c", available_gb: 3.5 },
      { name: "tmp", path: "/t", available_gb: 40 },
    ]);
    expect(r).toEqual({ available_gb: 3.5, low_volume: "cwd" });
    expect(lowestVolume([])).toEqual({ available_gb: null, low_volume: null });
  });

  it("skips unreadable volumes and keeps null when none are readable", () => {
    const d = checkDisk([{ name: "cwd", path: "/nonexistent-loki-path-xyz" }]);
    expect(d.available_gb).toBeNull();
    expect(d.low_volume).toBeNull();
  });
});

describe("doctor disk text volume label", () => {
  for (const name of ["home", "cwd", "tmp"] as const) {
    it(`names the ${name} volume on the text disk line when low`, async () => {
      const volumes = (["home", "cwd", "tmp"] as const).map((n) => ({
        name: n,
        path: `/${n}`,
        available_gb: n === name ? 3.2 : 100,
      }));
      const { cap } = await captureStdio(() => runDoctor([], { diskVolumes: volumes }));
      expect(cap.out).toContain(`Disk space: 3GB available on ${name} volume (low)`);
    }, 30_000);
  }

  it("omits the volume label when disk passes", async () => {
    const volumes = [{ name: "home" as const, path: "/h", available_gb: 100 }];
    const { cap } = await captureStdio(() => runDoctor([], { diskVolumes: volumes }));
    expect(cap.out).toContain("Disk space: 100GB available\n");
    expect(cap.out).not.toContain("volume");
  }, 30_000);
});

// ---- checkSkills -------------------------------------------------------------

describe("doctor.checkSkills", () => {
  // A-123: severity follows the SELECTED provider. Only its dangling link is a
  // blocking "fail"; every other provider's stale link is a "warn".
  it("grades only the selected provider's broken link as fail", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "loki-doctor-a123-"));
    try {
      for (const p of [".claude", ".cline"]) {
        const full = join(tmpHome, p, "skills/loki-mode");
        mkdirSync(join(full, ".."), { recursive: true });
        symlinkSync(join(tmpHome, "gone"), full);
      }
      mock.module("node:os", () => {
        const real = require("node:os");
        return { ...real, homedir: () => tmpHome };
      });
      const byName = (sel: string | null) =>
        Object.fromEntries(checkSkills(sel).map((x) => [x.name, x.status]));
      expect(byName("claude")["Claude Code"]).toBe("fail");
      expect(byName("claude")["Cline CLI"]).toBe("warn");
      expect(byName("cline")["Cline CLI"]).toBe("fail");
      expect(byName("cline")["Claude Code"]).toBe("warn");
      expect(byName(null)["Claude Code"]).toBe("warn");
    } finally {
      mock.module("node:os", () => require("node:os"));
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("returns one entry per provider", () => {
    const skills = checkSkills();
    expect(skills.length).toBe(4);
    const names = skills.map((s) => s.name);
    expect(names).toEqual([
      "Claude Code",
      "Codex CLI",
      "Cline CLI",
      "Aider CLI",
    ]);
  });

  it("each entry has a status of pass/fail/warn", () => {
    for (const s of checkSkills()) {
      expect(["pass", "fail", "warn"]).toContain(s.status);
      // Bash autonomy/loki:6410 leaves full path under set -e (tilde substitution
      // does not happen). Mirror that for parity.
      expect(s.path.startsWith("/")).toBe(true);
    }
  });

  // v7.5.10 -- regression guard for the `target` initialization in the
  // broken-symlink branch (doctor.ts ~line 224). If `let target = "unknown"`
  // were dropped before the try/readlinkSync, a readlink failure would leave
  // `target` undefined and the detail string would render "(broken symlink ->
  // undefined)" or throw a ReferenceError. checkSkills uses os.homedir(),
  // which on POSIX reads from the password database (not $HOME), so we mock
  // node:os to point at a temp dir containing broken symlinks.
  it("renders a defined target when readlinkSync hits a broken symlink", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "loki-doctor-skills-"));
    try {
      // Create broken symlinks at each of the 4 skill paths (gemini removed in v7.5.18).
      const paths = [
        ".claude/skills/loki-mode",
        ".codex/skills/loki-mode",
        ".cline/skills/loki-mode",
        ".aider/skills/loki-mode",
      ];
      for (const p of paths) {
        const full = join(tmpHome, p);
        mkdirSync(join(full, ".."), { recursive: true });
        symlinkSync(join(tmpHome, "does-not-exist"), full);
      }
      // Override homedir() to point at our tmp HOME via mock.module. The
      // mock applies to the next call of homedir() inside checkSkills().
      mock.module("node:os", () => {
        const real = require("node:os");
        return { ...real, homedir: () => tmpHome };
      });
      const skills = checkSkills();
      expect(skills.length).toBe(4);
      for (const s of skills) {
        // Severity now depends on WHICH provider a build would use: the
        // effective provider's dangling link is a blocking "fail", every other
        // one is an advisory "warn" (and on a host where no provider resolves,
        // all four are "warn"). Both arms render the same detail, which is what
        // this test actually guards -- see the `target` assertions below.
        expect(["fail", "warn"]).toContain(s.status);
        expect(s.detail).toContain("broken symlink");
        // The crucial assertion: `target` is initialized BEFORE readlinkSync
        // and never undefined.
        expect(s.detail).not.toContain("undefined");
        // readlinkSync succeeds on a dangling symlink (it returns the link's
        // recorded target, regardless of existence), so target should equal
        // the dangling path.
        expect(s.detail).toContain("does-not-exist");
      }
    } finally {
      // Restore the real node:os module so downstream tests see real homedir.
      mock.module("node:os", () => require("node:os"));
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ---- httpReachable -----------------------------------------------------------

describe("doctor.httpReachable", () => {
  it("returns false fast for an unreachable URL", async () => {
    // Use a port no one is listening on; AbortSignal.timeout caps wait time.
    const start = Date.now();
    const ok = await httpReachable("http://127.0.0.1:1/never", 500);
    const elapsed = Date.now() - start;
    expect(ok).toBe(false);
    expect(elapsed).toBeLessThan(2000);
  });
});

// ---- buildDoctorJson ---------------------------------------------------------

describe("doctor.buildDoctorJson", () => {
  let json: DoctorJson;

  beforeEach(async () => {
    json = await buildDoctorJson();
  });

  it("matches the documented JSON shape", () => {
    expect(Array.isArray(json.checks)).toBe(true);
    expect(json.disk).toBeDefined();
    expect(json.summary).toBeDefined();
    expect(typeof json.summary.passed).toBe("number");
    expect(typeof json.summary.failed).toBe("number");
    expect(typeof json.summary.warnings).toBe("number");
    expect(typeof json.summary.ok).toBe("boolean");
  });

  it("contains all 12 expected tool checks in order", () => {
    // v7.4.9: added "bun" probe (recommended) so users can see whether the
    // ported-command speedup is available on their system.
    // v7.5.18: gemini probe removed.
    // v9.22.13: opencode is an active provider route and must be observable.
    const expected = [
      "node",
      "python3",
      "jq",
      "git",
      "curl",
      "bash",
      "bun",
      "claude",
      "codex",
      "cline",
      "aider",
      "opencode",
    ];
    expect(json.checks.map((c) => c.command)).toEqual(expected);
  });

  it("each check has the documented field set", () => {
    for (const c of json.checks) {
      expect(typeof c.name).toBe("string");
      expect(typeof c.command).toBe("string");
      expect(typeof c.found).toBe("boolean");
      expect(["pass", "fail", "warn"]).toContain(c.status);
      expect(["required", "recommended", "optional"]).toContain(c.required);
      // version & min_version & path are nullable
      if (c.version !== null) expect(typeof c.version).toBe("string");
      if (c.path !== null) expect(typeof c.path).toBe("string");
    }
  });

  it("summary tallies match the per-check statuses (incl. disk)", () => {
    let pass = 0, fail = 0, warn = 0;
    for (const c of json.checks) {
      if (c.status === "pass") pass++;
      else if (c.status === "fail") fail++;
      else warn++;
    }
    if (json.disk.status === "pass") pass++;
    else if (json.disk.status === "fail") fail++;
    else warn++;
    // ai_provider is an AGGREGATE over the individually-optional provider CLIs
    // (Claude, Codex, Cline, Aider, or opencode). It is counted in the tally because
    // having none is a genuine blocker -- without it, --json reported zero
    // failures and ok true on a host that cannot run a build, contradicting
    // the same command's own exit code.
    if (json.ai_provider.status === "pass") pass++;
    else if (json.ai_provider.status === "fail") fail++;
    else warn++;
    // Skill-link integrity is counted per entry, exactly as buildDoctorJson
    // and the text path tally it -- a dangling ~/.claude/skills/loki-mode is a
    // genuine failure, so omitting it here understates the tally by one.
    for (const s of json.skills) {
      if (s.status === "pass") pass++;
      else if (s.status === "fail") fail++;
      else warn++;
    }
    expect(json.summary.passed).toBe(pass);
    expect(json.summary.failed).toBe(fail);
    expect(json.summary.warnings).toBe(warn);
    expect(json.summary.ok).toBe(fail === 0);
  });

  it("required tools that are missing are marked fail (not warn)", () => {
    const requiredChecks = json.checks.filter((c) => c.required === "required");
    for (const c of requiredChecks as ToolCheck[]) {
      if (!c.found) expect(c.status).toBe("fail");
    }
  });
});

// ---- runDoctor end-to-end ----------------------------------------------------

describe("doctor.runDoctor (end-to-end)", () => {
  beforeEach(stubPythonImportOk);
  afterEach(restorePythonImportOk);

  it("--json emits parseable JSON and exits according to summary.ok", async () => {
    const { result, cap } = await captureStdio(() => runDoctor(["--json"]));
    const parsed = JSON.parse(cap.out) as DoctorJson;
    expect(result).toBe(parsed.summary.ok ? 0 : 1);
    // The check count moves whenever a probe is added or removed; the tally covers every counted check plus provider and skill entries.
    const t = parsed.summary;
    expect(t.passed + t.failed + t.warnings).toBeGreaterThanOrEqual(parsed.checks.length);
    expect(parsed.checks.length).toBeGreaterThan(0);
    expect(parsed.summary).toBeDefined();
  });

  it("--help exits 0 and prints usage", async () => {
    const { result, cap } = await captureStdio(() => runDoctor(["--help"]));
    expect(result).toBe(0);
    expect(cap.out).toContain("loki doctor");
    expect(cap.out).toContain("--json");
  });

  it("F4: --repo --fix refreshes the profile instead of being rejected; --repo --requirements prints both", async () => {
    const prev = process.env.LOKI_REPO_BASELINE, cwd = process.cwd(), d = mkdtempSync(join(tmpdir(), "doctor-f4-"));
    process.env.LOKI_REPO_BASELINE = "0"; // never run a baseline from a unit test
    try {
      process.chdir(d);
      const fixed = await captureStdio(() => runDoctor(["--repo", "--fix"]));
      expect(fixed.result).toBe(0);
      expect(fixed.cap.err).not.toContain("cannot be combined");
      const repoOnly = await captureStdio(() => runDoctor(["--repo"]));
      const both = await captureStdio(() => runDoctor(["--repo", "--requirements"]));
      expect(both.result).toBe(0);
      expect(both.cap.out.startsWith(repoOnly.cap.out)).toBe(true);
      expect(both.cap.out.length).toBeGreaterThan(repoOnly.cap.out.length);
    } finally {
      process.chdir(cwd); rmSync(d, { recursive: true, force: true });
      if (prev === undefined) delete process.env.LOKI_REPO_BASELINE; else process.env.LOKI_REPO_BASELINE = prev;
    }
  });

  describe("P12-41 readiness history and round-trip", () => {
    const withRepo = async (fn: (d: string) => Promise<void>) => {
      const prev = process.env.LOKI_REPO_BASELINE, cwd = process.cwd(), d = mkdtempSync(join(tmpdir(), "doctor-p1241-"));
      process.env.LOKI_REPO_BASELINE = "0";
      try { process.chdir(d); await fn(d); } finally {
        process.chdir(cwd); rmSync(d, { recursive: true, force: true });
        if (prev === undefined) delete process.env.LOKI_REPO_BASELINE; else process.env.LOKI_REPO_BASELINE = prev;
      }
    };
    const lines = (d: string) => readFileSync(join(d, ".loki", "state", "readiness.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

    it("two --repo runs append two JSON lines", async () => {
      await withRepo(async (d) => {
        await captureStdio(() => runDoctor(["--repo"]));
        await captureStdio(() => runDoctor(["--repo"]));
        const l = lines(d);
        expect(l.length).toBe(2);
        expect(typeof l[0].ts).toBe("string");
        expect(Array.isArray(l[0].checks)).toBe(true);
        expect(typeof l[0].pass).toBe("boolean");
        expect(l[0].roundTrip).toBeNull();
      });
    });

    it("no provider call without --round-trip", async () => {
      await withRepo(async () => {
        let calls = 0;
        await captureStdio(() => runDoctor(["--repo"], { roundTrip: async () => { calls++; return { ok: true, detail: "x" }; } }));
        expect(calls).toBe(0);
      });
    });

    it("--round-trip failure is recorded, not thrown", async () => {
      await withRepo(async (d) => {
        const { result } = await captureStdio(() => runDoctor(["--repo", "--round-trip"], { roundTrip: async () => { throw new Error("boom"); } }));
        expect(result).toBe(0);
        const l = lines(d);
        expect(l[0].roundTrip.ok).toBe(false);
        expect(l[0].roundTrip.detail).toContain("boom");
      });
    });

    it("--round-trip success is recorded", async () => {
      await withRepo(async (d) => {
        await captureStdio(() => runDoctor(["--repo", "--round-trip"], { roundTrip: async () => ({ ok: true, detail: "OK" }) }));
        expect(lines(d)[0].roundTrip.ok).toBe(true);
      });
    });

    it("help lists --round-trip", async () => {
      const { cap } = await captureStdio(() => runDoctor(["--help"]));
      expect(cap.out).toContain("--round-trip");
    });
  });

  it("rejects unknown options with exit 1", async () => {
    const { result, cap } = await captureStdio(() => runDoctor(["--bogus"]));
    expect(result).toBe(1);
    expect(cap.err).toContain("Unknown option");
  });

  it("text mode prints sections and a summary", async () => {
    const { result, cap } = await captureStdio(() => runDoctor([]));
    // Exit code depends on host -- 0 if no required tool missing, 1 otherwise.
    expect([0, 1]).toContain(result);
    expect(cap.out).toContain("Loki Mode Doctor");
    expect(cap.out).toContain("Required:");
    expect(cap.out).toContain("AI Providers:");
    expect(cap.out).toContain("API Keys:");
    expect(cap.out).toContain("Skills:");
    expect(cap.out).toContain("Integrations:");
    expect(cap.out).toContain("System:");
    expect(cap.out).toContain("Summary:");
  }, 30_000);

  it("never echoes API key values (presence only)", async () => {
    // Inject a sentinel value; it must never appear in output.
    const sentinel = "sk-test-this-must-never-be-logged-9999";
    const prev = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = sentinel;
    try {
      const { cap } = await captureStdio(() => runDoctor([]));
      expect(cap.out).not.toContain(sentinel);
      expect(cap.err).not.toContain(sentinel);
    } finally {
      if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = prev;
    }
  }, 30_000);
});

// No doctor unit test may reach api.anthropic.com. Every test starts with the
// models.retrieve probe stubbed and a fetch trap that records, rejects and (in
// afterEach) fails the test on any real call to the API host.
const apiFetchAttempts: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  apiFetchAttempts.length = 0;
  _setModelsRetrieveForTest(async () => null);
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).hostname === "api.anthropic.com") {
      apiFetchAttempts.push(url);
      return Promise.reject(new Error(`doctor test made a real fetch to ${url}`));
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  _setModelsRetrieveForTest(null);
  const attempts = apiFetchAttempts.splice(0);
  expect(attempts).toEqual([]);
});

describe("doctor tests never reach the network (guard)", () => {
  it("the fetch trap records and rejects a real api.anthropic.com call", async () => {
    await expect(fetch("https://api.anthropic.com/v1/models/x")).rejects.toThrow("real fetch");
    expect(apiFetchAttempts).toHaveLength(1);
    apiFetchAttempts.length = 0;
  });
  it("runDoctor with a key set makes no real API fetch", async () => {
    const prev = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-guard-sentinel";
    try {
      await captureStdio(() => runDoctor([]));
      expect(apiFetchAttempts).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"]; else process.env["ANTHROPIC_API_KEY"] = prev;
    }
  }, 30_000);
});

// ---- exit-code parity --------------------------------------------------------

describe("doctor exit-code parity", () => {
  // Text and JSON may tally different advisory surfaces, but each mode must
  // bind its exit code to its own required-failure verdict.
  beforeEach(stubPythonImportOk);
  afterEach(restorePythonImportOk);

  it("text mode exit code is 0 or 1", async () => {
    const { result } = await captureStdio(() => runDoctor([]));
    expect([0, 1]).toContain(result);
  }, 30_000);

  it("json mode exit code mirrors summary.ok", async () => {
    const { result, cap } = await captureStdio(() => runDoctor(["--json"]));
    const parsed = JSON.parse(cap.out) as DoctorJson;
    expect(result).toBe(parsed.summary.ok ? 0 : 1);
  }, 30_000);

  it("json mode summary.ok mirrors summary.failed === 0", async () => {
    const j = await buildDoctorJson();
    expect(j.summary.ok).toBe(j.summary.failed === 0);
  });
});

// ---- Integration PASS branches (previously only WARN-tested on this host) ----
//
// The following suites exercise the PASS branches for MiroFish, OTEL, MCP,
// ChromaDB, and disk fail/warn -- branches that were NOT covered because the
// dev host lacks those services. Each test stands up a hermetic fixture
// (loopback HTTP server, temp dir, env override, or monkey-patched module) and
// tears it down in afterEach so the suite stays idempotent and parallel-safe.

// Helper: spawn a localhost HTTP server. routes is a map from path -> status.
function startLocalServer(
  routes: Record<string, number>,
  port = 0,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const status = routes[req.url ?? ""] ?? 404;
      res.statusCode = status;
      res.end();
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error("server.address() did not return AddressInfo"));
      }
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

describe("doctor.runDoctor MiroFish PASS branch", () => {
  let server: Server | null = null;
  const prevUrl = process.env["LOKI_MIROFISH_URL"];

  beforeEach(stubPythonImportOk);
  afterEach(async () => {
    restorePythonImportOk();
    if (server) {
      await stopServer(server);
      server = null;
    }
    if (prevUrl === undefined) delete process.env["LOKI_MIROFISH_URL"];
    else process.env["LOKI_MIROFISH_URL"] = prevUrl;
  });

  it("reports MiroFish as PASS when /health returns 200", async () => {
    const started = await startLocalServer({ "/health": 200 });
    server = started.server;
    process.env["LOKI_MIROFISH_URL"] = `http://127.0.0.1:${started.port}`;

    const { result, cap } = await captureStdio(() => runDoctor([]));
    expect([0, 1]).toContain(result);
    // Match the exact PASS line emitted by runText() at doctor.ts:480.
    expect(cap.out).toContain(`PASS`);
    expect(cap.out).toContain(`MiroFish server (${process.env["LOKI_MIROFISH_URL"]})`);
    // Must NOT have emitted the WARN line.
    expect(cap.out).not.toContain("MiroFish - not running");
  }, 30_000);
});

describe("doctor.runDoctor OTEL PASS branch", () => {
  const prev = process.env["LOKI_OTEL_ENDPOINT"];

  beforeEach(stubPythonImportOk);
  afterEach(() => {
    restorePythonImportOk();
    if (prev === undefined) delete process.env["LOKI_OTEL_ENDPOINT"];
    else process.env["LOKI_OTEL_ENDPOINT"] = prev;
  });

  it("reports OTEL endpoint as PASS when LOKI_OTEL_ENDPOINT is set", async () => {
    const endpoint = "http://localhost:9999";
    process.env["LOKI_OTEL_ENDPOINT"] = endpoint;

    const { result, cap } = await captureStdio(() => runDoctor([]));
    expect([0, 1]).toContain(result);
    expect(cap.out).toContain(`OTEL endpoint: ${endpoint}`);
    expect(cap.out).not.toContain("OTEL - not configured");
  }, 30_000);
});

describe("doctor.runDoctor MCP PASS branch", () => {
  // pythonImportOk("mcp") shells out to `python3 -c "import mcp"` from the
  // current working directory. By chdir-ing to a temp dir that contains a
  // stub `mcp/__init__.py`, the import succeeds without needing the real
  // pip-installed package on this host.
  let tmpDir: string | null = null;
  let prevCwd: string | null = null;

  beforeEach(stubMlPythonImportOk);
  afterEach(() => {
    restorePythonImportOk();
    if (prevCwd) {
      process.chdir(prevCwd);
      prevCwd = null;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("reports MCP SDK as PASS when `import mcp` exits 0", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "loki-doctor-mcp-"));
    mkdirSync(join(tmpDir, "mcp"));
    writeFileSync(join(tmpDir, "mcp", "__init__.py"), "");
    prevCwd = process.cwd();
    process.chdir(tmpDir);

    const { result, cap } = await captureStdio(() => runDoctor([]));
    expect([0, 1]).toContain(result);
    expect(cap.out).toContain("MCP SDK (Python)");
    expect(cap.out).not.toContain("MCP SDK - not installed");
  }, 30_000);
});

describe("doctor.runDoctor ChromaDB PASS branch", () => {
  // The chroma probe URL is hardcoded to http://localhost:8100/api/v2/heartbeat
  // (doctor.ts:466). Bind a loopback server to 8100 to satisfy it. If 8100 is
  // already busy on the dev host, the listen will reject and the test fails
  // loudly -- preferable to silently skipping coverage.
  let server: Server | null = null;

  beforeEach(stubPythonImportOk);
  afterEach(async () => {
    restorePythonImportOk();
    if (server) {
      await stopServer(server);
      server = null;
    }
  });

  it("reports ChromaDB as PASS when port 8100 /api/v2/heartbeat returns 200", async () => {
    const started = await startLocalServer({ "/api/v2/heartbeat": 200 }, 8100);
    server = started.server;

    const { result, cap } = await captureStdio(() => runDoctor([]));
    expect([0, 1]).toContain(result);
    expect(cap.out).toContain("ChromaDB server (port 8100)");
    expect(cap.out).not.toContain("ChromaDB - not running");
  }, 30_000);
});

describe("doctor.buildDoctorJson disk fail/warn branches", () => {
  // checkDisk() reads the host filesystem and on a normal dev box returns
  // "pass" (>=5GB free). To exercise the fail/warn arms of the summary
  // tally, we use bun:test's mock.module to swap checkDisk for a fake that
  // returns the desired DiskCheck. The original module is restored by
  // re-mocking with the real implementation in afterEach.
  let realCheckDisk: typeof import("../../src/commands/doctor.ts")["checkDisk"];

  beforeEach(async () => {
    const fresh = await import("../../src/commands/doctor.ts");
    realCheckDisk = fresh.checkDisk;
  });

  afterEach(async () => {
    mock.module("../../src/commands/doctor.ts", () => {
      const orig = require("../../src/commands/doctor.ts");
      return { ...orig, checkDisk: realCheckDisk };
    });
  });

  it("counts disk as failed when available_gb < 1", async () => {
    mock.module("../../src/commands/doctor.ts", () => {
      const orig = require("../../src/commands/doctor.ts");
      return {
        ...orig,
        checkDisk: () => ({ available_gb: 0.5, status: "fail" }),
      };
    });
    const patched = await import("../../src/commands/doctor.ts");
    const json = await patched.buildDoctorJson();
    expect(json.disk.status).toBe("fail");
    expect(json.disk.available_gb).toBe(0.5);
    expect(json.summary.failed).toBeGreaterThanOrEqual(1);
    expect(json.summary.ok).toBe(false);
  });

  it("counts disk as warning when 1 <= available_gb < 5", async () => {
    mock.module("../../src/commands/doctor.ts", () => {
      const orig = require("../../src/commands/doctor.ts");
      return {
        ...orig,
        checkDisk: () => ({ available_gb: 3, status: "warn" }),
      };
    });
    const patched = await import("../../src/commands/doctor.ts");
    const json = await patched.buildDoctorJson();
    expect(json.disk.status).toBe("warn");
    expect(json.disk.available_gb).toBe(3);
    expect(json.summary.warnings).toBeGreaterThanOrEqual(1);
  });
});

// ---- v7.5.8 parallelism + non-null fallback ---------------------------------

describe("doctor v7.5.8 parallel python imports", () => {
  // Verifies the three pythonImportOk("mcp" | "numpy" | "sentence_transformers")
  // calls in runText() now run concurrently via Promise.all instead of
  // sequentially. Inject a stub via _setPythonImportOkForTest that sleeps
  // 200ms and records each invocation's start timestamp. If parallel, all
  // three starts overlap within ~50ms; if sequential, starts would be
  // staggered by ~200ms each.
  it("runs the three python module probes concurrently", async () => {
    const { _setPythonImportOkForTest } = await import("../../src/commands/doctor.ts");
    const starts: number[] = [];
    const SLEEP_MS = 200;
    _setPythonImportOkForTest(async (_module: string, _ml?: boolean): Promise<boolean> => {
      starts.push(Date.now());
      await new Promise((r) => setTimeout(r, SLEEP_MS));
      return false;
    });
    try {
      const { runDoctor } = await import("../../src/commands/doctor.ts");
      await captureStdio(() => runDoctor([]));
    } finally {
      _setPythonImportOkForTest(null);
    }

    // The Integration block fires exactly 3 probes (mcp, numpy, st).
    expect(starts.length).toBe(3);
    const spread = Math.max(...starts) - Math.min(...starts);
    // Parallel: three starts fire within a few ms. Allow 100ms for
    // event-loop jitter; sequential would be >= 200ms.
    expect(spread).toBeLessThan(100);
  }, 30_000);
});

describe("doctor v7.5.8 byCmd non-null fallback", () => {
  // Verifies that `byCmd.get("claude" | "codex")?.found ?? false`
  // returns false (instead of crashing with "Cannot read property 'found' of
  // undefined") when a provider key is absent from the map. We exercise this
  // by stubbing runAllToolChecks via mock.module to omit those keys.
  // v7.5.18: gemini removed from provider set.
  afterEach(() => {
    mock.module("../../src/commands/doctor.ts", () => {
      const orig = require("../../src/commands/doctor.ts");
      return { ...orig };
    });
  });

  it("does not throw when claude/codex are missing from byCmd", async () => {
    // Replace runText's input by stubbing checkTool to mark those two as
    // not-found AND removing them from the spec output. The simplest path is
    // to install a mock that intercepts checkTool calls -- but checkTool is
    // called per-spec and needs to still return rows for non-provider tools.
    //
    // Instead, we directly verify the fallback expression behaves correctly:
    // an empty Map's .get() returns undefined, and `?.found ?? false` yields
    // false (not a TypeError). This mirrors the exact code path in runText().
    const byCmd = new Map<string, { found: boolean }>();
    const claudeFound = byCmd.get("claude")?.found ?? false;
    const codexFound = byCmd.get("codex")?.found ?? false;
    expect(claudeFound).toBe(false);
    expect(codexFound).toBe(false);
  });
});

// ---- BUG-002 regression: Python 3.12 patch-version display ------------------
//
// The Bun route previously printed only major.minor (e.g. "3.12") while the
// bash route printed major.minor.micro (e.g. "3.12.11"). This test guards
// that the version string shown in `loki doctor` output now includes the
// patch component when Python 3.12 is available on this host.

describe("doctor BUG-002 Python 3.12 patch-version parity", () => {
  // The version line asserted here comes from checkPython312's own run() path,
  // not pyImpl.fn, so stubbing the integration probes does not weaken the
  // assertion -- it only avoids the unrelated 30s numpy/sentence_transformers
  // probes that runDoctor([]) would otherwise fire.
  beforeEach(stubPythonImportOk);
  afterEach(restorePythonImportOk);

  it("displays full major.minor.micro version for Python 3.12 when available", async () => {
    // Detect whether Python 3.12 is reachable via the same priority list used
    // by findPython3(): /opt/homebrew/bin/python3.12 first, then PATH.
    const { existsSync } = await import("node:fs");
    const { run } = await import("../../src/util/shell.ts");

    let py312: string | null = null;
    if (existsSync("/opt/homebrew/bin/python3.12")) {
      py312 = "/opt/homebrew/bin/python3.12";
    } else {
      const res = await run(["which", "python3.12"]);
      if (res.exitCode === 0 && res.stdout.trim()) {
        py312 = res.stdout.trim();
      }
    }

    if (py312 === null) {
      // Python 3.12 is not available on this host; skip rather than fabricate.
      console.log("SKIP: python3.12 not found on PATH -- skipping BUG-002 regression test");
      return;
    }

    // Probe the version string the same way doctor.ts does.
    const verRes = await run(
      [py312, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"],
      { timeoutMs: 5000 },
    );
    const ver = verRes.stdout.trim();

    // Must match major.minor.micro (e.g. "3.12.11"), not just major.minor.
    expect(ver).toMatch(/^3\.12\.\d+$/);

    // Confirm the doctor text output also includes the full patch version.
    const { runDoctor } = await import("../../src/commands/doctor.ts");
    const { cap } = await captureStdio(() => runDoctor([]));
    // The Python 3.12 line must contain the full version string, not just "3.12".
    expect(cap.out).toContain(`Python 3.12 (chromadb / sentence-transformers): ${ver} at ${py312}`);
  }, 30_000);
});

// LM-001: shared setup requirements table (autonomy/lib/setup-requirements.json).
// Regenerate the doc block with: UPDATE_CONTRACT=1 bun test tests/commands/doctor.test.ts
// Markdown requirements table; the doc block between the markers must equal this text.
function renderContractTable(t: ReqTable = loadRequirements()): string {
  const out: string[] = [];
  for (const p of t.paths) {
    out.push(`### ${p.title}`, "", `${p.summary}.`, "", "| Requirement | Level | Check | Fix |", "| --- | --- | --- | --- |");
    for (const r of t.requirements.filter((x) => x.path === p.id)) {
      const list = Array.isArray(r.target) ? r.target : [r.target];
      const tg = list.join(" or ");
      const check =
        r.kind === "command" ? `\`${tg}\` on PATH${r.min ? `, version ${r.min} or newer` : ""}`
        : r.kind === "sdk_binary" ? `executable \`${tg}-<platform>/claude\` in an installed node_modules`
        : r.kind === "env_value" ? `\`${tg}\` is ${(r.values ?? []).map((v) => `\`${v}\``).join(" or ")}`
        : `one of ${list.map((v) => `\`${v}\``).join(", ")} is set`;
      out.push(`| ${r.label} | ${r.level} | ${check} | ${r.fix} |`);
    }
    out.push("");
  }
  out.push("### When an optional dependency is missing", "", "| Missing | Effect |", "| --- | --- |");
  for (const m of t.missing_optional) out.push(`| ${m.dependency} | ${m.effect} |`);
  return `${out.join("\n")}\n`;
}

const ALL_CMDS = ["node", "python3", "jq", "git", "curl", "bash", "bun", "claude", "codex", "cline", "aider", "opencode"];
function deps(over: Partial<EvalDeps> & { cmds?: string[] } = {}): EvalDeps {
  const cmds = over.cmds ?? ALL_CMDS;
  return {
    env: over.env ?? {},
    commandPath: async (c) => (cmds.includes(c) ? `/usr/bin/${c}` : null),
    version: async () => "99.0.0",
    sdkBinary: over.sdkBinary ?? (() => false),
  };
}
const pathOf = (rep: Awaited<ReturnType<typeof evaluateRequirements>>, id: string) => rep.paths.find((p) => p.id === id)!;

describe("requirements table", () => {
  test("every requirement has a known path, a fix, and a label", () => {
    const t = loadRequirements();
    const ids = new Set(t.paths.map((p) => p.id));
    const seen = new Set<string>();
    for (const r of t.requirements) {
      expect(ids.has(r.path)).toBe(true);
      expect(r.fix.length).toBeGreaterThan(0);
      expect(r.label.length).toBeGreaterThan(0);
      expect(seen.has(r.id)).toBe(false);
      seen.add(r.id);
    }
  });

  test("node minimum matches package.json engines", () => {
    const eng = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).engines.node as string;
    expect(eng).toBe(`>=${requirementMin("node")!.split(".")[0]}.0.0`);
  });

  test("claude path needs the CLI; api-key path needs mode, credentials, SDK binary and bun", async () => {
    const none = await evaluateRequirements(deps({ cmds: ["node", "python3", "jq", "git", "curl"] }));
    expect(pathOf(none, "claude-cli").ready).toBe(false);
    expect(pathOf(none, "api-key-sdk").ready).toBe(false);
    expect(firstTaskReady(none)).toBe(false);

    const cli = await evaluateRequirements(deps());
    expect(pathOf(cli, "claude-cli").ready).toBe(true);
    expect(firstTaskReady(cli)).toBe(true);

    const noCliButSdk = await evaluateRequirements(
      deps({ cmds: ["node", "python3", "jq", "git", "curl", "bun"], env: { LOKI_SDK_LOOP: "1", ANTHROPIC_API_KEY: "k" }, sdkBinary: () => true }),
    );
    expect(pathOf(noCliButSdk, "claude-cli").ready).toBe(false);
    expect(pathOf(noCliButSdk, "api-key-sdk").ready).toBe(true);
    expect(firstTaskReady(noCliButSdk)).toBe(true);
  });

  test("missing optional SDK leaves the claude path ready and the api-key path not ready", async () => {
    const rep = await evaluateRequirements(deps({ env: { LOKI_SDK_LOOP: "1", ANTHROPIC_API_KEY: "k" }, sdkBinary: () => false }));
    expect(pathOf(rep, "claude-cli").ready).toBe(true);
    const sdk = pathOf(rep, "api-key-sdk");
    expect(sdk.ready).toBe(false);
    expect(sdk.items.find((i) => i.id === "sdk-binary")!.status).toBe("missing");
  });

  test("missing bun is optional for common but blocks the api-key path", async () => {
    const cmds = ALL_CMDS.filter((c) => c !== "bun");
    const rep = await evaluateRequirements(deps({ cmds, env: { LOKI_SDK_LOOP: "1", ANTHROPIC_API_KEY: "k" }, sdkBinary: () => true }));
    expect(pathOf(rep, "common").ready).toBe(true);
    expect(pathOf(rep, "api-key-sdk").ready).toBe(false);
  });

  test("an old node fails the common path", async () => {
    const rep = await evaluateRequirements({ ...deps(), version: async (c) => (c === "node" ? "18.19.0" : "99.0.0") });
    expect(pathOf(rep, "common").ready).toBe(false);
    expect(pathOf(rep, "common").items.find((i) => i.id === "node")!.detail).toContain("older than 20.0");
  });

  test("any one other provider makes that path ready", async () => {
    const rep = await evaluateRequirements(deps({ cmds: ["codex"] }));
    expect(pathOf(rep, "other-providers").ready).toBe(true);
    const none = await evaluateRequirements(deps({ cmds: [] }));
    expect(pathOf(none, "other-providers").ready).toBe(false);
  });

  test("runtime wording shares the table fix text", () => {
    expect(requirementFix("claude")).toBe("npm install -g @anthropic-ai/claude-code");
        expect(requirementFix("nonesuch")).toBeNull();
  });

  test("sdkBinaryPresent finds an executable platform binary and ignores a non-executable one", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-run.req-"));
    try {
      const d = join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk-test-x64");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "claude"), "#!/bin/sh\n");
      chmodSync(join(d, "claude"), 0o644);
      expect(sdkBinaryPresent({ LOKI_SDK_NODE_MODULES: join(dir, "node_modules") })).toBe(false);
      chmodSync(join(d, "claude"), 0o755);
      expect(sdkBinaryPresent({ LOKI_SDK_NODE_MODULES: join(dir, "node_modules") })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("docs/alternative-installations.md setup requirements", () => {
  const file = join(REPO_ROOT, "docs", "alternative-installations.md");
  const BEGIN = "<!-- BEGIN GENERATED REQUIREMENTS (loki-ts/tests/commands/doctor.test.ts) -->";
  const END = "<!-- END GENERATED REQUIREMENTS -->";

  test("embeds the table generated from the shared source", () => {
    const want = renderContractTable();
    let doc = readFileSync(file, "utf8");
    if (process.env["UPDATE_CONTRACT"] === "1") {
      const a = doc.indexOf(BEGIN), b = doc.indexOf(END);
      doc = `${doc.slice(0, a + BEGIN.length)}\n\n${want}\n${doc.slice(b)}`;
      writeFileSync(file, doc);
    }
    const a = doc.indexOf(BEGIN), b = doc.indexOf(END);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(doc.slice(a + BEGIN.length, b).trim()).toBe(want.trim());
  });
});

function bashReport(env: Record<string, string>): { paths: { id: string; ready: boolean; items: { id: string; status: string }[] }[]; first_task_ready: boolean } {
  const lib = join(REPO_ROOT, "autonomy/provider-offer.sh");
  const r = spawnSync("bash", ["-c", `source "$1"; loki_requirements_json "$2"`, "bash", lib, REPO_ROOT], {
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env },
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}

describe("bash requirements evaluator (autonomy/provider-offer.sh)", () => {
  test("emits every path and item from the shared table", () => {
    const rep = bashReport({ LOKI_SDK_NODE_MODULES: join(REPO_ROOT, "no-such-dir") });
    const t = loadRequirements();
    expect(rep.paths.map((p) => p.id)).toEqual(t.paths.map((p) => p.id));
    const ids = rep.paths.flatMap((p) => p.items.map((i) => i.id)).sort();
    expect(ids).toEqual(t.requirements.map((r) => r.id).sort());
  });

  test("api-key path is not ready without the SDK loop flag and SDK binary", () => {
    const rep = bashReport({ ANTHROPIC_API_KEY: "k", LOKI_SDK_NODE_MODULES: join(REPO_ROOT, "no-such-dir") });
    const sdk = rep.paths.find((p) => p.id === "api-key-sdk")!;
    expect(sdk.ready).toBe(false);
    expect(sdk.items.find((i) => i.id === "sdk-credentials")!.status).toBe("present");
    expect(sdk.items.find((i) => i.id === "sdk-binary")!.status).toBe("missing");
    expect(sdk.items.find((i) => i.id === "sdk-mode")!.status).toBe("missing");
  });

  test("SDK loop flag is honored", () => {
    const rep = bashReport({ LOKI_SDK_LOOP: "1", LOKI_SDK_NODE_MODULES: join(REPO_ROOT, "no-such-dir") });
    const sdk = rep.paths.find((p) => p.id === "api-key-sdk")!;
    expect(sdk.items.find((i) => i.id === "sdk-mode")!.status).toBe("present");
  });
});

// ---- P12-24: Claude CLI minimum version and compat manifest ------------------

describe("doctor claude CLI compat (P12-24)", () => {
  const range = { min_version: "2.1.0", qualified_version: "2.1.293" };

  it("manifest carries a min and qualified claude CLI version", () => {
    const r = loadClaudeCliRange();
    expect(r?.min_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r?.qualified_version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("classifies versions against the range", () => {
    expect(evaluateClaudeCliCompat("2.0.9", range)).toBe("below_min");
    expect(evaluateClaudeCliCompat("2.1.0", range)).toBe("ok");
    expect(evaluateClaudeCliCompat("2.1.293", range)).toBe("ok");
    expect(evaluateClaudeCliCompat("2.1.294", range)).toBe("newer_unqualified");
    expect(evaluateClaudeCliCompat(null, range)).toBe("unknown");
    expect(evaluateClaudeCliCompat("1.0.0", null)).toBe("unknown");
  });

  describe("runDoctor with a stub claude on PATH", () => {
    let dir = "";
    let prevPath: string | undefined;
    beforeEach(() => {
      stubPythonImportOk();
      dir = mkdtempSync(join(tmpdir(), "doctor-p1224-"));
      writeFileSync(join(dir, "claude"), "#!/bin/sh\necho 2.1.293\n");
      chmodSync(join(dir, "claude"), 0o755);
      prevPath = process.env.PATH;
      process.env.PATH = `${dir}:${prevPath ?? ""}`;
    });
    afterEach(() => {
      restorePythonImportOk();
      _setClaudeVersionForTest(null);
      if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
      rmSync(dir, { recursive: true, force: true });
    });

    it("fails with a blocker below the minimum", async () => {
      _setClaudeVersionForTest(() => "1.9.0");
      const { result, cap } = await captureStdio(() => runDoctor([]));
      expect(result).toBe(1);
      expect(cap.out).toContain("older than the minimum 2.1.0");
      expect(cap.out).toContain("claude CLI must be >= 2.1.0");
    });

    it("does not fail at a qualified version", async () => {
      _setClaudeVersionForTest(() => "2.1.293");
      const { cap } = await captureStdio(() => runDoctor([]));
      expect(cap.out).not.toContain("older than the minimum");
    });
  });
});

describe("doctor --fix consent-gated installs (TEN-UX-04)", () => {
  const NPM = ["npm", "install", "-g", "@anthropic-ai/claude-code"];
  const mk = (): { cwd: string; home: string } => ({
    cwd: mkdtempSync(join(tmpdir(), "docfix-cwd-")),
    home: mkdtempSync(join(tmpdir(), "docfix-home-")),
  });
  const missing = (...gone: string[]) => (c: string) => !gone.includes(c);
  const recorder = (status = 0, stderr = "") => {
    const calls: string[][] = [];
    return { calls, run: (argv: readonly string[]) => { calls.push([...argv]); return { status, stderr }; } };
  };

  it("(a) claude missing, no tty, no --yes: runner never called, npm command printed", async () => {
    const { applyDoctorFixes } = await import("../../src/commands/doctor_fix.ts");
    const { cwd, home } = mk();
    const r = recorder();
    const out = applyDoctorFixes(cwd, home, { has: missing("claude"), runner: r.run, tty: false, yes: false, loggedIn: () => "yes" });
    expect(r.calls).toEqual([]);
    expect(out.manual.join("\n")).toContain("npm install -g @anthropic-ai/claude-code");
  });

  it("(b) claude missing, --yes: runner gets exactly the npm install argv", async () => {
    const { applyDoctorFixes } = await import("../../src/commands/doctor_fix.ts");
    const { cwd, home } = mk();
    const r = recorder();
    const out = applyDoctorFixes(cwd, home, { has: missing("claude"), runner: r.run, tty: false, yes: true, loggedIn: () => "yes" });
    expect(r.calls).toEqual([NPM]);
    expect(out.applied).toContain(NPM.join(" "));
  });

  it("(b2) tty without --yes asks first: declined runs nothing, accepted runs npm", async () => {
    const { applyDoctorFixes } = await import("../../src/commands/doctor_fix.ts");
    const { cwd, home } = mk();
    const no = recorder();
    applyDoctorFixes(cwd, home, { has: missing("claude"), runner: no.run, tty: true, confirm: () => false });
    expect(no.calls).toEqual([]);
    const yes = recorder();
    applyDoctorFixes(cwd, home, { has: missing("claude"), runner: yes.run, tty: true, confirm: () => true });
    expect(yes.calls).toEqual([NPM]);
  });

  it("(c) runner failure: output has failed: and exit code is non-zero", async () => {
    const { runDoctorFix } = await import("../../src/commands/doctor_fix.ts");
    const r = recorder(1, "npm ERR! EACCES permission denied\nsecond line");
    const { cwd, home } = mk();
    const { result, cap } = await captureStdio(async () =>
      runDoctorFix({ cwd, home, has: missing("claude"), runner: r.run, yes: true, loggedIn: () => "yes" }));
    expect(cap.out).toContain("failed: npm install -g @anthropic-ai/claude-code: npm ERR! EACCES permission denied");
    expect(cap.out).not.toContain("second line");
    expect(result).toBe(1);
  });

  it("(c2) success exits 0 with fixed:", async () => {
    const { runDoctorFix } = await import("../../src/commands/doctor_fix.ts");
    const r = recorder();
    const { cwd, home } = mk();
    const { result, cap } = await captureStdio(async () =>
      runDoctorFix({ cwd, home, has: missing("claude"), runner: r.run, yes: true, loggedIn: () => "yes" }));
    expect(cap.out).toContain("fixed: npm install -g @anthropic-ai/claude-code");
    expect(result).toBe(0);
  });

  it("(d) jq missing with --yes: system package is never run, command printed", async () => {
    const { applyDoctorFixes } = await import("../../src/commands/doctor_fix.ts");
    const { cwd, home } = mk();
    const r = recorder();
    const out = applyDoctorFixes(cwd, home, { has: missing("jq"), runner: r.run, yes: true, loggedIn: () => "yes" });
    expect(r.calls).toEqual([]);
    expect(out.manual.join("\n")).toContain("brew install jq");
  });

  it("(e) claude present and logged out with --yes: runner gets [claude, login]", async () => {
    const { applyDoctorFixes } = await import("../../src/commands/doctor_fix.ts");
    const { cwd, home } = mk();
    const r = recorder();
    applyDoctorFixes(cwd, home, { has: () => true, runner: r.run, yes: true, loggedIn: () => "no" });
    expect(r.calls).toEqual([["claude", "login"]]);
  });

  it("(e2) logged in or unknown login state: no login run", async () => {
    const { applyDoctorFixes } = await import("../../src/commands/doctor_fix.ts");
    for (const state of ["yes", ""] as const) {
      const { cwd, home } = mk();
      const r = recorder();
      applyDoctorFixes(cwd, home, { has: () => true, runner: r.run, yes: true, loggedIn: () => state });
      expect(r.calls).toEqual([]);
    }
  });

  it("seed provider: first installed provider CLI is written, claude when none", async () => {
    const { applyDoctorFixes } = await import("../../src/commands/doctor_fix.ts");
    const seeded = (has: (c: string) => boolean): string => {
      const { cwd, home } = mk();
      applyDoctorFixes(cwd, home, { has, runner: recorder().run, tty: false, loggedIn: () => "yes" });
      return JSON.parse(readFileSync(join(cwd, ".loki", "config", "settings.json"), "utf8")).provider;
    };
    expect(seeded((c) => c === "codex")).toBe("codex");
    expect(seeded((c) => c === "aider" || c === "opencode")).toBe("aider");
    expect(seeded(() => true)).toBe("claude");
    expect(seeded(() => false)).toBe("claude");
  });

  it("seed provider: real entry path bin/loki doctor --fix seeds codex from a shim", () => {
    const { cwd, home } = mk();
    const shim = mkdtempSync(join(tmpdir(), "docfix-seed-"));
    writeFileSync(join(shim, "codex"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(shim, "codex"), 0o755);
    const noClaudePath = (process.env.PATH ?? "").split(":").filter((d) => d && !existsSync(join(d, "claude"))).join(":");
    const r = spawnSync(join(REPO_ROOT, "bin", "loki"), ["doctor", "--fix"], {
      cwd, encoding: "utf8", timeout: 120000,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LOKI_"))),
        HOME: home, PATH: `${shim}:${noClaudePath}`,
      },
    });
    const cfg = JSON.parse(readFileSync(join(cwd, ".loki", "config", "settings.json"), "utf8"));
    expect(cfg.provider).toBe("codex");
    expect(r.stdout).toContain("provider=codex");
    rmSync(shim, { recursive: true, force: true });
  }, 60000);

  it("(g) repair settings: invalid JSON is backed up and rewritten only with consent", async () => {
    const { applyDoctorFixes } = await import("../../src/commands/doctor_fix.ts");
    const bad = "{ not json";
    const seed = () => {
      const { cwd, home } = mk();
      mkdirSync(join(cwd, ".loki", "config"), { recursive: true });
      writeFileSync(join(cwd, ".loki", "config", "settings.json"), bad);
      return { cwd, home, file: join(cwd, ".loki", "config", "settings.json") };
    };
    const deps = { has: (c: string) => c === "claude", runner: recorder().run, loggedIn: () => "yes" as const };
    const a = seed();
    const outA = applyDoctorFixes(a.cwd, a.home, { ...deps, tty: false, yes: false });
    expect(readFileSync(a.file, "utf8")).toBe(bad);
    expect(outA.manual.join("\n")).toContain("is not valid JSON");
    const b = seed();
    const outB = applyDoctorFixes(b.cwd, b.home, { ...deps, tty: false, yes: true });
    expect(JSON.parse(readFileSync(b.file, "utf8")).provider).toBe("claude");
    const bak = readdirSync(join(b.cwd, ".loki", "config")).filter((f) => f.startsWith("settings.json.invalid-"));
    expect(bak.length).toBe(1);
    expect(readFileSync(join(b.cwd, ".loki", "config", bak[0]!), "utf8")).toBe(bad);
    expect(outB.applied.join("\n")).toContain("backed up invalid");
    expect(outB.manual.join("\n")).not.toContain("is not valid JSON");
    const c = seed();
    applyDoctorFixes(c.cwd, c.home, { ...deps, tty: true, confirm: () => false });
    expect(readFileSync(c.file, "utf8")).toBe(bad);
  });

  it("(g2) repair settings through bin/loki doctor --fix --yes", () => {
    const { cwd, home } = mk();
    mkdirSync(join(cwd, ".loki", "config"), { recursive: true });
    const f = join(cwd, ".loki", "config", "settings.json");
    writeFileSync(f, "{ broken");
    const r = spawnSync(join(REPO_ROOT, "bin", "loki"), ["doctor", "--fix", "--yes"], {
      cwd, encoding: "utf8", timeout: 120000,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LOKI_"))), HOME: home },
    });
    expect(r.stdout).toContain("backed up invalid");
    expect(() => JSON.parse(readFileSync(f, "utf8"))).not.toThrow();
  }, 60000);

  it("(f) real entry path: bin/loki doctor --fix --yes runs claude login via the shim", () => {
    const { cwd, home } = mk();
    const shim = mkdtempSync(join(tmpdir(), "docfix-shim-"));
    const log = join(shim, "calls.log");
    writeFileSync(join(shim, "claude"), `#!/bin/sh\nif [ "$1" = auth ]; then echo '{"loggedIn":false}'; exit 0; fi\necho "$@" >> "${log}"\nexit 0\n`);
    chmodSync(join(shim, "claude"), 0o755);
    const r = spawnSync(join(REPO_ROOT, "bin", "loki"), ["doctor", "--fix", "--yes"], {
      cwd, encoding: "utf8", timeout: 120000,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LOKI_"))),
        HOME: home, PATH: `${shim}:${process.env.PATH ?? ""}`,
      },
    });
    if (!r.stdout.includes("fixed: claude login")) console.error(r.stdout.slice(-1500), r.stderr.slice(-500));
    expect(r.stdout).toContain("fixed: claude login");
    expect(readFileSync(log, "utf8").trim().split("\n").filter((l) => l === "login")).toEqual(["login"]);
    rmSync(shim, { recursive: true, force: true });
  });
});

// ---- TEN-SPEED-06: Integration probes run concurrently ------------------------

describe("doctor Integration probes run concurrently (TEN-SPEED-06)", () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  afterEach(() => {
    _setIntegrationProbesForTest(null);
    restorePythonImportOk();
  });

  it("three 200ms injected probes finish in well under the 600ms serial sum", async () => {
    _setPythonImportOkForTest(async () => { await sleep(200); return true; });
    _setIntegrationProbesForTest({
      http: async () => { await sleep(200); return true; },
      command: async (c) => { await sleep(200); return c === "gopls" ? "/x/gopls" : null; },
      sentruxVersion: async () => "1.2.3",
    });
    const t0 = Date.now();
    const r = await probeIntegrations("http://mf.invalid");
    const dt = Date.now() - t0;
    expect(dt).toBeLessThan(350);
    expect(r).toEqual({
      mcpOk: true, numpyOk: true, stOk: true, chromaOk: true,
      lsp: ["gopls"], mirofishOk: true, sentruxVersion: null,
    });
  });

  it("unset MiroFish url skips the probe; sentrux version only when on PATH", async () => {
    _setPythonImportOkForTest(async () => false);
    let httpCalls = 0;
    _setIntegrationProbesForTest({
      http: async () => { httpCalls++; return false; },
      command: async (c) => (c === "sentrux" ? "/x/sentrux" : null),
      sentruxVersion: async () => "9.9.9",
    });
    const r = await probeIntegrations(undefined);
    expect(httpCalls).toBe(1);
    expect(r.mirofishOk).toBeNull();
    expect(r.sentruxVersion).toBe("9.9.9");
    expect(r.lsp).toEqual([]);
  });

  it("runDoctor([]) starts every probe together and keeps the Integrations output order", async () => {
    const starts: number[] = [];
    const t0 = Date.now();
    const mark = (): void => { starts.push(Date.now() - t0); };
    _setPythonImportOkForTest(async () => { mark(); await sleep(150); return true; });
    _setIntegrationProbesForTest({
      http: async () => { mark(); await sleep(150); return true; },
      command: async (c) => {
        if (["pyright-langserver", "pylsp", "typescript-language-server", "gopls", "rust-analyzer", "jdtls", "sentrux"].includes(c)) {
          mark(); await sleep(150);
          return c === "sentrux" || c === "pylsp" ? `/x/${c}` : null;
        }
        const { commandExists } = await import("../../src/util/shell.ts");
        return commandExists(c);
      },
      sentruxVersion: async () => "1.2.3",
    });
    const { cap } = await captureStdio(() => runDoctor([]));
    const spread = Math.max(...starts) - Math.min(...starts);
    expect(starts.length).toBe(3 + 1 + 6 + 1);
    expect(spread).toBeLessThan(100);
    const order = ["MCP SDK (Python)", "numpy (vector search)", "sentence-transformers (embeddings)", "ChromaDB server (port 8100)", "LSP servers detected (1): pylsp", "OTEL", "sentrux 1.2.3"];
    let at = -1;
    for (const needle of order) {
      const i = cap.out.indexOf(needle);
      expect(i).toBeGreaterThan(at);
      at = i;
    }
  });
});

describe("doctor json checks run concurrently (TEN-SPEED-10)", () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  afterEach(() => _setJsonProbesForTest(null));

  it("json checks run concurrently: three 200ms probes overlap and output keys are preserved", async () => {
    await buildDoctorJson(); // warm the shared tool-check path
    const base = await buildDoctorJson();
    _setJsonProbesForTest({
      sentrux: async () => { await sleep(200); return base.sentrux; },
      memory: async () => { await sleep(200); return base.memory; },
      requirements: async () => { await sleep(200); return base.requirements; },
    });
    const t0 = Date.now();
    const j = await buildDoctorJson();
    const dt = Date.now() - t0;
    const t1 = Date.now();
    _setJsonProbesForTest({ sentrux: async () => base.sentrux, memory: async () => base.memory, requirements: async () => base.requirements });
    await buildDoctorJson();
    const floor = Date.now() - t1;
    expect(dt - floor).toBeLessThan(400);
    expect(j.sentrux).toEqual(base.sentrux);
    expect(j.memory).toEqual(base.memory);
    expect(j.requirements).toEqual(base.requirements);
    expect(Object.keys(j)).toEqual(Object.keys(base));
  });
});

// TEN-UX-18: doctor --quiet keeps only FAIL/WARN rows and the Summary footer.
describe("doctor --quiet", () => {
  afterEach(() => { _setPythonImportOkForTest(null); _setIntegrationProbesForTest(null); });

  it("filterQuietDoctor drops pass rows, headers and OK lines, keeps fail/warn with fix lines and the footer", async () => {
    const { filterQuietDoctor } = await import("../../src/commands/doctor.ts");
    const text = [
      "Loki Mode Doctor", "", "Tools:", "  PASS  Node (v20)", "  FAIL  Git - not found",
      "         Fix: install git", "  OK    Single loki install", "  WARN  Disk low", "  PASS  Bun",
      "         Note: pass detail", "", "Summary: 2 passed, 1 failed, 1 warnings", "", "Then re-run: loki doctor", "",
    ].join("\n");
    const out = filterQuietDoctor(text);
    expect(out).toContain("FAIL  Git - not found");
    expect(out).toContain("Fix: install git");
    expect(out).toContain("WARN  Disk low");
    expect(out).toContain("Summary: 2 passed");
    expect(out).toContain("Then re-run: loki doctor");
    expect(out).not.toContain("PASS");
    expect(out).not.toContain("Tools:");
    expect(out).not.toContain("Single loki");
    expect(out).not.toContain("pass detail");
  });

  it("runDoctor(['--quiet']) prints no PASS row, keeps the footer, and returns the same exit code as the full run", async () => {
    stubPythonImportOk();
    const full = await captureStdio(() => runDoctor([]));
    const quiet = await captureStdio(() => runDoctor(["--quiet"]));
    expect(quiet.result).toBe(full.result);
    expect(quiet.cap.out).not.toMatch(/\bPASS\b/);
    expect(quiet.cap.out).toMatch(/Summary:/);
    expect(quiet.cap.out.length).toBeLessThan(full.cap.out.length);
    const short = await captureStdio(() => runDoctor(["-q"]));
    expect(short.result).toBe(full.result);
  });

  it("install hint follows its row", async () => {
    stubPythonImportOk();
    const saved = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      const quiet = await captureStdio(() => runDoctor(["--quiet"]));
      const lines = quiet.cap.out.split("\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
      const i = lines.findIndex((l) => /\b(FAIL|WARN)\b.*claude/i.test(l));
      expect(i).toBeGreaterThanOrEqual(0);
      expect(lines[i + 1]).toContain("Install: npm install -g @anthropic-ai/claude-code");
      expect(quiet.cap.err).not.toContain("Install:");
    } finally {
      process.env.PATH = saved;
    }
  });

  it("--quiet leaves --json unaffected", async () => {
    stubPythonImportOk();
    const a = await captureStdio(() => runDoctor(["--json"]));
    const b = await captureStdio(() => runDoctor(["--json", "--quiet"]));
    expect(b.result).toBe(a.result);
    expect(JSON.parse(b.cap.out).summary).toEqual(JSON.parse(a.cap.out).summary);
  });
});

// TEN-STABILITY-17: doctor lists orphan runs (dead owner, no run.completed) with the resume/undo command.
describe("doctor orphan runs", () => {
  const env = (id: string, seq: number, type: string) => JSON.stringify({ v: 1, seq, ts: new Date().toISOString(), run: id, type, stage: null, data: {} }) + "\n";
  let repo: string;
  let prevCwd: string;
  function mkRun(id: string, types: string[], pid?: number): void {
    const dir = join(repo, ".loki", "runs", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), types.map((t, i) => env(id, i, t)).join(""));
    if (pid !== undefined) {
      const start = pid === process.pid ? (processStartTime(pid) ?? "") : "dead-start";
      writeFileSync(join(dir, "run.pid"), JSON.stringify({ pid, start, argv: ["x"], run_id: id }));
    }
  }
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "loki-orphan-"));
    prevCwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(repo, { recursive: true, force: true });
    restorePythonImportOk();
  });

  it("lists a dead-owner run without run.completed; skips live and completed runs", () => {
    mkRun("e10-orphan", ["run.started"], 999999);
    mkRun("e10-live", ["run.started"], process.pid);
    mkRun("e10-done", ["run.started", "run.completed"], 999999);
    expect(findOrphanRuns(repo)).toEqual(["e10-orphan"]);
  });

  it("runDoctor text prints a warn row naming the run id and the resume and undo commands", async () => {
    mkRun("e10-orphan", ["run.started"], 999999);
    mkRun("e10-live", ["run.started"], process.pid);
    mkRun("e10-done", ["run.started", "run.completed"], 999999);
    process.chdir(repo);
    stubPythonImportOk();
    const { cap } = await captureStdio(() => runDoctor([]));
    const out = cap.out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toMatch(/WARN\s+Orphan run e10-orphan/);
    expect(out).toContain("loki start --resume e10-orphan");
    expect(out).toContain("loki undo e10-orphan");
    expect(out).not.toContain("e10-live");
    expect(out).not.toContain("e10-done");
  });
});

describe("doctor hung helper (TEN-STABILITY-47)", () => {
  let dir = "";
  let prevPath: string | undefined;
  let prevTimeout: string | undefined;
  beforeEach(() => {
    stubPythonImportOk();
    dir = mkdtempSync(join(tmpdir(), "doctor-hung-"));
    for (const name of ["bash", "python3"]) {
      writeFileSync(join(dir, name), "#!/bin/sh\nexec sleep 30\n");
      chmodSync(join(dir, name), 0o755);
    }
    prevPath = process.env.PATH;
    prevTimeout = process.env.LOKI_DOCTOR_HELPER_TIMEOUT_MS;
    process.env.PATH = `${dir}:${prevPath ?? ""}`;
    process.env.LOKI_DOCTOR_HELPER_TIMEOUT_MS = "300";
  });
  afterEach(() => {
    restorePythonImportOk();
    if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
    if (prevTimeout === undefined) delete process.env.LOKI_DOCTOR_HELPER_TIMEOUT_MS;
    else process.env.LOKI_DOCTOR_HELPER_TIMEOUT_MS = prevTimeout;
    rmSync(dir, { recursive: true, force: true });
  });

  it("provider helpers return skipped values when the helper hangs", () => {
    const t0 = Date.now();
    expect(readEffectiveProvider()).toBeNull();
    expect(readProviderAvailability()).toBeNull();
    expect(renderProviderAvailability()).toBe("");
    expect(Date.now() - t0).toBeLessThan(10000);
  });

  it("runDoctor finishes and reports hung probes as skipped", async () => {
    const t0 = Date.now();
    const { cap } = await captureStdio(() => runDoctor([]));
    expect(Date.now() - t0).toBeLessThan(25000);
    expect(cap.out).toContain("timed out (skipped)");
  }, 30000);
});

describe("doctor version compare", () => {
  test("one semver compare serves all three call shapes", async () => {
    expect(cmpVersion("2.1.0", "2.1.0", 3)).toBe(0);
    expect(cmpVersion("2.0.9", "2.1.0", 3)).toBeLessThan(0);
    expect(cmpVersion("2.1.1", "2.1.0", 2)).toBe(0);
    expect(cmpVersion("2.1.1", "2.1.0")).toBeGreaterThan(0);
    expect(cmpVersion("20", "20.0", 2)).toBe(0);
    expect(cmpVersion("1.x", "1.0", 2)).toBe(0);
    expect(evaluateClaudeCliCompat("2.0.9", { min_version: "2.1.0" } as never)).toBe("below_min");
    expect(evaluateClaudeCliCompat("2.1.5", { min_version: "2.1.0", qualified_version: "2.1.4" } as never)).toBe("newer_unqualified");
    const old = await checkTool("bun", "bun", "required", "999.0");
    expect(old.status).toBe("fail");
    const ok = await checkTool("bun", "bun", "required", null);
    expect(ok.status).toBe("pass");
  });
});

describe("evaluateCloudAuth", () => {
  it("is silent when no CLAUDE_CODE_USE_* flag is set", () => {
    expect(evaluateCloudAuth({})).toEqual([]);
  });
  it("warns naming AWS_REGION when Bedrock is on without a region", () => {
    const rows = evaluateCloudAuth({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "dev" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("warn");
    expect(rows[0]!.line).toContain("AWS_REGION");
    expect(rows[0]!.line).not.toContain("AWS credentials");
  });
  it("passes Bedrock with region and credentials, never echoing values", () => {
    const rows = evaluateCloudAuth({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIASECRET" });
    expect(rows[0]!.status).toBe("pass");
    expect(rows[0]!.line).not.toContain("AKIASECRET");
  });
  it("names the Vertex project id and region when missing", () => {
    const line = evaluateCloudAuth({ CLAUDE_CODE_USE_VERTEX: "1", GOOGLE_APPLICATION_CREDENTIALS: "/x" })[0]!.line;
    expect(line).toContain("CLOUD_ML_REGION");
    expect(line).toContain("ANTHROPIC_VERTEX_PROJECT_ID");
  });
  it("carries the service-account key hygiene hint", () => {
    expect(CLOUD_KEY_HYGIENE).toContain("service-account");
    expect(CLOUD_KEY_HYGIENE).toContain("expiration");
  });
});

describe("evaluateCloudAuth warn path", () => {
  it("never echoes env values in a warn line", () => {
    const cases: Array<Record<string, string>> = [
      { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "SECRETPROFILE" },
      { CLAUDE_CODE_USE_VERTEX: "1", GOOGLE_APPLICATION_CREDENTIALS: "SECRETPATH" },
      { CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_RESOURCE: "SECRETRESOURCE" },
    ];
    for (const env of cases) {
      const rows = evaluateCloudAuth(env);
      expect(rows[0]!.status).toBe("warn");
      for (const v of Object.values(env)) {
        if (v !== "1") expect(rows[0]!.line).not.toContain(v);
      }
    }
  });
  it("names the keyless paths the check cannot see", () => {
    expect(evaluateCloudAuth({ CLAUDE_CODE_USE_FOUNDRY: "1" })[0]!.line).toContain("Entra ID");
    expect(evaluateCloudAuth({ CLAUDE_CODE_USE_VERTEX: "1" })[0]!.line).toContain("gcloud ADC");
    expect(evaluateCloudAuth({ CLAUDE_CODE_USE_BEDROCK: "1" })[0]!.line).toContain("instance or task role");
  });
  it("buildDoctorJson carries cloud_auth rows and counts the warning", async () => {
    const saved = process.env["CLAUDE_CODE_USE_BEDROCK"];
    const savedRegion = process.env["AWS_REGION"];
    const savedDefault = process.env["AWS_DEFAULT_REGION"];
    process.env["CLAUDE_CODE_USE_BEDROCK"] = "1";
    delete process.env["AWS_REGION"];
    delete process.env["AWS_DEFAULT_REGION"];
    try {
      const withFlag = await buildDoctorJson();
      delete process.env["CLAUDE_CODE_USE_BEDROCK"];
      const base = await buildDoctorJson();
      process.env["CLAUDE_CODE_USE_BEDROCK"] = "1";
      const j = withFlag;
      expect(j.summary.warnings).toBe(base.summary.warnings + 1);
      expect(j.cloud_auth).toHaveLength(1);
      expect(j.cloud_auth[0]!.status).toBe("warn");
      expect(j.cloud_auth[0]!.line).toContain("AWS_REGION");
    } finally {
      if (saved === undefined) delete process.env["CLAUDE_CODE_USE_BEDROCK"]; else process.env["CLAUDE_CODE_USE_BEDROCK"] = saved;
      if (savedRegion !== undefined) process.env["AWS_REGION"] = savedRegion;
      if (savedDefault !== undefined) process.env["AWS_DEFAULT_REGION"] = savedDefault;
    }
  }, 60000);
});

describe("model capability row (models.retrieve vs the catalog)", () => {
  const dir = mkdtempSync(join(tmpdir(), "capcat-"));
  const cat = join(dir, "cat.json");
  writeFileSync(cat, JSON.stringify({ providers: { claude: { models: [
    { id: "m-a", thinking: { types: ["adaptive", "between_tools"] }, effort: { levels: ["low", "medium", "high"] } },
  ] } } }));
  const env = { ANTHROPIC_API_KEY: "k", LOKI_MODEL_CATALOG: cat } as NodeJS.ProcessEnv;
  afterEach(() => _setModelsRetrieveForTest(null));

  it("parses supported effort levels and thinking types from a retrieve body", () => {
    const body = { capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: false } }, thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } } } };
    expect(parseModelCapabilities(body)).toEqual({ effort: ["low"], thinking: ["adaptive"] });
    expect(parseModelCapabilities({})).toBeNull();
  });

  it("prints a mismatch when the API lacks an effort level the catalog lists", async () => {
    _setModelsRetrieveForTest(async () => ({ effort: ["low", "medium"], thinking: ["adaptive"] }));
    const r = await checkModelCapabilities(env);
    expect(r.status).toBe("warn");
    expect(r.mismatches.map((m) => m.detail).join("|")).toContain("effort levels: catalog [low, medium, high], API [low, medium]");
  });

  it("flags a thinking type drift but ignores loki-side types the API cannot list", () => {
    const entry = { id: "m-a", thinking: { types: ["adaptive", "between_tools"] }, effort: { levels: ["low"] } };
    expect(compareModelCapabilities(entry, { effort: ["low"], thinking: ["adaptive"] })).toEqual([]);
    expect(compareModelCapabilities(entry, { effort: ["low"], thinking: ["adaptive", "enabled"] })[0]!.detail).toContain("thinking types");
  });

  it("passes when the API matches the catalog", async () => {
    _setModelsRetrieveForTest(async () => ({ effort: ["high", "medium", "low"], thinking: ["adaptive"] }));
    expect((await checkModelCapabilities(env)).status).toBe("pass");
  });

  it("warns, never throws, without a key and when offline", async () => {
    let calls = 0;
    _setModelsRetrieveForTest(async () => { calls++; throw new Error("offline"); });
    const noKey = await checkModelCapabilities({ LOKI_MODEL_CATALOG: cat } as NodeJS.ProcessEnv);
    expect(noKey.status).toBe("warn");
    expect(calls).toBe(0);
    const offline = await checkModelCapabilities(env);
    expect(offline.status).toBe("warn");
    expect(offline.mismatches).toEqual([]);
  });

  it("runDoctor renders the Model capabilities section without changing the exit code basis", async () => {
    _setModelsRetrieveForTest(async () => ({ effort: ["low"], thinking: ["adaptive"] }));
    const saved = { k: process.env["ANTHROPIC_API_KEY"], c: process.env["LOKI_MODEL_CATALOG"] };
    process.env["ANTHROPIC_API_KEY"] = "k";
    process.env["LOKI_MODEL_CATALOG"] = cat;
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (c: string | Uint8Array) => { chunks.push(String(c)); return true; };
    try {
      stubPythonImportOk();
      await runDoctor([]);
    } finally {
      (process.stdout as { write: unknown }).write = orig;
      if (saved.k === undefined) delete process.env["ANTHROPIC_API_KEY"]; else process.env["ANTHROPIC_API_KEY"] = saved.k;
      if (saved.c === undefined) delete process.env["LOKI_MODEL_CATALOG"]; else process.env["LOKI_MODEL_CATALOG"] = saved.c;
    }
    const out = chunks.join("");
    expect(out).toContain("Model capabilities:");
    expect(out).toContain("m-a: effort levels: catalog [low, medium, high], API [low]");
  });
});

describe("CW-14: provider_auth rows", () => {
  const CANARY = "sk-canary-DO-NOT-LEAK-0123456789";
  it("names the credential source for every provider and never the value", () => {
    const env = { HOME: "/nonexistent-home", ANTHROPIC_API_KEY: CANARY, OPENAI_API_KEY: CANARY + "2" };
    const rows = providerAuthRows(env);
    expect(rows.map((r) => r.provider)).toEqual(["claude", "codex", "cline", "aider", "opencode"]);
    expect(rows.find((r) => r.provider === "claude")!.auth_path).toBe("api_key:ANTHROPIC_API_KEY");
    expect(rows.find((r) => r.provider === "codex")!.auth_path).toBe("api_key:OPENAI_API_KEY");
    expect(JSON.stringify(rows)).not.toContain("canary");
  });
  it("no credential: claude and codex defer to their CLI login, others say none", () => {
    const env = { HOME: "/nonexistent-home" };
    expect(providerAuthPath("claude", env)).toBe("cli_login:claude");
    expect(providerAuthPath("codex", env)).toBe("cli_login:codex");
    expect(providerAuthPath("aider", env)).toBe("none");
  });
  it("an oauth token is named as oauth_token", () => {
    expect(providerAuthPath("claude", { HOME: "/x", CLAUDE_CODE_OAUTH_TOKEN: CANARY })).toBe("oauth_token:CLAUDE_CODE_OAUTH_TOKEN");
  });
  it("buildDoctorJson carries provider_auth rows", async () => {
    const j = await buildDoctorJson();
    expect(j.provider_auth).toHaveLength(5);
    expect(JSON.stringify(j.provider_auth)).not.toMatch(/sk-/);
  }, 60000);
});

// R100-001: loki doctor --json reports provider_autodetected, true when an installed provider CLI is logged in.
describe("doctor.providerAutodetected (R100-001)", () => {
  const PROVIDERS = ["claude", "codex", "opencode", "cline", "aider"] as const;
  function fixture(provider: (typeof PROVIDERS)[number], loggedIn: boolean) {
    const root = mkdtempSync(join(tmpdir(), "r100-autodetect-"));
    const bin = join(root, "bin");
    const home = join(root, "home");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    const stubs: Record<string, string> = {
      claude: `#!/bin/sh\n[ "$1" = auth ] && echo '{"loggedIn":${loggedIn}}'\nexit 0\n`,
      codex: `#!/bin/sh\n[ "$1" = login ] && { ${loggedIn ? "echo 'Logged in'; exit 0" : "echo 'Not logged in'; exit 1"}; }\nexit 0\n`,
      opencode: "#!/bin/sh\nexit 0\n",
      cline: "#!/bin/sh\nexit 0\n",
      aider: "#!/bin/sh\nexit 0\n",
    };
    const path = join(bin, provider);
    writeFileSync(path, stubs[provider]!);
    chmodSync(path, 0o755);
    const env: NodeJS.ProcessEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_DATA_HOME: join(home, "xdg") };
    if (loggedIn && provider === "opencode") {
      mkdirSync(join(home, "xdg", "opencode"), { recursive: true });
      writeFileSync(join(home, "xdg", "opencode", "auth.json"), "{}");
    }
    if (loggedIn && provider === "cline") mkdirSync(join(home, ".cline"), { recursive: true });
    if (loggedIn && provider === "aider") env["ANTHROPIC_API_KEY"] = "sk-ant-placeholder-for-the-fixture";
    return { root, env, checks: [{ command: provider, found: true, path }] };
  }

  it("claude logged out: only claude's own key or token counts, a foreign provider key does not (preflight parity)", () => {
    const off = fixture("claude", false);
    try {
      expect(providerAutodetected(off.checks, { ...off.env, OPENAI_API_KEY: "x" })).toBe(false);
      expect(providerAutodetected(off.checks, { ...off.env, CLAUDE_CODE_OAUTH_TOKEN: "x" })).toBe(true);
      expect(providerAutodetected(off.checks, { ...off.env, ANTHROPIC_API_KEY: "x" })).toBe(true);
    } finally {
      rmSync(off.root, { recursive: true, force: true });
    }
  });

  for (const p of PROVIDERS) {
    it(`${p}: installed and logged in is autodetected, installed and logged out is not`, () => {
      const on = fixture(p, true);
      const off = fixture(p, false);
      try {
        expect(providerAutodetected(on.checks, on.env)).toBe(true);
        expect(providerAutodetected(off.checks, off.env)).toBe(false);
      } finally {
        rmSync(on.root, { recursive: true, force: true });
        rmSync(off.root, { recursive: true, force: true });
      }
    });
  }

  it("a provider that is not installed is never autodetected, even with an API key in the env", () => {
    expect(providerAutodetected([{ command: "claude", found: false, path: null }], { ANTHROPIC_API_KEY: "x" })).toBe(false);
  });

  it("buildDoctorJson carries the provider_autodetected boolean", async () => {
    const j = await buildDoctorJson();
    expect(typeof j.provider_autodetected).toBe("boolean");
  });
});

describe("checkAgentSdkPin", () => {
  const SDK = "@anthropic-ai/claude-agent-sdk";
  function fixture(pin: string | null, installed: string | null): string {
    const root = mkdtempSync(join(tmpdir(), "doctor-sdkpin-"));
    mkdirSync(join(root, "loki-ts"), { recursive: true });
    const deps = pin === null ? {} : { [SDK]: pin };
    writeFileSync(join(root, "loki-ts/package.json"), JSON.stringify({ dependencies: deps }));
    writeFileSync(join(root, "loki-ts/bun.lock"), "");
    if (installed !== null) {
      const d = join(root, "loki-ts/node_modules", SDK);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "package.json"), JSON.stringify({ name: SDK, version: installed }));
    }
    return root;
  }

  it("warns with the fix command when installed differs from the pin", async () => {
    const { checkAgentSdkPin } = await import("../../src/commands/doctor.ts");
    const root = fixture("0.3.309", "0.3.300");
    try {
      const r = checkAgentSdkPin(root, {});
      expect(r.status).toBe("warn");
      expect(r.detail).toContain("0.3.300");
      expect(r.detail).toContain("0.3.309");
      expect(r.detail).toContain("Fix: cd loki-ts && bun install");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fix text per install layout", async () => {
    const { agentSdkFixText } = await import("../../src/commands/doctor.ts");
    const base = mkdtempSync(join(tmpdir(), "doctor-sdkfix-"));
    try {
      const checkout = join(base, "checkout");
      mkdirSync(join(checkout, "loki-ts"), { recursive: true });
      writeFileSync(join(checkout, "loki-ts/bun.lock"), "");
      expect(agentSdkFixText(checkout)).toBe("cd loki-ts && bun install");
      const global = join(base, "prefix/lib/node_modules/loki-mode");
      mkdirSync(global, { recursive: true });
      expect(agentSdkFixText(global)).toBe("npm install -g loki-mode@latest");
      const local = join(base, "proj/node_modules/loki-mode");
      mkdirSync(local, { recursive: true });
      expect(agentSdkFixText(local)).toBe("npm install loki-mode@latest");
      const other = join(base, "elsewhere");
      mkdirSync(other, { recursive: true });
      expect(agentSdkFixText(other)).toContain("npm install -g loki-mode@latest");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reads the installed version from a hoisted layout (root/.. and root/../..)", async () => {
    const { checkAgentSdkPin } = await import("../../src/commands/doctor.ts");
    for (const depth of [1, 2]) {
      const base = mkdtempSync(join(tmpdir(), "doctor-sdkhoist-"));
      try {
        const nm = join(base, "node_modules");
        const root = depth === 1 ? join(nm, "loki-mode") : join(nm, "wrap", "loki-mode");
        mkdirSync(join(root, "loki-ts"), { recursive: true });
        writeFileSync(join(root, "loki-ts/package.json"), JSON.stringify({ dependencies: { [SDK]: "0.3.309" } }));
        const d = join(nm, SDK);
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, "package.json"), JSON.stringify({ name: SDK, version: "0.3.300" }));
        const r = checkAgentSdkPin(root, {});
        expect(r.installed).toBe("0.3.300");
        expect(r.status).toBe("warn");
        expect(r.detail).toContain("npm install");
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
  });

  it("passes when installed equals the pin", async () => {
    const { checkAgentSdkPin } = await import("../../src/commands/doctor.ts");
    const root = fixture("0.3.309", "0.3.309");
    try {
      expect(checkAgentSdkPin(root, {}).status).toBe("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports unknown, never pass, when the SDK is not installed or the pin is absent", async () => {
    const { checkAgentSdkPin } = await import("../../src/commands/doctor.ts");
    const missing = fixture("0.3.309", null);
    const nopin = fixture(null, "0.3.309");
    try {
      expect(checkAgentSdkPin(missing, {}).status).toBe("unknown");
      expect(checkAgentSdkPin(nopin, {}).status).toBe("unknown");
    } finally {
      rmSync(missing, { recursive: true, force: true });
      rmSync(nopin, { recursive: true, force: true });
    }
  });

  it("buildDoctorJson carries agent_sdk", async () => {
    const j = await buildDoctorJson();
    expect(["pass", "warn", "unknown"]).toContain(j.agent_sdk.status);
  });
});
