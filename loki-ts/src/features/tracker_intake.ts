// D62-JIRA: Jira and Linear intake. Turns a `jira:PROJ-123` / `linear:ENG-42` ref (or the tracker's
// issue URL) into the same issue.json shape GitHub intake writes, plus a `source` field, so every
// stage downstream is unchanged. fetch is injected so tests need no network. GitHub parsing is untouched.
import { writeFileSync } from "node:fs";
import { LOKI_COMMENT_MARKER, withIssueContext, type IssueComment, type NormalizedIssue } from "../engine10/fetch_issue.ts";

export type TrackerRef = { source: "jira"; key: string; site?: string } | { source: "linear"; key: string };
export type TrackerIssue = NormalizedIssue & { source: "jira" | "linear" };
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
const JIRA_KEY = "[A-Z][A-Z0-9_]*-\\d+";
const JIRA_REF = new RegExp(`^jira:(${JIRA_KEY})$`);
const JIRA_URL = new RegExp(`^https://([\\w-]+(?:\\.[\\w-]+)*\\.atlassian\\.net)/browse/(${JIRA_KEY})/?(?:[?#]\\S*)?$`);
const LINEAR_REF = /^linear:([A-Za-z][A-Za-z0-9]*-\d+)$/;
const LINEAR_URL = /^https:\/\/linear\.app\/[\w-]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/\S*)?$/;
const SELF_URL = new RegExp(`^(https?://[^/\\s?#]+)/browse/(${JIRA_KEY})/?(?:[?#]\\S*)?$`);

