// P12-36: outbox for external side effects (PR create, comment post, deploy).
// Each effect is recorded "pending" under an idempotency key BEFORE the post and "done" (with the
// result) AFTER it. A kill between post and record leaves "pending"; on replay `probe` asks the
// remote whether the keyed effect already landed and, if so, adopts it instead of posting again.
// With no probe, replay re-posts, so the poster itself must tolerate duplicates (pr.ts push-pr
// reuses an existing PR for the branch).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic.ts";

/** Stable across resume: same kind, run and discriminator always give the same key. */
export function idempotencyKey(kind: string, runId: string, discriminator: string): string {
  return createHash("sha256").update(`${kind}\0${runId}\0${discriminator}`).digest("hex").slice(0, 32);
}

type Rec<T> = { key: string; state: "pending" | "done"; result?: T };

export function runOnce<T>(a: { dir: string; key: string; post: (key: string) => T; probe?: (key: string) => T | null; afterPost?: () => void; keep?: (r: T) => boolean }): T {
  mkdirSync(a.dir, { recursive: true });
  const file = join(a.dir, `outbox-${a.key}.json`);
  let rec: Rec<T> | null = null;
  if (existsSync(file)) { try { rec = JSON.parse(readFileSync(file, "utf8")) as Rec<T>; } catch { rec = null; } }
  if (rec?.state === "done") return rec.result as T;
  if (rec?.state === "pending" && a.probe) {
    const found = a.probe(a.key);
    if (found !== null) { atomicWriteJson(file, { key: a.key, state: "done", result: found }); return found; }
  }
  atomicWriteJson(file, { key: a.key, state: "pending" });
  const result = a.post(a.key);
  a.afterPost?.();
  if (a.keep?.(result) !== false) atomicWriteJson(file, { key: a.key, state: "done", result }); // keep=false: a failed post stays pending so replay retries
  return result;
}
