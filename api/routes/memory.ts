/**
 * Memory Routes
 *
 * REST endpoints for the Loki Mode memory system.
 * Provides access to episodic, semantic, and procedural memory layers.
 *
 * Emits learning signals:
 * - ContextRelevanceSignal on memory retrieval
 * - SuccessPatternSignal on successful operations
 * - ToolEfficiencySignal with response times
 */

import { learningCollector } from "../services/learning-collector.ts";
import type {
  MemorySummary,
  EpisodeSummary,
  EpisodeDetail,
  PatternSummary,
  PatternDetail,
  SkillSummary,
  SkillDetail,
  RetrieveRequest,
  RetrieveResponse,
  ConsolidateRequest,
  ConsolidateResponse,
  TokenEconomicsDetail,
  IndexLayer,
  TimelineLayer,
  Suggestion,
  SuggestionsResponse,
  LearningSuggestion,
  LearningSuggestionsResponse,
} from "../types/memory.ts";
import {
  LokiApiError,
  ErrorCodes,
  validateBody,
  successResponse,
} from "../middleware/error.ts";

// Base path for memory storage
const MEMORY_BASE_PATH = ".loki/memory";

// Python helper shared by the token-economics scripts. A session that recorded
// nothing (all counters zero) is unmeasured: every metric is null, never 0 or
// a 100% saving. Once anything is recorded the measured values pass through.
const PY_TOKEN_METRICS = `
def token_metrics_from(summary):
    m = summary.get('metrics', {})
    keys = ('discovery_tokens', 'read_tokens', 'layer1_loads', 'layer2_loads',
            'layer3_loads', 'cache_hits', 'cache_misses')
    if not any((m.get(k) or 0) > 0 for k in keys):
        return {'discoveryTokens': None, 'readTokens': None, 'ratio': None, 'savingsPercent': None}
    return {
        'discoveryTokens': m.get('discovery_tokens'),
        'readTokens': m.get('read_tokens'),
        'ratio': summary.get('ratio'),
        'savingsPercent': summary.get('savings_percent')
    }
`;

// Default subprocess timeout (30 seconds)
const SUBPROCESS_TIMEOUT_MS = 30000;

// Valid task types for retrieval (allowlist for security)
const VALID_TASK_TYPES = new Set([
  "auto",
  "debugging",
  "implementation",
  "testing",
  "refactoring",
  "planning",
]);

// Rate limiter for suggestions endpoint (simple sliding window)
const rateLimiter = {
  requests: new Map<string, number[]>(),
  maxRequests: 10,
  windowMs: 1000,

  isAllowed(clientId: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Get existing timestamps for this client
    const timestamps = this.requests.get(clientId) || [];

    // Filter to only keep timestamps within the window
    const recentTimestamps = timestamps.filter((t) => t > windowStart);

    // Check if under limit
    if (recentTimestamps.length >= this.maxRequests) {
      return false;
    }

    // Add current timestamp and update
    recentTimestamps.push(now);
    this.requests.set(clientId, recentTimestamps);

    // Cleanup old entries periodically (every 100 requests)
    if (Math.random() < 0.01) {
      this.cleanup();
    }

    return true;
  },

  cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    for (const [clientId, timestamps] of this.requests.entries()) {
      const recent = timestamps.filter((t) => t > windowStart);
      if (recent.length === 0) {
        this.requests.delete(clientId);
      } else {
        this.requests.set(clientId, recent);
      }
    }
  },
};

/**
 * Safely escape a string for use in Python string literals.
 * Uses JSON.stringify which properly handles all special characters.
 */
function escapePythonString(str: string): string {
  // JSON.stringify handles all escaping, then we remove the surrounding quotes
  return JSON.stringify(str).slice(1, -1);
}

/**
 * Execute a Python command to interact with the memory system.
 * The memory system is implemented in Python, so we call it via subprocess.
 */
async function executePythonMemory(
  script: string,
  timeoutMs: number = SUBPROCESS_TIMEOUT_MS
): Promise<string> {
  const command = new Deno.Command("python3", {
    args: ["-c", script],
    cwd: Deno.cwd(),
    stdout: "piped",
    stderr: "piped",
  });

  const process = command.spawn();

  // Create timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      try {
        process.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
      reject(new LokiApiError(
        `Python subprocess timed out after ${timeoutMs}ms`,
        ErrorCodes.INTERNAL_ERROR,
        { timeout: timeoutMs }
      ));
    }, timeoutMs);
  });

  // Race between process completion and timeout
  const output = await Promise.race([
    process.output(),
    timeoutPromise,
  ]);

  if (output.code !== 0) {
    const errorText = new TextDecoder().decode(output.stderr);
    throw new LokiApiError(
      `Memory system error: ${errorText}`,
      ErrorCodes.INTERNAL_ERROR,
      { stderr: errorText }
    );
  }

  return new TextDecoder().decode(output.stdout);
}

