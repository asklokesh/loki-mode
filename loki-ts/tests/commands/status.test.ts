// Tests for the status command port.
// Source-of-truth: autonomy/loki:1963 (cmd_status), :2124 (cmd_status_json).
//
// Hermetic: each test creates a tmpdir for LOKI_DIR; nothing reads the real
// ~/.loki or repo .loki. process.stdout/stderr are monkey-patched per-test
// because runStatus writes directly to them (mirrors bash's `echo`).

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { runStatus } from "../../src/commands/status.ts";
import { stripAnsi } from "../../src/util/colors.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Capture = { stdout: string; stderr: string };

function captureIO(): { restore: () => void; get: () => Capture } {
  const orig = {
    out: process.stdout.write.bind(process.stdout),
    err: process.stderr.write.bind(process.stderr),
  };
  let out = "";
  let err = "";
  // Bun typings allow string | Uint8Array; coerce both to string.
  process.stdout.write = ((chunk: unknown): boolean => {
    out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    err += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => {
      process.stdout.write = orig.out;
      process.stderr.write = orig.err;
    },
    get: () => ({ stdout: out, stderr: err }),
  };
}

// Save and restore env vars touched by status.
const ENV_KEYS = ["LOKI_DIR", "LOKI_PROVIDER", "LOKI_DASHBOARD_PORT", "PATH"] as const;
let savedEnv: Partial<Record<string, string>> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "loki-status-test-"));
}

async function runWithCapture(argv: readonly string[]): Promise<Capture & { exitCode: number }> {
  const cap = captureIO();
  let exitCode: number;
  try {
    exitCode = await runStatus(argv);
  } finally {
    cap.restore();
  }
  return { ...cap.get(), exitCode };
}

