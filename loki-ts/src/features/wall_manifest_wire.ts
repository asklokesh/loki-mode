// D77 (W1-S2): wires the Wall manifest to a git base tree. Reads only blobs of the intake tree (never the
// worktree, diff or .loki/), builds wall_manifest.txt, and returns its sha256. Any failure returns null so
// the Wall behaves as if the flag were off (fail closed).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { buildWallManifest, type ManifestFile } from "./wall_manifest.ts";

export const wallManifestEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => ["1", "on", "true", "yes"].includes((env.LOKI_E10_WALL_MANIFEST ?? "").toLowerCase());
const CONFIG = /^(package\.json|bunfig\.toml|(vitest|jest)\.config\.[cm]?[jt]s|pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|go\.mod|Cargo\.toml)$/;
const TESTISH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
const SOURCE = /\.(py|[cm]?[jt]sx?)$/;
const MAX_BLOB = 200_000, MAX_FILES = 300, MAX_NAMED = 5;
const git = (repoDir: string, args: string[], input?: string): Buffer | null => {
  const r = spawnSync("git", ["-C", repoDir, ...args], { input, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
  return r.error || r.status !== 0 ? null : r.stdout;
};

export function wallManifestFor(repoDir: string, tree: string | undefined, task: string, env: NodeJS.ProcessEnv = process.env): { text: string; sha256: string } | null {
  if (!wallManifestEnabled(env)) return null;
  try {
    if (!tree || !/^[0-9a-f]{40,64}$/.test(tree)) return null;
    const ls = git(repoDir, ["ls-tree", "-r", "--name-only", "-z", tree]);
    if (!ls) return null;
    const paths = ls.toString("utf8").split("\0").filter(Boolean), low = task.toLowerCase();
    const named = paths.filter((p) => SOURCE.test(p) && !TESTISH.test(p) && low.includes(basename(p).toLowerCase())).slice(0, MAX_NAMED);
    const want = [...new Set([...paths.filter((p) => CONFIG.test(p)), ...paths.filter((p) => TESTISH.test(p)).slice(0, MAX_FILES), ...named])];
    const cat = git(repoDir, ["cat-file", "--batch"], want.map((p) => `${tree}:${p}`).join("\n") + "\n");
    if (!cat) return null;
    const files: ManifestFile[] = [];
    for (let at = 0, i = 0; i < want.length; i++) {
      const nl = cat.indexOf(10, at);
      if (nl < 0) return null;
      const head = cat.subarray(at, nl).toString("utf8").split(" ");
      if (head[1] !== "blob") { at = nl + 1; continue; }
      const size = Number(head[2]), start = nl + 1;
      if (!Number.isInteger(size)) return null;
      if (size <= MAX_BLOB) files.push({ path: want[i]!, content: cat.subarray(start, start + size).toString("utf8") });
      at = start + size + 1;
    }
    const text = buildWallManifest(files, named);
    return { text, sha256: createHash("sha256").update(text).digest("hex") };
  } catch { return null; }
}
