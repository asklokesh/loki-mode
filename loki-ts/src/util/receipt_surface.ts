// GitHub receipt comment. The PR body already carries the same facts (e10ext/reviewer_body.ts).
// This is the short comment a reviewer sees without opening the body. No new receipt format.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pushArgv } from "../engine10/types.ts";
import { run } from "./shell.ts";
import type { Passport } from "./receipt_bundle.ts";

export interface ReceiptCommentInput {
  verdict: string;
  draft: boolean;
  draftReason: string | null;
  notProven: readonly string[];
  receiptSha256: string | null;
  runId: string;
  /** Wall-on-the-old-tree line from seal, when mutation proof ran. Absent on older callers. */
  mutationProof?: string | null;
  /** Proof passport (DSSE envelope + public JWK) for a VERIFIED run; a `missing` reason is printed as one line. Absent: nothing is added. */
  passport?: Passport | null;
}

/** The last lines of a run. Same facts as the receipt: verdict, money, time, checks the harness ran, fail-to-pass, hash. A null dollar amount is "not measured", never $0. */
export function renderProofCard(i: {
  verdict: string;
  usd: number | null;
  wallS: number;
  checks: number;
  mutationProof: string | null;
  sha: string | null;
  tampered?: boolean;
}): string {
  const verdict = i.tampered ? "TAMPERED" : i.verdict;
  const cost = i.usd == null ? "cost not measured" : `$${i.usd.toFixed(2)}`;
  const secs = Number.isFinite(i.wallS) && i.wallS >= 0 ? Math.round(i.wallS) : 0;
  const n = Number.isFinite(i.checks) && i.checks > 0 ? Math.floor(i.checks) : 0;
  const proof = i.mutationProof ?? "fail-to-pass: no proof line on the receipt";
  const sha = i.sha ? `sha256:${i.sha}` : "receipt not sealed";
  return [`LOKI ${verdict}`, `${cost} in ${secs}s, ${n} checks run outside the model`, proof, sha].join("\n");
}

/** AWE knobs (LOKI_AWE_DIFF_EARLY, LOKI_AWE_PROOF_CARD, LOKI_AWE_LIVE_COST): presentation only, on by default, "0" turns one off. */
export const aweOn = (name: "LOKI_AWE_DIFF_EARLY" | "LOKI_AWE_PROOF_CARD" | "LOKI_AWE_LIVE_COST", env: NodeJS.ProcessEnv = process.env): boolean => (env[name] ?? "").trim() !== "0";

/** AWE-2: what the proof card says, read from receipt.json alone. `green` is true for a "yes" fail-then-pass proof whose every proving file passed in verify, or for an
 *  own proof (a proof-script step that fails in a copy without the change); a "no", an inconclusive proof with no own proof, or a receipt with no proof line ("not run") is never green. */
