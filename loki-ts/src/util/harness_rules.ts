// Self-improving harness (prototype, proto/self-improving-harness). New file: util/pr_lessons.ts owns per-repo lessons for the AGENT's
// brief; nothing owns cross-repo rules that change what the HARNESS does (commit filter, fix gate, config scan), so this file does.
//
// The loop: mine failure signals from sealed run facts (receipt + events, no model call, no hidden test, no benchmark grade) ->
// propose candidate rules from a CLOSED grammar of harness interventions, each at every rung of a generalization ladder
// (literal path -> basename -> path class -> any; harness-written only -> any writer) -> keep a candidate only if it has support in
// >= MIN_REPOS distinct repos -> validate each candidate by paired runs on held-back fixtures the miner never saw (with and
// without the rule) and accept it only if it raises correct outcomes, adds no false green and no harm -> run accepted rules live
// with a harm monitor that rolls a rule back when it damages a tree, and retires rules that never fire.
//
// Verdict safety is structural: no template can turn a failing check into a pass. An excused check is NOT PROVEN and caps the
// verdict at PARTIAL; a dropped path is listed in NOT PROVEN; a filtered config flag is listed in NOT PROVEN.
import { basename } from "node:path";
import { LOCKFILE, manifestChanged } from "../e10ext/commit_filter.ts";

export type Writer = "agent" | "harness";
export type PathCls = "lockfile" | "build_cache" | "runner_config" | "test" | "doc" | "source";
const RUNNER_CFG = /(^|\/)(tsconfig[^/]*\.json|vite(st)?\.config\.[^/]+|jest\.config\.[^/]+|pytest\.ini|conftest\.py|setup\.cfg|\.eslintrc[^/]*|eslint\.config\.[^/]+|mypy\.ini)$/;
const TEST = /(^|\/)(tests?|__tests__)\/|[._-](test|spec)\.[^/]+$|_test\.go$/;
const DOC = /\.(md|rst|txt)$/i;
/** One class per path. `ignored` (gitignored at seal time) wins: a build cache is a cache whatever its name says. */
export function pathClass(p: string, ignored: boolean): PathCls {
  if (ignored) return "build_cache";
  if (LOCKFILE.test(p)) return "lockfile";
  if (RUNNER_CFG.test(p)) return "runner_config";
  if (TEST.test(p)) return "test";
  if (DOC.test(p)) return "doc";
  return "source";
}
/** The name-only class (what the path looks like, ignoring ignore status): a second view the miner proposes, validation decides. */
export const nameClass = (p: string): PathCls => pathClass(p, false);

/** What one sealed run records that the miner may read. All of it is derivable from Loki's own receipt and events. */
export interface RunFacts {
  run_id: string;
  repo: string;
  verdict: "VERIFIED" | "PARTIAL" | "FAILED" | "STALLED";
  /** Paths in the shipped commit (WIP or final), with who wrote them: inside an agent session, or after it (verify, install, codegen). */
  shipped: { path: string; by: Writer; ignored: boolean; wip: boolean }[];
  /** One entry per fix round per failing check: did the failure signature survive the round, which paths did the round edit. */
  fix_rounds: { check: string; kind: string; sig_same: boolean; edited: string[]; failing_in_diff: boolean }[];
  /** "test configuration changed" flags raised at seal, with who wrote the path. */
  flags: { path: string; by: Writer; ignored: boolean }[];
  cost_usd: number;
}

// ---- the closed grammar -------------------------------------------------------------------------------------------------
// wip_drop:       when the run ships uncommitted work, reset matching paths to base and list them in NOT PROVEN.
// pre_red:        before a fix round, rerun a failing check whose failure names no changed file at base; the SAME signature there excuses it.
// untouched_excuse: excuse a failing check whose failure names no changed file (no base rerun). Cheaper; the miner may propose it.
// flag_ignore:    drop a matching "test configuration changed" flag from the stall rule (still listed in NOT PROVEN).
export type Template = "wip_drop" | "pre_red" | "untouched_excuse" | "flag_ignore";
export interface Rule {
  id: string;
  template: Template;
  /** lit:<path> | base:<name> | cls:<class> | ncls:<name class> | kind:<check kind> | any */
  match: string;
  writer: Writer | "any";
  /** manifest_unchanged: only when no manifest changed at or above the path's directory (the guard the commit stage's dropSet uses). */
  guard: "none" | "manifest_unchanged";
  state: "candidate" | "rejected" | "active" | "rolled_back" | "retired";
  support: { runs: number; repos: string[] };
  validation?: { delta_correct: number; delta_false_green: number; delta_harm: number; delta_cost: number; train_delta?: number };
  live: { fired: number; harm: number; runs: number };
  why?: string;
}
export const ruleId = (t: Template, m: string, w: string, g = "none"): string => `${t}|${m}|${w}|${g}`;
export const MIN_REPOS = 2;

