import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./paths.ts";
import { presetExecutor, routerPreset } from "../runner/router/flag.ts";

/** Recorded when a claude run has no configured model: the provider CLI runs its own default, exactly like raw `claude -p` (L1). */
export const PROVIDER_DEFAULT_MODEL = "claude (provider default)";

const FAMILY_ALIASES = new Set(["haiku", "sonnet", "opus", "fable"]);

/** Resolves a Claude cli_alias (haiku, sonnet, opus, fable) to its providers/model_catalog.json id; an id already, or an unknown alias, passes through unchanged. Catalog is located via REPO_ROOT (works from src and dist) and honours LOKI_MODEL_CATALOG. */
export function resolveClaudeModel(want: string): string {
  try {
    const path = process.env["LOKI_MODEL_CATALOG"] || resolve(REPO_ROOT, "providers/model_catalog.json");
    return JSON.parse(readFileSync(path, "utf8")).providers?.claude?.cli_aliases?.[want] ?? want;
  } catch {
    return want;
  }
}

/** True when a model string is still a bare family alias, which the API would reject with a 404. */
export function isUnresolvedClaudeAlias(model: string): boolean {
  return FAMILY_ALIASES.has(model);
}

/**
 * Strength rank of a Claude model from the catalog's own tier order: the order tiers first appear in the claude models[] (the catalog
 * says position is load-bearing), skipping legacy. 0 is the strongest tier. Null for an unknown model or an unreadable catalog, so a
 * caller never rejects on a guess.
 */
export function claudeTierRank(model: string): number | null {
  try {
    const path = process.env["LOKI_MODEL_CATALOG"] || resolve(REPO_ROOT, "providers/model_catalog.json");
    const models = JSON.parse(readFileSync(path, "utf8")).providers?.claude?.models as Array<{ id: string; alias?: string; tier: string }> | undefined;
    if (!Array.isArray(models)) return null;
    const order: string[] = [];
    for (const m of models) if (m.tier !== "legacy" && !order.includes(m.tier)) order.push(m.tier);
    const id = resolveClaudeModel(model);
    const hit = models.find((m) => m.id === id || m.alias === model);
    const rank = hit ? order.indexOf(hit.tier) : -1;
    return rank >= 0 ? rank : null;
  } catch {
    return null;
  }
}

/**
 * Effort levels the catalog records for a Claude model (providers.claude.models[].effort.levels), ordered low to max. Null when the
 * model is unknown, the catalog is unreadable, or the entry records no capability data, so a caller never clamps on a guess. An empty
 * array means the model accepts no effort parameter.
 */
export function claudeEffortLevels(model: string): string[] | null {
  try {
    const path = process.env["LOKI_MODEL_CATALOG"] || resolve(REPO_ROOT, "providers/model_catalog.json");
    const models = JSON.parse(readFileSync(path, "utf8")).providers?.claude?.models as Array<{ id: string; alias?: string; effort?: { levels?: string[] } }> | undefined;
    if (!Array.isArray(models)) return null;
    const id = resolveClaudeModel(model);
    const levels = models.find((m) => m.id === id || m.alias === model)?.effort?.levels;
    return Array.isArray(levels) ? levels : null;
  } catch {
    return null;
  }
}

interface ThinkingSpec { types?: string[]; max_effort?: Record<string, string>; substitute?: Record<string, string> }

function claudeThinkingSpec(model: string): ThinkingSpec | null {
  try {
    const path = process.env["LOKI_MODEL_CATALOG"] || resolve(REPO_ROOT, "providers/model_catalog.json");
    const models = JSON.parse(readFileSync(path, "utf8")).providers?.claude?.models as Array<{ id: string; alias?: string; thinking?: ThinkingSpec }> | undefined;
    if (!Array.isArray(models)) return null;
    const id = resolveClaudeModel(model);
    return models.find((m) => m.id === id || m.alias === model)?.thinking ?? null;
  } catch {
    return null;
  }
}

/**
 * Highest effort level at which the catalog records a model accepting a thinking type (providers.claude.models[].thinking.max_effort,
 * keyed by type). Null when the model is unknown, the catalog is unreadable, or no limit is recorded for that type, so a caller never
 * clamps on a guess. Example: the previous Opus generation accepts "disabled" only at "high" or below.
 */
export function claudeThinkingMaxEffort(model: string, type: string): string | null {
  const max = claudeThinkingSpec(model)?.max_effort?.[type];
  return typeof max === "string" ? max : null;
}

