// FC-COMMIT-STAGES-USER-UNTRACKED: lives outside e10ext to keep that tree under its line cap (precedent: features/crash_work.ts).
import { lstatSync } from "node:fs"; import { join } from "node:path";
import { blob } from "../e10ext/preexisting_dirty.ts";

/** FC-COMMIT-STAGES-USER-UNTRACKED: intake-untracked files the run left exactly as they were (bytes and mode for a snapshotted file, size/mtime/ctime for one that was too big to snapshot). */
export function untouchedUntracked(repoDir: string, recorded: unknown, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!recorded || typeof recorded !== "object") return [];
  return Object.entries(recorded as Record<string, unknown>).filter(([p, v]) => {
    if (typeof v !== "string") return false;
    try {
      const st = lstatSync(join(repoDir, p));
      if (v.startsWith("!")) return v === `!${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
      const [sha, mode] = v.split(" ");
      return st.isFile() && blob(repoDir, p, env) === sha && (st.mode & 0o777).toString(8) === mode;
    } catch { return false; }
  }).map(([p]) => p);
}
