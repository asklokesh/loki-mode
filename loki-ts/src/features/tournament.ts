// PROTOTYPE (proto/candidate-tournament): disagreement-adjudicated candidate tournament.
// New file because features/attempts.ts owns two FULL agent sessions scored by pass counts over the shared set S;
// this module owns a different mechanism: patch-only candidates from ONE tool-less model call, behavioral probes
// written from the issue alone, and a code-blind adjudicator that judges only the concrete inputs on which the
// candidates disagree. Repo checks still gate every candidate; the tournament never weakens a verdict, it only
// chooses which already-check-passing tree goes to verify and Seal.
//
// Calls (all tool-less, single turn): (1) candidates, (2) probes, (3) adjudication, and (3) runs only when the
// check-passing candidates disagree on at least one probe. Everything with side effects is injected (Io).

export interface Usage { inTok: number; outTok: number; cacheRead: number; cacheWrite: number; costUsd: number }
export interface LlmCall { (system: string, user: string): Promise<{ text: string; usage: Usage }> }
export interface Edit { path: string; search: string; replace: string }
export interface CandidateSpec { id: string; lens: string; edits: Edit[] }
export interface ProbeRun { [probeId: string]: string }
export interface Probe { id: string; desc: string }
export interface Io {
  /** Materialize the base tree plus edits into a scratch tree; returns its dir or null when an edit does not apply. */
  materialize(edits: Edit[] | "agent"): string | null;
  /** The repo's own checks for the files in play; true when all pass in that tree. */
  checks(dir: string): boolean;
  /** Writes the probe program into dir, runs it, returns its stdout (parsed with parseProbeOutput). */
  probe(dir: string, program: string): string;
}
export interface Context { issue: string; files: Record<string, string>; tests: Record<string, string>; lang: string }

export const LENSES = [
  "minimal: the smallest change that makes the issue's expected behavior true",
  "convention: read each whole function you edit first and make the new branch match its sibling branches (raw vs normalized values, error wrapping, return shapes)",
  "coverage: list every site, symbol and example the issue names and make sure each one is handled, preferring the issue's own preferred fix",
] as const;

const SYS_PATCH = "You write code patches. Output only the requested blocks, no prose.";
export function candidatePrompt(c: Context, lenses: readonly string[] = LENSES): string {
  return [
    `ISSUE:\n${c.issue}`,
    ...Object.entries(c.files).map(([p, s]) => `FILE ${p}:\n${s}`),
    ...Object.entries(c.tests).map(([p, s]) => `EXISTING TEST ${p}:\n${s}`),
    `Write ${lenses.length} candidate fixes, each one under a different lens. They must differ where the lenses lead to different code; identical candidates waste the slot.`,
    ...lenses.map((l, i) => `Candidate ${i + 1} lens: ${l}`),
    "Format, repeated per candidate:\n=== CANDIDATE <n> ===\n<<<<<<< SEARCH <path>\n<exact lines from the file>\n=======\n<replacement lines>\n>>>>>>> REPLACE\nSEARCH text must match the file exactly and be unique. Do not edit tests.",
  ].join("\n\n");
}

const SYS_PROBE = "You write a small behavioral probe program. Output only one fenced code block.";
export function probePrompt(c: Context): string {
  return [
    `ISSUE:\n${c.issue}`,
    ...Object.entries(c.files).map(([p, s]) => `FILE ${p} (before any fix):\n${s}`),
    ...Object.entries(c.tests).map(([p, s]) => `EXISTING TEST ${p}:\n${s}`),
    `Write a ${c.lang} program that calls the code above on 6 to 10 concrete inputs and prints one JSON line per case: {"id":"p1","desc":"<input in words>","out":<JSON of the result>}.`,
    "Wrap each case in try/catch and print out as \"THROW:\" + message on a throw. Do not assert anything: print what the code returns.",
    "Choose inputs that separate correct from plausible-but-wrong fixes: every example the issue gives, then variants of them (surrounding whitespace, case, normalization, wrapped or nested forms, empty and boundary values), and combinations with neighbouring behavior the existing tests pin.",
    "Import the module with the same relative path the existing test uses, since the program is saved next to it.",
  ].join("\n\n");
}

