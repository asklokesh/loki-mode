// D62-JIRA: Jira and Linear intake. Turns a `jira:PROJ-123` / `linear:ENG-42` ref (or the tracker's
// issue URL) into the same issue.json shape GitHub intake writes, plus a `source` field, so every
// stage downstream is unchanged. fetch is injected so tests need no network. GitHub parsing is untouched.
import { writeFileSync } from "node:fs";
import type { NormalizedIssue } from "../engine10/fetch_issue.ts";

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
  const j = (await res.json()) as { key?: string; fields?: { summary?: string; description?: unknown; labels?: string[]; creator?: { displayName?: string }; reporter?: { displayName?: string }; created?: string } };
  const fl = j.fields ?? {};
  return {
    source: "jira", provider: "jira", number: 0,
    title: fl.summary ?? ref.key, body: adfToText(fl.description),
    labels: Array.isArray(fl.labels) ? fl.labels : [],
    author: fl.reporter?.displayName ?? fl.creator?.displayName ?? "",
    url: `${base}/browse/${j.key ?? ref.key}`, created_at: fl.created ?? "",
    repo: j.key ?? ref.key, state: null, closed_by_merged_pr: false,
  };
}

async function fetchLinear(ref: Extract<TrackerRef, { source: "linear" }>, f: FetchFn, env: NodeJS.ProcessEnv): Promise<TrackerIssue> {
  const key = need(env, "LINEAR_API_KEY", "; Linear intake needs LINEAR_API_KEY");
  const res = await f("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "query($id: String!) { issue(id: $id) { identifier title description url } }", variables: { id: ref.key } }),
  });
  if (res.status === 401) throw new Error(`Linear rejected the credentials (HTTP 401); check LINEAR_API_KEY`);
  if (!res.ok) throw new Error(`Linear returned HTTP ${res.status} for ${ref.key}`);
  const j = (await res.json()) as { data?: { issue?: { identifier?: string; title?: string; description?: string | null; url?: string } | null }; errors?: { message?: string }[] };
  const is = j.data?.issue;
  if (!j.data && j.errors?.length) throw new Error(`Linear returned errors for ${ref.key}; check LINEAR_API_KEY: ${j.errors[0]?.message ?? "unknown"}`);
  if (!is) throw new Error(`Linear issue ${ref.key} not found${j.errors?.[0]?.message ? `: ${j.errors[0].message}` : ""}`);
  return {
    source: "linear", provider: "linear", number: 0,
    title: is.title ?? ref.key, body: is.description ?? "", labels: [], author: "",
    url: is.url ?? "", created_at: "", repo: is.identifier ?? ref.key, state: null, closed_by_merged_pr: false,
  };
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
