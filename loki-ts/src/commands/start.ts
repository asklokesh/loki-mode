// v8 Phase 4 Story 5 + RUN-25 iter 2: `loki start` on the Bun route. Parses the
// reconciled flag surface into RunnerOpts / env and calls runAutonomous. Reached
// from bin/loki ONLY when LOKI_SDK_LOOP is truthy (Story 6); until then the
// default route still runs the bash cmd_start.
//
// T3(c) reconciliation (loop default-flip pre-flight): the bash cmd_start accepts
// ~44 flags. This route now handles every RUNNER flag (value-flags -> RunnerOpts,
// env-mapping flags -> process.env the lazily-imported runner reads, no-ops
// accepted) and REJECTS only genuinely-unsupported flags. Pre-loop orchestration
// flags (--parallel, --github, --sandbox, issue-mode, ...) are diverted BACK to
// the bash route by bin/loki BEFORE this code runs, so they are never seen here
// and never rejected -- the user gets full behavior. Deliberate drops
// (--compliance, mirofish) are rejected loudly and documented. See
// artifacts/ITER1-FLAG-RECONCILE.md.

import { SAFE_BUN_FLAGS } from "../runner/worker_proc.ts";
import { accessSync, constants as fsConstants, existsSync as pathExists, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { DEFAULT_MAX_COST_USD } from "../e10ext/budget_cap.ts"; // LM-002: help states the real default
import type { ProviderName, SessionTier } from "../runner/types.ts";
import { tokenFreeEnv, safeGitRun } from "../util/safe_git.ts";
import { REPO_ROOT } from "../util/paths.ts";
import { GENERIC_TIERS, VALID_TIERS } from "../util/claude_model.ts";
import { applyCostProfile, COST_PROFILES } from "../util/cost_profile.ts";
import { lokiYamlTexts, yamlKey } from "../util/yaml_key.ts";
import { suggestWord } from "../cli/registry.ts";
import { VALID_PROVIDERS } from "../runner/router/cost_preview.ts";

function argVal(args: readonly string[], flag: string): string | undefined {
  // First occurrence wins; both "--flag value" and "--flag=value" forms (TEN-COST-35).
  const eq = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === flag) return i + 1 < args.length ? args[i + 1] : undefined;
    if (a.startsWith(eq)) return a.slice(eq.length);
  }
  return undefined;
}

// RUNNER value-flags: consume the next token, map to a ParsedStartOpts field.
const VALUE_FLAGS = new Set([
  "--max-iterations",
  "--max-retries",
  "--budget-limit",
  "--budget", // alias of --budget-limit (bash uses --budget); closes the divergence
  "--provider",
  "--session-model",
  "--completion-promise",
  "--base-wait",
  "--max-wait",
  "--prd", // explicit spec path (overrides positional)
  "--brief", // one-liner spec text
  // provider-specific env-mapping value flags (only affect that provider)
  "--aider-model",
  "--aider-flags",
  "--cline-model",
  "--cost", // TEN-COST-01: cost profile (lean|off); also LOKI_COST_PROFILE
]);

// TEN-STABILITY-33: free-text value flags. A missing, empty or dash-leading value is an error (use --flag=-x for a dash-leading value).
// TEN-UX-48: --provider, --session-model, --cost and --spec take a required value too.
const TEXT_VALUE_FLAGS = new Set(["--prd", "--brief", "--completion-promise", "--aider-model", "--aider-flags", "--cline-model", "--provider", "--session-model", "--cost", "--spec"]);

// RUNNER boolean env-mapping flags: no value token; set an env var the runner
// already reads (or, for --skip-memory, now reads -- see build_prompt/runner).
const BOOL_ENV_FLAGS = new Map<string, [string, string]>([
  ["--allow-haiku", ["LOKI_ALLOW_HAIKU", "true"]],
  ["--simple", ["LOKI_COMPLEXITY", "simple"]],
  ["--complex", ["LOKI_COMPLEXITY", "complex"]],
  ["--regen-prd", ["LOKI_PRD_REGEN", "1"]],
  ["--regenerate-prd", ["LOKI_PRD_REGEN", "1"]],
  ["--regen", ["LOKI_PRD_REGEN", "1"]],
  ["--fresh-prd", ["LOKI_PRD_REGEN", "1"]],
  ["--skip-memory", ["LOKI_SKIP_MEMORY", "true"]],
  ["--fresh", ["LOKI_NO_RESUME", "1"]], // SB-12: skip the interrupted-run offer; engine10 reads LOKI_NO_RESUME
]);

// Accept-and-ignore no-op booleans (documented no-op on the non-interactive Bun
// route). Accepted so scripts passing them do not hard-fail; they take no action.
const NOOP_BOOL_FLAGS = new Set(["--yes", "-y", "--no-plan", "--no-mirofish", "--no-dashboard"]);

// FC-38, scoped to `start --attempts` (CTO ruling A): attempts run only engine10, so a flag is accepted
// there only if engine10 honors it: --provider / --budget(-limit) / --no-pr are forwarded as child argv,
// --session-model reaches the child through LOKI_SESSION_MODEL, --attempts drives the attempts runner,
// --prd / --brief pick the spec. Every other runner flag is refused with exit 2, never dropped.
// Without --attempts the 11.3.0 surface above applies unchanged.
const ATTEMPTS_VALUE_FLAGS = new Set([
  "--budget-limit",
  "--budget",
  "--provider",
  "--session-model",
  "--prd",
  "--brief",
  "--cost",
  "--attempts", // N independent attempts in separate worktrees (1-5)
]);
const ATTEMPTS_NOOP_BOOL_FLAGS = new Set(["--yes", "-y", "--no-plan", "--no-mirofish", "--no-dashboard", "--no-pr"]);

function hasAttemptsFlag(args: readonly string[]): boolean {
  return args.some((a) => a === "--attempts" || a.startsWith("--attempts="));
}

// SPEC-FIRST-INTENT: `start --spec FILE` / `--spec-first` run engine10 only, so a flag is accepted there
// only if engine10 honors it (the attempts set minus --attempts, plus the spec flags). Others are refused with exit 2.
const SPEC_VALUE_FLAGS = new Set([...ATTEMPTS_VALUE_FLAGS].filter((f) => f !== "--attempts").concat(["--spec"]));
const SPEC_NOOP_BOOL_FLAGS = new Set([...ATTEMPTS_NOOP_BOOL_FLAGS, "--spec-first"]);