const pathMatches = (m: string, p: string, ignored: boolean): boolean =>
  m === "any" || m === `lit:${p}` || m === `base:${basename(p)}` || m === `cls:${pathClass(p, ignored)}` || m === `ncls:${nameClass(p)}`;
const ladderFor = (p: string, ignored: boolean): string[] => [...new Set([`lit:${p}`, `base:${basename(p)}`, `cls:${pathClass(p, ignored)}`, `ncls:${nameClass(p)}`, "any"])];

/** Mining: every failure signal in the facts, lifted to every rung of its ladder, counted by distinct repo. Deterministic. */
export function mine(facts: RunFacts[]): Rule[] {
  const acc = new Map<string, Rule>();
  const add = (t: Template, m: string, w: Writer | "any", f: RunFacts, g: Rule["guard"]): void => {
    const id = ruleId(t, m, w, g), r = acc.get(id) ?? { id, template: t, match: m, writer: w, guard: g, state: "candidate", support: { runs: 0, repos: [] }, live: { fired: 0, harm: 0, runs: 0 } };
    r.support.runs++; if (!r.support.repos.includes(f.repo)) r.support.repos.push(f.repo);
    acc.set(id, r);
  };
  for (const f of facts) {
    const seen = new Set<string>(), once = (t: Template, m: string, w: Writer | "any", g: Rule["guard"] = "none"): void => { const k = ruleId(t, m, w, g); if (!seen.has(k)) { seen.add(k); add(t, m, w, f, g); } };
    // Signal 1: a WIP commit shipped a path no agent session wrote.
    for (const s of f.shipped) if (s.wip && s.by === "harness") for (const m of ladderFor(s.path, s.ignored)) for (const g of ["none", "manifest_unchanged"] as const) { once("wip_drop", m, "harness", g); once("wip_drop", m, "any", g); }
    // Signal 2: a futile fix round (same failure after it) on a check whose failure names no changed file, or a round that edited a runner config.
    for (const r of f.fix_rounds) {
      const futile = (r.sig_same && !r.failing_in_diff) || r.edited.some((p) => nameClass(p) === "runner_config");
      if (!futile) continue;
      for (const m of [`kind:${r.kind}`, "any"]) { once("pre_red", m, "any"); once("untouched_excuse", m, "any"); }
    }
    // Signal 3: a config flag on a path no agent session wrote (it can never be the run's change).
    for (const g of f.flags) if (g.by === "harness") for (const m of ladderFor(g.path, g.ignored)) { once("flag_ignore", m, "harness"); once("flag_ignore", m, "any"); }
  }
  return [...acc.values()].filter((r) => r.support.repos.length >= MIN_REPOS).sort((a, b) => b.support.repos.length - a.support.repos.length || a.id.localeCompare(b.id));
}