// Self-hosted Jira: a browse URL parses only when its origin equals JIRA_BASE_URL's origin.
function selfHostedSite(s: string, env: NodeJS.ProcessEnv): TrackerRef | null {
  const base = env.JIRA_BASE_URL;
  const m = SELF_URL.exec(s);
  if (!base || !m || m[1]!.includes("@")) return null;
  try {
    if (new URL(base).origin !== new URL(m[1]!).origin) return null;
  } catch { return null; }
  return { source: "jira", key: m[2]!, site: new URL(m[1]!).origin };
}
/** Returns the parsed tracker ref, or null for anything else (GitHub refs, free text). */
export function parseTrackerRef(ref: string, env: NodeJS.ProcessEnv = process.env): TrackerRef | null {
  if (env.LOKI_TRACKER_INTAKE === "0") return null;
  const s = ref.trim();
  let m = JIRA_REF.exec(s);
  if (m) return { source: "jira", key: m[1]! };
  m = JIRA_URL.exec(s);
  if (m) return { source: "jira", key: m[2]!, site: `https://${m[1]}` };
  const site = selfHostedSite(s, env);
  if (site) return site;
  m = LINEAR_REF.exec(s) ?? LINEAR_URL.exec(s);
  if (m) return { source: "linear", key: m[1]!.toUpperCase() };
  return null;
}
interface AdfNode { type?: string; text?: string; content?: AdfNode[] }
/** Converts an Atlassian Document Format tree (or a plain string) to plain text. */
export function adfToText(doc: unknown): string {
  if (typeof doc === "string") return doc;
  if (!doc || typeof doc !== "object") return "";
  const walk = (n: AdfNode, listPrefix: string): string => {
    const kids = n.content ?? [];
    switch (n.type) {
      case "text": return n.text ?? "";
      case "hardBreak": return "\n";
      case "paragraph": case "heading": case "codeBlock": return kids.map((k) => walk(k, "")).join("") + "\n";
      case "bulletList": return kids.map((k) => walk(k, "- ")).join("");
      case "orderedList": return kids.map((k, i) => walk(k, `${i + 1}. `)).join("");
      case "listItem": {
        const inner = kids.map((k) => walk(k, "")).join("").replace(/\n+$/, "");
        return `${listPrefix}${inner.split("\n").join("\n  ")}\n`;
      }
      default: return kids.map((k) => walk(k, listPrefix)).join("");
    }
  };
  return walk(doc as AdfNode, "").replace(/\n{3,}/g, "\n\n").trim();
}
// L039: Jira and Linear have no author association, so intake reuses the trust lists the trigger server already uses to steer a
// run from a tracker comment (autonomy/trigger-server.py tracker_comment_steer): LOKI_JIRA_STEER_ACTORS (Jira accountIds) and
// LOKI_LINEAR_STEER_ACTORS (Linear user ids), comma-separated, exact match. Display names are never matched (anyone can set one).
// Unset or empty trusts nobody, so no comment is added. Loki's own writeback comments are left out, as there.
export function steerActors(env: NodeJS.ProcessEnv, source: "jira" | "linear"): Set<string> {
  const v = source === "jira" ? env.LOKI_JIRA_STEER_ACTORS : env.LOKI_LINEAR_STEER_ACTORS;
  return new Set((v ?? "").split(",").map((x) => x.trim()).filter(Boolean));
}
function pickTrusted<C>(list: C[] | undefined, actor: (c: C) => unknown, toComment: (c: C) => IssueComment, allow: Set<string>): { trusted: IssueComment[]; excluded: number } {
  const all = Array.isArray(list) ? list : [];
  const trusted = all.filter((c) => { const a = actor(c); return typeof a === "string" && allow.has(a); }).map(toComment)
    .filter((c) => c.body.trim() !== "" && !c.body.includes(LOKI_COMMENT_MARKER));
  return { trusted, excluded: all.length - trusted.length };
}
function need(env: NodeJS.ProcessEnv, name: string, hint = ""): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set (required for this issue ref${hint})`);
  return v;
}
async function fetchJira(ref: Extract<TrackerRef, { source: "jira" }>, f: FetchFn, env: NodeJS.ProcessEnv): Promise<TrackerIssue> {
  const base = (env.JIRA_BASE_URL || ref.site || need(env, "JIRA_BASE_URL", "; Jira intake needs JIRA_EMAIL, JIRA_API_TOKEN and JIRA_BASE_URL")).replace(/\/+$/, "");
  if (env.JIRA_BASE_URL && ref.site) {
    let a = "", b = "";
    try { a = new URL(env.JIRA_BASE_URL).origin; b = new URL(ref.site).origin; } catch { /* mismatch below */ }
    if (!a || a !== b || /@/.test(ref.site)) {
      throw new Error(`Jira browse URL site ${ref.site} does not match JIRA_BASE_URL ${env.JIRA_BASE_URL}; refusing to fetch ${ref.key} from the wrong site`);
    }
  }
  const jiraHint = "; Jira intake needs JIRA_EMAIL, JIRA_API_TOKEN and JIRA_BASE_URL";
  const email = need(env, "JIRA_EMAIL", jiraHint), token = need(env, "JIRA_API_TOKEN", jiraHint);
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const res = await f(`${base}/rest/api/3/issue/${encodeURIComponent(ref.key)}`, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Jira returned HTTP ${res.status} for ${ref.key}`);
  const j = (await res.json()) as { key?: string; fields?: { summary?: string; description?: unknown; labels?: string[]; creator?: { displayName?: string }; reporter?: { displayName?: string }; created?: string; comment?: { comments?: JiraComment[] } } };
  const fl = j.fields ?? {};
  const { trusted, excluded } = pickTrusted(fl.comment?.comments, (c) => c.author?.accountId,
    (c) => ({ author: c.author?.displayName || c.author?.accountId || "", association: "LOKI_JIRA_STEER_ACTORS", created_at: c.created ?? "", body: adfToText(c.body) }), steerActors(env, "jira"));
  return withIssueContext<TrackerIssue>({
    source: "jira", provider: "jira", number: 0,
    title: fl.summary ?? ref.key, body: adfToText(fl.description),
    labels: Array.isArray(fl.labels) ? fl.labels : [],
    author: fl.reporter?.displayName ?? fl.creator?.displayName ?? "",
    url: `${base}/browse/${j.key ?? ref.key}`, created_at: fl.created ?? "",
    repo: j.key ?? ref.key, state: null, closed_by_merged_pr: false,
  }, trusted, excluded);
}
interface JiraComment { author?: { accountId?: string; displayName?: string }; body?: unknown; created?: string }
interface LinearComment { body?: string; createdAt?: string; user?: { id?: string; name?: string } | null }
async function fetchLinear(ref: Extract<TrackerRef, { source: "linear" }>, f: FetchFn, env: NodeJS.ProcessEnv): Promise<TrackerIssue> {
  const key = need(env, "LINEAR_API_KEY", "; Linear intake needs LINEAR_API_KEY");
  const res = await f("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "query($id: String!) { issue(id: $id) { identifier title description url labels { nodes { name } } comments(first: 100) { nodes { body createdAt user { id name } } } } }", variables: { id: ref.key } }),
  });
  if (res.status === 401) throw new Error(`Linear rejected the credentials (HTTP 401); check LINEAR_API_KEY`);
  if (!res.ok) throw new Error(`Linear returned HTTP ${res.status} for ${ref.key}`);
  const j = (await res.json()) as { data?: { issue?: { identifier?: string; title?: string; description?: string | null; url?: string; labels?: { nodes?: { name?: string }[] }; comments?: { nodes?: LinearComment[] } } | null }; errors?: { message?: string }[] };
  const is = j.data?.issue;
  if (!j.data && j.errors?.length) throw new Error(`Linear returned errors for ${ref.key}; check LINEAR_API_KEY: ${j.errors[0]?.message ?? "unknown"}`);
  if (!is) throw new Error(`Linear issue ${ref.key} not found${j.errors?.[0]?.message ? `: ${j.errors[0].message}` : ""}`);
  const labels = (is.labels?.nodes ?? []).map((l) => l?.name).filter((n): n is string => typeof n === "string" && n !== "");
  const { trusted, excluded } = pickTrusted(is.comments?.nodes, (c) => c.user?.id,
    (c) => ({ author: c.user?.name || c.user?.id || "", association: "LOKI_LINEAR_STEER_ACTORS", created_at: c.createdAt ?? "", body: c.body ?? "" }), steerActors(env, "linear"));
  return withIssueContext<TrackerIssue>({
    source: "linear", provider: "linear", number: 0,
    title: is.title ?? ref.key, body: is.description ?? "", labels, author: "",
    url: is.url ?? "", created_at: "", repo: is.identifier ?? ref.key, state: null, closed_by_merged_pr: false,
  }, trusted, excluded);
}
/** Fetches and normalizes a Jira or Linear issue. Throws on missing env vars (naming the variable) or HTTP errors. */
export async function fetchTrackerIssue(ref: TrackerRef, f: FetchFn = fetch, env: NodeJS.ProcessEnv = process.env): Promise<TrackerIssue> {
  return ref.source === "jira" ? fetchJira(ref, f, env) : fetchLinear(ref, f, env);
}
export async function fetchTrackerIssueToFile(ref: TrackerRef, outFile: string, f: FetchFn = fetch, env: NodeJS.ProcessEnv = process.env): Promise<TrackerIssue> {
  const issue = await fetchTrackerIssue(ref, f, env);
  writeFileSync(outFile, JSON.stringify(issue));
  return issue;
}

