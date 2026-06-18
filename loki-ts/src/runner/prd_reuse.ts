// PRD-reuse resolution for the autonomous runner (Bun route).
//
// Mirrors the bash route in autonomy/run.sh so both routes behave identically:
//   compute_codebase_signature()        autonomy/run.sh:4800
//   _loki_hash_stdin()                   autonomy/run.sh:4768
//   _loki_prd_file_hash()                autonomy/run.sh:4869
//   decide_generated_prd_action()        autonomy/run.sh:4892
//   persist_prd_signature_if_present()   autonomy/run.sh:4983
//   user-PRD persistence branch          autonomy/run.sh run_autonomous (Agent C, W4)
//
// Semantics (FEAT-PRD-REUSE, FEAT-PRDREUSE-DOCKER-PLAN):
//   | Run | File arg? | Persisted PRD? | Behavior |
//   | 1st | yes | no  | use file; persist to .loki/generated-prd.md, source=user |
//   | 1st | no  | no  | codebase-analysis generates the PRD, source=generated     |
//   | 2nd+| no  | yes | continue from persisted PRD (reuse; generated may update  |
//   |     |     |     |   on drift, user never)                                   |
//   | 2nd+| yes | yes | new file overwrites the PRD, source reset to user         |
//
// LOCK 1: canonical PRD path is <lokiDir>/generated-prd.md. User content is
//   persisted INTO it; provenance is recorded in .loki/state/prd-signature.json
//   via the `source` field.
// LOCK 2: user PRDs resolve to reuse/user_owned, NEVER update. source=user is
//   stamped at persist; decideGeneratedPrdAction short-circuits to user_owned
//   when source=user (except --fresh-prd/LOKI_PRD_REGEN). Signature-diff
//   `update` stays scoped to source=generated.
//
// PARITY NOTES (for integrator reconciliation against Agent C's bash schema):
//   - prd_sha and the git-case signature are BYTE-PARITY with bash:
//       prd_sha       = sha256(file content) truncated to first 16 hex chars,
//                       matching `_loki_hash_stdin` (shasum -a 256 | cut -c1-16).
//       signature     = "git:<HEAD>:<dirty>" for a git work tree, matching
//                       compute_codebase_signature's git branch. <dirty> is
//                       "clean" or the 16-char hash of the .loki/.git-filtered
//                       `git status --porcelain` output.
//   - The non-git content-signature tiers ("files:" / "files-sampled:") are
//     NOT ported here. They are only consumed by the source=generated
//     reuse-vs-update comparison, and on the Bun route the generated-PRD
//     persist + signature compare is owned by the bash post-iteration hook
//     (persist_prd_signature_if_present). For a non-git tree we write a
//     documented "files-bun:<sha256-of-listing-paths>" placeholder so the field
//     is present and honest; the integrator should reconcile this against Agent
//     C's exact tier output if Bun ever owns generated-PRD persistence. It does
//     not affect the user-owned path (which never compares signatures).
//   - NEW fields beyond the committed bash schema, added by this feature on
//     BOTH routes: `source` ("user"|"generated") and `origin_path` (set when
//     source=user). Field names here MUST match Agent C's bash writer exactly.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { atomicWriteFileSync } from "./state.ts";

// --- public types ----------------------------------------------------------

export type PrdSource = "user" | "generated";

// Decision returned by decideGeneratedPrdAction. Mirrors the bash echo values
// of decide_generated_prd_action (autonomy/run.sh:4892).
export type GeneratedPrdAction = "reuse" | "update" | "user_owned" | "generate";

// Schema of .loki/state/prd-signature.json. Field names are byte-locked to the
// bash writer (persist_prd_signature_if_present, autonomy/run.sh:5046-5053) plus
// the two NEW provenance fields (source, origin_path) this feature adds on both
// routes.
export interface PrdSignature {
  signature: string;
  generated_at: string; // ISO-8601 with trailing Z (UTC)
  prd_path: string; // always ".loki/generated-prd.md"
  prd_sha: string;
  mode: string; // "git" | "files"
  loki_version?: string;
  source?: PrdSource;
  origin_path?: string; // set only when source === "user"
}

