// D77 (W1-S2): wires the Wall manifest to a git base tree. Reads only blobs of the intake tree (never the
// worktree, diff or .loki/), builds wall_manifest.txt, and returns its sha256. Any failure or misalignment returns null so the Wall behaves as if the flag were off (fail closed).
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { buildWallManifest, type ManifestFile } from "./wall_manifest.ts";
import { safeGitSpawn } from "../util/safe_git.ts";

export const wallManifestEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => ["1", "on", "true", "yes"].includes((env.LOKI_E10_WALL_MANIFEST ?? "").toLowerCase());
const CONFIG = /^(package\.json|bunfig\.toml|(vitest|jest)\.config\.[cm]?[jt]s|pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|go\.mod|Cargo\.toml)$/;
const TESTISH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
const SOURCE = /\.(py|[cm]?[jt]sx?)$/;
const MAX_BLOB = 200_000, MAX_FILES = 300, MAX_NAMED = 5, GIT_TIMEOUT_MS = 5_000;
// --no-replace-objects: a replace ref must never change what the sealed tree read returns.
const git = (repoDir: string, args: string[], input?: string): Buffer | null => {
  const r = safeGitSpawn(repoDir, ["--no-replace-objects", ...args], { input, maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } });
  return r.error || r.status !== 0 ? null : r.stdout;
};

interface Entry { path: string; sha: string }
// Regular blobs of the tree within the size cap. A path that cannot round-trip (control characters, a newline,
// invalid UTF-8) is dropped; objects are fetched by sha, never by a path-derived name.
function blobEntries(ls: Buffer): Entry[] | null {
  const out: Entry[] = [];
  for (const raw of ls.toString("latin1").split("\0")) {
    if (!raw) continue;
    const tab = raw.indexOf("\t"), m = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)$/.exec(raw.slice(0, tab));
    if (tab < 0 || !m) return null;
    if (m[2] !== "blob" || (m[1] !== "100644" && m[1] !== "100755") || m[4] === "-" || Number(m[4]) > MAX_BLOB) continue;
    const bytes = Buffer.from(raw.slice(tab + 1), "latin1"), path = bytes.toString("utf8");
    if (/[\x00-\x1f\x7f]/.test(path) || !Buffer.from(path, "utf8").equals(bytes)) continue;
    out.push({ path, sha: m[3]! });
  }
  return out;
}

export function wallManifestFor(repoDir: string, tree: string | undefined, task: string, env: NodeJS.ProcessEnv = process.env): { text: string; sha256: string } | null {
  if (!wallManifestEnabled(env)) return null;
  try {
    if (!tree || !/^[0-9a-f]{40,64}$/.test(tree)) return null;
    const ls = git(repoDir, ["ls-tree", "-r", "-l", "-z", tree]);
    const all = ls && blobEntries(ls);
    if (!all) return null;
    const low = task.toLowerCase().replace(/\\/g, "/");
    // A file the task names (whole-token basename, path or stem), in any directory, is never a style example. The exclusion
    // set takes EVERY match before any cap; only the signature list is capped, exact basename or path matches first.
    const token = (n: string): boolean => new RegExp(`(?<![A-Za-z0-9_])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`).test(low);
    // A directory module (index, __init__, mod, main) is also named by its directory path ("fix the module in src/user").
    const dirModule = (e: Entry): boolean => /^(index|__init__|mod|main)\.[^.]+$/.test(basename(e.path)) && e.path.includes("/") && token(dirname(e.path));
    const matched = all.filter((e) => SOURCE.test(e.path) && (token(basename(e.path)) || token(e.path) || token(basename(e.path).replace(/\.[^.]*$/, "")) || dirModule(e)));
    // Exact path rank (W1-S2 r8): the full repo path occurs in the task, after "/" or any non-word char and before a non-path char
    // (absolute, ../ and drive prefixes count). An occurrence inside a longer matched path is only a suffix and does not count; longest first.
    const spans = (p: string): Array<[number, number]> => [...low.matchAll(new RegExp(`(?<![A-Za-z0-9_])${p.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "g"))].map((m) => [m.index!, m.index! + m[0].length]);
    const occ = new Map(matched.map((e) => [e, spans(e.path)] as const));
    const exact = (e: Entry): boolean => occ.get(e)!.some(([s, t]) => !matched.some((o) => o !== e && o.path.length > e.path.length && occ.get(o)!.some(([s2, t2]) => s2 <= s && t <= t2)));
    const byPath = matched.filter(exact).sort((a, b) => b.path.length - a.path.length), byBase = matched.filter((e) => !byPath.includes(e) && token(basename(e.path)));
    const named = [...byPath, ...byBase, ...matched.filter((e) => !byPath.includes(e) && !byBase.includes(e))].slice(0, MAX_NAMED); // path, then basename, then stem-only
    const tests = all.filter((e) => TESTISH.test(e.path)).slice(0, MAX_FILES), listed = tests.filter((e) => !SOURCE.test(e.path));
    const want = [...new Set([...all.filter((e) => CONFIG.test(e.path)), ...tests.filter((e) => SOURCE.test(e.path)), ...named])];
    const cat = git(repoDir, ["cat-file", "--batch"], want.map((e) => e.sha).join("\n") + "\n");
    if (!cat) return null;
    const files: ManifestFile[] = [];
    let at = 0;
    for (const e of want) {
      const nl = cat.indexOf(10, at);
      if (nl < 0) return null;
      const head = cat.subarray(at, nl).toString("latin1").split(" "), size = Number(head[2]), start = nl + 1;
      if (head.length !== 3 || head[0] !== e.sha || head[1] !== "blob" || !Number.isInteger(size) || size < 0 || start + size + 1 > cat.length || cat[start + size] !== 10) return null;
      files.push({ path: e.path, content: cat.subarray(start, start + size).toString("utf8") });
      at = start + size + 1;
    }
    if (at !== cat.length) return null;
    // Non-source files under test directories appear in the layout by name only, never with content.
    const text = buildWallManifest([...files, ...listed.map((e) => ({ path: e.path, content: "" }))], named.map((e) => e.path), matched.map((e) => e.path));
    return { text, sha256: createHash("sha256").update(text).digest("hex") };
  } catch { return null; }
}
