/**
 * Loki Mode Memory API Type Definitions
 *
 * Types for the memory system HTTP API endpoints.
 */

// -----------------------------------------------------------------------------
// Token Economics Types (defined first as they are used by other types)
// -----------------------------------------------------------------------------

export interface TokenMetrics {
  discoveryTokens: number;
  readTokens: number;
  ratio: number;
  savingsPercent: number;
}

export interface ThresholdAction {
  actionType: string;
  priority: number;
  description: string;
  triggeredBy: string;
}

export interface TokenEconomicsDetail extends TokenMetrics {
  sessionId: string;
  startedAt: string;
  layer1Loads: number;
  layer2Loads: number;
  layer3Loads: number;
  cacheHits: number;
  cacheMisses: number;
  thresholdsTriggered: ThresholdAction[];
}

// -----------------------------------------------------------------------------
// Summary Types
// -----------------------------------------------------------------------------

export interface MemorySummary {
  episodic: {
    count: number;
    latestDate: string | null;
  };
  semantic: {
    patterns: number;
    antiPatterns: number;
  };
  procedural: {
    skills: number;
  };
  tokenEconomics: TokenMetrics | null;
}

// -----------------------------------------------------------------------------
// Episode Types
// -----------------------------------------------------------------------------

export interface EpisodeSummary {
  id: string;
  taskId: string;
  timestamp: string;
  agent: string;
  phase: string;
  outcome: string;
}

export interface ActionEntry {
  t: number;
  action: string;
  target: string;
  result: string;
}

export interface ErrorEntry {
  type: string;
  message: string;
  resolution: string;
}

export interface EpisodeDetail extends EpisodeSummary {
  goal: string;
  durationSeconds: number;
  actionLog: ActionEntry[];
  errorsEncountered: ErrorEntry[];
  artifactsProduced: string[];
  gitCommit: string | null;
  tokensUsed: number;
  filesRead: string[];
  filesModified: string[];
}

// -----------------------------------------------------------------------------
// Pattern Types
// -----------------------------------------------------------------------------

export interface Link {
  to: string;
  relation: string;
  strength: number;
}

export interface PatternSummary {
  id: string;
  pattern: string;
  category: string;
  confidence: number;
  usageCount: number;
}

export interface PatternDetail extends PatternSummary {
  conditions: string[];
  correctApproach: string;
  incorrectApproach: string;
  sourceEpisodes: string[];
  lastUsed: string | null;
  links: Link[];
}

// -----------------------------------------------------------------------------
// Skill Types
// -----------------------------------------------------------------------------

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
}

export interface SkillDetail extends SkillSummary {
  prerequisites: string[];
  steps: string[];
  commonErrors: { error: string; fix: string }[];
  exitCriteria: string[];
  exampleUsage?: string;
}

// -----------------------------------------------------------------------------
// Request/Response Types
// -----------------------------------------------------------------------------

export interface RetrieveRequest {
  query: string;
  taskType?: string;
  topK?: number;
}

export interface MemoryEntry {
  id: string;
  source: "episodic" | "semantic" | "skills" | "anti_patterns";
  score: number;
  content: Record<string, unknown>;
}

export interface RetrieveResponse {
  memories: MemoryEntry[];
  tokenMetrics: TokenMetrics;
}

export interface ConsolidateRequest {
  sinceHours?: number;
}

export interface ConsolidateResponse {
  patternsCreated: number;
  patternsMerged: number;
  antiPatternsCreated: number;
  linksCreated: number;
  episodesProcessed: number;
  durationSeconds: number;
}

// -----------------------------------------------------------------------------
// Index and Timeline Types
// -----------------------------------------------------------------------------

export interface IndexLayer {
  version: string;
  lastUpdated: string;
  topics: TopicEntry[];
  totalMemories: number;
  totalTokensAvailable: number;
}

export interface TopicEntry {
  id: string;
  summary: string;
  relevanceScore: number;
  lastAccessed: string | null;
  tokenCount: number;
}

export interface TimelineLayer {
  version: string;
  lastUpdated: string;
  recentActions: TimelineAction[];
  keyDecisions: string[];
  activeContext: {
    currentFocus: string | null;
    blockedBy: string[];
    nextUp: string[];
  };
}

export interface TimelineAction {
  timestamp: string;
  action: string;
  outcome: string;
  topicId: string;
}

// -----------------------------------------------------------------------------
// Query Parameters
// -----------------------------------------------------------------------------

export interface EpisodesQueryParams {
  since?: string; // ISO date string
  limit?: number;
}

export interface PatternsQueryParams {
  category?: string;
  minConfidence?: number;
}
