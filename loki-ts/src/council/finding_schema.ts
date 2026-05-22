// loki-ts/src/council/finding_schema.ts -- Phase C (v7.5.20) helpers.
//
// Loads the static JSON Schema from loki-ts/data/finding-schema.json and
// provides minimal manual validation + multi-response parsing. Both bash and
// Bun routes consume the SAME schema file (see architect design Phase C).
//
// Why manual validation (no ajv): adding ajv pulls in ~200KB of runtime deps
// for a 4-field check. We only validate the small set required by the
// AgentVerdict reconciliation: required fields, vote enum, confidence range.
// Optional fields (severity, suggested_action, issues) are tolerated when
// well-typed and silently dropped otherwise -- the schema file remains the
// authoritative spec for upstream Claude consumers.
//
// Reconciliation with AgentVerdict (council.ts:128-133):
//   schema.findings[i].vote        -> AgentVerdict.verdict
//   schema.findings[i].confidence  -> dropped (not on AgentVerdict in v7.5.20)
//   schema.findings[i].severity    -> dropped (top-level hint; issues carry it)
//   schema.findings[i].suggested_action -> dropped (carried in transcripts only)
//   schema.findings[i].issues      -> mapped onto AgentVerdict.issues
//
// Public API:
//   FINDING_SCHEMA            -- the parsed JSON Schema object (frozen)
//   validateFinding(obj)      -> AgentVerdict | { error, path }
//   parseMultiResponse(text)  -> AgentVerdict[]  (throws on malformed JSON)

import { readFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentVerdict, Severity } from "../runner/council.ts";

// Resolve the schema file path relative to this module so both runtime
// (Bun.spawn callers in CI) and bundled callers work.
const _moduleDir = dirname(fileURLToPath(import.meta.url));
const _schemaPath = resolvePath(_moduleDir, "..", "..", "data", "finding-schema.json");

export const FINDING_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze(
  JSON.parse(readFileSync(_schemaPath, "utf8")) as Record<string, unknown>,
);

const VOTE_ENUM = new Set(["APPROVE", "REJECT", "CANNOT_VALIDATE"]);
const SEVERITY_ENUM = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);

export type ValidationError = { error: string; path: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Manual validator. Returns AgentVerdict on success, structured error otherwise.
// Validates required fields, vote enum, confidence range; tolerates optional
// fields and drops them from the AgentVerdict output.
export function validateFinding(obj: unknown): AgentVerdict | ValidationError {
  if (!isRecord(obj)) {
    return { error: "finding must be an object", path: "$" };
  }
  if (typeof obj["role"] !== "string" || obj["role"].length === 0) {
    return { error: "role must be a non-empty string", path: "$.role" };
  }
  if (typeof obj["vote"] !== "string" || !VOTE_ENUM.has(obj["vote"])) {
    return {
      error: `vote must be one of APPROVE|REJECT|CANNOT_VALIDATE, got ${JSON.stringify(obj["vote"])}`,
      path: "$.vote",
    };
  }
  if (typeof obj["reason"] !== "string" || obj["reason"].length === 0) {
    return { error: "reason must be a non-empty string", path: "$.reason" };
  }
  if (obj["reason"].length > 4000) {
    return { error: "reason exceeds 4000 chars", path: "$.reason" };
  }
  if (typeof obj["confidence"] !== "number" || !Number.isFinite(obj["confidence"])) {
    return { error: "confidence must be a finite number", path: "$.confidence" };
  }
  const conf = obj["confidence"] as number;
  if (conf < 0 || conf > 1) {
    return { error: `confidence must be in [0,1], got ${conf}`, path: "$.confidence" };
  }

  // Optional issues array. Tolerated when present; mapped onto AgentVerdict.issues.
  const issuesOut: AgentVerdict["issues"] = [];
  const rawIssues = obj["issues"];
  if (rawIssues !== undefined) {
    if (!Array.isArray(rawIssues)) {
      return { error: "issues must be an array when present", path: "$.issues" };
    }
    for (let i = 0; i < rawIssues.length; i++) {
      const it = rawIssues[i];
      if (!isRecord(it)) {
        return { error: "issue must be an object", path: `$.issues[${i}]` };
      }
      const sev = it["severity"];
      const desc = it["description"];
      if (typeof sev !== "string" || !SEVERITY_ENUM.has(sev)) {
        return { error: "issue.severity must be CRITICAL|HIGH|MEDIUM|LOW", path: `$.issues[${i}].severity` };
      }
      if (typeof desc !== "string" || desc.length === 0) {
        return { error: "issue.description must be a non-empty string", path: `$.issues[${i}].description` };
      }
      issuesOut.push({ severity: sev as Severity, description: desc });
    }
  }

  return {
    role: obj["role"],
    verdict: obj["vote"] as AgentVerdict["verdict"],
    reason: obj["reason"],
    issues: issuesOut,
  };
}

// parseMultiResponse extracts the first JSON object from Claude's output text
// and validates each finding. Throws on malformed JSON or on schema-level
// errors (missing top-level findings, empty array, per-finding validation).
// Caller (dispatchClaudeAgents) catches throw and falls through to heuristic.
export function parseMultiResponse(text: string): AgentVerdict[] {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("empty response text");
  }
  // Find the first balanced JSON object in the text. Claude may emit prose
  // before/after the JSON block; we extract the substring between the first
  // '{' and its matching '}'.
  const firstBrace = text.indexOf("{");
  if (firstBrace < 0) {
    throw new Error("no JSON object found in response");
  }
  // Walk forward, counting braces (naive but handles the common case where
  // strings don't contain unbalanced braces; Claude's structured output is
  // simple JSON, not arbitrary text with brace-like content in strings).
  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx < 0) {
    throw new Error("unbalanced JSON braces in response");
  }
  const jsonStr = text.slice(firstBrace, endIdx + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`malformed JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("response must be a JSON object");
  }
  const findings = parsed["findings"];
  if (!Array.isArray(findings)) {
    throw new Error("response.findings must be an array");
  }
  if (findings.length === 0) {
    throw new Error("response.findings must be non-empty");
  }

  const out: AgentVerdict[] = [];
  for (let i = 0; i < findings.length; i++) {
    const r = validateFinding(findings[i]);
    if ("error" in r) {
      throw new Error(`findings[${i}] validation: ${r.error} (${r.path})`);
    }
    out.push(r);
  }
  return out;
}
