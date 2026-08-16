// loki-ts/src/runner/exec_manifest.ts -- harness intelligence feature 7.
//
// PARALLEL EXECUTION MANIFEST. Before fanning work out across worktrees, declare
// what each stream is allowed to touch and what "done" means for it. Then
// validate every returned result against that declaration.
//
// The manifest exists because parallel streams fail in two specific ways that a
// generic orchestrator cannot see:
//
//   OVERLAPPING SCOPES -- two streams editing the same path produce a merge
//                         conflict at best and a silently-lost edit at worst.
//                         Overlapping streams are SERIALIZED, not run together.
//   STALE BASE SHA     -- a stream that branched from SHA X and returns after
//                         HEAD moved to Y was reasoning about code that no
//                         longer exists. Its result is REJECTED, not merged.
//
// OWNERSHIP:
//   - The manifest owns worktree/result VALIDATION.
//   - Exactly ONE integration owner per manifest performs merges. The recovery
//     policy (feature 8) does NOT own merges.
//   - The manifest READS the repo-profile snapshot (feature 6) and never writes
//     learned memory. This matters concretely: create_worktree
//     (autonomy/run.sh:5205) does `cp -r .loki` into each worktree, so a
//     worktree-local profile write would fork the profile per stream.
//
// DEFAULT OFF (LOKI_EXEC_MANIFEST). With the flag unset, planManifest() returns
// null and no manifest is planned, written, or validated.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lokiDir } from "../util/paths.ts";
import { atomicWriteFileSync } from "./state.ts";

export const MANIFEST_SCHEMA_VERSION = 1;

export interface StreamSpec {
  readonly name: string;
  /** Repo-relative path prefixes this stream may modify. Must be non-empty. */
  readonly paths: readonly string[];
  /** What must be true for this stream's result to count as done. */
  readonly acceptance: string;
}

export interface PlannedStream extends StreamSpec {
  /**
   * Execution wave. Streams in the same wave run in parallel; a stream whose
   * scope overlaps an earlier stream is pushed to a later wave (serialized).
   */
  readonly wave: number;
}

export interface ExecManifest {
  readonly schema_version: number;
  /** Git SHA every stream branches from. A result against a different HEAD is stale. */
  readonly base_sha: string;
  /** The single identity permitted to integrate results. */
  readonly integration_owner: string;
  readonly streams: readonly PlannedStream[];
  /** Read-only snapshot of the repo profile, if one was fresh at plan time. */
  readonly profile_snapshot: string;
}

export function manifestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["LOKI_EXEC_MANIFEST"] === "1";
}

// Do two path scopes overlap? A scope is a repo-relative prefix. "src" overlaps
// "src/runner" (containment), and "src" overlaps "src" (identity), but "src"
// does NOT overlap "srcery" -- which is why this compares on a SEGMENT boundary
// and not with a bare startsWith. A bare prefix test would serialize unrelated
// streams, and the cost of that mistake is losing the parallelism entirely.
export function scopesOverlap(a: string, b: string): boolean {
  const na = normalizeScope(a);
  const nb = normalizeScope(b);
  if (na === nb) return true;
  return na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

function normalizeScope(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+$/, "");
}

function streamsOverlap(a: StreamSpec, b: StreamSpec): boolean {
  return a.paths.some((pa) => b.paths.some((pb) => scopesOverlap(pa, pb)));
}

export interface PlanOpts {
  readonly baseSha: string;
  readonly integrationOwner: string;
  readonly streams: readonly StreamSpec[];
  readonly profileSnapshot?: string;
  readonly env?: NodeJS.ProcessEnv;
}

