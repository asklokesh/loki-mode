// Triage router: implement, spec or human for one work item before a run is spent. New file: spec_ambiguity.ts only scores text, and issues_run.ts triage is an opt-in model call for `loki issues run`; nothing owned per-item routing for `loki backlog` (the only caller that skips work) or recording a class on a direct run.
import { buildTestMap } from "../engine10/testmap.ts";
import { ambiguityThreshold, scoreAmbiguity } from "./spec_ambiguity.ts";

export type TriageClass = "implement" | "spec" | "human";
export const TRIAGE_CLASSES: readonly TriageClass[] = ["implement", "spec", "human"];
export interface TriageItem { title: string; body?: string; labels?: readonly string[] }
/** Detected test runners and test-file count (engine10 testmap), reported in the implement reason. */
export interface RepoSignals { runners: readonly string[]; tests: number }
export interface TriageResult { class: TriageClass; reason: string; rule: string }

const clip = (s: string, n = 60): string => { const c = Array.from(s.replace(/\s+/g, " ").trim()); return c.length > n ? `${c.slice(0, n - 3).join("")}...` : c.join(""); };
const hit = (re: RegExp, text: string): string | null => re.exec(text)?.[0] ?? null;

// Secrets (named together with an operation on them), production and destructive operations: never headless. The env-var form is case-sensitive (FOO_SECRET_KEY).
const SECRET_RE = /\b(?:secrets?|credentials?|passwords?|api[ _-]?keys?|private[ _-]?keys?|access[ _-]?tokens?|signing[ _-]?keys?)\b/i;
const SECRET_VAR_RE = /\b[A-Z][A-Z0-9]*_(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\b/;
const SECRET_OP_RE = /\b(?:rotat\w*|revok\w*|regenerat\w*|leak\w*|expos\w*|reset|replac\w*|renew\w*|invalidat\w*|hardcod\w*)\b/i;
const PROD_RE = /\b(?:in|on|to|against|from)\s+(?:the\s+)?(?:production|prod)\b|\b(?:production|prod)\s+(?:database|db|servers?|cluster|environment|env|data|deploy(?:ment)?|secrets?|keys?|credentials?|config|traffic|users)\b/i;
const DESTRUCTIVE_RE = /\b(?:drop\s+(?:table|database|schema)|truncate\s+table|delete\s+(?:all|every)\s+\w+|wipe|purge|force[- ]push|rm\s+-rf|destroy\s+(?:the\s+)?(?:cluster|database|bucket|environment))\b/i;
// Large: an epic label or title, or a long task list.
const EPIC_LABEL_RE = /^(?:epic|umbrella|tracking|meta)$/i;
const EPIC_TITLE_RE = /^\s*(?:\[?(?:epic|umbrella|tracking)\]?)\b/i;
const TASK_ITEM_RE = /^\s*[-*]\s+\[[ xX]\]\s+/gm;
const MAX_TASK_ITEMS = 3, MAX_BODY_CHARS = 4000;
// A concrete target or acceptance check: a code span, a call, a file path, a number, a quoted value, a stated expected result, or a stated change ("change X to Y").
const ANCHORS: ReadonlyArray<[string, RegExp]> = [
  ["code", /`[^`\n]+`/], ["call", /\b[A-Za-z_]\w*\([^)]*\)/], ["file", /\b[\w./-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|swift|c|h|cpp|md|json|ya?ml|toml|sh|sql|html|css)\b/],
  ["number", /\d/], ["quoted value", /"[^"\n]{1,80}"/], ["expected result", /\b(?:expected|actual|acceptance|steps to reproduce|regression|returns?|throws?|exit code|error message)\b/i],
  ["stated change", /\b(?:change|set|rename|move|switch|update)\b[^.\n]{1,60}\bto\b/i],
];

/** Deterministic class for one item. Rules, first match wins: override label, secrets/prod/destructive, large, ambiguous, vague, implement. Missing tests, UI and infra work still run: Loki writes its own tests and verifies once at the end. Total: it always decides, so no model call is needed. */
export function triageItem(item: TriageItem, repo?: RepoSignals): TriageResult {
  const labels = (item.labels ?? []).map((l) => l.trim().toLowerCase()), body = item.body ?? "", text = `${item.title}\n\n${body}`;
  const forced = TRIAGE_CLASSES.find((c) => labels.includes(`loki:${c}`));
  if (forced) return { class: forced, reason: `label loki:${forced}`, rule: "label" };
  const risk = SECRET_OP_RE.test(text) ? hit(SECRET_VAR_RE, text) ?? hit(SECRET_RE, text) : null;
  if (risk) return { class: "human", reason: `touches secrets ("${clip(risk, 40)}"); rotate or change them by hand`, rule: "secrets" };
  const prod = hit(PROD_RE, text) ?? hit(DESTRUCTIVE_RE, text);
  if (prod) return { class: "human", reason: `production or destructive operation ("${clip(prod, 40)}")`, rule: "prod" };
  const items = (body.match(TASK_ITEM_RE) ?? []).length, epic = labels.find((l) => EPIC_LABEL_RE.test(l));
  if (epic || EPIC_TITLE_RE.test(item.title) || items > MAX_TASK_ITEMS || body.length > MAX_BODY_CHARS)
    return { class: "spec", reason: `large: ${epic ? `label ${epic}` : items > MAX_TASK_ITEMS ? `${items} task-list items` : EPIC_TITLE_RE.test(item.title) ? "epic title" : `${body.length} characters`}; split it in a spec first`, rule: "large" };
  const amb = scoreAmbiguity(text), threshold = ambiguityThreshold();
  if (amb.score >= threshold) return { class: "spec", reason: `ambiguous: score ${amb.score} (threshold ${threshold}), e.g. "${clip(amb.hits[0]?.excerpt ?? "", 50)}"`, rule: "ambiguous" };
  const anchor = ANCHORS.find(([, re]) => re.test(text));
  if (!anchor) return { class: "spec", reason: "vague: no file, function, value or expected result named", rule: "vague" };
  return { class: "implement", reason: `concrete target (${anchor[0]})${repo ? `, ${repo.tests} test file(s) via ${repo.runners.slice(0, 3).join(", ")}` : ""}`, rule: "implement" };
}

/** Runners and test-file count from the engine10 test map; null when the repo cannot be read. */
export function repoSignals(repoDir: string): RepoSignals | undefined {
  try { const m = buildTestMap(repoDir); return { runners: m.runners, tests: m.tests.length }; } catch { return undefined; }
}

const validTriage = (x: unknown): { class: TriageClass; reason: string } | null => {
  const t = x as { class?: unknown; reason?: unknown } | null;
  return t && typeof t === "object" && TRIAGE_CLASSES.includes(t.class as TriageClass) ? { class: t.class as TriageClass, reason: typeof t.reason === "string" ? t.reason : "" } : null;
};
type Gate = { stop?: { failData: Record<string, unknown>; reason: string }; data: Record<string, unknown> };

/** Intake hook around ambiguityGate: records, never routes. A direct run (`loki "<goal>"`, `loki start owner/repo#N`) always runs exactly as the gate decided; only `loki backlog` skips or drafts.
 *  A backlog child carries its class in LOKI_TRIAGE_CLASS/LOKI_TRIAGE_REASON (recorded, never re-triaged); a direct run is triaged only when the ambiguity gate fired. LOKI_TRIAGE=0 records nothing. */
export function triageGate(task: string, repoDir: string, gate: Gate, env: NodeJS.ProcessEnv = process.env): Gate {
  const given = validTriage({ class: env.LOKI_TRIAGE_CLASS, reason: env.LOKI_TRIAGE_REASON });
  const fired = Boolean(gate.stop) || "ambiguity_score" in gate.data;
  if (!given && (env.LOKI_TRIAGE === "0" || !fired)) return gate;
  const triage = given ?? (({ class: c, reason }) => ({ class: c, reason }))(triageItem({ title: task }, repoSignals(repoDir)));
  return gate.stop ? { ...gate, stop: { ...gate.stop, failData: { ...gate.stop.failData, triage } } } : { ...gate, data: { ...gate.data, triage } };
}

/** Additive receipt block from intake's recorded triage; empty (key omitted, receipt hashes unchanged) when none. */
export function triageReceiptBlock(intake: Record<string, unknown> | undefined): { triage?: { class: TriageClass; reason: string } } {
  const t = validTriage(intake?.triage);
  return t ? { triage: t } : {};
}
/** PR body line; empty without a recorded triage. */
export function triagePrLine(intake: Record<string, unknown> | undefined): string {
  const t = validTriage(intake?.triage);
  return t ? `\nTriage: ${t.class} (${t.reason})\n` : "";
}

/** `loki internal triage [--repo-dir DIR]`: JSON array of {id, title, body, labels} on stdin, JSON array of {id, class, reason, rule} on stdout. Used by `loki backlog`. */
export async function runTriageCli(args: readonly string[]): Promise<number> {
  const i = args.indexOf("--repo-dir"), repoDir = i >= 0 ? args[i + 1] : process.cwd();
  if (!repoDir) { process.stderr.write("usage: loki internal triage [--repo-dir DIR] < items.json\n"); return 2; }
  let items: unknown;
  try { items = JSON.parse(await new Response(Bun.stdin.stream()).text()); } catch { process.stderr.write("loki internal triage: stdin is not JSON\n"); return 2; }
  if (!Array.isArray(items)) { process.stderr.write("loki internal triage: stdin must be a JSON array\n"); return 2; }
  const repo = repoSignals(repoDir), str = (x: unknown): string => (typeof x === "string" ? x : "");
  const out = items.map((raw) => {
    const it = (raw ?? {}) as Record<string, unknown>, labels = Array.isArray(it.labels) ? it.labels.map((l) => (typeof l === "string" ? l : str((l as { name?: unknown } | null)?.name))) : [];
    return { id: it.id ?? null, ...triageItem({ title: str(it.title), body: str(it.body), labels }, repo) };
  });
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}
