// Entry for `loki control serve` (bundled to dist/server.js). Config comes from env: PORT, LOKI_CONTROL_DB.
// Binds loopback unless LOKI_CONTROL_HOST is set (the container image sets 0.0.0.0). LOKI_CONTROL_PORT_FALLBACK=1 (set for the default port, never for an explicit --port)
// retries on any free port when PORT is taken; the URL printed below is always the real one.
import { createApp } from "./app.ts";

const { app } = createApp({ dbPath: process.env.LOKI_CONTROL_DB ?? "control.db" });
const serve = (port: number) => Bun.serve({ port, hostname: process.env.LOKI_CONTROL_HOST || "127.0.0.1", fetch: app.fetch });
let s: ReturnType<typeof serve>;
try {
  s = serve(Number(process.env.PORT ?? 0));
} catch (e) {
  if ((e as { code?: string }).code !== "EADDRINUSE" || process.env.LOKI_CONTROL_PORT_FALLBACK !== "1") throw e;
  s = serve(0);
}
console.log(`loki-control listening on ${s.url}`);