const SYS_JUDGE = "You decide which observed behavior an issue requires. You never see code. Answer only in the requested format.";
export function judgePrompt(c: Context, d: Disagreement[], base: ProbeRun): string {
  const rows = d.map((x) => [`PROBE ${x.probeId}: ${x.desc}`, `  before the fix: ${base[x.probeId] ?? "(not run)"}`, ...x.options.map((o) => `  option ${o.label}: ${o.out}`)].join("\n"));
  return [
    `ISSUE:\n${c.issue}`,
    ...Object.entries(c.tests).map(([p, s]) => `EXISTING TEST ${p} (pins the repo's conventions):\n${s}`),
    "Several candidate fixes disagree on the probes below. For each probe, pick the option the issue and the existing tests' conventions require. Say unknown when neither the issue nor the tests decide it.",
    rows.join("\n\n"),
    "Answer one line per probe: <probe id>: <option label or unknown>",
  ].join("\n\n");
}

export function parseCandidates(text: string): CandidateSpec[] {
  const out: CandidateSpec[] = [];
  const parts = text.split(/^=== CANDIDATE (\d+) ===\s*$/m);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const n = Number(parts[i]), body = parts[i + 1]!, edits: Edit[] = [];
    const re = /<<<<<<< SEARCH ([^\n]+)\n([\s\S]*?)\n=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g;
    for (let m = re.exec(body); m; m = re.exec(body)) edits.push({ path: m[1]!.trim(), search: m[2]!, replace: m[3]! });
    out.push({ id: `c${n}`, lens: LENSES[n - 1] ?? `lens ${n}`, edits });
  }
  return out;
}

export function applyEdits(files: Record<string, string>, edits: Edit[]): Record<string, string> | null {
  const next = { ...files };
  for (const e of edits) {
    const src = next[e.path];
    if (src === undefined) return null;
    const at = src.indexOf(e.search);
    if (at < 0 || src.indexOf(e.search, at + 1) >= 0) return null; // missing or ambiguous
    next[e.path] = src.slice(0, at) + e.replace + src.slice(at + e.search.length);
  }
  return next;
}

export function extractProgram(text: string): string {
  const m = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(text);
  return m ? m[1]! : text;
}

/** Parse probe stdout lines into id -> canonical output and id -> desc. Lines that are not probe JSON are ignored. */
export function parseProbeOutput(stdout: string): { run: ProbeRun; probes: Probe[] } {
  const run: ProbeRun = {}, probes: Probe[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t) as { id?: unknown; desc?: unknown; out?: unknown };
      if (typeof o.id !== "string") continue;
      run[o.id] = typeof o.out === "string" ? o.out : JSON.stringify(o.out);
      probes.push({ id: o.id, desc: typeof o.desc === "string" ? o.desc : o.id });
    } catch { /* not a probe line */ }
  }
  return { run, probes };
}

export interface Entrant { id: string; lens: string; dir: string; checksPass: boolean; run: ProbeRun; diffLines: number }
export interface Disagreement { probeId: string; desc: string; options: { label: string; out: string; entrants: string[] }[] }

/** Probes on which check-passing entrants print different outputs. A probe that throws identically everywhere is not a disagreement. */
export function disagreements(entrants: Entrant[], probes: Probe[]): Disagreement[] {
  const live = entrants.filter((e) => e.checksPass);
  const out: Disagreement[] = [];
  for (const p of probes) {
    const groups = new Map<string, string[]>();
    for (const e of live) { const o = e.run[p.id] ?? "(missing)"; groups.set(o, [...(groups.get(o) ?? []), e.id]); }
    if (groups.size < 2) continue;
    out.push({ probeId: p.id, desc: p.desc, options: [...groups.entries()].map(([o, ids], i) => ({ label: String.fromCharCode(65 + i), out: o, entrants: ids })) });
  }
  return out;
}

export function parseVerdicts(text: string): Map<string, string> {
  const v = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^\s*\**\s*([A-Za-z0-9_-]+)\s*\**\s*:\s*\**\s*(?:option\s+)?([A-Z]|unknown)\b/i.exec(line); // Haiku answered "p4: option B" in the first real run
    if (m) v.set(m[1]!, m[2]!.length === 1 ? m[2]!.toUpperCase() : "unknown");
  }
  return v;
}

export interface Pick { winner: string; reason: string; scores: Record<string, number> }
/** Rank: checks pass (gate) > adjudicated wins > behavior-cluster size (agreement with other candidates) > smaller diff > agent first.
 *  With no disagreement, the agent's own tree (entrant "agent") wins whenever it passes checks: the tournament only ever adds. */
