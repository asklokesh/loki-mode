// Producer fingerprint the engine10 repomap/testmap cache keys bind to. Moved out of engine10/cache.ts to keep the core under its line cap.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

/** sha256 over the relative path and bytes of every .ts file under `root`, in sorted order. Hashing the whole tree (not a
 *  hand-picked builder list) means any code the builders import changes the key too. */
export function sourceFingerprint(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); }
      else if (e.isFile() && e.name.endsWith(".ts")) h.update(`${relative(root, p)}\0`).update(readFileSync(p)).update("\0");
    }
  };
  walk(root);
  return h.digest("hex");
}
declare global { var __LOKI_PRODUCER_FP__: string | undefined; }
let producerFp: string | null = null;
/** The producer fingerprint stored maps are bound to. A bundle gets it generated in by scripts/build.ts (the bundle has no
 *  source path to hash); a source run hashes src/ itself. When neither is possible it is a per-process random value, so
 *  nothing stored can ever match: a cache that cannot name its producer misses, it never serves an unbound map. */
export function computeProducerFingerprint(root: string = resolve(import.meta.dir, ".."), injected: unknown = globalThis.__LOKI_PRODUCER_FP__): string {
  if (typeof injected === "string" && /^[0-9a-f]{64}$/.test(injected)) return injected;
  try { return sourceFingerprint(root); } catch { return createHash("sha256").update(`unbound:${process.pid}:${Date.now()}:${Math.random()}`).digest("hex"); }
}
export function producerFingerprint(): string {
  return (producerFp ??= computeProducerFingerprint());
}
