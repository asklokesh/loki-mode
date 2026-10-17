// MARK-2: per-change AI-BOM as a CycloneDX 1.7 document with ML-BOM components. Pure: receipt plus config in,
// object out. No network, no file reads, no spawn. The writer hook is MARK-3. It lists what ran; it makes no claim
// about legal sufficiency of anything.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getVersion } from "../version.ts";

export const AI_BOM_SPEC_VERSION = "1.7";
const UNKNOWN = "unknown";

export interface AiBomReceipt { run_id: string; provider: string; model: string; receipt_sha256: string }
export interface AiBomInput {
  receipt: AiBomReceipt;
  harnessVersion: string;
  /** Only when known from a trusted source; otherwise the BOM says "unknown". Never derived from the model name. */
  modelVersion?: string;
  /** Models the run recorded. When given (even empty) it replaces the single receipt model, so nothing is guessed. */
  models?: string[];
  tools?: string[];
  mcpServers?: string[];
  /** ISO timestamp; injected so output is deterministic. */
  now?: string;
}
export interface BomComponent { type: string; "bom-ref": string; name: string; version?: string; publisher?: string; properties?: { name: string; value: string }[] }
export interface AiBom {
  bomFormat: "CycloneDX";
  specVersion: string;
  serialNumber: string;
  version: 1;
  metadata: {
    timestamp: string;
    tools: { components: { type: string; name: string; version: string }[] };
    component: { type: string; name: string; "bom-ref": string };
    properties: { name: string; value: string }[];
  };
  components: BomComponent[];
}

const nz = (s: unknown): string => (typeof s === "string" && s.trim() !== "" ? s.trim() : UNKNOWN);

/** Server names only, from a `{ mcpServers: { name: {...} } }` bundle. Config bodies (env, args) are never read out. */
export function mcpServerNames(bundle: unknown): string[] {
  const s = bundle && typeof bundle === "object" ? (bundle as Record<string, unknown>)["mcpServers"] : undefined;
  return s && typeof s === "object" && !Array.isArray(s) ? Object.keys(s as object) : [];
}

/** A v4-shaped UUID derived from the receipt hash so the same receipt always yields the same serialNumber. */
function serialFrom(sha: string): string {
  const h = createHash("sha256").update(sha).digest("hex");
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function buildAiBom(i: AiBomInput): AiBom {
  const r = i.receipt, provider = nz(r.provider), model = nz(r.model);
  const seen = new Set<string>();
  const comps: BomComponent[] = [];
  const add = (c: BomComponent): void => { if (!seen.has(c["bom-ref"])) { seen.add(c["bom-ref"]); comps.push(c); } };
  for (const m of i.models ?? [model]) add({ type: "machine-learning-model", "bom-ref": `model:${provider}:${nz(m)}`, publisher: provider, name: nz(m), version: nz(i.modelVersion) });
  for (const t of i.tools ?? []) add({ type: "application", "bom-ref": `tool:${t}`, name: t });
  for (const m of i.mcpServers ?? []) add({ type: "application", "bom-ref": `mcp:${m}`, name: m, properties: [{ name: "loki:kind", value: "mcp-server" }] });
  const runRef = `run:${nz(r.run_id)}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: AI_BOM_SPEC_VERSION,
    serialNumber: serialFrom(r.receipt_sha256),
    version: 1,
    metadata: {
      timestamp: i.now ?? new Date().toISOString(),
      tools: { components: [{ type: "application", name: "loki-mode", version: nz(i.harnessVersion) }] },
      component: { type: "application", name: runRef, "bom-ref": runRef },
      properties: [{ name: "loki:receipt_sha256", value: r.receipt_sha256 }],
    },
    components: comps,
  };
}

export const AI_BOM_FILE = "ai-bom.cdx.json";
export interface SealedReceipt { run_id: string; provider: string; model: string; receipt_sha256: string; cost?: { per_model?: Record<string, unknown> } }

/** Names that look like a path, an env assignment or a credential are dropped, never written. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}(\/[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127})?$/;
const SECRETISH = /^(sk[-_]|gh[pousr]_|github_pat_|glpat-|xox|AKIA|ASIA|AIza|npm_|hf_|eyJ)/i;
const safe = (s: unknown): string | null => { const t = typeof s === "string" ? s.trim() : ""; return SAFE_NAME.test(t) && !t.split("/").some((p) => SECRETISH.test(p)) ? t : null; };

/** MARK-3: after the seal, write the BOM next to the receipt from what the run recorded. Throws on I/O failure; the caller (seal) swallows it. */
export function writeAiBom(runDir: string, r: SealedReceipt): void {
  const recorded = Object.keys(r.cost?.per_model ?? {}).map(safe).filter((m): m is string => m !== null);
  const one = safe(r.model);
  const models = recorded.length > 0 ? recorded : one ? [one] : [];
  const provider = safe(r.provider);
  const bom = buildAiBom({
    receipt: { run_id: safe(r.run_id) ?? UNKNOWN, provider: provider ?? UNKNOWN, model: UNKNOWN, receipt_sha256: r.receipt_sha256 },
    harnessVersion: getVersion(), models, tools: provider && models.length > 0 ? [provider] : [],
  });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, AI_BOM_FILE), JSON.stringify(bom, null, 2) + "\n");
}
