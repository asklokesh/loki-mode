#!/usr/bin/env bun
/**
 * check-phase6-ready.ts
 *
 * Auto-graduation gate for Phase 6 (v8.0.0 sunset of bash). Exits 0 if
 * every criterion in loki-ts/docs/phase6-readiness-checklist.md passes,
 * non-zero otherwise with a per-failure "NOT READY: ..." reason.
 *
 * Run: bun run scripts/check-phase6-ready.ts
 *
 * No arguments. Reads repo state under cwd's parent if invoked from
 * loki-ts/, otherwise from cwd.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

interface GateResult {
  readonly name: string;
  readonly passed: boolean;
  readonly reason: string;
}

const REPO_ROOT: string = (() => {
  // If invoked from loki-ts/, walk up one level. Otherwise assume cwd is repo root.
  const cwd = process.cwd();
  if (cwd.endsWith("/loki-ts")) return resolve(cwd, "..");
  if (existsSync(join(cwd, "loki-ts"))) return cwd;
  // Last resort: ask git.
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return cwd;
  }
})();

const SOAK_DAYS_REQUIRED: number = 30;
const PHASE5_MIN_TAG: string = "v7.5.0";

function fileExists(rel: string): boolean {
  return existsSync(join(REPO_ROOT, rel));
}

function safeReadLines(rel: string): readonly string[] {
  const path = join(REPO_ROOT, rel);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function safeReaddir(rel: string): readonly string[] {
  const path = join(REPO_ROOT, rel);
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function gitTagDateEpoch(tag: string): number | null {
  try {
    const out = execSync(`git log -1 --format=%ct ${tag}`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function hasGitTag(tag: string): boolean {
  try {
    execSync(`git rev-parse --verify --quiet refs/tags/${tag}`, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function listMatchingTags(prefix: string): readonly string[] {
  try {
    return execSync(`git tag -l '${prefix}*'`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

// ---------- Gates ----------

function gatePhase5TagExists(): GateResult {
  // Accept any v7.5.x or higher 7.x tag.
  const tags = listMatchingTags("v7.");
  const ok = tags.some((t) => {
    const m = /^v7\.(\d+)\.(\d+)$/.exec(t);
    if (!m) return false;
    const minor = Number.parseInt(m[1] ?? "0", 10);
    return minor >= 5;
  });
  return {
    name: "phase5-release-tag-exists",
    passed: ok,
    reason: ok
      ? `found Phase-5+ tag (>= ${PHASE5_MIN_TAG})`
      : `no v7.5.x or higher 7.x tag found; current tags: ${tags.join(", ") || "(none in v7.x)"}`,
  };
}

function gatePhase5ModulesExist(): GateResult {
  const required: readonly string[] = [
    "loki-ts/src/runner/completion.ts",
    "loki-ts/src/runner/council.ts",
    "loki-ts/src/runner/providers.ts",
    "loki-ts/src/runner/quality_gates.ts",
    "loki-ts/src/runner/queues.ts",
  ];
  const missing = required.filter((p) => !fileExists(p));
  return {
    name: "phase5-modules-on-disk",
    passed: missing.length === 0,
    reason:
      missing.length === 0
        ? `all ${required.length} Phase 5 modules present`
        : `missing modules: ${missing.join(", ")}`,
  };
}

function gateBashStillPresent(): GateResult {
  // Sanity: if bash files are already deleted, Phase 6 already happened.
  const sentinels: readonly string[] = [
    "autonomy/loki",
    "autonomy/run.sh",
    "autonomy/completion-council.sh",
  ];
  const missing = sentinels.filter((p) => !fileExists(p));
  return {
    name: "bash-files-present-for-deletion",
    passed: missing.length === 0,
    reason:
      missing.length === 0
        ? "bash entry points present; deletion will be meaningful"
        : `bash files already gone (${missing.join(", ")}); v8.0.0 may already be partially shipped`,
  };
}

function gateSoakWindowElapsed(): GateResult {
  // Find earliest Phase-5+ tag and ensure now - tag_date >= 30 days.
  const tags = listMatchingTags("v7.").filter((t) => /^v7\.(\d+)\.\d+$/.test(t));
  const phase5Tags = tags.filter((t) => {
    const m = /^v7\.(\d+)\.\d+$/.exec(t);
    if (!m) return false;
    return Number.parseInt(m[1] ?? "0", 10) >= 5;
  });
  if (phase5Tags.length === 0) {
    return {
      name: "30-day-soak-elapsed",
      passed: false,
      reason: "no Phase-5+ tag found, soak clock has not started",
    };
  }
  const epochs = phase5Tags
    .map((t) => gitTagDateEpoch(t))
    .filter((e): e is number => e !== null);
  if (epochs.length === 0) {
    return {
      name: "30-day-soak-elapsed",
      passed: false,
      reason: "could not resolve any Phase-5 tag date via git log",
    };
  }
  const earliest = Math.min(...epochs);
  const nowSec = Math.floor(Date.now() / 1000);
  const daysElapsed = Math.floor((nowSec - earliest) / 86400);
  return {
    name: "30-day-soak-elapsed",
    passed: daysElapsed >= SOAK_DAYS_REQUIRED,
    reason:
      daysElapsed >= SOAK_DAYS_REQUIRED
        ? `${daysElapsed} days since Phase 5 tag`
        : `only ${daysElapsed} of ${SOAK_DAYS_REQUIRED} soak days elapsed`,
  };
}

interface ManagedEvent {
  readonly timestamp?: number;
  readonly legacy_bash?: boolean;
  readonly parity_failure?: boolean;
}

function readManagedEvents(): readonly ManagedEvent[] {
  const lines = safeReadLines(".loki/managed/events.ndjson");
  const out: ManagedEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        out.push(parsed as ManagedEvent);
      }
    } catch {
      // Skip malformed line; do not throw.
    }
  }
  return out;
}

function gateZeroLegacyBashInWindow(): GateResult {
  if (!fileExists(".loki/managed/events.ndjson")) {
    return {
      name: "zero-legacy-bash-invocations",
      passed: false,
      reason: ".loki/managed/events.ndjson not found; soak telemetry pipeline not deployed",
    };
  }
  const cutoff = Math.floor(Date.now() / 1000) - SOAK_DAYS_REQUIRED * 86400;
  const events = readManagedEvents();
  const hits = events.filter(
    (e) => (e.timestamp ?? 0) >= cutoff && e.legacy_bash === true
  ).length;
  return {
    name: "zero-legacy-bash-invocations",
    passed: hits === 0,
    reason: hits === 0
      ? "no LOKI_LEGACY_BASH=true invocations in 30-day window"
      : `${hits} LOKI_LEGACY_BASH=true invocations in 30-day window`,
  };
}

function gateZeroParityFailures(): GateResult {
  if (!fileExists(".loki/managed/events.ndjson")) {
    return {
      name: "zero-parity-failures",
      passed: false,
      reason: ".loki/managed/events.ndjson not found; cannot verify parity",
    };
  }
  const cutoff = Math.floor(Date.now() / 1000) - SOAK_DAYS_REQUIRED * 86400;
  const events = readManagedEvents();
  const hits = events.filter(
    (e) => (e.timestamp ?? 0) >= cutoff && e.parity_failure === true
  ).length;
  return {
    name: "zero-parity-failures",
    passed: hits === 0,
    reason: hits === 0
      ? "no parity_failure=true events in 30-day window"
      : `${hits} parity_failure=true events in 30-day window`,
  };
}

interface BenchRecord {
  readonly speedup?: number;
  readonly timestamp?: number | string;
}

function readBenchRecords(rel: string): readonly BenchRecord[] {
  const lines = safeReadLines(rel);
  const out: BenchRecord[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        out.push(parsed as BenchRecord);
      }
    } catch {
      // Skip malformed line.
    }
  }
  return out;
}

function gateBunNeverSlower(): GateResult {
  const recs = readBenchRecords(".loki/metrics/migration_bench.jsonl");
  if (recs.length === 0) {
    return {
      name: "bun-never-slower-than-bash",
      passed: false,
      reason: "no .loki/metrics/migration_bench.jsonl records found",
    };
  }
  const regressions = recs.filter((r) => typeof r.speedup === "number" && r.speedup < 1.0);
  return {
    name: "bun-never-slower-than-bash",
    passed: regressions.length === 0,
    reason: regressions.length === 0
      ? `min speedup >= 1.0 across ${recs.length} bench records`
      : `${regressions.length} bench records show Bun slower than bash`,
  };
}

function gateSoakContinuity(): GateResult {
  const recs = readBenchRecords(".loki/metrics/migration_bench_soak.jsonl");
  if (recs.length === 0) {
    return {
      name: "soak-data-continuity",
      passed: false,
      reason: "no .loki/metrics/migration_bench_soak.jsonl records found",
    };
  }
  const days = new Set<string>();
  for (const r of recs) {
    let epoch: number | null = null;
    if (typeof r.timestamp === "number") {
      // jsonl stores epoch seconds for soak file
      epoch = r.timestamp > 1e12 ? Math.floor(r.timestamp / 1000) : r.timestamp;
    } else if (typeof r.timestamp === "string") {
      const t = Date.parse(r.timestamp);
      if (Number.isFinite(t)) epoch = Math.floor(t / 1000);
    }
    if (epoch !== null) {
      const d = new Date(epoch * 1000).toISOString().slice(0, 10);
      days.add(d);
    }
  }
  return {
    name: "soak-data-continuity",
    passed: days.size >= SOAK_DAYS_REQUIRED,
    reason: days.size >= SOAK_DAYS_REQUIRED
      ? `${days.size} distinct soak days with bench data`
      : `only ${days.size} of ${SOAK_DAYS_REQUIRED} distinct soak days have bench data`,
  };
}

function countFiles(rel: string, matcher: (name: string) => boolean): number {
  const dir = join(REPO_ROOT, rel);
  if (!existsSync(dir)) return 0;
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let entries: readonly string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(cur, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
      } else if (matcher(name)) {
        total += 1;
      }
    }
  }
  return total;
}

function gateBunTestCoverage(): GateResult {
  const bashTests = safeReaddir("tests").filter(
    (n) => n.startsWith("test-") && n.endsWith(".sh")
  ).length;
  const bunTests = countFiles("loki-ts/tests", (n) => n.endsWith(".test.ts"));
  return {
    name: "bun-test-coverage-not-regressed",
    passed: bunTests >= bashTests,
    reason: bunTests >= bashTests
      ? `${bunTests} Bun tests >= ${bashTests} bash tests`
      : `only ${bunTests} Bun tests vs ${bashTests} bash tests being deleted`,
  };
}

function gateOpenBlockerReviews(): GateResult {
  const dir = join(REPO_ROOT, ".loki/quality/reviews");
  if (!existsSync(dir)) {
    return {
      name: "no-open-blocker-reviews",
      passed: true,
      reason: "no .loki/quality/reviews directory; treating as zero open blockers",
    };
  }
  let open = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let entries: readonly string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(cur, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!name.endsWith(".txt") && !name.endsWith(".json")) continue;
      try {
        const content = readFileSync(p, "utf8");
        if (/severity[":\s=]+(critical|high|blocker)/i.test(content) &&
            !/(resolved|closed|approved)/i.test(content)) {
          open += 1;
        }
      } catch {
        // skip unreadable
      }
    }
  }
  return {
    name: "no-open-blocker-reviews",
    passed: open === 0,
    reason: open === 0
      ? "no open blocker-severity reviews found"
      : `${open} review files appear to be open blockers`,
  };
}

function gateFinalCouncilVerdict(): GateResult {
  const path = ".loki/quality/phase6-final-council.json";
  if (!fileExists(path)) {
    return {
      name: "final-council-verdict-recorded",
      passed: false,
      reason: `${path} not found; final reviewer council has not voted`,
    };
  }
  try {
    const raw = readFileSync(join(REPO_ROOT, path), "utf8");
    const parsed = JSON.parse(raw) as { unanimous?: boolean; pass?: boolean };
    const ok = parsed.unanimous === true && parsed.pass === true;
    return {
      name: "final-council-verdict-recorded",
      passed: ok,
      reason: ok
        ? "final council unanimous PASS recorded"
        : `final council file present but verdict not unanimous-pass: ${raw.slice(0, 120)}`,
    };
  } catch (err) {
    return {
      name: "final-council-verdict-recorded",
      passed: false,
      reason: `could not parse final council file: ${(err as Error).message}`,
    };
  }
}

// ---------- Runner ----------

function main(): number {
  const gates: readonly GateResult[] = [
    gatePhase5TagExists(),
    gatePhase5ModulesExist(),
    gateBashStillPresent(),
    gateSoakWindowElapsed(),
    gateZeroLegacyBashInWindow(),
    gateZeroParityFailures(),
    gateBunNeverSlower(),
    gateSoakContinuity(),
    gateBunTestCoverage(),
    gateOpenBlockerReviews(),
    gateFinalCouncilVerdict(),
  ];

  const passed = gates.filter((g) => g.passed);
  const failed = gates.filter((g) => !g.passed);

  process.stdout.write("Phase 6 readiness check\n");
  process.stdout.write(`Repo root: ${REPO_ROOT}\n`);
  process.stdout.write(`Gates: ${passed.length}/${gates.length} passed\n\n`);

  for (const g of gates) {
    const tag = g.passed ? "PASS" : "FAIL";
    process.stdout.write(`[${tag}] ${g.name}: ${g.reason}\n`);
  }

  if (failed.length === 0) {
    process.stdout.write("\nREADY: all Phase 6 graduation criteria met. Safe to ship v8.0.0.\n");
    return 0;
  }

  process.stdout.write("\nNOT READY:\n");
  for (const g of failed) {
    process.stdout.write(`  - ${g.name}: ${g.reason}\n`);
  }
  return 1;
}

const code = main();
process.exit(code);