export function select(entrants: Entrant[], d: Disagreement[], verdicts: Map<string, string>): Pick {
  const live = entrants.filter((e) => e.checksPass);
  if (live.length === 0) return { winner: entrants[0]?.id ?? "agent", reason: "no entrant passes checks; agent tree kept", scores: {} };
  const wins: Record<string, number> = {}, cluster: Record<string, number> = {};
  for (const e of live) { wins[e.id] = 0; cluster[e.id] = 0; }
  for (const x of d) {
    const pick = verdicts.get(x.probeId);
    for (const o of x.options) {
      for (const id of o.entrants) cluster[id] = (cluster[id] ?? 0) + o.entrants.length;
      if (pick && pick !== "unknown" && o.label === pick) for (const id of o.entrants) wins[id] = (wins[id] ?? 0) + 1;
      if (pick && pick !== "unknown" && o.label !== pick) for (const id of o.entrants) wins[id] = (wins[id] ?? 0) - 1;
    }
  }
  const order = [...live].sort((a, b) => (wins[b.id]! - wins[a.id]!) || (cluster[b.id]! - cluster[a.id]!) || (a.diffLines - b.diffLines) || ((a.id === "agent" ? 0 : 1) - (b.id === "agent" ? 0 : 1)));
  const w = order[0]!;
  const reason = d.length === 0 ? "no behavioral disagreement" : `adjudicated ${[...verdicts.values()].filter((x) => x !== "unknown").length}/${d.length} disagreements`;
  return { winner: w.id, reason, scores: wins };
}

export interface TournamentResult { pick: Pick; entrants: Entrant[]; disagreements: Disagreement[]; verdicts: Record<string, string>; usage: Usage[]; calls: number; baseRun: ProbeRun; probes: Probe[] }

const diffLines = (edits: Edit[]): number => edits.reduce((n, e) => n + e.search.split("\n").length + e.replace.split("\n").length, 0);

/** Runs the tournament. With `agent`, Io.materialize("agent") yields the agent session's finished tree, entered as entrant "agent". */
export async function runTournament(c: Context, llm: LlmCall, io: Io, opts: { agent?: boolean; lenses?: readonly string[] } = {}): Promise<TournamentResult> {
  const usage: Usage[] = [];
  const [candRes, probeRes] = await Promise.all([llm(SYS_PATCH, candidatePrompt(c, opts.lenses)), llm(SYS_PROBE, probePrompt(c))]); // independent: probes never see candidates
  usage.push(candRes.usage, probeRes.usage);
  const specs = parseCandidates(candRes.text), program = extractProgram(probeRes.text);
  const baseDir = io.materialize([]);
  const baseParsed = baseDir ? parseProbeOutput(io.probe(baseDir, program)) : { run: {}, probes: [] };
  const entrants: Entrant[] = [];
  const descs = new Map<string, string>(baseParsed.probes.map((p) => [p.id, p.desc]));
  const enter = (id: string, lens: string, edits: Edit[] | "agent"): void => {
    if (edits !== "agent" && applyEdits(c.files, edits) === null) { entrants.push({ id, lens, dir: "", checksPass: false, run: {}, diffLines: 0 }); return; }
    const dir = io.materialize(edits);
    if (!dir) { entrants.push({ id, lens, dir: "", checksPass: false, run: {}, diffLines: 0 }); return; }
    const ok = io.checks(dir), parsed = ok ? parseProbeOutput(io.probe(dir, program)) : { run: {}, probes: [] };
    for (const p of parsed.probes) if (!descs.has(p.id)) descs.set(p.id, p.desc);
    const run = parsed.run;
    entrants.push({ id, lens, dir, checksPass: ok, run, diffLines: edits === "agent" ? 0 : diffLines(edits) });
  };
  if (opts.agent) enter("agent", "agent session", "agent");
  for (const s of specs) enter(s.id, s.lens, s.edits);
  const ids = new Set<string>();
  for (const e of entrants) for (const k of Object.keys(e.run)) ids.add(k);
  const probes: Probe[] = [...ids].map((id) => ({ id, desc: descs.get(id) ?? id }));
  const d = disagreements(entrants, probes);
  let verdicts = new Map<string, string>();
  if (d.length > 0) {
    const j = await llm(SYS_JUDGE, judgePrompt(c, d, baseParsed.run));
    usage.push(j.usage);
    verdicts = parseVerdicts(j.text);
  }
  return { pick: select(entrants, d, verdicts), entrants, disagreements: d, verdicts: Object.fromEntries(verdicts), usage, calls: usage.length, baseRun: baseParsed.run, probes };
}

