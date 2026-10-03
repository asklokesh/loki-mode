// D62-VIS: optional visual evidence for PRs, behind LOKI_VISUAL_EVIDENCE=1 (off by default).
// Screenshots of changed pages (Playwright CLI already installed in the repo, never downloaded)
// or an HTTP transcript for API repos. Capture never throws and never fails a run: a skip is recorded.
// Each screenshot's sha256 goes into receipt.evidence_screens; `loki verify` rechecks it when present.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join, normalize } from "node:path";

export interface EvidenceScreen { path: string; sha256: string } // path is relative to the .loki dir
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

/** Hash files (paths relative to lokiRoot) into the receipt shape; unreadable files are dropped. */
export function hashScreens(lokiRoot: string, rels: string[]): EvidenceScreen[] {
  const out: EvidenceScreen[] = [];
  for (const rel of rels) { try { out.push({ path: rel, sha256: sha256File(join(lokiRoot, rel)) }); } catch { /* skipped */ } }
  return out;
}

/** Verify side: null when every recorded screen still hashes to its recorded value, else a clear message. */
export function checkScreens(lokiRoot: string, screens: unknown): string | null {
  if (!Array.isArray(screens)) return "evidence_screens is not a list";
  for (const s of screens as { path?: unknown; sha256?: unknown }[]) {
    if (typeof s?.path !== "string" || typeof s.sha256 !== "string") return "evidence_screens entry is malformed";
    if (isAbsolute(s.path) || normalize(s.path).startsWith("..")) return `evidence screenshot path escapes the evidence dir: ${s.path}`;
    const file = join(lokiRoot, s.path);
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
async function waitUp(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
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

export interface CaptureOpts { timeoutMs?: number; env?: NodeJS.ProcessEnv }

/** Never throws. lokiRoot is the .loki dir; changed is repo-relative paths. */
export async function captureVisualEvidence(repoDir: string, lokiRoot: string, changed: string[], opts: CaptureOpts = {}): Promise<EvidenceResult> {
  const skip = (why: string): EvidenceResult => ({ screens: [], http: false, skipped: why });
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
    const timeout = opts.timeoutMs ?? 90_000, port = await freePort(), base = `http://127.0.0.1:${port}`;
    child = spawn("npm", ["run", script, "--silent"], { cwd: repoDir, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", BROWSER: "none" }, stdio: "ignore" });
    child.on("error", () => undefined);
    if (!(await waitUp(base, timeout))) return skip(`${script} server did not answer within ${Math.round(timeout / 1000)}s`);
    const dir = join(lokiRoot, "evidence");
    if (pages.length > 0) {
      mkdirSync(join(dir, "screens"), { recursive: true });
      const rels: string[] = [];
      for (const route of [...new Set(pages.map(routeFor))]) {
        const rel = join("evidence", "screens", `${screenName(route)}.png`);
        const r = spawnSync(pw!, ["screenshot", `${base}${route}`, join(lokiRoot, rel)], { cwd: repoDir, env: process.env, timeout: 60_000, stdio: "ignore" });
        if (r.status === 0 && existsSync(join(lokiRoot, rel))) rels.push(rel);
      }
      const screens = hashScreens(lokiRoot, rels);
      return screens.length > 0 ? { screens, http: false, skipped: null } : skip("screenshots failed");
    }
    const rows: unknown[] = [];
    for (const p of apiPaths) {
      try { const r = await fetch(`${base}${p}`); rows.push({ method: "GET", path: p, status: r.status, body: (await r.text()).slice(0, 2048) }); } catch { rows.push({ method: "GET", path: p, status: 0, body: "" }); }
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "http.json"), JSON.stringify(rows, null, 2) + "\n");
    return { screens: [], http: true, skipped: null };
  } catch (e) {
    return skip(`capture failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  } finally {
    try { child?.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

/** Seal hook: returns `{ evidence_screens }` to spread into the receipt body, or `{}`. Records a skip in notProven. Never throws. */
export async function sealEvidence(repoDir: string, runDir: string, o: { verify?: Record<string, unknown> }, notProven: Set<string>): Promise<{ evidence_screens?: EvidenceScreen[] }> {
  if (!visualEvidenceEnabled()) return {};
  const cf = Array.isArray(o.verify?.["changed_files"]) ? (o.verify["changed_files"] as unknown[]).map(String) : [];
  const ev = await captureVisualEvidence(repoDir, join(runDir, "..", ".."), cf);
  if (ev.skipped) notProven.add(`visual evidence skipped: ${ev.skipped}`);
  return ev.screens.length > 0 ? { evidence_screens: ev.screens } : {};
}

/** Verify hook: null when the receipt has no evidence_screens or all still match, else a message. */
export function receiptScreensProblem(receiptPath: string, receipt: Record<string, unknown>): string | null {
  return receipt["evidence_screens"] === undefined ? null : checkScreens(join(receiptPath, "..", "..", ".."), receipt["evidence_screens"]);
}

/** PR hook: an "Evidence" markdown section read from the sealed receipt, or "" when there are no screens. */
export function evidenceSection(receiptPath: string | undefined | null): string {
  try {
    const r = JSON.parse(readFileSync(receiptPath ?? "", "utf8")) as { evidence_screens?: EvidenceScreen[] };
    if (!Array.isArray(r.evidence_screens) || r.evidence_screens.length === 0) return "";
    return `\n## Evidence\n${r.evidence_screens.map((s) => `- ${s.path} (sha256:${s.sha256})`).join("\n")}\n`;
  } catch { return ""; }
}
