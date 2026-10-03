// D62-VIS: optional visual evidence for PRs, behind LOKI_VISUAL_EVIDENCE=1 (off by default).
// Screenshots of changed pages (Playwright CLI already installed in the repo, never downloaded)
// or an HTTP transcript for API repos. Capture never throws and never fails a run: a skip is recorded.
// Each screenshot's sha256 goes into receipt.evidence_screens; `loki verify` rechecks it when present.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

export interface EvidenceScreen { path: string; sha256: string } // path is relative to the run dir
export interface EvidenceResult { screens: EvidenceScreen[]; http: boolean; skipped: string | null }

export const visualEvidenceEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env["LOKI_VISUAL_EVIDENCE"] === "1";

const PAGE_RE = /^(?:.*\/)?(?:app|pages|src|public)\/.*\.(?:html|jsx|tsx|vue|svelte)$/;
export const isPageFile = (p: string): boolean => PAGE_RE.test(p);

/** Best-effort route for a changed page file (Next, Nuxt, SvelteKit and plain html layouts). */
export function routeFor(file: string): string {
  let r = file.replace(/^(?:.*?\/)?(?:app|pages|src|public)\//, "").replace(/^(?:routes|pages)\//, "");
  r = r.replace(/\.(?:html|jsx|tsx|vue|svelte)$/, "").replace(/\/?(?:page|index|\+page)$/, "");
  return `/${r}`.replace(/\/+/g, "/");
}
export const screenName = (route: string): string => (route === "/" ? "index" : route.slice(1).replace(/[^A-Za-z0-9._-]+/g, "_")) || "index";

export const sha256File = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Hash files (paths relative to runDir) into the receipt shape; unreadable files are dropped. */
export function hashScreens(runDir: string, rels: string[]): EvidenceScreen[] {
  const out: EvidenceScreen[] = [];
  for (const rel of rels) { try { out.push({ path: rel, sha256: sha256File(join(runDir, rel)) }); } catch { /* skipped */ } }
  return out;
}

/** Verify side: null when every recorded screen still hashes to its recorded value, else a clear message. */
export function checkScreens(runDir: string, screens: unknown): string | null {
  if (!Array.isArray(screens)) return "evidence_screens is not a list";
  for (const s of screens as { path?: unknown; sha256?: unknown }[]) {
    if (typeof s?.path !== "string" || typeof s.sha256 !== "string") return "evidence_screens entry is malformed";
    if (isAbsolute(s.path) || normalize(s.path).startsWith("..")) return `evidence screenshot path escapes the evidence dir: ${s.path}`;
    const file = join(runDir, s.path);
    let cur = runDir;
    for (const seg of normalize(s.path).split(sep)) { cur = join(cur, seg); if (isSymlink(cur)) return `evidence screenshot path is a symlink: ${s.path}`; }
    if (!existsSync(file)) return `evidence screenshot is missing: ${s.path}`;
    if (sha256File(file) !== s.sha256) return `evidence screenshot was altered: ${s.path}`;
  }
  return null;
}

function pickScript(pkg: Record<string, unknown>): string | null {
  const s = (pkg["scripts"] ?? {}) as Record<string, string>;
  return ["dev", "preview", "start"].find((k) => typeof s[k] === "string") ?? null;
}
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => { const p = (srv.address() as { port: number }).port; srv.close(() => res(p)); });
  });
}
async function waitUp(url: string, ms: number, signal?: AbortSignal): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end && !signal?.aborted) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(2000, end - Date.now()))) }); if (r.status < 500) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(250, end - Date.now()))));
  }
  return false;
}
const playwrightBin = (repoDir: string): string | null => {
  const bin = join(repoDir, "node_modules", ".bin", "playwright");
  return existsSync(bin) ? bin : null;
};
function openapiPaths(repoDir: string): string[] {
  for (const f of ["openapi.json", "openapi.yaml", "openapi.yml", "swagger.json"]) {
    const p = join(repoDir, f);
    if (!existsSync(p)) continue;
    try {
      const txt = readFileSync(p, "utf8");
      const paths = f.endsWith(".json") ? Object.keys((JSON.parse(txt).paths ?? {}) as object) : [...txt.matchAll(/^ {2}(\/[^\s:]*):\s*$/gm)].map((m) => m[1]!);
      return paths.filter((x) => !x.includes("{")).slice(0, 10);
    } catch { return []; }
  }
  return [];
}

export interface CaptureOpts { budgetMs?: number; maxRoutes?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
const DEFAULT_BUDGET_MS = 25_000; // well under the 60s seal stage limit
const MAX_ROUTES = 5;

/** Async screenshot with a hard timeout and kill; resolves true on exit 0. Honors the abort signal. */
function shoot(pw: string, args: string[], cwd: string, ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((res) => {
    if (ms <= 0 || signal?.aborted) return res(false);
    const c = spawn(pw, args, { cwd, env: { ...process.env }, stdio: "ignore" });
    const done = (ok: boolean): void => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); res(ok); };
    const kill = (): void => { try { c.kill("SIGKILL"); } catch { /* gone */ } };
    const t = setTimeout(() => { kill(); done(false); }, ms);
    const onAbort = (): void => { kill(); done(false); };
    signal?.addEventListener("abort", onAbort);
    c.on("error", () => done(false));
    c.on("exit", (code) => done(code === 0));
  });
}