function hasSpecFlag(args: readonly string[]): boolean {
  return args.some((a) => a === "--spec" || a.startsWith("--spec=") || a === "--spec-first");
}

// The full set of flag names this route ACCEPTS (value + bool-env + no-op).
// Anything else is rejected loudly (fail-closed: no silent capability loss).
function acceptedFlags(attemptsMode: boolean, specMode = false): Set<string> {
  const engineOnly = attemptsMode || specMode;
  const s = new Set<string>(specMode ? SPEC_VALUE_FLAGS : attemptsMode ? ATTEMPTS_VALUE_FLAGS : VALUE_FLAGS);
  if (!engineOnly) for (const k of BOOL_ENV_FLAGS.keys()) s.add(k);
  for (const k of specMode ? SPEC_NOOP_BOOL_FLAGS : attemptsMode ? ATTEMPTS_NOOP_BOOL_FLAGS : NOOP_BOOL_FLAGS) s.add(k);
  s.add("--help");
  s.add("-h");
  s.add("--dry-run");
  if (!engineOnly) s.add("--haiku");
  return s;
}

function posNum(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface ParsedStartOpts {
  prdPath: string;
  provider?: ProviderName;
  maxIterations?: number;
  maxRetries?: number;
  budgetLimit?: number;
  sessionModel?: SessionTier;
  completionPromise?: string;
  baseWaitSeconds?: number;
  maxWaitSeconds?: number;
  attempts?: number; // set only by --attempts; selects the engine10 attempts path
  specPath?: string; // SPEC-FIRST-INTENT: --spec FILE, forwarded to engine10
  specFirst?: boolean; // --spec-first: write the spec for editing and stop
  dryRun?: boolean; // TEN-UX-45: validate, preflight, print provider/model/cap, exit 0 without a run
  noPr?: boolean; // --attempts / --spec only: forwarded to engine10; absent = normal PR behavior
}

export const START_USAGE =
  "usage: loki start <spec> [--max-iterations N] [--max-retries N] [--budget-limit USD]\n" +
  "                        [--provider claude|codex|cline|aider|opencode] [--session-model small|medium|high|opus|sonnet|haiku]\n" +
  "                        [--completion-promise TEXT] [--base-wait S] [--max-wait S]\n" +
  "                        [--prd FILE | --brief TEXT] [--simple|--complex] [--allow-haiku]\n" +
  "                        [--regen-prd] [--skip-memory] [--cost lean|off] [--haiku]\n" +
  "                        [--spec FILE | --spec-first] [--dry-run]\n" +
  "                        [--workspace NAME | --deploy [--health-url URL [--health-match STR]] [--auto-rollback]\n" +
  "                                  [--destination preview|staging|production] [--canary] [--env-file FILE] [--domain HOST] [--github]]\n" +
  "  <spec> = a PRD path, or a one-line brief. (Issue refs / --github / --parallel /\n" +
  "  --sandbox, opencode, and other shell-adapter paths run on the bash route automatically.)\n" +
  "  --workspace NAME  run the loki.yaml workspace NAME for the brief; --deploy deploys after the run through the gated loki deploy --execute\n" +
  "  --cost lean|off   opt-in cost profile (also LOKI_COST_PROFILE=lean): sets LOKI_IMPLEMENT_HAIKU_FIRST=1, LOKI_E10_TRIM=1, LOKI_E10_SMALL_NO_RUNNER=1 and LOKI_E10_SMALL_MAX_CHARS=1200 unless already set; recorded in .loki/cost-profile.json\n" +
  "  --haiku          opt in to haiku for the first implement (same levers as --cost lean, plus LOKI_COST_FIRST=1). A failed check climbs back. The default model is the provider default, same as a raw session\n" +
  "  Proof            loki start sets LOKI_MUTATION_STRICT=1 and LOKI_E10_TRIM=1 unless you set them. A behavior change is VERIFIED only when a Wall test fails on the old code. Tool logs are trimmed before the next turn. Opt out with either var set to 0\n" +
  "  --fresh       skip the offer to resume an interrupted or cancelled run (also LOKI_NO_RESUME=1); without it, loki start offers to resume or start fresh itself\n" +
  "  --dry-run     validate every flag, run the preflight and print the provider, model and cost cap this run would use, then exit 0 without spending a token\n" +
  "  --spec-first  write the acceptance criteria to .loki/specs/<slug>.md and stop, so you can edit them\n" +
  "  --spec FILE   run Loki 10 against an edited spec as the authoritative intent (a spec that does not parse exits 2 with the line)\n" +
  `  --budget-limit USD  per-run spend cap (default $${DEFAULT_MAX_COST_USD}; Loki 10 applies it with an API key and none on a subscription; see docs/cost-controls.md)\n` +
  "       loki start <spec> --attempts N [--no-pr] [--provider P] [--budget USD] [--session-model T]\n" +
  "  --attempts N  run N (1-5) independent Loki 10 engine attempts in separate git worktrees; the one with\n" +
  "                the most executed passing checks is applied and every loser is recorded on the attempts\n" +
  "                receipt. Without --no-pr the winner alone is pushed and opened as a draft PR. Runner-only flags are refused with --attempts.\n" +
  "\nExamples:\n" +
  "  loki start \"build a todo app\"      # brief\n" +
  "  loki start ./prd.md                 # PRD file\n" +
  "  loki start owner/repo#123           # GitHub issue ref\n";

// Parse the reconciled flag surface into RunnerOpts (+ apply env-mapping flags to
// process.env), or return an error/terminal exit code. Value 0 = handled+exit
// (e.g. --help). Exported for a pure unit test. `applyEnv` lets the test capture
// env writes instead of mutating process.env.
export function parseStartArgs(
  args: readonly string[],
  err: (s: string) => void = (s) => process.stderr.write(s),
  out: (s: string) => void = (s) => process.stdout.write(s),
  applyEnv: (k: string, v: string) => void = (k, v) => {
    process.env[k] = v;
  },
): ParsedStartOpts | number {
  // --help / -h: print usage and exit 0 (terminal pre-loop arg).
  if (args.includes("--help") || args.includes("-h")) {
    out(START_USAGE);
    return 0;
  }

  const attemptsMode = hasAttemptsFlag(args);
  const specMode = hasSpecFlag(args);
  if (attemptsMode && specMode) {
    err("start: --spec / --spec-first cannot be combined with --attempts\n");
    return 2;
  }
  const accepted = acceptedFlags(attemptsMode, specMode);

  // Single pass: validate flag names, collect the spec, apply bool/env flags.
  // `--` ends options: the next token is the spec regardless of leading dashes.
  let spec: string | undefined;
  let endOfOpts = false;
  const seenValueFlags = new Set<string>();
  const valueFlagSet = specMode ? SPEC_VALUE_FLAGS : attemptsMode ? ATTEMPTS_VALUE_FLAGS : VALUE_FLAGS;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (endOfOpts) {
      if (spec === undefined) spec = a;
      continue;
    }
    if (a === "--") {
      endOfOpts = true;
      continue;
    }
    if (a.startsWith("-") && a !== "-") {
      const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      if (!accepted.has(name)) {
        if (attemptsMode || specMode) {
          err(`start: flag ${name} is not supported by loki start ${attemptsMode ? "--attempts" : "--spec"} (attempts run only the Loki 10 engine).\n`);
          err("Runner and orchestration flags were only honored by the legacy loop; remove them or drop --attempts.\n");
          return 2;
        }
        const near = suggestWord(name, [...accepted].filter((f) => f.startsWith("--")));
        err(`start: flag ${name} is not supported by loki start.${near ? ` Did you mean ${near}?` : ""}\n`);
        err("Run 'loki start --help' to see the supported flags.\n");
        return 2;
      }
      // TEN-UX-56: a repeated single-value flag is refused, never silently first-wins.
      if (valueFlagSet.has(name)) {
        if (seenValueFlags.has(name)) {
          err(`start: ${name} was given more than once; pass it a single time\n`);
          return 2;
        }
        seenValueFlags.add(name);
      }
      const boolEnv = BOOL_ENV_FLAGS.get(name);
      if (name === "--haiku") { // the lean profile's levers plus LOKI_COST_FIRST; explicit env wins
        for (const [k, v] of Object.entries({ ...COST_PROFILES.lean, LOKI_COST_FIRST: "1" })) {
          if (process.env[k] === undefined || process.env[k] === "") applyEnv(k, v);
        }
        continue;
      }
      if (boolEnv) {
        applyEnv(boolEnv[0], boolEnv[1]);
        continue;
      }
      if ((specMode ? SPEC_NOOP_BOOL_FLAGS : attemptsMode ? ATTEMPTS_NOOP_BOOL_FLAGS : NOOP_BOOL_FLAGS).has(name)) continue;
      if (TEXT_VALUE_FLAGS.has(name)) {
        const inline = a.includes("=");
        const v = inline ? a.slice(a.indexOf("=") + 1) : args[i + 1];
        if (v === undefined || v === "" || (!inline && v.startsWith("-"))) {
          err(`start: ${name} needs a value, got ${v === undefined ? "nothing" : v === "" ? "an empty value" : `'${v}'`} (use ${name}=VALUE for a dash-leading value)\n`);
          return 2;
        }
      }
      // value-flag: skip its value token (unless inline --flag=value)
      if ((specMode ? SPEC_VALUE_FLAGS : attemptsMode ? ATTEMPTS_VALUE_FLAGS : VALUE_FLAGS).has(name) && !a.includes("=")) i++;
      continue;
    }
    // bare token: the spec (first one wins)
    if (spec === undefined) spec = a;
  }

  // --prd / --brief override the positional spec.
  const prdFlag = argVal(args, "--prd");
  const briefFlag = argVal(args, "--brief");
  const specFlag = argVal(args, "--spec");
  const specFirst = args.includes("--spec-first");
  if (specFlag !== undefined && specFirst) {
    err("start: --spec and --spec-first cannot be combined\n");
    return 2;
  }
  // TEN-UX-32: two or more different spec sources are refused, never silently dropped.
  const sources: Array<[string, string]> = [];
  if (spec !== undefined) sources.push(["positional spec", spec]);
  if (prdFlag !== undefined) sources.push(["--prd", prdFlag]);
  if (briefFlag !== undefined) sources.push(["--brief", briefFlag]);
  if (new Set(sources.map(([, v]) => v)).size > 1) {
    err(`start: conflicting spec sources, pick one: ${sources.map(([n, v]) => `${n} ${JSON.stringify(v)}`).join(", ")}\n`);
    return 2;
  }
  const resolvedSpec = prdFlag ?? briefFlag ?? spec ?? (specFlag !== undefined ? "" : undefined);
  if (resolvedSpec === undefined || (resolvedSpec === "" && specFlag === "")) {
    err("start: a spec source (PRD path, --prd FILE, --brief TEXT, or issue ref) is required\n");
    err(START_USAGE);
    return 2;
  }

  // Apply provider-specific env-mapping VALUE flags (runner reads them per provider).
  const aiderModel = argVal(args, "--aider-model");
  if (aiderModel) applyEnv("LOKI_AIDER_MODEL", aiderModel);
  const aiderFlags = argVal(args, "--aider-flags");
  if (aiderFlags) applyEnv("LOKI_AIDER_FLAGS", aiderFlags);
  const clineModel = argVal(args, "--cline-model");
  if (clineModel) applyEnv("LOKI_CLINE_MODEL", clineModel);

  const providerRaw = argVal(args, "--provider");
  if (providerRaw && !VALID_PROVIDERS.has(providerRaw)) {
    err(`start: unknown --provider '${providerRaw}' (use one of: ${[...VALID_PROVIDERS].join(", ")})\n`);
    return 2;
  }
  // Generic capability vocabulary (small|medium|high) is translated onto the
  // canonical tier names before validation. Mirrors loki_tier_alias() in
  // providers/models.sh and run.sh's entry-point case.
  const tierRaw = GENERIC_TIERS[argVal(args, "--session-model") ?? ""]
    ?? argVal(args, "--session-model");
  if (tierRaw && !VALID_TIERS.has(tierRaw)) {
    err(
      `start: unknown --session-model '${tierRaw}' ` +
        `(small|medium|high, planning|development|fast, or opus|sonnet|haiku|fable)\n`,
    );
    return 2;
  }
  // Export the pin the way run.sh does (translated, e.g. high -> planning), so
  // the provider's opus pin and every child process read the same value.
  if (tierRaw) applyEnv("LOKI_SESSION_MODEL", tierRaw);

  // TEN-COST-01: opt-in cost profile; fills only unset levers, records them, names them on one line.
  // TEN-COST-27: loki.yaml cost.profile is the team default; --cost and LOKI_COST_PROFILE win. An invalid yaml value warns and falls back.
  let costRaw = args.find((a) => a.startsWith("--cost="))?.slice("--cost=".length) ?? argVal(args, "--cost") ?? process.env["LOKI_COST_PROFILE"];
  if (costRaw === undefined) {
    for (const t of lokiYamlTexts(process.cwd())) {
      const v = yamlKey(t, "cost", "profile");
      if (v === null) continue;
      if (Object.hasOwn(COST_PROFILES, v.trim().toLowerCase())) costRaw = v;
      else err(`start: ignoring loki.yaml cost.profile '${v}' (expected lean or off)\n`);
      break;
    }
  }
  try {
    const note = applyCostProfile(costRaw, process.env, applyEnv, process.env["LOKI_DIR"] ?? ".loki");
    if (note) out(note + "\n");
  } catch (e) {
    err(`start: ${(e as Error).message}\n`);
    return 2;
  }

  // TEN-COST-36: a present numeric flag with a missing, non-numeric, zero or negative value is an error, not a silent default.
  for (const f of ["--max-iterations", "--max-retries", "--budget-limit", "--budget", "--base-wait", "--max-wait"]) {
    if (!accepted.has(f) || !args.some((a) => a === f || a.startsWith(`${f}=`))) continue;
    const v = argVal(args, f);
    if (posNum(v) === undefined) {
      err(`start: ${f} must be a positive number, got '${v ?? ""}'\n`);
      return 2;
    }
  }

  // --budget is an alias of --budget-limit (bash divergence closed).
  // TEN-COST-43: both spellings with different values is an error, never first-wins.
  const bl = argVal(args, "--budget-limit");
  const bb = argVal(args, "--budget");
  if (bl !== undefined && bb !== undefined && posNum(bl) !== posNum(bb)) {
    err(`start: conflicting budget flags, pick one: --budget-limit ${bl}, --budget ${bb}\n`);
    return 2;
  }
  const budget = posNum(bl ?? bb);

  let attempts: number | undefined;
  if (attemptsMode) {
    const attemptsRaw = argVal(args, "--attempts") ?? args.find((a) => a.startsWith("--attempts="))?.slice("--attempts=".length);
    if (attemptsRaw === undefined || !/^[1-5]$/.test(attemptsRaw)) {
      err(`start: --attempts must be an integer from 1 to 5, got '${attemptsRaw ?? ""}'\n`);
      return 2;
    }
    attempts = Number(attemptsRaw);
  }

  return {
    ...(attempts !== undefined ? { attempts } : {}),
    ...((attemptsMode || specMode) && args.includes("--no-pr") ? { noPr: true } : {}),
    ...(args.includes("--dry-run") ? { dryRun: true } : {}),
    ...(specFlag ? { specPath: specFlag } : {}),
    ...(specFirst ? { specFirst: true } : {}),
    prdPath: resolvedSpec,
    provider: providerRaw as ProviderName | undefined,
    maxIterations: posNum(argVal(args, "--max-iterations")),
    maxRetries: posNum(argVal(args, "--max-retries")),
    budgetLimit: budget,
    sessionModel: tierRaw as SessionTier | undefined,
    completionPromise: argVal(args, "--completion-promise"),
    baseWaitSeconds: posNum(argVal(args, "--base-wait")),
    maxWaitSeconds: posNum(argVal(args, "--max-wait")),
  };
}

