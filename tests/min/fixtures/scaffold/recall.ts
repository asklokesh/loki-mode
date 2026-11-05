// Recall and precision probe for the systematic-edit pass, on real merged multi-site edits from repos outside the corpus.
// Extends fp.ts (the 256-commit false-positive replay) with a ground truth, so recall is measured, not only silence.
//   mine:   a commit's non-test code diff holds >= 3 one-line rewrites with one identical change bag (tokens only the old
//           line has, tokens only the new line has; an identifier on both sides is context and does not count). That set
//           of sites is the ground truth. The bag is deliberately not the completer's own shape abstraction, so a site the
//           completer cannot express still counts against its recall.
//   replay: per cluster, revert some sites to the parent's text (the partial "agent" edit; every other change of the commit
//           stays applied), run a completer dry, and score every proposed rewrite against the merged commit's text.
//   fp:     apply whole commits (nothing held out) and count proposed rewrites; each one deviates from what was merged.
// usage: bun recall.ts mine <repo> <maxCommits> <out.json>
//        bun recall.ts replay <repo> <clusters.json> <completer.ts> <out.json> [--mode loo|keep2] [--task msg|none]
//        bun recall.ts fp <repo> <maxCommits> <completer.ts> <out.json>
// A completer module exports complete(repoDir, baseSha, task) => { file, line, before, after[] }[] and never writes.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isTestFile } from "../../../../loki-ts/src/util/test_file_text.ts";

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|go|py)$/;
const GENERATED = /(^|\/)(vendor|dist|build|node_modules|third_party|__generated__|testdata|fixtures?)\/|\.(pb|gen)\.go$|_generated|\.min\.js$/;
const TIP = "refs/remotes/origin/HEAD"; // the clone's default branch tip: never HEAD, which a killed replay can leave detached
const git = (dir: string, ...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] });

// Neutral tokenizer (ground truth only; the completers carry their own).
const TOK = /[A-Za-z_$][\w$]*|\d[\w.]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`|===|!==|\*\*|:=|==|!=|<=|>=|=>|->|&&|\|\||\?\?|\?\.|\.\.\.|\S/g;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const PUNCT = /^[^\w"'`$]+$/;
export const toks = (s: string): string[] => s.match(TOK) ?? [];
const isCommentLine = (s: string): boolean => /^\s*(\/\/|#|\/\*|\*|"""|''')/.test(s);

export interface Site { file: string; oldLine: number; newLine: number; old: string; new: string[]; fileLines: number }
export interface Cluster { commit: string; parent: string; message: string; key: string; sites: Site[] }

/** The change bag of one rewrite, or null when it holds no identifier, keyword or literal (whitespace, punctuation, reorder). */
export function bagOf(oldLine: string, newLines: string[]): string | null {
  const a = toks(oldLine), b = toks(newLines.join(" "));
  const ia = new Set(a.filter((t) => IDENT.test(t))), ib = new Set(b.filter((t) => IDENT.test(t)));
  const rem: string[] = [], add: string[] = [];
  for (const t of ia) if (!ib.has(t)) rem.push(t);
  for (const t of ib) if (!ia.has(t)) add.push(t);
  const count = (xs: string[]): Map<string, number> => { const m = new Map<string, number>(); for (const x of xs) if (!IDENT.test(x)) m.set(x, (m.get(x) ?? 0) + 1); return m; };
  const ca = count(a), cb = count(b);
  for (const [t, n] of ca) for (let i = cb.get(t) ?? 0; i < n; i++) rem.push(t);
  for (const [t, n] of cb) for (let i = ca.get(t) ?? 0; i < n; i++) add.push(t);
  if (![...rem, ...add].some((t) => !PUNCT.test(t))) return null;
  return `${rem.sort().join(" ")} => ${add.sort().join(" ")}`;
}

type Hunk = { oldStart: number; removed: string[]; newStart: number; added: string[] };
function parseHunks(diff: string): Map<string, Hunk[]> {
  const out = new Map<string, Hunk[]>(); let file: string | null = null, cur: Hunk | null = null;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) { file = null; cur = null; continue; }
    if (l.startsWith("+++ ")) { file = l.startsWith("+++ b/") ? l.slice(6) : null; if (file) out.set(file, []); cur = null; continue; }
    if (l.startsWith("--- ")) continue;
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) { cur = { oldStart: +h[1]!, removed: [], newStart: +h[3]!, added: [] }; if (file) out.get(file)!.push(cur); continue; }
    if (!cur) continue;
    if (l.startsWith("-")) cur.removed.push(l.slice(1)); else if (l.startsWith("+")) cur.added.push(l.slice(1));
  }
  return out;
}

