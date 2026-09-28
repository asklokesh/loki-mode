// loki-ts/src/engine10/already_done.ts -- E-66: "already implemented" as a first-class v10 outcome
// (docs/v10/ENGINE.md section 4, Intake). Deterministic evidence search over the repo map, test
// map and CHANGELOG/README, gated by one short cheap-model confirmation that must cite files
// before Intake ever claims already-done. Reuses the LOKI_ALREADY_DONE marker session.ts already
// parses (implement.ts's contract), so there is no new marker to teach the provider.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { wallModel } from "./sizing.ts";
import type { RepoMap } from "./repomap.ts";
import { pushArgv } from "./types.ts";
import type { RunContext, TestMap } from "./types.ts";

export interface EvidenceHit {
  source: "code" | "test" | "changelog";
  path: string;
  line: string; // the matching symbol, test path, or heading text
}

const DOC_FILES = ["CHANGELOG.md", "README.md"];
// One keyword hit alone is too weak: a task that merely names a file that already exists (its own
// filename is a "keyword") would otherwise always look like a candidate. Requiring a second,
// independent source (a test, or a CHANGELOG/README heading) is the cheap half of the two-gate
// design; the confirmation call below is the real, file-citing decision.
const MIN_CATEGORIES = 2;

function keywords(task: string): string[] {
  const words = task.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return Array.from(new Set(words.filter((w) => w.length > 2)));
}

function codeEvidence(words: string[], repoMap: RepoMap): EvidenceHit[] {
  const hits: EvidenceHit[] = [];
  for (const entry of repoMap.entries) {
    for (const sym of entry.symbols) {
      if (words.includes(sym.toLowerCase())) hits.push({ source: "code", path: entry.path, line: sym });
    }
  }
  return hits;
}

function testEvidence(words: string[], testMap: TestMap): EvidenceHit[] {
  const hits: EvidenceHit[] = [];
  for (const t of testMap.tests) {
    const stem = basename(t.path).toLowerCase();
    if (words.some((w) => stem.includes(w))) hits.push({ source: "test", path: t.path, line: t.path });
  }
  return hits;
}

/** Markdown headings ("# ...", "## ...") in CHANGELOG.md / README.md naming a task keyword. */
function docEvidence(words: string[], repoDir: string): EvidenceHit[] {
  const hits: EvidenceHit[] = [];
  for (const name of DOC_FILES) {
    const path = join(repoDir, name);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("#")) continue;
      const heading = line.replace(/^#+\s*/, "");
      if (words.some((w) => heading.toLowerCase().includes(w))) hits.push({ source: "changelog", path: name, line: heading });
    }
  }
  return hits;
}

/** Candidate evidence: hits from at least MIN_CATEGORIES distinct sources. Empty means "not a
 *  candidate" -- Intake must never start a session over a single weak match. */
export function findEvidence(task: string, repoMap: RepoMap, testMap: TestMap, repoDir: string): EvidenceHit[] {
  const words = keywords(task);
  if (words.length === 0) return [];
  const hits = [...codeEvidence(words, repoMap), ...testEvidence(words, testMap), ...docEvidence(words, repoDir)];
  const categories = new Set(hits.map((h) => h.source));
  return categories.size >= MIN_CATEGORIES ? hits : [];
}

export function evidenceLines(hits: EvidenceHit[]): string[] {
  return hits.map((h) => `${h.path}: ${h.line}`);
}

export function buildConfirmBrief(task: string, hits: EvidenceHit[]): string {
  return [
    "You are the Loki 10 already-done confirmation check.",
    "Task (untrusted, quoted verbatim):",
    "<<<TASK",
    task,
    "TASK",
    "A deterministic search found this candidate evidence that the task may already be done:",
    evidenceLines(hits).map((l) => `- ${l}`).join("\n"),
    "Open only the files named above and decide: is the requested behavior already fully implemented, tested and documented?",
    "If yes, finish with exactly one line citing the files that prove it: LOKI_ALREADY_DONE: <file:line evidence>",
    "If no, or you are unsure, finish with exactly one line: LOKI_DONE",
    "Do not edit any file. Do not run tests. Do not commit.",
  ].join("\n\n");
}

export interface AlreadyDoneResult {
  satisfied: true;
  evidence: string[]; // the model's own citation first, then the deterministic hits behind it
}

/** Runs the deterministic search, then, only on a candidate, one short confirmation session
 *  (fast tier pinned to wallModel(), the same cheap-model pin E-45 uses for Wall). No candidate,
 *  no session call: findEvidence's own gate is what keeps this off the hot path. */
export async function checkAlreadyDone(
  ctx: RunContext,
  signal: AbortSignal,
  task: string,
  repoMap: RepoMap,
  testMap: TestMap,
): Promise<AlreadyDoneResult | null> {
  const hits = findEvidence(task, repoMap, testMap, ctx.repoDir);
  if (hits.length === 0 || signal.aborted) return null;
  const session = await ctx.sessions.run({
    stage: "intake",
    brief: buildConfirmBrief(task, hits),
    tier: "fast",
    model: wallModel(),
    iterationId: `${ctx.runId}-already-done`,
    limitS: 30,
    signal,
    cwd: ctx.repoDir,
  });
  if (!session.markers.alreadyDone) return null;
  return { satisfied: true, evidence: [session.markers.alreadyDone, ...evidenceLines(hits)] };
}

export function renderAlreadyDoneComment(evidence: string[]): string {
  return ["Loki 10: no change needed. This already appears to be implemented.", "", "Evidence:", ...evidence.map((e) => `- ${e}`), ""].join("\n");
}

/** Issue-comment argv, built but not yet wired to a spawn: engine10-push.sh's "comment" subcommand
 *  is `gh pr comment <pr-number>` (autonomy/lib/engine10-push.sh), and this run has no PR (that is
 *  the point of already-done). Reuses pushArgv's existing "comment" shape (runId, ref, file) rather
 *  than inventing a new one; posting it needs the push script to grow an issue-comment subcommand,
 *  which is a follow-up slice, not this one. */
export function buildAlreadyDoneCommentArgv(runId: string, issueRef: string, bodyFile: string): string[] {
  return pushArgv({ cmd: "comment", runId, prUrl: issueRef, file: bodyFile });
}