/**
 * The thinking type the catalog says to send in place of a requested one (providers.claude.models[].thinking.substitute). Null when
 * none is recorded. Example: the current Sonnet generation rejects "disabled" at every effort, so "disabled" is sent as "between_tools".
 */
export function claudeThinkingSubstitute(model: string, type: string): string | null {
  const sub = claudeThinkingSpec(model)?.substitute?.[type];
  return typeof sub === "string" ? sub : null;
}

/**
 * False when the catalog lists thinking.types for the model, the requested type is not among them, and no substitute is recorded for it,
 * so the API would answer 400 at every effort. True when the model, the catalog entry or the types list is unknown: never refuse on a guess.
 */
export function claudeThinkingAccepted(model: string, type: string): boolean {
  const spec = claudeThinkingSpec(model);
  if (!spec || !Array.isArray(spec.types)) return true;
  return spec.types.includes(type) || typeof spec.substitute?.[type] === "string";
}

/** Whether the catalog lists adaptive for the model (the type every clamp falls back to). */
export function claudeThinkingHasAdaptive(model: string): boolean {
  const types = claudeThinkingSpec(model)?.types;
  return Array.isArray(types) && types.includes("adaptive");
}

/** Session-pin values run.sh's LOKI_SESSION_MODEL case accepts: the three tier names plus the Claude aliases (opus is the top-only setting; bash dispatches it as opus, not as the sonnet-defaulted planning tier). */
export const VALID_TIERS = new Set(["planning", "development", "fast", "opus", "sonnet", "haiku", "fable"]);

/** Generic capability tiers: small|medium|high -> the canonical tier names, so downstream consumers only ever see the names in VALID_TIERS. Mirrors loki_tier_alias() in providers/models.sh. */
export const GENERIC_TIERS: Record<string, string> = {
  small: "fast",
  medium: "development",
  high: "planning",
};

/**
 * The canonical session pin for a raw LOKI_SESSION_MODEL: trim and lowercase (run.sh's session-pin rule), generic tiers translated.
 * Undefined when unset or blank. Throws on any other value, naming the valid set, so a pin is run or refused and never replaced by the provider default.
 */
export function canonicalSessionPin(raw: string | undefined): string | undefined {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return undefined;
  const pin = GENERIC_TIERS[v] ?? v;
  if (!VALID_TIERS.has(pin)) {
    throw new Error(`unknown LOKI_SESSION_MODEL '${(raw ?? "").trim()}' (small|medium|high, planning|development|fast, or opus|sonnet|haiku|fable)`);
  }
  return pin;
}

/**
 * Explicit top / floor setup, the one rule for every Bun surface: LOKI_SESSION_MODEL high|planning gives opus for the planning tier,
 * small|fast gives haiku for the fast tier (only while LOKI_ALLOW_HAIKU is unset or "true"). Never under legacy tier switching and
 * never over an explicit per-tier pin. Undefined means no setup applies. Mirrors claude.sh resolve_model_for_tier.
 */
export function explicitSetupModel(tier: string, e: NodeJS.ProcessEnv = process.env): string | undefined {
  if (e["LOKI_LEGACY_TIER_SWITCHING"] === "true") return undefined;
  const sess = (e["LOKI_SESSION_MODEL"] ?? "").trim().toLowerCase();
  if (tier === "planning" && (sess === "high" || sess === "planning")) return e["LOKI_CLAUDE_MODEL_PLANNING"] || e["LOKI_MODEL_PLANNING"] ? undefined : "opus";
  if (tier !== "fast" || (sess !== "small" && sess !== "fast") || e["LOKI_CLAUDE_MODEL_FAST"] || e["LOKI_MODEL_FAST"]) return undefined;
  return e["LOKI_ALLOW_HAIKU"] === undefined || e["LOKI_ALLOW_HAIKU"] === "true" ? "haiku" : undefined;
}

