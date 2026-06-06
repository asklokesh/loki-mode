// Tests for the `loki crash` command port (Crash Reporting Phase 0,
// local-only, ZERO network egress).
// Source-of-truth: loki-ts/src/commands/crash.ts.
//
// Hermetic: each test sets LOKI_DIR to a tmpdir so nothing reads the real
// ~/.loki or repo .loki. crashDir() resolves to <LOKI_DIR>/crash. Reports are
// seeded by writing whitelist-only JSON (we never depend on a real crash).
// process.stdout/stderr are monkey-patched per-test because runCrash writes
// directly to them (mirrors the bash route's `echo`).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runCrash } from "../../src/commands/crash.ts";
import { captureCrash } from "../../src/runner/crash.ts";
import { stripAnsi } from "../../src/util/colors.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const RUNNER_CRASH = resolve(REPO_ROOT, "loki-ts", "src", "runner", "crash.ts");
const BASH_CRASH_SH = resolve(REPO_ROOT, "autonomy", "crash.sh");

// Count scrubbed *.json reports in a target dir's .loki/crash.
function crashFileCount(targetDir: string): number {
  const dir = join(targetDir, ".loki", "crash");
  if (!existsSync(dir)) {
    return 0;
  }
  return readdirSync(dir).filter((n) => n.endsWith(".json")).length;
}

// Read the single scrubbed report from a target dir's .loki/crash (or null).
function readSingleReport(targetDir: string): Record<string, unknown> | null {
  const dir = join(targetDir, ".loki", "crash");
  if (!existsSync(dir)) {
    return null;
  }
  const files = readdirSync(dir).filter((n) => n.endsWith(".json"));
  if (files.length === 0) {
    return null;
  }
  return JSON.parse(readFileSync(join(dir, files[0]!), "utf8")) as Record<
    string,
    unknown
  >;
}

type Capture = { stdout: string; stderr: string };

function captureIO(): { restore: () => void; get: () => Capture } {
  const orig = {
    out: process.stdout.write.bind(process.stdout),
    err: process.stderr.write.bind(process.stderr),
  };
  let out = "";
  let err = "";
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

// Opt-out env vars are saved/cleared too: collectionEnabled() (the capture
// gate) reads them, so a stale DO_NOT_TRACK / LOKI_TELEMETRY in the runner's
// environment would silently make the capture-driving tests no-op and break
// their positive controls.
const ENV_KEYS = [
  "LOKI_DIR",
  "DO_NOT_TRACK",
  "LOKI_TELEMETRY",
  "LOKI_TELEMETRY_DISABLED",
  "HOME",
] as const;
let savedEnv: Partial<Record<string, string>> = {};
let workDir = "";

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  workDir = mkdtempSync(join(tmpdir(), "loki-crash-test-"));
  process.env["LOKI_DIR"] = join(workDir, ".loki");
  // Hermetic capture gate: no opt-out, and HOME points at an empty temp dir so
  // collectionEnabled() never reads the real ~/.loki/config.
  delete process.env["DO_NOT_TRACK"];
  delete process.env["LOKI_TELEMETRY"];
  delete process.env["LOKI_TELEMETRY_DISABLED"];
  process.env["HOME"] = join(workDir, "home");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = "";
  }
});

// Seed a whitelist-only scrubbed report into <LOKI_DIR>/crash. Returns the
// fingerprint so tests can resolve it.
function seedReport(overrides: Record<string, unknown> = {}): {
  fingerprint: string;
  filename: string;
} {
  const fingerprint =
    (overrides["fingerprint"] as string | undefined) ??
    "abc123def456abc123def456abc123def456abc123def456abc123def456abcd";
  const report = {
    os: "Darwin",
    arch: "arm64",
    loki_version: "7.18.0",
    error_class: "TypeError",
    stack_signature: ["handler", "run"],
    rarv_phase: "act",
    exit_code: 1,
    fingerprint,
    project_id_hash: "deadbeef",
    rules_version: "1.0",
    redactions_count: 2,
    captured_at: "2026-06-06T00:00:00Z",
    ...overrides,
  };
  const dir = join(process.env["LOKI_DIR"]!, "crash");
  mkdirSync(dir, { recursive: true });
  const filename = `${fingerprint}-1717632000`;
  writeFileSync(join(dir, `${filename}.json`), JSON.stringify(report, null, 2));
  return { fingerprint, filename };
}

async function runWithCapture(
  argv: readonly string[],
): Promise<Capture & { exitCode: number }> {
  const cap = captureIO();
  let exitCode: number;
  try {
    exitCode = await runCrash(argv);
  } finally {
    cap.restore();
  }
  return { ...cap.get(), exitCode };
}

describe("crash: empty", () => {
  it("prints the empty message and returns 0 when .loki/crash is absent", async () => {
    const r = await runWithCapture([]);
    expect(r.exitCode).toBe(0);
    expect(stripAnsi(r.stdout)).toContain("No crash reports found.");
  });
});

