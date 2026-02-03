/**
 * Memory Routes
 *
 * REST endpoints for the Loki Mode memory system.
 * Provides access to episodic, semantic, and procedural memory layers.
 */

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
} from "../types/memory.ts";
import {
  LokiApiError,
  ErrorCodes,
  validateBody,
  successResponse,
} from "../middleware/error.ts";

// Base path for memory storage
const MEMORY_BASE_PATH = ".loki/memory";

/**
 * Execute a Python command to interact with the memory system.
 * The memory system is implemented in Python, so we call it via subprocess.
 */
async function executePythonMemory(script: string): Promise<string> {
  const command = new Deno.Command("python3", {
    args: ["-c", script],
    cwd: Deno.cwd(),
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    const errorText = new TextDecoder().decode(stderr);
    throw new LokiApiError(
      `Memory system error: ${errorText}`,
      ErrorCodes.INTERNAL_ERROR,
      { stderr: errorText }
    );
  }

  return new TextDecoder().decode(stdout);
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
    token_metrics = {
        'discoveryTokens': summary['metrics'].get('discovery_tokens', 0),
        'readTokens': summary['metrics'].get('read_tokens', 0),
        'ratio': summary.get('ratio', 0),
        'savingsPercent': summary.get('savings_percent', 100)
    }
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
  const limit = parseInt(params.get("limit") || "50", 10);

  try {
    const script = `
import sys
import json
from datetime import datetime
sys.path.insert(0, '.')
from memory.engine import MemoryEngine

engine = MemoryEngine('${MEMORY_BASE_PATH}')

since_filter = '${since}' if '${since}' else None
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
  try {
    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.engine import MemoryEngine

engine = MemoryEngine('${MEMORY_BASE_PATH}')
episode = engine.get_episode('${episodeId}')

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
  const minConfidence = parseFloat(params.get("minConfidence") || "0.5");

  try {
    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.engine import MemoryEngine

engine = MemoryEngine('${MEMORY_BASE_PATH}')

category_filter = '${category}' if '${category}' else None
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
  try {
    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.engine import MemoryEngine

engine = MemoryEngine('${MEMORY_BASE_PATH}')
pattern = engine.get_pattern('${patternId}')

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
  try {
    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.engine import MemoryEngine

engine = MemoryEngine('${MEMORY_BASE_PATH}')
skill = engine.get_skill('${skillId}')

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
  const body = await req.json().catch(() => ({}));
  const data = validateBody<RetrieveRequest>(body, ["query"], [
    "taskType",
    "topK",
  ]);

  const query = data.query;
  const taskType = data.taskType || "auto";
  const topK = data.topK || 5;

  try {
    // Escape single quotes in query for Python
    const escapedQuery = query.replace(/'/g, "\\'");

    const script = `
import sys
import json
sys.path.insert(0, '.')
from memory.engine import MemoryEngine
from memory.retrieval import MemoryRetrieval
from memory.storage import MemoryStorage
from memory.token_economics import TokenEconomics

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
    token_metrics = {
        'discoveryTokens': summary['metrics'].get('discovery_tokens', 0),
        'readTokens': summary['metrics'].get('read_tokens', 0),
        'ratio': summary.get('ratio', 0),
        'savingsPercent': summary.get('savings_percent', 100)
    }
except:
    token_metrics = {
        'discoveryTokens': 0,
        'readTokens': 0,
        'ratio': 0,
        'savingsPercent': 100
    }

result = {
    'memories': memories,
    'tokenMetrics': token_metrics
}

print(json.dumps(result, default=str))
`;

    const result = await executePythonMemory(script);
    const response: RetrieveResponse = JSON.parse(result.trim());
    return successResponse(response);
  } catch (error) {
    if (error instanceof LokiApiError) {
      throw error;
    }
    // Return empty result if retrieval fails
    const emptyResponse: RetrieveResponse = {
      memories: [],
      tokenMetrics: {
        discoveryTokens: 0,
        readTokens: 0,
        ratio: 0,
        savingsPercent: 100,
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

te = TokenEconomics('api-session', '${MEMORY_BASE_PATH}')
te.load()
summary = te.get_summary()

result = {
    'sessionId': summary.get('session_id', 'unknown'),
    'startedAt': summary.get('started_at', ''),
    'discoveryTokens': summary['metrics'].get('discovery_tokens', 0),
    'readTokens': summary['metrics'].get('read_tokens', 0),
    'ratio': summary.get('ratio', 0),
    'savingsPercent': summary.get('savings_percent', 100),
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
      discoveryTokens: 0,
      readTokens: 0,
      ratio: 0,
      savingsPercent: 100,
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
