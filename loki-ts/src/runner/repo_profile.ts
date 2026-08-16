// loki-ts/src/runner/repo_profile.ts -- harness intelligence feature 6.
//
// A LOCAL, EVIDENCE-BACKED repository profile: durable facts about this repo
// (build command, test command, language, package manager) derived ONLY from
// files that exist in the repo, each carrying the path that proves it.
//
// Three properties do the real work here:
//
//   CONTENT HASH  -- the profile records a hash over the evidence inputs. If a
//                    manifest file changes, the hash no longer matches and the
//                    profile is stale. This is what stops a profile from
//                    asserting "the test command is X" after someone changed it.
//   FRESHNESS     -- a TTL, independently of the hash, so a profile cannot
//                    silently outlive the repo state it was derived from.
//   BOUNDED       -- the prompt fragment is hard-capped in characters. An
//                    unbounded profile is a prompt-cache buster and a token leak.
//
// PRIVACY / NAMESPACE. The profile is namespaced per repository and records only
// facts derived from tracked repo files. It never records absolute host paths,
// environment values, or file CONTENTS -- only which file proved which fact.
// See redactEvidence() below, which is the single enforcement point.
//
// DEFAULT OFF (LOKI_REPO_PROFILE). With the flag unset, profileFragment()
// returns "" and nothing is read or written, so build_prompt parity is exact.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { basename, resolve, isAbsolute } from "node:path";
import { lokiDir } from "../util/paths.ts";
import { atomicWriteFileSync } from "./state.ts";

// Bumped when the record shape changes. An unrecognized version is treated as
// ABSENT, never as an error -- an older binary reading a newer artifact must
// degrade to default-off behavior rather than crash.
export const PROFILE_SCHEMA_VERSION = 1;

const DEFAULT_TTL_SECONDS = 86_400; // 24h
const DEFAULT_MAX_CHARS = 2_000;
const TRUNCATION_MARKER = "\n- (truncated)";

export interface ProfileFact {
  readonly key: string;
  readonly value: string;
  /** Repo-relative path of the file that proves this fact. Never absolute. */
  readonly evidence: string;
}

export interface RepoProfile {
  readonly schema_version: number;
  /** Namespace = repo identity. Basename only; never an absolute host path. */
  readonly namespace: string;
  /** Hash over the evidence inputs. Mismatch => stale. */
  readonly content_hash: string;
  /** UTC ISO-8601. */
  readonly generated_at: string;
  readonly facts: readonly ProfileFact[];
}

// Evidence sources: (repo-relative file, fact extractor). Only files that
// actually exist contribute, so every fact is provably backed.
const EVIDENCE_FILES = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Makefile",
] as const;

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function profileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["LOKI_REPO_PROFILE"] === "1";
}

// redactEvidence -- the single privacy enforcement point.
//
// An evidence path must be REPO-RELATIVE. An absolute path leaks the host
// layout (usernames, org names, directory structure) into a prompt and into a
// durable artifact. We reduce anything absolute to its basename rather than
// dropping it, so the fact keeps its proof without the leak.
export function redactEvidence(path: string, repoRoot: string): string {
  if (!isAbsolute(path)) return path;
  const root = resolve(repoRoot);
  const abs = resolve(path);
  if (abs.startsWith(root + "/")) return abs.slice(root.length + 1);
  return basename(abs);
}

// Hash the evidence INPUTS (path + size + mtime), not their contents. Contents
// hashing would be more precise and would also mean reading every manifest on
// every check; path+size+mtime detects the edits that matter at a fraction of
// the cost. ponytail: size+mtime, switch to content hashing if a same-size
// same-mtime edit ever shows up in practice.
function hashEvidence(repoRoot: string): string {
  const h = createHash("sha256");
  for (const rel of EVIDENCE_FILES) {
    const p = resolve(repoRoot, rel);
    if (!existsSync(p)) continue;
    try {
      const st = statSync(p);
      h.update(`${rel}:${st.size}:${Math.floor(st.mtimeMs)}\n`);
    } catch {
      // Unreadable evidence file contributes nothing rather than throwing.
    }
  }
  return h.digest("hex");
}

function extractFacts(repoRoot: string): ProfileFact[] {
  const facts: ProfileFact[] = [];
  const pkgPath = resolve(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      // Record that a script EXISTS, not its body: a script body can contain
      // tokens, hostnames, or deploy targets. The name is the useful fact.
      for (const name of ["build", "test", "lint"]) {
        if (typeof scripts[name] === "string" && scripts[name] !== "") {
          facts.push({ key: `script.${name}`, value: name, evidence: "package.json" });
        }
      }
      facts.push({ key: "language", value: "javascript", evidence: "package.json" });
    } catch {
      // Malformed package.json yields no facts; never throws.
    }
  }
  for (const [rel, key, value] of [
    ["requirements.txt", "language", "python"],
    ["pyproject.toml", "language", "python"],
    ["Cargo.toml", "language", "rust"],
    ["go.mod", "language", "go"],
    ["Makefile", "build.system", "make"],
  ] as const) {
    if (existsSync(resolve(repoRoot, rel))) {
      facts.push({ key, value, evidence: rel });
    }
  }
  return facts;
}