/** TEN-STABILITY-30: a path-shaped spec (or any --prd value) that does not exist is an error, never a paid run on the path string as an inline brief. Issue refs, URLs and multi-word briefs are not path-shaped. Returns the message, or null. */
export function missingPrdMessage(args: readonly string[], spec: string, exists: (p: string) => boolean = pathExists): string | null {
  if (spec === "") return null;
  const fromFlag = argVal(args, "--prd") !== undefined || args.some((a) => a.startsWith("--prd="));
  if (!fromFlag) {
    if (argVal(args, "--brief") !== undefined || args.some((a) => a.startsWith("--brief="))) return null;
    const noRef = !/#|^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec);
    const spacedPath = /\s/.test(spec) && !/[\r\n]/.test(spec) && spec.includes("/") && /\.(md|txt|pdf|docx|ya?ml|json)$/i.test(spec); // TEN-UX-50: "My Docs/prd.md"
    const pathShaped = noRef && (spacedPath || (!/\s/.test(spec) && (spec.includes("/") || /\.(md|txt|pdf|docx|ya?ml|json)$/i.test(spec))));
    if (!pathShaped) return null;
  }
  return exists(spec) ? null : `PRD file not found: ${spec}\n`;
}

export const SPEC_MAX_BYTES = 32 * 1024 * 1024;
// stdlib-only docx reader: the last-resort extractor when neither pandoc nor textutil is on PATH.
const DOCX_PY = "import sys,zipfile,re,html\nx=zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode('utf8')\nx=re.sub(r'</w:p>','\\n',x)\nx=re.sub(r'<w:tab/>','\\t',x)\nprint(html.unescape(re.sub(r'<[^>]+>','',x)))";

