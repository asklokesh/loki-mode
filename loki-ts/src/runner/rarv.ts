// RARV cycle tier mapping + project complexity detection.
// Mirrors bash autonomy/run.sh:
//   - get_rarv_tier        (lines 1484-1505)
//   - get_rarv_phase_name  (lines 1508-1519)
//   - get_provider_tier_param (lines 1524-1571)
//   - detect_complexity    (lines 1338-1428)
//
// Note: there is no rarv.md in docs/phase4-research/. This module follows
// the bash source directly. Iteration tier mapping is iteration % 4:
//   0 -> planning   (REASON,  opus)
//   1 -> development (ACT,    sonnet)
//   2 -> development (REFLECT, sonnet)
//   3 -> fast       (VERIFY,  haiku)

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { extname, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// RARV tier mapping
// ---------------------------------------------------------------------------

export type RarvTier = "planning" | "development" | "fast" | "fable";
export type RarvPhase = "REASON" | "ACT" | "REFLECT" | "VERIFY";
export type Provider = "claude" | "codex" | "cline" | "aider";

export interface GetRarvTierOptions {
  // When set and `legacy` is false, the session-pinned model overrides the
  // RARV cycle (matches run.sh:10417-10423).
  sessionModel?: string;
  // When true, force RARV-driven rotation (LOKI_LEGACY_TIER_SWITCHING=true).
  legacy?: boolean;
}

// Pure RARV cycle (iteration % 4) -> tier. Always available regardless of
// session-pinning behaviour. Mirrors run.sh:1484-1505.
function rarvCycleTier(iteration: number): RarvTier {
  // Bash is `(iteration % 4)` over a non-negative iteration counter.
  // Normalize negatives just in case (((n % 4) + 4) % 4).
  const step = ((Math.trunc(iteration) % 4) + 4) % 4;
  switch (step) {
    case 0:
      return "planning";
    case 1:
      return "development";
    case 2:
      return "development";
    case 3:
      return "fast";
    default:
      return "development";
  }
}

// Map a session-pinned model name to a tier. Mirrors the run.sh session-pin
// case (LOKI_SESSION_MODEL -> CURRENT_TIER), including the explicit `fable` arm
// so a fable-pinned session resolves to the fable tier (not the development
// default) and the Bun route stays parity-locked with bash.
function sessionModelToTier(model: string): RarvTier {
  switch (model) {
    case "opus":
      return "planning";
    case "sonnet":
      return "development";
    case "haiku":
      return "fast";
    case "fable":
      return "fable";
    case "planning":
    case "development":
    case "fast":
      return model;
    default:
      // Unknown model strings: bash passes through as-is to provider helpers.
      // We default to "development" so the type stays narrow.
      return "development";
  }
}

// Resolve the active tier for an iteration. Default behaviour (legacy=false)
// pins the tier from sessionModel. legacy=true rotates via RARV cycle.
export function getRarvTier(iteration: number, options: GetRarvTierOptions = {}): RarvTier {
  const legacy = options.legacy ?? (process.env["LOKI_LEGACY_TIER_SWITCHING"] === "true");
  if (legacy) {
    return rarvCycleTier(iteration);
  }
  const sessionModel = options.sessionModel ?? process.env["LOKI_SESSION_MODEL"] ?? "sonnet";
  return sessionModelToTier(sessionModel);
}

// Phase name for logging (mirrors run.sh:1508-1519). Always the RARV cycle
// phase (independent of session pinning).
export function getRarvPhaseName(iteration: number): RarvPhase {
  const step = ((Math.trunc(iteration) % 4) + 4) % 4;
  switch (step) {
    case 0:
      return "REASON";
    case 1:
      return "ACT";
    case 2:
      return "REFLECT";
    case 3:
      return "VERIFY";
    default:
      // Unreachable, but keeps return type narrow.
      return "REASON";
  }
}

// Provider-specific tier parameter (legacy fallback table from
// run.sh:1535-1570). Production code prefers resolve_model_for_tier from
// providers/*.sh, but the static table is what dashboards/tests rely on.
export function getProviderTierParam(tier: RarvTier | string, provider: Provider | string): string {
  switch (provider) {
    case "claude":
      switch (tier) {
        case "planning":
          return process.env["PROVIDER_MODEL_PLANNING"] ?? "opus";
        case "development":
          return process.env["PROVIDER_MODEL_DEVELOPMENT"] ?? "opus";
        case "fast":
          return process.env["PROVIDER_MODEL_FAST"] ?? "sonnet";
        case "fable":
          // fable unavailable, collapse to opus. Claude Fable 5 is not
          // available at the Claude API ("use Opus 4.8"). Mirrors the bash
          // resolver's `fable) model="opus"` arm and run.sh's static fallback,
          // so dispatch, the cost quote, and the dashboard agree. The fable tier
          // label and session-pin parsing stay; only the RESOLVED model becomes
          // opus (v7.39.1).
          return "opus";
        default:
          return "sonnet";
      }
    case "codex":
      switch (tier) {
        case "planning":
          return process.env["PROVIDER_EFFORT_PLANNING"] ?? "xhigh";
        case "development":
          return process.env["PROVIDER_EFFORT_DEVELOPMENT"] ?? "high";
        case "fast":
          return process.env["PROVIDER_EFFORT_FAST"] ?? "low";
        default:
          return "high";
      }
    case "cline":
      return process.env["CLINE_DEFAULT_MODEL"] ?? process.env["LOKI_CLINE_MODEL"] ?? "default";
    case "aider":
      return process.env["AIDER_DEFAULT_MODEL"] ?? process.env["LOKI_AIDER_MODEL"] ?? "claude-opus-4-7";
    default:
      return "development";
  }
}

// ---------------------------------------------------------------------------
// Complexity detection
// ---------------------------------------------------------------------------

export type Complexity = "simple" | "standard" | "complex";

export interface DetectComplexityOptions {
  // Project root (default: cwd). Maps to TARGET_DIR in bash.
  filesGlob?: string;
  // PRD path (markdown or .json). Optional.
  prdPath?: string;
  // Force a complexity tier (mirrors COMPLEXITY_TIER != "auto"). Also reads
  // LOKI_COMPLEXITY env var as a convenience.
  override?: string;
}

export interface ComplexityDetails {
  complexity: Complexity;
  fileCount: number;
  prdComplexity: Complexity;
  hasExternal: boolean;
  hasMicroservices: boolean;
}

// Source-file extensions counted by run.sh:1351-1353.
const SOURCE_EXTS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".php",
  ".swift",
  ".kt",
]);

