// Shared deterministic holdout (P12-05): modernize holds out oracle cases, engine10's Wall holds out acceptance tests.
// Selection is ranked by sha256(seed:id): no clock, file order or RNG. Held files live outside the repo (the implementer's cwd).
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { sealedWallDir } from "./check_result.ts";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Default Wall holdout ratio (D99 item 4, C-C4): on by default. LOKI_WALL_HOLDOUT=0 or LOKI_WALL_HOLDOUT_RATIO=0 opts out; LOKI_WALL_HOLDOUT_RATIO=0.4 holds out ~40%, capped at 0.9. An unparseable value falls back to the default, never to off. */
export const WALL_HOLDOUT_DEFAULT_RATIO = 0.2;
export function wallHoldoutRatio(env: NodeJS.ProcessEnv = process.env): number {
  if (env["LOKI_WALL_HOLDOUT"]?.trim() === "0") return 0;
  const raw = env["LOKI_WALL_HOLDOUT_RATIO"]; if (raw === undefined || raw.trim() === "") return WALL_HOLDOUT_DEFAULT_RATIO;
  if (!/^(\d+\.?\d*|\.\d+)$/.test(raw.trim())) return WALL_HOLDOUT_DEFAULT_RATIO; // decimal only: hex (0x1), exponent, sign and words are garbage
  const r = Number(raw); return Number.isFinite(r) ? Math.min(r, 0.9) : WALL_HOLDOUT_DEFAULT_RATIO;
}

/** Deterministic split ranked by sha256(seed:id). Count is max(1, round(ratio*N)) for N >= min, else none; ids keep input order. */
export function holdoutSplit(seed: string, ids: string[], opts: { ratio: number; min: number }): string[] {
  if (opts.ratio <= 0 || ids.length < Math.max(1, opts.min)) return [];
  const ranked = ids.map((id) => ({ id, d: sha(`${seed}:${id}`) })).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const held = new Set(ranked.slice(0, Math.max(1, Math.round(opts.ratio * ids.length))).map((r) => r.id));
  return ids.filter((id) => held.has(id));
}

/** A verify check that runs a held-out test (holdout:N) or reports a bad store (holdout:store). Its text, name and command must never reach fix-stage input. */
export const isHoldoutCheck = (name: string): boolean => name.startsWith("holdout:");

/** The one exact store path for a run (never a glob). */
export const holdoutDirFor = (runId: string, repoDir: string): string => join(tmpdir(), `loki-e10-holdout-${sha(`${runId}:${repoDir}`).slice(0, 16)}`);
/** Where the authored Wall's sealed copies wait, outside the repo tree, until the install step before verify (an implement session must not be able to read them from <repo>/.loki/runs). */
export const sealStageDir = (runId: string, repoDir: string): string => join(tmpdir(), `loki-e10-wallseal-${sha(`${runId}:${repoDir}`).slice(0, 16)}`);
/** Install step: moves the staged sealed copies to <runDir>/wall, where seal and mutation proof read them. Returns false when nothing was staged (the caller names the reason). */
export function publishSealed(runId: string, repoDir: string, runDir: string): boolean { const from = sealStageDir(runId, repoDir); if (!existsSync(from)) return false; mkdirSync(runDir, { recursive: true }); rmSync(sealedWallDir(runDir), { recursive: true, force: true }); cpSync(from, sealedWallDir(runDir), { recursive: true }); rmSync(from, { recursive: true, force: true }); return true; }
/** Run-end cleanup: removes only this run's stores. */
export function removeHoldout(runId: string, repoDir: string): void { rmSync(holdoutDirFor(runId, repoDir), { recursive: true, force: true }); rmSync(sealStageDir(runId, repoDir), { recursive: true, force: true }); }

interface HoldoutManifest { targetDir: string; files: { name: string; runner: string; sha256: string }[]; }
const MANIFEST = "manifest.json";

/** Wall holdout is active only with 5 or more eligible Wall checks (D99 item 4), so the implementer keeps at least 4 visible ones. */
export const WALL_HOLDOUT_MIN = 5;

/** Moves the held-out subset of srcDir's files out of the Wall author dir into a private dir under the OS tmp (never the repo), with a manifest. Returns the dir and the held names, or null when nothing is held. */
export function stashHoldout(o: { runId: string; repoDir: string; srcDir: string; targetDir: string; names: string[]; runnerOf: (name: string) => string | null }): { dir: string; names: Set<string> } | null {
  const eligible = o.names.filter((n) => o.runnerOf(n) !== null);
  const held = holdoutSplit(o.runId, eligible, { ratio: wallHoldoutRatio(), min: WALL_HOLDOUT_MIN });
  if (held.length === 0) return null;
  const dir = holdoutDirFor(o.runId, o.repoDir);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = held.map((name) => {
    copyFileSync(join(o.srcDir, name), join(dir, name)); rmSync(join(o.srcDir, name), { force: true });
    return { name, runner: o.runnerOf(name)!, sha256: sha(readFileSync(join(dir, name), "utf8")) };
  });
  writeFileSync(join(dir, MANIFEST), JSON.stringify({ targetDir: o.targetDir, files } satisfies HoldoutManifest));
  return { dir, names: new Set(held) };
}

/** Verify time only: copies the held files into the Wall target dir under neutral names and returns their TestRefs. A missing dir, manifest or file, or a sha mismatch, yields a `missing` entry so the caller fails closed. */
export function stageHoldout(dir: string, repoDir: string): { tests: { runner: string; path: string }[]; missing: string[]; cleanup: () => void } {
  const put: string[] = [], tests: { runner: string; path: string }[] = [], missing: string[] = [];
  let man: HoldoutManifest | null = null;
  try { man = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as HoldoutManifest; } catch { /* handled below */ }
  if (!man) return { tests, missing: [`holdout store unreadable: ${basename(dir)}`], cleanup: () => {} };
  mkdirSync(man.targetDir, { recursive: true });
  man.files.forEach((f, i) => {
    const src = join(dir, f.name);
    if (!existsSync(src) || sha(readFileSync(src, "utf8")) !== f.sha256) { missing.push(`holdout ${i + 1} missing or altered`); return; }
    const dest = join(man.targetDir, `loki_wall_holdout_${i + 1}${f.name.slice(f.name.indexOf("."))}`);
    copyFileSync(src, dest); put.push(dest); tests.push({ runner: f.runner, path: relative(repoDir, dest) });
  });
  return { tests, missing, cleanup: () => { for (const p of put) rmSync(p, { force: true }); } };
}

/** C-C4b-c-b: private triage channel. The real reason a holdout check or store failed goes to <runDir>/holdout-triage.jsonl (0600), never to an event, a stage result or any agent-visible record. An operator reads it from .loki state. Best effort: a write failure never affects the run. */
export const HOLDOUT_TRIAGE_FILE = "holdout-triage.jsonl";
export function recordHoldoutTriage(runDir: string, entry: { check: string; result: string; reason: string }): void {
  try { mkdirSync(runDir, { recursive: true }); appendFileSync(join(runDir, HOLDOUT_TRIAGE_FILE), JSON.stringify(entry) + "\n", { mode: 0o600 }); } catch { /* triage is best effort */ }
}