describe("crash: list", () => {
  it("lists a seeded scrubbed report", async () => {
    const { fingerprint } = seedReport();
    const r = await runWithCapture([]);
    expect(r.exitCode).toBe(0);
    const out = stripAnsi(r.stdout);
    expect(out).toContain("ERROR_CLASS");
    expect(out).toContain(fingerprint);
    expect(out).toContain("TypeError");
    expect(out).toContain("1 report(s).");
  });
});

describe("crash: show", () => {
  it("pretty-prints one report resolved by fingerprint", async () => {
    const { fingerprint } = seedReport();
    const r = await runWithCapture(["show", fingerprint]);
    expect(r.exitCode).toBe(0);
    const out = stripAnsi(r.stdout);
    // Pretty-printed JSON containing the whitelisted fields.
    expect(out).toContain(`"error_class": "TypeError"`);
    expect(out).toContain(`"fingerprint": "${fingerprint}"`);
    // The report must be whitelist-only: no free-text fields leak in.
    expect(out).not.toContain("message");
    expect(out).not.toContain("prompt");
  });

  it("returns nonzero for a missing id", async () => {
    seedReport();
    const r = await runWithCapture(["show", "no-such-id"]);
    expect(r.exitCode).not.toBe(0);
    expect(stripAnsi(r.stderr)).toContain("Crash report not found");
  });

  it("returns 2 when no id is given", async () => {
    const r = await runWithCapture(["show"]);
    expect(r.exitCode).toBe(2);
    expect(stripAnsi(r.stderr)).toContain("Missing crash id.");
  });
});

describe("crash: submit", () => {
  it("prints the prefilled GitHub issue URL and states nothing is sent", async () => {
    const { fingerprint } = seedReport();
    const r = await runWithCapture(["submit", fingerprint]);
    expect(r.exitCode).toBe(0);
    const out = stripAnsi(r.stdout);
    // Prefilled issue URL points at the canonical repo new-issue endpoint.
    expect(out).toContain("https://github.com/asklokesh/loki-mode/issues/new");
    // The URL is prefilled with title + body params.
    expect(out).toContain("title=");
    expect(out).toContain("body=");
    // It must clearly state nothing is transmitted automatically.
    expect(out).toContain("Nothing is sent automatically");
    // The whole scrubbed payload is shown so the user can review it.
    expect(out).toContain(`"fingerprint": "${fingerprint}"`);
  });

  it("defaults to the most recent report when no id is given", async () => {
    seedReport({ fingerprint: "1111111111111111111111111111111111111111111111111111111111111111" });
    seedReport({ fingerprint: "2222222222222222222222222222222222222222222222222222222222222222" });
    const r = await runWithCapture(["submit"]);
    expect(r.exitCode).toBe(0);
    expect(stripAnsi(r.stdout)).toContain(
      "https://github.com/asklokesh/loki-mode/issues/new",
    );
  });

  it("reports nothing to submit when there are no reports", async () => {
    const r = await runWithCapture(["submit"]);
    expect(r.exitCode).toBe(0);
    expect(stripAnsi(r.stdout)).toContain("Nothing to submit.");
  });
});

// ===========================================================================
// DEFECT 2: path traversal. `crash show/submit <traversal>` must exit nonzero
// and print NONE of an external file's contents. crashDir() is <LOKI_DIR>/crash
// and the id is joined as crashDir/<id>.json, so `../../pwn` resolves to
// <workDir>/pwn.json -- seed the bait THERE so the test is non-vacuous (if the
// isSafeId guard were removed, the marker WOULD leak). Legit lookups by
// fingerprint AND by filename-id must still work (positive controls).
// ===========================================================================
const PWN_MARKER = "PWNED_SECRET_MARKER_TS_7c1d";

describe("crash: path traversal guard (defect 2)", () => {
  function seedBaitAndLegit(): { fingerprint: string; filename: string } {
    // Bait at <workDir>/pwn.json (where ../../pwn.json resolves from crashDir).
    writeFileSync(join(workDir, "pwn.json"), JSON.stringify({ secret: PWN_MARKER }));
    // A legit scrubbed report so positive controls have something to find.
    return seedReport({
      fingerprint: "legitfp00000000000000000000000000000000000000000000000000000000",
    });
  }

  const vectors = ["../../pwn", "../../../etc/hosts", "..\\..\\pwn"];

  for (const vec of vectors) {
    it(`show '${vec}' exits nonzero and leaks no external file`, async () => {
      seedBaitAndLegit();
      const r = await runWithCapture(["show", vec]);
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout + r.stderr).not.toContain(PWN_MARKER);
    });
  }

  it("submit '../../pwn' exits nonzero and leaks no external file", async () => {
    seedBaitAndLegit();
    const r = await runWithCapture(["submit", "../../pwn"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).not.toContain(PWN_MARKER);
  });

  it("legit show by fingerprint still works (positive control)", async () => {
    const { fingerprint } = seedBaitAndLegit();
    const r = await runWithCapture(["show", fingerprint]);
    expect(r.exitCode).toBe(0);
    expect(stripAnsi(r.stdout)).toContain(`"fingerprint": "${fingerprint}"`);
  });

  it("legit show by filename-id still works (positive control)", async () => {
    const { filename } = seedBaitAndLegit();
    const r = await runWithCapture(["show", filename]);
    expect(r.exitCode).toBe(0);
    expect(stripAnsi(r.stdout)).toContain(`"error_class": "TypeError"`);
  });
});

