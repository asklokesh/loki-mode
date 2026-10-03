// D61-11 (D71): unit run mode. One unit of a parallel group runs as a full v10 run whose write set is an advisory scope fence,
// whose brief carries only its own context pack (no transcript, no model-driven exploration) and whose token budget
// is fixed by the decomposer. Active only when LOKI_SPEED=1 and LOKI_UNIT_SPEC names a readable, valid spec file;
// otherwise every export is inert and the callers behave byte-identically. Data and fence only, no verdict logic.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Staged } from "../../e10ext/commit_filter.ts";

export interface UnitSpec { id: string; writeSet: string[]; pack: string[]; tokenBudget: number }

export const MAX_SPEC_BYTES = 1024 * 1024;
export const MAX_TOKEN_BUDGET = 1e9;
const norm = (p: string): string => p.replace(/^\.\//, "");
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x1f\x7f]/;
const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string" && !CTRL.test(x)) ? (v as string[]).map(norm) : null);

/** Bounded, non-blocking read of a regular file: lstat (no symlink, regular, size cap), then open O_NONBLOCK|O_NOFOLLOW and re-check by fstat. */
function readBounded(path: string): string | null {
  const l = lstatSync(path);
  if (l.isSymbolicLink() || !l.isFile() || l.size > MAX_SPEC_BYTES) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_SPEC_BYTES) return null;
    const buf = Buffer.alloc(st.size + 1);
    let n = 0;
    for (;;) { const r = readSync(fd, buf, n, buf.length - n, null); if (r <= 0) break; n += r; if (n >= buf.length) return null; }
    return buf.subarray(0, n).toString("utf8");
  } finally { closeSync(fd); }
}

function parseText(txt: string): UnitSpec | null {
  try {
    const j = JSON.parse(txt) as Record<string, unknown>, ws = strs(j.writeSet), pack = strs(j.pack), tb = j.tokenBudget;
    if (typeof j.id !== "string" || !j.id || !ws || ws.length === 0 || !pack || typeof tb !== "number" || !Number.isFinite(tb) || !(tb > 0) || tb > MAX_TOKEN_BUDGET) return null;
    return { id: j.id, writeSet: ws, pack, tokenBudget: tb };
  } catch { return null; }
}
function parseSpec(path: string): UnitSpec | null {
  try { const txt = readBounded(path); return txt === null ? null : parseText(txt); } catch { return null; }
}

// Process-lifetime cache keyed by path: a spec (including a null from an invalid or missing one) is never re-read, so a fixed file needs a new process.
const memo = new Map<string, UnitSpec | null>();
/** The active unit spec, or null (speed off, no spec, unreadable or invalid: fail-safe to the ordinary run). Parsed once per path per process. */
export function unitSpec(env: NodeJS.ProcessEnv = process.env): UnitSpec | null {
  const path = env["LOKI_UNIT_SPEC"], frozen = env["LOKI_UNIT_SPEC_FROZEN"];
  if (env["LOKI_SPEED"] === "0" || !path) return null;
  if (frozen !== undefined) return frozen.length <= MAX_SPEC_BYTES ? parseText(frozen) : null; // frozen at intake: the file is never consulted again
  if (!memo.has(path)) memo.set(path, parseSpec(path));
  return memo.get(path) ?? null;
}

/** A path is inside the write set when it equals an entry or sits under an entry that ends in "/". */
export const inWriteSet = (spec: UnitSpec, f: string): boolean => spec.writeSet.some((w) => (w.endsWith("/") ? f.startsWith(w) : f === w));

/** The brief context for a unit: only its pack files (repo-relative, no traversal). null when unit mode is off. */
export function unitBrief(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = unitSpec(env);
  if (!s) return null;
  const files = s.pack.filter((f) => !/^([/~]|[A-Za-z]:[\\/])/.test(f) && !f.split(/[\\/]/).includes(".."));
  return files.length ? `Relevant files:\n${files.join("\n")}` : "";
}