// ---- hooks the harness calls (pure) --------------------------------------------------------------------------------------
const act = (rules: readonly Rule[], t: Template): Rule[] => rules.filter((r) => r.template === t && r.state === "active");
/** Paths to reset before the WIP commit, each with the rule that fired. */
export function wipDrops(rules: readonly Rule[], shipped: RunFacts["shipped"]): { path: string; rule: string }[] {
  const out: { path: string; rule: string }[] = [];
  const staged = shipped.map((s) => ({ st: "M", f: s.path }));
  for (const s of shipped) { const r = act(rules, "wip_drop").find((x) => (x.writer === "any" || x.writer === s.by) && pathMatches(x.match, s.path, s.ignored) && (x.guard === "none" || !manifestChanged(staged, s.path))); if (r) out.push({ path: s.path, rule: r.id }); }
  return out;
}
/** Whether a failing check is excused, and by which rule. `baseSig` is null when the base rerun did not run or failed to start: fail closed. */
export function excuse(rules: readonly Rule[], kind: string, headSig: string, baseSig: string | null, failingInDiff: boolean): string | null {
  for (const r of act(rules, "pre_red")) if ((r.match === "any" || r.match === `kind:${kind}`) && !failingInDiff && baseSig !== null && baseSig === headSig) return r.id; // a fail-to-pass target also fails at base: it names a changed file, so it is never excused
  for (const r of act(rules, "untouched_excuse")) if ((r.match === "any" || r.match === `kind:${kind}`) && !failingInDiff) return r.id;
  return null;
}
/** Config flags the stall rule should still count (the rest stay in NOT PROVEN with the rule id). */
export function keptFlags(rules: readonly Rule[], flags: RunFacts["flags"]): { kept: RunFacts["flags"]; dropped: { path: string; rule: string }[] } {
  const kept: RunFacts["flags"] = [], dropped: { path: string; rule: string }[] = [];
  for (const g of flags) { const r = act(rules, "flag_ignore").find((x) => (x.writer === "any" || x.writer === g.by) && pathMatches(x.match, g.path, g.ignored)); if (r) dropped.push({ path: g.path, rule: r.id }); else kept.push(g); }
  return { kept, dropped };
}

// ---- validation, selection, live monitor ---------------------------------------------------------------------------------
export interface Outcome { correct: number; false_green: number; harm: number; cost: number }
/** Accept only a strict gain in correct outcomes with zero added false greens and zero added harm. Cost may not rise by more than `costSlack`. */
export function judge(base: Outcome, withRule: Outcome, costSlack = 0): Rule["validation"] & { accept: boolean } {
  const v = { delta_correct: withRule.correct - base.correct, delta_false_green: withRule.false_green - base.false_green, delta_harm: withRule.harm - base.harm, delta_cost: +(withRule.cost - base.cost).toFixed(4) };
  return { ...v, accept: v.delta_correct > 0 && v.delta_false_green <= 0 && v.delta_harm <= 0 && v.delta_cost <= costSlack };
}
const GENERALITY: Record<string, number> = { lit: 0, base: 1, kind: 2, cls: 2, ncls: 2, any: 3 };
const gen = (r: Rule): number => (GENERALITY[r.match.split(":")[0]!] ?? 0) + (r.writer === "any" ? 1 : 0) + (r.guard === "none" ? 1 : 0);
/** Among accepted candidates of one template, keep the ones not subsumed: prefer the larger held-out gain, then the MORE general rung
 *  (a general rule that matches the gain of a specific one is the better description of the failure class). */
export function select(accepted: Rule[]): Rule[] {
  const by = new Map<Template, Rule[]>();
  for (const r of accepted) by.set(r.template, [...(by.get(r.template) ?? []), r]);
  const out: Rule[] = [];
  for (const rs of by.values()) {
    rs.sort((a, b) => (b.validation!.delta_correct - a.validation!.delta_correct) || (a.validation!.delta_cost - b.validation!.delta_cost) || (gen(b) - gen(a)));
    out.push(rs[0]!);
  }
  return out;
}
export const HARM_ROLLBACK = 2, RETIRE_AFTER = 30;
/** Live: one run's effect of a rule. Harm is observable without ground truth: a check that passed before the rule acted fails after it. */
export function observe(r: Rule, fired: boolean, harmed: boolean): Rule {
  r.live.runs++; if (fired) r.live.fired++; if (harmed) r.live.harm++;
  if (r.state === "active" && r.live.harm >= HARM_ROLLBACK) { r.state = "rolled_back"; r.why = `rolled back: ${r.live.harm} runs where a check passed before the rule acted and failed after`; }
  else if (r.state === "active" && r.live.runs >= RETIRE_AFTER && r.live.fired === 0) { r.state = "retired"; r.why = `retired: never fired in ${r.live.runs} runs`; }
  return r;
}
