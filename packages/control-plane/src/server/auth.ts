// Control Plane auth: bearer token on /v1, Host allowlist on loopback (DNS rebinding), bind refusal without a token.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";

const LOOPBACK_BINDS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True when a Host header value (optional port) names this machine's loopback. Strict: nothing may follow the name or port. */
export function isLoopbackHost(host: string | undefined | null): boolean {
  return !!host && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
}

/** True when the real socket peer (not the spoofable Host header) is loopback. An unknown peer fails closed. */
export function peerIsLoopback(c: Context): boolean {
  const ip = (c.env as { requestIP?: (r: Request) => { address?: string } | null } | undefined)?.requestIP?.(c.req.raw)?.address;
  return typeof ip === "string" && /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(ip);
}

/** Constant-time check of an Authorization header against the token. Hashing first makes the compare length-safe. */
export function tokenMatches(header: string | undefined | null, token: string): boolean {
  const m = /^Bearer (.+)$/i.exec(header ?? "");
  if (!m) return false;
  const a = createHash("sha256").update(m[1] ?? "").digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/** Message to print before exiting 2 when the env asks for a non-loopback bind with no token, else null. */
export function bindRefusal(env: Record<string, string | undefined>): string | null {
  const host = env.LOKI_CONTROL_HOST;
  if (!host || LOOPBACK_BINDS.has(host.toLowerCase())) return null;
  if (env.LOKI_CONTROL_TOKEN || env.LOKI_CONTROL_ALLOW_INSECURE_BIND === "1") return null;
  return `loki-control: refusing to listen on ${host} without LOKI_CONTROL_TOKEN. Set LOKI_CONTROL_TOKEN, or LOKI_CONTROL_ALLOW_INSECURE_BIND=1 to accept an unauthenticated non-loopback bind.`;
}

/** Stderr warning when ALLOW_INSECURE_BIND is what permits a non-loopback bind with no token, else null. Never includes a token. */
export function insecureBindWarning(env: Record<string, string | undefined>): string | null {
  const host = env.LOKI_CONTROL_HOST;
  if (!host || LOOPBACK_BINDS.has(host.toLowerCase())) return null;
  if (env.LOKI_CONTROL_TOKEN || env.LOKI_CONTROL_ALLOW_INSECURE_BIND !== "1") return null;
  return `loki-control: WARNING listening on ${host} with no LOKI_CONTROL_TOKEN (LOKI_CONTROL_ALLOW_INSECURE_BIND=1). Anyone who can reach this port can read and write runs.`;
}

/** Host allowlist guard (apply on "*"; /health and /ready still need the Host check on loopback). */
export function hostGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (!isLoopbackHost(c.req.header("host"))) return c.json({ error: "host not allowed" }, 403);
    await next();
  };
}

/** Bearer guard. Register it with app.use("/v1/*", ...) so Hono's decoded route matching decides coverage, never the raw URL. */
export function tokenGuard(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (!tokenMatches(c.req.header("authorization"), token)) return c.json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    await next();
  };
}
