// loki-ts/src/util/lock_ecosystems.ts -- D106: the one ecosystem table behind lockedInstall (lockfile to frozen install form, workspace
// declarations). It lives here, not in src/project_model, because it must name package managers and manifests; project_model sources
// name no language or framework (tests/project_model L0 self-check). Entries in tests/engine10/l0_guard.allowlist move with it. No existing util owns package-manager and lockfile names, so a new file is justified.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LockRule {
  tool: string; subs: string[]; locks: string[];
  locked: (sub: string, rest: string[], env: string[]) => boolean; // the command is already a lock-honoring form
  build: (sub: string, rest: string[], ctx: { berry: boolean }) => string[]; // words of the locked form, the model's flags kept
  /** Glob patterns of the workspace an ancestor directory declares; absent: the ecosystem has no workspace lockfile sharing. */
  ws?: (ancestor: string) => string[];
}
export const has = (rest: string[], ...f: string[]): boolean => rest.some((x) => f.includes(x));
export const withFlag = (rest: string[], flag: string): string[] => (rest.includes(flag) ? rest : [...rest, flag]);
export const text = (dir: string, file: string): string | null => { try { return readFileSync(join(dir, file), "utf8"); } catch { return null; } };
export const quoted = (s: string): string[] => [...s.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
/** package.json `workspaces` (array, or {packages: []}): npm, yarn and bun. */
export const pkgWorkspaces = (dir: string): string[] => {
  try {
    const w = (JSON.parse(text(dir, "package.json") ?? "{}") as { workspaces?: unknown }).workspaces;
    const l = Array.isArray(w) ? w : (w as { packages?: unknown } | undefined)?.packages;
    return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};
/** pnpm-workspace.yaml `packages:` list (a leading ! excludes): block (indented or not) and inline lists. */
export const pnpmWorkspaces = (dir: string): string[] => {
  const out: string[] = []; let inBlock = false;
  for (const l of (text(dir, "pnpm-workspace.yaml") ?? "").split("\n")) {
    const top = /^packages\s*:\s*(.*)$/.exec(l);
    if (top) {
      const v = top[1]!.replace(/\s+#.*$/, "").trim();
      inBlock = v === "" || v.startsWith("#");
      if (v.startsWith("[")) out.push(...v.slice(1, v.includes("]") ? v.indexOf("]") : undefined).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
      continue;
    }
    if (inBlock && /^[^\s#-]/.test(l)) inBlock = false;
    const m = inBlock ? /^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(l) : null;
    if (m) out.push(m[1]!);
  }
  return out;
};
/** `members` (and `exclude`, as ! patterns) of one TOML table such as [workspace] or [tool.uv.workspace]. */
export const tomlWorkspace = (dir: string, file: string, header: string): string[] => {
  const t = text(dir, file); if (!t) return [];
  const at = t.indexOf(`[${header}]`); if (at < 0) return [];
  const body = t.slice(at + header.length + 2).split(/^\[/m)[0]!;
  const list = (k: string): string[] => quoted(new RegExp(`^\\s*${k}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(body)?.[1] ?? "");
  return [...list("members"), ...list("exclude").map((x) => `!${x}`)];
};

/** The ecosystem table: one row per package manager, its official frozen form. `poetry install` already honors poetry.lock, so it is kept
 *  as written (`--no-root` would skip installing the project itself and break src-layout imports; `--sync` would delete environment
 *  packages the lock lacks). */
export const LOCK_RULES: LockRule[] = [
  { tool: "npm", subs: ["install", "i", "ci"], locks: ["package-lock.json", "npm-shrinkwrap.json"], locked: (s) => s === "ci", build: (_s, r) => ["npm", "ci", ...r], ws: pkgWorkspaces },
  { tool: "pnpm", subs: ["install", "i"], locks: ["pnpm-lock.yaml"], locked: (_s, r) => has(r, "--frozen-lockfile") && !has(r, "--no-frozen-lockfile"), build: (_s, r) => ["pnpm", "install", ...withFlag(r.filter((x) => x !== "--no-frozen-lockfile"), "--frozen-lockfile")], ws: pnpmWorkspaces },
  { tool: "yarn", subs: ["", "install"], locks: ["yarn.lock"], locked: (_s, r) => has(r, "--immutable", "--frozen-lockfile"), build: (_s, r, c) => ["yarn", "install", ...withFlag(r, c.berry ? "--immutable" : "--frozen-lockfile")], ws: pkgWorkspaces },
  { tool: "bun", subs: ["install", "i", "ci"], locks: ["bun.lock", "bun.lockb"], locked: (s, r) => s === "ci" || has(r, "--frozen-lockfile"), build: (_s, r) => ["bun", "install", ...withFlag(r, "--frozen-lockfile")], ws: pkgWorkspaces },
  { tool: "uv", subs: ["sync"], locks: ["uv.lock"], locked: (_s, r, e) => has(r, "--locked") || e.some((x) => /^UV_(FROZEN|LOCKED)=(?!0$|false$|$)/i.test(x)), build: (_s, r) => ["uv", "sync", ...withFlag(r.filter((x) => x !== "--frozen"), "--locked")], ws: (d) => tomlWorkspace(d, "pyproject.toml", "tool.uv.workspace") },
  { tool: "poetry", subs: ["install"], locks: ["poetry.lock"], locked: () => true, build: (_s, r) => ["poetry", "install", ...r] },
  { tool: "pipenv", subs: ["install", "sync"], locks: ["Pipfile.lock"], locked: (_s, r) => has(r, "--deploy"), build: (_s, r) => ["pipenv", "install", ...withFlag(r, "--deploy")] },
  { tool: "cargo", subs: ["fetch", "build"], locks: ["Cargo.lock"], locked: (_s, r) => has(r, "--locked", "--frozen"), build: (s, r) => ["cargo", s, ...withFlag(r, "--locked")], ws: (d) => tomlWorkspace(d, "Cargo.toml", "workspace") },
  { tool: "bundle", subs: ["", "install"], locks: ["Gemfile.lock"], locked: (_s, r, e) => e.includes("BUNDLE_FROZEN=true") || has(r, "--frozen", "--deployment"), build: (_s, r) => ["bundle", "install", ...r] },
  { tool: "composer", subs: ["install", "update"], locks: ["composer.lock"], locked: (s) => s === "install", build: (_s, r) => ["composer", "install", ...r] },
];

/** Yarn Berry (2+): .yarnrc.yml beside the lockfile or package.json packageManager yarn@>=2; anything else is Classic. */
export function isYarnBerry(dir: string): boolean {
  if (existsSync(join(dir, ".yarnrc.yml"))) return true;
  try { return /^yarn@([2-9]|\d{2,})/.test(String((JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { packageManager?: unknown }).packageManager ?? "")); } catch { return false; }
}
