#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-run --allow-env
/**
 * Minimal HTTP API for loki-mode
 * Zero dependencies - uses only Deno built-ins
 * Usage: deno run --allow-all api-examples/deno-api.ts
 */

const PORT = parseInt(Deno.env.get("LOKI_DASHBOARD_PORT") || "57374");
const HOME = Deno.env.get("HOME") || "/tmp";
const LOKI_DIR = Deno.env.get("LOKI_DIR") || `${HOME}/.loki`;
const STATE_DIR = `${LOKI_DIR}/state`;

// Ensure state directory exists
await Deno.mkdir(STATE_DIR, { recursive: true });

// SSE clients
const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();

// Utility: read file safely
async function readFile(path: string): Promise<string> {
  try {
    return (await Deno.readTextFile(path)).trim();
  } catch {
    return "";
  }
}

// Utility: check if process is running
function isRunning(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT"); // Signal 0 equivalent
    return true;
  } catch {
    return false;
  }
}

// Get current status
async function getStatus(): Promise<Record<string, unknown>> {
  const pidStr = await readFile(`${STATE_DIR}/session.pid`);
  let state = "stopped";

  if (pidStr) {
    const pid = parseInt(pidStr);
    if (!isNaN(pid) && isRunning(pid)) {
      try {
        await Deno.stat(`${STATE_DIR}/paused`);
        state = "paused";
      } catch {
        state = "running";
      }
    }
  }

  return {
    state,
    project: await readFile(`${STATE_DIR}/current_project`),
    task: await readFile(`${STATE_DIR}/current_task`),
    provider: (await readFile(`${STATE_DIR}/provider`)) || "claude",
    timestamp: new Date().toISOString(),
  };
}

// Broadcast to SSE clients
function broadcast(data: Record<string, unknown>) {
  const message = new TextEncoder().encode(
    `data: ${JSON.stringify(data)}\n\n`
  );
  for (const controller of sseClients) {
    try {
      controller.enqueue(message);
    } catch {
      sseClients.delete(controller);
    }
  }
}

// JSON response helper
function json(
  data: Record<string, unknown>,
  status = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Request handler
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const path = url.pathname;

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  // Routes
  if (method === "GET" && path === "/health") {
    return json({ status: "ok" });
  }

  if (method === "GET" && path === "/status") {
    return json(await getStatus());
  }

  if (method === "GET" && path === "/events") {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        sseClients.add(controller);

        // Send initial status
        const status = await getStatus();
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(status)}\n\n`)
        );

        // Periodic updates
        const interval = setInterval(async () => {
          try {
            const status = await getStatus();
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(status)}\n\n`)
            );
          } catch {
            clearInterval(interval);
            sseClients.delete(controller);
          }
        }, 5000);
      },
      cancel(controller) {
        sseClients.delete(controller);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (method === "GET" && path === "/logs") {
    const lines = parseInt(url.searchParams.get("lines") || "50");
    const logFile = `${LOKI_DIR}/logs/session.log`;

    try {
      const content = await Deno.readTextFile(logFile);
      const allLines = content.trim().split("\n");
      const logs = allLines.slice(-lines);
      return json({ logs });
    } catch {
      return json({ logs: [] });
    }
  }

  if (method === "POST" && path === "/start") {
    let body: Record<string, string> = {};
    try {
      body = await req.json();
    } catch {
      // empty body is fine
    }

    const prd = body.prd || "";
    const provider = body.provider || "claude";
    const runScript = `${Deno.cwd()}/autonomy/run.sh`;

    try {
      await Deno.stat(runScript);
    } catch {
      return json({ error: "run.sh not found" }, 500);
    }

    const args = ["--provider", provider];
    if (prd) args.push(prd);

    const command = new Deno.Command(runScript, {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    });
    const child = command.spawn();

    await Deno.writeTextFile(`${STATE_DIR}/session.pid`, String(child.pid));
    await Deno.writeTextFile(`${STATE_DIR}/provider`, provider);

    broadcast({ state: "running", provider });
    return json({ started: true, pid: child.pid });
  }

  if (method === "POST" && path === "/stop") {
    const pidStr = await readFile(`${STATE_DIR}/session.pid`);

    if (pidStr) {
      const pid = parseInt(pidStr);
      if (!isNaN(pid) && isRunning(pid)) {
        Deno.kill(pid, "SIGTERM");
        broadcast({ state: "stopped" });
        return json({ stopped: true });
      }
    }
    return json({ error: "no session running" }, 404);
  }

  if (method === "POST" && path === "/pause") {
    await Deno.writeTextFile(`${STATE_DIR}/paused`, "1");
    broadcast(await getStatus());
    return json({ paused: true });
  }

  if (method === "POST" && path === "/resume") {
    try {
      await Deno.remove(`${STATE_DIR}/paused`);
    } catch {
      // file might not exist
    }
    broadcast(await getStatus());
    return json({ resumed: true });
  }

  return json({ error: "not found" }, 404);
}

// Start server
console.log(`Loki API listening on http://localhost:${PORT}`);
console.log("Endpoints:");
console.log("  GET  /health  - Health check");
console.log("  GET  /status  - Current status");
console.log("  GET  /events  - SSE stream");
console.log("  GET  /logs    - Recent logs");
console.log("  POST /start   - Start session");
console.log("  POST /stop    - Stop session");
console.log("  POST /pause   - Pause session");
console.log("  POST /resume  - Resume session");

Deno.serve({ port: PORT }, handler);
