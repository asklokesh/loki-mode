// Q1 PROVE, listing (stages/prove.ts runs it): a short session that sees only the issue text returns the ask list, and the harness accepts it only when
// every ask is a verbatim line or sentence of the issue. New file beside prove.ts: the listing is a separate call with its own brief, whose wording is
// measured for agreement on its own; keeping it apart keeps that text byte-stable while the prove stage changes.
export const LIST_RULES = [
  "Rules:",
  "1. If the issue has list items under what is its acceptance list (whatever its heading is called, or with no heading), the asks are exactly those items, in order, except items the issue marks optional and first-person attestation or template lines (for example \"I am willing to submit a pull request\", \"I searched existing issues\").",
  "2. If it has no such list, the asks are the sentences that state what must be delivered, in order.",
  "3. A checked box ([x]) is not an ask.",
  "4. Copy each ask exactly as it appears in the issue: one list item or one sentence, without its leading \"-\", \"*\", number or checkbox. Do not paraphrase, merge, split or add.",
].join("\n");
/** The listing brief. `out` is the file the JSON goes to; `rejected` (the retry) names the asks the harness refused. */
export function listBrief(issue: string, out: string, rejected: string[] = []): string {
  return [
    "Loki 10 prove listing. Below is the text of an issue. List what it asks to be delivered, copying each ask word for word from the issue.",
    LIST_RULES,
    ...(rejected.length ? [`Your last list was rejected. These asks are not word for word in the issue, or are checked boxes:\n${rejected.map((a) => `- ${a}`).join("\n")}\nCopy each ask exactly as the issue writes it.`] : []),
    `Write only this JSON to the file ${out}: {"asks": ["<ask 1>", "<ask 2>"]}\nThen finish with exactly one line: LOKI_DONE.`,
    `The issue:\n${issue}`,
  ].join("\n\n");
}
const MARK = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[[ xX]\]\s*)?/;
const CHECKED = /^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]/;
export const normAsk = (t: string): string => t.replace(MARK, "").replace(/\s+/g, " ").trim();
/** The issue as the check reads it: each line without its list or checkbox marker, checked-box lines dropped, whitespace collapsed. */
export const normIssue = (issue: string): string => issue.split("\n").filter((l) => !CHECKED.test(l)).map((l) => l.replace(MARK, "")).join("\n").replace(/\s+/g, " ").trim();
/** Parses the listing reply and checks every ask is an exact substring of the issue. */
export function checkAsks(raw: string | null, issue: string): { asks: string[]; bad: string[]; error: string | null } {
  if (raw === null) return { asks: [], bad: [], error: "no list was written" };
  let j: unknown; try { j = JSON.parse(raw); } catch { return { asks: [], bad: [], error: "the list is not valid JSON" }; }
  const list = Array.isArray(j) ? j : Array.isArray((j as { asks?: unknown })?.asks) ? (j as { asks: unknown[] }).asks : null;
  if (!list) return { asks: [], bad: [], error: "the list has no asks array" };
  const body = normIssue(issue), asks: string[] = [], bad: string[] = [];
  for (const x of list) { if (typeof x !== "string") continue; const a = normAsk(x); if (!a) continue; if (a.length >= 3 && body.includes(a)) { if (!asks.includes(a)) asks.push(a); } else bad.push(a.slice(0, 200)); }
  return { asks, bad, error: asks.length === 0 && bad.length === 0 ? "the list is empty" : null };
}