// ===========================================================================
// DEFECT 1: stack/fingerprint parity. The TS argv path (captureCrash ->
// buildCrashArgs -> crash_capture.py) and the REAL bash helper
// (loki_crash_capture, stdin path) must produce the SAME fingerprint for an
// identical (error_class, stack). Paths differ on purpose to prove path
// normalization keeps the two routes equal.
// ===========================================================================
describe("crash: bash/TS fingerprint parity (defect 1)", () => {
  it("captureCrash (TS argv) and loki_crash_capture (bash stdin) agree", async () => {
    // TS side: drive the exported captureCrash, which uses buildCrashArgs and
    // the shared python scrubber. Stack passed as one argv string with
    // newlines (mirrors the uncaughtException err.stack shape).
    const tsTarget = join(workDir, "ts");
    mkdirSync(tsTarget, { recursive: true });
    const tsStack =
      "at handler (/Users/jdoe/src/app.ts:10:5)\nat run (/Users/jdoe/src/run.ts:20:7)";
    await captureCrash({
      errorClass: "TypeError",
      message: "boom message",
      stack: tsStack,
      exitCode: 1,
      targetDir: tsTarget,
    });
    const tsReport = readSingleReport(tsTarget);

    // Bash side: drive the REAL loki_crash_capture helper via its stdin path,
    // with a DIFFERENT home path (alice) to prove path-independence.
    const bashTarget = join(workDir, "bash");
    mkdirSync(bashTarget, { recursive: true });
    const bashStack =
      "at handler (/home/alice/src/app.ts:10:5)\nat run (/home/alice/src/run.ts:20:7)";
    const script =
      `. "${BASH_CRASH_SH}"; ` +
      `loki_crash_capture "TypeError" "boom message" "$LOKI_TEST_STACK" "act" "1"`;
    spawnSync("bash", ["-c", script], {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: join(workDir, "home"),
        TARGET_DIR: bashTarget,
        LOKI_TEST_STACK: bashStack,
      },
      stdio: "ignore",
    });
    const bashReport = readSingleReport(bashTarget);

    // Both routes must have written a report.
    expect(tsReport).not.toBeNull();
    expect(bashReport).not.toBeNull();
    // Non-empty symbol signature is the exact thing the original defect broke.
    expect(tsReport!["stack_signature"]).toEqual(["handler", "run"]);
    expect(bashReport!["stack_signature"]).toEqual(["handler", "run"]);
    // And the fingerprints must match across routes (path-independent).
    expect(tsReport!["fingerprint"]).toBe(bashReport!["fingerprint"] as string);
  });
});

// ===========================================================================
// DEFECT 3: opt-out gates the TS captureCrashSync exit path. A real
// uncaughtException probe (installCrashHandlers + throw) writes a scrubbed file
// to cwd/.loki/crash UNLESS the unified opt-out is set. The handler exits 1 by
// design, so we assert on file presence/absence, not the exit code.
// ===========================================================================
describe("crash: opt-out gates captureCrashSync (defect 3)", () => {
  // Build a probe script that installs the crash handlers then throws, so the
  // uncaughtException -> captureCrashSync path runs. captureCrashSync uses no
  // targetDir, so it writes to cwd/.loki/crash; the probe is spawned with cwd
  // set to a temp dir.
  function runProbe(extraEnv: Record<string, string>): string {
    const probeDir = mkdtempSync(join(tmpdir(), "loki-crash-probe-"));
    const probe = join(probeDir, "probe.ts");
    writeFileSync(
      probe,
      `import { installCrashHandlers } from ${JSON.stringify(RUNNER_CRASH)};\n` +
        `installCrashHandlers();\n` +
        `throw new Error("boom probe");\n`,
    );
    spawnSync("bun", [probe], {
      cwd: probeDir,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: join(probeDir, "home"),
        ...extraEnv,
      },
      stdio: "ignore",
    });
    return probeDir;
  }

  it("writes a crash file on uncaughtException when opt-out is unset (control)", () => {
    const dir = runProbe({});
    try {
      expect(crashFileCount(dir)).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes NO crash file when DO_NOT_TRACK=1", () => {
    const dir = runProbe({ DO_NOT_TRACK: "1" });
    try {
      expect(crashFileCount(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes NO crash file when LOKI_TELEMETRY=off", () => {
    const dir = runProbe({ LOKI_TELEMETRY: "off" });
    try {
      expect(crashFileCount(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