export interface ResolvePrdOpts {
  // The PRD path the user passed (file arg), if any.
  prdPath?: string;
  // Working directory for the run (defaults to process.cwd()).
  cwd?: string;
  // Override for the .loki dir (defaults to <cwd>/.loki, honoring LOKI_DIR).
  lokiDirOverride?: string;
  // Optional logger; defaults to a no-op so this helper is silent in tests.
  log?: (line: string) => void;
}

export interface ResolvePrdResult {
  // The PRD path the runner should use for this run. `undefined` means
  // codebase-analysis mode (no PRD): existing behavior.
  prdPath: string | undefined;
  // The action that was taken / decided (for logging + parity tests).
  action: GeneratedPrdAction | "user_persist" | "none";
}

// --- internal helpers (parity with bash) -----------------------------------

// 16-char SHA-256 hex digest of a buffer/string. Byte-parity with bash
// _loki_hash_stdin (autonomy/run.sh:4768): `shasum -a 256 | cut -c1-16`.
function hash16(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function resolveLokiDir(opts: ResolvePrdOpts): string {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.lokiDirOverride) return opts.lokiDirOverride;
  return process.env["LOKI_DIR"] ?? resolve(cwd, ".loki");
}

function generatedPrdPath(lokiDir: string): string {
  return resolve(lokiDir, "generated-prd.md");
}

function generatedPrdJsonPath(lokiDir: string): string {
  return resolve(lokiDir, "generated-prd.json");
}

function signaturePath(lokiDir: string): string {
  return resolve(lokiDir, "state", "prd-signature.json");
}

// True when a generated PRD (md or json) is present. Mirrors the bash
// `-f "$loki_dir/generated-prd.md" || -f .../generated-prd.json` checks.
function hasGeneratedPrd(lokiDir: string): boolean {
  return (
    existsSync(generatedPrdPath(lokiDir)) ||
    existsSync(generatedPrdJsonPath(lokiDir))
  );
}

// Content hash of the generated PRD file itself (not the codebase). Mirrors
// _loki_prd_file_hash (autonomy/run.sh:4869): prefers generated-prd.md, falls
// back to generated-prd.json, "" when neither exists.
function generatedPrdFileHash(lokiDir: string): string {
  const md = generatedPrdPath(lokiDir);
  const js = generatedPrdJsonPath(lokiDir);
  let f = "";
  if (existsSync(md)) f = md;
  else if (existsSync(js)) f = js;
  if (!f) return "";
  try {
    return hash16(readFileSync(f));
  } catch {
    return "";
  }
}

// Codebase signature. Byte-parity with compute_codebase_signature's git branch
// (autonomy/run.sh:4800-4862): "git:<HEAD>:<dirty>". For non-git trees we emit
// a documented "files-bun:<hash>" placeholder (see PARITY NOTES at the top of
// this file). Never throws.
function computeCodebaseSignature(dir: string): string {
  try {
    const inside = spawnSync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: dir, encoding: "utf8" },
    );
    if (inside.status === 0 && (inside.stdout || "").trim() === "true") {
      const headR = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        encoding: "utf8",
      });
      const head =
        headR.status === 0 && (headR.stdout || "").trim()
          ? (headR.stdout || "").trim()
          : "nohead";
      const statusR = spawnSync("git", ["status", "--porcelain"], {
        cwd: dir,
        encoding: "utf8",
      });
      const porcelain = (statusR.stdout || "")
        .split("\n")
        // Mirror bash: drop .loki/ and .git/ churn lines.
        // bash: grep -vE '(^...?\.loki/|/\.loki/| \.loki/|\.git/)'
        .filter((line) => {
          if (line === "") return false;
          if (/^...?\.loki\//.test(line)) return false;
          if (/\/\.loki\//.test(line)) return false;
          if (/ \.loki\//.test(line)) return false;
          if (/\.git\//.test(line)) return false;
          return true;
        })
        .join("\n");
      const dirty = porcelain === "" ? "clean" : hash16(porcelain);
      return `git:${head}:${dirty}`;
    }
  } catch {
    // fall through to the non-git placeholder
  }
  // Non-git placeholder. Documented as NOT byte-parity with bash's content
  // tiers; only the source=user path (which never compares this) writes it.
  return "files-bun:0000000000000000";
}

// Read the prd-signature.json, returning null on any error (missing/corrupt).
export function readPrdSignature(lokiDir: string): PrdSignature | null {
  const f = signaturePath(lokiDir);
  if (!existsSync(f)) return null;
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8"));
    if (parsed && typeof parsed === "object") return parsed as PrdSignature;
    return null;
  } catch {
    return null;
  }
}