/**
 * Parse query parameters from request URL
 */
function getQueryParams(req: Request): URLSearchParams {
  const url = new URL(req.url);
  return url.searchParams;
}

// -----------------------------------------------------------------------------
// GET /api/memory - Get memory summary
// -----------------------------------------------------------------------------

export async function getMemorySummary(_req: Request): Promise<Response> {
  try {
    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.engine import MemoryEngine
from memory.token_economics import TokenEconomics
${PY_TOKEN_METRICS}

engine = MemoryEngine('${MEMORY_BASE_PATH}')
stats = engine.get_stats()

# Get latest episode date
timeline = engine.get_timeline()
recent = timeline.get('recent_actions', [])
latest_date = recent[0].get('timestamp') if recent else None

# Try to get token economics
try:
    te = TokenEconomics('api-session', '${MEMORY_BASE_PATH}')
    te.load()
    summary = te.get_summary()
    token_metrics = token_metrics_from(summary)
except:
    token_metrics = None

result = {
    'episodic': {
        'count': stats.get('episodic_count', 0),
        'latestDate': latest_date
    },
    'semantic': {
        'patterns': stats.get('semantic_pattern_count', 0),
        'antiPatterns': stats.get('anti_pattern_count', 0)
    },
    'procedural': {
        'skills': stats.get('skill_count', 0)
    },
    'tokenEconomics': token_metrics
}

print(json.dumps(result))
`;

    const result = await executePythonMemory(script);
    const summary: MemorySummary = JSON.parse(result.trim());
    return successResponse(summary);
  } catch (error) {
    if (error instanceof LokiApiError) {
      throw error;
    }
    // Memory system may not be initialized
    const emptySummary: MemorySummary = {
      episodic: { count: 0, latestDate: null },
      semantic: { patterns: 0, antiPatterns: 0 },
      procedural: { skills: 0 },
      tokenEconomics: null,
    };
    return successResponse(emptySummary);
  }
}

// -----------------------------------------------------------------------------
// GET /api/memory/index - Get index layer
// -----------------------------------------------------------------------------

export async function getMemoryIndex(_req: Request): Promise<Response> {
  try {
    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.engine import MemoryEngine

engine = MemoryEngine('${MEMORY_BASE_PATH}')
index = engine.get_index()

# Convert snake_case to camelCase for API consistency
result = {
    'version': index.get('version', '1.0'),
    'lastUpdated': index.get('last_updated'),
    'topics': [
        {
            'id': t.get('id'),
            'summary': t.get('summary'),
            'relevanceScore': t.get('relevance_score', 0.5),
            'lastAccessed': t.get('last_accessed'),
            'tokenCount': t.get('token_count', 0)
        }
        for t in index.get('topics', [])
    ],
    'totalMemories': index.get('total_memories', 0),
    'totalTokensAvailable': index.get('total_tokens_available', 0)
}

print(json.dumps(result))
`;

    const result = await executePythonMemory(script);
    const indexLayer: IndexLayer = JSON.parse(result.trim());
    return successResponse(indexLayer);
  } catch (error) {
    if (error instanceof LokiApiError) {
      throw error;
    }
    throw new LokiApiError(
      "Memory index not available",
      ErrorCodes.SERVICE_UNAVAILABLE
    );
  }
}

// -----------------------------------------------------------------------------
// GET /api/memory/timeline - Get timeline layer
// -----------------------------------------------------------------------------