// planManifest -- assign waves so that no two streams in the same wave have
// overlapping path scopes.
//
// Greedy first-fit over waves. Deterministic: streams keep their input order,
// and each takes the lowest wave with no conflict. Greedy is not optimal
// (optimal is graph colouring) but it is predictable, and a reader can verify
// any assignment by hand. ponytail: greedy first-fit, revisit if wave counts
// ever actually matter.
export function planManifest(opts: PlanOpts): ExecManifest | null {
  const env = opts.env ?? process.env;
  if (!manifestEnabled(env)) return null;

  for (const s of opts.streams) {
    if (s.paths.length === 0) {
      throw new Error(`exec_manifest: stream "${s.name}" declares no path scope`);
    }
    if (s.acceptance.trim() === "") {
      throw new Error(`exec_manifest: stream "${s.name}" declares no acceptance criteria`);
    }
  }

  const planned: PlannedStream[] = [];
  for (const s of opts.streams) {
    let wave = 0;
    // Advance until this stream conflicts with nothing already in the wave.
    for (;;) {
      const conflict = planned.some((p) => p.wave === wave && streamsOverlap(p, s));
      if (!conflict) break;
      wave += 1;
    }
    planned.push({ ...s, wave });
  }

  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    base_sha: opts.baseSha,
    integration_owner: opts.integrationOwner,
    streams: planned,
    profile_snapshot: opts.profileSnapshot ?? "",
  };
}

function manifestPath(lokiDirOverride?: string): string {
  return resolve(lokiDirOverride ?? lokiDir(), "manifest", "exec-manifest.json");
}

export function writeManifest(m: ExecManifest, lokiDirOverride?: string): string {
  const target = manifestPath(lokiDirOverride);
  mkdirSync(resolve(target, ".."), { recursive: true });
  atomicWriteFileSync(target, JSON.stringify(m, null, 2) + "\n");
  return target;
}

export function readManifest(lokiDirOverride?: string): ExecManifest | null {
  const target = manifestPath(lokiDirOverride);
  if (!existsSync(target)) return null;
  try {
    const m = JSON.parse(readFileSync(target, "utf8")) as ExecManifest;
    // Unknown schema version => absent, never an error.
    if (!m || m.schema_version !== MANIFEST_SCHEMA_VERSION) return null;
    return m;
  } catch {
    return null;
  }
}

export interface StreamResult {
  readonly name: string;
  /** SHA the stream actually branched from. */
  readonly baseSha: string;
  /** Repo-relative paths the stream modified. */
  readonly changedPaths: readonly string[];
  /** Did the stream report its acceptance criteria met? */
  readonly acceptanceMet: boolean;
}

export type ResultVerdict =
  | "accepted"
  | "rejected_unknown_stream"
  | "rejected_stale_base"
  | "rejected_out_of_scope"
  | "rejected_acceptance";

export interface ValidationOutcome {
  readonly verdict: ResultVerdict;
  readonly detail: string;
}

// validateResult -- decide whether a stream's result may be integrated.
//
// Every rejection reason is distinct and reported, because a manifest that
// rejects without saying which rule fired is unactionable. Order matters: an
// unknown stream is checked before base SHA, since we cannot look up its scope.
export function validateResult(m: ExecManifest, r: StreamResult): ValidationOutcome {
  const spec = m.streams.find((s) => s.name === r.name);
  if (spec === undefined) {
    return { verdict: "rejected_unknown_stream", detail: `stream "${r.name}" is not in the manifest` };
  }

  // STALE BASE SHA. The stream reasoned about a tree that HEAD has moved past.
  if (r.baseSha !== m.base_sha) {
    return {
      verdict: "rejected_stale_base",
      detail: `stream "${r.name}" branched from ${r.baseSha}, manifest base is ${m.base_sha}`,
    };
  }

  // OUT OF SCOPE. Every changed path must fall inside a declared scope.
  for (const changed of r.changedPaths) {
    const inScope = spec.paths.some((p) => scopesOverlap(p, changed));
    if (!inScope) {
      return {
        verdict: "rejected_out_of_scope",
        detail: `stream "${r.name}" modified "${changed}" outside its declared scope`,
      };
    }
  }

  if (!r.acceptanceMet) {
    return {
      verdict: "rejected_acceptance",
      detail: `stream "${r.name}" did not meet acceptance: ${spec.acceptance}`,
    };
  }

  return { verdict: "accepted", detail: `stream "${r.name}" validated against ${m.base_sha}` };
}

// May `who` integrate results for this manifest? Exactly one owner, by design:
// two integrators racing on the same set of results is the failure this prevents.
export function isIntegrationOwner(m: ExecManifest, who: string): boolean {
  return m.integration_owner === who && who !== "";
}
