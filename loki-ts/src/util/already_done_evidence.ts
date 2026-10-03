// loki-ts/src/util/already_done_evidence.ts -- deterministic evidence search behind the E-66
// already-done check (moved out of engine10/already_done.ts to keep the core under its line cap,
// D29/D33). Pure reads over the repo map, test map and CHANGELOG/README headings.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RepoMap } from "../engine10/repomap.ts";
import { linkedHits } from "../e10ext/compound_match.ts";
import { pushArgv, taskBlock } from "../engine10/types.ts";
import type { TestMap } from "../engine10/types.ts";

export interface EvidenceHit {
  source: "code" | "test" | "changelog";
  path: string;
  line: string; // the matching symbol, test path, or heading text
}

const DOC_FILES = ["CHANGELOG.md", "README.md"];
// One keyword hit alone is too weak (a task naming an existing file would always look like a candidate); a second independent source is the cheap gate.
const MIN_CATEGORIES = 2;
// Caps the brief and receipt evidence per source, not on the concatenated total, so one noisy source cannot crowd out the other two.
const PER_SOURCE_CAP = 7;

// Generic words carry no signal that THIS task's feature exists (E-66 review: "Add a dark mode toggle" matched 653 lines on words alone).
// A curated list, not a dictionary; a surviving keyword still needs a second independent category.
const STOP_WORDS = new Set([
  // function words
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "had", "has", "have",
  "if", "in", "into", "is", "it", "its", "not", "of", "on", "or", "such", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "those", "to", "too", "via", "was",
  "were", "will", "with", "without", "your", "you", "can",
  // generic task verbs: every feature request says one of these, none of them names the feature
  "add", "adds", "added", "adding", "remove", "removes", "removed", "removing",
  "update", "updates", "updated", "updating", "support", "supports", "supported", "supporting",
  "allow", "allows", "allowed", "allowing", "enable", "enables", "enabled", "enabling",
  "disable", "disables", "disabled", "disabling", "create", "creates", "created", "creating",
  "make", "makes", "made", "making", "implement", "implements", "implemented", "implementing",
  "change", "changes", "changed", "changing", "build", "builds", "built", "building",
  "fix", "fixes", "fixed", "fixing", "improve", "improves", "improved", "improving", "new", "old",
  // generic UI/domain nouns: recur across unrelated features in any real product's history
  "mode", "modes", "toggle", "toggles", "toggled", "setting", "settings", "option", "options",
  "page", "pages", "button", "buttons", "panel", "panels", "screen", "screens", "view", "views",
  "menu", "menus", "dialog", "dialogs", "modal", "modals", "tab", "tabs", "field", "fields",
  "form", "forms", "list", "lists", "item", "items", "file", "files", "feature", "features", "data",
]);

function keywords(task: string): string[] {
  const words = task.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return Array.from(new Set(words.filter((w) => w.length > 2 && !STOP_WORDS.has(w))));
}

/** Whole tokens in `s` (split on anything that is not a letter or digit), never a substring set:
 *  "page" must not match inside "ProjectsPage" or "projectspage.state.test.mjs". */
function tokenSet(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
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
    const toks = tokenSet(basename(t.path));
    if (words.some((w) => toks.has(w))) hits.push({ source: "test", path: t.path, line: t.path });
  }
  return hits;
}

/** Markdown headings ("# ...", "## ...") in CHANGELOG.md / README.md naming a task keyword. */
function docEvidence(words: string[], repoDir: string): EvidenceHit[] {
  const hits: EvidenceHit[] = [];
  for (const name of DOC_FILES) {
    let text: string;
    try {
      text = readFileSync(join(repoDir, name), "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("#")) continue;
      const heading = line.replace(/^#+\s*/, "");
      const toks = tokenSet(heading);
      if (words.some((w) => toks.has(w))) hits.push({ source: "changelog", path: name, line: heading });
    }
  }
  return hits;
}

/** True when `word` alone (not the task's keyword set as a whole) is named in at least
 *  MIN_CATEGORIES distinct sources -- the real signal that a search across many keywords must
 *  require. Two unrelated keywords each hitting a different source coincidentally (E-66 review:
 *  "toggle" matched an unrelated test, "mode" matched an unrelated changelog entry -- neither said
 *  anything about the other) is not evidence that the *same* feature already exists; one keyword
 *  naming the feature in more than one place is. */
function wordSpansCategories(word: string, repoMap: RepoMap, testMap: TestMap, repoDir: string): boolean {
  const cats = new Set<EvidenceHit["source"]>();
  if (codeEvidence([word], repoMap).length > 0) cats.add("code");
  if (testEvidence([word], testMap).length > 0) cats.add("test");
  if (docEvidence([word], repoDir).length > 0) cats.add("changelog");
  return cats.size >= MIN_CATEGORIES;
}

/** Candidate evidence: at least one keyword individually clears MIN_CATEGORIES (see
 *  wordSpansCategories), then every keyword's hits are returned, each source capped to
 *  PER_SOURCE_CAP. Empty means "not a candidate" -- Intake must never start a session over a
 *  single weak match, over words too generic to name this task's actual feature (STOP_WORDS), or
 *  over unrelated keywords that only coincidentally cover different sources. */
export function findEvidence(task: string, repoMap: RepoMap, testMap: TestMap, repoDir: string): EvidenceHit[] {
  const words = keywords(task);
  if (words.length === 0) return [];
  const linked = words.flatMap((w) => linkedHits(w, repoMap, testMap, repoDir));
  if (linked.length === 0 && !words.some((w) => wordSpansCategories(w, repoMap, testMap, repoDir))) return [];
  const all = [...codeEvidence(words, repoMap), ...testEvidence(words, testMap), ...docEvidence(words, repoDir), ...linked];
  const uniq = [...new Map(all.map((h) => [`${h.source}|${h.path}|${h.line}`, h])).values()];
  return (["code", "test", "changelog"] as const).flatMap((s) => uniq.filter((h) => h.source === s).slice(0, PER_SOURCE_CAP));
}

export function evidenceLines(hits: EvidenceHit[]): string[] {
  return hits.map((h) => `${h.path}: ${h.line}`);
}

export function buildConfirmBrief(task: string, hits: EvidenceHit[]): string {
  return [
    "You are the Loki 10 already-done confirmation check.",
    ...taskBlock(task),
    "A deterministic search found this candidate evidence that the task may already be done:",
    evidenceLines(hits).map((l) => `- ${l}`).join("\n"),
    "Open only the files named above and decide: is the requested behavior already fully implemented, tested and documented?",
    "If yes, finish with exactly one line citing the files that prove it: LOKI_ALREADY_DONE: <file:line evidence>",
    "If no, or you are unsure, finish with exactly one line: LOKI_DONE",
    "Do not edit any file. Do not run tests. Do not commit.",
  ].join("\n\n");
}

/** Whole-word substring: unlike `String.includes`, "search.ts" does not match inside
 *  "research.ts" (there is no word boundary between the "e" and the "s" that starts the citation). */
function citesToken(text: string, token: string): boolean {
  return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
}

/** True when `text` names a hit's path (full or basename -- models often cite one without the
 *  other, at a real word boundary) AND that path still exists in the repo AND the hit is code or a
 *  test, never a changelog heading alone: a line in a changelog says a feature was documented, not
 *  that working code for it exists today (E-66 review findings 3 and 5). */
export function citesRealHit(text: string, hit: EvidenceHit, repoDir: string): boolean {
  if (hit.source === "changelog") return false;
  return (citesToken(text, hit.path) || citesToken(text, basename(hit.path))) && existsSync(join(repoDir, hit.path));
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