export async function getMemoryTimeline(_req: Request): Promise<Response> {
  try {
    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.engine import MemoryEngine

engine = MemoryEngine('${MEMORY_BASE_PATH}')
timeline = engine.get_timeline()

# Convert snake_case to camelCase for API consistency
result = {
    'version': timeline.get('version', '1.0'),
    'lastUpdated': timeline.get('last_updated'),
    'recentActions': [
        {
            'timestamp': a.get('timestamp'),
            'action': a.get('action'),
            'outcome': a.get('outcome'),
            'topicId': a.get('topic_id')
        }
        for a in timeline.get('recent_actions', [])
    ],
    'keyDecisions': timeline.get('key_decisions', []),
    'activeContext': {
        'currentFocus': timeline.get('active_context', {}).get('current_focus'),
        'blockedBy': timeline.get('active_context', {}).get('blocked_by', []),
        'nextUp': timeline.get('active_context', {}).get('next_up', [])
    }
}

print(json.dumps(result))
`;

    const result = await executePythonMemory(script);
    const timelineLayer: TimelineLayer = JSON.parse(result.trim());
    return successResponse(timelineLayer);
  } catch (error) {
    if (error instanceof LokiApiError) {
      throw error;
    }
    throw new LokiApiError(
      "Memory timeline not available",
      ErrorCodes.SERVICE_UNAVAILABLE
    );
  }
}

// -----------------------------------------------------------------------------
// GET /api/memory/episodes - List episodes
// -----------------------------------------------------------------------------

export async function listEpisodes(req: Request): Promise<Response> {
  const params = getQueryParams(req);
  const since = params.get("since") || "";
  const rawLimit = parseInt(params.get("limit") || "50", 10);
  const limit = Math.min(Math.max(1, rawLimit), 100); // Validate: 1-100

  // Escape since parameter for Python
  const escapedSince = escapePythonString(since);

  try {
    const script = `
import sys
import json
from datetime import datetime
sys.path.insert(0, '.')
from memory.engine import MemoryEngine

engine = MemoryEngine('${MEMORY_BASE_PATH}')

since_filter = '${escapedSince}' if '${escapedSince}' else None
limit = ${limit}

if since_filter:
    # Parse the since date and retrieve temporal
    since_dt = datetime.fromisoformat(since_filter.replace('Z', ''))
    episodes = engine.retrieve_by_temporal(since_dt)
else:
    # Get recent episodes
    episodes = engine.get_recent_episodes(limit=limit)

# Convert to summary format
results = []
for ep in episodes[:limit]:
    if hasattr(ep, 'to_dict'):
        ep_dict = ep.to_dict()
    else:
        ep_dict = ep

    ctx = ep_dict.get('context', {})
    results.append({
        'id': ep_dict.get('id', ''),
        'taskId': ep_dict.get('task_id', ''),
        'timestamp': ep_dict.get('timestamp', ''),
        'agent': ep_dict.get('agent', ''),
        'phase': ctx.get('phase', ep_dict.get('phase', '')),
        'outcome': ep_dict.get('outcome', '')
    })

print(json.dumps(results))
`;

    const result = await executePythonMemory(script);
    const episodes: EpisodeSummary[] = JSON.parse(result.trim());
    return successResponse({
      episodes,
      total: episodes.length,
    });
  } catch (error) {
    if (error instanceof LokiApiError) {
      throw error;
    }
    return successResponse({ episodes: [], total: 0 });
  }
}

// -----------------------------------------------------------------------------
// GET /api/memory/episodes/:id - Get specific episode
// -----------------------------------------------------------------------------

export async function getEpisode(
  _req: Request,
  episodeId: string
): Promise<Response> {
  // Escape episodeId for Python
  const escapedEpisodeId = escapePythonString(episodeId);

  try {
    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.engine import MemoryEngine

engine = MemoryEngine('${MEMORY_BASE_PATH}')
episode = engine.get_episode('${escapedEpisodeId}')

if episode is None:
    print('null')
else:
    ep_dict = episode.to_dict() if hasattr(episode, 'to_dict') else episode.__dict__
    ctx = ep_dict.get('context', {})

    result = {
        'id': ep_dict.get('id', ''),
        'taskId': ep_dict.get('task_id', ''),
        'timestamp': ep_dict.get('timestamp', ''),
        'agent': ep_dict.get('agent', ''),
        'phase': ctx.get('phase', ep_dict.get('phase', '')),
        'outcome': ep_dict.get('outcome', ''),
        'goal': ctx.get('goal', ep_dict.get('goal', '')),
        'durationSeconds': ep_dict.get('duration_seconds', 0),
        'actionLog': ep_dict.get('action_log', []),
        'errorsEncountered': ep_dict.get('errors_encountered', []),
        'artifactsProduced': ep_dict.get('artifacts_produced', []),
        'gitCommit': ep_dict.get('git_commit'),
        'tokensUsed': ep_dict.get('tokens_used', 0),
        'filesRead': ep_dict.get('files_read', ctx.get('files_involved', [])),
        'filesModified': ep_dict.get('files_modified', [])
    }
    print(json.dumps(result))
`;

    const result = await executePythonMemory(script);
    const trimmed = result.trim();

    if (trimmed === "null") {
      throw new LokiApiError(
        `Episode not found: ${episodeId}`,
        ErrorCodes.NOT_FOUND
      );
    }

    const episode: EpisodeDetail = JSON.parse(trimmed);
    return successResponse(episode);
  } catch (error) {
    if (error instanceof LokiApiError) {
      throw error;
    }
    throw new LokiApiError(
      `Episode not found: ${episodeId}`,
      ErrorCodes.NOT_FOUND
    );
  }
}

// -----------------------------------------------------------------------------
// GET /api/memory/patterns - List semantic patterns
// -----------------------------------------------------------------------------