// `loki backlog jira:PROJ | linear:TEAM`: list the open items of one Jira project or Linear team, normalized like a fetched issue, so the
// backlog triages and runs them the way it does GitHub issues. Same credentials and fetch injection as the single-issue intake above.
export type TrackerProject = { source: "jira" | "linear"; project: string };
export interface TrackerListItem { key: string; number: number; title: string; body: string; labels: string[] }
export interface TrackerSelector { label?: string; numbers?: readonly number[] }
const MAX_LIST = 200;
/** `jira:PROJ` or `linear:TEAM` (no issue number) -> the project to list; anything else is null. */
export function parseTrackerProject(s: string, env: NodeJS.ProcessEnv = process.env): TrackerProject | null {
  if (env.LOKI_TRACKER_INTAKE === "0") return null;
  const m = /^(jira|linear):([A-Za-z][A-Za-z0-9_]*)$/.exec(s.trim());
  if (!m || (m[1] === "jira" && !/^[A-Z][A-Z0-9_]*$/.test(m[2]!)) || (m[1] === "linear" && m[2]!.includes("_"))) return null;
  return { source: m[1] as "jira" | "linear", project: m[2]!.toUpperCase() };
}
const byNumber = (a: TrackerListItem, b: TrackerListItem): number => a.number - b.number;
const keyNumber = (key: string): number => Number(/-(\d+)$/.exec(key)?.[1] ?? 0);
async function listJira(p: TrackerProject, sel: TrackerSelector, f: FetchFn, env: NodeJS.ProcessEnv): Promise<TrackerListItem[]> {
  const hint = "; Jira intake needs JIRA_EMAIL, JIRA_API_TOKEN and JIRA_BASE_URL";
  const base = need(env, "JIRA_BASE_URL", hint).replace(/\/+$/, ""), email = need(env, "JIRA_EMAIL", hint), token = need(env, "JIRA_API_TOKEN", hint);
  const q = (v: string): string => `"${v.replace(/["\\]/g, "\\$&")}"`;
  const jql = [sel.numbers?.length ? `key in (${sel.numbers.map((n) => `${p.project}-${n}`).join(", ")})` : `project = ${q(p.project)} AND statusCategory != Done`,
    ...(sel.label ? [`labels = ${q(sel.label)}`] : [])].join(" AND ") + " ORDER BY key ASC";
  const auth = Buffer.from(`${email}:${token}`).toString("base64"), out: TrackerListItem[] = [];
  let page: string | undefined;
  do {
    const url = `${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,description,labels&maxResults=100${page ? `&nextPageToken=${encodeURIComponent(page)}` : ""}`;
    const res = await f(url, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
    if (!res.ok) throw new Error(`Jira returned HTTP ${res.status} listing ${p.project}`);
    const j = (await res.json()) as { issues?: { key?: string; fields?: { summary?: string; description?: unknown; labels?: string[] } }[]; nextPageToken?: string; isLast?: boolean };
    for (const it of j.issues ?? []) {
      if (!it.key) continue;
      const fl = it.fields ?? {};
      out.push({ key: it.key, number: keyNumber(it.key), title: fl.summary ?? it.key, body: adfToText(fl.description), labels: Array.isArray(fl.labels) ? fl.labels : [] });
    }
    page = j.isLast === true ? undefined : j.nextPageToken;
  } while (page && out.length < MAX_LIST);
  return out.slice(0, MAX_LIST).sort(byNumber);
}
async function listLinear(p: TrackerProject, sel: TrackerSelector, f: FetchFn, env: NodeJS.ProcessEnv): Promise<TrackerListItem[]> {
  const key = need(env, "LINEAR_API_KEY", "; Linear intake needs LINEAR_API_KEY");
  const filter: Record<string, unknown> = { team: { key: { eq: p.project } },
    ...(sel.numbers?.length ? { number: { in: [...sel.numbers] } } : { state: { type: { nin: ["completed", "canceled"] } } }),
    ...(sel.label ? { labels: { some: { name: { eq: sel.label } } } } : {}) };
  const query = "query($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 100, after: $after) { nodes { identifier number title description labels { nodes { name } } } pageInfo { hasNextPage endCursor } } }";
  type Node = { identifier?: string; number?: number; title?: string; description?: string | null; labels?: { nodes?: { name?: string }[] } };
  const out: TrackerListItem[] = [];
  let after: string | null = null;
  do {
    const res = await f("https://api.linear.app/graphql", { method: "POST", headers: { Authorization: key, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables: { filter, after } }) });
    if (res.status === 401) throw new Error(`Linear rejected the credentials (HTTP 401); check LINEAR_API_KEY`);
    if (!res.ok) throw new Error(`Linear returned HTTP ${res.status} listing ${p.project}`);
    const j = (await res.json()) as { data?: { issues?: { nodes?: Node[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } | null }; errors?: { message?: string }[] };
    if (!j.data?.issues) throw new Error(`Linear returned errors listing ${p.project}; check LINEAR_API_KEY: ${j.errors?.[0]?.message ?? "no issues field"}`);
    for (const n of j.data.issues.nodes ?? []) {
      if (!n.identifier) continue;
      out.push({ key: n.identifier, number: typeof n.number === "number" ? n.number : keyNumber(n.identifier), title: n.title ?? n.identifier, body: n.description ?? "",
        labels: (n.labels?.nodes ?? []).map((l) => l.name ?? "").filter(Boolean) });
    }
    const pi = j.data.issues.pageInfo;
    after = pi?.hasNextPage && pi.endCursor ? pi.endCursor : null;
  } while (after && out.length < MAX_LIST);
  return out.slice(0, MAX_LIST).sort(byNumber);
}
/** Open items of one Jira project or Linear team (or exactly `numbers`, any state), optionally only those with `label`; at most 200, by number. */
export async function listTrackerIssues(p: TrackerProject, sel: TrackerSelector = {}, f: FetchFn = fetch, env: NodeJS.ProcessEnv = process.env): Promise<TrackerListItem[]> {
  return p.source === "jira" ? listJira(p, sel, f, env) : listLinear(p, sel, f, env);
}
/** `loki internal tracker-list <jira:PROJ|linear:TEAM> [--label X] [--issues 1,2]`: JSON array of {key, number, title, body, labels} on stdout. Used by `loki backlog`. */
export async function runTrackerListCli(args: readonly string[], f: FetchFn = fetch, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const usage = "usage: loki internal tracker-list <jira:PROJ|linear:TEAM> [--label X] [--issues 1,2,3]\n";
  const p = parseTrackerProject(args[0] ?? "", env), li = args.indexOf("--label"), ii = args.indexOf("--issues");
  const label = li >= 0 ? args[li + 1] : undefined, issues = ii >= 0 ? args[ii + 1] : undefined;
  if (!p || (li >= 0 && !label) || (ii >= 0 && !/^\d+(,\d+)*$/.test(issues ?? ""))) { process.stderr.write(usage); return 2; }
  try {
    const items = await listTrackerIssues(p, { ...(label ? { label } : {}), ...(issues ? { numbers: issues.split(",").map(Number) } : {}) }, f, env);
    process.stdout.write(`${JSON.stringify(items)}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`loki internal tracker-list: ${(e as Error).message}\n`);
    return 1;
  }
}
