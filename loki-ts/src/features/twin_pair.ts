// PROTO twin-site pair inputs (LOKI_E10_TWIN_PAIR=1, off by default). New file: nothing in loki-ts finds type-dispatch
// chains or derives pair inputs; the nearest neighbour (site_ledger interactionPairs on proto/micro-agent-decomposition)
// asks a model to write the pair test. Fold target if adopted: the verify stage, as one more check on the changed
// functions, with its finding routed to the fix brief (and, before implement, exec-spec's "must keep passing" list).
//
// Deterministic, no model. Two sites of one function that test the same subject's type (a strict assertion and an
// errors.As, two isinstance branches, a type switch's cases) decide, by their order, which branch takes a value both
// accept. The language engines in autonomy/lib/twinpair (Python: AST plus runtime predicates; Go: a generated probe
// test) derive candidate inputs, run the real function and precedence variants of it, and report observations.
// This module decides which candidates are pair inputs and gives the verdicts:
//   pre  (derived on the base tree): x was dispatched by site j at base, and broadening an earlier site i (or swapping
//        two sites that both take x) changes x's outcome. Red when the changed tree reproduces exactly the variant's
//        outcome on a component where the variant differs from base ("inverted").
//   post (derived on the changed tree): two sites of the changed chain take x. Red when x's outcome differs from base
//        and restoring precedence on the changed tree (swap back, or narrow the earlier site) gives base's outcome
//        again ("precedence-regression"), and x was dispatched by the base chain at all.
// Anything else that changed is advisory ("changed"): a guard never fails a change it cannot attribute to precedence.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../util/paths.ts";

export const twinPairEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.LOKI_E10_TWIN_PAIR === "1";
export const TWIN_LIB = join(REPO_ROOT, "autonomy", "lib", "twinpair");
export const GO_PROBE_FILE = "loki_twinpair_probe_test.go";

export type Obs = Record<string, unknown>;
export interface ProbeSite { id: string; kind: string; line: number; src: string }
export interface ProbeVariant { id: string; kind: "broaden" | "narrow" | "swap" | "identity"; site: string; site2?: string | null; order: string[] }
export interface ProbeCand { key: string; src: string; preds: Record<string, boolean | null>; vpreds: Record<string, boolean | null>; obs: Record<string, Obs> }
export interface ProbeChain { lang: "py" | "go"; file: string; func: string; recv?: string; subject: string; loop?: string | null; line: number; sites: ProbeSite[]; order: string[]; variants: ProbeVariant[]; cands: ProbeCand[]; skipped?: string }
export interface Guard { lang: "py" | "go"; file: string; func: string; recv?: string; subject: string; loop?: string | null; line: number; mode: "pre" | "post"; src: string; variant: string; vkind: string; takenBy: string; movedTo: string; comps: string[]; ref: Obs; alt: Obs; sites: ProbeSite[] }
export interface Observed { key: string; missing?: boolean; build_error?: string; preds?: Record<string, boolean | null>; order?: string[]; obs?: { real?: Obs; real2?: Obs } }
export type PreVerdict = "kept" | "inverted" | "changed" | "unknown";
export type PostVerdict = "same-as-base" | "precedence-regression" | "changed" | "unhandled-at-base" | "unknown";
export interface TwinFinding { guard: Guard; verdict: PreVerdict | PostVerdict; red: boolean; detail: { comp: string; base: unknown; now: unknown }[]; text: string }

const norm = (v: unknown): string => JSON.stringify(v === undefined ? null : v);
const eq = (a: unknown, b: unknown): boolean => norm(a) === norm(b);
export const firstMatch = (order: string[], preds: Record<string, boolean | null>): string | null => order.find((s) => preds[s] === true) ?? null;
const IGNORED = new Set(["build_error"]);

/** Components where the variant's outcome differs from the real function's, counting only components that are stable
 *  across two real runs and that the faithful copy reproduces (so a difference comes from precedence, not from noise). */
export function sensitiveComps(c: ProbeCand, variant: string): string[] {
  const real = c.obs.real, real2 = c.obs.real2, ident = c.obs.identity, alt = c.obs[variant];
  if (!real || !real2 || !alt || real.build_error !== undefined || alt.build_error !== undefined) return [];
  const keys = new Set([...Object.keys(real), ...Object.keys(alt)].filter((k) => !IGNORED.has(k)));
  return [...keys].filter((k) => eq(real[k], real2[k]) && (!ident || eq(ident[k], real[k])) && !eq(real[k], alt[k])).sort();
}