// Directory components excluded by `! -path "*/X/*"` in run.sh:1354-1355.
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "vendor",
  "dist",
  "build",
  "__pycache__",
]);

// Substrings detected by `grep -rq` for external integrations (run.sh:1363).
const EXTERNAL_PATTERN = /oauth|SAML|OIDC|stripe|twilio|aws-sdk|@google-cloud|azure/i;
// File globs scanned for external integrations: *.json, *.ts, *.js (run.sh:1364).
const EXTERNAL_SCAN_EXTS: ReadonlySet<string> = new Set([".json", ".ts", ".js"]);

interface WalkResult {
  fileCount: number;
  hasExternal: boolean;
}

// Recursive walk that counts source files and scans for external integrations
// in one pass (vs two find/grep calls in bash).
function walkProject(root: string): WalkResult {
  let fileCount = 0;
  let hasExternal = false;

  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (EXCLUDED_DIRS.has(name)) continue;
        // Bash also excludes via path globs -- the names match.
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      const ext = extname(name).toLowerCase();
      if (SOURCE_EXTS.has(ext)) {
        fileCount += 1;
      }
      if (!hasExternal && EXTERNAL_SCAN_EXTS.has(ext)) {
        try {
          // Cap read size at 256KB. Bash uses `grep -rq` which streams; we
          // open the file, read the first chunk, and run the pattern only
          // on that head sample. Prevents OOM on multi-GB lockfiles when
          // detect_complexity is invoked from a working dir like / or $HOME.
          // (Devil's Advocate C6 finding 2026-04-25.)
          const fd = openSync(full, "r");
          try {
            const cap = 262144; // 256 * 1024
            const head = Buffer.alloc(cap);
            const n = readSync(fd, head, 0, cap, 0);
            const sample = head.subarray(0, n).toString("utf8");
            if (EXTERNAL_PATTERN.test(sample)) {
              hasExternal = true;
            }
          } finally {
            closeSync(fd);
          }
        } catch {
          // ignore unreadable file
        }
      }
      // Cheap short-circuit not required -- continuing is fine.
      // Avoid relative() call hot-path; kept here for future use.
      void relative;
    }
  }

  return { fileCount, hasExternal };
}

