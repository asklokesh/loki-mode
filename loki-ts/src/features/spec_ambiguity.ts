import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"; import { join } from "node:path";
import { symbolSpans } from "../util/context_pack.ts"; import { safeGit } from "../util/safe_git.ts"; import { ISSUE_CONTEXT_HEAD, type IssueComment } from "../engine10/fetch_issue.ts";
import { escapeRegex } from "../util/regex_escape.ts";
// Deterministic spec-ambiguity scoring for Intake (no LLM), kept outside the size-capped engine10 core.
export interface AmbiguityHit { kind: "marker" | "open_question" | "hedge" | "vague"; excerpt: string; weight: number }
const AMBIGUITY_RULES: Array<{ kind: AmbiguityHit["kind"]; weight: number; re: RegExp }> = [
  { kind: "marker", weight: 2, re: /\b(?:TBD|TBC|TODO|FIXME)\b|\?\?\?|\b[Tt]o be (?:decided|determined|defined|confirmed)\b/ }, // placeholders are case-sensitive: a status word like \"todo\" is prose, not a marker,
  { kind: "hedge", weight: 1, re: /\b(?:or something|somehow|maybe|perhaps|whatever|and so on|etc\.?|if possible|some kind of|as needed|as appropriate|appropriately|probably)\b/i },
  { kind: "vague", weight: 1, re: /\b(?:fast|quick(?:ly)?|scalable|user-friendly|intuitive|robust|modern|performant|efficient|nice|clean|easy|simple)\b/i },
];
/** Deterministic spec-ambiguity score (the no-LLM half of `loki grill`'s interrogation: unresolved markers, open questions, hedges, unmeasured quality words). A sentence with a digit never counts as vague. 0 for a clear spec. */
export function scoreAmbiguity(task: string): { score: number; hits: AmbiguityHit[] } {
  const hits: AmbiguityHit[] = [];
  for (const sent of sentencesOf(task)) {
    const cps = Array.from(sent), excerpt = cps.length > 100 ? `${cps.slice(0, 97).join("")}...` : sent; // by code point: never splits a surrogate pair
    if (/\?$/.test(sent) && /\b(?:should|which|what|whether|how|or)\b/i.test(sent)) { hits.push({ kind: "open_question", excerpt, weight: 2 }); continue; }
    for (const r of AMBIGUITY_RULES) if (r.re.test(sent) && !(r.kind === "vague" && /\d/.test(sent))) { hits.push({ kind: r.kind, excerpt, weight: r.weight }); break; }
  }
  return { score: hits.reduce((n, h) => n + h.weight, 0), hits };
}
export const ambiguityThreshold = (): number => { const n = Number(process.env.LOKI_E10_AMBIGUITY_THRESHOLD); return Number.isFinite(n) && n > 0 ? n : 5; };
/** Interactive = a person can answer now. LOKI_E10_INTAKE_ASK=1|0 forces it; LOKI_E10_ASSUME=1 (the resume choice) always proceeds on recorded assumptions. */
export function intakeInteractive(): boolean { if (process.env.LOKI_E10_ASSUME === "1") return false; const f = process.env.LOKI_E10_INTAKE_ASK; return f === "1" ? true : f === "0" ? false : Boolean(process.stdin.isTTY && process.stdout.isTTY); }
export const questionFor = (h: AmbiguityHit): string => h.kind === "open_question" ? h.excerpt : `Spec says: "${h.excerpt}" - what exactly is required (a concrete value, behaviour or acceptance check)?`;
export const assumptionFor = (h: AmbiguityHit): string => `"${h.excerpt}" taken literally: the smallest change that satisfies the stated text, no extra scope`;
// ---- Open choices: an explicit either/or in the task is settled from evidence (no model call), not left for the model to guess. ----
/** Sibling test transplant (Go): the siblings' visible tests, generalized with TYPE and RET slots and filled with the target. */
export interface Transplant { binding: boolean; why: string; statements: string[]; test: string }
export const CHOICE_PREFIX = "Open choice";
export type ChoiceBasis = "maintainer" | "task_preferred" | "existing_tests" | "precedent" | "none";
export interface OpenChoice { sentence: string; options: string[]; preferred: number | null; fallback: boolean; any?: boolean /* an "acceptable outputs" list: the options may coexist */ }
export interface ChoiceResolution extends OpenChoice { basis: ChoiceBasis; picked: number | null; evidence: string; precedent?: string; transplant?: Transplant }
/** comments: the trusted comments intake read from issue.json (never parsed back out of the task text, which an issue author could forge). */
export interface ChoiceCtx { repoDir?: string; comments?: Pick<IssueComment, "author" | "association" | "body">[]; probe?: boolean /* voteOpenChoices only: attach the sibling listing even without a vote */; votes?: (number | null | undefined)[] /* per choice: option index the siblings follow, null = they disagree (NEITHER), undefined = no vote ran */ }
const trunc = (s: string, n: number): string => { const cps = Array.from(s.replace(/\s+/g, " ").trim()); return cps.length > n ? `${cps.slice(0, n - 3).join("")}...` : cps.join(""); };
const AUX = "should|would|does|do|is|are|can|will|must";
const LIST_ITEM = /^\s*(?:(?:[-*+]|\d+[.)]|\(\d+\)|[A-Da-d][.)])\s+|(?:#+\s*)?(?:\*\*)?(?:option|solution|approach|alternative|proposal)\s*#?\(?(\d+|[A-Da-d])\)?(?:\*\*)?\s*[:.)-]\s*)(.+)$/i;
const LIST_HEAD = /\b(?:(?:possible|proposed|suggested|potential)\s+(?:solutions?|fix(?:es)?|approach(?:es)?|resolutions?)|options|alternatives|acceptable|any of the following|one of the following|either of)\b/i;
const PREF = /\b(?:prefer(?:red|ably)?|recommended|ideal(?:ly)?|best|first choice|my preference)\b/i, FALLBACK = /\b(?:workaround|fall ?back|alternatively|as a last resort|less ideal|second choice|stop-?gap|temporary|hack)\b/i;
const PREF_NAMED = [/\b(?:prefer(?:red)?|recommend(?:ed)?|go with|best)\b[^.\n]{0,30}?\b(?:option|solution|approach|fix|choice|alternative)\s*#?\(?(\d+|[A-Da-d])\)?/i, /\b(?:option|solution|approach|fix|choice|alternative)\s*#?\(?(\d+|[A-Da-d])\)?\s+(?:is|would be|seems)\s+(?:the\s+)?(?:preferred|recommended|best|ideal|better|right)/i];
const sentencesOf = (t: string): string[] => t.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
const cleanOpt = (s: string): string => s.replace(new RegExp(`^(?:so,?\\s+|and\\s+)?(?:${AUX})\\s+`, "i"), "").replace(/[?.\s]+$/, "").trim();
/** The two sides of one either/or sentence, or null. Splits at "or <aux>", ", or" or a single " or"; a sentence with several bare "or"s is not split (which "or" is meant is unknowable). */
function eitherOr(sent: string): string[] | null {
  const q = new RegExp(`^(?:so,?\\s+|and\\s+)?(?:${AUX})\\b`, "i").test(sent) && /\?$/.test(sent), w = sent.match(/\bwhether\b(.+)$/i), e = sent.match(/\beither\b\s+(.+)$/i);
  const body = q ? sent : w ? w[1]! : e ? e[1]! : null;
  if (!body) return null;
  let parts = body.split(new RegExp(`,?\\s+or\\s+(?=(?:${AUX})\\b)`, "i"));
  if (parts.length < 2) parts = body.split(/,\s+or\s+/i);
  if (parts.length < 2) { const bare = body.split(/\s+or\s+/i); if (bare.length === 2) parts = bare; }
  const opts = parts.map(cleanOpt).filter((x) => x.split(/\s+/).length >= 2);
  return parts.length === 2 && opts.length === 2 ? opts : null;
}
/** Explicit open choices in the issue part of a task: an either/or sentence, an option list (Possible solution, Options, "Option 1:"), or a "preferred ... alternatively" pair. At most 3. */
export function detectOpenChoices(issue: string): OpenChoice[] {
  const out: OpenChoice[] = [], lines = issue.split("\n"), labelPref = (items: { label: string; text: string }[]): number | null => {
    for (const re of PREF_NAMED) { const m = issue.match(re); if (m) { const k = items.findIndex((it, i) => it.label.toLowerCase() === m[1]!.toLowerCase() || String(i + 1) === m[1]); if (k >= 0) return k; } }
    return null;
  };
  for (let i = 0; i < lines.length; i++) { // option lists
    if (!LIST_ITEM.test(lines[i]!)) continue;
    const items: { label: string; text: string }[] = []; let j = i, labeled = false;
    for (; j < lines.length; j++) {
      const m = lines[j]!.match(LIST_ITEM);
      if (m) { labeled ||= m[1] !== undefined; items.push({ label: m[1] ?? String(items.length + 1), text: m[2]!.trim() }); } else if (/^\s{2,}\S/.test(lines[j]!) && items.length) items[items.length - 1]!.text += ` ${lines[j]!.trim()}`; else if (lines[j]!.trim() !== "") break;
    }
    let k = i - 1; while (k >= 0 && lines[k]!.trim() === "") k--;
    const intro = k >= 0 ? lines[k]! : "";
    if (items.length >= 2 && items.length <= 6 && (labeled || (LIST_HEAD.test(intro) && !/considered/i.test(intro)))) {
      const fb = items.map((it) => FALLBACK.test(it.text)), pf = items.findIndex((it, n) => PREF.test(it.text) && !fb[n]), keep = items.map((_, n) => n).filter((n) => !fb[n]);
      const preferred = pf >= 0 ? pf : fb.some(Boolean) && keep.length === 1 ? keep[0]! : labelPref(items);
      out.push({ sentence: trunc(intro.replace(/^[#\s*]+/, "").trim() || items.map((x) => x.text).join(" / "), 100), options: items.map((it) => it.text), preferred, fallback: fb.some(Boolean), any: /acceptable|any of the following|one of the following|either of/i.test(intro) });
    }
    i = j - 1;
  }
  const sents = sentencesOf(issue);
  for (const s of sents) { const o = eitherOr(s); if (o) out.push({ sentence: s, options: o, preferred: null, fallback: false }); }
  if (!out.length) { // prose pair: a preferred sentence, then an alternative or workaround sentence
    const p = sents.findIndex((s) => PREF.test(s) && !/\?$/.test(s)), q = p >= 0 ? sents.findIndex((s, n) => n > p && FALLBACK.test(s)) : -1;
    if (p >= 0 && q >= 0) out.push({ sentence: sents[p]!, options: [sents[p]!, sents[q]!], preferred: 0, fallback: true });
  }
  return out.slice(0, 3);
}
const STOP = new Set("the and for are not but with that this from should would could can will does has have its their then than into when what which also only just any all one two out use used using".split(" "));
const tokens = (t: string): Set<string> => { const s = new Set<string>(); for (const w of t.toLowerCase().match(/[a-z0-9_]+(?:\.[a-z0-9_]+)*/g) ?? []) { for (const p of [w, ...w.split(".")]) if (p.length >= 3 && !STOP.has(p)) s.add(p); } return s; };
const distinct = (sets: Set<string>[]): Set<string>[] => sets.map((s, i) => new Set([...s].filter((w) => sets.every((o, j) => j === i || !o.has(w)))));
/** Tokens that came from a dotted identifier (a.b): every option and every comment about it repeats those, so an overlap on them says little about WHICH option a maintainer chose. */
const symbolTokens = (t: string): Set<string> => { const s = new Set<string>(); for (const w of t.toLowerCase().match(/[a-z0-9_]+(?:\.[a-z0-9_]+)+/g) ?? []) for (const p of [w, ...w.split(".")]) s.add(p); return s; };
type Cmt = Pick<IssueComment, "author" | "association" | "body">;
const DECISION = /\b(?:should|let'?s|we'?ll|we will|prefer|go with|better|makes? sense|agree|instead|the right|please|i'?d|i would|lgtm)\b/i, NEGATION = /\b(?:don'?t|do not|shouldn'?t|should not|not|never)\b/i;
function byMaintainer(c: OpenChoice, comments: Cmt[]): { k: number; evidence: string } | null {
  const d = distinct(c.options.map(tokens));
  for (const cm of [...comments].reverse()) for (const s of sentencesOf(cm.body).reverse()) {
    if (!DECISION.test(s) || /\beither\b.*\bor\b/i.test(s)) continue;
    const t = tokens(s), sym = symbolTokens(`${s} ${c.options.join(" ")}`), score = d.map((x) => [...x].filter((w) => t.has(w)).reduce((n, w) => n + (sym.has(w) ? 1 : 3), 0)), best = Math.max(...score); // a content word outweighs a symbol fragment
    if (best < 1 || score.filter((n) => n === best).length !== 1) continue;
    let k = score.indexOf(best);
    if (NEGATION.test(s)) { if (c.options.length !== 2) continue; k = 1 - k; }
    return { k, evidence: `latest maintainer comment by ${cm.author} (${cm.association}): "${trunc(s, 90)}"` };
  }
  return null;
}
const snippetsOf = (opt: string): string[] => [...new Set([...(opt.match(/`([^`]{3,80})`/g) ?? []).map((x) => x.slice(1, -1)), ...(opt.match(/"([^"\n]{3,80})"/g) ?? []).map((x) => x.slice(1, -1)), ...(opt.match(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Za-z]+_[A-Za-z_]+\b/g) ?? [])])].filter((x) => x.replace(/\s/g, "").length >= 4 && /[^A-Za-z0-9_\s]|[a-z][A-Z]|_/.test(x)); // a bare word is not a literal worth looking for
const TEST_DOC = /(?:^|\/)(?:tests?|__tests__|docs?|spec)\/|[._-](?:test|spec)\.\w+$|_test\.\w+$|(?:^|\/)test_[^/]*\.py$|\.mdx?$/i;
function corpus(repoDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  let tracked: string[] = []; try { tracked = safeGit(repoDir, ["ls-files", "-z"], { timeout: 5000, maxBuffer: 64 << 20 }).split("\0"); } catch { /* not a git repo: no corpus, and never a walk of an unknown folder */ }
  for (const f of tracked.filter((p) => TEST_DOC.test(p)).slice(0, 600)) {
    try { if (statSync(join(repoDir, f)).size <= 200_000) out.push({ path: f, text: readFileSync(join(repoDir, f), "utf8").replace(/\s+/g, "") }); } catch { /* unreadable file: not evidence */ }
  }
  return out;
}
const CURRENT_CUE = /\b(?:returns?|returned|currently|today|actually|emits?|outputs?|gives?|produces?|bug|buggy|wrong|instead of|panics?)\b/i, EXPECT_CUE = /\b(?:expected|should (?:be|return|give|produce|output|yield)|must (?:be|return))\b/i;
/** True when the issue itself says the pinned option's literal is today's (buggy) behavior, or states an expected result that does not contain it: a test pinning that literal then proves nothing about what is wanted. */
function issueContradictsPin(c: OpenChoice, issue: string, pinned: string[]): boolean {
  const norm = (x: string): string => x.replace(/\s+/g, ""), has = (sent: string): boolean => pinned.some((p) => norm(sent).includes(norm(p)));
  const rest = sentencesOf(issue).filter((x) => x !== c.sentence && !c.options.some((o) => x.includes(o)) && !/\?$/.test(x));
  return rest.some((x) => (has(x) && CURRENT_CUE.test(x)) || (EXPECT_CUE.test(x) && !has(x)));
}
function byExistingTests(c: OpenChoice, repoDir: string, issue: string): { k: number; evidence: string } | null {
  const per = c.options.map(snippetsOf), uniq = per.map((s, i) => s.filter((x) => per.every((o, j) => j === i || !o.includes(x)))), files = corpus(repoDir);
  const hit = uniq.map((s) => s.flatMap((x) => { const f = files.find((y) => y.text.includes(x.replace(/\s+/g, ""))); return f ? [{ x, path: f.path }] : []; }));
  const n = hit.map((h) => h.length), best = Math.max(...n);
  if (best < 1 || n.filter((v) => v === best).length !== 1) return null;
  const k = n.indexOf(best);
  if (issueContradictsPin(c, issue, hit[k]!.map((h) => h.x))) return null; // the issue's own account of the bug or the expected result outranks a test that may pin the bug
  return { k, evidence: `existing tests or docs already pin it (${hit[k]!.slice(0, 2).map((h) => `\`${trunc(h.x, 40)}\` in ${h.path}`).join("; ")}); the other option has ${Math.min(...n.filter((_, i) => i !== k))} pinned` };
}
/** One line of recent history for the symbols the options name: the newest commits touching their defining files, local history at the checked-out commit only (never a network fetch, never a linked PR or issue-number search). "" when unavailable. */
function historyLine(c: OpenChoice, ctx: ChoiceCtx): string {
  if (!ctx.repoDir) return "";
  const git = (a: string[]): string => { try { return safeGit(ctx.repoDir!, a, { timeout: 5000, maxBuffer: 1 << 20 }).trim(); } catch { return ""; } };
  const syms = [...new Set(c.options.flatMap(snippetsOf).filter((x) => /^[\w.]+$/.test(x)))].slice(0, 3), paths = new Set<string>();
  for (const s of syms) for (const f of git(["grep", "-l", "-F", "-e", s, "--", ".", ":(exclude)*test*", ":(exclude)*.md"]).split("\n").filter(Boolean).slice(0, 2)) paths.add(f);
  const log = paths.size ? git(["log", "-n", "3", "--format=%h %s", "--", ...paths]).split("\n").filter(Boolean) : [];
  return trunc(log.length ? `recent history of the touched code at the base commit: ${log.join("; ")}` : "", 240);
}
const SRC = /\.(?:go|ts|tsx|js|jsx|mjs|py|rs|java|kt|rb|cs)$/, TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec)\/|[._-](?:test|spec)\.\w+$|_test\.\w+$|(?:^|\/)test_[^/]*\.py$/i, ASSERT = /\b(?:expect|assert|require|Equal|toBe|toEqual|Eq)\w*\b/;
/** Sibling implementations of the contract an option names, from the checked-out snapshot only: for each `Type.member` in the options, the other definitions of `member` on other types, and the test lines that assert it. Handed to the model as a short block; the model, not this code, judges which option the siblings follow. "" when none. */
function precedentFor(c: OpenChoice, repoDir: string): string {
  const dotted = [...new Set(c.options.flatMap((o) => o.match(/\b[A-Za-z_]\w*\.[A-Za-z_]\w*\b/g) ?? []))].slice(0, 4);
  if (!dotted.length) return "";
  let tracked: string[] = []; try { tracked = safeGit(repoDir, ["ls-files", "-z"], { timeout: 5000, maxBuffer: 64 << 20 }).split("\0").filter((p) => SRC.test(p)).slice(0, 800); } catch { return ""; }
  const defs: string[] = [], tests: string[] = [], seen = new Set<string>();
  for (const f of tracked) {
    let lines: string[]; try { if (statSync(join(repoDir, f)).size > 200_000) continue; lines = readFileSync(join(repoDir, f), "utf8").split("\n"); } catch { continue; }
    const isTest = TEST_FILE.test(f);
    for (const d of dotted) {
      const [type, member] = d.split("."), esc = member!.replace(/[^\w]/g, "");
      const defRe = new RegExp(`^\\s*(?:func\\s*\\([^)]*\\)\\s*${esc}\\s*\\(|(?:pub\\s+)?(?:async\\s+)?(?:fn|def|function)\\s+${esc}\\s*[<(]|(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+|get\\s+|set\\s+)*${esc}\\s*\\([^)]*\\)\\s*(?::[^{=]+)?\\{)`), callRe = new RegExp(`\\.${esc}\\(`);
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i]!;
        if (!isTest && defs.length < 5 && defRe.test(ln) && !new RegExp(`\\b${type}\\b`).test(ln) && !seen.has(`${f}:${i}`)) { seen.add(`${f}:${i}`); defs.push(`${f}:${i + 1} ${trunc(lines.slice(i, i + 4).join(" "), 170)}`); }
        else if (isTest && tests.length < 3 && callRe.test(ln) && ASSERT.test(ln)) tests.push(`${f}:${i + 1} ${trunc(ln, 120)}`);
      }
    }
    if (defs.length >= 5 && tests.length >= 3) break;
  }
  return trunc([...defs.map((x) => `sibling ${x}`), ...tests.map((x) => `test ${x}`)].join(" | "), 800);
}
const goStatements = (body: string): string[] => {
  const out: string[] = []; let cur: string[] = [], depth = 0;
  for (const line of body.split("\n")) { cur.push(line); for (const ch of line) { if (ch === "{") depth++; else if (ch === "}") depth--; } if (depth === 0 && cur.join("").trim()) { out.push(cur.join("\n").trim()); cur = []; } }
  return out;
};
const reEsc = escapeRegex;
/** Only an issue that says the target behaves like its siblings makes the transplant binding; a list of acceptable outputs is the spec itself and never does. */
/** The last CamelCase word that at least two sibling type names share (IntFlag, BoolFlag -> Flag): the family a sentence can name as "the other flags". */
const familyStem = (types: string[]): string | null => { const n = new Map<string, number>(); for (const t of types) { const w = /[A-Z][a-z0-9]*$/.exec(t)?.[0]; if (w && w !== t) n.set(w, (n.get(w) ?? 0) + 1); } const best = [...n].sort((a, b) => b[1] - a[1])[0]; return best && best[1] >= 2 ? best[0] : null; };
/** One sentence with a comparison cue that also names something the repo knows: a sibling type name, or the family ("the other flags" for IntFlag and BoolFlag). The sentence must also name the target type or member. A bare "other platforms", "the other release" or "as" names no sibling, so it never binds. */
export const saysLikeSiblings = (issue: string, siblingTypes: string[] = [], target: string[] = []): boolean => { const stem = familyStem(siblingTypes); return issue.split(/(?<=[.!?])\s+|\n+/).some((st) => /\b(?:like|consistent with|matches|same as)\b/i.test(st) && target.some((t) => new RegExp(`\\b${reEsc(t)}\\b`).test(st)) && (siblingTypes.some((t) => new RegExp(`\\b${reEsc(t)}\\b`).test(st)) || (stem !== null && new RegExp(`\\bother ${reEsc(stem)}s?\\b`, "i").test(st)))); };
/** Deterministic, no model call. A shared statement is a repo convention only when 2 or more sibling tests contain it byte for byte after generalization; a lone declaration is never a case. Binding needs the issue to ask for sibling behavior; otherwise advisory. Go only; null when the picked option names no qualified return type for the target. */
export function transplantFor(c: OpenChoice, picked: number, issue: string, repoDir: string, precedent: string, mayBind = false): Transplant | null {
  try {
    const sibs = [...precedent.matchAll(/sibling (\S+?):\d+ func \(\w+ \*?(\w+)\) (\w+)\(\) ([^{]+?) \{/g)].map((m) => ({ file: m[1]!, type: m[2]!, member: m[3]!, ret: m[4]!.trim() }));
    if (sibs.length < 2 || !sibs[0]!.file.endsWith(".go")) return null;
    const types = new Set(sibs.map((x) => x.type)), opt = c.options[picked] ?? "";
    const tgt = [...new Set(c.options.flatMap((o) => o.match(/\b[A-Za-z_]\w*\.[A-Za-z_]\w*\b/g) ?? []))].map((d) => d.split(".") as [string, string]).find(([t, m]) => !types.has(t) && sibs.some((x) => x.member === m) && opt.includes(`${t}.${m}`));
    const ret = /\b[a-z]+\.[A-Z]\w*\b/.exec(opt.replace(tgt ? `${tgt[0]}.${tgt[1]}` : "", ""))?.[0];
    if (!tgt || !ret) return null;
    const tests = safeGit(repoDir, ["ls-files", "-z"], { timeout: 5000, maxBuffer: 64 << 20 }).split("\0").filter((f) => f.endsWith("_test.go")).slice(0, 200).map((f) => { try { return readFileSync(join(repoDir, f), "utf8"); } catch { return ""; } }).join("\n");
    const bodies = new Map<string, string[]>();
    for (const x of sibs) { const fn = new RegExp(`^func (Test\\w*${reEsc(x.type)}\\w*)\\(t \\*testing\\.T\\) \\{\\n([\\s\\S]*?)^\\}`, "m").exec(tests); if (fn) bodies.set(x.type, goStatements(fn[2]!).map((st) => st.replace(new RegExp(`\\b${reEsc(x.type)}\\b`, "g"), "TYPE").replace(new RegExp(`(var \\w+ )${reEsc(x.ret)}$`, "m"), "$1RET"))); }
    const count = new Map<string, number>(); for (const sts of bodies.values()) for (const st of new Set(sts)) count.set(st, (count.get(st) ?? 0) + 1);
    const all = [...count].filter(([, n]) => n >= 2).map(([st]) => st), decl = (st: string): string | null => /^var (\w+) /.exec(st)?.[1] ?? null;
    const shared = all.filter((st) => { const v = decl(st); return v === null || all.some((o) => o !== st && new RegExp(`\\b${v}\\b`).test(o)); });
    if (!shared.some((st) => decl(st) === null)) return null;
    const fill = (st: string): string => st.replace(/\bTYPE\b/g, tgt[0]).replace(/\bRET\b/g, ret), imports = [...new Set([...ret.matchAll(/\b([a-z]\w*)\./g)].map((m) => m[1]!))];
    const pkg = /^package (\w+)/m.exec(readFileSync(join(repoDir, sibs[0]!.file), "utf8"))?.[1] ?? "";
    const test = `package ${pkg}\n\nimport (\n\t"testing"\n${imports.map((i) => `\t"${i}"\n`).join("")})\n\nfunc TestLokiTransplant_${tgt[0]}${tgt[1]}(t *testing.T) {\n${shared.map((st) => `\t${fill(st).split("\n").join("\n")}`).join("\n")}\n}\n`;
    const binding = mayBind && saysLikeSiblings(issue, [...types], [tgt[0], tgt[1]]);
    return { binding, why: binding ? `${shared.length} statement(s) shared by 2+ sibling tests, and the issue asks for sibling behavior` : mayBind ? "shared by 2+ sibling tests, but the issue does not ask for sibling behavior: advisory" : "shared by 2+ sibling tests; the option was settled by something other than the sibling vote: advisory", statements: shared.map(fill), test };
  } catch { return null; }
}
/** Precedent is ON by default; LOKI_E10_PRECEDENT=0 opts out. */
export const precedentOn = (): boolean => process.env.LOKI_E10_PRECEDENT !== "0";
/** One tool-less question per open choice: which option do the sibling implementations follow. The voter sees only the options and the sibling bodies. */
export const SYS_PRECEDENT_VOTE = "You compare code conventions. Answer only in the requested format.";
export function precedentVotePrompt(c: OpenChoice, siblings: string, comments: string[] = [], issue = ""): string {
  return [`A change must pick one of these options:\n${c.options.map((o, i) => `OPTION ${i + 1}: ${o}`).join("\n")}`, `Other implementations of the same contract in this repository:\n${siblings}`, ...(issue ? [`The issue text (if it states a hard requirement that rules out an option, such as that a behavior must not change, answer NEITHER; a mere preference does not count):\n${trunc(issue, 1500)}`] : []), ...(comments.length ? [`Maintainer comments on the issue (a maintainer who already chose an option outranks the siblings: answer NEITHER then):\n${comments.map((x) => trunc(x, 400)).join("\n---\n")}`] : []), "Which option makes the changed code follow the same convention as these other implementations? If they do not all follow the same one, answer NEITHER.", "Answer with exactly one line: OPTION <n> or NEITHER."].join("\n\n");
}
/** The option index the answer names, or null for NEITHER, an unparseable answer or an out-of-range number. */
export function parsePrecedentVote(text: string, n: number): number | null {
  const m = /\bOPTION\s*(\d+)\b/i.exec(text); if (!m || /\bNEITHER\b/i.test(text.split("\n")[0] ?? "")) return null;
  const k = Number(m[1]) - 1; return k >= 0 && k < n ? k : null;
}
/** Full-text sibling definitions for the vote: each definition `precedentFor` lists, with its body up to 12 lines. */
export function siblingBodies(precedent: string, repoDir: string): string {
  const out: string[] = [];
  for (const m of precedent.matchAll(/sibling (\S+?):(\d+) /g)) {
    try {
      const src = readFileSync(join(repoDir, m[1]!), "utf8"), lines = src.split("\n"), at = Number(m[2]);
      const sp = symbolSpans(m[1]!, src).filter((x) => !x.container && x.start <= at && at <= x.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]; // the innermost definition holding the line, cut at its own end
      const from = sp ? sp.start : at, to = sp ? Math.min(sp.end, from + 59) : Math.min(lines.length, from + 11);
      out.push(`${m[1]}:${m[2]}\n${lines.slice(from - 1, to).join("\n")}`);
    } catch { /* unreadable: skipped */ }
  }
  return out.join("\n\n");
}
/** The sibling definitions a precedent text lists, as [file:line, "Type.member() RET" or ""] pairs. */
const siblingList = (precedent: string): { at: string; sig: string }[] => [...precedent.matchAll(/sibling (\S+?:\d+) (?:func \(\w+ \*?(\w+)\) (\w+)\([^)]*\) ([^{]+?) \{)?/g)].map((m) => ({ at: m[1]!, sig: m[2] ? `${m[2]}.${m[3]}() ${m[4]!.trim()}` : "" }));
/** Deterministic refusal: when every sibling body is one `return <expr>` and the expressions differ (receiver name abstracted), the siblings visibly disagree, so no vote is taken and nothing is emitted. */
export function siblingsDisagree(precedent: string, repoDir: string): boolean {
  const exprs: string[] = [];
  for (const body of siblingBodies(precedent, repoDir).split("\n\n")) {
    const lines = body.split("\n").slice(1), head = lines[0] ?? "", recv = /\((\w+) \*?\w+\)|\b(this|self)\b/.exec(head)?.[1] ?? "", inner = lines.slice(1, -1).map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
    if (inner.length !== 1 || !/^return\b/.test(inner[0]!)) return false;
    exprs.push(inner[0]!.replace(recv ? new RegExp(`\\b${recv}\\b`, "g") : /$^/, "R"));
  }
  return exprs.length >= 2 && new Set(exprs).size > 1;
}
/** Go: the siblings' return types for the member are split against the target's current return type (some already return what the target returns now, some do not). Siblings that are not unanimous against the target's current behavior cannot settle the either/or, so no vote and no line. */
export function siblingsSplitOnTarget(c: OpenChoice, precedent: string, repoDir: string): boolean {
  try {
    const sibs = siblingList(precedent).filter((x) => x.sig), types = new Set(sibs.map((x) => x.sig.split(".")[0]!)), members = new Set(sibs.map((x) => /\.(\w+)\(\)/.exec(x.sig)![1]!));
    const tgt = [...new Set(c.options.flatMap((o) => o.match(/\b[A-Za-z_]\w*\.[A-Za-z_]\w*\b/g) ?? []))].map((d) => d.split(".") as [string, string]).find(([t, m]) => !types.has(t) && members.has(m));
    if (sibs.length < 2 || !tgt) return false;
    const def = new RegExp(`^func \\(\\w+ \\*?${reEsc(tgt[0])}\\) ${reEsc(tgt[1])}\\([^)]*\\) ([^{]+?) \\{`, "m");
    for (const f of safeGit(repoDir, ["ls-files", "-z"], { timeout: 5000, maxBuffer: 64 << 20 }).split("\0").filter((x) => x.endsWith(".go") && !x.endsWith("_test.go")).slice(0, 300)) {
      const cur = def.exec(readFileSync(join(repoDir, f), "utf8"))?.[1]?.trim(); if (!cur) continue;
      const same = sibs.filter((x) => x.sig.replace(/^\S+\s/, "") === cur).length; return same > 0 && same < sibs.length;
    }
  } catch { /* unreadable: no split claimed */ }
  return false;
}
/** A trusted comment that names a symbol of one of the options: its author may already have decided, in words the cue detector cannot place, so no vote may steer against it. */
export function commentMentionsOption(c: OpenChoice, comments: { body: string }[] = []): boolean {
  const syms = [...new Set(c.options.flatMap((o) => snippetsOf(o).flatMap((x) => [x, ...x.split(".")])))].filter((x) => x.length >= 3);
  return comments.some((cm) => syms.some((x) => cm.body.includes(x)));
}
export type PrecedentCall = (system: string, prompt: string) => Promise<string | null>;
/** The default voter: toolLessCall on the small model, thinking off, priced into the child ledger and cut off by the run's dollar cap. null on any non-ok outcome. */
async function defaultVoteCall(system: string, prompt: string): Promise<string | null> {
  const { toolLessCall } = await import("../runner/sdk_invoker.ts"), { modelRouteModel } = await import("../providers/model_routes.ts");
  const dir = process.env["LOKI_DIR"], r = await toolLessCall({ model: process.env["LOKI_E10_PRECEDENT_MODEL"] || modelRouteModel() || "claude-haiku-5-5", system, prompt, maxTokens: 1024, thinking: "off", timeoutMs: 30_000, ...(dir ? { ledger: { lokiDir: dir, phase: "precedent-vote" } } : {}) });
  return r.outcome.kind === "ok" ? r.outcome.value : null;
}
/** One vote per open choice that nothing else decided (no maintainer reply, no stated preference, no pinned test, not an acceptable-outputs list) and that has at least two sibling definitions. Fewer than two siblings cannot agree, so no call. Never throws; a failed or capped call leaves that entry undefined. */
export async function voteOpenChoices(task: string, ctx: ChoiceCtx = {}, call: PrecedentCall = defaultVoteCall): Promise<(number | null | undefined)[]> {
  try {
    if (!precedentOn() || !ctx.repoDir) return [];
    const base = resolveChoices(task, { ...ctx, votes: undefined, probe: true }), choices = base.map((c) => c.basis === "none" && !c.any && (c.precedent?.match(/sibling /g) ?? []).length >= 2 && !commentMentionsOption(c, ctx.comments) && !siblingsDisagree(c.precedent!, ctx.repoDir!) && !siblingsSplitOnTarget(c, c.precedent!, ctx.repoDir!) ? c : null);
    return await Promise.all(choices.map(async (c) => {
      if (!c) return undefined;
      const prompt = precedentVotePrompt(c, siblingBodies(c.precedent!, ctx.repoDir!), (ctx.comments ?? []).map((x) => x.body), task.includes(ISSUE_CONTEXT_HEAD) ? task.slice(0, task.lastIndexOf(ISSUE_CONTEXT_HEAD)) : task);
      const text = await call(SYS_PRECEDENT_VOTE, prompt);
      return text === null ? undefined : parsePrecedentVote(text, c.options.length);
    }));
  } catch { return []; }
}
/** Settles each open choice in the task, in this order: the latest maintainer comment, the option the task names as preferred, the option existing tests and docs already pin, else none (the line then says to keep every existing test true and satisfy both where compatible). Deterministic, no model call, never throws. */
const prec0 = (c: OpenChoice, repoDir: string | undefined): string => (repoDir ? precedentFor(c, repoDir) : "");
export function resolveChoices(task: string, ctx: ChoiceCtx = {}): ChoiceResolution[] {
  try {
    const comments = (ctx.comments ?? []).filter((c) => typeof c?.author === "string" && typeof c.association === "string" && typeof c.body === "string"), at = comments.length ? task.lastIndexOf(ISSUE_CONTEXT_HEAD) : -1, issue = at < 0 ? task : task.slice(0, at); // the appended comment section is not the issue's own question
    return detectOpenChoices(issue).map((c, i): ChoiceResolution => {
      const r = settle(c, comments, ctx, issue), vote = ctx.votes?.[i];
      if (c.any || !ctx.repoDir || !precedentOn() || (r.basis === "none" && ((typeof vote !== "number" && !ctx.probe) || siblingsDisagree(prec0(c, ctx.repoDir), ctx.repoDir!) || siblingsSplitOnTarget(c, prec0(c, ctx.repoDir), ctx.repoDir!) || (typeof vote === "number" && commentMentionsOption(c, comments))))) return r; // the issue's own list of acceptable outputs beats the siblings; siblings that disagree (vote null) emit nothing
      const prec = precedentFor(c, ctx.repoDir);
      const out: ChoiceResolution = r.basis === "none" && prec && typeof vote === "number" && vote >= 0 && vote < c.options.length ? { ...r, basis: "precedent", picked: vote, evidence: `a one-call vote over ${siblingList(prec).length} sibling definitions picked it (${siblingList(prec).map((x) => x.sig ? `${x.sig} at ${x.at}` : x.at).join("; ")}); the siblings may not be unanimous, and the issue's own words and any maintainer comment outrank it`, precedent: prec } : prec ? { ...r, precedent: prec } : r;
      const tp = out.picked !== null && prec ? transplantFor(c, out.picked, issue, ctx.repoDir, prec, out.basis === "precedent") : null;
      return tp ? { ...out, transplant: tp } : out; // a maintainer, the issue's own preference or a pinned test settle first: the precedent is then only shown as a check
    });
  } catch { return []; }
}
function settle(c: OpenChoice, comments: Cmt[], ctx: ChoiceCtx, issue: string): ChoiceResolution {
  const m = byMaintainer(c, comments);
  if (m) return { ...c, basis: "maintainer", picked: m.k, evidence: m.evidence };
  if (c.preferred !== null) return { ...c, basis: "task_preferred", picked: c.preferred, evidence: `the task text names it as preferred${c.fallback ? " and offers the other only as a fallback" : ""}` };
  const t = ctx.repoDir ? byExistingTests(c, ctx.repoDir, issue) : null, h = historyLine(c, ctx);
  if (t) return { ...c, basis: "existing_tests", picked: t.k, evidence: [t.evidence, h].filter(Boolean).join(". ") };
  return { ...c, basis: "none", picked: null, evidence: ["no maintainer reply, stated preference or pinned test or doc decides it", h].filter(Boolean).join(". ") };
}
/** The one assumptions line for a resolved choice: the option to implement and its one-line evidence (copied into the receipt and the per-run brief). */
export const choiceLine = (c: ChoiceResolution): string => {
  const prec = c.precedent ? ` Sibling precedent in this repo (${c.picked === null ? "prefer the option these follow" : "check your option against these"}): ${c.precedent}.` : "";
  const both = c.any ? " The task lists several acceptable outputs: where they can coexist, build one design that produces every one of them." : "";
  return c.picked === null
    ? `${CHOICE_PREFIX}: "${trunc(c.sentence, 110)}" -> no evidence picks one (${c.evidence}).${prec}${both} Keep every existing test and documented behavior true, satisfy both options where they do not conflict, and name the one you chose.`
    : `${CHOICE_PREFIX}: "${trunc(c.sentence, 110)}" -> implement option ${c.picked + 1}: "${trunc(c.options[c.picked]!, 130)}". Evidence (${c.basis}): ${c.evidence}.${c.fallback ? " A fallback may be added only on top of it." : ""}${c.basis === "precedent" || c.transplant ? ` The issue's own words and any maintainer comment outrank this line.${(c.precedent?.match(/sibling /g) ?? []).length >= 2 ? " If an existing test pins the other option of this one member and the issue does not ask to keep it, that test may be updated to this option; every other test stays true." : ""}` : ""}${prec}${both}${c.transplant ? (c.transplant.binding ? ` Binding sibling test: add it to the package as a new _test.go file and make it pass; do not edit it, and do not change the target to satisfy another test (${c.transplant.why}):\n${c.transplant.test}` : ` Advisory, the sibling tests also check for the target (${c.transplant.why}): ${c.transplant.statements.map((x) => trunc(x, 120)).join(" | ")}`) : ""}`;
};
/** The lines worth sending: a choice nothing decided and nothing could inform (no precedent, not an acceptable-outputs list) is just a question ("faster or cheaper?"), not a spec choice, so it emits nothing. */
export const emitChoiceLines = (cs: ChoiceResolution[]): string[] => cs.filter((c) => c.basis !== "none" || c.precedent || c.any).map(choiceLine);
/** Ambiguity gate: one batched question set, never a silent stall or a guessing loop. Interactive: `stop` carries the checkpoint file and resume offer. Headless: `data` carries the assumptions (copied into the receipt) and intake goes on. A clear spec yields `data: {}`.
 *  An explicit open choice (resolveChoices) is answered from evidence first: its line joins the assumptions, and a choice that evidence settled is not asked of a person. */
export function ambiguityGate(task: string, runDir: string, ctx: ChoiceCtx = {}): { stop?: { failData: Record<string, unknown>; reason: string }; data: Record<string, unknown> } {
  const choices = resolveChoices(task, ctx), choiceLines = emitChoiceLines(choices), settled = choices.filter((c) => c.basis !== "none").map((c) => c.sentence);
  const amb = scoreAmbiguity(task), hits = amb.hits.filter((h) => !settled.some((s) => s === h.excerpt || (h.excerpt.endsWith("...") && s.startsWith(h.excerpt.slice(0, -3)))));
  const score = hits.reduce((n, h) => n + h.weight, 0);
  if (score < ambiguityThreshold()) return { data: choiceLines.length ? { assumptions: choiceLines } : {} };
  const qs = [...new Set(hits.map(questionFor))].slice(0, 8), assumptions = [...new Set(hits.map(assumptionFor))].slice(0, 8);
  if (!intakeInteractive()) return { data: { ambiguity_score: score, assumptions: [...assumptions, ...choiceLines] } };
  mkdirSync(runDir, { recursive: true });
  const checkpoint = join(runDir, "intake-questions.md");
  writeFileSync(checkpoint, `# Spec needs clarification (ambiguity score ${score})\n\n${qs.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n`, "utf8");
  return { data: {}, stop: { failData: { ambiguity_score: score, questions: qs, checkpoint }, reason: `spec is ambiguous (score ${score}); ${qs.length} question(s) in ${checkpoint}. Resume: answer them in the task text and rerun, run \`loki grill\` for a deeper interrogation, or rerun with LOKI_E10_ASSUME=1 to proceed on recorded assumptions` } };
}
/** Per-run prompt lines (after the task, never in the cache-stable prefix) telling plan and implement to work on the recorded assumptions instead of guessing. Empty when none. A choice line (CHOICE_PREFIX) says it was settled from evidence, so it gets its own header. */
export function assumptionsBlock(assumptions: unknown): string[] {
  const list = Array.isArray(assumptions) ? assumptions.filter((a): a is string => typeof a === "string" && a.length > 0) : [];
  const num = (xs: string[]): string => xs.map((a, i) => `${i + 1}. ${a}`).join("\n"), choices = list.filter((a) => a.startsWith(CHOICE_PREFIX)), plain = list.filter((a) => !a.startsWith(CHOICE_PREFIX));
  return [...(plain.length ? [`The task text is ambiguous and nobody could be asked. Work on these recorded assumptions, no extra scope, and say in your final message where one mattered:\n${num(plain)}`] : []),
    ...(choices.length ? [`The task leaves a choice open. Each line gives the option to implement and the evidence from the task and the repo (or the rule to follow when none decides it); follow it, no extra scope, and name the option you implemented in your final message:\n${num(choices)}`] : [])];
}

// F1 ranked-remedy enforcement (LOKI_E10_RANKED_REMEDY, default on, =0 opts out). The failure it targets: an issue lists its remedies in order of preference and the change
// implements only a lower-ranked one (a fallback) in place of the first, while the correct fixes implement remedy 1. The rule
// "implement the fix the issue prefers" (FIXED_RULES) already existed and did not hold, so intake records remedy 1, the implement brief names it as the first site of the
// coverage check, and one tool-less check of the diff gates one targeted resume (util/conflict_resume.ts resumeForRemedy). Stored as intake.ranked_remedy, never in
// assumptions (those feed the open-decision cap and the consult trigger).
export const rankedRemedyEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_RANKED_REMEDY"] ?? "").trim());
const REMEDY_HEAD = /\b(?:possible|proposed|suggested|potential)\s+(?:solutions?|fix(?:es)?|approach(?:es)?|resolutions?|remed(?:y|ies))\b|\bin order of preference\b|\bpreferred\b/i;
/** The issue's first-ranked remedy: a numbered list of at least two items starting at 1 whose intro (up to 3 lines above) or nearest heading (up to 12 lines above) names a
 *  remedy list or a preference order. The item the text marks as preferred (and not as a fallback) wins over item 1. Deterministic; null when there is no ranked list. */
export function rankedRemedy(issue: string): { first: string; count: number } | null {
  const lines = issue.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " ")).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m0 = /^\s*1[.)]\s+(\S.*)$/.exec(lines[i]!); if (!m0) continue;
    const items: string[] = [m0[1]!]; let j = i + 1;
    for (; j < lines.length; j++) {
      const m = /^\s*(\d+)[.)]\s+(\S.*)$/.exec(lines[j]!);
      if (m && Number(m[1]) === items.length + 1) items.push(m[2]!); else if (/^\s{2,}\S/.test(lines[j]!) && !/^\s*\d+[.)]\s/.test(lines[j]!)) items[items.length - 1] += ` ${lines[j]!.trim()}`; else break;
    }
    const intro = lines.slice(Math.max(0, i - 3), i).join(" "), head = lines.slice(Math.max(0, i - 12), i).reverse().find((l) => /^\s*#{1,6}\s/.test(l)) ?? "";
    if (items.length >= 2 && (REMEDY_HEAD.test(intro) || REMEDY_HEAD.test(head))) {
      const pf = items.findIndex((t) => PREF.test(t) && !FALLBACK.test(t)), pick = items[pf >= 0 ? pf : 0]!;
      return { first: trunc(pick.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"), 300), count: items.length };
    }
    i = j - 1;
  }
  return null;
}
/** The per-task brief line (after the task block, never in the cache-stable prefix); [] when there is no ranked remedy. */
export const rankedRemedyBlock = (remedy: unknown): string[] => (typeof remedy === "string" && remedy ? [`The issue ranks its remedies, and its first choice is: "${remedy}". Treat it as the first named site of the coverage check: implement it, and add any other remedy only on top of it, never in its place.`] : []);