/** Pair inputs and their guards. Pure: the same probe output always gives the same guards. */
export function selectGuards(chains: ProbeChain[], mode: "pre" | "post", maxPerChain = 6): Guard[] {
  const out: Guard[] = [];
  for (const ch of chains) {
    if (ch.skipped) continue;
    const reachable = new Set(ch.cands.map((c) => firstMatch(ch.order, c.preds)).filter((s): s is string => s !== null));
    const mine: Guard[] = [];
    for (const c of ch.cands) {
      const fm = firstMatch(ch.order, c.preds);
      if (!fm) continue;
      for (const v of ch.variants) {
        let movedTo = "";
        if (v.kind === "broaden" && mode === "pre") {
          if (c.vpreds[v.id] === true && ch.order.indexOf(v.site) < ch.order.indexOf(fm)) movedTo = v.site;
        } else if (v.kind === "swap" && v.site2) {
          const [i, j] = ch.order.indexOf(v.site) < ch.order.indexOf(v.site2) ? [v.site, v.site2] : [v.site2, v.site];
          // both sites take x and the earlier one wins; at base (pre) the later site must also win some other input,
          // so the order is a deliberate specific-before-general one rather than a dead branch
          if (fm === i && c.preds[j] === true && (mode === "post" || reachable.has(j))) movedTo = j;
        } else if (v.kind === "narrow" && mode === "post") {
          const later = ch.order.slice(ch.order.indexOf(fm) + 1).find((s) => c.preds[s] === true);
          if (v.site === fm && c.vpreds[v.id] === false && later) movedTo = later;
        }
        if (!movedTo) continue;
        const comps = sensitiveComps(c, v.id);
        if (comps.length === 0) continue;
        const pick = (o: Obs): Obs => Object.fromEntries(comps.map((k) => [k, o[k] ?? null]));
        mine.push({ lang: ch.lang, file: ch.file, func: ch.func, ...(ch.recv ? { recv: ch.recv } : {}), subject: ch.subject, loop: ch.loop ?? null, line: ch.line, mode, src: c.src, variant: v.id, vkind: v.kind, takenBy: fm, movedTo, comps, ref: pick(c.obs.real!), alt: pick(c.obs[v.id]!), sites: ch.sites });
      }
    }
    // one guard per candidate first, then the rest, so a few guards cover distinct inputs
    const seen = new Set<string>(), first: Guard[] = [], rest: Guard[] = [];
    for (const g of mine) (seen.has(g.src) ? rest : (seen.add(g.src), first)).push(g);
    out.push(...[...first, ...rest].slice(0, maxPerChain));
  }
  return out;
}

const stableOn = (o: Observed): string[] | null => {
  const r = o.obs?.real, r2 = o.obs?.real2;
  if (o.missing || o.build_error || !r || !r2 || r.build_error !== undefined) return null;
  return Object.keys({ ...r, ...r2 }).filter((k) => eq(r[k], r2[k]));
};

/** pre: the guard was derived on base; o is the changed tree's run of the same input. */
export function verdictPre(g: Guard, o: Observed | undefined): PreVerdict {
  if (!o) return "unknown";
  const stable = stableOn(o);
  if (!stable) return "unknown";
  const r = o.obs!.real!, d = g.comps.filter((k) => stable.includes(k) || r[k] === undefined);
  if (d.length === 0) return "unknown";
  if (d.every((k) => eq(r[k], g.ref[k]))) return "kept";
  if (d.some((k) => eq(r[k], g.alt[k]))) return "inverted";
  return "changed";
}

/** post: the guard was derived on the changed tree (ref = changed, alt = precedence restored); o is base's run. */
export function verdictPost(g: Guard, o: Observed | undefined): PostVerdict {
  if (!o) return "unknown";
  if (o.preds && o.order && o.order.length > 0 && firstMatch(o.order, o.preds) === null) return "unhandled-at-base";
  if (!o.order || o.order.length === 0) return "unhandled-at-base";
  const stable = stableOn(o);
  if (!stable) return "unknown";
  const b = o.obs!.real!, diff = g.comps.filter((k) => (stable.includes(k) || b[k] === undefined) && !eq(g.ref[k], b[k]));
  if (diff.length === 0) return "same-as-base";
  return diff.some((k) => eq(g.alt[k], b[k])) ? "precedence-regression" : "changed";
}

