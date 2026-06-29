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
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { REPO_ROOT } from "../util/paths.ts";
import { commandExists, run } from "../util/shell.ts";
import { findPython3, runInline } from "../util/python.ts";
import { BOLD, CYAN, DIM, GREEN, NC, RED, YELLOW } from "../util/colors.ts";
import { getVersion } from "../version.ts";

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

// v7.5.15: sentrux architectural-drift gate state exposed in --json output.
// Sibling of checks/disk -- intentionally not counted in the summary tally
// to keep summary numbers backwards-compatible with v7.5.14 consumers.
export type SentruxCheck = {
  found: boolean;
  version: string | null;
  status: Status;
  required: "optional";
};

// v7.7.17: memory subsystem health surface. Mirrors the bash side
// (autonomy/loki:cmd_doctor_json) which reports the latest entries from
// .loki/memory/.errors.log (rotated by memory/error_log.py). Sibling of
// checks/disk/sentrux; not counted in the summary tally to preserve
// backwards-compatible numbers.
export type MemoryHealth = {
  errors_log_path: string | null;
  recent_errors: string[];
  recent_error_count: number;
  status: Status;
};

export type DoctorJson = {
  // v7.6.1 B-9 fix: surface the active loki version so tools parsing this
  // JSON know which release produced the report. Mirrors the bash side
  // (autonomy/loki:cmd_doctor_json) which now sets LOKI_VERSION env.
  loki_mode_version: string;
  checks: ToolCheck[];
  disk: DiskCheck;
  sentrux: SentruxCheck;
  memory: MemoryHealth;
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
export async function pythonImportOk(module: string, useMlPython = false): Promise<boolean> {
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

// Mutable indirection so tests can swap the implementation (e.g. to record
// invocation timestamps and assert the three Integration-section probes run
// in parallel). Production callers use this exact reference, so a test stub
// is observed inside runText() without touching the export shape.
type PythonImportOk = (module: string, useMlPython?: boolean) => Promise<boolean>;
const pyImpl = { fn: pythonImportOk as PythonImportOk };
export function _setPythonImportOkForTest(fn: PythonImportOk | null): void {
  pyImpl.fn = fn ?? pythonImportOk;
}

// ---------- Skills check ------------------------------------------------------

type SkillEntry = { name: string; dir: string };

const SKILL_ENTRIES: readonly SkillEntry[] = [
  { name: "Claude Code", dir: ".claude/skills/loki-mode" },
  { name: "Codex CLI", dir: ".codex/skills/loki-mode" },
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
        // Initialize before the try so the catch arm leaves `target` defined.
        let target = "unknown";
        try {
          target = readlinkSync(sdir);
        } catch {
          // readlink can fail on race or permission error; keep "unknown".
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
  // v7.4.9: Bun powers the routed commands (version, status, stats, doctor,
  // provider show/list, memory list/index). Marked recommended -- if missing,
  // bin/loki silently falls through to bash autonomy/loki, but users miss the
  // ~3-5x speedup.
  { displayName: "Bun (>= 1.3)", jsonName: "Bun", cmd: "bun", required: "recommended", min: "1.3" },
  { displayName: "Claude CLI", jsonName: "Claude CLI", cmd: "claude", required: "optional" },
  { displayName: "Codex CLI", jsonName: "Codex CLI", cmd: "codex", required: "optional" },
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

// v7.5.15: probe the sentrux binary for the JSON output. Mirrors the bash
// cmd_doctor_json sentrux block byte-for-byte (subject to the bun-parity
// matrix's jq -S key-sort + disk float normalization). Always returns a
// SentruxCheck record; the `found` field discriminates installed vs not.
async function checkSentrux(): Promise<SentruxCheck> {
  const path = await commandExists("sentrux");
  const found = path !== null;
  const version = found ? await probeVersion("sentrux") : null;
  const status: Status = found ? "pass" : "warn";
  return { found, version, status, required: "optional" };
}

// v7.7.17: read the memory subsystem error log surface for doctor --json.
// Resolves the log path via LOKI_DIR env (set by loki invocations) with a
// cwd-relative `.loki/memory/.errors.log` fallback. Never throws; returns
// an empty list on any read failure (matches bash side behaviour).
//
// v7.7.17 council fix (Opus 2):
//   (a) Tail-only read (last 64 KB) so an oversize log cannot OOM the
//       doctor command. Mirrors memory/error_log.py read_recent_errors.
//   (b) Path parity: emit RELATIVE path (join only, no resolve) to match
//       the bash side's os.path.join output exactly. Bash uses relative;
//       Bun was emitting absolute, breaking the parity matrix.
async function checkMemoryHealth(): Promise<MemoryHealth> {
  const { openSync, statSync, readSync, closeSync, existsSync } =
    await import("node:fs");
  const { join } = await import("node:path");
  const TAIL_BYTES = 64 * 1024;
  const lokiDir = process.env["LOKI_DIR"] ?? ".loki";
  const logPath = join(lokiDir, "memory", ".errors.log");
  let recent: string[] = [];
  let exists = false;
  try {
    if (existsSync(logPath)) {
      exists = true;
      const size = statSync(logPath).size;
      const offset = Math.max(0, size - TAIL_BYTES);
      const len = size - offset;
      const buf = Buffer.alloc(len);
      const fd = openSync(logPath, "r");
      try {
        readSync(fd, buf, 0, len, offset);
      } finally {
        closeSync(fd);
      }
      const text = buf.toString("utf-8");
      let lines = text.split("\n");
      if (offset > 0 && lines.length > 0) {
        lines = lines.slice(1); // drop possibly-partial first line
      }
      lines = lines.map((l) => l.trim()).filter((l) => l.length > 0);
      recent = lines.slice(-5);
    }
  } catch {
    recent = [];
  }
  return {
    errors_log_path: exists ? logPath : null,
    recent_errors: recent,
    recent_error_count: recent.length,
    status: recent.length === 0 ? "pass" : "warn",
  };
}

export async function buildDoctorJson(): Promise<DoctorJson> {
  const rows = await runAllToolChecks();
  // Strip the displayName field for JSON output -- bash JSON has bare names.
  const checks: ToolCheck[] = rows.map(({ displayName: _displayName, ...rest }) => rest);
  const disk = checkDisk();
  const sentrux = await checkSentrux();
  const memory = await checkMemoryHealth();

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
    loki_mode_version: getVersion(),
    checks,
    disk,
    sentrux,
    memory,
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
  process.stdout.write(`        claude/codex CLIs, and disk space.\n`);
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
  const providerCmds = ["claude", "codex", "cline", "aider"];
  // Per-provider install hint, byte-matching the bash route's
  // doctor_provider_install_cmd (autonomy/loki:8128). The bash route writes this
  // hint to STDERR (run.sh doctor_check_provider, `>&2`), so it must go to STDERR
  // here too: the canonical bun-parity gate (.github/workflows/bun-parity.yml)
  // captures STDOUT only (`>out 2>/dev/null`), so a stdout hint would appear on
  // the Bun route but not bash and break parity. On stderr it is invisible to the
  // stdout-only gate AND aligned under local-ci's 2>&1 capture. The user still
  // sees the hint (stderr is shown on a real terminal).
  const providerInstall: Record<string, string> = {
    claude: "npm install -g @anthropic-ai/claude-code",
    codex: "npm install -g @openai/codex",
    cline: "npm install -g cline",
    aider: "pip install aider-chat",
  };
  let anyProvider = false;
  for (const cmd of providerCmds) {
    const c = byCmd.get(cmd)!;
    process.stdout.write(formatToolLine(c) + "\n");
    if (!c.found && providerInstall[cmd]) {
      process.stderr.write(`         ${YELLOW}Install: ${providerInstall[cmd]}${NC}\n`);
    }
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
    // v7.29.0: consent-gated install offer. Parity by construction: rather than
    // re-implementing the prompt copy in TypeScript (which would drift from the
    // bash route), invoke the single shared helper autonomy/provider-offer.sh
    // via child_process with inherited stdio. The helper's "report" mode is a
    // no-op on non-TTY/CI, so doctor's non-interactive and --json output stay
    // byte-identical (this is the only path; --json never reaches runText).
    // Guarded on stdout being a TTY so we never spawn bash in piped/CI doctor.
    if (process.stdout.isTTY) {
      const offerScript = resolve(REPO_ROOT, "autonomy/provider-offer.sh");
      if (existsSync(offerScript)) {
        spawnSync("bash", [offerScript, "report"], { stdio: "inherit" });
      }
    }
  }
  process.stdout.write(`\n`);

  // API Keys (presence only -- never echo values)
  process.stdout.write(`${CYAN}API Keys:${NC}\n`);
  const claudeFound = byCmd.get("claude")?.found ?? false;
  const codexFound = byCmd.get("codex")?.found ?? false;
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
  // Phase I (v7.5.25): detect ANTHROPIC_BASE_URL alt-provider routing
  // (OpenRouter, Ollama, LiteLLM, self-hosted). Claude Code reads this env
  // var natively; Loki passes it through unchanged. Warn when the user sets
  // an alt endpoint without LOKI_MODEL_OVERRIDE -- the default opus/sonnet/
  // haiku aliases may not resolve on the alt-provider.
  if (env["ANTHROPIC_BASE_URL"]) {
    const url = env["ANTHROPIC_BASE_URL"];
    process.stdout.write(`  ${badge("pass")}  ANTHROPIC_BASE_URL: ${url}\n`);
    tally.pass++;
    if (!env["LOKI_MODEL_OVERRIDE"]) {
      process.stdout.write(
        `  ${badge("warn")}  LOKI_MODEL_OVERRIDE not set -- opus/sonnet/haiku aliases may not resolve on alt-provider\n`,
      );
      tally.warn++;
    } else {
      process.stdout.write(
        `  ${badge("pass")}  LOKI_MODEL_OVERRIDE: ${env["LOKI_MODEL_OVERRIDE"]}\n`,
      );
      tally.pass++;
    }
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
  // v7.5.8: parallelize the three python module probes. Sequentially the
  // numpy + sentence_transformers checks each have a 30s timeout (cold ML
  // imports), so worst case was ~60-90s wall time. Promise.all keeps them
  // bounded by the slowest single probe. Output order is preserved by
  // awaiting the array up front.
  const [mcpOk, numpyOk, stOk] = await Promise.all([
    pyImpl.fn("mcp"),
    pyImpl.fn("numpy", true),
    pyImpl.fn("sentence_transformers", true),
  ]);
  if (mcpOk) {
    process.stdout.write(`  ${badge("pass")}  MCP SDK (Python)\n`);
    tally.pass++;
  } else {
    process.stdout.write(`  ${badge("warn")}  MCP SDK - not installed (pip3 install mcp)\n`);
    tally.warn++;
  }
  if (numpyOk) {
    process.stdout.write(`  ${badge("pass")}  numpy (vector search)\n`);
    tally.pass++;
  } else {
    process.stdout.write(`  ${badge("warn")}  numpy - not installed (pip3 install numpy)\n`);
    tally.warn++;
  }
  if (stOk) {
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
  // v7.7.0: LSP servers check (mirrors autonomy/loki cmd_doctor). The
  // mcp.lsp_proxy auto-detects these binaries; reporting here gives users
  // visibility into which languages get agent-side symbol grounding.
  {
    const lspBins = [
      "pyright-langserver",
      "pylsp",
      "typescript-language-server",
      "gopls",
      "rust-analyzer",
      "jdtls",
    ];
    const found: string[] = [];
    for (const bin of lspBins) {
      if (await commandExists(bin)) {
        found.push(bin);
      }
    }
    if (found.length > 0) {
      process.stdout.write(
        `  ${badge("pass")}  LSP servers detected (${found.length}): ${found.join(", ")}\n`,
      );
      tally.pass++;
    } else {
      process.stdout.write(
        `  ${badge("warn")}  LSP servers - none on PATH (install for symbol grounding: npm i -g pyright typescript-language-server; brew install gopls)\n`,
      );
      tally.warn++;
    }
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
  // sentrux check (v7.5.14, optional architectural-drift gate). Mirrors the
  // bash-route line at autonomy/loki:cmd_doctor so the bun-parity matrix
  // diff stays empty.
  if (await commandExists("sentrux")) {
    let sentruxVer = "unknown";
    try {
      const r = await run(["sentrux", "--version"], { timeoutMs: 2000 });
      const tok = r.stdout.split(/\s+/).filter(Boolean).pop();
      if (tok) sentruxVer = tok.replace(/^v/, "");
    } catch {
      /* keep "unknown" */
    }
    process.stdout.write(
      `  ${badge("pass")}  sentrux ${sentruxVer} (architectural drift gate: loki sentrux help)\n`,
    );
    tally.pass++;
  } else {
    process.stdout.write(
      `  ${badge("warn")}  sentrux - not installed (optional, brew install sentrux/tap/sentrux)\n`,
    );
    tally.warn++;
  }
  process.stdout.write(`\n`);

  // System
  process.stdout.write(`${CYAN}System:${NC}\n`);
  const bashCheck = byCmd.get("bash")!;
  process.stdout.write(formatToolLine(bashCheck) + "\n");
  bump(tally, bashCheck.status);

  // v7.4.10 fix: Bun probe was added to TOOL_SPECS in v7.4.9 but never
  // wired into the text-mode System section, so doctor text-mode dropped
  // the Bun line + the summary count was off-by-one vs bash. JSON output
  // already included Bun via the generic loop. Restore parity here.
  const bunCheck = byCmd.get("bun");
  if (bunCheck) {
    process.stdout.write(formatToolLine(bunCheck) + "\n");
    bump(tally, bunCheck.status);
  }

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

  // v7.5.1 fix B23: report which runtime route the user's `loki` invocation
  // is actually taking. Pre-v7.5.1 doctor only reported whether bun/bash were
  // installed, not which path was active -- users couldn't tell if their flag
  // overrides (LOKI_LEGACY_BASH=1, LOKI_TS_ENTRY=...) were taking effect.
  //
  // Informational only: this section does NOT contribute to the pass/fail/
  // warn tally so the bun-parity matrix can normalize it to nothing without
  // also having to reconcile the summary counts across routes.
  process.stdout.write(`${CYAN}Runtime route:${NC}\n`);
  const isBun = (process.versions as Record<string, string | undefined>)["bun"] !== undefined;
  const argv0 = process.argv[0] ?? "(unknown)";
  process.stdout.write(`  ${badge("pass")}  Active runtime: ${isBun ? "Bun" : "Node"} (${argv0})\n`);
  if (process.env["LOKI_LEGACY_BASH"] === "1" || process.env["LOKI_LEGACY_BASH"] === "true") {
    process.stdout.write(`  ${badge("warn")}  LOKI_LEGACY_BASH set: shim routes every command to autonomy/loki (bash)\n`);
  }
  if (process.env["LOKI_TS_ENTRY"]) {
    process.stdout.write(`  ${badge("pass")}  LOKI_TS_ENTRY override: ${process.env["LOKI_TS_ENTRY"]}\n`);
  }
  if (process.env["BUN_FROM_SOURCE"] === "1" || process.env["BUN_FROM_SOURCE"] === "true") {
    process.stdout.write(`  ${badge("pass")}  BUN_FROM_SOURCE set: shim prefers loki-ts/src/ over dist/\n`);
  }
  // v7.5.2 fix #33: chromadb + sentence-transformers require Python 3.12; the
  // generic "Python 3 (>= 3.8)" check above passes Python 3.13/3.14 and the
  // operator only finds out via cryptic chromadb errors at runtime. Probe
  // explicitly here.
  //
  // HONESTY (T1.2): 3.12 is needed only for the OPTIONAL vector-search /
  // embedding path (chromadb + sentence-transformers). Core memory (episodic /
  // semantic, file-based) and the rest of Loki run fine on Python 3.8+. So this
  // is a WARN that names the real, narrow impact -- never a FAIL. It stays
  // badge-only and does NOT touch the pass/fail/warn tally, so it can never flip
  // doctor's exit code and block a working user (fail-open), and it keeps the
  // summary counts identical across the bun and bash routes.
  const py = await findPython3();
  if (py !== null) {
    const verRes = await run([py, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"], { timeoutMs: 5000 });
    const ver = verRes.stdout.trim();
    if (ver.startsWith("3.12")) {
      process.stdout.write(`  ${badge("pass")}  Python 3.12 (chromadb / sentence-transformers): ${ver} at ${py}\n`);
    } else if (ver) {
      process.stdout.write(`  ${badge("warn")}  Python 3.12 recommended for memory vector search (chromadb / sentence-transformers); found ${ver} at ${py}. Core memory and the rest of Loki work without it. Install: brew install python@3.12 (macOS) or apt install python3.12 (Debian/Ubuntu).\n`);
    } else {
      process.stdout.write(`  ${badge("warn")}  Python 3 found at ${py} but version probe failed; memory vector search (chromadb / sentence-transformers) may not work. The rest of Loki is unaffected.\n`);
    }
  } else {
    process.stdout.write(`  ${badge("warn")}  Python 3 not on PATH -- memory + MCP integrations disabled. The rest of Loki works without them.\n`);
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
  } else {
    process.stdout.write(`${GREEN}All checks passed. System is ready for Loki Mode.${NC}\n`);
  }
  // Setup verified (no required check failed): hand the user straight to a
  // first build with a copy-paste command, so they never dead-end here. The
  // fail branch returns above, so a failing setup is never told to build.
  process.stdout.write(`\n`);
  process.stdout.write(
    `Next: loki quickstart (guided first build from your idea, no PRD needed)\n`,
  );
  process.stdout.write(
    `      or loki demo (builds a sample todo app end to end) or loki start ./prd.md\n`,
  );
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
