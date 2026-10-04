// loki-ts/src/project_model/gather.ts -- EL-W1-01 (L0): the harness only GATHERS candidate file
// contents for the discovery prompt, by a bounded generic walk. It never decides which file is a
// manifest or what a repo is: files are ranked by depth and size alone, and the model reads the rest.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkFingerprint } from "./schema.ts";

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
}

const depthOf = (p: string): number => p.split("/").length;

/** Tracked paths within maxDepth (NUL-separated, so no path is ever quoted or split), never throws. */
function listShallow(repoDir: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: repoDir, encoding: "utf8", env: process.env, maxBuffer: 256 * 1024 * 1024 });
    return out.split("\0").filter((p) => p !== "").slice(0, GATHER_CAPS.maxListFiles).filter((p) => depthOf(p) <= GATHER_CAPS.maxDepth);
  } catch {
    return [];
  }
}

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
  const shallow = listShallow(repoDir);
  const sized: { path: string; size: number }[] = [];
  for (const path of shallow) {
    try {
      const st = lstatSync(join(repoDir, path)); // lstat: a symlink is never inlined, so no out-of-repo content reaches the prompt
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
  return { tree: [...shallow].sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b)).slice(0, GATHER_CAPS.maxTreeLines), files };
}

/** Directories (within maxDepth) holding a tracked file; a new package arrives as a new directory. */
export function shallowDirs(repoDir: string): string[] {
  return [...new Set(listShallow(repoDir).map((p) => dirname(p)))].sort();
}

/** Cache key: the content of the fingerprint files plus the shallow directory set. A fingerprint
 *  that is not a regular file inside the repo is never opened (no FIFO or device can block a read). */
/** Bumped when the model shape grows (rev 2: dependsOn and install), so a cached older model is rediscovered once. */
export const MODEL_REV = "model-rev:2";
export function computeKey(repoDir: string, fingerprintFiles: string[], dirs: string[]): string {
  const h = createHash("sha256");
  h.update(`${MODEL_REV}\n`);
  for (const f of [...fingerprintFiles].sort()) {
    h.update(`file:${f}\n`);
    try {
      if (checkFingerprint(repoDir, f) !== null) h.update("invalid");
      else {
        const abs = join(repoDir, f);
        const size = lstatSync(abs).size;
        h.update(size <= GATHER_CAPS.maxHashBytes ? readFileSync(abs) : `too-large:${size}`);
      }
    } catch {
      h.update("missing");
    }
    h.update("\n");
  }
  for (const d of dirs) h.update(`dir:${d}\n`);
  return h.digest("hex");
}