/** D76: advisory. Files staged outside the write set (tests and new files included), to be flagged as outside stated scope; nothing is
 *  reverted. null when unit mode is off. */
export function unitFlags(staged: Staged[], env: NodeJS.ProcessEnv = process.env, pre: Record<string, string> = {}): string[] | null {
  const s = unitSpec(env);
  return s ? staged.filter(({ f }) => !inWriteSet(s, f) && !Object.hasOwn(pre, f)).map(({ f }) => f) : null;
}

/** Env additions for the unit's worker. Never loosens or disables the run cap: result is min(existing, max(0.01, budget cost)), a plain
 *  decimal rounded up. A non-finite or non-positive rate leaves the existing cap unchanged (no override when there is none). */
export function unitCapEnv(s: UnitSpec, usdPerMillionTokens: number, existingCapUsd?: number): Record<string, string> {
  const ex = typeof existingCapUsd === "number" && Number.isFinite(existingCapUsd) && existingCapUsd > 0 ? existingCapUsd : null;
  const fmt = (n: number): string => (Math.ceil(Math.min(n, 1e15) * 1e6) / 1e6).toFixed(6).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  const keep = (e: number): string => (/^\d+(\.\d+)?$/.test(String(e)) ? String(e) : fmt(e)); // the existing cap, unchanged when plain
  const cost = (s.tokenBudget * usdPerMillionTokens) / 1e6;
  if (!Number.isFinite(usdPerMillionTokens) || !(usdPerMillionTokens > 0) || !Number.isFinite(cost)) return ex === null ? {} : { LOKI_E10_MAX_COST_USD: ex > 1e15 ? fmt(ex) : keep(ex) };
  const v = Math.max(0.01, cost);
  return { LOKI_E10_MAX_COST_USD: ex !== null && ex <= v && ex <= 1e15 ? keep(ex) : fmt(ex === null ? v : Math.min(ex, v)) };
}

export const UNIT_NOT_PROVEN = (why: string): string => `NOT PROVEN: unit mode was requested but ${why}; no unfenced run was started`;
export const DEFAULT_UNIT_USD_PER_MTOK = 15;

/** Intake for a unit run, before any worker spawns. null when unit mode is not requested (LOKI_SPEED=1 and LOKI_UNIT_SPEC set).
 *  Otherwise fails closed (ok false + a NOT PROVEN note) when the spec is missing, invalid, or lives inside the repo/worktree, where the
 *  agent could rewrite its own write set. On success returns env additions: the spec frozen as read now, and the cost cap from unitCapEnv
 *  applied over the run's existing cap (never loosened). */
export function unitIntake(env: NodeJS.ProcessEnv, repoDir: string, existingCapUsd?: number): { ok: true; env: Record<string, string> } | { ok: false; note: string } | null {
  const path = env["LOKI_UNIT_SPEC"];
  if (env["LOKI_SPEED"] === "0" || !path) return null;
  const bad = (why: string) => ({ ok: false as const, note: UNIT_NOT_PROVEN(why) });
  let txt: string | null;
  try {
    const real = realpathSync(resolve(path)), root = realpathSync(repoDir), rel = relative(root, real);
    if (!(rel === ".." || rel.startsWith("../") || isAbsolute(rel))) return bad("its spec file is inside the worktree where the agent could edit it");
    txt = readBounded(real);
  } catch { return bad("its spec file is missing or unreadable"); }
  const spec = txt === null ? null : parseText(txt);
  if (txt === null || !spec) return bad("its spec file is invalid");
  const rate = Number(env["LOKI_UNIT_USD_PER_MTOK"] ?? DEFAULT_UNIT_USD_PER_MTOK);
  return { ok: true, env: { LOKI_UNIT_SPEC_FROZEN: txt, ...unitCapEnv(spec, rate, existingCapUsd) } };
}