/** acc-156: the session model a claude run uses when the user names none. One line to change (the h2 threshold verdict may make it "haiku"). */
export const DEFAULT_SESSION_MODEL = "sonnet";
/** Env vars that name a model choice; any one set means the user chose, and the default never applies. Catalog path, base URL and key are not choices. */
export const EXPLICIT_MODEL_ENV = ["LOKI_SESSION_MODEL", "LOKI_MODEL_OVERRIDE", "LOKI_MODEL_ROUTE", "LOKI_MODEL_DEVELOPMENT", "LOKI_MODEL_PLANNING", "LOKI_MODEL_FAST", "LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_CLAUDE_MODEL_PLANNING", "LOKI_CLAUDE_MODEL_FAST"] as const;
export interface SessionModelChoice { source: "explicit" | "default" | "provider"; pin: string | null; why: string }
/**
 * Which model a claude run starts with, and why. An explicit --session-model (bin/loki exports it as LOKI_SESSION_MODEL), any EXPLICIT_MODEL_ENV var, or the model router being on wins;
 * else LOKI_DEFAULT_SESSION_MODEL (a session pin value, or "provider" for the CLI's own default, the pre-acc-156 behavior), else DEFAULT_SESSION_MODEL.
 * pin is the LOKI_SESSION_MODEL value to export when source is "default", so the default run is exactly a `--session-model <pin>` run. Throws on an unknown value.
 */
export function chooseSessionModel(e: NodeJS.ProcessEnv = process.env): SessionModelChoice {
  const carried = canonicalSessionPin(e["LOKI_SESSION_MODEL"]); // a slice or child of a run that already applied the default keeps it as the default
  if (e["LOKI_SESSION_MODEL_SOURCE"] === "default" && carried && EXPLICIT_MODEL_ENV.every((k) => k === "LOKI_SESSION_MODEL" || (e[k] ?? "").trim() === "")) return { source: "default", pin: carried, why: "Loki default, carried from the parent run" };
  const named = EXPLICIT_MODEL_ENV.find((k) => (e[k] ?? "").trim() !== "");
  if (named) return { source: "explicit", pin: null, why: named === "LOKI_SESSION_MODEL" ? "--session-model or LOKI_SESSION_MODEL" : named };
  const router = (e["LOKI_ROUTER"] ?? "").trim().toLowerCase(); // the model router (LOKI_ROUTER=on|auto, also --haiku and --cost lean) picks each unit's model itself; a pin would switch it off
  if (["1", "true", "on", "auto"].includes(router)) return { source: "explicit", pin: null, why: `LOKI_ROUTER=${router}` };
  const raw = (e["LOKI_DEFAULT_SESSION_MODEL"] ?? "").trim().toLowerCase();
  if (raw === "provider") return { source: "provider", pin: null, why: "LOKI_DEFAULT_SESSION_MODEL=provider (the Claude CLI's own default)" };
  const pin = canonicalSessionPin(raw || DEFAULT_SESSION_MODEL)!;
  return { source: "default", pin, why: raw ? `LOKI_DEFAULT_SESSION_MODEL=${raw}` : "Loki default, set another with --session-model or LOKI_DEFAULT_SESSION_MODEL=provider" };
}

/** Q1 HAIKU-SCOPE: true when this run will implement on Haiku, as far as the environment decides it before any session. Covered, in the order the
 *  engine resolves the implement model (engine10/session.ts resolveModel, runner/router): opencode with a Haiku LOKI_OPENCODE_MODEL; LOKI_MODEL_OVERRIDE,
 *  LOKI_MODEL_ROUTE, LOKI_CLAUDE_MODEL_DEVELOPMENT or LOKI_MODEL_DEVELOPMENT naming Haiku; a session pin (--session-model, LOKI_SESSION_MODEL, or the default
 *  chooseSessionModel applies, LOKI_DEFAULT_SESSION_MODEL) of haiku, or of small/fast whose fast tier is Haiku; LOKI_ROUTER=auto (also --haiku and
 *  --cost lean) with no pin, whose executor is Haiku unless LOKI_ALLOW_HAIKU=false or LOKI_ROUTER_EXECUTOR names another. Not covered: LOKI_ROUTER=1, where
 *  the plan session's route record may send implement to Haiku after this decision. LOKI_ALLOW_HAIKU=true alone moves only the fast tier (plan), not implement. */
export function haikuRun(e: NodeJS.ProcessEnv = process.env): boolean {
  const H = /haiku/i, val = (k: string): string => (e[k] ?? "").trim();
  const dev = roleModel("dev", e); if (dev !== undefined) return H.test(dev); // ROLE-MODELS: a dev role is the implement model, ahead of every rule below
  if (val("LOKI_PROVIDER").toLowerCase() === "opencode") return H.test(val("LOKI_OPENCODE_MODEL"));
  for (const k of ["LOKI_MODEL_OVERRIDE", "LOKI_MODEL_ROUTE", "LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_MODEL_DEVELOPMENT"]) if (val(k)) return H.test(val(k));
  let pin: string | undefined;
  try { pin = canonicalSessionPin(e["LOKI_SESSION_MODEL"]) ?? chooseSessionModel(e).pin ?? undefined; } catch { return false; } // an unknown pin is refused by the engine before any run
  if (pin === "haiku") return true;
  if (pin === "fast") return H.test(explicitSetupModel("fast", e) ?? (val("LOKI_CLAUDE_MODEL_FAST") || val("LOKI_MODEL_FAST") || (e["LOKI_ALLOW_HAIKU"] === "true" ? "haiku" : "sonnet")));
  if (pin) return false;
  return routerPreset(e) && H.test(presetExecutor(e).model);
}

