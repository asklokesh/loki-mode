/**
 * Health Check Routes
 *
 * Endpoints for monitoring and health checks.
 */

import { cliBridge } from "../services/cli-bridge.ts";
import { eventBus } from "../services/event-bus.ts";
import type { HealthResponse, Phase } from "../types/api.ts";

// Base path for memory storage
const MEMORY_BASE_PATH = ".loki/memory";

/**
 * Memory pattern summary for status response
 */
interface PatternSummary {
  id: string;
  pattern: string;
  category: string;
  confidence: number;
}

/**
 * Memory context included in detailed status
 */
interface MemoryContext {
  available: boolean;
  currentPhase: Phase | null;
  relevantPatterns: PatternSummary[];
  patternCount: number;
}

const startTime = Date.now();
const version = Deno.env.get("LOKI_VERSION") || "dev";

/**
 * GET /health - Basic health check
 */
export async function healthCheck(_req: Request): Promise<Response> {
  const sessions = await cliBridge.listSessions();
  const runningSession = sessions.find((s) => s.status === "running");

  // Check provider availability
  const providers = await checkProviders();

  const response: HealthResponse = {
    status: providers.claude ? "healthy" : "degraded",
    version,
    uptime: Date.now() - startTime,
    providers,
    activeSession: runningSession?.id || null,
  };

  return new Response(JSON.stringify(response), {
    status: response.status === "healthy" ? 200 : 503,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GET /health/ready - Readiness probe
 */
export async function readinessCheck(_req: Request): Promise<Response> {
  // Check if we can access the CLI
  try {
    await cliBridge.executeCommand(["--version"], 5000);
    return new Response(JSON.stringify({ ready: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        ready: false,
        error: err instanceof Error ? err.message : "Unknown error",
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

/**
 * GET /health/live - Liveness probe
 */
export function livenessCheck(_req: Request): Response {
  return new Response(
    JSON.stringify({
      alive: true,
      uptime: Date.now() - startTime,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * GET /api/status - Detailed status
 */
export async function detailedStatus(_req: Request): Promise<Response> {
  const sessions = await cliBridge.listSessions();
  const providers = await checkProviders();

  const runningCount = sessions.filter((s) => s.status === "running").length;
  const completedCount = sessions.filter((s) => s.status === "completed").length;
  const failedCount = sessions.filter((s) => s.status === "failed").length;

  // Determine current phase from active session
  const runningSession = sessions.find((s) => s.status === "running");
  const currentPhase = runningSession?.currentPhase || null;

  // Get memory context with relevant patterns
  const memoryContext = await getMemoryContext(currentPhase);

  return new Response(
    JSON.stringify({
      version,
      uptime: Date.now() - startTime,
      uptimeFormatted: formatUptime(Date.now() - startTime),
      providers,
      sessions: {
        total: sessions.length,
        running: runningCount,
        completed: completedCount,
        failed: failedCount,
      },
      events: {
        subscribers: eventBus.getSubscriberCount(),
        historySize: eventBus.getHistory({}).length,
      },
      system: {
        platform: Deno.build.os,
        arch: Deno.build.arch,
        denoVersion: Deno.version.deno,
        v8Version: Deno.version.v8,
      },
      memoryContext,
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Check provider availability
 */
async function checkProviders(): Promise<{
  claude: boolean;
  opencode: boolean;
}> {
  const checkCommand = async (cmd: string): Promise<boolean> => {
    try {
      const command = new Deno.Command("which", {
        args: [cmd],
        stdout: "null",
        stderr: "null",
      });
      const output = await command.output();
      return output.success;
    } catch {
      return false;
    }
  };

  // The supported set (providers/loader.sh SUPPORTED_PROVIDERS).
  const [claude, opencode] = await Promise.all([
    checkCommand("claude"),
    checkCommand("opencode"),
  ]);

  return { claude, opencode };
}

/**
 * Get memory context with relevant patterns for the current phase
 */
async function getMemoryContext(currentPhase: Phase | null): Promise<MemoryContext> {
  const emptyContext: MemoryContext = {
    available: false,
    currentPhase,
    relevantPatterns: [],
    patternCount: 0,
  };

  try {
    // Build category filter based on current phase
    const categoryFilter = currentPhase ? `'${currentPhase}'` : "None";

    const script = `
import sys
import json
sys.path.insert(0, '.')

try:
    from memory.engine import MemoryEngine
    from memory.storage import MemoryStorage

    storage = MemoryStorage('${MEMORY_BASE_PATH}')
    engine = MemoryEngine(storage=storage, base_path='${MEMORY_BASE_PATH}')

    # Get patterns, optionally filtered by phase/category
    category = ${categoryFilter}

    # Get all patterns first to get total count
    all_patterns = engine.find_patterns(min_confidence=0.5)
    total_count = len(all_patterns)

    # Get relevant patterns for the current phase
    if category:
        # Try to find patterns matching the phase category
        phase_patterns = engine.find_patterns(category=category, min_confidence=0.5)
        if not phase_patterns:
            # Fall back to highest confidence patterns
            phase_patterns = sorted(all_patterns, key=lambda p: getattr(p, 'confidence', 0.5) if hasattr(p, 'confidence') else p.get('confidence', 0.5), reverse=True)
    else:
        # No phase, return highest confidence patterns
        phase_patterns = sorted(all_patterns, key=lambda p: getattr(p, 'confidence', 0.5) if hasattr(p, 'confidence') else p.get('confidence', 0.5), reverse=True)

    # Limit to top 3
    top_patterns = phase_patterns[:3]

    results = []
    for p in top_patterns:
        p_dict = p.to_dict() if hasattr(p, 'to_dict') else (p.__dict__ if hasattr(p, '__dict__') else p)
        results.append({
            'id': p_dict.get('id', ''),
            'pattern': p_dict.get('pattern', ''),
            'category': p_dict.get('category', ''),
            'confidence': p_dict.get('confidence', 0.8)
        })

    output = {
        'available': True,
        'relevantPatterns': results,
        'patternCount': total_count
    }
    print(json.dumps(output))

except ImportError:
    # Memory module not available
    print(json.dumps({'available': False, 'relevantPatterns': [], 'patternCount': 0}))
except Exception as e:
    # Any other error - memory not initialized or empty
    print(json.dumps({'available': False, 'relevantPatterns': [], 'patternCount': 0, 'error': str(e)}))
`;

    const command = new Deno.Command("python3", {
      args: ["-c", script],
      cwd: Deno.cwd(),
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout } = await command.output();

    if (code !== 0) {
      return emptyContext;
    }

    const result = new TextDecoder().decode(stdout);
    const parsed = JSON.parse(result.trim());

    return {
      available: parsed.available || false,
      currentPhase,
      relevantPatterns: parsed.relevantPatterns || [],
      patternCount: parsed.patternCount || 0,
    };
  } catch {
    // Memory system not available or error occurred
    return emptyContext;
  }
}

/**
 * Format uptime to human-readable string
 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
