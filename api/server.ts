/**
 * Loki Mode API Server
 *
 * HTTP/SSE server for loki-mode remote control and monitoring.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-write --allow-env --allow-run api/server.ts
 *
 * Or via CLI:
 *   loki serve [--port 8420] [--host localhost]
 */

import { stateWatcher } from "./services/state-watcher.ts";
import { corsMiddleware } from "./middleware/cors.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { errorMiddleware } from "./middleware/error.ts";
import { timingMiddleware } from "./middleware/timing.ts";
import { LokiApiError, ErrorCodes } from "./middleware/error.ts";
import { learningCollector } from "./services/learning-collector.ts";

// Import routes
import {
  startSession,
  listSessions,
  getSession,
  stopSession,
  pauseSession,
  resumeSession,
  injectInput,
  deleteSession,
} from "./routes/sessions.ts";
import {
  listTasks,
  getTask,
  listAllTasks,
  getActiveTasks,
  getQueuedTasks,
} from "./routes/tasks.ts";
import {
  streamEvents,
  getEventHistory,
  getEventStats,
} from "./routes/events.ts";
import {
  healthCheck,
  readinessCheck,
  livenessCheck,
  detailedStatus,
} from "./routes/health.ts";
import {
  getMemorySummary,
  getMemoryIndex,
  getMemoryTimeline,
  listEpisodes,
  getEpisode,
  listPatterns,
  getPattern,
  listSkills,
  getSkill,
  retrieveMemories,
  consolidateMemories,
  getTokenEconomics,
  getSuggestions,
  getLearningSuggestions,
} from "./routes/memory.ts";
import {
  getLearningMetrics,
  getLearningTrends,
  getLearningSignals,
  getLatestAggregation,
  triggerAggregation,
  getAggregatedPreferences,
  getAggregatedErrors,
  getAggregatedSuccessPatterns,
  getToolEfficiency,
} from "./routes/learning.ts";

// Server configuration
interface ServerConfig {
  port: number;
  host: string;
  cors: boolean;
  auth: boolean;
}

const defaultConfig: ServerConfig = {
  port: parseInt(Deno.env.get("LOKI_DASHBOARD_PORT") || "57374", 10),
  host: Deno.env.get("LOKI_DASHBOARD_HOST") || "localhost",
  cors: true,
  auth: true,
};

/**
 * Route handler type
 */
type RouteHandler = (
  req: Request,
  ...params: string[]
) => Promise<Response> | Response;

/**
 * Route definition
 */
interface Route {
  method: string;
  pattern: RegExp;
  handler: RouteHandler;
}

/**
 * Define all routes
 */
