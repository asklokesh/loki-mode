// Control Plane auth: bearer token on /v1, Host allowlist on loopback (DNS rebinding), bind refusal without a token.
import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const LOOPBACK_BINDS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True when a Host header value (optional port) names this machine's loopback. */
export function isLoopbackHost(host: string | undefined | null): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : (h.split(":")[0] ?? "");
  return LOOPBACK_NAMES.has(name);
}

/** Constant-time check of an Authorization header against the token. Hashing first makes the compare length-safe. */
export function tokenMatches(header: string | undefined | null, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
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

/** Host allowlist (when loopbackOnly) then bearer check on /v1/* (when a token is set). /health and /ready need no token (the Host check still applies on loopback). */
export function authGuard(opts: { token?: string; loopbackOnly?: boolean }): MiddlewareHandler {
  return async (c, next) => {
    if (opts.loopbackOnly && !isLoopbackHost(c.req.header("host"))) return c.json({ error: "host not allowed" }, 403);
    if (opts.token && new URL(c.req.url).pathname.startsWith("/v1/") && !tokenMatches(c.req.header("authorization"), opts.token)) {
      return c.json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    }
    await next();
  };
}