/** Line rewrites of a commit: an n-to-n hunk pairs line i with line i; a 1-to-k hunk is one rewrite into k lines. */
function rewritesOf(repo: string, parent: string, commit: string): Omit<Site, "fileLines">[] {
  const diff = git(repo, "diff", "-U0", "--no-color", "--no-renames", "--no-ext-diff", parent, commit, "--");
  const out: Omit<Site, "fileLines">[] = [];
  for (const [file, hs] of parseHunks(diff)) {
    if (!CODE.test(file) || isTestFile(file) || GENERATED.test(file)) continue;
    for (const h of hs) {
      if (h.removed.length === 0 || h.added.length === 0) continue;
      if (h.removed.length === h.added.length) h.removed.forEach((r, i) => out.push({ file, oldLine: h.oldStart + i, newLine: h.newStart + i, old: r, new: [h.added[i]!] }));
      else if (h.removed.length === 1) out.push({ file, oldLine: h.oldStart, newLine: h.newStart, old: h.removed[0]!, new: h.added });
    }
  }
  return out.filter((s) => !isCommentLine(s.old) && s.old.trim() !== "");
}

function mine(repo: string, max: number): { scanned: number; clusters: Cluster[] } {
  const commits = git(repo, "rev-list", "--no-merges", "-n", String(max), TIP).trim().split("\n").filter(Boolean);
  const clusters: Cluster[] = []; let scanned = 0;
  for (const c of commits) {
    let parent: string;
    try { parent = git(repo, "rev-parse", "--verify", "-q", `${c}^`).trim(); } catch { continue; } // shallow boundary
    let rw: Omit<Site, "fileLines">[];
    try { rw = rewritesOf(repo, parent, c); } catch { continue; }
    scanned++;
    const by = new Map<string, Omit<Site, "fileLines">[]>();
    for (const s of rw) { const k = bagOf(s.old, s.new); if (k) by.set(k, [...(by.get(k) ?? []), s]); }
    const sizes = new Map<string, number>();
    const size = (f: string): number => { if (!sizes.has(f)) { try { sizes.set(f, git(repo, "show", `${c}:${f}`).split("\n").length); } catch { sizes.set(f, 0); } } return sizes.get(f)!; };
    for (const [key, sites] of by) if (sites.length >= 3) clusters.push({ commit: c, parent, message: git(repo, "log", "-1", "--format=%B", c).trim(), key, sites: sites.map((s) => ({ ...s, fileLines: size(s.file) })) });
  }
  return { scanned, clusters };
}

export interface Ev { rule: string; level?: "lgg" | "cg"; instances: number; matches: number; matches_home: number; home: boolean; specificity: number }
export interface Rw { file: string; line: number; before: string; after: string[]; evidence?: Ev }
type Completer = (repoDir: string, baseSha: string, task: string) => Rw[];

/** Checks out the commit and reverts the held-out sites to the parent's text; returns each held-out site's line in the partial tree. */
function partialTree(repo: string, cl: Cluster, held: Site[]): Map<Site, number> {
  git(repo, "checkout", "-q", "-f", "--detach", cl.commit); git(repo, "clean", "-qfdx");
  const at = new Map<Site, number>();
  for (const file of new Set(held.map((s) => s.file))) {
    const lines = readFileSync(join(repo, file), "utf8").split("\n");
    const hs = held.filter((s) => s.file === file).sort((a, b) => a.newLine - b.newLine);
    let shift = 0;
    for (const s of hs) { at.set(s, s.newLine - shift); shift += s.new.length - 1; }
    for (const s of [...hs].reverse()) lines.splice(s.newLine - 1, s.new.length, s.old);
    writeFileSync(join(repo, file), lines.join("\n"));
  }
  return at;
}