const short = (v: unknown): string => { const s = JSON.stringify(v ?? null); return s.length > 120 ? s.slice(0, 117) + "..." : s; };
const COMP: Record<string, string> = { ret: "return value", ret0: "return value", exc: "exception", out: "stdout", stdout: "stdout", stderr: "stderr", err: "stderr", panic: "panic", calls: "hook calls", timeout: "timed out", exit: "exit" };
const compName = (k: string): string => COMP[k] ?? (k.startsWith("w:") ? `writes to ${k.slice(2)}` : /^ret\d+$/.test(k) ? `return value ${+k.slice(3) + 1}` : k);
const siteSrc = (g: Guard, id: string): string => g.sites.find((s) => s.id === id)?.src ?? id;

/** The finding text for a fix brief: the input, which check took it at base, which takes it now, and what changed. */
export function findingText(g: Guard, verdict: string, detail: { comp: string; base: unknown; now: unknown }[]): string {
  const where = `${g.func} (${g.file}:${g.line})`;
  const changes = detail.map((d) => `${compName(d.comp)} ${short(d.base)} at base, ${short(d.now)} now`).join("; ");
  const baseSite = g.mode === "pre" ? siteSrc(g, g.takenBy) : siteSrc(g, g.movedTo);
  const nowSite = g.mode === "pre" ? siteSrc(g, g.movedTo) : siteSrc(g, g.takenBy);
  return `Twin-site check (${verdict}): ${where} dispatches \`${g.subject}\` by type. The input \`${g.src}\` was handled at base by \`${baseSite}\`; on the changed code \`${nowSite}\` takes it first (${changes}), which is exactly the outcome of putting that check ahead. Keep the base outcome for values the base code already dispatched by their own type: test the more specific type first, or narrow the earlier check.`;
}

export function findings(pre: Guard[], preObs: Map<string, Observed>, post: Guard[], postObs: Map<string, Observed>): TwinFinding[] {
  const out: TwinFinding[] = [];
  for (const g of pre) {
    const o = preObs.get(guardKey(g)), v = verdictPre(g, o), r = o?.obs?.real ?? {};
    const detail = g.comps.filter((k) => !eq(r[k], g.ref[k])).map((k) => ({ comp: k, base: g.ref[k], now: r[k] ?? null }));
    out.push({ guard: g, verdict: v, red: v === "inverted", detail, text: v === "inverted" ? findingText(g, v, detail) : "" });
  }
  for (const g of post) {
    const o = postObs.get(guardKey(g)), v = verdictPost(g, o), b = o?.obs?.real ?? {};
    const detail = g.comps.filter((k) => !eq(g.ref[k], b[k])).map((k) => ({ comp: k, base: b[k] ?? null, now: g.ref[k] }));
    out.push({ guard: g, verdict: v, red: v === "precedence-regression", detail, text: v === "precedence-regression" ? findingText(g, v, detail) : "" });
  }
  return out;
}

export const guardKey = (g: Guard): string => `${g.file}|${g.recv ?? ""}|${g.func}|${g.subject}|${g.src}`;

// ---------------------------------------------------------------- diff hunks

export interface FileHunks { path: string; old: [number, number][]; new: [number, number][] }
/** Changed line ranges on both sides of `git diff -U0 a [b]`, per file (new path), 1-based inclusive. New because the
 *  four inline copies (reviewer_brief.ts, secure_scan.ts, e10ext/select.ts, export_sarif.ts) each parse one side only. */