/** ROLE-MODELS (founder 2026-11-19): the user picks the model per role. A role is set by --<role>-model (start.ts exports LOKI_ROLE_<ROLE>), or by one
 *  line, --models / LOKI_MODELS "plan=opus,dev=haiku,...", where a LOKI_ROLE_<ROLE> var wins over its LOKI_MODELS entry. Precedence at every call:
 *  the older per-call variable (LOKI_E10_WALL_TIER, LOKI_E10_CONSULT_MODEL, ...) > the role > the whole-run model (--model, --session-model) > today's
 *  per-call default. A set role is exact: no cap to the session pin, no cascade, no router climb, no Wall re-author swap, and no escalation unless
 *  escalate= names the model. An unset role changes nothing. Values: haiku|sonnet|opus|fable or a full model id (an opencode id on opencode). */
export const ROLES = ["plan", "dev", "test", "review", "advisor", "helper", "escalate"] as const;
export type Role = (typeof ROLES)[number];
/** The flag for each role and the variable it sets: --plan-model -> LOKI_ROLE_PLAN, ..., --models -> LOKI_MODELS (start.ts and the engine10 argv both read it). */
export const ROLE_FLAG_ENV: ReadonlyMap<string, string> = new Map([...ROLES.map((r): [string, string] => [`--${r}-model`, `LOKI_ROLE_${r.toUpperCase()}`]), ["--models", "LOKI_MODELS"]]);
const ROLE_VALUE = /^[A-Za-z0-9][\w.:@/[\]-]*$/;
const ROUTE_ID = /^(openrouter|ollama|lmstudio|llamacpp|vllm|custom)\//;
/** The raw role values the user set, validated for shape. Throws on an unknown role, an empty or malformed value, or the fable alias. Whether a value is
 *  a model the provider knows is roleValueError's job (it needs the provider: an opencode id such as openrouter/deepseek/... is valid there). */
export function roleSettings(e: NodeJS.ProcessEnv = process.env): Partial<Record<Role, string>> {
  const out: Partial<Record<Role, string>> = {};
  const check = (role: string, v: string, from: string): void => {
    if (!(ROLES as readonly string[]).includes(role)) throw new Error(`unknown role '${role}' in ${from} (${ROLES.join("|")})`);
    if (!ROLE_VALUE.test(v)) throw new Error(`bad model '${v}' for role ${role} in ${from} (haiku|sonnet|opus|fable or a model id)`);
    out[role as Role] = v;
  };
  const line = (e["LOKI_MODELS"] ?? "").trim();
  if (line) for (const part of line.split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i <= 0) throw new Error(`bad LOKI_MODELS entry '${part}' (role=model, comma separated)`);
    check(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim(), "LOKI_MODELS");
  }
  for (const r of ROLES) { const v = (e[`LOKI_ROLE_${r.toUpperCase()}`] ?? "").trim(); if (v) check(r, v, `LOKI_ROLE_${r.toUpperCase()}`); }
  return out;
}
/** The Claude model ids the catalog knows (providers/model_catalog.json claude.models[].id, the file resolveClaudeModel reads; LOKI_MODEL_CATALOG overrides). */
export function catalogClaudeIds(): string[] {
  try {
    const path = process.env["LOKI_MODEL_CATALOG"] || resolve(REPO_ROOT, "providers/model_catalog.json");
    const ms = JSON.parse(readFileSync(path, "utf8")).providers?.claude?.models;
    return Array.isArray(ms) ? ms.map((m: { id?: unknown }) => m?.id).filter((x: unknown): x is string => typeof x === "string") : [];
  } catch { return []; }
}
const editDistance = (a: string, b: string): number => { let prev = Array.from({ length: b.length + 1 }, (_, j) => j); for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return prev[b.length]!; };
/** On a Claude run a role value must be haiku|sonnet|opus or a catalog id, so a typo (sonet, claude-sonet-5-5) or another vendor's id (gpt-5) is refused at
 *  preflight with the accepted aliases and the nearest known id. On opencode the provider validates its own ids (the start line says so). Null when valid. */