export interface ProofCard { green: boolean; state: "shown" | "not shown" | "not run"; why: string; before: { file: string; lines: string[]; after: string; step?: true }[]; notProven: string[]; notProvenMore: number }
const MAX_CARD_NOT_PROVEN = 8;
export function proofCardOf(receipt: Record<string, unknown> | null | undefined): ProofCard {
  const r = receipt ?? {}, outcome = r["mutation_outcome"], line = typeof r["mutation_proof"] === "string" ? (r["mutation_proof"] as string) : "";
  const checks = Array.isArray(r["checks"]) ? (r["checks"] as { name?: unknown; result?: unknown }[]) : [];
  const np = (Array.isArray(r["not_proven"]) ? (r["not_proven"] as unknown[]) : []).filter((x): x is string => typeof x === "string").map((x) => x.replace(/[\x00-\x1f\x7f]+/g, " ").trim()).filter(Boolean);
  const notProven = np.slice(0, MAX_CARD_NOT_PROVEN), notProvenMore = Math.max(0, np.length - MAX_CARD_NOT_PROVEN);
  const afterOf = (file: string): string => { const c = checks.find((k) => typeof k.name === "string" && k.name.endsWith(`:${file}`)); return typeof c?.result === "string" ? c.result : "not recorded"; };
  const rows = (Array.isArray(r["mutation_before"]) ? (r["mutation_before"] as { file?: unknown; lines?: unknown }[]) : []).filter((b) => typeof b.file === "string").map((b) => ({ file: b.file as string, lines: (Array.isArray(b.lines) ? b.lines : []).filter((l): l is string => typeof l === "string"), after: afterOf(b.file as string) }));
  const reason = /\(([^()]*)\)\s*$/.exec(line)?.[1];
  if (outcome === "yes" && rows.length > 0 && rows.every((b) => b.after === "pass")) return { green: true, state: "shown", why: "", before: rows, notProven, notProvenMore };
  const own = r["own_proof"] as { ok?: unknown; steps?: unknown; before?: unknown } | undefined, ownSteps = own?.ok === true && Array.isArray(own.steps) ? own.steps.filter((s): s is string => typeof s === "string") : [], ownLines = new Map((Array.isArray(own?.before) ? (own!.before as { step?: unknown; lines?: unknown }[]) : []).filter((b) => typeof b.step === "string").map((b) => [b.step as string, (Array.isArray(b.lines) ? b.lines : []).filter((l): l is string => typeof l === "string")]));
  if (ownSteps.length > 0) return { green: true, state: "shown", why: "", before: ownSteps.slice(0, 5).map((s) => ({ file: s, lines: ownLines.get(s) ?? [], after: "pass", step: true as const })), notProven, notProvenMore };
  if (outcome === "yes") return { green: false, state: "not run", why: rows.length === 0 ? "the receipt names no test file for the proof" : "a proving test did not pass after the change", before: [], notProven, notProvenMore };
  if (outcome === "no") return { green: false, state: "not shown", why: "the new tests also pass on your old code, so they do not show the fix", before: [], notProven, notProvenMore };
  return { green: false, state: "not run", why: receipt == null ? "no trusted receipt was sealed" : outcome === "inconclusive" ? `inconclusive${reason ? `: ${reason}` : ""}` : "the fail-then-pass proof runs only on a VERIFIED run", before: [], notProven, notProvenMore };
}
/** receipt.json at a sealed path, or null when absent or unreadable (the card then reads "not run"). */
export function readReceiptAt(path: unknown): Record<string, unknown> | null {
  if (typeof path !== "string" || !path) return null;
  try { const r: unknown = JSON.parse(readFileSync(path, "utf8")); return typeof r === "object" && r !== null && !Array.isArray(r) ? (r as Record<string, unknown>) : null; } catch { return null; }
}
/** One Before line: a proof-script step that fails in a copy without the change, or a test file that fails on the base code. */
export const proofRowLead = (b: { file: string; lines: string[]; step?: true }, base: string): string => (b.step ? `proof step ${b.file} fails in a copy of the checkout without the change` : `${b.file} fails on ${base}`) + (b.lines.length ? (b.step ? ", with:" : " with:") : " (output line not recorded)");
/** D48 default output: the proof card as one line (yes/no plus the proving test files); the full card prints under --verbose. */
export function renderAweProofLine(c: ProofCard): string {
  const files = c.before.map((b) => b.file), named = files.slice(0, 2).join(", ") + (files.length > 2 ? ` +${files.length - 2} more` : "");
  if (c.green && c.before.every((b) => b.step)) return `Proof: yes, proof step ${named} fails without the change and passes with it`;
  return c.green ? `Proof: yes, ${named} fails on your code and passes after the change` : c.state === "not shown" ? `Proof: no (${c.why})` : `Proof: not run (${c.why})`;
}
/** Terminal proof card, printed after the summary. Green (when color is on) only for a shown proof. */
export function renderAweProofCard(c: ProofCard, color = false): string {
  const g = (s: string): string => (color && c.green ? `\x1b[32m${s}\x1b[0m` : s);
  const L = [c.green ? `Proof: ${g("fail-then-pass shown")}` : `Proof: ${c.state} (${c.why})`];
  for (const b of c.before) { L.push(`  Before: ${proofRowLead(b, "your code")}`, ...b.lines.map((l) => `    ${l}`), b.step ? "  After: passes on the change" : "  After: passes"); }
  L.push(c.notProven.length ? "Not proven:" : "Not proven: none listed on the receipt", ...c.notProven.map((n) => `  - ${n}`), ...(c.notProvenMore ? [`  - (+${c.notProvenMore} more in receipt.json)`] : []));
  return L.join("\n");
}

