import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path";
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
  for (const sent of task.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean)) {
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
/** Ambiguity gate: one batched question set, never a silent stall or a guessing loop. Interactive: `stop` carries the checkpoint file and resume offer. Headless: `data` carries the assumptions (copied into the receipt) and intake goes on. A clear spec yields `data: {}`. */
export function ambiguityGate(task: string, runDir: string): { stop?: { failData: Record<string, unknown>; reason: string }; data: Record<string, unknown> } {
  const amb = scoreAmbiguity(task);
  if (amb.score < ambiguityThreshold()) return { data: {} };
  const qs = [...new Set(amb.hits.map(questionFor))].slice(0, 8), assumptions = [...new Set(amb.hits.map(assumptionFor))].slice(0, 8);
  if (!intakeInteractive()) return { data: { ambiguity_score: amb.score, assumptions } };
  mkdirSync(runDir, { recursive: true });
  const checkpoint = join(runDir, "intake-questions.md");
  writeFileSync(checkpoint, `# Spec needs clarification (ambiguity score ${amb.score})\n\n${qs.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n`, "utf8");
  return { data: {}, stop: { failData: { ambiguity_score: amb.score, questions: qs, checkpoint }, reason: `spec is ambiguous (score ${amb.score}); ${qs.length} question(s) in ${checkpoint}. Resume: answer them in the task text and rerun, run \`loki grill\` for a deeper interrogation, or rerun with LOKI_E10_ASSUME=1 to proceed on recorded assumptions` } };
}
/** Per-run prompt lines (after the task, never in the cache-stable prefix) telling plan and implement to work on the recorded assumptions instead of guessing. Empty when none. */
export function assumptionsBlock(assumptions: unknown): string[] {
  const list = Array.isArray(assumptions) ? assumptions.filter((a): a is string => typeof a === "string" && a.length > 0) : [];
  return list.length ? [`The task text is ambiguous and nobody could be asked. Work on these recorded assumptions, no extra scope, and say in your final message where one mattered:\n${list.map((a, i) => `${i + 1}. ${a}`).join("\n")}`] : [];
}
