// Port of autonomy/loki:cmd_doctor (line 6216) and cmd_doctor_json (line 6534).
//
// Behavioral parity targets:
//   - Text mode: sectioned PASS/FAIL/WARN output, summary footer, exit 1 on
//     any FAIL (warnings ok).
//   - JSON mode: emit the structure documented in the migration inventory and
//     produced by python3 in cmd_doctor_json. Always exits 0 in JSON mode so
//     scripts can parse the result regardless of system health.
//
// Network probes (ChromaDB, MiroFish) use AbortSignal.timeout(2000) so a slow
// probe never hangs the CLI. Secret env vars are checked for presence only --
// the value is never read or echoed.
import { existsSync, lstatSync, readlinkSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { commandExists, run } from "../util/shell.ts";
import { findPython3, runInline } from "../util/python.ts";
import { BOLD, CYAN, DIM, GREEN, NC, RED, YELLOW } from "../util/colors.ts";

// ---------- Types (mirror cmd_doctor_json shape) ------------------------------

export type Severity = "required" | "recommended" | "optional";
export type Status = "pass" | "fail" | "warn";

export type ToolCheck = {
  name: string;
  command: string;
  found: boolean;
  version: string | null;
  required: Severity;
  min_version: string | null;
  status: Status;
  path: string | null;
};

export type DiskCheck = {
  available_gb: number | null;
  status: Status;
};

export type DoctorJson = {
  checks: ToolCheck[];
  disk: DiskCheck;
  summary: {
    passed: number;
    failed: number;
    warnings: number;
    ok: boolean;
  };
};

// ---------- Tool check helpers ------------------------------------------------

const VERSION_NUMBER_RE = /(\d+\.\d+(?:\.\d+)*)/;

// Extract a version number using the same regex bash's python helper uses.
function extractVersion(text: string): string | null {
  const m = text.match(VERSION_NUMBER_RE);
  return m ? m[1]! : null;
}

// Run `<cmd> --version` (timeout 5s) and pull the first version-shaped token
// out of stdout/stderr. Mirrors get_version() in cmd_doctor_json.
async function probeVersion(cmd: string): Promise<string | null> {
  try {
    const r = await run([cmd, "--version"], { timeoutMs: 5000 });
    const text = (r.stdout || r.stderr || "").trim();
    return extractVersion(text);
  } catch {
    return null;
  }
}

function compareMajorMinor(version: string, min: string): number {
  const cur = version.split(".").map((p) => parseInt(p, 10));
  const want = min.split(".").map((p) => parseInt(p, 10));
  while (cur.length < 2) cur.push(0);
  while (want.length < 2) want.push(0);
  for (let i = 0; i < 2; i++) {
    const a = cur[i] ?? 0;
    const b = want[i] ?? 0;
    if (Number.isNaN(a) || Number.isNaN(b)) return 0;
    if (a !== b) return a - b;
  }
  return 0;
}

export async function checkTool(
  name: string,
  cmd: string,
  required: Severity,
  minVersion: string | null = null,
): Promise<ToolCheck> {
  const path = await commandExists(cmd);
  const found = path !== null;
  const version = found ? await probeVersion(cmd) : null;

  let status: Status = "pass";
  if (!found) {
    status = required === "required" ? "fail" : "warn";
  } else if (minVersion && version) {
    if (compareMajorMinor(version, minVersion) < 0) {
      status = required === "required" ? "fail" : "warn";
    }
  }

  return {
    name,
    command: cmd,
    found,
    version,
    required,
    min_version: minVersion,
    status,
    path,
  };
}

// ---------- Disk check --------------------------------------------------------

// JSON form of disk check (bash cmd_doctor_json uses round(..., 1) -- 1 decimal).
export function checkDisk(): DiskCheck {
  let available_gb: number | null = null;
  try {
    const stats = statfsSync(homedir());
    const bytes = Number(stats.bavail) * Number(stats.bsize);
    available_gb = Math.round((bytes / (1024 ** 3)) * 10) / 10;
  } catch {
    available_gb = null;
  }

  let status: Status = "pass";
  if (available_gb !== null) {
    if (available_gb < 1) status = "fail";
    else if (available_gb < 5) status = "warn";
  }
  return { available_gb, status };
}

// ---------- Network probes ----------------------------------------------------

// HTTP GET with hard 2s timeout. Returns true only on 2xx response.
export async function httpReachable(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------- Python integration probes -----------------------------------------

// Returns true if `python3 -c "import <mod>"` exits 0. Uses runInline (which
// honors the python detection priority in src/util/python.ts).
//
// v7.4.2 fix (BUG-23): the previous 5s timeout was tighter than a cold
// sentence_transformers import (~3.3s) under parallel load, causing
// probabilistic divergence vs bash (which has no timeout). ML imports get
// 30s; non-ML imports keep 5s.
async function pythonImportOk(module: string, useMlPython = false): Promise<boolean> {
  const source = `import ${module}`;
  const timeoutMs = useMlPython ? 30000 : 5000;
  if (!useMlPython) {
    const r = await runInline(source, { timeoutMs });
    return r.exitCode === 0;
  }
  // For numpy / sentence_transformers, prefer the ML python (3.12) since 3.14
  // is not yet compatible with chromadb/sentence-transformers.
  // findPython3() already prefers /opt/homebrew/bin/python3.12; runInline uses
  // findPython3(), so this is the same behavior. Keep the flag for clarity.
  const py = await findPython3();
  if (!py) return false;
  const r = await run([py, "-c", source], { timeoutMs });
  return r.exitCode === 0;
}

// ---------- Skills check ------------------------------------------------------

type SkillEntry = { name: string; dir: string };

const SKILL_ENTRIES: readonly SkillEntry[] = [
  { name: "Claude Code", dir: ".claude/skills/loki-mode" },
  { name: "Codex CLI", dir: ".codex/skills/loki-mode" },
  { name: "Gemini CLI", dir: ".gemini/skills/loki-mode" },
  { name: "Cline CLI", dir: ".cline/skills/loki-mode" },
  { name: "Aider CLI", dir: ".aider/skills/loki-mode" },
];

type SkillStatus = {
  name: string;
  path: string;
  status: Status;
  detail: string;
};

export function checkSkills(): SkillStatus[] {
  const home = homedir();
  return SKILL_ENTRIES.map(({ name, dir }) => {
    const sdir = resolve(home, dir);
    // Match bash autonomy/loki:6410 behavior under `set -euo pipefail`:
    // ${sdir/$HOME/~} does NOT substitute when set -e is active (bash quirk),
    // so the full path is shown. Mirror that.
    const shortPath = sdir;
    const skillFile = resolve(sdir, "SKILL.md");

    if (existsSync(skillFile)) {
      return { name, path: shortPath, status: "pass" as const, detail: "" };
    }
    // Detect broken symlink: lstat succeeds but stat target is missing.
    try {
      const info = lstatSync(sdir);
      if (info.isSymbolicLink()) {
        let target = "unknown";
        try {
          target = readlinkSync(sdir);
        } catch {
          // ignore
        }
        return {
          name,
          path: shortPath,
          status: "fail" as const,
          detail: `(broken symlink -> ${target})`,
        };
      }
    } catch {
      // Path does not exist at all -- fall through to warn.
    }
    return {
      name,
      path: shortPath,
      status: "warn" as const,
      detail: "(not found - run 'loki setup-skill')",
    };
  });
}

// ---------- Tool list (single source of truth shared by text + JSON) ----------

// Display name (text mode, with min-version suffix per bash autonomy/loki:6354)
// vs JSON name (cmd_doctor_json bare name per bash :6580). They differ by design.
type ToolSpec = {
  displayName: string;
  jsonName: string;
  cmd: string;
  required: Severity;
  min?: string;
};

const TOOL_SPECS: readonly ToolSpec[] = [
  { displayName: "Node.js (>= 18)", jsonName: "Node.js", cmd: "node", required: "required", min: "18.0" },
  { displayName: "Python 3 (>= 3.8)", jsonName: "Python 3", cmd: "python3", required: "required", min: "3.8" },
  { displayName: "jq", jsonName: "jq", cmd: "jq", required: "required" },
  { displayName: "git", jsonName: "git", cmd: "git", required: "required" },
  { displayName: "curl", jsonName: "curl", cmd: "curl", required: "required" },
  { displayName: "bash (>= 4.0)", jsonName: "bash", cmd: "bash", required: "recommended", min: "4.0" },
  { displayName: "Claude CLI", jsonName: "Claude CLI", cmd: "claude", required: "optional" },
  { displayName: "Codex CLI", jsonName: "Codex CLI", cmd: "codex", required: "optional" },
  { displayName: "Gemini CLI", jsonName: "Gemini CLI", cmd: "gemini", required: "optional" },
  { displayName: "Cline CLI", jsonName: "Cline CLI", cmd: "cline", required: "optional" },
  { displayName: "Aider CLI", jsonName: "Aider CLI", cmd: "aider", required: "optional" },
];

// Internal record carries both names; callers pick which one to render.
type ToolRow = ToolCheck & { displayName: string };

async function runAllToolChecks(): Promise<ToolRow[]> {
  return Promise.all(
    TOOL_SPECS.map(async (spec) => {
      const c = await checkTool(spec.jsonName, spec.cmd, spec.required, spec.min ?? null);
      return { ...c, displayName: spec.displayName };
    }),
  );
}

// ---------- JSON mode ---------------------------------------------------------

export async function buildDoctorJson(): Promise<DoctorJson> {
  const rows = await runAllToolChecks();
  // Strip the displayName field for JSON output -- bash JSON has bare names.
  const checks: ToolCheck[] = rows.map(({ displayName: _displayName, ...rest }) => rest);
  const disk = checkDisk();

  let passed = 0;
  let failed = 0;
  let warnings = 0;
  for (const c of checks) {
    if (c.status === "pass") passed++;
    else if (c.status === "fail") failed++;
    else warnings++;
  }
  if (disk.status === "pass") passed++;
  else if (disk.status === "fail") failed++;
  else warnings++;

  return {
    checks,
    disk,
    summary: { passed, failed, warnings, ok: failed === 0 },
  };
}

// ---------- Text mode rendering ----------------------------------------------

function badge(status: Status): string {
  switch (status) {
    case "pass":
      return `${GREEN}PASS${NC}`;
    case "fail":
      return `${RED}FAIL${NC}`;
    case "warn":
      return `${YELLOW}WARN${NC}`;
  }
}

function formatToolLine(c: ToolRow): string {
  const ver = c.version ? ` (v${c.version})` : "";
  // Text-mode label uses the bash-style display name (with `(>= MIN)` suffix).
  const label = c.displayName;
  if (!c.found) {
    const note =
      c.required === "required"
        ? "not found"
        : c.required === "recommended"
          ? "not found (recommended)"
          : "not found (optional)";
    return `  ${badge(c.status)}  ${label} - ${note}`;
  }
  if (c.min_version && c.version && compareMajorMinor(c.version, c.min_version) < 0) {
    const tag = c.required === "required" ? "requires" : "recommended";
    return `  ${badge(c.status)}  ${label}${ver} - ${tag} >= ${c.min_version}`;
  }
  return `  ${badge(c.status)}  ${label}${ver}`;
}

type Tally = { pass: number; fail: number; warn: number };

function bump(t: Tally, s: Status): void {
  if (s === "pass") t.pass++;
  else if (s === "fail") t.fail++;
  else t.warn++;
}

function printHelp(): void {
  process.stdout.write(`${BOLD}loki doctor${NC} - Check system prerequisites\n\n`);
  process.stdout.write(`Usage: loki doctor [--json]\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --json    Output machine-readable JSON\n\n`);
  process.stdout.write(`Checks: node, python3, jq, git, curl, bash version,\n`);
  process.stdout.write(`        claude/codex/gemini CLIs, and disk space.\n`);
}

async function runText(): Promise<number> {
  process.stdout.write(`${BOLD}Loki Mode Doctor${NC}\n\n`);
  process.stdout.write(`Checking system prerequisites...\n\n`);

  const tally: Tally = { pass: 0, fail: 0, warn: 0 };
  const allChecks = await runAllToolChecks();
  const byCmd = new Map(allChecks.map((c) => [c.command, c]));

  // Required section
  process.stdout.write(`${CYAN}Required:${NC}\n`);
  for (const cmd of ["node", "python3", "jq", "git", "curl"]) {
    const c = byCmd.get(cmd)!;
    process.stdout.write(formatToolLine(c) + "\n");
    bump(tally, c.status);
  }
  process.stdout.write(`\n`);

  // AI Providers
  process.stdout.write(`${CYAN}AI Providers:${NC}\n`);
  const providerCmds = ["claude", "codex", "gemini", "cline", "aider"];
  let anyProvider = false;
  for (const cmd of providerCmds) {
    const c = byCmd.get(cmd)!;
    process.stdout.write(formatToolLine(c) + "\n");
    bump(tally, c.status);
    if (c.found) anyProvider = true;
  }
  if (!anyProvider) {
    process.stdout.write(
      `  ${badge("fail")}  No AI provider CLI installed -- at least one is required\n`,
    );
    process.stdout.write(
      `         ${YELLOW}Install: npm install -g @anthropic-ai/claude-code${NC}\n`,
    );
    tally.fail++;
  }
  process.stdout.write(`\n`);

  // API Keys (presence only -- never echo values)
  process.stdout.write(`${CYAN}API Keys:${NC}\n`);
  const claudeFound = byCmd.get("claude")!.found;
  const codexFound = byCmd.get("codex")!.found;
  const geminiFound = byCmd.get("gemini")!.found;
  const env = process.env;
  if (env["ANTHROPIC_API_KEY"]) {
    process.stdout.write(`  ${badge("pass")}  ANTHROPIC_API_KEY is set\n`);
    tally.pass++;
  } else if (claudeFound) {
    process.stdout.write(
      `  ${DIM}  --  ${NC}  ANTHROPIC_API_KEY not set (Claude CLI uses its own login)\n`,
    );
  }
  if (env["OPENAI_API_KEY"]) {
    process.stdout.write(`  ${badge("pass")}  OPENAI_API_KEY is set\n`);
    tally.pass++;
  } else if (codexFound) {
    process.stdout.write(
      `  ${DIM}  --  ${NC}  OPENAI_API_KEY not set (Codex CLI uses its own login)\n`,
    );
  }
  if (env["GOOGLE_API_KEY"] || env["GEMINI_API_KEY"]) {
    process.stdout.write(`  ${badge("pass")}  GOOGLE_API_KEY is set\n`);
    tally.pass++;
  } else if (geminiFound) {
    process.stdout.write(
      `  ${DIM}  --  ${NC}  GOOGLE_API_KEY not set (Gemini CLI uses its own login)\n`,
    );
  }
  process.stdout.write(`\n`);

  // Skills
  process.stdout.write(`${CYAN}Skills:${NC}\n`);
  for (const s of checkSkills()) {
    if (s.status === "pass") {
      process.stdout.write(`  ${badge("pass")}  ${s.name}  ${DIM}${s.path}${NC}\n`);
      tally.pass++;
    } else if (s.status === "fail") {
      process.stdout.write(`  ${badge("fail")}  ${s.name}  ${DIM}${s.detail}${NC}\n`);
      process.stdout.write(`         ${YELLOW}Fix: loki setup-skill${NC}\n`);
      tally.fail++;
    } else {
      process.stdout.write(`  ${badge("warn")}  ${s.name}  ${DIM}${s.detail}${NC}\n`);
      tally.warn++;
    }
  }
  process.stdout.write(`\n`);

  // Integrations
  process.stdout.write(`${CYAN}Integrations:${NC}\n`);
  if (await pythonImportOk("mcp")) {
    process.stdout.write(`  ${badge("pass")}  MCP SDK (Python)\n`);
    tally.pass++;
  } else {
    process.stdout.write(`  ${badge("warn")}  MCP SDK - not installed (pip3 install mcp)\n`);
    tally.warn++;
  }
  if (await pythonImportOk("numpy", true)) {
    process.stdout.write(`  ${badge("pass")}  numpy (vector search)\n`);
    tally.pass++;
  } else {
    process.stdout.write(`  ${badge("warn")}  numpy - not installed (pip3 install numpy)\n`);
    tally.warn++;
  }
  if (await pythonImportOk("sentence_transformers", true)) {
    process.stdout.write(`  ${badge("pass")}  sentence-transformers (embeddings)\n`);
    tally.pass++;
  } else {
    process.stdout.write(
      `  ${badge("warn")}  sentence-transformers - not installed (loki memory vectors setup)\n`,
    );
    tally.warn++;
  }
  if (await httpReachable("http://localhost:8100/api/v2/heartbeat")) {
    process.stdout.write(`  ${badge("pass")}  ChromaDB server (port 8100)\n`);
    tally.pass++;
  } else {
    process.stdout.write(
      `  ${badge("warn")}  ChromaDB - not running (docker start loki-chroma)\n`,
    );
    tally.warn++;
  }
  // MiroFish: only check if env var is set (we can't run docker inspect cheaply
  // without spawning docker; bash also gates on env var or docker inspect).
  const mfUrl = process.env["LOKI_MIROFISH_URL"];
  if (mfUrl) {
    if (await httpReachable(`${mfUrl}/health`)) {
      process.stdout.write(`  ${badge("pass")}  MiroFish server (${mfUrl})\n`);
      tally.pass++;
    } else {
      process.stdout.write(
        `  ${badge("warn")}  MiroFish - not running (loki start --mirofish-docker <image>)\n`,
      );
      tally.warn++;
    }
  }
  if (process.env["LOKI_OTEL_ENDPOINT"]) {
    process.stdout.write(
      `  ${badge("pass")}  OTEL endpoint: ${process.env["LOKI_OTEL_ENDPOINT"]}\n`,
    );
    tally.pass++;
  } else {
    process.stdout.write(
      `  ${badge("warn")}  OTEL - not configured (set LOKI_OTEL_ENDPOINT)\n`,
    );
    tally.warn++;
  }
  process.stdout.write(`\n`);

  // System
  process.stdout.write(`${CYAN}System:${NC}\n`);
  const bashCheck = byCmd.get("bash")!;
  process.stdout.write(formatToolLine(bashCheck) + "\n");
  bump(tally, bashCheck.status);

  const disk = checkDisk();
  // Bash text uses `df -g` (integer GB, floored). JSON uses round(_, 1).
  // checkDisk() returns the JSON-friendly float; floor it here for text-mode parity.
  const diskTextGb = disk.available_gb === null ? null : Math.floor(disk.available_gb);
  if (diskTextGb === null) {
    process.stdout.write(`  ${badge("warn")}  Disk space: unable to determine\n`);
    tally.warn++;
  } else if (disk.status === "fail") {
    process.stdout.write(
      `  ${badge("fail")}  Disk space: ${diskTextGb}GB available (need >= 1GB)\n`,
    );
    tally.fail++;
  } else if (disk.status === "warn") {
    process.stdout.write(
      `  ${badge("warn")}  Disk space: ${diskTextGb}GB available (low)\n`,
    );
    tally.warn++;
  } else {
    process.stdout.write(
      `  ${badge("pass")}  Disk space: ${diskTextGb}GB available\n`,
    );
    tally.pass++;
  }
  process.stdout.write(`\n`);

  // Summary
  process.stdout.write(
    `${BOLD}Summary:${NC} ${GREEN}${tally.pass} passed${NC}, ${RED}${tally.fail} failed${NC}, ${YELLOW}${tally.warn} warnings${NC}\n\n`,
  );

  if (tally.fail > 0) {
    process.stdout.write(`${RED}Some required prerequisites are missing.${NC}\n`);
    process.stdout.write(`Install missing dependencies and run 'loki doctor' again.\n`);
    return 1;
  }
  if (tally.warn > 0) {
    process.stdout.write(`${YELLOW}All required checks passed with some warnings.${NC}\n`);
    return 0;
  }
  process.stdout.write(`${GREEN}All checks passed. System is ready for Loki Mode.${NC}\n`);
  return 0;
}

// ---------- Public entry point -----------------------------------------------

export async function runDoctor(argv: readonly string[]): Promise<number> {
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      return 0;
    } else {
      process.stderr.write(`${RED}Unknown option: ${arg}${NC}\n`);
      process.stderr.write(`Usage: loki doctor [--json]\n`);
      return 1;
    }
  }

  if (json) {
    const result = await buildDoctorJson();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0; // JSON mode always exits 0 (parity with bash cmd_doctor_json).
  }
  return runText();
}