const routes: Route[] = [
  // Health endpoints (no auth required)
  { method: "GET", pattern: /^\/health$/, handler: healthCheck },
  { method: "GET", pattern: /^\/health\/ready$/, handler: readinessCheck },
  { method: "GET", pattern: /^\/health\/live$/, handler: livenessCheck },

  // Status endpoint
  { method: "GET", pattern: /^\/api\/status$/, handler: detailedStatus },

  // Session endpoints
  { method: "POST", pattern: /^\/api\/sessions$/, handler: startSession },
  { method: "GET", pattern: /^\/api\/sessions$/, handler: listSessions },
  {
    method: "GET",
    pattern: /^\/api\/sessions\/([^/]+)$/,
    handler: getSession,
  },
  {
    method: "POST",
    pattern: /^\/api\/sessions\/([^/]+)\/stop$/,
    handler: stopSession,
  },
  {
    method: "POST",
    pattern: /^\/api\/sessions\/([^/]+)\/pause$/,
    handler: pauseSession,
  },
  {
    method: "POST",
    pattern: /^\/api\/sessions\/([^/]+)\/resume$/,
    handler: resumeSession,
  },
  {
    method: "POST",
    pattern: /^\/api\/sessions\/([^/]+)\/input$/,
    handler: injectInput,
  },
  {
    method: "DELETE",
    pattern: /^\/api\/sessions\/([^/]+)$/,
    handler: deleteSession,
  },

  // Task endpoints
  { method: "GET", pattern: /^\/api\/tasks$/, handler: listAllTasks },
  { method: "GET", pattern: /^\/api\/tasks\/active$/, handler: getActiveTasks },
  { method: "GET", pattern: /^\/api\/tasks\/queue$/, handler: getQueuedTasks },
  {
    method: "GET",
    pattern: /^\/api\/sessions\/([^/]+)\/tasks$/,
    handler: listTasks,
  },
  {
    method: "GET",
    pattern: /^\/api\/sessions\/([^/]+)\/tasks\/([^/]+)$/,
    handler: getTask,
  },

  // Event endpoints
  { method: "GET", pattern: /^\/api\/events$/, handler: streamEvents },
  {
    method: "GET",
    pattern: /^\/api\/events\/history$/,
    handler: getEventHistory,
  },
  { method: "GET", pattern: /^\/api\/events\/stats$/, handler: getEventStats },

  // Memory endpoints
  { method: "GET", pattern: /^\/api\/memory$/, handler: getMemorySummary },
  { method: "GET", pattern: /^\/api\/memory\/index$/, handler: getMemoryIndex },
  {
    method: "GET",
    pattern: /^\/api\/memory\/timeline$/,
    handler: getMemoryTimeline,
  },
  { method: "GET", pattern: /^\/api\/memory\/episodes$/, handler: listEpisodes },
  {
    method: "GET",
    pattern: /^\/api\/memory\/episodes\/([^/]+)$/,
    handler: getEpisode,
  },
  { method: "GET", pattern: /^\/api\/memory\/patterns$/, handler: listPatterns },
  {
    method: "GET",
    pattern: /^\/api\/memory\/patterns\/([^/]+)$/,
    handler: getPattern,
  },
  { method: "GET", pattern: /^\/api\/memory\/skills$/, handler: listSkills },
  {
    method: "GET",
    pattern: /^\/api\/memory\/skills\/([^/]+)$/,
    handler: getSkill,
  },
  {
    method: "POST",
    pattern: /^\/api\/memory\/retrieve$/,
    handler: retrieveMemories,
  },
  {
    method: "POST",
    pattern: /^\/api\/memory\/consolidate$/,
    handler: consolidateMemories,
  },
  {
    method: "GET",
    pattern: /^\/api\/memory\/economics$/,
    handler: getTokenEconomics,
  },
  {
    method: "GET",
    pattern: /^\/api\/suggestions$/,
    handler: getSuggestions,
  },
  {
    method: "GET",
    pattern: /^\/api\/suggestions\/learning$/,
    handler: getLearningSuggestions,
  },

  // Learning endpoints
  { method: "GET", pattern: /^\/api\/learning\/metrics$/, handler: getLearningMetrics },
  { method: "GET", pattern: /^\/api\/learning\/trends$/, handler: getLearningTrends },
  { method: "GET", pattern: /^\/api\/learning\/signals$/, handler: getLearningSignals },
  { method: "GET", pattern: /^\/api\/learning\/aggregation$/, handler: getLatestAggregation },
  { method: "POST", pattern: /^\/api\/learning\/aggregate$/, handler: triggerAggregation },
  { method: "GET", pattern: /^\/api\/learning\/preferences$/, handler: getAggregatedPreferences },
  { method: "GET", pattern: /^\/api\/learning\/errors$/, handler: getAggregatedErrors },
  { method: "GET", pattern: /^\/api\/learning\/success$/, handler: getAggregatedSuccessPatterns },
  { method: "GET", pattern: /^\/api\/learning\/tools$/, handler: getToolEfficiency },
];

/**
 * Route a request to the appropriate handler
 */
async function routeRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Find matching route
  for (const route of routes) {
    if (route.method !== method && method !== "OPTIONS") {
      continue;
    }

    const match = path.match(route.pattern);
    if (match) {
      // Extract path parameters
      const params = match.slice(1);
      return route.handler(req, ...params);
    }
  }

  // No route matched
  throw new LokiApiError(
    `No route found for ${method} ${path}`,
    ErrorCodes.NOT_FOUND
  );
}

/**
 * Create the main request handler with middleware
 */
function createHandler(config: ServerConfig): Deno.ServeHandler {
  let handler: (req: Request) => Promise<Response> = routeRequest;

  // Apply middleware in reverse order (innermost first)
  handler = errorMiddleware(handler);

  // Add timing middleware for learning signals (after error handling)
  handler = timingMiddleware(handler);

  if (config.auth) {
    // Skip auth for health endpoints
    const authHandler = handler;
    handler = async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/health")) {
        return authHandler(req);
      }
      return authMiddleware(authHandler)(req);
    };
  }

  if (config.cors) {
    handler = corsMiddleware(handler);
  }

  return handler;
}

