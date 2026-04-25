// Task-queue population for the autonomous runner.
//
// Source-of-truth (bash):
//   populate_bmad_queue()      autonomy/run.sh:9390
//   populate_openspec_queue()  autonomy/run.sh:9619
//   populate_mirofish_queue()  autonomy/run.sh:9730
//   populate_prd_queue()       autonomy/run.sh:9817-10162
//
// Phase 5 second iteration scope:
//   - populatePrdQueue: lean checklist/feature extraction from a markdown PRD,
//     written atomically to .loki/queue/pending.json.
//   - populateBmadQueue: scans .loki/bmad/ for *.md story files; one task per
//     file (or per `## heading` for multi-story files). Idempotent via
//     .bmad-populated sentinel.
//   - populateOpenspecQueue: scans .loki/openspec/ for spec-*.md files; one
//     task per spec. Idempotent via .openspec-populated sentinel.
//   - populateMirofishQueue: still a stub (other agent owns it).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import type { RunnerContext } from "./types.ts";

// --- MiroFish queue (real) ------------------------------------------------
//
// Source: autonomy/run.sh:9730-9817 (populate_mirofish_queue).
// Reads .loki/mirofish-tasks.json (advisory data from the MiroFish market-
// validation step), converts each entry into the shared queue task shape,
// merges into pending.json (deduping by id), and drops a .mirofish-populated
// sentinel so subsequent calls are no-ops -- all idempotent and atomic.
export async function populateMirofishQueue(ctx: RunnerContext): Promise<void> {
  const queueDir = resolve(ctx.lokiDir, "queue");
  const sentinel = resolve(queueDir, ".mirofish-populated");
  const advisoryPath = resolve(ctx.lokiDir, "mirofish-tasks.json");

  if (!existsSync(advisoryPath)) return;
  if (existsSync(sentinel)) return;

  let advisories: unknown;
  try {
    advisories = JSON.parse(readFileSync(advisoryPath, "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(advisories) || advisories.length === 0) return;

  if (!existsSync(queueDir)) mkdirSync(queueDir, { recursive: true });
  const pendingPath = resolve(queueDir, "pending.json");
  const { tasks: existing, wrapper } = readExisting(pendingPath);
  const existingIds = new Set(existing.map((t) => t.id));

  let added = 0;
  for (let i = 0; i < advisories.length; i++) {
    const raw = advisories[i];
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const idVal = typeof a["id"] === "string" ? a["id"] : `mirofish-${String(i + 1).padStart(3, "0")}`;
    if (existingIds.has(idVal)) continue;
    const titleVal = typeof a["title"] === "string" ? a["title"] : `MiroFish Advisory ${i + 1}`;
    const descVal = typeof a["description"] === "string" ? a["description"] : "";
    const priorityVal: "high" | "medium" | "low" =
      a["priority"] === "high" || a["priority"] === "low" ? a["priority"] : "medium";
    const entry: PrdTask & { category?: string } = {
      id: idVal,
      title: titleVal,
      description: descVal,
      priority: priorityVal,
      status: "pending",
      source: "mirofish",
    };
    if (typeof a["category"] === "string") entry.category = a["category"];
    existing.push(entry);
    existingIds.add(idVal);
    added++;
  }

  if (added === 0) {
    // Drop sentinel anyway -- avoids re-scanning a stable advisory file when
    // every advisory already lives in pending.json (matches BMAD/OpenSpec idiom).
    writeFileSync(sentinel, "");
    return;
  }

  const out: unknown = wrapper ? { ...wrapper, tasks: existing } : existing;
  atomicWriteJson(pendingPath, out);
  writeFileSync(sentinel, "");
}

// --- PRD queue (real) ------------------------------------------------------

interface PrdTask {
  id: string;
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  status: "pending";
  source: "prd" | "bmad" | "openspec" | "mirofish";
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

// --- Markdown directory helpers (shared by BMAD + OpenSpec) ---------------

// List markdown files in `dir` matching `predicate(name)`. Non-recursive,
// sorted, deterministic. Hidden entries (leading dot) are skipped. Returns
// [] if the directory is missing or unreadable.
function listMarkdownFiles(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (!name.toLowerCase().endsWith(".md")) continue;
    if (!predicate(name)) continue;
    const full = resolve(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    out.push(full);
  }
  out.sort();
  return out;
}

function basenameNoExt(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

// Extract the first H1 (`# heading`) title from a markdown body, falling back
// to the supplied default (typically the file basename without extension).
function titleFromBody(body: string, fallback: string): string {
  for (const line of body.split("\n")) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m && m[1]) return m[1].trim();
  }
  return fallback;
}

interface StoryStub {
  title: string;
  description: string;
}

// Split a markdown file into per-`## heading` story stubs. Files with no
// `##` headings collapse to a single story (title = H1 or filename).
// Description is the first non-empty, non-heading line in the section.
function splitStories(body: string, fallbackTitle: string): StoryStub[] {
  const lines = body.split("\n");
  const headings: { idx: number; title: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m && m[1]) headings.push({ idx: i, title: m[1].trim() });
  }
  if (headings.length === 0) {
    const title = titleFromBody(body, fallbackTitle);
    return [{ title, description: title }];
  }
  const out: StoryStub[] = [];
  for (let h = 0; h < headings.length; h++) {
    const cur = headings[h]!;
    const nextIdx = h + 1 < headings.length ? headings[h + 1]!.idx : lines.length;
    const sectionLines = lines.slice(cur.idx + 1, nextIdx);
    let description = cur.title;
    for (const sl of sectionLines) {
      const trimmed = sl.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith("#")) continue;
      description = trimmed;
      break;
    }
    out.push({ title: cur.title, description });
  }
  return out;
}

// --- BMAD queue (real) -----------------------------------------------------

export async function populateBmadQueue(ctx: RunnerContext): Promise<void> {
  const bmadDir = resolve(ctx.lokiDir, "bmad");
  const queueDir = resolve(ctx.lokiDir, "queue");
  const sentinel = resolve(queueDir, ".bmad-populated");

  if (existsSync(sentinel)) return;
  const files = listMarkdownFiles(bmadDir, () => true);
  if (files.length === 0) return;

  const stories: StoryStub[] = [];
  for (const file of files) {
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const stub of splitStories(body, basenameNoExt(file))) {
      if (stub.title.length === 0) continue;
      stories.push(stub);
    }
  }
  if (stories.length === 0) return;

  if (!existsSync(queueDir)) mkdirSync(queueDir, { recursive: true });
  const pendingPath = resolve(queueDir, "pending.json");
  const { tasks: existing, wrapper } = readExisting(pendingPath);
  const existingIds = new Set(existing.map((t) => t.id));

  let added = 0;
  for (let i = 0; i < stories.length; i++) {
    const id = `bmad-${String(i + 1).padStart(3, "0")}`;
    if (existingIds.has(id)) continue;
    const stub = stories[i]!;
    existing.push({
      id,
      title: stub.title,
      description: stub.description,
      priority: priorityFor(i, stories.length),
      status: "pending",
      source: "bmad",
    });
    existingIds.add(id);
    added++;
  }

  if (added === 0) {
    // Drop sentinel anyway -- avoids re-scanning a stable .loki/bmad/ when
    // every story already lives in pending.json (e.g. crash-restart).
    writeFileSync(sentinel, "");
    return;
  }

  const out: unknown = wrapper ? { ...wrapper, tasks: existing } : existing;
  atomicWriteJson(pendingPath, out);
  writeFileSync(sentinel, "");
}