export async function listPatterns(req: Request): Promise<Response> {
  const params = getQueryParams(req);
  const category = params.get("category") || "";
  const rawMinConfidence = parseFloat(params.get("minConfidence") || "0.5");
  // Validate minConfidence: 0.0 to 1.0
  const minConfidence = Math.min(Math.max(0, rawMinConfidence), 1);

  // Escape category for Python
  const escapedCategory = escapePythonString(category);

  try {
    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.engine import MemoryEngine

engine = MemoryEngine('${MEMORY_BASE_PATH}')

category_filter = '${escapedCategory}' if '${escapedCategory}' else None
min_confidence = ${minConfidence}

patterns = engine.find_patterns(category=category_filter, min_confidence=min_confidence)

results = []
for p in patterns:
    p_dict = p.to_dict() if hasattr(p, 'to_dict') else p.__dict__
    results.append({
        'id': p_dict.get('id', ''),
        'pattern': p_dict.get('pattern', ''),
        'category': p_dict.get('category', ''),
        'confidence': p_dict.get('confidence', 0.8),
        'usageCount': p_dict.get('usage_count', 0)
    })

print(json.dumps(results))
`;

    const result = await executePythonMemory(script);
    const patterns: PatternSummary[] = JSON.parse(result.trim());
    return successResponse({
      patterns,
      total: patterns.length,
    });
  } catch (error) {
    if (error instanceof LokiApiError) {
      throw error;
    }
    return successResponse({ patterns: [], total: 0 });
  }
}

// -----------------------------------------------------------------------------
// GET /api/memory/patterns/:id - Get specific pattern
// -----------------------------------------------------------------------------

export async function getPattern(
  _req: Request,
  patternId: string
): Promise<Response> {
  // Escape patternId for Python
  const escapedPatternId = escapePythonString(patternId);

  try {
    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.engine import MemoryEngine

engine = MemoryEngine('${MEMORY_BASE_PATH}')
pattern = engine.get_pattern('${escapedPatternId}')

if pattern is None:
    print('null')
else:
    p_dict = pattern.to_dict() if hasattr(pattern, 'to_dict') else pattern.__dict__

    result = {
        'id': p_dict.get('id', ''),
        'pattern': p_dict.get('pattern', ''),
        'category': p_dict.get('category', ''),
        'confidence': p_dict.get('confidence', 0.8),
        'usageCount': p_dict.get('usage_count', 0),
        'conditions': p_dict.get('conditions', []),
        'correctApproach': p_dict.get('correct_approach', ''),
        'incorrectApproach': p_dict.get('incorrect_approach', ''),
        'sourceEpisodes': p_dict.get('source_episodes', []),
        'lastUsed': p_dict.get('last_used'),
        'links': p_dict.get('links', [])
    }
    print(json.dumps(result, default=str))
`;

    const result = await executePythonMemory(script);
    const trimmed = result.trim();

    if (trimmed === "null") {
      throw new LokiApiError(
        `Pattern not found: ${patternId}`,
        ErrorCodes.NOT_FOUND
      );
    }

    const pattern: PatternDetail = JSON.parse(trimmed);
    return successResponse(pattern);
  } catch (error) {
    if (error instanceof LokiApiError) {
      throw error;
    }
    throw new LokiApiError(
      `Pattern not found: ${patternId}`,
      ErrorCodes.NOT_FOUND
    );
  }
}

// -----------------------------------------------------------------------------
// GET /api/memory/skills - List procedural skills
// -----------------------------------------------------------------------------

export async function listSkills(_req: Request): Promise<Response> {
  try {
    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.engine import MemoryEngine

engine = MemoryEngine('${MEMORY_BASE_PATH}')
skills = engine.list_skills()

results = []
for s in skills:
    s_dict = s.to_dict() if hasattr(s, 'to_dict') else s.__dict__
    results.append({
        'id': s_dict.get('id', ''),
        'name': s_dict.get('name', ''),
        'description': s_dict.get('description', '')
    })

print(json.dumps(results))
`;

    const result = await executePythonMemory(script);
    const skills: SkillSummary[] = JSON.parse(result.trim());
    return successResponse({
      skills,
      total: skills.length,
    });
  } catch (error) {
    if (error instanceof LokiApiError) {
      throw error;
    }
    return successResponse({ skills: [], total: 0 });
  }
}

// -----------------------------------------------------------------------------
// GET /api/memory/skills/:id - Get specific skill
// -----------------------------------------------------------------------------

export async function getSkill(
  _req: Request,
  skillId: string
): Promise<Response> {
  // Escape skillId for Python
  const escapedSkillId = escapePythonString(skillId);

  try {
    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.engine import MemoryEngine

engine = MemoryEngine('${MEMORY_BASE_PATH}')
skill = engine.get_skill('${escapedSkillId}')

if skill is None:
    print('null')
else:
    s_dict = skill.to_dict() if hasattr(skill, 'to_dict') else skill.__dict__

    result = {
        'id': s_dict.get('id', ''),
        'name': s_dict.get('name', ''),
        'description': s_dict.get('description', ''),
        'prerequisites': s_dict.get('prerequisites', []),
        'steps': s_dict.get('steps', []),
        'commonErrors': s_dict.get('common_errors', []),
        'exitCriteria': s_dict.get('exit_criteria', []),
        'exampleUsage': s_dict.get('example_usage')
    }
    print(json.dumps(result))
`;

    const result = await executePythonMemory(script);
    const trimmed = result.trim();

    if (trimmed === "null") {
      throw new LokiApiError(
        `Skill not found: ${skillId}`,
        ErrorCodes.NOT_FOUND
      );
    }

    const skill: SkillDetail = JSON.parse(trimmed);
    return successResponse(skill);
  } catch (error) {
    if (error instanceof LokiApiError) {
      throw error;
    }
    throw new LokiApiError(
      `Skill not found: ${skillId}`,
      ErrorCodes.NOT_FOUND
    );
  }
}