const same = (a: string[], b: string[]): boolean => toks(a.join(" ")).join(" ") === toks(b.join(" ")).join(" ");

/** One replayed trial: the held-out sites (where they sit in the partial tree, what the merged commit wrote) and every candidate. */
interface Raw { repo: string; commit: string; key: string; n: number; big: boolean; ms: number; held: { file: string; line: number; want: string[] }[]; cands: Rw[]; check?: { control: boolean; with: boolean } }
/** Writes rewrites into the tree (bottom-up per file, each only where its line still reads as before), like the scaffold's apply. */
function applyRw(repo: string, rws: Rw[]): void {
  for (const f of new Set(rws.map((r) => r.file))) {
    const lines = readFileSync(join(repo, f), "utf8").split("\n");
    for (const r of rws.filter((x) => x.file === f).sort((a, b) => b.line - a.line)) if (lines[r.line - 1] === r.before) lines.splice(r.line - 1, 1, ...r.after);
    writeFileSync(join(repo, f), lines.join("\n"));
  }
}
/** go vet over the packages the rewrites touch (compile and type errors, the cheapest part of a verify); true when it passes. */
function goVet(repo: string, rws: Rw[]): boolean {
  const pkgs = [...new Set(rws.map((r) => `./${dirname(r.file)}`))];
  const r = spawnSync("go", ["vet", ...pkgs], { cwd: repo, timeout: 300000, stdio: "ignore", env: { ...process.env, GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" } });
  return r.status === 0;
}
/** A guard policy applied offline to diag candidates: scope "file" keeps candidates in files holding the rule's instances (and
 *  counts fan-out there); a rule may rewrite at most fanout x instances lines; per line the most specific surviving rule wins. */
export interface Policy { name: string; scope: "file" | "dir"; fanout: number; minSpec?: number; lggOnly?: boolean }
function select(c: Rw[], p: Policy | null): Rw[] {
  if (!p) return c;
  const byLine = new Map<string, Rw>();
  for (const r of c) {
    const e = r.evidence; if (!e) { byLine.set(`${r.file}:${r.line}`, r); continue; }
    if ((p.scope === "file" && !e.home) || (p.lggOnly && e.level === "cg")) continue;
    const m = p.scope === "file" ? e.matches_home : e.matches;
    if (m > p.fanout * e.instances || e.specificity < (p.minSpec ?? 0)) continue;
    const k = `${r.file}:${r.line}`, cur = byLine.get(k);
    if (!cur || (cur.evidence && (e.specificity > cur.evidence.specificity || (e.specificity === cur.evidence.specificity && e.instances > cur.evidence.instances)))) byLine.set(k, r);
  }
  return [...byLine.values()];
}
interface Trial { repo: string; commit: string; key: string; n: number; held: number; tp: number; exact: number; fp_wrong_site: number; fp_unchanged: number; big: boolean; ms: number; samples: unknown[] }
function score(t0: Raw, rws: Rw[]): Trial {
  const t: Trial = { repo: t0.repo, commit: t0.commit, key: t0.key, n: t0.n, held: t0.held.length, tp: 0, exact: 0, fp_wrong_site: 0, fp_unchanged: 0, big: t0.big, ms: t0.ms, samples: [] };
  for (const r of rws) {
    const h = t0.held.find((s) => s.file === r.file && s.line === r.line);
    if (h && same(r.after, h.want)) { t.tp++; if (r.after.join("\n") === h.want.join("\n")) t.exact++; }
    else { if (h) t.fp_wrong_site++; else t.fp_unchanged++; if (t.samples.length < 3) t.samples.push({ file: r.file, line: r.line, before: r.before.trim(), after: r.after.map((x) => x.trim()), want: h ? h.want.map((x) => x.trim()) : null, ev: r.evidence ? { i: r.evidence.instances, m: r.evidence.matches, s: r.evidence.specificity } : undefined }); }
  }
  return t;
}

/** loo: hold out one site at a time (at most 3 trials per cluster: first, middle, last); keep2: keep the first 2 sites, hold out the rest. */
function trialsOf(cl: Cluster, mode: string): Site[][] {
  const s = cl.sites;
  if (mode === "keep2") return [s.slice(2)];
  const idx = [...new Set([0, Math.floor((s.length - 1) / 2), s.length - 1])];
  return idx.map((i) => [s[i]!]);
}

async function load(p: string): Promise<Completer> { const m = await import(resolve(p)); return m.complete as Completer; }

async function main(): Promise<void> {
  const [cmd, repo, a, b, c, ...rest] = process.argv.slice(2);
  const opt = (k: string, d: string): string => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1]! : d; };
  if (cmd === "mine") {
    const r = mine(repo!, Number(a)); writeFileSync(b!, JSON.stringify(r, null, 1));
    const commits = new Set(r.clusters.map((x) => x.commit)), big = new Set(r.clusters.filter((x) => x.sites.some((s) => s.fileLines >= 300)).map((x) => x.commit));
    console.log(JSON.stringify({ scanned: r.scanned, clusters: r.clusters.length, commits: commits.size, commits_big_file: big.size, sites: r.clusters.reduce((n, x) => n + x.sites.length, 0) }));
    return;
  }
  if (cmd === "replay") {
    const { clusters } = JSON.parse(readFileSync(a!, "utf8")) as { clusters: Cluster[] };
    const complete = await load(b!), mode = opt("--mode", "loo"), taskMode = opt("--task", "msg"), checkMode = opt("--check", "");
    const out: Raw[] = [];
    const head = git(repo!, "rev-parse", TIP).trim();
    const perCommit = new Map<string, number>(); // at most 3 clusters per commit (first in diff order), so one mass edit cannot dominate
    const picked = clusters.filter((cl) => { const k = perCommit.get(cl.commit) ?? 0; perCommit.set(cl.commit, k + 1); return k < 3; });
    try {
      for (const cl of picked) for (const held of trialsOf(cl, mode)) {
        const at = partialTree(repo!, cl, held), t0 = performance.now();
        let rws: Rw[] = [];
        try { rws = complete(repo!, cl.parent, taskMode === "none" ? "" : cl.message); } catch { rws = []; }
        let check: Raw["check"];
        if (checkMode === "go" && rws.length) { const control = goVet(repo!, rws); applyRw(repo!, rws); check = { control, with: goVet(repo!, rws) }; }
        out.push({ ...(check ? { check } : {}), repo: repo!.split("/").pop()!, commit: cl.commit.slice(0, 10), key: cl.key, n: cl.sites.length, big: held.some((x) => x.fileLines >= 300), ms: Math.round(performance.now() - t0), held: held.map((x) => ({ file: x.file, line: at.get(x)!, want: x.new })), cands: rws });
      }
    } finally { git(repo!, "checkout", "-q", "-f", head); git(repo!, "clean", "-qfdx"); }
    writeFileSync(c!, JSON.stringify(out));
    const pol = out.some((x) => x.cands.some((r) => r.evidence)) ? DEFAULT_POLICY : null;
    console.log(JSON.stringify(summarize(out.map((t) => score(t, select(t.cands, pol))))));
    if (checkMode) console.log(JSON.stringify({ after_undo: summarize(out.map((t) => score(t, t.check && t.check.control && !t.check.with ? [] : select(t.cands, pol)))), checked_trials: out.filter((t) => t.check).length, undone_trials: out.filter((t) => t.check && t.check.control && !t.check.with).length, control_red: out.filter((t) => t.check && !t.check.control).length }));
    return;
  }
  if (cmd === "analyze") { // bun recall.ts analyze <policies.json|-> <trials.json>...
    const files = [a!, b!, c!, ...rest].filter((x) => x && !x.startsWith("--") && x !== "-");
    const raws = files.flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as Raw[]);
    const pols: Policy[] = repo && repo !== "-" ? JSON.parse(readFileSync(repo, "utf8")) : DEFAULT_POLICIES;
    for (const p of pols) console.log(JSON.stringify({ policy: p.name, ...summarize(raws.map((t) => score(t, select(t.cands, p)))) }));
    return;
  }
  if (cmd === "fp") {
    const complete = await load(b!);
    const commits = git(repo!, "rev-list", "--no-merges", "-n", a!, TIP).trim().split("\n").filter(Boolean);
    const head = git(repo!, "rev-parse", TIP).trim();
    let n = 0, withRw = 0, rw = 0; const samples: unknown[] = []; let ms = 0;
    try {
      for (const cm of commits) {
        let parent: string; try { parent = git(repo!, "rev-parse", "--verify", "-q", `${cm}^`).trim(); } catch { continue; }
        git(repo!, "checkout", "-q", "-f", "--detach", cm); git(repo!, "clean", "-qfdx");
        const t0 = performance.now(); let r: Rw[] = [];
        try { r = complete(repo!, parent, git(repo!, "log", "-1", "--format=%B", cm)); } catch { r = []; }
        ms += performance.now() - t0; n++;
        if (r.length) { withRw++; rw += r.length; if (samples.length < 12) samples.push({ c: cm.slice(0, 10), rewrites: r.slice(0, 2).map((x) => ({ file: x.file, line: x.line, before: x.before.trim(), after: x.after.map((y) => y.trim()) })) }); }
      }
    } finally { git(repo!, "checkout", "-q", "-f", head); git(repo!, "clean", "-qfdx"); }
    const res = { commits: n, commits_with_rewrite: withRw, rewrites: rw, mean_ms: Math.round(ms / Math.max(1, n)), samples };
    writeFileSync(c!, JSON.stringify(res, null, 1)); console.log(JSON.stringify({ ...res, samples: undefined }));
  }
}

