// loki-ts/src/providers/model_routes.ts
// Mirror of providers/model_routes.sh. Resolves a route spec such as
// "openrouter/anthropic/claude-sonnet-4.5" or "ollama/qwen3-coder" into the env
// a claude child process needs (Claude Code honors ANTHROPIC_BASE_URL and
// ANTHROPIC_AUTH_TOKEN natively). The returned env is for the CHILD only; this
// module never mutates process.env and never logs a token.
// Plain Claude ids (opus, sonnet, claude-*) resolve to null: behavior unchanged.

export interface ModelRoute {
  kind: string;
  model: string;
  baseUrl: string;
  env: Record<string, string>;
}

export const MODEL_ROUTES: Record<string, { baseUrl: string; tokenVar?: string }> = {
  openrouter: { baseUrl: "https://openrouter.ai/api", tokenVar: "OPENROUTER_API_KEY" },
  ollama: { baseUrl: "http://localhost:11434" },
  lmstudio: { baseUrl: "http://localhost:1234" },
  llamacpp: { baseUrl: "http://localhost:8080" },
  vllm: { baseUrl: "http://localhost:8000" },
};

type Env = Record<string, string | undefined>;

/** Spec comes from LOKI_MODEL_ROUTE first, then LOKI_MODEL_OVERRIDE when it is a route spec. */
export function routeSpecFromEnv(env: Env): string {
  const a = (env["LOKI_MODEL_ROUTE"] ?? "").trim();
  if (a) return a;
  const b = (env["LOKI_MODEL_OVERRIDE"] ?? "").trim();
  if (b.startsWith("custom/")) return b;
  const kind = b.split("/")[0] ?? "";
  return b.includes("/") && kind in MODEL_ROUTES ? b : "";
}

export function resolveModelRoute(spec: string, env: Env = process.env): ModelRoute | null {
  const s = spec.trim();
  if (!s) return null;
  const idx = s.indexOf("/");
  if (idx < 0) return null;
  const kind = s.slice(0, idx);
  const model = s.slice(idx + 1);
  if (!model) return null;
  let baseUrl: string;
  let token = "";
  if (kind === "custom") {
    baseUrl = (env["LOKI_MODEL_BASE_URL"] ?? "").trim();
    if (!baseUrl) return null;
    token = env["LOKI_MODEL_API_KEY"] ?? "";
  } else if (kind in MODEL_ROUTES) {
    const r = MODEL_ROUTES[kind]!;
    baseUrl = r.baseUrl;
    if (r.tokenVar) token = env[r.tokenVar] ?? "";
  } else {
    return null;
  }
  return {
    kind,
    model,
    baseUrl,
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      ANTHROPIC_AUTH_TOKEN: token || "loki-local-route",
      // Gateways like OpenRouter want the key only as the bearer token.
      ANTHROPIC_API_KEY: "",
    },
  };
}

/** Child env overrides for the active route, or {} when no route is configured. */
export function modelRouteEnv(env: Env = process.env): Record<string, string> {
  return resolveModelRoute(routeSpecFromEnv(env), env)?.env ?? {};
}

/** Model id the route serves, or null when no route is configured. */
export function modelRouteModel(env: Env = process.env): string | null {
  return resolveModelRoute(routeSpecFromEnv(env), env)?.model ?? null;
}