// Whether a force-regen was requested. Mirrors bash precedence: --fresh-prd /
// --regen-prd set LOKI_PRD_REGEN=1 (autonomy/run.sh:4894).
function forceRegenRequested(): boolean {
  return process.env["LOKI_PRD_REGEN"] === "1";
}

// --- decision table (port of decide_generated_prd_action) ------------------

// Decide what to do with a previously generated PRD on a no-PRD run. Returns
// one of reuse | update | user_owned | generate. Never throws.
//
// Precedence (matches autonomy/run.sh:4892-4978 plus LOCK 2):
//   1. LOKI_PRD_REGEN=1 (--fresh-prd) -> generate.
//   2. no generated PRD present       -> generate (first run).
//   3. source === "user" (LOCK 2)     -> user_owned (use as-is, never update).
//   4. no signature file              -> update (have a PRD, no provenance).
//   5. empty stored signature         -> update.
//   6. recorded prd_sha differs from
//      the current file hash           -> user_owned (user hand-edited it).
//   7. signature == current codebase   -> reuse.
//   8. otherwise                       -> update.
export function decideGeneratedPrdAction(opts: {
  cwd?: string;
  lokiDirOverride?: string;
}): GeneratedPrdAction {
  const cwd = opts.cwd ?? process.cwd();
  const lokiDir = opts.lokiDirOverride ?? resolve(cwd, ".loki");

  // 1. force-regen wins over everything.
  if (forceRegenRequested()) return "generate";

  // 2. no generated PRD -> first run.
  if (!hasGeneratedPrd(lokiDir)) return "generate";

  const sig = readPrdSignature(lokiDir);

  // 3. LOCK 2: a user-owned PRD is always used as-is (precedence ABOVE the
  //    signature-diff logic, which is scoped to source=generated). Only
  //    --fresh-prd (handled above) overrides this.
  if (sig && sig.source === "user") return "user_owned";

  // 4. generated PRD present but no provenance file -> reconcile.
  if (!sig) return "update";

  const stored = typeof sig.signature === "string" ? sig.signature : "";
  // 5. empty stored signature -> update.
  if (stored === "") return "update";

  // 6. hand-edit detection: a recorded prd_sha that no longer matches the file
  //    means the user edited it -> user_owned (bash run.sh:4923-4928).
  const storedPrdSha = typeof sig.prd_sha === "string" ? sig.prd_sha : "";
  if (storedPrdSha !== "") {
    const curPrdSha = generatedPrdFileHash(lokiDir);
    if (curPrdSha !== "" && curPrdSha !== storedPrdSha) return "user_owned";
  }

  // 7/8. compare codebase signature.
  const current = computeCodebaseSignature(cwd);
  if (stored === current) return "reuse";

  // The bash route additionally treats a v7.32.3 / #171 stored-format upgrade
  // (3-field "files:" or "files-shallow:" prefix of the new format) as reuse.
  // The Bun route does not emit those legacy formats (it only writes git: or
  // files-bun:), so there is no stored legacy format to transition from here.
  // If a bash-written legacy "files:" signature is read on the Bun route, this
  // falls to "update", which is the safe (re-reconcile) direction and matches
  // bash's behavior when its own upgrade-prefix check does not apply.
  return "update";
}

// --- user-PRD persistence (port of the Agent-C run_autonomous branch) ------

