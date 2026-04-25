// Tests for src/commands/doctor.ts.
//
// Strategy:
//   - Unit-test pure helpers (compareMajorMinor implicit via checkTool, disk,
//     skills, JSON shape).
//   - End-to-end test runDoctor() with --json by capturing stdout via a
//     write hook. This is the same shape as autonomy/loki doctor --json.
//   - Avoid asserting exact pass/fail counts (depends on host) -- assert shape
//     and invariants instead.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDoctorJson,
  checkDisk,
  checkSkills,
  checkTool,
  httpReachable,
  runDoctor,
  type DoctorJson,
  type ToolCheck,
} from "../../src/commands/doctor.ts";

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
});

// ---- checkSkills -------------------------------------------------------------

describe("doctor.checkSkills", () => {
  it("returns one entry per provider", () => {
    const skills = checkSkills();
    expect(skills.length).toBe(5);
    const names = skills.map((s) => s.name);
    expect(names).toEqual([
      "Claude Code",
      "Codex CLI",
      "Gemini CLI",
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

  it("contains all 11 expected tool checks in order", () => {
    const expected = [
      "node",
      "python3",
      "jq",
      "git",
      "curl",
      "bash",
      "claude",
      "codex",
      "gemini",
      "cline",
      "aider",
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
  it("--json emits parseable JSON and exits 0", async () => {
    const { result, cap } = await captureStdio(() => runDoctor(["--json"]));
    expect(result).toBe(0);
    const parsed = JSON.parse(cap.out) as DoctorJson;
    expect(parsed.checks.length).toBe(11);
    expect(parsed.summary).toBeDefined();
  });

  it("--help exits 0 and prints usage", async () => {
    const { result, cap } = await captureStdio(() => runDoctor(["--help"]));
    expect(result).toBe(0);
    expect(cap.out).toContain("loki doctor");
    expect(cap.out).toContain("--json");
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

// ---- exit-code parity --------------------------------------------------------

describe("doctor exit-code parity", () => {
  // Bash parity: text mode includes skill + integration counts in the
  // pass/fail/warn tallies (cmd_doctor lines 6398-6483); JSON mode does not
  // (cmd_doctor_json only checks tools + disk, line 6534+). So the two exit
  // semantics are necessarily decoupled. We assert each one's invariant
  // independently rather than tying them together.

  it("text mode exit code is 0 or 1", async () => {
    const { result } = await captureStdio(() => runDoctor([]));
    expect([0, 1]).toContain(result);
  }, 30_000);

  it("json mode always exits 0 regardless of failures", async () => {
    const { result } = await captureStdio(() => runDoctor(["--json"]));
    expect(result).toBe(0);
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

  afterEach(async () => {
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

  afterEach(() => {
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

  afterEach(() => {
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

  afterEach(async () => {
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