const DEFAULT_POLICY: Policy = { name: "file-fan1", scope: "file", fanout: 1 }; // the production defaults (SYSTEMATIC_DEFAULTS)
const DEFAULT_POLICIES: Policy[] = [
  { name: "unguarded", scope: "dir", fanout: Infinity }, { name: "file-unguarded", scope: "file", fanout: Infinity },
  { name: "dir-fan2", scope: "dir", fanout: 2 }, { name: "dir-fan1", scope: "dir", fanout: 1 }, { name: "dir-fan0.5", scope: "dir", fanout: 0.5 },
  { name: "file-fan2", scope: "file", fanout: 2 }, { name: "file-fan1", scope: "file", fanout: 1 }, { name: "file-fan0.5", scope: "file", fanout: 0.5 },
];
export function summarize(ts: Trial[]): Record<string, unknown> {
  const sum = (f: (t: Trial) => number, xs = ts): number => xs.reduce((n, t) => n + f(t), 0);
  const part = (xs: Trial[]): Record<string, unknown> => {
    const held = sum((t) => t.held, xs), tp = sum((t) => t.tp, xs), fp = sum((t) => t.fp_wrong_site + t.fp_unchanged, xs);
    const byC = new Map<string, { h: number; tp: number }>();
    for (const t of xs) { const k = `${t.repo}:${t.commit}`, c = byC.get(k) ?? { h: 0, tp: 0 }; c.h += t.held; c.tp += t.tp; byC.set(k, c); }
    const macro = byC.size ? [...byC.values()].reduce((n, c) => n + c.tp / c.h, 0) / byC.size : 0;
    return { trials: xs.length, commits: byC.size, commit_macro_recall: +macro.toFixed(3), commits_any_hit: [...byC.values()].filter((c) => c.tp > 0).length, held, tp, exact: sum((t) => t.exact, xs), fp_wrong_site: sum((t) => t.fp_wrong_site, xs), fp_unchanged: sum((t) => t.fp_unchanged, xs), recall: held ? +(tp / held).toFixed(3) : null, precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, trials_any_hit: xs.filter((t) => t.tp > 0).length };
  };
  return { all: part(ts), big_files: part(ts.filter((t) => t.big)), mean_ms: Math.round(sum((t) => t.ms) / Math.max(1, ts.length)) };
}

if (import.meta.main) await main();