// --- OpenSpec queue (real) -------------------------------------------------

export async function populateOpenspecQueue(ctx: RunnerContext): Promise<void> {
  const specDir = resolve(ctx.lokiDir, "openspec");
  const queueDir = resolve(ctx.lokiDir, "queue");
  const sentinel = resolve(queueDir, ".openspec-populated");

  if (existsSync(sentinel)) return;
  const files = listMarkdownFiles(specDir, (name) => name.toLowerCase().startsWith("spec-"));
  if (files.length === 0) return;

  interface SpecStub {
    title: string;
    description: string;
  }
  const specs: SpecStub[] = [];
  for (const file of files) {
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const fallback = basenameNoExt(file);
    const title = titleFromBody(body, fallback);
    if (title.length === 0) continue;
    specs.push({ title, description: `[OpenSpec] ${title}` });
  }
  if (specs.length === 0) return;

  if (!existsSync(queueDir)) mkdirSync(queueDir, { recursive: true });
  const pendingPath = resolve(queueDir, "pending.json");
  const { tasks: existing, wrapper } = readExisting(pendingPath);
  const existingIds = new Set(existing.map((t) => t.id));

  let added = 0;
  for (let i = 0; i < specs.length; i++) {
    const id = `openspec-${String(i + 1).padStart(3, "0")}`;
    if (existingIds.has(id)) continue;
    const stub = specs[i]!;
    existing.push({
      id,
      title: stub.title,
      description: stub.description,
      priority: priorityFor(i, specs.length),
      status: "pending",
      source: "openspec",
    });
    existingIds.add(id);
    added++;
  }

  if (added === 0) {
    writeFileSync(sentinel, "");
    return;
  }

  const out: unknown = wrapper ? { ...wrapper, tasks: existing } : existing;
  atomicWriteJson(pendingPath, out);
  writeFileSync(sentinel, "");
}