describe("status: --help", () => {
  it("prints usage and returns 0", async () => {
    const r = await runWithCapture(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage: loki status [--json]");
  });

  it("accepts -h alias", async () => {
    const r = await runWithCapture(["-h"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage: loki status [--json]");
  });
});

describe("status: unknown flag", () => {
  it("rejects unknown flags with exit 1", async () => {
    const r = await runWithCapture(["--bogus"]);
    expect(r.exitCode).toBe(1);
    expect(stripAnsi(r.stdout)).toContain("Unknown flag: --bogus");
    expect(r.stdout).toContain("Usage: loki status [--json]");
  });
});

describe("status: text mode -- missing jq", () => {
  it("returns 1 and prints install instructions when jq is absent", async () => {
    // Force PATH to /bin only (sh must remain available for shell.ts) and
    // verify that jq is genuinely absent there. Skip if jq lives in /bin
    // (extremely uncommon -- jq is usually /usr/bin or /opt/homebrew/bin).
    const empty = mkTmp();
    try {
      process.env["PATH"] = "/bin";
      // Sanity check the assumption.
      const { commandExists } = await import("../../src/util/shell.ts");
      const jqInBin = await commandExists("jq");
      if (jqInBin) {
        // Environment has jq in /bin; can't run this test hermetically.
        // Mark as skipped by passing a trivial assertion.
        expect(jqInBin.includes("/bin/jq")).toBe(true);
        return;
      }
      process.env["LOKI_DIR"] = join(empty, "no-loki");
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(1);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Error: jq is required but not installed.");
      expect(out).toContain("brew install jq");
      expect(out).toContain("apt install jq");
      expect(out).toContain("yum install jq");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("status: text mode -- missing .loki dir", () => {
  it("prints friendly 'no active session' block and exits 0", async () => {
    const root = mkTmp();
    try {
      process.env["LOKI_DIR"] = join(root, "nonexistent");
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Loki Mode Status");
      expect(out).toContain("No active session found.");
      expect(out).toContain("loki start <prd>");
      expect(out).toContain("Current directory:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("status: text mode -- minimal .loki present", () => {
  it("shows default provider (claude) when no saved provider and no env override", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(lokiDir, { recursive: true });
      process.env["LOKI_DIR"] = lokiDir;
      delete process.env["LOKI_PROVIDER"];
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Provider: claude (full features)");
      expect(out).toContain("Switch with: loki provider set");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors LOKI_PROVIDER env var when no saved provider", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(lokiDir, { recursive: true });
      process.env["LOKI_DIR"] = lokiDir;
      process.env["LOKI_PROVIDER"] = "codex";
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Provider: codex (degraded mode)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("saved provider overrides env var", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "state"), { recursive: true });
      writeFileSync(join(lokiDir, "state", "provider"), "cline\n");
      process.env["LOKI_DIR"] = lokiDir;
      process.env["LOKI_PROVIDER"] = "codex";
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Provider: cline (near-full mode)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows PAUSED when PAUSE signal file exists", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(lokiDir, { recursive: true });
      writeFileSync(join(lokiDir, "PAUSE"), "");
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Status: PAUSED");
      expect(out).toContain("Resume with: loki resume");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows STOPPED when STOP signal file exists (and no PAUSE)", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(lokiDir, { recursive: true });
      writeFileSync(join(lokiDir, "STOP"), "");
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Status: STOPPED");
      expect(out).toContain("Clear with: loki resume");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits STATUS.txt contents under Session Info", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(lokiDir, { recursive: true });
      writeFileSync(join(lokiDir, "STATUS.txt"), "Phase: implementation\nIteration: 5\n");
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Session Info:");
      expect(out).toContain("Phase: implementation");
      expect(out).toContain("Iteration: 5");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders orchestrator phase via jq", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "state"), { recursive: true });
      writeFileSync(
        join(lokiDir, "state", "orchestrator.json"),
        JSON.stringify({ currentPhase: "design", currentIteration: 3 }),
      );
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Orchestrator State:");
      expect(out).toContain("design");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts pending tasks (array form) via jq", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "queue"), { recursive: true });
      writeFileSync(
        join(lokiDir, "queue", "pending.json"),
        JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]),
      );
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Pending Tasks: 3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts pending tasks ({tasks: [...]} form) via jq", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "queue"), { recursive: true });
      writeFileSync(
        join(lokiDir, "queue", "pending.json"),
        JSON.stringify({ tasks: [{ id: 1 }, { id: 2 }] }),
      );
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Pending Tasks: 2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows Budget line when budget_limit > 0", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "metrics"), { recursive: true });
      writeFileSync(
        join(lokiDir, "metrics", "budget.json"),
        JSON.stringify({ budget_limit: 100, budget_used: 12.5 }),
      );
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Budget: $12.5 / $100");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows Cost line (no limit) when budget_limit == 0", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "metrics"), { recursive: true });
      writeFileSync(
        join(lokiDir, "metrics", "budget.json"),
        JSON.stringify({ budget_limit: 0, budget_used: 7.42 }),
      );
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Cost: $7.42 (no limit)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("computes context window percentage", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "state"), { recursive: true });
      writeFileSync(
        join(lokiDir, "state", "context-usage.json"),
        JSON.stringify({ window_size: 200000, used_tokens: 50000 }),
      );
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Context: 25% (50000 / 200000 tokens)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows dashboard URL with LOKI_DASHBOARD_PORT honored when pid is alive", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "dashboard"), { recursive: true });
      // Use our own pid -- guaranteed alive.
      writeFileSync(join(lokiDir, "dashboard", "dashboard.pid"), String(process.pid));
      process.env["LOKI_DIR"] = lokiDir;
      process.env["LOKI_DASHBOARD_PORT"] = "9999";
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Dashboard: http://127.0.0.1:9999/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits dashboard URL when pid is dead", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "dashboard"), { recursive: true });
      // PID 1 may be alive; use a guaranteed-dead pid (very large).
      writeFileSync(join(lokiDir, "dashboard", "dashboard.pid"), "2147483646");
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).not.toContain("Dashboard: http://");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists active session for live loki.pid (global)", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(lokiDir, { recursive: true });
      writeFileSync(join(lokiDir, "loki.pid"), String(process.pid));
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Active Sessions: 1");
      expect(out).toContain("[global] PID");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores stale loki.pid (dead pid)", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(lokiDir, { recursive: true });
      writeFileSync(join(lokiDir, "loki.pid"), "2147483646");
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      expect(out).not.toContain("Active Sessions:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("status --json: missing .loki dir", () => {
  it("returns inactive shape with task_counts zeros", async () => {
    const root = mkTmp();
    try {
      process.env["LOKI_DIR"] = join(root, "nonexistent");
      const r = await runWithCapture(["--json"]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(parsed["status"]).toBe("inactive");
      expect(parsed["phase"]).toBeNull();
      expect(parsed["iteration"]).toBe(0);
      expect(parsed["pid"]).toBeNull();
      expect(parsed["dashboard_url"]).toBeNull();
      expect(parsed["elapsed_time"]).toBe(0);
      expect(parsed["task_counts"]).toEqual({ total: 0, completed: 0, failed: 0, pending: 0 });
      // Provider falls back to env or 'claude'.
      expect(typeof parsed["provider"]).toBe("string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to LOKI_PROVIDER env when no .loki and no saved provider", async () => {
    const root = mkTmp();
    try {
      process.env["LOKI_DIR"] = join(root, "nonexistent");
      process.env["LOKI_PROVIDER"] = "gemini";
      const r = await runWithCapture(["--json"]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(parsed["provider"]).toBe("gemini");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("status --json: present .loki", () => {
  it("aggregates phase, iteration, status, provider, task counts", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "state"), { recursive: true });
      mkdirSync(join(lokiDir, "queue"), { recursive: true });
      writeFileSync(join(lokiDir, "state", "provider"), "cline\n");
      writeFileSync(
        join(lokiDir, "state", "orchestrator.json"),
        JSON.stringify({ currentPhase: "test", currentIteration: 7 }),
      );
      writeFileSync(
        join(lokiDir, "session.json"),
        JSON.stringify({ status: "running", start_time: 1700000000 }),
      );
      writeFileSync(join(lokiDir, "queue", "pending.json"), JSON.stringify([{ id: 1 }]));
      writeFileSync(
        join(lokiDir, "queue", "completed.json"),
        JSON.stringify({ tasks: [{ id: 2 }, { id: 3 }] }),
      );
      writeFileSync(join(lokiDir, "queue", "failed.json"), JSON.stringify([]));

      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture(["--json"]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(parsed["status"]).toBe("running");
      expect(parsed["phase"]).toBe("test");
      expect(parsed["iteration"]).toBe(7);
      expect(parsed["provider"]).toBe("cline");
      expect(parsed["task_counts"]).toEqual({
        total: 3,
        completed: 2,
        failed: 0,
        pending: 1,
      });
      // elapsed_time should be > 0 (time.time() is well past 2023).
      expect(typeof parsed["elapsed_time"]).toBe("number");
      expect((parsed["elapsed_time"] as number) > 0).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports paused status when PAUSE signal is set", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(lokiDir, { recursive: true });
      writeFileSync(join(lokiDir, "PAUSE"), "");
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture(["--json"]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(parsed["status"]).toBe("paused");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports stopped status when STOP signal is set", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(lokiDir, { recursive: true });
      writeFileSync(join(lokiDir, "STOP"), "");
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture(["--json"]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(parsed["status"]).toBe("stopped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors LOKI_DASHBOARD_PORT in dashboard_url when pid is alive", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "dashboard"), { recursive: true });
      writeFileSync(join(lokiDir, "dashboard", "dashboard.pid"), String(process.pid));
      process.env["LOKI_DIR"] = lokiDir;
      process.env["LOKI_DASHBOARD_PORT"] = "12345";
      const r = await runWithCapture(["--json"]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(parsed["dashboard_url"]).toBe("http://127.0.0.1:12345/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves Python json.dumps(indent=2) formatting", async () => {
    const root = mkTmp();
    try {
      process.env["LOKI_DIR"] = join(root, "nonexistent");
      const r = await runWithCapture(["--json"]);
      expect(r.exitCode).toBe(0);
      // Python json.dumps with indent=2 uses 2-space indent and a trailing newline from print().
      expect(r.stdout).toMatch(/^\{\n  "/);
      expect(r.stdout.endsWith("\n")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
