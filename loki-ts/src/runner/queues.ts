// Task-queue population for the autonomous runner.
//
// Source-of-truth (bash):
//   populate_bmad_queue()      autonomy/run.sh:9390
//   populate_openspec_queue()  autonomy/run.sh:9619
//   populate_mirofish_queue()  autonomy/run.sh:9730
//   populate_prd_queue()       autonomy/run.sh:9817-10162
//
// Phase 5 first iteration scope:
//   - populatePrdQueue: lean checklist/feature extraction from a markdown PRD,
//     written atomically to .loki/queue/pending.json. Mirrors the bash output
//     shape (bare list of task dicts) and the .prd-populated sentinel file.
//   - The other three populators are stubs that return without throwing so
//     the autonomous loop's tryImport contract is satisfied. Full ports of
//     the BMAD / OpenSpec / MiroFish adapters land in later Phase 5 iters.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import type { RunnerContext } from "./types.ts";

// --- Stubs (Phase 5) -------------------------------------------------------

// STUB: Phase 5 -- BMAD adapter port pending. See run.sh:9390.
export async function populateBmadQueue(_ctx: RunnerContext): Promise<void> {
  return;
}

// STUB: Phase 5 -- OpenSpec adapter port pending. See run.sh:9619.
export async function populateOpenspecQueue(_ctx: RunnerContext): Promise<void> {
  return;
}

// STUB: Phase 5 -- MiroFish adapter port pending. See run.sh:9730.
export async function populateMirofishQueue(_ctx: RunnerContext): Promise<void> {
  return;
}

// --- PRD queue (real) ------------------------------------------------------

interface PrdTask {
  id: string;
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  status: "pending";
  source: "prd";
}

// Read existing pending.json, supporting both bare-list and {tasks: [...]}
// wrapper shapes (run.sh:10078-10091). Returns the task list and the wrapper
// so we can write back in the original format.
function readExisting(path: string): { tasks: PrdTask[]; wrapper: Record<string, unknown> | null } {
  if (!existsSync(path)) return { tasks: [], wrapper: null };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(raw)) return { tasks: raw as PrdTask[], wrapper: null };
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const tasks = Array.isArray(obj["tasks"]) ? (obj["tasks"] as PrdTask[]) : [];
      const { tasks: _drop, ...rest } = obj as { tasks?: unknown };
      return { tasks, wrapper: rest };
    }
  } catch {
    // corrupt JSON -- treat as empty, mirroring bash bare-except behaviour
  }
  return { tasks: [], wrapper: null };
}

// Atomic write via tmp + rename (matches src/runner/state.ts pattern and the
// bash `<path>.tmp.$$` + `mv -f` idiom in run.sh:8740).
function atomicWriteJson(target: string, body: unknown): void {
  const tmp = `${target}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(body, null, 2));
  renameSync(tmp, target);
}

// Extract feature titles from a markdown PRD. We look for top-level bullets
// (`- foo`, `* foo`, `1. foo`) under non-meta `##` sections, plus `###`
// sub-headings. This is a deliberately conservative subset of the bash
// extractor (run.sh:9934-10023) -- enough to seed the queue, sufficient for
// a Phase 5 smoke test, and easy to extend.
function extractFeatures(md: string): string[] {
  const skip = /^(table of contents|overview|introduction|summary|appendix|references|changelog|glossary|background|metrics|roadmap|tech stack|deployment|risks|timeline)\b/i;
  const out: string[] = [];
  const seen = new Set<string>();
  let inSkippedSection = false;

  for (const rawLine of md.split("\n")) {
    const headingMatch = rawLine.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (headingMatch && headingMatch[1] && headingMatch[2] !== undefined) {
      const level = headingMatch[1].length;
      const titleRaw = headingMatch[2];
      // Strip leading "1." or "1.2." numbering before skip-check (run.sh:9886).
      const titleClean = titleRaw.replace(/^\d+(\.\d+)*\.?\s*/, "").trim();
      if (level <= 2) {
        inSkippedSection = skip.test(titleClean);
        continue;
      }
      // ### sub-heading inside a non-skipped section -> feature title.
      if (level === 3 && !inSkippedSection && titleClean.length > 5 && !seen.has(titleClean)) {
        out.push(titleClean);
        seen.add(titleClean);
      }
      continue;
    }
    if (inSkippedSection) continue;
    // Bullet at column 0 only (run.sh:9954 "skip indented sub-bullets").
    if (rawLine.length > 0 && (rawLine[0] === " " || rawLine[0] === "\t")) continue;
    const bulletMatch = rawLine.match(/^(?:\d+[.)]\s*|-\s+|\*\s+)(.+)$/);
    if (bulletMatch && bulletMatch[1]) {
      const text = bulletMatch[1].trim();
      if (text.length > 10 && !seen.has(text)) {
        out.push(text);
        seen.add(text);
      }
    }
  }
  return out;
}

function priorityFor(index: number, total: number): "high" | "medium" | "low" {
  if (total <= 3) return "high";
  const third = total / 3;
  if (index < third) return "high";
  if (index < 2 * third) return "medium";
  return "low";
}

export async function populatePrdQueue(ctx: RunnerContext): Promise<void> {
  const prdPath = ctx.prdPath;
  if (!prdPath || !existsSync(prdPath)) return;

  const queueDir = resolve(ctx.lokiDir, "queue");
  const sentinel = resolve(queueDir, ".prd-populated");
  // Idempotency + adapter-precedence guards (run.sh:9823-9830).
  if (existsSync(sentinel)) return;
  for (const other of [".openspec-populated", ".bmad-populated", ".mirofish-populated"]) {
    if (existsSync(resolve(queueDir, other))) return;
  }

  let md: string;
  try {
    md = readFileSync(prdPath, "utf8");
  } catch {
    return;
  }
  const features = extractFeatures(md);
  if (features.length === 0) return;

  if (!existsSync(queueDir)) mkdirSync(queueDir, { recursive: true });
  const pendingPath = resolve(queueDir, "pending.json");
  const { tasks: existing, wrapper } = readExisting(pendingPath);
  const existingIds = new Set(existing.map((t) => t.id));

  for (let i = 0; i < features.length; i++) {
    const id = `prd-${String(i + 1).padStart(3, "0")}`;
    if (existingIds.has(id)) continue;
    const title = features[i] as string;
    existing.push({
      id,
      title,
      description: title,
      priority: priorityFor(i, features.length),
      status: "pending",
      source: "prd",
    });
  }

  const out: unknown = wrapper ? { ...wrapper, tasks: existing } : existing;
  atomicWriteJson(pendingPath, out);
  writeFileSync(sentinel, "");
}