interface PrdAnalysis {
  prdComplexity: Complexity;
}

function analyzePrd(prdPath: string): PrdAnalysis {
  let prdComplexity: Complexity = "standard";
  if (!existsSync(prdPath)) return { prdComplexity };

  let raw: string;
  try {
    raw = readFileSync(prdPath, "utf8");
  } catch {
    return { prdComplexity };
  }

  const isJson = prdPath.toLowerCase().endsWith(".json");
  const wordCount = raw.trim().length === 0 ? 0 : raw.trim().split(/\s+/).length;

  let featureCount = 0;
  let sectionCount = 0;

  if (isJson) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        for (const k of ["features", "requirements", "tasks", "user_stories", "epics"]) {
          const v = obj[k];
          if (Array.isArray(v)) featureCount += v.length;
        }
      }
    } catch {
      // Fallback: count occurrences of key fields by regex (run.sh:1393).
      const m = raw.match(/"title"|"name"|"feature"|"requirement"/g);
      featureCount = m ? m.length : 0;
    }
  } else {
    // Markdown: count h2 headers and checklist items (run.sh:1397).
    const featMatches = raw.match(/^(##|- \[)/gm);
    featureCount = featMatches ? featMatches.length : 0;
    // Section count uses h2 + h3 headers (run.sh:1403).
    const sectionMatches = raw.match(/^(##|###)/gm);
    sectionCount = sectionMatches ? sectionMatches.length : 0;
  }

  // Run.sh:1408-1412 thresholds.
  if (wordCount < 200 && featureCount < 5 && sectionCount < 3) {
    prdComplexity = "simple";
  } else if (wordCount > 1000 || featureCount > 15 || sectionCount > 10) {
    prdComplexity = "complex";
  } else {
    prdComplexity = "standard";
  }

  return { prdComplexity };
}

// Detect project complexity. Mirrors detect_complexity (run.sh:1338-1428).
// Returns a structured details object so callers can log/debug; the primary
// value is `details.complexity`.
export function detectComplexity(opts: DetectComplexityOptions = {}): ComplexityDetails {
  // Override path 1: explicit option.
  // Override path 2: COMPLEXITY_TIER env var (bash idiom).
  // Override path 3: LOKI_COMPLEXITY env var (matches user docs).
  const override =
    opts.override ??
    (process.env["COMPLEXITY_TIER"] && process.env["COMPLEXITY_TIER"] !== "auto"
      ? process.env["COMPLEXITY_TIER"]
      : undefined) ??
    process.env["LOKI_COMPLEXITY"];

  if (override && override !== "auto") {
    if (override === "simple" || override === "standard" || override === "complex") {
      return {
        complexity: override,
        fileCount: 0,
        prdComplexity: "standard",
        hasExternal: false,
        hasMicroservices: false,
      };
    }
  }

  const targetDir = opts.filesGlob ?? process.env["TARGET_DIR"] ?? process.cwd();

  let fileCount = 0;
  let hasExternal = false;
  if (existsSync(targetDir)) {
    const walked = walkProject(targetDir);
    fileCount = walked.fileCount;
    hasExternal = walked.hasExternal;
  }

  const hasMicroservices =
    existsSync(join(targetDir, "docker-compose.yml")) ||
    existsSync(join(targetDir, "docker-compose.yaml")) ||
    existsSync(join(targetDir, "k8s"));

  let prdComplexity: Complexity = "standard";
  if (opts.prdPath) {
    prdComplexity = analyzePrd(opts.prdPath).prdComplexity;
  }

  // Final decision tree (run.sh:1417-1425).
  let complexity: Complexity;
  if (fileCount <= 5 && prdComplexity === "simple" && !hasExternal && !hasMicroservices) {
    complexity = "simple";
  } else if (fileCount > 50 || hasMicroservices || hasExternal || prdComplexity === "complex") {
    complexity = "complex";
  } else {
    complexity = "standard";
  }

  return {
    complexity,
    fileCount,
    prdComplexity,
    hasExternal,
    hasMicroservices,
  };
}
