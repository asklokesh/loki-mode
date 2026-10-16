// Specialist reviewer model routing and lean child flags (cost program S9).
//
// Pure helpers; no spawn, no IO. quality_gates.ts calls routeReviewer() when it
// builds the `claude -p` argv for a specialist reviewer (wired by S4).
//
// Policy (parity with the bash reviewer dispatch in autonomy/run.sh and the lean
// helper in autonomy/lib/claude-flags.sh):
//   - simple and standard tier: specialist reviewers run on haiku with lean flags.
//   - complex tier, unknown tier, HIGH-tier changes, and the moat reviewers
//     (security-sentinel, devils-advocate): unchanged, no pin, no lean flags.
//   - an explicit LOKI_ADVISOR_MODEL (haiku|sonnet|opus) always wins; fable is
//     refused (its safety classifiers can end a reviewer turn with no VERDICT).
// Verdict semantics are untouched: this module only picks a model and flags.

type Env = Record<string, string | undefined>;

/** Reviewers whose verdict guards the moat; never downgraded by tier routing. */
export const HIGH_TIER_REVIEWERS: readonly string[] = ["security-sentinel", "devils-advocate"];

const SMALL_TIERS = new Set(["simple", "standard"]);
const ADVISOR_MODELS = new Set(["haiku", "sonnet", "opus"]);
const SMALL_TIER_MODEL = "haiku";

export type ReviewerModelOpts = {
  tier?: string;
  reviewer: string;
  /** True when the change under review is HIGH tier (moat, verifier, Seal, auth, security). */
  highTier?: boolean;
  env?: Env;
};

/** Model alias to pass as `--model`, or null to leave the account default. */
export function reviewerModelForTier(opts: ReviewerModelOpts): string | null {
  const env = opts.env ?? process.env;
  const advisor = (env["LOKI_ADVISOR_MODEL"] ?? "").trim().toLowerCase();
  if (ADVISOR_MODELS.has(advisor)) return advisor;
  if (env["LOKI_REVIEWER_TIER_ROUTING"] === "0") return null;
  if (opts.highTier === true) return null;
  if (HIGH_TIER_REVIEWERS.includes(opts.reviewer)) return null;
  const tier = (opts.tier ?? "").trim().toLowerCase();
  return SMALL_TIERS.has(tier) ? SMALL_TIER_MODEL : null;
}

export type LeanFlagOpts = {
  env?: Env;
  /** Returns true when the installed claude supports the flag; unsupported flags are dropped. */
  flagSupported: (flag: string) => boolean;
  /** Text-only role: also emit `--tools ""`. Reviewer prompts are self-contained, so default true. */
  textOnly?: boolean;
};

/** Lean child flags: `--bare` only with API-key auth, else narrowed setting sources. */
export function leanReviewerFlags(opts: LeanFlagOpts): string[] {
  const env = opts.env ?? process.env;
  if (env["LOKI_LEAN_CHILDREN"] === "0") return [];
  const ok = opts.flagSupported;
  const flags: string[] = [];
  const hasKey = (env["ANTHROPIC_API_KEY"] ?? "").trim() !== "";
  if (env["LOKI_BARE_SUBCALLS"] !== "0" && hasKey && ok("--bare")) {
    flags.push("--bare");
  } else {
    if (ok("--setting-sources")) flags.push("--setting-sources", "project");
    if (ok("--strict-mcp-config")) flags.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
    if (ok("--disable-slash-commands")) flags.push("--disable-slash-commands");
  }
  if (opts.textOnly !== false && ok("--tools")) flags.push("--tools", "");
  return flags;
}

export type RouteOpts = ReviewerModelOpts & Pick<LeanFlagOpts, "flagSupported" | "textOnly">;

/** Model plus lean flags for one specialist reviewer; lean flags apply only when routed. */
export function routeReviewer(opts: RouteOpts): { model: string | null; flags: string[] } {
  const model = reviewerModelForTier(opts);
  const routed = model !== null && opts.highTier !== true && !HIGH_TIER_REVIEWERS.includes(opts.reviewer);
  const tier = (opts.tier ?? "").trim().toLowerCase();
  if (!routed || !SMALL_TIERS.has(tier)) return { model, flags: [] };
  return {
    model,
    flags: leanReviewerFlags({ env: opts.env, flagSupported: opts.flagSupported, textOnly: opts.textOnly }),
  };
}
