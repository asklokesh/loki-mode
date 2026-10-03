// GET /v1/providers (CPE-15): which provider CLIs are installed, their versions, which auth env var NAMES are set (never values), and the model tiers.
// Behind the /v1 token guard. Every probe is bounded by a timeout; nothing here reads or returns a secret value.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { probeAllowed, ttlCache, type RouteCtx } from "./index.ts";

const ORDER = ["claude", "codex", "cline", "aider", "opencode"] as const;
const DEPRECATED = ["gemini"] as const;
const AUTH_ENV: Record<string, string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["OPENAI_API_KEY"],
  cline: ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"],
  aider: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
  opencode: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};
const DEFAULT_TIMEOUT_MS = 3000;

export interface ProbeResult { installed: boolean; version: string | null; probe: "ok" | "timeout" | "error" | "not_found" }

function findOnPath(bin: string, pathVar: string): string | null {
  for (const d of pathVar.split(delimiter)) {
    if (!d) continue;
    const p = join(d, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Run `<bin> --version` with a hard timeout. Only a version-looking token is returned, never raw output. */
export function probeCli(bin: string, timeoutMs: number, pathVar = process.env.PATH ?? ""): Promise<ProbeResult> {
  const exe = findOnPath(bin, pathVar);
  if (!exe) return Promise.resolve({ installed: false, version: null, probe: "not_found" });
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: ProbeResult): void => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, ["--version"], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, NO_COLOR: "1" } });
    } catch {
      return resolve({ installed: true, version: null, probe: "error" });
    }
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish({ installed: true, version: null, probe: "timeout" });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { if (out.length < 2048) out += d.toString("utf8"); });
    child.on("error", () => finish({ installed: true, version: null, probe: "error" }));
    child.on("close", () => {
      const m = /\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z.]+)?/.exec(out);
      finish({ installed: true, version: m ? m[0] : null, probe: "ok" });
    });
  });
}

function providersDir(): string | null {
  const cands = [process.env.LOKI_PROVIDERS_DIR, join(import.meta.dir, "../../../../../providers"), join(import.meta.dir, "../../../providers")];
  return cands.find((d): d is string => !!d && existsSync(join(d, "model_catalog.json"))) ?? null;
}

interface CatalogModel { id?: string; alias?: string; tier?: string }
interface CatalogProvider { models?: CatalogModel[]; latest_planning?: string; latest_development?: string; latest_fast?: string }

function loadCatalog(dir: string | null): { providers: Record<string, CatalogProvider>; updated: string | null } {
  if (!dir) return { providers: {}, updated: null };
  try {
    const j = JSON.parse(readFileSync(join(dir, "model_catalog.json"), "utf8"));
    return { providers: j.providers ?? {}, updated: typeof j.updated === "string" ? j.updated : null };
  } catch { return { providers: {}, updated: null }; }
}

export async function listProviders(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  const cat = loadCatalog(providersDir());
  const names = [...ORDER, ...DEPRECATED];
  const rows = await Promise.all(names.map(async (name) => {
    const probe = await probeCli(name, timeoutMs);
    const envNames = AUTH_ENV[name] ?? [];
    const envSet = envNames.filter((n) => (process.env[n] ?? "") !== "");
    const cp = cat.providers[name];
    const tiers: Record<string, string | null> = cp
      ? { planning: cp.latest_planning ?? null, development: cp.latest_development ?? null, fast: cp.latest_fast ?? null }
      : {};
    const models = (cp?.models ?? []).filter((m) => m.id).map((m) => ({ id: m.id as string, alias: m.alias ?? null, tier: m.tier ?? null }));
    return {
      id: name,
      deprecated: (DEPRECATED as readonly string[]).includes(name),
      installed: probe.installed,
      version: probe.version,
      probe: probe.probe,
      auth_env_names: envNames,
      auth_env_set: envSet,
      auth_present: envSet.length > 0,
      tiers,
      models,
    };
  }));
  return { providers: rows, catalog_updated: cat.updated, probe_timeout_ms: timeoutMs };
}

export function mount(ctx: RouteCtx): void {
  const cached = ttlCache<unknown>();
  ctx.app.get("/v1/providers", async (c) => {
    if (!probeAllowed(ctx, c)) return c.json({ error: "loopback only without a token" }, 403);
    const t = Number.parseInt(process.env.LOKI_PROVIDER_PROBE_TIMEOUT_MS ?? "", 10);
    const ms = t > 0 ? t : DEFAULT_TIMEOUT_MS;
    return c.json(await cached(String(ms), () => listProviders(ms)));
  });
}