export function roleValueError(e: NodeJS.ProcessEnv = process.env, provider: string = providerOf(e)): string | null {
  if (provider === "opencode") return null;
  const ids = catalogClaudeIds(), known = new Set(["haiku", "sonnet", "opus", "fable", ...ids]);
  for (const [role, v] of Object.entries(roleSettings(e))) {
    if (known.has(v)) continue;
    if (ROUTE_ID.test(v)) return `role ${role}: '${v}' is a route; set a route for the whole run with --model, per-role routes are not supported`;
    const near = [...known].sort((a, b) => editDistance(v.toLowerCase(), a) - editDistance(v.toLowerCase(), b))[0];
    return `role ${role}: unknown model '${v}' on the claude provider; use haiku, sonnet, opus or fable, or a model id from the catalog${near ? ` (nearest: ${near})` : ""}`;
  }
  return null;
}
/** A role that the run's other settings would silently override is refused, so the user resolves the conflict (no setting ever does nothing):
 *  a Claude role under LOKI_MODEL_ROUTE (the route serves every call of the run), and a role above LOKI_MAX_TIER (haiku < sonnet < opus < fable; the
 *  role pin is exact and the ceiling is a cost guard). Null when nothing conflicts, or for an id with no known family against the ceiling. */
export function roleConflictError(e: NodeJS.ProcessEnv = process.env, provider: string = providerOf(e)): string | null {
  const route = (e["LOKI_MODEL_ROUTE"] ?? "").trim(), set = Object.entries(roleSettings(e));
  if (route && provider !== "opencode" && set.length) return `role ${set[0]![0]} names ${set[0]![1]}, but LOKI_MODEL_ROUTE=${route} serves every call of the run; unset the role or the route`;
  const cap = (e["LOKI_MAX_TIER"] ?? "").trim().toLowerCase(), order = ["haiku", "sonnet", "opus", "fable"];
  const fam = (m: string): number => { const f = /haiku|sonnet|opus|fable/i.exec(resolveClaudeModel(m))?.[0]?.toLowerCase(); return f ? order.indexOf(f) : -1; };
  const capRank = order.indexOf(cap);
  if (capRank < 0) return null;
  const s = Object.fromEntries(set) as Partial<Record<Role, string>>;
  for (const r of ROLES) { const v = s[r]; if (v && fam(v) > capRank) return `role ${r} names ${v}, above LOKI_MAX_TIER=${cap}; lower the role or raise the ceiling`; }
  return null;
}
const safeSettings = (e: NodeJS.ProcessEnv): Partial<Record<Role, string>> => { try { return roleSettings(e); } catch { return {}; } }; // preflight refuses a bad value before any call
/** True when a whole-run route is active and the role value is a Claude name: the route serves every Claude call, so the role is inert (named on the start line). */
const underRoute = (e: NodeJS.ProcessEnv, provider: string): boolean => provider !== "opencode" && (e["LOKI_MODEL_ROUTE"] ?? "").trim() !== "";
export const providerOf = (e: NodeJS.ProcessEnv): string => ((e["LOKI_E10_RUN_PROVIDER"] || e["LOKI_E10_PROVIDER"] || e["LOKI_PROVIDER"] || "claude").trim().toLowerCase());
/** The raw value of a role for this provider (an alias stays an alias), or undefined when unset or inert under a route. */
export function roleValue(role: Role, e: NodeJS.ProcessEnv = process.env, provider: string = providerOf(e)): string | undefined {
  const v = safeSettings(e)[role];
  return v && !underRoute(e, provider) ? v : undefined;
}
/** The model a role runs on: a Claude alias resolved through the catalog (an opencode id stays as given), or undefined when the role is unset. */
export function roleModel(role: Role, e: NodeJS.ProcessEnv = process.env, provider: string = providerOf(e)): string | undefined {
  const v = roleValue(role, e, provider);
  return v === undefined ? undefined : provider === "opencode" ? v : resolveClaudeModel(v);
}
/** True for a model a tool-less (Anthropic API or Agent SDK) call can run: a Claude family alias or id. */
export const isClaudeModel = (m: string): boolean => /^(claude-|haiku$|sonnet$|opus$|fable$)/i.test(m) || /(haiku|sonnet|opus|fable)/i.test(m) && !m.includes("/");
/** True when `model` is the value (or the resolved value) of a role the user set: the opencode tool-less skip applies only to such a model, so a run
 *  with no role keeps exactly today's calls. */