const isSymlink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** Never throws. runDir is the run directory; evidence goes to a fresh dir under it. changed is repo-relative paths. */
export async function captureVisualEvidence(repoDir: string, runDir: string, changed: string[], opts: CaptureOpts = {}): Promise<EvidenceResult> {
  const skip = (why: string): EvidenceResult => ({ screens: [], http: false, skipped: why });
  const signal = opts.signal;
  let child: ReturnType<typeof spawn> | null = null;
  try {
    if (!visualEvidenceEnabled(opts.env)) return skip("LOKI_VISUAL_EVIDENCE is not 1");
    const pkgPath = join(repoDir, "package.json");
    if (!existsSync(pkgPath)) return skip("no package.json");
    const script = pickScript(JSON.parse(readFileSync(pkgPath, "utf8")));
    if (!script) return skip("no dev, preview or start script");
    const pages = changed.filter(isPageFile);
    const apiPaths = pages.length === 0 ? openapiPaths(repoDir) : [];
    if (pages.length === 0 && apiPaths.length === 0) return skip("no changed page files and no openapi routes");
    const pw = pages.length > 0 ? playwrightBin(repoDir) : null;
    if (pages.length > 0 && !pw) return skip("playwright not resolvable in the repo");
    const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS, end = Date.now() + budget, left = (): number => end - Date.now();
    const aborted = (): boolean => signal?.aborted === true;
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    child = spawn("npm", ["run", script, "--silent"], { cwd: repoDir, detached: true, env: { ...(opts.env ?? process.env), PORT: String(port), HOST: "127.0.0.1", BROWSER: "none" }, stdio: "ignore" });
    child.on("error", () => undefined);
    if (!(await waitUp(base, left(), signal))) return skip(aborted() ? "aborted" : `${script} server did not answer within ${Math.round(budget / 1000)}s`);
    const evRoot = join(runDir, "evidence");
    if (isSymlink(evRoot)) return skip("evidence dir is a symlink");
    mkdirSync(evRoot, { recursive: true });
    if (pages.length > 0) {
      const rel0 = join("evidence", randomBytes(6).toString("hex"));
      mkdirSync(join(runDir, rel0)); // non-recursive: refuses an existing path
      const rels: string[] = [];
      for (const route of [...new Set(pages.map(routeFor))].slice(0, opts.maxRoutes ?? MAX_ROUTES)) {
        if (aborted() || left() <= 0) break;
        const rel = join(rel0, `${screenName(route)}.png`);
        const ok = await shoot(pw!, ["screenshot", `${base}${route}`, join(runDir, rel)], repoDir, left(), signal);
        if (ok && !aborted() && !isSymlink(join(runDir, rel)) && existsSync(join(runDir, rel))) rels.push(rel);
      }
      if (aborted()) return skip("aborted");
      const screens = hashScreens(runDir, rels);
      return screens.length > 0 ? { screens, http: false, skipped: null } : skip(left() <= 0 ? `screenshots did not finish within ${Math.round(budget / 1000)}s` : "screenshots failed");
    }
    const rows: unknown[] = [];
    for (const p of apiPaths) {
      if (aborted() || left() <= 0) break;
      try { const r = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(Math.max(1, left())) }); rows.push({ method: "GET", path: p, status: r.status, body: (await r.text()).slice(0, 2048) }); } catch { rows.push({ method: "GET", path: p, status: 0, body: "" }); }
    }
    if (aborted()) return skip("aborted");
    const hdir = join(evRoot, randomBytes(6).toString("hex"));
    mkdirSync(hdir);
    writeFileSync(join(hdir, "http.json"), JSON.stringify(rows, null, 2) + "\n");
    return { screens: [], http: true, skipped: null };
  } catch (e) {
    return skip(`capture failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  } finally {
    try { if (child?.pid) process.kill(-child.pid, "SIGTERM"); } catch { try { child?.kill("SIGTERM"); } catch { /* already gone */ } }
  }
}

/** Seal hook: returns `{ evidence_screens }` to spread into the receipt body, or `{}`. Records a skip in notProven. Throws only if the stage was aborted, so nothing is written after a limit kill. */
export async function sealEvidence(repoDir: string, runDir: string, o: { verify?: Record<string, unknown> }, notProven: Set<string>, signal?: AbortSignal): Promise<{ evidence_screens?: EvidenceScreen[] }> {
  if (!visualEvidenceEnabled()) return {};
  const cf = Array.isArray(o.verify?.["changed_files"]) ? (o.verify["changed_files"] as unknown[]).map(String) : [];
  const ev = await captureVisualEvidence(repoDir, runDir, cf, { signal });
  if (signal?.aborted) throw new Error("seal aborted: visual evidence discarded");
  if (ev.skipped) notProven.add(`visual evidence skipped: ${ev.skipped}`);
  return ev.screens.length > 0 ? { evidence_screens: ev.screens } : {};
}

/** Verify hook: null when the receipt has no evidence_screens or all still match, else a message. */
export function receiptScreensProblem(receiptPath: string, receipt: Record<string, unknown>): string | null {
  return receipt["evidence_screens"] === undefined ? null : checkScreens(dirname(receiptPath), receipt["evidence_screens"]);
}

/** PR hook: an "Evidence" markdown section read from the sealed receipt, or "" when there are no screens. */
export function evidenceSection(receiptPath: string | undefined | null): string {
  try {
    const r = JSON.parse(readFileSync(receiptPath ?? "", "utf8")) as { evidence_screens?: EvidenceScreen[] };
    if (!Array.isArray(r.evidence_screens) || r.evidence_screens.length === 0) return "";
    return `\n## Evidence\n${r.evidence_screens.map((s) => `- ${s.path} (sha256:${s.sha256})`).join("\n")}\n`;
  } catch { return ""; }
}