/** FC-BINARY-SPEC-READ-AS-UTF8: a .pdf or .docx spec is converted to text before any reader sees it. Returns the text, or an error message (missing extractor naming the install, encrypted, over 32 MB, or no text layer). Never returns binary bytes. */
export interface SpecAnchor { page?: number; line?: number; paragraph?: number; text: string; ocr?: true }
const OCR_HINT = "install ocrmypdf (brew install ocrmypdf, or apt install ocrmypdf) or tesseract (brew install tesseract, or apt install tesseract-ocr)";

/** Page and line anchors for a PDF: pages split on form feed, line numbers count every line on the page (blank ones too) so they match a viewer of the .txt page. Blank lines emit no anchor. */
export function pdfAnchors(pages: readonly string[], ocrPages: ReadonlySet<number> = new Set()): SpecAnchor[] {
  const out: SpecAnchor[] = [];
  pages.forEach((pg, pi) => pg.split("\n").forEach((t, li) => { if (t.trim() !== "") out.push({ page: pi + 1, line: li + 1, text: t, ...(ocrPages.has(pi + 1) ? { ocr: true as const } : {}) }); }));
  return out;
}

/** Paragraph anchors for a DOCX: pandoc wraps a paragraph over several lines, so its paragraphs are the blank-line separated blocks; textutil and the stdlib reader emit one paragraph per line. */
export function docxAnchors(text: string, byBlock: boolean): SpecAnchor[] {
  const parts = byBlock ? text.split(/\n[ \t]*\n/) : text.split("\n");
  const out: SpecAnchor[] = [];
  for (const raw of parts) { const t = byBlock ? raw.split("\n").map((l) => l.trim()).filter(Boolean).join(" ") : raw; if (t.trim() !== "") out.push({ paragraph: out.length + 1, text: t }); }
  return out;
}