// -----------------------------------------------------------------------------
// POST /api/memory/retrieve - Query memories
// -----------------------------------------------------------------------------

export async function retrieveMemories(req: Request): Promise<Response> {
  const startTime = Date.now();
  const body = await req.json().catch(() => ({}));
  const data = validateBody<RetrieveRequest>(body, ["query"], [
    "taskType",
    "topK",
  ]);

  const query = data.query;
  const rawTaskType = data.taskType || "auto";
  const topK = Math.min(Math.max(1, data.topK || 5), 50); // Validate: 1-50

  // Validate taskType against allowlist
  const taskType = VALID_TASK_TYPES.has(rawTaskType) ? rawTaskType : "auto";

  // Validate query length (max 10,000 characters)
  if (query.length > 10000) {
    throw new LokiApiError(
      "Query exceeds maximum length of 10,000 characters",
      ErrorCodes.VALIDATION_ERROR,
      { maxLength: 10000, actualLength: query.length }
    );
  }

  try {
    // Properly escape string for Python using JSON.stringify
    const escapedQuery = escapePythonString(query);

    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.engine import MemoryEngine
from memory.retrieval import MemoryRetrieval
from memory.storage import MemoryStorage
from memory.token_economics import TokenEconomics
${PY_TOKEN_METRICS}

storage = MemoryStorage('${MEMORY_BASE_PATH}')
engine = MemoryEngine(storage=storage, base_path='${MEMORY_BASE_PATH}')
retrieval = MemoryRetrieval(storage=storage, base_path='${MEMORY_BASE_PATH}')

# Build context for task-aware retrieval
context = {
    'goal': '${escapedQuery}',
    'task_type': '${taskType}' if '${taskType}' != 'auto' else None
}

# Retrieve memories
memories_raw = retrieval.retrieve_task_aware(context, top_k=${topK})

# Format results
memories = []
for m in memories_raw:
    memories.append({
        'id': m.get('id', ''),
        'source': m.get('_source', 'unknown'),
        'score': m.get('_weighted_score', m.get('_score', 0.5)),
        'content': {k: v for k, v in m.items() if not k.startswith('_')}
    })

# Get token metrics
try:
    te = TokenEconomics('retrieve-session', '${MEMORY_BASE_PATH}')
    te.load()
    summary = te.get_summary()
    token_metrics = token_metrics_from(summary)
except:
    token_metrics = token_metrics_from({})

result = {
    'memories': memories,
    'tokenMetrics': token_metrics
}

print(json.dumps(result, default=str))
`;

    const result = await executePythonMemory(script);
    const response: RetrieveResponse = JSON.parse(result.trim());

    // Emit learning signals for memory retrieval
    const retrievedIds = response.memories.map((m) => m.id);
    learningCollector.emitMemoryRetrieval(
      query,
      retrievedIds,
      startTime,
      {
        taskType,
        context: {
          topK,
          tokenMetrics: response.tokenMetrics,
        },
      }
    );

    return successResponse(response);
  } catch (error) {
    // Emit error signal for failed retrieval
    learningCollector.emitContextRelevance(
      "memory_retrieve_failed",
      query,
      [],
      {
        precision: 0,
        recall: 0,
        context: {
          taskType,
          error: error instanceof Error ? error.message : "Unknown error",
          durationMs: Date.now() - startTime,
        },
      }
    );

    if (error instanceof LokiApiError) {
      throw error;
    }
    // Return empty result if retrieval fails
    const emptyResponse: RetrieveResponse = {
      memories: [],
      tokenMetrics: {
        discoveryTokens: null,
        readTokens: null,
        ratio: null,
        savingsPercent: null,
      },
    };
    return successResponse(emptyResponse);
  }
}

// -----------------------------------------------------------------------------
// POST /api/memory/consolidate - Trigger consolidation
// -----------------------------------------------------------------------------

export async function consolidateMemories(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const data = validateBody<ConsolidateRequest>(body, [], ["sinceHours"]);

  const sinceHours = data.sinceHours || 24;

  try {
    const script = `
import sys
import json
import time
from datetime import datetime, timedelta
sys.path.insert(0, '.')

# Consolidation requires the consolidation module
try:
    from memory.consolidation import ConsolidationPipeline
    from memory.engine import MemoryEngine
    from memory.storage import MemoryStorage

    storage = MemoryStorage('${MEMORY_BASE_PATH}')
    engine = MemoryEngine(storage=storage, base_path='${MEMORY_BASE_PATH}')

    start_time = time.time()

    # Create consolidation pipeline
    pipeline = ConsolidationPipeline(storage)

    # Get episodes from the last N hours
    since = datetime.now() - timedelta(hours=${sinceHours})
    episodes = engine.retrieve_by_temporal(since)

    # Run consolidation (this is a simplified version)
    # Full consolidation would extract patterns, create links, etc.
    patterns_created = 0
    patterns_merged = 0
    anti_patterns_created = 0
    links_created = 0
    episodes_processed = len(episodes)

    # Note: Full consolidation logic would go here
    # For now, return the episode count as processed

    duration = time.time() - start_time

    result = {
        'patternsCreated': patterns_created,
        'patternsMerged': patterns_merged,
        'antiPatternsCreated': anti_patterns_created,
        'linksCreated': links_created,
        'episodesProcessed': episodes_processed,
        'durationSeconds': round(duration, 2)
    }
    print(json.dumps(result))

except ImportError:
    # Consolidation module not available, return basic result
    result = {
        'patternsCreated': 0,
        'patternsMerged': 0,
        'antiPatternsCreated': 0,
        'linksCreated': 0,
        'episodesProcessed': 0,
        'durationSeconds': 0,
        'note': 'Consolidation module not available'
    }
    print(json.dumps(result))
`;

    const result = await executePythonMemory(script);
    const response: ConsolidateResponse = JSON.parse(result.trim());
    return successResponse(response);
  } catch (error) {
    if (error instanceof LokiApiError) {
      throw error;
    }
    throw new LokiApiError(
      "Consolidation failed",
      ErrorCodes.INTERNAL_ERROR,
      { error: error instanceof Error ? error.message : "Unknown error" }
    );
  }
}

// -----------------------------------------------------------------------------
// GET /api/memory/economics - Get token economics
// -----------------------------------------------------------------------------

export async function getTokenEconomics(_req: Request): Promise<Response> {
  try {
    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.token_economics import TokenEconomics
${PY_TOKEN_METRICS}

te = TokenEconomics('api-session', '${MEMORY_BASE_PATH}')
te.load()
summary = te.get_summary()

result = {
    'sessionId': summary.get('session_id', 'unknown'),
    'startedAt': summary.get('started_at', ''),
    **token_metrics_from(summary),
    'layer1Loads': summary['metrics'].get('layer1_loads', 0),
    'layer2Loads': summary['metrics'].get('layer2_loads', 0),
    'layer3Loads': summary['metrics'].get('layer3_loads', 0),
    'cacheHits': summary['metrics'].get('cache_hits', 0),
    'cacheMisses': summary['metrics'].get('cache_misses', 0),
    'thresholdsTriggered': [
        {
            'actionType': t.get('action_type', ''),
            'priority': t.get('priority', 999),
            'description': t.get('description', ''),
            'triggeredBy': t.get('triggered_by', '')
        }
        for t in summary.get('thresholds_triggered', [])
    ]
}

print(json.dumps(result))
`;

    const result = await executePythonMemory(script);
    const economics: TokenEconomicsDetail = JSON.parse(result.trim());
    return successResponse(economics);
  } catch (error) {
    if (error instanceof LokiApiError) {
      throw error;
    }
    // Return default economics if not available
    const defaultEconomics: TokenEconomicsDetail = {
      sessionId: "none",
      startedAt: new Date().toISOString(),
      discoveryTokens: null,
      readTokens: null,
      ratio: null,
      savingsPercent: null,
      layer1Loads: 0,
      layer2Loads: 0,
      layer3Loads: 0,
      cacheHits: 0,
      cacheMisses: 0,
      thresholdsTriggered: [],
    };
    return successResponse(defaultEconomics);
  }
}

