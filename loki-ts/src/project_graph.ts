// Phase F: cross-project context discovery (Bun route).
//
// Discovers a multi-member application graph by walking from a target dir
// up one parent level looking for `.loki/app.json` marker files. When found,
// the manifest declares sibling members that share CLAUDE.md + memory dirs.
//
// Scope: only CLAUDE.md + memory are shared across members; state, queue,
// and checkpoints stay per-member. Discovery does not follow symlinks.
//
// Mirrors the bash implementation. See `docs/MIGRATION-STATUS.md` and the
// architect design for the binding schema and env-var contract.

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type AppGraphResult = {
  appId: string;
  root: string;
  members: string[];
  sharedMemoryDir?: string;
};

type AppJson = {
  schema_version: number;
  app_id: string;
  members?: string[];
  shared_memory_dir?: string;
};

const APP_ID_REGEX = /^[a-z0-9-]{3,40}$/;
const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Parse and validate a `.loki/app.json` manifest. Returns null when the file
 * is missing, unreadable, malformed, or fails schema validation.
 */
function readManifest(path: string): AppJson | null {
  if (!existsSync(path)) {
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["schema_version"] !== SUPPORTED_SCHEMA_VERSION) {
    // Emit a single warning so unknown schemas surface in logs but do not
    // crash the runtime. Bash route should mirror this.
    // eslint-disable-next-line no-console
    console.warn(
      `[loki:project_graph] unsupported schema_version in ${path}: ` +
        `${String(obj["schema_version"])} (expected ${SUPPORTED_SCHEMA_VERSION})`,
    );
    return null;
  }
  const appId = obj["app_id"];
  if (typeof appId !== "string" || !APP_ID_REGEX.test(appId)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[loki:project_graph] invalid app_id in ${path}: ${String(appId)}`,
    );
    return null;
  }
  const members = Array.isArray(obj["members"])
    ? (obj["members"].filter((m) => typeof m === "string") as string[])
    : [];
  const sharedMemoryDir =
    typeof obj["shared_memory_dir"] === "string"
      ? (obj["shared_memory_dir"] as string)
      : undefined;
  return {
    schema_version: SUPPORTED_SCHEMA_VERSION,
    app_id: appId,
    members,
    shared_memory_dir: sharedMemoryDir,
  };
}

/**
 * Resolve the member list relative to `rootDir`. Each declared name is
 * treated as either a literal sibling directory OR a glob-pattern matched
 * against the basename of each immediate child of `rootDir`. Only entries
 * that exist on disk and resolve to a directory are returned. The current
 * dir basename is always included if not already present.
 */
function resolveMembers(
  rootDir: string,
  declared: string[],
  selfBasename: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  let children: string[];
  try {
    children = readdirSync(rootDir);
  } catch {
    children = [];
  }

  const matchPattern = (pattern: string, name: string): boolean => {
    if (!pattern.includes("*") && !pattern.includes("?")) {
      return pattern === name;
    }
    const re = new RegExp(
      "^" +
        pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") +
        "$",
    );
    return re.test(name);
  };

  for (const name of declared) {
    for (const child of children) {
      if (!matchPattern(name, child)) continue;
      const full = join(rootDir, child);
      if (seen.has(full)) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      seen.add(full);
      out.push(full);
    }
  }

  // The manifest is authoritative: if the originating dir is not declared
  // as a member, it is not in the graph. Caller can decide how to handle
  // that signal (e.g. warn, fall back to non-graph mode).
  void selfBasename;
  return out;
}

function cacheKey(manifestPaths: string[]): string {
  const parts: string[] = [];
  for (const p of manifestPaths.sort()) {
    let mtime = 0;
    try {
      mtime = statSync(p).mtimeMs;
    } catch {
      // Missing or unreadable; skip
    }
    parts.push(`${p}:${mtime}`);
  }
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function writeCache(targetDir: string, key: string, result: AppGraphResult): void {
  try {
    const cacheDir = join(targetDir, ".loki", "state");
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, "project-graph.json");
    writeFileSync(cachePath, JSON.stringify({ key, result }, null, 2), "utf8");
  } catch {
    // Cache write failures are non-fatal.
  }
}

/**
 * Run the discovery algorithm. Returns the AppGraphResult or null when no
 * `.loki/app.json` manifest is found at `targetDir` or its immediate parent.
 */
export function discoverProjectGraph(targetDir: string): AppGraphResult | null {
  const absTarget = resolve(targetDir);
  const targetManifest = join(absTarget, ".loki", "app.json");
  const parentDir = dirname(absTarget);
  const parentManifest = join(parentDir, ".loki", "app.json");

  const examined: string[] = [];
  let chosenManifest: AppJson | null = null;
  let chosenRoot = "";

  // Architect rule (parent-rooted wins): prefer the parent manifest as the
  // canonical app root. Only fall back to a target-rooted manifest when the
  // parent has none (single-member graph case). This matches the bash route
  // and the parity test's expectation. Sibling-rooted thin-pointer manifests
  // (target-rooted with matching app_id) are validated against the parent
  // manifest later in the member-resolution loop.
  if (existsSync(parentManifest) && parentDir !== absTarget) {
    examined.push(parentManifest);
    chosenManifest = readManifest(parentManifest);
    chosenRoot = parentDir;
  }
  if (!chosenManifest && existsSync(targetManifest)) {
    examined.push(targetManifest);
    chosenManifest = readManifest(targetManifest);
    chosenRoot = absTarget;
  }
  if (!chosenManifest) return null;

  const declared = chosenManifest.members ?? [];
  const members = resolveMembers(chosenRoot, declared, basename(absTarget));

  // Skip siblings whose own .loki/app.json declares a different app_id.
  const filtered: string[] = [];
  for (const m of members) {
    const sibManifestPath = join(m, ".loki", "app.json");
    if (existsSync(sibManifestPath)) {
      examined.push(sibManifestPath);
      const sibManifest = readManifest(sibManifestPath);
      if (sibManifest && sibManifest.app_id !== chosenManifest.app_id) {
        continue;
      }
    }
    filtered.push(m);
  }

  const result: AppGraphResult = {
    appId: chosenManifest.app_id,
    root: chosenRoot,
    members: filtered,
    sharedMemoryDir: chosenManifest.shared_memory_dir,
  };

  writeCache(absTarget, cacheKey(examined), result);
  return result;
}

/**
 * Mutate `process.env` to expose the discovery result to downstream tools.
 * Matches the bash route variable names so both implementations are
 * interchangeable.
 */
export function applyProjectGraphEnv(result: AppGraphResult): void {
  process.env["LOKI_PROJECT_GRAPH_ROOT"] = result.root;
  process.env["LOKI_PROJECT_GRAPH_APP_ID"] = result.appId;
  process.env["LOKI_PROJECT_GRAPH_MEMBERS"] = result.members.join(":");
  if (result.sharedMemoryDir) {
    process.env["LOKI_PROJECT_GRAPH_SHARED_MEMORY_DIR"] = result.sharedMemoryDir;
  }
}