// Persist an explicit user-provided PRD into <lokiDir>/generated-prd.md and
// stamp prd-signature.json with source:"user". Atomic. Mirrors the bash
// user-PRD persistence branch described in the plan (LOCK 1 + LOCK 2):
//   mkdir -p .loki .loki/state; atomic copy origin -> generated-prd.md;
//   write prd-signature.json {source:user, prd_sha, generated_at, signature,
//   origin_path}; repoint prd_path to the generated path.
function persistUserPrd(
  originPath: string,
  lokiDir: string,
  cwd: string,
  log: (line: string) => void,
): string {
  mkdirSync(lokiDir, { recursive: true });
  mkdirSync(resolve(lokiDir, "state"), { recursive: true });

  const dest = generatedPrdPath(lokiDir);
  // Atomic copy: write to a per-process tmp then rename into place, so a
  // concurrent reader never sees a half-written PRD.
  //
  // v7.68 bug-fix: the prior implementation read the tmp into a Buffer and
  // wrote it back via atomicWriteFileSync(dest, content.toString("binary")).
  // That round-trips the bytes through latin1 (binary) and back out as utf8,
  // which CORRUPTS any PRD containing multi-byte UTF-8 (smart quotes, accents,
  // emoji, CJK). The persisted generated-prd.md then differed from the source
  // file, and its hash no longer matched the recorded prd_sha on the next run.
  // tmp and dest live in the same directory (lokiDir), so a plain rename(2) is
  // atomic on POSIX and byte-exact -- no string transcoding involved.
  const tmp = `${dest}.tmp.${process.pid}`;
  copyFileSync(originPath, tmp);
  // Read the exact bytes for the prd_sha hash BEFORE the rename consumes tmp.
  const content = readFileSync(tmp);
  renameSync(tmp, dest);

  const prdSha = hash16(content);
  const signature = computeCodebaseSignature(cwd);
  const mode = signature.startsWith("git:") ? "git" : "files";
  const generatedAt = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z"); // bash emits second-resolution ...Z; keep ms-trim

  const rec: PrdSignature = {
    signature,
    generated_at: generatedAt,
    prd_path: ".loki/generated-prd.md",
    prd_sha: prdSha,
    mode,
    source: "user",
    origin_path: originPath,
  };
  atomicWriteFileSync(signaturePath(lokiDir), JSON.stringify(rec));
  log(`[runner] PRD: persisted user file -> .loki/generated-prd.md (source=user)`);
  return dest;
}

// --- public entrypoint ------------------------------------------------------

// Resolve the PRD path for a run, persisting/reusing the generated PRD as
// needed. Returns the path the runner should use (undefined = codebase-analysis
// mode). Never throws; on any unexpected error it falls back to the input
// prdPath so the run is never blocked by reuse logic.
export function resolvePrdForRun(opts: ResolvePrdOpts): ResolvePrdResult {
  const log = opts.log ?? (() => {});
  const cwd = opts.cwd ?? process.cwd();
  const lokiDir = resolveLokiDir(opts);
  const generated = generatedPrdPath(lokiDir);

  try {
    const given = opts.prdPath;
    const givenNonEmpty = typeof given === "string" && given !== "";

    // Case A: user provided a real file that is NOT already the canonical
    // generated path -> persist it (1st-run-with-file OR new-file-overwrite).
    if (givenNonEmpty) {
      const givenResolved = resolve(cwd, given);
      const isAlreadyGenerated =
        givenResolved === generated ||
        given === generated ||
        given.endsWith(".loki/generated-prd.md");
      if (!isAlreadyGenerated && existsSync(given) && statSync(given).isFile()) {
        const dest = persistUserPrd(given, lokiDir, cwd, log);
        return { prdPath: dest, action: "user_persist" };
      }
      // Given path is already the generated PRD, or is not a real file: use it
      // as-is (mirrors bash, which only adds a persistence branch for new
      // non-generated files; everything else flows through unchanged).
      return { prdPath: given, action: "none" };
    }

    // Case B: no file arg, but a generated PRD exists -> decide reuse/update/
    // user_owned/generate.
    if (hasGeneratedPrd(lokiDir)) {
      const action = decideGeneratedPrdAction({
        cwd,
        lokiDirOverride: lokiDir,
      });
      if (action === "generate") {
        // Re-analyze: return undefined so the runner re-enters analysis mode.
        log("[runner] PRD: regenerating (action=generate)");
        return { prdPath: undefined, action };
      }
      // reuse | update | user_owned all continue from the persisted PRD path.
      log(`[runner] PRD: reusing .loki/generated-prd.md (action=${action})`);
      return { prdPath: generated, action };
    }

    // Case C: no file arg and no generated PRD -> codebase-analysis mode
    // (existing behavior).
    return { prdPath: undefined, action: "none" };
  } catch (err) {
    // Never let reuse logic break a run. Fall back to the caller's prdPath.
    log(
      `[runner] PRD reuse resolution failed (non-fatal): ${
        (err as Error).message
      }`,
    );
    return { prdPath: opts.prdPath, action: "none" };
  }
}
