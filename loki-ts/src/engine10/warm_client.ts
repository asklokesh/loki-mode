// loki-ts/src/engine10/warm_client.ts -- D61 slice 6: CLI side of the warm engine. Tries the unix
// socket for a short deadline and returns null on any problem (no daemon, timeout, bad reply), in
// which case the caller runs the cold path exactly as before. Behind LOKI_SPEED=1.
import { createConnection } from "node:net";
import { speedEnabled, warmSocketPath, type WarmReply } from "./warm.ts";

export const WARM_TRY_MS = 50;

/** One request/response over the socket within `timeoutMs`; null on every failure. */
export function warmRequest(
  req: Record<string, unknown>,
  timeoutMs: number = WARM_TRY_MS,
  path: string = warmSocketPath(),
): Promise<WarmReply | null> {
  return new Promise((done) => {
    let settled = false;
    let buf = "";
    const sock = createConnection(path);
    const finish = (v: WarmReply | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      done(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on("error", () => finish(null));
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const r = JSON.parse(buf.slice(0, nl)) as WarmReply;
        finish(r && r.ok ? r : null);
      } catch {
        finish(null);
      }
    });
  });
}

/** Formats the user-facing line, e.g. "warm in 0.1s". */
export function warmLine(seconds: number): string {
  return `warm in ${seconds.toFixed(1)}s`;
}

/** Cheap liveness probe within the deadline, then (if alive) the maps request with a longer
 *  budget since a first build can take seconds. Returns null when the flag is off or no daemon
 *  answers within WARM_TRY_MS; the caller then proceeds cold with identical events. */
export async function tryWarm(
  repoDir: string,
  opts: { path?: string; pingMs?: number; getMs?: number; write?: (s: string) => void } = {},
): Promise<WarmReply | null> {
  if (!speedEnabled()) return null;
  const path = opts.path ?? warmSocketPath();
  if (!(await warmRequest({ op: "ping" }, opts.pingMs ?? WARM_TRY_MS, path))) return null;
  const t0 = Date.now();
  const r = await warmRequest({ op: "get", repoDir }, opts.getMs ?? 5000, path);
  if (!r) return null;
  (opts.write ?? ((s: string) => process.stderr.write(s)))(warmLine((Date.now() - t0) / 1000) + "\n");
  return r;
}