function profilePath(lokiDirOverride?: string): string {
  return resolve(lokiDirOverride ?? lokiDir(), "profile", "repo-profile.json");
}

export interface BuildProfileOpts {
  readonly repoRoot: string;
  readonly lokiDirOverride?: string;
  readonly now?: Date;
}

// buildProfile -- derive and persist the profile. Caller decides when; this
// never self-triggers, so it cannot surprise a default-path run.
export function buildProfile(opts: BuildProfileOpts): RepoProfile {
  const root = resolve(opts.repoRoot);
  const facts = extractFacts(root).map((f) => ({
    ...f,
    evidence: redactEvidence(f.evidence, root),
  }));
  const profile: RepoProfile = {
    schema_version: PROFILE_SCHEMA_VERSION,
    // Namespace is the repo BASENAME, never the absolute path.
    namespace: basename(root),
    content_hash: hashEvidence(root),
    generated_at: (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    facts,
  };
  const target = profilePath(opts.lokiDirOverride);
  mkdirSync(resolve(target, ".."), { recursive: true });
  atomicWriteFileSync(target, JSON.stringify(profile, null, 2) + "\n");
  return profile;
}

export type ProfileStatus = "fresh" | "absent" | "stale_hash" | "stale_ttl" | "unreadable";

export interface ReadProfileResult {
  readonly status: ProfileStatus;
  readonly profile: RepoProfile | null;
}

// readProfile -- load and VALIDATE. A profile is usable only when it parses,
// its schema version is recognized, its content hash still matches the repo,
// and it is within TTL. Every other outcome is a status, never an exception.
export function readProfile(opts: BuildProfileOpts & { env?: NodeJS.ProcessEnv }): ReadProfileResult {
  const env = opts.env ?? process.env;
  const root = resolve(opts.repoRoot);
  const target = profilePath(opts.lokiDirOverride);
  if (!existsSync(target)) return { status: "absent", profile: null };

  let parsed: RepoProfile;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8")) as RepoProfile;
  } catch {
    return { status: "unreadable", profile: null };
  }
  // Forward compatibility: an unknown schema version is ABSENT, not an error.
  if (!parsed || parsed.schema_version !== PROFILE_SCHEMA_VERSION) {
    return { status: "absent", profile: null };
  }

  if (parsed.content_hash !== hashEvidence(root)) {
    return { status: "stale_hash", profile: parsed };
  }

  const ttl = num(env, "LOKI_REPO_PROFILE_TTL_SECONDS", DEFAULT_TTL_SECONDS);
  const generated = Date.parse(parsed.generated_at);
  const now = (opts.now ?? new Date()).getTime();
  if (!Number.isFinite(generated) || now - generated > ttl * 1000) {
    return { status: "stale_ttl", profile: parsed };
  }

  return { status: "fresh", profile: parsed };
}

// profileFragment -- the ONLY function that produces prompt text.
//
// Returns "" when the feature is off, or when the profile is anything other
// than fresh. A stale profile injecting stale facts is worse than no profile:
// it is confidently wrong. Output is hard-capped; over-cap is truncated at a
// line boundary with an explicit marker, never silently.
export function profileFragment(
  opts: BuildProfileOpts & { env?: NodeJS.ProcessEnv },
): string {
  const env = opts.env ?? process.env;
  if (!profileEnabled(env)) return "";

  const { status, profile } = readProfile({ ...opts, env });
  if (status !== "fresh" || profile === null || profile.facts.length === 0) return "";

  const cap = num(env, "LOKI_REPO_PROFILE_MAX_CHARS", DEFAULT_MAX_CHARS);
  const header = "Repository profile (evidence-backed, local):";
  const lines = profile.facts.map((f) => `- ${f.key}=${f.value} (from ${f.evidence})`);

  let out = header;
  let truncated = false;
  for (const line of lines) {
    // +1 for the newline. Reserve room for the truncation marker so the marker
    // itself can never push the result over the cap.
    if (out.length + line.length + 1 > cap - TRUNCATION_MARKER.length) {
      truncated = true;
      break;
    }
    out += "\n" + line;
  }
  if (truncated) out += TRUNCATION_MARKER;
  return out;
}