export function roleNamesModel(model: string, e: NodeJS.ProcessEnv = process.env): boolean {
  return Object.values(safeSettings(e)).some((v) => v === model || resolveClaudeModel(v) === model);
}
/** The session role of an engine stage; a caller names the role itself where the stage is ambiguous (the conflict referee runs as "wall"). */
export const stageRole = (stage: string): Role => (stage === "plan" ? "plan" : stage === "wall" || stage === "prove" ? "test" : stage === "intake" ? "helper" : "dev");
/** The start line, only when a role is set (otherwise the header is byte-identical): "models: plan opus, dev haiku, ... (auto: Loki picks per call)". */
export function roleStartLine(e: NodeJS.ProcessEnv = process.env, provider: string = providerOf(e)): string {
  const s = safeSettings(e);
  if (!Object.keys(s).length) return "";
  return `models: ${ROLES.map((r) => `${r} ${s[r] ? s[r] : r === "escalate" ? (s.dev ? "none" : "auto") : "auto"}`).join(", ")}${provider === "opencode" ? " (passed to opencode as given; opencode checks the ids)" : ""}`;
}
/** ROLE-MODELS receipt: the model each role really started, in this process, in call order (deduplicated). Read by the seal into models_by_role. */
const roleUsed = new Map<Role, string[]>();
export function noteRoleModel(role: Role, model: string | undefined | null): void { if (!model) return; const l = roleUsed.get(role) ?? []; if (!l.includes(model)) l.push(model); roleUsed.set(role, l); }
export const roleModelsUsed = (): Partial<Record<Role, string[]>> => Object.fromEntries([...roleUsed].filter(([, l]) => l.length));
/** ROLE-MODELS: a model call this run skipped on opencode, with the reason, in call order: { call, reason }. Read by the seal into tool_calls_skipped. */
const roleSkips: { call: string; reason: string }[] = [];
export function noteRoleSkip(call: string, reason: string): void { if (!roleSkips.some((x) => x.call === call && x.reason === reason)) roleSkips.push({ call, reason }); }
export const __resetRoleModelsForTests = (): void => { roleUsed.clear(); roleSkips.length = 0; };
/** ROLE-MODELS: { pinSource: "specific" } when an older per-call variable chose this call's model and its role is also set, so the narrower setting
 *  wins in the session runner; {} otherwise (with no role set the call's options are unchanged). */
export const specificPin = (role: Role, varName: string, e: NodeJS.ProcessEnv = process.env): { pinSource?: "specific" } => ((e[varName] ?? "").trim() !== "" && roleModel(role, e) !== undefined ? { pinSource: "specific" } : {});
/** FABLE-RAW-API: Fable answers on the CLI and Agent SDK sessions, but a tool-less call with an API key goes to /v1/messages, where Fable is not yet
 *  verified. When a role, the session pin or LOKI_MODEL_OVERRIDE names Fable and ANTHROPIC_API_KEY is set, the start line and the receipt say so; a refused
 *  call is reported with the API's error (sdk_invoker toolLessCall), never swapped for another model. "" when it does not apply. */
export function fableRawApiNote(e: NodeJS.ProcessEnv = process.env): string {
  if (!(e["ANTHROPIC_API_KEY"] ?? "").trim()) return "";
  const named = [...Object.values(safeSettings(e)), e["LOKI_SESSION_MODEL"] ?? "", e["LOKI_MODEL_OVERRIDE"] ?? ""].some((v) => /fable/i.test(v));
  return named ? "fable on the raw API is not verified; a refused call is reported, never swapped for another model" : "";
}
/** ROLE-MODELS receipt block, spread into the sealed receipt: { models_by_role } when any role is set, so a run with no role keeps its receipt bytes. */
export const roleModelsReceiptBlock = (e: NodeJS.ProcessEnv = process.env): { models_by_role?: Partial<Record<Role, string[]>>; tool_calls_skipped?: { call: string; reason: string }[]; fable_raw_api?: string } =>
  ({ ...(Object.keys(safeSettings(e)).length ? { models_by_role: roleModelsUsed() } : {}), ...(roleSkips.length ? { tool_calls_skipped: roleSkips.map((x) => ({ ...x })) } : {}), ...(fableRawApiNote(e) ? { fable_raw_api: fableRawApiNote(e) } : {}) }); // tool_calls_skipped: present only when a call was skipped (a role naming a non-Claude model, or LOKI_E10_PATCH on opencode)
