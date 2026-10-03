// loki-ts/src/project_model/gather.ts -- EL-W1-01 (L0): the harness only GATHERS candidate file
// contents for the discovery prompt, by a bounded generic walk. It never decides which file is a
// manifest or what a repo is: files are ranked by depth and size alone, and the model reads the rest.
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { listRepoFiles } from "../engine10/repomap.ts";

export const GATHER_CAPS = {
  maxListFiles: 20_000, // tracked files considered at all
  maxDepth: 3, // path components; deeper files are listed by the model's own tools, never inlined
  maxFileBytes: 16 * 1024, // per inlined file
  maxFiles: 60, // inlined files
  maxTotalBytes: 96 * 1024, // inlined bytes
  maxTreeLines: 300, // paths in the tree listing
  maxHashBytes: 16 * 1024 * 1024, // per fingerprint file
} as const;

export interface Gathered {
  tree: string[];
  files: { path: string; text: string }[];
  dirs: string[]; // every directory (within maxDepth) holding a tracked file, sorted
}

const depthOf = (p: string): number => p.split("/").length;

function looksText(abs: string): boolean {
  let fd = -1;
  try {
    fd = openSync(abs, "r");
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, 512, 0);
    return !buf.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

export function gather(repoDir: string): Gathered {
  const shallow = listRepoFiles(repoDir, GATHER_CAPS.maxListFiles).files.filter((p) => depthOf(p) <= GATHER_CAPS.maxDepth);
  const sized: { path: string; size: number }[] = [];
  for (const path of shallow) {
    try {
      const st = statSync(join(repoDir, path));
      if (st.isFile() && st.size <= GATHER_CAPS.maxFileBytes) sized.push({ path, size: st.size });
    } catch { /* unreadable: skip */ }
  }
  sized.sort((a, b) => depthOf(a.path) - depthOf(b.path) || a.size - b.size || a.path.localeCompare(b.path));
  const files: Gathered["files"] = [];
  let total = 0;
  for (const { path, size } of sized) {
    if (files.length >= GATHER_CAPS.maxFiles || total + size > GATHER_CAPS.maxTotalBytes) break;
    if (size === 0 || !looksText(join(repoDir, path))) continue;
    files.push({ path, text: readFileSync(join(repoDir, path), "utf8") });
    total += size;
  }
  const dirs = [...new Set(shallow.map((p) => dirname(p)))].sort();
  return { tree: [...shallow].sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b)).slice(0, GATHER_CAPS.maxTreeLines), files, dirs };
}

/** Cache key: the content of the model-named manifest and lockfiles, plus the set of directories
 *  (a new package arrives as a new directory). Any edit to a fingerprint file changes it. */
export function computeKey(repoDir: string, fingerprintFiles: string[], dirs: string[]): string {
  const h = createHash("sha256");
  for (const f of [...fingerprintFiles].sort()) {
    h.update(`file:${f}\n`);
    try {
      const abs = join(repoDir, f);
      h.update(statSync(abs).size <= GATHER_CAPS.maxHashBytes ? readFileSync(abs) : `too-large:${statSync(abs).size}`);
    } catch {
      h.update("missing");
    }
    h.update("\n");
  }
  for (const d of dirs) h.update(`dir:${d}\n`);
  return h.digest("hex");
}

/** Directories (within maxDepth) holding a tracked file; the cheap half of gather(), for cache checks. */
export function shallowDirs(repoDir: string): string[] {
  const shallow = listRepoFiles(repoDir, GATHER_CAPS.maxListFiles).files.filter((p) => depthOf(p) <= GATHER_CAPS.maxDepth);
  return [...new Set(shallow.map((p) => dirname(p)))].sort();
}