/** OCR one PDF page (1-based) with ocrmypdf (preferred) or pdftoppm+tesseract, when installed. Returns null when no OCR tool works. */
function ocrPage(path: string, n: number, env: NodeJS.ProcessEnv): string | null {
  const dir = mkdtempSync(join(tmpdir(), "spec-ocr-"));
  const sp = (cmd: string, argv: string[]) => spawnSync(cmd, argv, { env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 300_000 });
  try {
    const o = join(dir, "ocr.pdf");
    if ((sp("ocrmypdf", ["--force-ocr", "--pages", String(n), path, o]).status ?? 1) === 0) {
      const t = sp("pdftotext", ["-f", String(n), "-l", String(n), "-layout", o, "-"]);
      if (t.status === 0) return t.stdout;
    }
    if ((sp("pdftoppm", ["-f", String(n), "-l", String(n), "-r", "300", "-png", path, join(dir, "pg")]).status ?? 1) === 0) {
      const img = readdirSync(dir).find((f) => f.endsWith(".png"));
      if (img) { const t = sp("tesseract", [join(dir, img), "stdout"]); if (t.status === 0) return t.stdout; }
    }
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function extractSpecText(path: string, env: NodeJS.ProcessEnv = process.env): { text: string; anchors: SpecAnchor[]; warnings: string[] } | { error: string } {
  const ext = /\.(pdf|docx)$/i.exec(path)?.[1]?.toLowerCase();
  if (!ext) return { error: `start: not a binary spec: ${path}\n` };
  if (statSync(path).size > SPEC_MAX_BYTES) return { error: `start: ${path} is over the 32 MB spec limit\n` };
  const run = (cmd: string, argv: string[]): { ok: boolean; missing: boolean; out: string; err: string } => {
    const r = spawnSync(cmd, argv, { env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
    return { ok: r.status === 0, missing: (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT", out: r.stdout ?? "", err: r.stderr ?? "" };
  };
  let text = "", anchors: SpecAnchor[] = [], byBlock = false;
  const warnings: string[] = [];
  if (ext === "pdf") {
    const info = run("pdfinfo", [path]);
    if (/^Encrypted:\s+yes/im.test(info.out)) return { error: `start: ${path} is an encrypted PDF; remove the encryption and retry\n` };
    const r = run("pdftotext", ["-layout", path, "-"]);
    if (r.missing) return { error: "start: reading a PDF spec needs pdftotext (install poppler: brew install poppler, or apt install poppler-utils)\n" };
    if (!r.ok) return { error: /password|encrypt/i.test(r.err) ? `start: ${path} is an encrypted PDF; remove the encryption and retry\n` : `start: pdftotext failed on ${path}: ${r.err.trim().split("\n")[0] ?? ""}\n` };
    text = r.out;
    const pages = text.split("\f");
    if (pages.length > 1 && pages[pages.length - 1]!.trim() === "") pages.pop();
    const blank = pages.flatMap((pg, i) => (pg.trim() === "" ? [i + 1] : []));
    const ocrd = new Set<number>(), missed: number[] = [];
    for (const n of blank) { const o = ocrPage(path, n, env); if (o !== null && o.trim() !== "") { pages[n - 1] = o; ocrd.add(n); } else missed.push(n); }
    if (ocrd.size > 0) text = pages.join("\f") + (r.out.endsWith("\f") ? "\f" : "");
    if (missed.length > 0 && missed.length < pages.length) warnings.push(`start: ${path}: page${missed.length > 1 ? "s" : ""} ${missed.join(", ")} had no text layer and were not read; ${OCR_HINT}\n`);
    anchors = pdfAnchors(pages, ocrd);
  } else {
    const tries: [string, string[]][] = [["pandoc", ["-t", "plain", path]], ["textutil", ["-convert", "txt", "-stdout", path]], ["python3", ["-c", DOCX_PY, path]]];
    let last: ReturnType<typeof run> | null = null;
    for (const [cmd, argv] of tries) { const r = run(cmd, argv); if (r.missing) continue; last = r; if (r.ok) { text = r.out; byBlock = cmd === "pandoc"; break; } }
    if (last === null) return { error: "start: reading a DOCX spec needs pandoc (brew install pandoc, or apt install pandoc)\n" };
    if (!last.ok) return { error: `start: could not read ${path} as DOCX: ${last.err.trim().split("\n")[0] ?? ""}\n` };
  }
  if (text.replace(/\s/g, "") === "") return { error: `start: ${path} has no extractable text (a scanned document needs OCR first; ${OCR_HINT})\n` };
  if (ext === "docx") anchors = docxAnchors(text, byBlock);
  return { text, anchors, warnings };
}

/** Extracts a .pdf/.docx spec to <cwd>/.loki/spec-extracted/<name>.txt so every downstream reader sees text; returns the new path, null for a non-binary or absent spec, or an error. */
export function textSpecPath(spec: string, cwd: string, env: NodeJS.ProcessEnv = process.env): { path: string } | { error: string } | null {
  if (!/\.(pdf|docx)$/i.test(spec) || !pathExists(spec) || !statSync(spec).isFile()) return null;
  const r = extractSpecText(spec, env);
  if ("error" in r) return r;
  const dir = join(cwd, ".loki", "spec-extracted"), out = join(dir, `${basename(spec)}.txt`);
  mkdirSync(dir, { recursive: true }); writeFileSync(out, r.text);
  writeFileSync(join(dir, `${basename(spec)}.anchors.json`), JSON.stringify(r.anchors, null, 1) + "\n");
  for (const w of r.warnings) process.stderr.write(w);
  return { path: resolve(out) };
}

/** FC-BINARY-SPEC-READ-AS-UTF8: the bash-diverted start (--workspace/--deploy) takes its spec as a positional arg; every .pdf/.docx arg is swapped for its extracted text path, so autonomy/run.sh never reads binary bytes. */
export function textifyBashArgs(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): { args: string[] } | { error: string } {
  const out: string[] = [];
  for (const a of args) {
    const t = a.startsWith("-") ? null : textSpecPath(a, cwd, env);
    if (t && "error" in t) return t;
    out.push(t ? t.path : a);
  }
  return { args: out };
}

/** `loki internal spec-text <path>`: prints the text path for a .pdf/.docx (or the path itself for any other file), so non-TS readers (the MCP server) share this one extractor. Exit 2 with the error on stderr when it cannot be read as text. */
export function runInternalSpecText(args: readonly string[], cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): number {
  const spec = args[0];
  if (!spec) { process.stderr.write("spec-text: usage: loki internal spec-text <path>\n"); return 2; }
  const t = textSpecPath(spec, cwd, env);
  if (t && "error" in t) { process.stderr.write(t.error); return 2; }
  process.stdout.write(`${t ? t.path : spec}\n`);
  return 0;
}

/** Which engine a parsed start runs: the 11.3.0 runner, unless --attempts was given (FC-38 scoped). */
export function startEngine(o: ParsedStartOpts): "runner" | "attempts" | "spec" {
  if (o.specPath !== undefined || o.specFirst) return "spec";
  return o.attempts === undefined ? "runner" : "attempts";
}

/** A jira:/linear: ref exports LOKI_WRITEBACK_ISSUE and LOKI_WRITEBACK_KIND so tracker writeback keys off the intake ref (returns a copy when set). */
export function writebackEnv(task: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const m = /^(jira|linear):([A-Za-z][A-Za-z0-9_]*-\d+)$/.exec(task.trim());
  return m ? { ...env, LOKI_WRITEBACK_ISSUE: m[2]!.toUpperCase(), LOKI_WRITEBACK_KIND: m[1]! } : env;
}

/** The engine10 argv for one start (pure; the cap flag reaches the plan route too). */
export function engineArgv(o: ParsedStartOpts, task: string, forceNoPr: boolean): string[] {
  const argv = o.specFirst ? [process.argv[1] ?? "", "engine10", "plan", task, "--spec"] : [process.argv[1] ?? "", "engine10", ...(task ? [task] : [])];
  if (o.specPath) argv.push("--spec", o.specPath);
  if (o.specFirst) { if (o.provider) argv.push("--provider", o.provider); if (o.budgetLimit !== undefined) argv.push("--max-cost", String(o.budgetLimit)); return argv; }
  if (forceNoPr || o.noPr) argv.push("--no-pr");
  if (o.provider) argv.push("--provider", o.provider);
  if (o.budgetLimit !== undefined) argv.push("--max-cost", String(o.budgetLimit)); // FC-37: per-run cap, never dropped
  return argv;
}
/** One engine10 run (FC-38: the only engine `start --attempts` may reach; it seals a receipt). */
async function runEngine10(cwd: string, o: ParsedStartOpts, env: NodeJS.ProcessEnv, forceNoPr: boolean): Promise<number> {
  const { existsSync, readFileSync, statSync } = await import("node:fs");
  const spec = o.prdPath;
  const task = spec !== "" && existsSync(spec) && statSync(spec).isFile() ? readFileSync(spec, "utf8") : spec;
  env = writebackEnv(task, env);
  return await spawnEngine(cwd, engineArgv(o, task, forceNoPr), env);
}

async function spawnEngine(cwd: string, argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const { spawn } = await import("node:child_process");
  return await new Promise<number>((resolveExit) => {
    const child = spawn(process.execPath, [...SAFE_BUN_FLAGS, ...argv], { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => resolveExit(1));
    child.on("close", (code) => resolveExit(code ?? 1));
  });
}

/** PATH slice: --workspace / --deploy (and their --health-url / --auto-rollback modifiers) are bash-route orchestration. Alone they divert to autonomy/loki; with --attempts or --spec they fall through and are refused loudly. */
export function isBashOnlyStart(args: readonly string[]): boolean {
  if (hasAttemptsFlag(args) || hasSpecFlag(args)) return false;
  return args.some((a) => a === "--workspace" || a.startsWith("--workspace=") || a === "--deploy");
}

/** TEN-DEPLOY-19: --health-url must be http(s) with a host and --domain a bare hostname; null when valid or absent (a missing value is left to the bash parser). */
export function deployFlagError(args: readonly string[]): string | null {
  const val = (name: string): string | undefined => {
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? "";
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      if (a === name) {
        const n = args[i + 1];
        return n !== undefined && !n.startsWith("-") ? n : undefined;
      }
    }
    return undefined;
  };
  // TEN-DEPLOY-26: a value flag with no value is named here, before the paid build
  for (const f of ["--health-url", "--domain", "--destination", "--env-file"]) {
    const i = args.indexOf(f);
    if (i >= 0 && (args[i + 1] === undefined || args[i + 1]!.startsWith("-"))) return `start: ${f} requires a value\n`;
  }
  const health = val("--health-url");
  if (health !== undefined) {
    let ok = false;
    try {
      const u = new URL(health);
      ok = (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
    } catch {
      ok = false;
    }
    if (!ok) return `start: --health-url must be an http or https URL with a host, got '${health}'\n`;
  }
  const domain = val("--domain");
  if (domain !== undefined && !/^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(domain)) {
    return `start: --domain must be a bare hostname (no scheme, path or port), got '${domain}'\n`;
  }
  const envFile = val("--env-file"); // TEN-DEPLOY-20: fail before the build, not after
  if (envFile !== undefined) {
    let ok = false;
    try {
      accessSync(envFile, fsConstants.R_OK);
      ok = statSync(envFile).isFile();
    } catch {
      ok = false;
    }
    if (!ok) return `start: --env-file '${envFile}' does not exist or is not a readable file\n`;
  }
  // TEN-DEPLOY-21: mirror loki deploy's destination enum, health-url requirement and canary rule before the paid build
  const dest = val("--destination");
  if (dest !== undefined && !["preview", "staging", "production"].includes(dest)) return `start: --destination must be one of: preview, staging, production, got '${dest}'\n`;
  if (args.includes("--auto-rollback") && health === undefined) return "start: --auto-rollback requires --health-url (no health signal, no rollback)\n";
  if (val("--health-match") !== undefined && health === undefined) return "start: --health-match requires --health-url\n";
  if (args.includes("--canary") && dest !== undefined && dest !== "production") return "start: --canary only applies to --destination production\n";
  return null;
}

const START_ENV_NAMES = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "LANG", "TZ", "CI", "NO_COLOR", "SSH_AUTH_SOCK", "LOKI_RUN_TMP"]);
const START_ENV_PREFIXES = ["LOKI_", "LC_", "XDG_", "NODE_", "BUN_", "ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "GEMINI_", "GOOGLE_", "OPENROUTER_", "OLLAMA_", "AWS_", "AZURE_", "GH_", "GITHUB_"];
/** Scoped child env for the bash divert: an explicit allowlist (plan section 3), never the whole env plus unrelated secrets. */
export function scopedStartEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && (START_ENV_NAMES.has(k) || START_ENV_PREFIXES.some((p) => k.startsWith(p)))) out[k] = v;
  }
  return out;
}

/** TEN-COST-41: the one-line effective run cap and its source; null when the runner's own `[runner] cap` note already names it (env, loki.yaml, default). */
export async function capSourceLine(budgetLimit: number | undefined, repoDir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const { resolveCap, capNote } = await import("../e10ext/budget_cap.ts");
  const c = resolveCap(budgetLimit !== undefined ? String(budgetLimit) : null, repoDir, env);
  if ("error" in c) return null;
  return budgetLimit !== undefined || c.source === "subscription" ? capNote(c.usd, c.source).replace("(--max-cost)", "(--budget-limit)") : null; // the start flag is --budget-limit, not engine10's --max-cost
}

/** TEN-UX-45: what `loki start --dry-run` prints; runs the real preflight (read-only: an uninitialised folder is reported, never git-initialised) and spends nothing. Returns the exit code. */
export async function dryRunStart(o: ParsedStartOpts, repoDir: string, env: NodeJS.ProcessEnv, out: (s: string) => void = (s) => process.stdout.write(s), err: (s: string) => void = (s) => process.stderr.write(s)): Promise<number> {
  const provider = o.provider ?? (env["LOKI_PROVIDER"] || "claude");
  if (!VALID_PROVIDERS.has(provider)) { err(`start: unknown LOKI_PROVIDER '${provider}' (use one of: ${[...VALID_PROVIDERS].join(", ")})\n`); return 2; }
  const { resolveCap, capNote } = await import("../e10ext/budget_cap.ts");
  const cap = resolveCap(o.budgetLimit !== undefined ? String(o.budgetLimit) : null, repoDir, env);
  if ("error" in cap) { err(`start: ${cap.error}\n`); return 2; }
  const inRepo = (await safeGitRun(repoDir, ["rev-parse", "--is-inside-work-tree"], { env: env as Record<string, string>, timeoutMs: 10000 })).stdout.trim() === "true";
  if (inRepo) {
    const { checkPreflight } = await import("../engine10/preflight.ts");
    const pf = await checkPreflight({ repoDir, provider, pr: o.noPr !== true, env });
    for (const w of pf.warnings) err(`${w}\n`);
    if (pf.fatal) { err(`start: dry-run preflight failed: ${pf.fatal}\n`); return 2; }
  } else {
    out("preflight: this folder is not a git repository; loki start would set one up if the folder is empty\n");
  }
  out(`dry-run: provider ${provider}, model ${o.sessionModel ?? "default tier routing"}, ${capNote(cap.usd, cap.source).replace("(--max-cost)", "(--budget-limit)")}, spec ${JSON.stringify(o.prdPath || o.specPath || "")}\n`);
  out("dry-run: flags valid, preflight passed, nothing was run and no tokens were spent\n");
  return 0;
}

/** SB-12: test seam for the offer's tty and reader (production leaves it empty). */
export const startRecoveryHooks: { deps?: import("../util/run_outputs.ts").ResumeDeps; afterOffer?: () => number; verifyPr?: (args: readonly string[]) => Promise<number> } = {};

/** SB-12: the one resume offer for `loki start <spec>`, made here while the parent owns the terminal (the engine child gets stdin "ignore").
 *  Returns an exit code when the user resumed, else null; on null it sets LOKI_NO_RESUME=1 so no engine child (or attempt) offers a second time.
 *  --attempts never offers Resume (noPr), since N fresh runs are being asked for. */
export async function offerInterruptedRun(o: ParsedStartOpts, cwd: string): Promise<number | null> {
  if (process.env["LOKI_NO_RESUME"] === "1") return null;
  try {
    const { existsSync, readFileSync, statSync } = await import("node:fs"), { safeGit } = await import("../util/safe_git.ts"), { startRecovery } = await import("../util/run_outputs.ts");
    const spec = o.prdPath, task = spec !== "" && existsSync(spec) && statSync(spec).isFile() ? readFileSync(spec, "utf8") : spec;
    const rec = await startRecovery(safeGit(cwd, ["rev-parse", "--show-toplevel"]).trim(), task, o.noPr === true || o.attempts !== undefined, startRecoveryHooks.deps ?? {});
    if (rec !== null) return rec;
  } catch { /* not a repo: nothing to offer */ }
  process.env["LOKI_NO_RESUME"] = "1";
  return null;
}

/** A github.com pull request URL (host case-insensitive, optional www., http or https) as the canonical https URL, else null. */
export function canonicalPrUrl(a: string): string | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(a);
  return m ? `https://github.com/${m[1]!}/pull/${m[2]!}` : null;
}

/** The route `loki start <PR url> --explain-route` prints; the text mirrors loki_route_print in autonomy/route.sh. */
export function prRouteText(url: string, json: boolean): string {
  const reason = "pull request URL: verify-pr seals it; no plan or implement stage, nothing is pushed";
  if (json) return `${JSON.stringify({ engine: "verify-pr", adapter: "verify-pr", provider: "n/a", model: "n/a (no model call)", input_type: "pr", input: url.length > 72 ? `${url.slice(0, 69)}...` : url, reason, capability_differences: [], run_cap_s: null })}\n`;
  const shown = url.length > 72 ? `${url.slice(0, 69)}...` : url;
  return `engine:   verify-pr\nadapter:  verify-pr\nprovider: n/a\nmodel:    n/a (no model call)\ninput:    pr (${shown})\nreason:   ${reason}\n`;
}

/** The verify-pr argv for `loki start` args holding a PR URL (null when none does). Only --json, --out and --no-pr are honored; any other flag, a second input or a PR-shaped URL parsePrRef rejects is refused, never dropped. --explain-route prints the route instead of running. */
export function prStartArgs(args: readonly string[], parsePrRef: (s: string) => unknown): { argv: string[]; explain: string | null } | { error: string } | null {
  let url: string | null = null, bad = "", badRef = "", extra = "", explain = false, json = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") return null;
    if (a === "--explain-route") explain = true;
    else if (a === "--json") { rest.push(a); json = true; }
    else if (a === "--no-pr") continue;
    else if (a === "--out") { rest.push(a, args[i + 1] ?? ""); i++; }
    else if (a.startsWith("--out=")) rest.push("--out", a.slice(6));
    else if (a.startsWith("-")) bad ||= a.split("=")[0]!;
    else {
      const u = canonicalPrUrl(a);
      if (u !== null && parsePrRef(u) === null) badRef ||= a;
      if (u !== null && url === null) url = u; else extra += `${extra ? " " : ""}${a}`;
    }
  }
  if (url === null) return null;
  if (badRef) return { error: `loki start <PR url>: not a valid pull request URL: ${badRef}` };
  if (bad) return { error: `loki start <PR url>: flag ${bad} is not supported (verify-pr takes --out DIR, --json and --no-pr)` };
  if (extra) return { error: `loki start <PR url> takes one input; also got: ${extra}` };
  return { argv: [url, ...rest], explain: explain ? prRouteText(url, json) : null };
}

export async function runStart(args: readonly string[]): Promise<number> {
  { // A github.com PR URL anywhere in the args is sealed by the existing verify-pr path (mirrors _route_pr_mode in autonomy/route.sh): no plan, no implement, nothing pushed.
    const { parsePrRef, runVerifyPr } = await import("./verify_pr.ts");
    const pr = prStartArgs(args, parsePrRef);
    if (pr !== null) {
      if ("error" in pr) { process.stderr.write(`${pr.error}\n`); return 2; }
      if (pr.explain !== null) { process.stdout.write(pr.explain); return 0; }
      return (startRecoveryHooks.verifyPr ?? runVerifyPr)(pr.argv);
    }
  }
  if (isBashOnlyStart(args)) {
    if (args.includes("--dry-run")) {
      process.stderr.write("start: --dry-run is not supported with --workspace or --deploy\n");
      return 2;
    }
    const deployErr = deployFlagError(args);
    if (deployErr) {
      process.stderr.write(deployErr);
      return 2;
    }
    const textual = textifyBashArgs(args, process.cwd(), process.env);
    if ("error" in textual) { process.stderr.write(textual.error); return 2; }
    const { spawn } = await import("node:child_process");
    return await new Promise<number>((resolveExit) => {
      const child = spawn("bash", [`${REPO_ROOT}/autonomy/loki`, "start", ...textual.args], { env: scopedStartEnv(process.env), stdio: "inherit" });
      child.on("error", () => resolveExit(1));
      child.on("close", (code) => resolveExit(code ?? 1));
    });
  }
  { // SB-12: a bare `loki start` (no spec) offers or resumes an interrupted run before it asks for a spec
    const errs: string[] = [], probe = parseStartArgs(args, (e) => { errs.push(e); }, () => {}, () => {});
    if (probe === 2 && errs.some((e) => e.startsWith("start: a spec source")) && process.env["LOKI_NO_RESUME"] !== "1" && !args.includes("--fresh")) {
      try {
        const { startRecovery } = await import("../util/run_outputs.ts"), { safeGit } = await import("../util/safe_git.ts"), rec = await startRecovery(safeGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim(), "", args.includes("--no-pr"));
        if (rec !== null) return rec;
      } catch { /* not a repo: the missing-spec message below */ }
    }
  }
  const parsed = parseStartArgs(args);
  if (typeof parsed === "number") return parsed;
  const missing = missingPrdMessage(args, parsed.prdPath);
  if (missing) {
    process.stderr.write(missing);
    return 2;
  }
  for (const k of ["prdPath", "specPath"] as const) { // FC-BINARY-SPEC-READ-AS-UTF8
    const v = parsed[k];
    const t = v ? textSpecPath(v, process.cwd(), process.env) : null;
    if (t && "error" in t) { process.stderr.write(t.error); return 2; }
    if (t) parsed[k] = t.path;
  }
  if (parsed.dryRun) return dryRunStart(parsed, process.cwd(), process.env);
  { const rec = await offerInterruptedRun(parsed, process.cwd()); if (rec !== null) return rec; }
  if (startEngine(parsed) === "runner") {
    const capLine = await capSourceLine(parsed.budgetLimit, process.cwd(), process.env);
    if (capLine) process.stdout.write(`[runner] ${capLine}\n`);
    if (startRecoveryHooks.afterOffer) return startRecoveryHooks.afterOffer(); // test seam: stop before any runner or engine dispatch
    const { runAutonomous } = await import("../runner/autonomous.ts");
    return runAutonomous(parsed);
  }
  if (startRecoveryHooks.afterOffer) return startRecoveryHooks.afterOffer();
  if (startEngine(parsed) === "spec") return runEngine10(process.cwd(), parsed, process.env, false);
  const { attempts, ...runnerOpts } = parsed;
  const { runAttempts, productionDeps } = await import("../runner/attempts.ts");
  const { perAttemptCap, resolveCap, capNote } = await import("../e10ext/budget_cap.ts");
  // One total for N attempts: each child run gets total/N, so --attempts 3 cannot triple the spend.
  const total = resolveCap(runnerOpts.budgetLimit !== undefined ? String(runnerOpts.budgetLimit) : null, process.cwd(), process.env);
  const share = "error" in total ? undefined : perAttemptCap(total.usd, attempts ?? 1);
  const attemptOpts = share !== undefined && (attempts ?? 1) > 1 ? { ...runnerOpts, budgetLimit: share } : runnerOpts;
  if (share !== undefined && "usd" in total && (attempts ?? 1) > 1) process.stdout.write(`${capNote(total.usd, total.source)} shared by ${attempts} attempts: $${share.toFixed(2)} each\n`);
  const deps = productionDeps(
    process.cwd(),
    () => runEngine10(process.cwd(), runnerOpts, process.env, false),
    async (_id, wt) => {
      // Each attempt is one engine10 run in its own worktree: only engine10 seals the receipt the scorer reads.
      // Attempts never open PRs themselves; the winner alone is pushed and opened as a draft PR (see productionDeps.openPr).
      // Token-free: attempts never push (forced --no-pr; only push-pr after all attempts has credentials), so no attempt process needs GH_TOKEN or SSH_AUTH_SOCK.
      const env = tokenFreeEnv({ ...process.env, LOKI_DIR: `${wt}/.loki` });
      delete env["LOKI_RUN_TMP"];
      return runEngine10(wt, attemptOpts, env, true);
    },
    { noPr: runnerOpts.noPr === true },
  );
  return runAttempts(attempts ?? 1, deps);
}
