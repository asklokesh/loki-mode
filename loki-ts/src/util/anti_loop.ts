// Identical-action stall. The verify loop already stops on the same failure signature
// three times (machine.ts). This catches a fix round that left the tree byte-identical,
// so the next verify (same tree, same checks) is not spent on a no-op.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeGit } from "./safe_git.ts";

const EXCLUDE = [":(exclude).loki", ":(exclude).loki/**"];
const MAX_BUFFER = 64 * 1024 * 1024; // a diff past this throws, the fingerprint is null, and no repeat is ever claimed

/** sha256 of the working tree against the run base: the full binary diff plus every untracked file's bytes. Null when git fails. */
export function treeFingerprint(repoDir: string, baseSha: string): string | null {
  try {
    const h = createHash("sha256");
    h.update(safeGit(repoDir, ["diff", "--binary", baseSha, "--", ".", ...EXCLUDE], { maxBuffer: MAX_BUFFER }));
    const fresh = safeGit(repoDir, ["ls-files", "-z", "--others", "--exclude-standard"], { maxBuffer: MAX_BUFFER }).split("\0")
      .filter((f) => f && f !== ".loki" && !f.startsWith(".loki/")).sort();
    for (const f of fresh) {
      h.update(`\0${f}\0`);
      const path = join(repoDir, f);
      if (statSync(path).size > MAX_BUFFER) return null; // a huge artifact is not worth reading twice per round; null never claims a loop
      h.update(readFileSync(path)); // an unreadable file throws: null, never a stable sentinel that could fake "unchanged"
    }
    return h.digest("hex");
  } catch { return null; }
}

/** True when a completed, not-killed fix round left the tree exactly as it found it. A missing fingerprint is never a loop. */
export function repeatedNoopFix(fix: Record<string, unknown> | undefined): boolean {
  if (!fix || fix.killed === true) return false;
  const a = fix.tree_before, b = fix.tree_after;
  return typeof a === "string" && a.length > 0 && a === b;
}

export function untrackedList(cwd: string | undefined): string { // NUL-separated; read once per heartbeat tick and shared by diffShortstat and diffSignature (TEN-SPEED-21)
  try { return safeGit(cwd ?? process.cwd(), ["ls-files", "-z", "--others", "--exclude-standard", "--", ".", ":(exclude).loki"], { timeout: 10_000 }); } catch { return ""; }
}
export function diffShortstat(cwd: string | undefined, untrackedRaw: string = untrackedList(cwd)): { files: number; insertions: number; deletions: number } {
  const dir = cwd ?? process.cwd(), o = { timeout: 10_000 }; // P12-12: bounded, since the heartbeat runs this synchronously every 30s
  let out = "";
  try { out = safeGit(dir, ["diff", "--shortstat", "--relative"], o).trim(); } catch { /* unreadable: counts stay zero */ } // --relative: same cwd scope as the name lists and ls-files, so the signature tracks only this run's subtree
  const untracked = untrackedRaw.split("\0").filter(Boolean).length; // --shortstat misses untracked files: count them (without reading content) so an add-only stage is not zero change
  const files = /(\d+) files? changed/.exec(out), ins = /(\d+) insertions?\(\+\)/.exec(out), del = /(\d+) deletions?\(-\)/.exec(out);
  return { files: (files ? Number(files[1]) : 0) + untracked, insertions: ins ? Number(ins[1]) : 0, deletions: del ? Number(del[1]) : 0 };
}
/** Watchdog signature: shortstat counts plus a cheap content signal (size and mtime of every changed file), so in-place growth of one already-modified file moves it. */
export function diffSignature(cwd: string | undefined, stat?: { files: number; insertions: number; deletions: number }, untrackedRaw: string = untrackedList(cwd)): string {
  stat ??= diffShortstat(cwd, untrackedRaw);
  const dir = cwd ?? process.cwd(), o = { timeout: 10_000 };
  let bytes = 0, newest = 0;
  const add = (list: string): void => { // each list gets its own 1000-file budget, so a huge tracked list never starves the untracked one
    let n = 0;
    for (const f of list.split("\0").filter(Boolean)) {
      if (n++ >= 1000) return; // bound the stat work on huge trees
      try { const st = statSync(join(dir, f)); bytes += st.size; if (st.mtimeMs > newest) newest = st.mtimeMs; } catch { /* deleted: counted by shortstat */ }
    }
  };
  try { add(safeGit(dir, ["diff", "--name-only", "--relative", "-z"], o)); } catch { /* unreadable: counts only */ } // --relative: cwd-relative like ls-files --others, so join(dir, f) holds from a repo subdirectory
  add(untrackedRaw);
  return `${JSON.stringify(stat)}|${bytes}|${newest}`;
}