export function parseHunks(diff: string): FileHunks[] {
  const out: FileHunks[] = [];
  let cur: FileHunks | null = null;
  for (const line of diff.split("\n")) {
    const f = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (f) { cur = f[1] === "/dev/null" ? null : { path: f[1]!, old: [], new: [] }; if (cur) out.push(cur); continue; }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && cur) {
      const oa = +h[1]!, ob = h[2] === undefined ? 1 : +h[2], na = +h[3]!, nb = h[4] === undefined ? 1 : +h[4];
      cur.old.push([oa, oa + Math.max(ob, 1) - 1]);
      cur.new.push([na, na + Math.max(nb, 1) - 1]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- engines

interface RunOpts { timeoutMs?: number; env?: NodeJS.ProcessEnv }
const run = (cmd: string, args: string[], cwd: string, o: RunOpts = {}) => spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: o.timeoutMs ?? 180_000, env: { ...process.env, ...(o.env ?? {}) }, maxBuffer: 64 * 1024 * 1024 });

interface PyFunc { func: string; line: number; subject: string; loop?: string | null; sites: ProbeSite[]; order?: string[]; variants?: ProbeVariant[]; candidates?: { src: string; preds: Record<string, boolean | null>; vpreds: Record<string, boolean | null>; obs: Record<string, Obs> }[]; skipped?: string; chain: number }

export function pyProbe(root: string, file: string, mode: "pre" | "post", hunks: [number, number][] = [], o: RunOpts = {}): { chains: ProbeChain[]; error?: string } {
  const args = ["-I", join(TWIN_LIB, "twinpair_py.py"), "probe", "--root", root, "--file", file, "--mode", mode, ...hunks.flatMap(([a, b]) => ["--hunk", `${a}:${b}`])];
  const r = run("python3", args, root, o);
  let d: { error?: string; functions?: PyFunc[] };
  try { d = JSON.parse(r.stdout); } catch { return { chains: [], error: `python probe: ${(r.stderr || r.stdout || String(r.error ?? "")).slice(-300)}` }; }
  if (d.error) return { chains: [], error: d.error };
  return { chains: (d.functions ?? []).map((f) => ({ lang: "py" as const, file, func: f.func, subject: f.subject, loop: f.loop ?? null, line: f.line, sites: f.sites, order: f.order ?? f.sites.map((s) => s.id), variants: f.variants ?? [], ...(f.skipped ? { skipped: f.skipped } : {}), cands: (f.candidates ?? []).map((c, i) => ({ key: `${f.func}#${f.chain}#${i}`, src: c.src, preds: c.preds, vpreds: c.vpreds, obs: c.obs })) })) };
}

export function pyObserve(root: string, file: string, guards: Guard[], o: RunOpts = {}): Map<string, Observed> {
  const res = new Map<string, Observed>();
  if (guards.length === 0) return res;
  const tmp = mkdtempSync(join(tmpdir(), "loki-twin-"));
  try {
    const cases = [...new Map(guards.map((g) => [guardKey(g), { key: guardKey(g), func: g.func, subject: g.subject, loop: g.loop, src: g.src }])).values()];
    writeFileSync(join(tmp, "cases.json"), JSON.stringify(cases));
    const r = run("python3", ["-I", join(TWIN_LIB, "twinpair_py.py"), "observe", "--root", root, "--file", file, "--cases", join(tmp, "cases.json")], root, o);
    let d: { observed?: Observed[]; error?: string };
    try { d = JSON.parse(r.stdout); } catch { return res; }
    for (const x of d.observed ?? []) res.set(x.key, x);
    return res;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

interface GoManifest { chains: { key: string; file?: string; func: string; recv?: string; subject: string; subject_type: string; loop?: string; line: number; sites: ProbeSite[]; skipped?: string; variants: ProbeVariant[] | null; candidates: { id: string; src: string }[] | null; order: string[] }[] | null; lines?: Record<string, [number, number]> }
interface GoRec { cand: string; variant: string; obs?: Obs; preds?: Record<string, boolean> }

/** Generate the probe in pkgDir, run it, drop the candidates or variants a build error points at, retry. The probe file
 *  is always removed. Returns the manifest and the JSON-line records. */
function goRun(pkgDir: string, genArgs: string[], o: RunOpts): { man: GoManifest | null; recs: GoRec[]; error?: string; attempts: number } {
  const tmp = mkdtempSync(join(tmpdir(), "loki-twin-")), probe = join(pkgDir, GO_PROBE_FILE), man = join(tmp, "manifest.json"), outF = join(tmp, "out.jsonl");
  const drop = new Set<string>(), noImport = new Set<string>();
  let attempts = 0, last = "";
  try {
    while (attempts < 5) {
      attempts++;
      // a prebuilt engine (LOKI_TWIN_GO_ENGINE) skips the per-call `go run` compile; the source is the fallback
      const eng = process.env.LOKI_TWIN_GO_ENGINE, gcmd = eng && existsSync(eng) ? eng : "go", gpre = gcmd === "go" ? ["run", join(TWIN_LIB, "twinpair_go.go")] : [];
      const g = run(gcmd, [...gpre, ...genArgs, "-out", probe, "-manifest", man, "-drop", [...drop].join(",")], pkgDir, { ...o, env: { GOWORK: "off", ...(o.env ?? {}) } });
      if (g.status !== 0 || !existsSync(man)) return { man: null, recs: [], error: `gen: ${(g.stderr || g.stdout).slice(-300)}`, attempts };
      const m = JSON.parse(readFileSync(man, "utf8")) as GoManifest;
      if (!existsSync(probe)) return { man: m, recs: [], attempts };
      if (noImport.size) writeFileSync(probe, readFileSync(probe, "utf8").split("\n").filter((l) => !noImport.has(l.trim())).join("\n"));
      rmSync(outF, { force: true });
      const t = run("go", ["test", "-vet=off", "-count=1", "-run", "^TestLokiTwinProbe$", "."], pkgDir, { ...o, env: { GOWORK: "off", LOKI_TWIN_OUT: outF, ...(o.env ?? {}) } });
      const text = (t.stdout ?? "") + (t.stderr ?? "");
      const errs = [...text.matchAll(new RegExp(`${GO_PROBE_FILE.replace(/\./g, "\\.")}:(\\d+):\\d+: (.*)`, "g"))];
      if (errs.length === 0 || existsSync(outF)) {
        const recs = existsSync(outF) ? readFileSync(outF, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as GoRec) : [];
        return { man: m, recs, attempts, ...(recs.length === 0 ? { error: `probe: ${text.slice(-400)}` } : {}) };
      }
      let progress = false;
      for (const e of errs) {
        const ln = +e[1]!, msg = e[2]!;
        const imp = /^"([^"]+)" imported( as \w+)? and not used/.exec(msg);
        if (imp) { const spec = readFileSync(probe, "utf8").split("\n")[ln - 1]?.trim(); if (spec && !noImport.has(spec)) { noImport.add(spec); progress = true; } continue; }
        for (const [k, [a, b]] of Object.entries(m.lines ?? {})) if (ln >= a && ln <= b && !drop.has(k)) { drop.add(k); progress = true; }
      }
      last = text.slice(-600);
      if (!progress) return { man: m, recs: [], error: `build: ${last}`, attempts };
    }
    return { man: null, recs: [], error: `build: ${last}`, attempts };
  } finally { rmSync(probe, { force: true }); rmSync(tmp, { recursive: true, force: true }); }
}

export function goProbe(pkgDir: string, mode: "pre" | "post", hunks: string[] = [], o: RunOpts = {}): { chains: ProbeChain[]; error?: string; attempts?: number } {
  const r = goRun(pkgDir, ["gen", "-pkg", ".", "-mode", mode, ...hunks.flatMap((h) => ["-hunk", h])], o);
  if (!r.man) return { chains: [], ...(r.error ? { error: r.error } : {}), attempts: r.attempts };
  const byCand = new Map<string, GoRec[]>();
  for (const rec of r.recs) byCand.set(rec.cand, [...(byCand.get(rec.cand) ?? []), rec]);
  const chains: ProbeChain[] = (r.man.chains ?? []).map((c) => ({
    lang: "go" as const, file: c.file ?? "", func: c.func, ...(c.recv ? { recv: c.recv } : {}), subject: c.subject, loop: c.loop ?? null, line: c.line, sites: c.sites, order: c.order, variants: c.variants ?? [], ...(c.skipped ? { skipped: c.skipped } : {}),
    cands: (c.candidates ?? []).flatMap((cd) => {
      const recs = byCand.get(`${c.key}/${cd.id}`) ?? [];
      const pr = recs.find((x) => x.variant === "preds")?.preds ?? {};
      if (recs.length === 0) return [];
      const preds: Record<string, boolean | null> = {}, vpreds: Record<string, boolean | null> = {}, obs: Record<string, Obs> = {};
      for (const [k, v] of Object.entries(pr)) (k.startsWith("v:") ? vpreds : preds)[k.startsWith("v:") ? k.slice(2) : k] = v;
      for (const x of recs) if (x.variant !== "preds" && x.obs) obs[x.variant] = x.obs;
      return [{ key: `${c.key}/${cd.id}`, src: cd.src, preds, vpreds, obs }];
    }),
  }));
  return { chains, ...(r.error ? { error: r.error } : {}), attempts: r.attempts };
}

export function goObserve(pkgDir: string, guards: Guard[], o: RunOpts = {}): Map<string, Observed> {
  const res = new Map<string, Observed>();
  if (guards.length === 0) return res;
  const tmp = mkdtempSync(join(tmpdir(), "loki-twin-"));
  try {
    const keyOf = new Map<string, string>(), cases: { key: string; func: string; recv: string; subject: string; src: string }[] = [];
    for (const g of guards) {
      const k = guardKey(g);
      if (keyOf.has(k)) continue;
      const id = `q${keyOf.size + 1}`;
      keyOf.set(k, id);
      cases.push({ key: id, func: g.func, recv: g.recv ?? "", subject: g.subject, src: g.src });
    }
    writeFileSync(join(tmp, "cases.json"), JSON.stringify(cases));
    const r = goRun(pkgDir, ["observe", "-pkg", ".", "-cases", join(tmp, "cases.json")], o);
    const chainOf = new Map<string, { order: string[] }>();
    for (const c of r.man?.chains ?? []) for (const cd of c.candidates ?? []) chainOf.set(cd.id, { order: c.order });
    for (const [k, id] of keyOf) {
      const recs = r.recs.filter((x) => x.cand === id);
      if (recs.length === 0) { res.set(k, { key: k, missing: true }); continue; }
      const obs: { real?: Obs; real2?: Obs } = {};
      for (const x of recs) if (x.variant === "real" || x.variant === "real2") obs[x.variant] = x.obs ?? {};
      res.set(k, { key: k, preds: recs.find((x) => x.variant === "preds")?.preds ?? {}, order: chainOf.get(id)?.order ?? [], obs });
    }
    return res;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- orchestration

export interface TwinPairRun { findings: TwinFinding[]; pre: number; post: number; errors: string[]; probed: { lang: string; file: string; chains: number; eligible: number }[] }
const PY_TEST = /(^|\/)(tests?|testing)\/|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/;

/** Run both checks on one change. baseDir and headDir are two checkouts (base commit and changed tree); files carry
 *  the diff hunks between them. Go probe files are written into the package directories and always removed. */
export function twinPairCheck(baseDir: string, headDir: string, files: FileHunks[], o: RunOpts = {}): TwinPairRun {
  const res: TwinPairRun = { findings: [], pre: 0, post: 0, errors: [], probed: [] };
  for (const f of files.filter((x) => x.path.endsWith(".py") && !PY_TEST.test(x.path))) {
    if (!existsSync(join(baseDir, f.path)) || !existsSync(join(headDir, f.path))) continue;
    const pre = pyProbe(baseDir, f.path, "pre", f.old, o), post = pyProbe(headDir, f.path, "post", f.new, o);
    for (const e of [pre.error, post.error]) if (e) res.errors.push(`${f.path}: ${e}`);
    const gPre = selectGuards(pre.chains, "pre"), gPost = selectGuards(post.chains, "post");
    res.probed.push({ lang: "py", file: f.path, chains: pre.chains.length + post.chains.length, eligible: pre.chains.filter((c) => !c.skipped).length + post.chains.filter((c) => !c.skipped).length });
    res.pre += gPre.length; res.post += gPost.length;
    res.findings.push(...findings(gPre, pyObserve(headDir, f.path, gPre, o), gPost, pyObserve(baseDir, f.path, gPost, o)));
  }
  const goDirs = new Map<string, FileHunks[]>();
  for (const f of files.filter((x) => x.path.endsWith(".go") && !x.path.endsWith("_test.go"))) goDirs.set(dirname(f.path), [...(goDirs.get(dirname(f.path)) ?? []), f]);
  for (const [dir, fs] of goDirs) {
    const bd = join(baseDir, dir), hd = join(headDir, dir);
    if (!existsSync(bd) || !existsSync(hd)) continue;
    const name = (p: string): string => p.split("/").pop()!;
    const pre = goProbe(bd, "pre", fs.flatMap((f) => f.old.map(([a, b]) => `${name(f.path)}:${a}:${b}`)), o);
    const post = goProbe(hd, "post", fs.flatMap((f) => f.new.map(([a, b]) => `${name(f.path)}:${a}:${b}`)), o);
    for (const e of [pre.error, post.error]) if (e) res.errors.push(`${dir}: ${e}`);
    for (const ch of [...pre.chains, ...post.chains]) ch.file = dir ? `${dir}/${ch.file}` : ch.file;
    const gPre = selectGuards(pre.chains, "pre"), gPost = selectGuards(post.chains, "post");
    res.probed.push({ lang: "go", file: dir || ".", chains: pre.chains.length + post.chains.length, eligible: pre.chains.filter((c) => !c.skipped).length + post.chains.filter((c) => !c.skipped).length });
    res.pre += gPre.length; res.post += gPost.length;
    res.findings.push(...findings(gPre, goObserve(hd, gPre, o), gPost, goObserve(bd, gPost, o)));
  }
  return res;
}
