// Tiny stand-in for CP-01's POST /v1/ingest: idempotent on source:run:seq, 409 on a changed hash. Records every posted body.
import { createHash } from "node:crypto";

export function stubServer() {
  const events = new Map<string, string>(); // id -> line sha256
  const bodies: string[] = [];
  let posts = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/ingest") return new Response("nope", { status: 404 });
      const text = await req.text();
      posts++;
      bodies.push(text);
      const b = JSON.parse(text) as { source: string; run_id: string; events: { seq: number }[] };
      let accepted = 0, duplicate = 0, conflict = 0;
      for (const e of b.events) {
        const id = `${b.source}:${b.run_id}:${e.seq}`, h = createHash("sha256").update(JSON.stringify(e)).digest("hex");
        const prev = events.get(id);
        if (prev === undefined) { events.set(id, h); accepted++; } else if (prev === h) duplicate++; else conflict++;
      }
      return Response.json({ accepted, duplicate, conflict }, { status: conflict ? 409 : 200 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, events, bodies, posts: () => posts, stop: () => server.stop(true) };
}