// -----------------------------------------------------------------------------
// GET /api/suggestions - Get task-aware suggestions
// -----------------------------------------------------------------------------

export async function getSuggestions(req: Request): Promise<Response> {
  const startTime = Date.now();

  // Rate limiting check
  const clientId = req.headers.get("x-forwarded-for") ||
    req.headers.get("x-real-ip") ||
    "localhost";
  if (!rateLimiter.isAllowed(clientId)) {
    throw new LokiApiError(
      "Rate limit exceeded. Maximum 10 requests per second.",
      ErrorCodes.VALIDATION_ERROR,
      { retryAfter: 1 }
    );
  }

  const params = getQueryParams(req);
  const context = params.get("context") || "";
  const rawTaskType = params.get("taskType") || "auto";
  const rawLimit = parseInt(params.get("limit") || "5", 10);

  // Validate taskType against allowlist
  const taskType = VALID_TASK_TYPES.has(rawTaskType) ? rawTaskType : "auto";

  // Validate limit: must be positive, max 50
  const limit = Math.min(Math.max(1, rawLimit), 50);

  if (!context) {
    throw new LokiApiError(
      "Missing required parameter: context",
      ErrorCodes.VALIDATION_ERROR
    );
  }

  // Validate context length (max 10,000 characters)
  if (context.length > 10000) {
    throw new LokiApiError(
      "Context exceeds maximum length of 10,000 characters",
      ErrorCodes.VALIDATION_ERROR,
      { maxLength: 10000, actualLength: context.length }
    );
  }

  try {
    // Properly escape string for Python using JSON.stringify
    const escapedContext = escapePythonString(context);

    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.retrieval import MemoryRetrieval
from memory.storage import MemoryStorage
from memory.token_economics import TokenEconomics

storage = MemoryStorage('${MEMORY_BASE_PATH}')
retrieval = MemoryRetrieval(storage=storage, base_path='${MEMORY_BASE_PATH}')

# Build context for task-aware retrieval
ctx = {
    'goal': '${escapedContext}',
    'task_type': '${taskType}' if '${taskType}' != 'auto' else None
}

# Detect task type if auto
detected_task_type = retrieval.detect_task_type(ctx) if '${taskType}' == 'auto' else '${taskType}'

# Retrieve memories using task-aware retrieval
memories = retrieval.retrieve_task_aware(ctx, top_k=${limit})

# Track in token economics
te = TokenEconomics('suggestions-session', '${MEMORY_BASE_PATH}')
te.load()
total_tokens = sum(len(json.dumps(m, default=str)) // 4 for m in memories)
te.record_read(total_tokens, 2)  # Layer 2 for suggestions
te.save()

# Convert memories to suggestions format
suggestions = []
for m in memories:
    source = m.get('_source', 'unknown')
    confidence = m.get('_weighted_score', m.get('_score', 0.5))

    # Generate content based on source type
    if source == 'episodic':
        content_ctx = m.get('context', {})
        content = content_ctx.get('goal', m.get('goal', 'No description'))
        action = f"Review episode: {m.get('outcome', 'completed')}"
    elif source == 'semantic':
        content = m.get('pattern', m.get('correct_approach', 'No pattern'))
        action = f"Apply pattern: {m.get('category', 'general')}"
    elif source == 'skills':
        content = m.get('description', m.get('name', 'No description'))
        action = f"Use skill: {m.get('name', 'unknown')}"
    elif source == 'anti_patterns':
        content = m.get('what_fails', m.get('prevention', 'No description'))
        action = f"Avoid: {m.get('why', 'known issue')}"
    else:
        content = str(m.get('content', m))[:200]
        action = "Review memory"

    suggestions.append({
        'id': m.get('id', f"sug-{len(suggestions)}"),
        'type': source,
        'confidence': round(float(confidence), 3) if confidence <= 1.0 else round(min(1.0, confidence / 10.0), 3),
        'content': content[:500],  # Limit content length
        'action': action[:200]
    })

result = {
    'suggestions': suggestions,
    'context': '${escapedContext}'[:200],
    'taskType': detected_task_type
}

print(json.dumps(result, default=str))
`;

    const result = await executePythonMemory(script);
    const response: SuggestionsResponse = JSON.parse(result.trim());

    // Sort suggestions by confidence (highest first)
    response.suggestions.sort((a, b) => b.confidence - a.confidence);

    // Emit learning signals for suggestions retrieval
    const suggestionIds = response.suggestions.map((s) => s.id);
    learningCollector.emitContextRelevance(
      "get_suggestions",
      context,
      suggestionIds,
      {
        context: {
          taskType: response.taskType,
          suggestionCount: response.suggestions.length,
          durationMs: Date.now() - startTime,
        },
      }
    );

    return successResponse(response);
  } catch (error) {
    // Emit error signal for failed suggestions
    learningCollector.emitContextRelevance(
      "get_suggestions_failed",
      context,
      [],
      {
        precision: 0,
        recall: 0,
        context: {
          taskType,
          error: error instanceof Error ? error.message : "Unknown error",
          durationMs: Date.now() - startTime,
        },
      }
    );

    if (error instanceof LokiApiError) {
      throw error;
    }
    // Return empty suggestions if retrieval fails
    const emptyResponse: SuggestionsResponse = {
      suggestions: [],
      context: context.substring(0, 200),
      taskType: taskType === "auto" ? "implementation" : taskType,
    };
    return successResponse(emptyResponse);
  }
}

// -----------------------------------------------------------------------------
// GET /api/suggestions/learning - Get learning-based suggestions
// -----------------------------------------------------------------------------

// Valid learning suggestion types
const VALID_LEARNING_SUGGESTION_TYPES = new Set([
  "command",
  "error",
  "practice",
  "tool",
]);

export async function getLearningSuggestions(req: Request): Promise<Response> {
  const startTime = Date.now();

  // Rate limiting check (reuse existing rate limiter)
  const clientId = req.headers.get("x-forwarded-for") ||
    req.headers.get("x-real-ip") ||
    "localhost";
  if (!rateLimiter.isAllowed(clientId)) {
    throw new LokiApiError(
      "Rate limit exceeded. Maximum 10 requests per second.",
      ErrorCodes.VALIDATION_ERROR,
      { retryAfter: 1 }
    );
  }

  const params = getQueryParams(req);
  const context = params.get("context") || "";
  const taskType = params.get("taskType") || "";
  const rawTypes = params.get("types") || "";
  const rawLimit = parseInt(params.get("limit") || "10", 10);
  const rawMinConfidence = parseFloat(params.get("minConfidence") || "0.3");

  // Validate limit: must be positive, max 50
  const limit = Math.min(Math.max(1, rawLimit), 50);

  // Validate minConfidence: 0.0 to 1.0
  const minConfidence = Math.min(Math.max(0, rawMinConfidence), 1);

  // Validate context length (max 10,000 characters)
  if (context.length > 10000) {
    throw new LokiApiError(
      "Context exceeds maximum length of 10,000 characters",
      ErrorCodes.VALIDATION_ERROR,
      { maxLength: 10000, actualLength: context.length }
    );
  }

  // Parse and validate types
  let typeFilter = "";
  if (rawTypes) {
    const types = rawTypes.split(",").map((t) => t.trim().toLowerCase());
    const validTypes = types.filter((t) => VALID_LEARNING_SUGGESTION_TYPES.has(t));
    if (validTypes.length > 0) {
      typeFilter = JSON.stringify(validTypes);
    }
  }

  try {
    // Properly escape strings for Python using JSON.stringify
    const escapedContext = escapePythonString(context);
    const escapedTaskType = escapePythonString(taskType);

    const script = `
import sys
import json
sys.path.insert(0, '.')
from learning.suggestions import (
    LearningSuggestions,
    SuggestionContext,
    SuggestionType,
)

# Build context
context = SuggestionContext(
    current_task='${escapedContext}',
    task_type='${escapedTaskType}',
)

# Parse type filter
type_filter_raw = ${typeFilter || 'None'}
type_filter = None
if type_filter_raw:
    type_map = {
        'command': SuggestionType.COMMAND,
        'error': SuggestionType.ERROR_PREVENTION,
        'practice': SuggestionType.BEST_PRACTICE,
        'tool': SuggestionType.TOOL,
    }
    type_filter = [type_map[t] for t in type_filter_raw if t in type_map]

# Create suggestions generator
gen = LearningSuggestions(
    loki_dir=None,  # Use default .loki
    max_suggestions=${limit},
    min_confidence=${minConfidence},
)

# Get suggestions
suggestions = gen.get_suggestions(
    context=context,
    types=type_filter if type_filter else None,
    limit=${limit},
)

# Convert to JSON-serializable format
result = {
    'suggestions': [s.to_dict() for s in suggestions],
    'count': len(suggestions),
    'timestamp': gen._cache_time.isoformat() + 'Z' if gen._cache_time else None,
}

if context.current_task or context.task_type:
    result['context'] = {
        'current_task': context.current_task,
        'task_type': context.task_type,
    }

print(json.dumps(result, default=str))
`;

    const result = await executePythonMemory(script);
    const response: LearningSuggestionsResponse = JSON.parse(result.trim());

    // Emit learning signal for successful retrieval
    learningCollector.emitToolEfficiency(
      "get_learning_suggestions",
      "api:suggestions:learning",
      {
        executionTimeMs: Date.now() - startTime,
        outcome: response.count > 0 ? "success" : "partial",
        context: {
          suggestionCount: response.count,
          types: rawTypes || "all",
          limit,
        },
      }
    );

    return successResponse(response);
  } catch (error) {
    // Emit error signal
    learningCollector.emitErrorPattern(
      "get_learning_suggestions",
      "learning_suggestions_error",
      error instanceof Error ? error.message : "Unknown error",
      {
        context: {
          durationMs: Date.now() - startTime,
          limit,
          types: rawTypes || "all",
        },
      }
    );

    if (error instanceof LokiApiError) {
      throw error;
    }

    // Return empty response on error
    const emptyResponse: LearningSuggestionsResponse = {
      suggestions: [],
      count: 0,
      timestamp: new Date().toISOString(),
    };
    return successResponse(emptyResponse);
  }
}
