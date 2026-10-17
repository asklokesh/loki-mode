// Tests for the status command port.
// Source-of-truth: autonomy/loki:1963 (cmd_status), :2124 (cmd_status_json).
//
// Hermetic: each test creates a tmpdir for LOKI_DIR; nothing reads the real
// ~/.loki or repo .loki. process.stdout/stderr are monkey-patched per-test
// because runStatus writes directly to them (mirrors bash's `echo`).

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { runStatus } from "../../src/commands/status.ts";
import { stripAnsi, RED } from "../../src/util/colors.ts";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
    expect(r.stdout).toContain("Usage: loki status [--json|--badge|--probe]");
  });

  it("accepts -h alias", async () => {
    const r = await runWithCapture(["-h"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage: loki status [--json|--badge|--probe]");
  });
});

describe("status: unknown flag", () => {
  it("rejects unknown flags with exit 1", async () => {
    const r = await runWithCapture(["--bogus"]);
    expect(r.exitCode).toBe(1);
    expect(stripAnsi(r.stdout)).toContain("Unknown flag: --bogus");
    expect(r.stdout).toContain("Usage: loki status [--json|--badge|--probe]");
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

  it("renders a saved opencode selection with truthful capability", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "state"), { recursive: true });
      writeFileSync(join(lokiDir, "state", "provider"), "opencode\n");
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      expect(stripAnsi(r.stdout)).toContain("Provider: opencode (model-agnostic mode)");
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

  it("shows Budget line + visual gauge when budget_limit > 0", async () => {
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
      // Plain data line (unchanged) ...
      expect(out).toContain("Budget: $12.5 / $100");
      // ... PLUS the visual gauge (context_gauge port -- parity with the bash
      // route, which sources tui.sh and always renders this bar). 12.5/100 ->
      // 1250c / 10000c = 12% over a width-30 "=" bar (3 filled cells); tokens
      // formatted 1.2K / 10.0K (format_tokens). Byte-for-byte verified against
      // `bash autonomy/loki status`.
      expect(out).toContain("  Budget [===                           ] 12% (1.2K / 10.0K)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("colors the budget gauge red at >= 80% and matches bash bar/format", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "metrics"), { recursive: true });
      writeFileSync(
        join(lokiDir, "metrics", "budget.json"),
        JSON.stringify({ budget_limit: 50, budget_used: 48 }),
      );
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      // 48/50 = 96% -> 28 filled cells, red color branch.
      expect(stripAnsi(r.stdout)).toContain(
        "  Budget [============================  ] 96% (4.8K / 5.0K)",
      );
      // Confirm the RED color precedes the bar (color-branch coverage).
      // Assert against the RED constant rather than a hard-coded escape so the
      // test holds under NO_COLOR (where colors.ts resolves RED to "" at module
      // load time -- a raw-escape assertion would falsely fail there).
      const budgetLineRaw = r.stdout
        .split("\n")
        .find((l) => stripAnsi(l).includes("Budget [")) as string | undefined;
      expect(budgetLineRaw).toBeDefined();
      if (RED !== "") {
        expect(budgetLineRaw as string).toContain(RED);
      }
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

  it("renders the context window as a visual gauge (parity with bash)", async () => {
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
      // context_gauge port REPLACES the old plain "Context: 25% (...)" line, to
      // match the bash route (autonomy/loki:2930 always takes the gauge branch
      // because tui.sh is sourced). 50000/200000 = 25% -> 7 filled "=" cells of
      // 30; tokens 50.0K / 200.0K. Byte-for-byte verified against bash.
      expect(out).toContain("  Context [=======                       ] 25% (50.0K / 200.0K)");
      // The old plain wording must no longer appear (it was the dead bash else).
      expect(out).not.toContain("Context: 25% (50000 / 200000 tokens)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits the context gauge entirely when window_size is 0 (bash early-out)", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "state"), { recursive: true });
      writeFileSync(
        join(lokiDir, "state", "context-usage.json"),
        JSON.stringify({ window_size: 0, used_tokens: 1000 }),
      );
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture([]);
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout);
      // tui.sh context_gauge does `if total -eq 0; then return; fi` -> nothing.
      expect(out).not.toContain("Context [");
      expect(out).not.toContain("Context:");
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
      process.env["LOKI_PROVIDER"] = "codex";
      const r = await runWithCapture(["--json"]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(parsed["provider"]).toBe("codex");
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

// v7.5.5 (#204): Phase 1 (RARV-C closure) artifact summary in --json output.
describe("status --json: phase1 artifact summary", () => {
  it("returns zeroed phase1 block when .loki is missing", async () => {
    const root = mkTmp();
    try {
      process.env["LOKI_DIR"] = join(root, "nonexistent");
      const r = await runWithCapture(["--json"]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(parsed["phase1"]).toEqual({
        findings_iters: 0,
        learnings_count: 0,
        escalations_count: 0,
        pause_signal: false,
        gate_failure_counts: {},
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts findings, learnings, escalations, pause, gate counts", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "state"), { recursive: true });
      mkdirSync(join(lokiDir, "escalations"), { recursive: true });
      mkdirSync(join(lokiDir, "quality"), { recursive: true });
      writeFileSync(join(lokiDir, "state", "findings-1.json"), "{}");
      writeFileSync(join(lokiDir, "state", "findings-2.json"), "{}");
      writeFileSync(join(lokiDir, "state", "findings-3.json"), "{}");
      writeFileSync(
        join(lokiDir, "state", "relevant-learnings.json"),
        JSON.stringify([{ id: "a" }, { id: "b" }]),
      );
      writeFileSync(join(lokiDir, "escalations", "2026-04-28-x.md"), "x");
      writeFileSync(join(lokiDir, "escalations", "2026-04-28-y.md"), "y");
      writeFileSync(join(lokiDir, "escalations", "ignore.txt"), "noise");
      writeFileSync(join(lokiDir, "PAUSE"), "");
      writeFileSync(
        join(lokiDir, "quality", "gate-failure-count.json"),
        JSON.stringify({ static_analysis: 2, code_review: 5 }),
      );
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture(["--json"]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      const p1 = parsed["phase1"] as Record<string, unknown>;
      expect(p1["findings_iters"]).toBe(3);
      expect(p1["learnings_count"]).toBe(2);
      expect(p1["escalations_count"]).toBe(2);
      expect(p1["pause_signal"]).toBe(true);
      expect(p1["gate_failure_counts"]).toEqual({
        static_analysis: 2,
        code_review: 5,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports {entries: [...]} learnings shape", async () => {
    const root = mkTmp();
    try {
      const lokiDir = join(root, ".loki");
      mkdirSync(join(lokiDir, "state"), { recursive: true });
      writeFileSync(
        join(lokiDir, "state", "relevant-learnings.json"),
        JSON.stringify({ entries: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
      );
      process.env["LOKI_DIR"] = lokiDir;
      const r = await runWithCapture(["--json"]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      const p1 = parsed["phase1"] as Record<string, unknown>;
      expect(p1["learnings_count"]).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("status: text mode -- last deploy", () => {
  function deployFixture(rec: Record<string, unknown> | null): { root: string } {
    const root = mkTmp();
    const lokiDir = join(root, ".loki");
    mkdirSync(join(lokiDir, "deploys"), { recursive: true });
    if (rec) writeFileSync(join(lokiDir, "deploys", "20261016T000000Z-1.json"), JSON.stringify(rec));
    process.env["LOKI_DIR"] = lokiDir;
    return { root };
  }

  it("prints the newest deploy, flags FAILED_HEALTH and reports an unsigned record as UNCHECKED", async () => {
    const { root } = deployFixture({
      schema: "loki.deploy/1", target: "vercel", head_sha: "abcdef1234567890", health_status: "FAILED_HEALTH",
      rollback_attempted: true, rollback_exit: 0, post_rollback_health: "healthy", receipt_sha256: "x",
    });
    try {
      const r = await runWithCapture([]);
      const out = stripAnsi(r.stdout);
      expect(out).toContain("Last deploy: vercel at abcdef123456");
      expect(out).toContain("health FAILED_HEALTH");
      expect(out).toContain("rolled back (service healthy)");
      expect(out).toContain("record UNCHECKED");
      expect(out).toContain("UNHEALTHY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints nothing about deploys when there are none", async () => {
    const { root } = deployFixture(null);
    try {
      expect(stripAnsi((await runWithCapture([])).stdout)).not.toContain("Last deploy");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("status --badge: verified deploy badge", () => {
  const URL = "https://app.example.com";
  const KEYS = ["LOKI_RECEIPT_SIGNING_KEY_FILE", "LOKI_RECEIPT_SIGNING_KEY"];
  let savedKeys: Array<string | undefined> = [];
  beforeEach(() => { savedKeys = KEYS.map((k) => process.env[k]); });
  afterEach(() => {
    KEYS.forEach((k, i) => { if (savedKeys[i] === undefined) delete process.env[k]; else process.env[k] = savedKeys[i]; });
  });
  async function badgeFixture(extra: Record<string, unknown>, sign = true): Promise<string> {
    const root = mkTmp();
    const lokiDir = join(root, ".loki");
    mkdirSync(join(lokiDir, "deploys"), { recursive: true });
    const keyFile = join(root, "key.pem");
    delete process.env["LOKI_RECEIPT_SIGNING_KEY"];
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = keyFile;
    {
      const { canonicalJson, signReceipt } = await import("../../src/util/receipt_signer.ts");
      const { createHash } = await import("node:crypto");
      const { main } = await import("../../src/engine10/verify_cmd.ts");
      const body = { schema: "proof/1", run_id: "p1", verdict: "pass" };
      const hash = createHash("sha256").update(canonicalJson(body)).digest("hex");
      mkdirSync(join(lokiDir, "proofs", "p1"), { recursive: true });
      writeFileSync(join(lokiDir, "proofs", "p1", "proof.json"), JSON.stringify({ ...body, verification: { hash, attestation: signReceipt("p1", hash).jwt } }));
      const rec = join(lokiDir, "deploys", "20261016T000000Z-1.json");
      writeFileSync(rec, JSON.stringify({ schema: "loki.deploy/1", receipt_sha256: hash, head_sha: "abc123", target: "vercel", command: "vercel --prod", health_status: "HEALTHY", health_url: "http://x/ok", rollback_attempted: false, rollback_exit: null, started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:05Z", ...extra }));
      if (sign) {
        const w = process.stdout.write.bind(process.stdout);
        process.stdout.write = (() => true) as typeof process.stdout.write;
        try { await main(["--sign-deploy", rec]); } finally { process.stdout.write = w; }
      }
    }
    process.env["LOKI_DIR"] = lokiDir;
    return root;
  }
  async function badge(extra: Record<string, unknown>, sign = true): Promise<string> {
    const root = await badgeFixture(extra, sign);
    try {
      const r = await runWithCapture(["--badge"]);
      expect(r.exitCode).toBe(0);
      return stripAnsi(r.stdout);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("signed healthy record with live_binding=VERIFIED prints a green linked badge", async () => {
    const out = await badge({ deployed_url: URL, live_binding: "VERIFIED" });
    expect(out).toContain("brightgreen");
    expect(out).toContain(`${URL}/.well-known/loki-provenance.json`);
  });
  it("FAILED_HEALTH gives a red badge", async () => {
    const out = await badge({ deployed_url: URL, live_binding: "VERIFIED", health_status: "FAILED_HEALTH" });
    expect(out).toContain("-red");
    expect(out).not.toContain("brightgreen");
  });
  it("tampered record gives a red badge", async () => {
    const root = await badgeFixture({ deployed_url: URL, live_binding: "VERIFIED" });
    try {
      const f = join(root, ".loki", "deploys", "20261016T000000Z-1.json");
      writeFileSync(f, readFileSync(f, "utf-8").replace("vercel", "evil"));
      const out = stripAnsi((await runWithCapture(["--badge"])).stdout);
      expect(out).toContain("-red");
      expect(out).not.toContain("brightgreen");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("unsigned record omits the badge with a reason", async () => {
    const out = await badge({ deployed_url: URL, live_binding: "VERIFIED" }, false);
    expect(out).not.toContain("brightgreen");
    expect(out).toContain("No deploy badge");
  });
  it("missing live_binding omits the badge", async () => {
    const out = await badge({ deployed_url: URL });
    expect(out).not.toContain("brightgreen");
    expect(out).toContain("live_binding");
  });
  it("missing deployed_url omits the badge", async () => {
    const out = await badge({ live_binding: "VERIFIED" });
    expect(out).not.toContain("shields.io");
    expect(out).toContain("deployed_url");
  });
});

describe("status --probe: re-probe last deploy health URL", () => {
  let server: ReturnType<typeof Bun.serve>;
  let root = "";
  let savedDir: string | undefined;
  let savedTimeout: string | undefined;
  let savedRetry: string | undefined;
  let flakyHits = 0;
  beforeEach(() => {
    savedDir = process.env["LOKI_DIR"];
    savedTimeout = process.env["LOKI_STATUS_PROBE_TIMEOUT_MS"];
    savedRetry = process.env["LOKI_STATUS_PROBE_RETRY_DELAY_MS"];
    process.env["LOKI_STATUS_PROBE_RETRY_DELAY_MS"] = "50";
    flakyHits = 0;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/flaky") return ++flakyHits === 1 ? new Response("cold", { status: 503 }) : new Response("ok");
        if (p === "/ok") return new Response("ok");
        if (p === "/redirect") return new Response(null, { status: 302, headers: { location: "/ok" } });
        if (p === "/slow") return new Promise<Response>((r) => setTimeout(() => r(new Response("late")), 3000));
        return new Response("boom", { status: 500 });
      },
    });
  });
  afterEach(() => {
    server.stop(true);
    if (savedDir === undefined) delete process.env["LOKI_DIR"]; else process.env["LOKI_DIR"] = savedDir;
    if (savedTimeout === undefined) delete process.env["LOKI_STATUS_PROBE_TIMEOUT_MS"]; else process.env["LOKI_STATUS_PROBE_TIMEOUT_MS"] = savedTimeout;
    if (savedRetry === undefined) delete process.env["LOKI_STATUS_PROBE_RETRY_DELAY_MS"]; else process.env["LOKI_STATUS_PROBE_RETRY_DELAY_MS"] = savedRetry;
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });
  function fixture(rec: Record<string, unknown> | null): void {
    root = mkdtempSync(join(tmpdir(), "status-probe-"));
    const lokiDir = join(root, ".loki");
    mkdirSync(join(lokiDir, "deploys"), { recursive: true });
    if (rec !== null) writeFileSync(join(lokiDir, "deploys", "20261016T000000Z-1.json"), JSON.stringify({ schema: "loki.deploy/1", target: "vercel", head_sha: "abc123", health_status: "HEALTHY", ...rec }));
    process.env["LOKI_DIR"] = lokiDir;
  }
  const url = (path: string): string => `http://127.0.0.1:${server.port}${path}`;

  it("healthy URL exits 0", async () => {
    fixture({ health_url: url("/ok") });
    const r = await runWithCapture(["--probe"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Deploy health OK");
  });
  it("redirect to a healthy URL exits 0", async () => {
    fixture({ health_url: url("/redirect") });
    expect((await runWithCapture(["--probe"])).exitCode).toBe(0);
  });
  it("a 500 exits 1 naming the URL and status", async () => {
    fixture({ health_url: url("/down") });
    const r = await runWithCapture(["--probe"]);
    expect(r.exitCode).toBe(1);
    const out = stripAnsi(r.stdout);
    expect(out).toContain(url("/down"));
    expect(out).toContain("returned 500");
  });
  it("first 503 then 200 retries and exits 0, retry visible", async () => {
    fixture({ health_url: url("/flaky") });
    const r = await runWithCapture(["--probe"]);
    expect(r.exitCode).toBe(0);
    expect(flakyHits).toBe(2);
    const out = stripAnsi(r.stdout);
    expect(out).toContain("retrying once");
    expect(out).toContain("returned 503");
    expect(out).toContain("Deploy health OK");
  });
  it("two failures exit 1 after exactly one retry", async () => {
    fixture({ health_url: url("/down") });
    const r = await runWithCapture(["--probe"]);
    expect(r.exitCode).toBe(1);
    const out = stripAnsi(r.stdout);
    expect(out.match(/retrying once/g)?.length).toBe(1);
    expect(out).toContain("Deploy health REGRESSED");
  });
  it("a timeout exits 1 naming the URL", async () => {
    fixture({ health_url: url("/slow") });
    process.env["LOKI_STATUS_PROBE_TIMEOUT_MS"] = "200";
    const r = await runWithCapture(["--probe"]);
    expect(r.exitCode).toBe(1);
    expect(stripAnsi(r.stdout)).toContain("timed out after 200ms");
    expect(stripAnsi(r.stdout)).toContain(url("/slow"));
  });
  it("unreachable URL exits 1", async () => {
    fixture({ health_url: "http://127.0.0.1:1/x" });
    expect((await runWithCapture(["--probe"])).exitCode).toBe(1);
  });
  it("no deploy record exits 0 with a note", async () => {
    fixture(null);
    const r = await runWithCapture(["--probe"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no deploy record");
  });
  it("record without health_url exits 0 with a note", async () => {
    fixture({});
    const r = await runWithCapture(["--probe"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no health URL");
  });
});