/**
 * Print startup banner
 */
function printBanner(config: ServerConfig): void {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    LOKI MODE API SERVER                       ║
╠═══════════════════════════════════════════════════════════════╣
║  Version:  ${Deno.env.get("LOKI_VERSION") || "dev".padEnd(50)}║
║  Host:     ${config.host.padEnd(50)}║
║  Port:     ${String(config.port).padEnd(50)}║
║  CORS:     ${(config.cors ? "enabled" : "disabled").padEnd(50)}║
║  Auth:     ${(config.auth ? "enabled (localhost bypass)" : "disabled").padEnd(50)}║
╠═══════════════════════════════════════════════════════════════╣
║  Endpoints:                                                   ║
║    GET  /health            - Health check                     ║
║    GET  /api/status        - Detailed status                  ║
║    GET  /api/events        - SSE event stream                 ║
║    POST /api/sessions      - Start new session                ║
║    GET  /api/sessions      - List sessions                    ║
║    GET  /api/sessions/:id  - Get session details              ║
║    POST /api/sessions/:id/stop   - Stop session               ║
║    POST /api/sessions/:id/input  - Inject input               ║
║    GET  /api/sessions/:id/tasks  - List tasks                 ║
║    GET  /api/memory        - Memory summary                   ║
║    GET  /api/memory/episodes     - List episodes              ║
║    GET  /api/memory/patterns     - List patterns              ║
║    POST /api/memory/retrieve     - Query memories             ║
║    GET  /api/suggestions         - Get task-aware suggestions ║
╚═══════════════════════════════════════════════════════════════╝
`);
}

/**
 * Parse command line arguments
 */
function parseArgs(): ServerConfig {
  const config = { ...defaultConfig };
  const args = Deno.args;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
      case "-p":
        config.port = parseInt(args[++i], 10);
        break;
      case "--host":
      case "-h":
        config.host = args[++i];
        break;
      case "--no-cors":
        config.cors = false;
        break;
      case "--no-auth":
        config.auth = false;
        break;
      case "--help":
        console.log(`
Loki Mode API Server

Usage:
  deno run --allow-all api/server.ts [options]

Options:
  --port, -p <port>   Port to listen on (default: 57374)
  --host, -h <host>   Host to bind to (default: localhost)
  --no-cors           Disable CORS
  --no-auth           Disable authentication
  --help              Show this help message

Environment Variables:
  LOKI_DASHBOARD_PORT Port (overridden by --port)
  LOKI_DASHBOARD_HOST Host (overridden by --host)
  LOKI_API_TOKEN      API token for remote access
  LOKI_DIR            Loki installation directory
  LOKI_VERSION        Version string
  LOKI_DEBUG          Enable debug output
`);
        Deno.exit(0);
    }
  }

  return config;
}

/**
 * Start the server
 */
async function main(): Promise<void> {
  const config = parseArgs();

  // Start state watcher
  await stateWatcher.start();

  // Register cleanup handler for learning collector
  Deno.addSignalListener("SIGINT", async () => {
    console.log("\nShutting down...");
    // Flush any pending learning signals
    const flushed = await learningCollector.flush();
    if (flushed > 0) {
      console.log(`Flushed ${flushed} learning signals`);
    }
    learningCollector.stopFlushTimer();
    Deno.exit(0);
  });

  Deno.addSignalListener("SIGTERM", async () => {
    console.log("\nShutting down...");
    const flushed = await learningCollector.flush();
    if (flushed > 0) {
      console.log(`Flushed ${flushed} learning signals`);
    }
    learningCollector.stopFlushTimer();
    Deno.exit(0);
  });

  // Print banner
  printBanner(config);

  // Create handler
  const handler = createHandler(config);

  // Start server
  console.log(`Server listening on http://${config.host}:${config.port}`);

  await Deno.serve(
    {
      port: config.port,
      hostname: config.host,
      onListen: ({ hostname, port }) => {
        console.log(`Ready to accept connections on ${hostname}:${port}`);
      },
    },
    handler
  ).finished;
}

// Run if this is the main module
if (import.meta.main) {
  main().catch((err) => {
    console.error("Server error:", err);
    Deno.exit(1);
  });
}

// Export for testing
export { createHandler, routeRequest, parseArgs };