/** Structured PR comment: outcome, receipt hash, verify command, PROVEN vs NOT PROVEN. */
export function renderReceiptComment(i: ReceiptCommentInput): string {
  const proven = i.verdict === "VERIFIED" && !i.draft
    ? "PROVEN: sealed verdict VERIFIED"
    : `PROVEN: no verified claim (verdict ${i.verdict})`;
  const items = i.notProven.length > 0 ? i.notProven.map((p) => `- ${p}`) : ["- none"];
  return [
    "<!-- loki-receipt -->",
    "## Loki receipt",
    `- Outcome: ${i.verdict}${i.draft ? ` (DRAFT${i.draftReason ? `: ${i.draftReason}` : ""})` : ""}`,
    `- Receipt: ${i.receiptSha256 ? `sha256:${i.receiptSha256}` : "not sealed"}`,
    `- Verify: \`loki verify ${i.runId}\``,
    `- ${proven}`,
    ...(i.mutationProof ? [`- Proof: ${i.mutationProof}`] : []),
    "## NOT PROVEN",
    ...items,
    ...passportLines(i.passport),
    "",
  ].join("\n");
}

const DSSE_MARK = "<!-- loki-passport:dsse -->", JWK_MARK = "<!-- loki-passport:jwk -->";
function passportBlock(mark: string, file: string, body: string): string[] {
  return [mark, `<details><summary>${file}</summary>`, "", "```json", body, "```", "", "</details>"];
}
function passportLines(p: Passport | null | undefined): string[] {
  if (!p) return [];
  if ("missing" in p) return ["## Proof passport", `- Passport: ${p.missing}`];
  return [
    "## Proof passport",
    "Save the two blocks below as receipt.dsse.json and pubkey.jwk, then run `loki verify --pubkey pubkey.jwk receipt.dsse.json`. Check that the key id is one you trust and the commit is this PR's head.",
    `- Key id: ${p.kid}`,
    `- Commit: ${p.head}`,
    ...passportBlock(DSSE_MARK, "receipt.dsse.json", p.envelope),
    ...passportBlock(JWK_MARK, "pubkey.jwk", p.jwk),
  ];
}

/** The passports a comment body carries, in order. Render and parse live here so they cannot drift apart. */
export function passportsIn(body: string): { envelope: string; jwk: string | null }[] {
  const grab = (mark: string, from: number): { text: string; end: number } | null => {
    const at = body.indexOf(mark, from);
    if (at < 0) return null;
    const m = /```json\r?\n([\s\S]*?)\r?\n```/.exec(body.slice(at + mark.length));
    return m ? { text: m[1]!.trim(), end: at + mark.length + m.index + m[0].length } : null;
  };
  const out: { envelope: string; jwk: string | null }[] = [];
  for (let from = 0; ;) {
    const e = grab(DSSE_MARK, from);
    if (!e) break;
    const nextDsse = body.indexOf(DSSE_MARK, e.end), j = grab(JWK_MARK, e.end);
    out.push({ envelope: e.text, jwk: j && (nextDsse < 0 || body.indexOf(JWK_MARK, e.end) < nextDsse) ? j.text : null });
    from = e.end;
  }
  return out;
}

/** GitHub PR number from a push-pr URL. Local and GitLab URLs return null (no comment). */
export function prNumberFromUrl(url: string): string | null {
  const m = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)$/.exec(url);
  return m?.[1] ?? null;
}

/**
 * Upsert the receipt comment through engine10-push.sh issue-comment --update, keyed on the
 * <!-- loki-receipt --> marker, so a re-run or resume on the same PR edits one comment.
 * Returns null when there is nothing to post or the post succeeded.
 * Returns a NOT PROVEN line (with the exit status and first stderr line) when the post failed. Never throws.
 */
