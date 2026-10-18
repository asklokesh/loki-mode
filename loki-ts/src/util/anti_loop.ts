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
