import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"; import { join } from "node:path";
import { safeGit } from "../util/safe_git.ts"; import { ISSUE_CONTEXT_HEAD, type IssueComment } from "../engine10/fetch_issue.ts";
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
export const CHOICE_PREFIX = "Open choice";
export type ChoiceBasis = "maintainer" | "task_preferred" | "existing_tests" | "precedent" | "none";
export interface OpenChoice { sentence: string; options: string[]; preferred: number | null; fallback: boolean; any?: boolean /* an "acceptable outputs" list: the options may coexist */ }
export interface ChoiceResolution extends OpenChoice { basis: ChoiceBasis; picked: number | null; evidence: string; precedent?: string }
/** comments: the trusted comments intake read from issue.json (never parsed back out of the task text, which an issue author could forge). */
export interface ChoiceCtx { repoDir?: string; comments?: Pick<IssueComment, "author" | "association" | "body">[]; votes?: (number | null)[] /* PROTO round 3: the precedent vote per choice (precedentVotePrompt), from one tool-less call */ }
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
type Cmt = Pick<IssueComment, "author" | "association" | "body">;
const DECISION = /\b(?:should|let'?s|we'?ll|we will|prefer|go with|better|makes? sense|agree|instead|the right|please|i'?d|i would|lgtm)\b/i, NEGATION = /\b(?:don'?t|do not|shouldn'?t|should not|not|never)\b/i;
function byMaintainer(c: OpenChoice, comments: Cmt[]): { k: number; evidence: string } | null {
  const d = distinct(c.options.map(tokens));
  for (const cm of [...comments].reverse()) for (const s of sentencesOf(cm.body).reverse()) {
    if (!DECISION.test(s) || /\beither\b.*\bor\b/i.test(s)) continue;
    const t = tokens(s), score = d.map((x) => [...x].filter((w) => t.has(w)).length), best = Math.max(...score);
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
/** PROTO round 3: one tool-less question per call: which option do the sibling implementations follow. The voter sees the choice, the
 *  options and the sibling definitions (full text, gathered by precedentFor's scan), never the task's preference wording beyond the options. */
export const SYS_PRECEDENT_VOTE = "You compare code conventions. Answer only in the requested format.";
export function precedentVotePrompt(c: OpenChoice, siblings: string): string {
  return [`A change must pick one of these options:\n${c.options.map((o, i) => `OPTION ${i + 1}: ${o}`).join("\n")}`, `Other implementations of the same contract in this repository:\n${siblings}`, "Which option makes the changed code follow the same convention as these other implementations? If they do not decide it, answer NEITHER.", "Answer with exactly one line: OPTION <n> or NEITHER."].join("\n\n");
}
export function parsePrecedentVote(text: string, n: number): number | null {
  const m = /\bOPTION\s*(\d+)\b/i.exec(text); if (!m || /\bNEITHER\b/i.test(text.split("\n")[0] ?? "")) return null;
  const k = Number(m[1]) - 1; return k >= 0 && k < n ? k : null;
}
/** Full-text sibling definitions for the vote: each definition `precedentFor` lists, with its body up to 12 lines. */
export function siblingBodies(precedent: string, repoDir: string): string {
  const out: string[] = [];
  for (const m of precedent.matchAll(/sibling (\S+?):(\d+) /g)) { try { const lines = readFileSync(join(repoDir, m[1]!), "utf8").split("\n"), i = Number(m[2]) - 1; let j = i; for (; j < Math.min(lines.length, i + 12); j++) if (/^\}/.test(lines[j]!)) break; out.push(`${m[1]}:${m[2]}\n${lines.slice(i, j + 1).join("\n")}`); } catch { /* unreadable: skipped */ } }
  return out.join("\n\n");
}
/** Settles each open choice in the task, in this order: the latest maintainer comment, the option the task names as preferred, the option existing tests and docs already pin, else none (the line then says to keep every existing test true and satisfy both where compatible). Deterministic, no model call, never throws. */
export function resolveChoices(task: string, ctx: ChoiceCtx = {}): ChoiceResolution[] {
  try {
    const comments = (ctx.comments ?? []).filter((c) => typeof c?.author === "string" && typeof c.association === "string" && typeof c.body === "string"), at = comments.length ? task.lastIndexOf(ISSUE_CONTEXT_HEAD) : -1, issue = at < 0 ? task : task.slice(0, at); // the appended comment section is not the issue's own question
    return detectOpenChoices(issue).map((c, i): ChoiceResolution => {
      const prec = ctx.repoDir && process.env.LOKI_E10_PRECEDENT === "1" ? precedentFor(c, ctx.repoDir) : "", r = settle(c, comments, ctx, issue); // precedent is default off (LOKI_E10_PRECEDENT=1) until the scored L-Haiku arm measures it
      const vote = ctx.votes?.[i]; // undefined: no vote was taken; null: the vote answered NEITHER
      if (prec && vote === null) return r; // siblings that decide nothing are not evidence: no precedent block, so a choice nothing else informs emits no line
      if (prec && r.basis === "none" && typeof vote === "number" && vote >= 0 && vote < c.options.length) return { ...r, basis: "precedent", picked: vote, evidence: "the sibling implementations of the same contract in this repo follow it (one tool-less vote over the sibling code)", precedent: prec };
      return prec ? { ...r, precedent: prec } : r;
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
  const prec = c.precedent ? ` Sibling precedent in this repo (${c.any ? "the outputs the task lists win over these" : c.picked === null ? "prefer the option these follow" : "check your option against these"}): ${c.precedent}.` : "";
  const both = c.any ? " The task lists several acceptable outputs: where they can coexist, build one design that produces every one of them." : "";
  return c.picked === null
    ? `${CHOICE_PREFIX}: "${trunc(c.sentence, 110)}" -> no evidence picks one (${c.evidence}).${prec}${both} Keep every existing test and documented behavior true, satisfy both options where they do not conflict, and name the one you chose.`
    : `${CHOICE_PREFIX}: "${trunc(c.sentence, 110)}" -> implement option ${c.picked + 1}: "${trunc(c.options[c.picked]!, 130)}". Evidence (${c.basis}): ${c.evidence}.${c.fallback ? " A fallback may be added only on top of it." : ""}${c.basis === "precedent" && !c.any ? " A preference stated in the issue for keeping the old behavior does not override the repo convention; an existing test that pins the old behavior of this one member is updated to the convention, every other test stays true." : ""}${prec}${both}`;
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