export function postReceiptComment(a: {
  scriptPath: string;
  env: NodeJS.ProcessEnv;
  runDir: string;
  url: string;
  comment: string;
  timeoutMs: number;
}): string | null {
  const num = prNumberFromUrl(a.url);
  if (!num) return null;
  try {
    const file = join(a.runDir, "receipt-comment.md");
    writeFileSync(file, a.comment, "utf8");
    const r = spawnSync("bash", [a.scriptPath, "issue-comment", "--update", `#${num}`, file], {
      env: a.env,
      encoding: "utf8",
      timeout: a.timeoutMs,
      killSignal: "SIGKILL",
    });
    if (r.status === 0) return null;
    const why = (r.stderr ?? "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 160);
    return `receipt comment not posted (exit ${r.status ?? r.signal ?? "unknown"}${why ? `: ${why}` : ""})`;
  } catch {
    return "receipt comment not posted";
  }
}

/** PR number at the end of a push-pr URL (any host). Looser than prNumberFromUrl on purpose: the deep-verify comment accepts a non-github URL. */
const PR_NUMBER_RE = /\/pull\/(\d+)$/;
type CommentCheck = { name: string; result: string; reason?: string };

/** The first line and the marker of the deep verify comment. The marker lets Loki's own comment (posted under the user's login) never be read as a request (pr_lessons.ts also leaves out comments earlier releases posted without it, by DEEP_COMMENT_LEAD). */
export const DEEP_COMMENT_LEAD = "## Loki deep verify: ", DEEP_COMMENT_MARK = "<!-- loki-deep-verify -->";

export function buildDeepCommentBody(checks: CommentCheck[], notProven: string[], statusState: "success" | "failure" | "error"): string {
  const lines = [`${DEEP_COMMENT_LEAD}${statusState}`, "", "### Checks"];
  lines.push(...(checks.length ? checks.map((c) => `- ${c.result}: ${c.name}${c.reason ? ` (${c.reason})` : ""}`) : ["- none"]));
  lines.push("", "### NOT PROVEN", ...(notProven.length ? notProven.map((n) => `- ${n}`) : ["- none"]));
  return `${lines.join("\n")}\n${DEEP_COMMENT_MARK}\n`;
}

/** Post the deep-verify comment and commit status through engine10-push.sh. headSha is "" when HEAD did not resolve to a full sha. Returns NOT PROVEN lines for each failed post. */
export async function postDeepResults(a: {
  scriptPath: string; extraEnv?: Record<string, string>; pinnedOrigin?: string; prUrl?: string; headSha: string;
  repoDir: string; runDir: string; checks: CommentCheck[]; notProven: string[]; statusState: "success" | "failure" | "error";
}): Promise<string[]> {
  const out: string[] = [];
  if (!a.pinnedOrigin) {
    out.push("push refused: no pinned origin (Rule of Two)");
    return out;
  }
  const env = { ...process.env, ...a.extraEnv, _LOKI_ORIGIN_PINNED: "1", _LOKI_PINNED_ORIGIN: a.pinnedOrigin };
  const prNumber = a.prUrl ? PR_NUMBER_RE.exec(a.prUrl)?.[1] : undefined;
  if (prNumber) {
    mkdirSync(a.runDir, { recursive: true });
    const bodyFile = join(a.runDir, "deep-comment.md");
    writeFileSync(bodyFile, buildDeepCommentBody(a.checks, a.notProven, a.statusState), "utf8");
    // engine10-push.sh takes `comment <pr-number> <body-file>`; pushArgv "comment" does not match that contract
    const commentResult = await run(["bash", a.scriptPath, "comment", prNumber, bodyFile], { cwd: a.repoDir, env, timeoutMs: 30_000 });
    if (commentResult.exitCode !== 0) out.push(`deep comment not posted (engine10-push.sh exit ${commentResult.exitCode})`);
  } else {
    out.push("deep comment not posted (no PR number)");
  }
  if (a.headSha) {
    const statusResult = await run(["bash", a.scriptPath, ...pushArgv({ cmd: "status", sha: a.headSha, state: a.statusState, description: `Loki 10 deep verify: ${a.statusState}` })], { cwd: a.repoDir, env, timeoutMs: 30_000 });
    if (statusResult.exitCode !== 0) out.push(`loki/deep-verify status not set (engine10-push.sh exit ${statusResult.exitCode})`);
  } else {
    out.push("loki/deep-verify status not set (HEAD sha not resolvable)");
  }
  return out;
}
