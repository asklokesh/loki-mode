// The one typed command registry. Help, completions, did-you-mean and the
// docs/CLI-INVENTORY.md inventory are all generated from this tree (FC-18).
// Guard: loki-ts/tests/cli/registry_guard.test.ts.
//
// Classes: KEEP-MODERN and UPDATE are shown in help and completions.
// DROP-LEGACY (program LEGACY-ZERO) and DELETE entries are accepted-but-hidden:
// they stay dispatchable until their delete slices land, but are never offered.

export type CmdClass = "KEEP-MODERN" | "UPDATE" | "DROP-LEGACY" | "DELETE";
export type DynKind = "providers" | "models" | "branches" | "runs" | "issues" | "workspaces";
export type ValueType = "bool" | "enum" | "string" | "int" | "path" | "dynamic";

export interface FlagSpec {
  name: string; // "--provider"
  short?: string; // "-p"
  type: ValueType;
  values?: readonly string[]; // enum
  dynamic?: DynKind; // dynamic
  placeholder?: string; // string/int hint, e.g. "<usd>"
  desc: string;
  excludes?: readonly string[]; // mutually exclusive flag names
}

export interface PositionalSpec {
  name: string;
  type: "string" | "path" | "dynamic" | "enum";
  dynamic?: DynKind;
  values?: readonly string[];
}

export interface CmdSpec {
  name: string;
  aliases?: readonly string[];
  desc: string;
  example?: string;
  cls?: CmdClass; // top level: required; nested: inherits from parent
  reason?: string;
  where?: "bash" | "bun" | "both"; // top level only
  hidden?: boolean;
  flags?: readonly FlagSpec[];
  positionals?: readonly PositionalSpec[];
  subcommands?: readonly CmdSpec[];
}

export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "--help", short: "-h", type: "bool", desc: "Show help for this command" },
];

const bool = (name: string, desc: string, excludes?: string[]): FlagSpec => ({ name, type: "bool", desc, ...(excludes ? { excludes } : {}) });
const json = bool("--json", "Machine-readable JSON output");
const str = (name: string, placeholder: string, desc: string): FlagSpec => ({ name, type: "string", placeholder, desc });
const dyn = (name: string, dynamic: DynKind, desc: string): FlagSpec => ({ name, type: "dynamic", dynamic, desc });
const sub = (name: string, desc: string, extra: Partial<CmdSpec> = {}): CmdSpec => ({ name, desc, ...extra });
const port: FlagSpec = { name: "--port", type: "int", placeholder: "<port>", desc: "Port" };
const dbFlag: FlagSpec = { name: "--db", type: "path", desc: "Database path" };
const runId: PositionalSpec = { name: "id", type: "dynamic", dynamic: "runs" };

function cmd(name: string, cls: CmdClass, where: "bash" | "bun" | "both", desc: string, reason: string, extra: Partial<CmdSpec> = {}): CmdSpec {
  return { name, cls, where, desc, reason, ...extra };
}
// Legacy-class entries carry no subtree: they are being removed, not modelled.
const legacy = (name: string, desc: string, reason: string, aliases?: string[]): CmdSpec =>
  cmd(name, "DROP-LEGACY", "bash", desc, reason, aliases ? { aliases } : {});

const startFlags: FlagSpec[] = [
  dyn("--provider", "providers", "AI provider"),
  bool("--parallel", "Parallel mode with git worktrees"),
  str("--workspace", "<name>", "Run a loki.yaml workspace (multi-repo) for the brief"),
  bool("--deploy", "After a VERIFIED run, deploy through the gated loki deploy --execute"),
  str("--health-url", "<url>", "With --deploy: probe this URL after the deploy"),
  bool("--auto-rollback", "With --deploy: roll back automatically when the health probe fails"),
  bool("--bg", "Run in background mode"),
  bool("--simple", "Force simple complexity tier", ["--complex"]),
  bool("--complex", "Force complex complexity tier", ["--simple"]),
  bool("--github", "Enable GitHub issue import"),
  bool("--no-dashboard", "Disable the web dashboard"),
  bool("--sandbox", "Run in a Docker sandbox"),
  { name: "--isolation", type: "enum", values: ["none", "worktree", "docker"], desc: "Per-run isolation level" },
  bool("--skip-memory", "Skip loading memory context at startup"),
  bool("--fresh-prd", "Regenerate the PRD from the codebase"),
  bool("--fresh", "Skip the offer to resume an interrupted or cancelled run (also LOKI_NO_RESUME=1)"),
  { name: "--compliance", type: "enum", values: ["default", "healthcare", "fintech", "government"], desc: "Compliance preset" },
  str("--budget", "<usd>", "Cost budget limit in USD"),
  { name: "--cost", type: "enum", values: ["lean", "off"], desc: "Cost profile (also LOKI_COST_PROFILE)" },
  { name: "--bmad-project", type: "path", desc: "BMAD Method project artifacts as input" },
  { name: "--openspec", type: "path", desc: "OpenSpec change directory as input" },
  { name: "--config", type: "path", desc: "Load settings from a config file" },
];

export const REGISTRY: readonly CmdSpec[] = [
  // ---- Bun-native (loki-ts dispatcher) ----
  cmd("version", "KEEP-MODERN", "bun", "Show version", "Bun-native, no legacy dependency", { aliases: ["--version", "-v"] }),
  cmd("status", "UPDATE", "both", "Show current run status, and what the next loki start will do with an interrupted run", "Reads both engines; fold legacy fields into the v10 view", { flags: [json, bool("--badge", "Print the verified deploy badge"), bool("--probe", "Re-probe the last deploy health URL; exit 1 on regression")], example: "loki status --json" }),
  cmd("stats", "DELETE", "bun", "Session statistics (alias of report session)", "Deprecated alias; use report session", { flags: [json, bool("--efficiency", "Token and cost efficiency")] }),
  cmd("doctor", "KEEP-MODERN", "both", "System prerequisites health check; --json, --fix, --requirements, --repo (repo profile with a 0-100 readiness score and fixes)", "Core onboarding gate", { flags: [json, bool("--fix", "Apply safe fixes; with --repo, build or refresh the repo profile"), bool("--yes", "With --fix: run the claude install and login without asking"), bool("--airgap", "Air-gapped check"), bool("--repo", "Print the repo profile and readiness score"), bool("--requirements", "Requirements per execution path")], example: "loki doctor --json" }),
  cmd("provider", "KEEP-MODERN", "both", "Show, list or set the AI provider", "Provider-agnostic core", {
    subcommands: [
      sub("show", "Show current provider", { positionals: [{ name: "name", type: "dynamic", dynamic: "providers" }] }),
      sub("list", "List providers and install status"),
      sub("set", "Switch the active provider", { positionals: [{ name: "name", type: "dynamic", dynamic: "providers" }] }),
      sub("info", "Provider details; --json prints the capability contract", { positionals: [{ name: "name", type: "dynamic", dynamic: "providers" }] }),
      sub("matrix", "Capability matrix per provider and engine"),
    ],
  }),
  cmd("memory", "UPDATE", "both", "Cross-project learnings", "Memory still carries legacy store paths", {
    subcommands: [
      sub("list", "All learnings", { flags: [bool("--json", "Print the learnings summary as JSON")] }),
      sub("index", "Show or rebuild the memory index", { positionals: [{ name: "action", type: "enum", values: ["rebuild"] }] }),
      sub("learn", "Learn lessons from a merged PR's review comments", { positionals: [{ name: "pr", type: "string" }] }),
      sub("lessons", "List PR review lessons with uses and outcomes", { flags: [bool("--json", "Print the lessons as JSON")] }),
      sub("brief", "Print the lessons and learnings block an engine10 run injects", { flags: [str("--task", "text", "Task text used to pick relevant lessons")] }),
      sub("show", "Show one learning"),
      sub("search", "Search learnings"),
      sub("stats", "Memory statistics"),
      sub("consolidate", "Episodic-to-semantic pipeline"),
      sub("compound", "Compound learnings"),
    ],
  }),
  cmd("rollback", "KEEP-MODERN", "both", "Restore .loki/ state from a checkpoint", "Checkpoint restore is engine-neutral", {
    subcommands: [
      sub("list", "List checkpoints", { flags: [bool("--json", "Print the checkpoints as a JSON array")] }),
      sub("show", "Show a checkpoint", { positionals: [runId] }),
      sub("to", "Restore a checkpoint", { positionals: [runId] }),
      sub("latest", "Restore the latest checkpoint"),
      sub("deploy", "Print the provider rollback command for the last deploy (read-only)"),
    ],
  }),
  cmd("backup", "KEEP-MODERN", "bash", "Back up dashboard state (audit log, checkpoint) with a sha256 manifest", "Enterprise retention and backup (D99 item 7)", { flags: [str("--dir", "<path>", "State directory (default ~/.loki/dashboard)"), str("--out", "<archive>", "Archive path (default ./loki-backup-<timestamp>.tar.gz)")] }),
  cmd("restore", "KEEP-MODERN", "bash", "Restore dashboard state from a verified backup archive", "Enterprise retention and backup (D99 item 7)", { flags: [str("--dir", "<path>", "State directory (default ~/.loki/dashboard)"), bool("--force", "Replace a non-empty state directory (old one is kept aside)"), str("--sha256", "<hex>", "Expected archive digest when no .sha256 sidecar exists")], positionals: [{ name: "archive", type: "path" }] }),
  cmd("proof", "KEEP-MODERN", "both", "Inspect and share proof-of-run receipts", "The Evidence Receipt moat", {
    aliases: ["receipt"],
    subcommands: [
      sub("list", "List receipts"),
      sub("show", "Show a receipt", { positionals: [runId] }),
      sub("open", "Open a receipt", { positionals: [runId] }),
      sub("share", "Share a receipt", { positionals: [runId] }),
      sub("badge", "Print the Verified by Loki badge", { positionals: [runId] }),
      sub("md", "Print badge markdown for a README", { positionals: [runId] }),
      sub("bundle", "Write a self-verifying receipt bundle", { positionals: [runId] }),
    ],
  }),
  cmd("wiki", "KEEP-MODERN", "both", "Cited codebase wiki and Q&A", "Bun-native knowledge feature", {
    subcommands: [
      sub("generate", "Generate the wiki"),
      sub("show", "Show a section", { positionals: [{ name: "section", type: "string" }] }),
      sub("ask", "Ask a question", { positionals: [{ name: "question", type: "string" }] }),
    ],
  }),
  cmd("control", "KEEP-MODERN", "both", "Control Plane (serve, backfill, prune, stop, status)", "D56 control plane, on by default", {
    subcommands: [
      sub("serve", "Run the control plane and UI", { flags: [port, dbFlag] }),
      sub("backfill", "Ship DIR/.loki/runs to the control plane", { positionals: [{ name: "dir", type: "path" }] }),
      sub("prune", "Delete matching runs", { flags: [str("--repo", "<owner/name>", "Repository to prune"), str("--before", "<iso-date>", "Prune runs before this date"), bool("--dry-run", "Report only"), dbFlag] }),
      sub("stop", "Stop the running control plane"),
      sub("status", "Show control plane reachability", { flags: [bool("--json", "Print one JSON object")] }),
    ],
  }),
  cmd("runs", "KEEP-MODERN", "bun", "List runs across registered projects", "R100-008: one list over the loki projects registry", { flags: [json] }),
  cmd("intent", "KEEP-MODERN", "bun", "Show a past run's intent card", "Read-only intent view", { subcommands: [sub("show", "Print the intent card and answer", { positionals: [runId] })] }),
  cmd("kpis", "KEEP-MODERN", "bun", "KPI snapshot (alias of report kpis)", "Bun-native KPI report", { flags: [json, str("--since", "<Nd|YYYY-MM-DD>", "Limit iteration totals to a window")] }),
  cmd("report", "UPDATE", "both", "Reporting: kpis, session, metrics, cost, export, share, dogfood, release-notes", "Mixed route; only kpis is Bun", {
    subcommands: [
      sub("kpis", "Canonical KPI snapshot", { flags: [json, str("--since", "<Nd|YYYY-MM-DD>", "Limit iteration totals to a window")] }),
      sub("session", "Session report", { flags: [bool("--efficiency", "Token and cost stats")] }),
      sub("metrics", "Metrics report"),
      sub("cost", "Cost report"),
      sub("export", "Export session", { positionals: [{ name: "format", type: "enum", values: ["json", "markdown", "csv", "timeline", "vibe-kanban"] }] }),
      sub("share", "Share a report"),
      sub("dogfood", "Dogfood report"),
      sub("release-notes", "Changes in a <from>..<to> range", { flags: [str("--format", "<text|json>", "Output format")] }),
    ],
  }),
  cmd("trust", "KEEP-MODERN", "both", "Trust trajectory from proof history", "Trust moat surface", { flags: [bool("--json", "Print the trust trajectory as JSON")], subcommands: [sub("detail", "Trust metrics detail")] }),
  cmd("crash", "KEEP-MODERN", "both", "Inspect or submit scrubbed crash reports", "Local-only crash plumbing", {
    subcommands: [sub("list", "List stored crash reports"), sub("show", "Show one scrubbed crash report"), sub("submit", "Submit a scrubbed crash report"),sub("help", "Show crash usage")],
  }),
  cmd("contract", "KEEP-MODERN", "bun", "Print the spec delivery contract", "v10 delivery contract", { positionals: [{ name: "spec", type: "path" }] }),
  cmd("start", "UPDATE", "both", "Run the autonomous build (a `jira:KEY` or `linear:KEY` ref also writes the outcome back to that ticket, see docs/trackers.md); an interrupted or cancelled run is offered for resume or a fresh start, and --fresh skips the offer", "Forks between v10 and the SDK loop; flags still legacy-shaped", { flags: startFlags, positionals: [{ name: "spec", type: "path" }], example: "loki start ./prd.md --provider claude" }),
  cmd("slack", "KEEP-MODERN", "bun", "Slack inbound handler", "Bun-native integration", { subcommands: [sub("serve", "Serve the Slack handler", { flags: [port, str("--host", "<host>", "Bind host")] })] }),
  cmd("queue", "KEEP-MODERN", "bun", "Overnight issue queue with a morning digest", "Governor-aware batch of issue-mode runs", { subcommands: [sub("add", "Queue issue refs", { positionals: [{ name: "issue", type: "string" }] }), sub("list", "Show the queue", { flags: [bool("--json", "Print the queued refs as a JSON array")] }), sub("remove", "Take issue refs out of the queue", { positionals: [{ name: "issue", type: "string" }] }), sub("clear", "Empty the queue"), sub("run", "Process the queue", { flags: [bool("--no-pr", "Do not open pull requests"), str("--max-total-cost", "<usd>", "Stop before the next item once cumulative spend reaches this cap")] })] }),
  cmd("issues", "KEEP-MODERN", "bun", "Run every open issue in a repo and open PRs", "Mass issue pickup on the T7 queue", {
    subcommands: [sub("run", "Triage and run open issues; split too-large ones into stacked PRs", {
      example: "loki issues run owner/repo --label bug --limit 10",
      positionals: [{ name: "repo", type: "string" }],
      flags: [str("--label", "<label>", "Only issues with this label"), { name: "--limit", type: "int", placeholder: "<n>", desc: "At most this many issues" }, { name: "--parallel", type: "int", placeholder: "<k>", desc: "Runs at once, at most 4 (separate worktrees); default min(4, issue count)" }, bool("--draft", "Open every PR as a draft"), bool("--dry-run", "List, dedupe and show the plan; no model calls"), bool("--json", "With --dry-run: print the plan as JSON (number, decision, reason, covered_by_pr)"), bool("--yes", "Skip the cost confirmation (CI)"), bool("--comment", "Comment the triage reason on skipped issues and the slice plan on split ones"), bool("--triage", "Triage each issue first (one planning call each) instead of running it whole"), bool("--no-split", "Never split: by default an issue whose whole run fails or hits a cap is split once into stacked PRs")],
    })],
  }),
  cmd("undo", "KEEP-MODERN", "bun", "Plan or apply an undo of a run", "UNDO-1/2: --plan is read-only, apply behind LOKI_UNDO=1", { flags: [bool("--plan", "Read-only plan"), bool("--list", "List runs that can be undone"), bool("--dry-run", "Report what would be undone; change nothing"), bool("--json", "JSON plan (with --plan)"), bool("--allow-unsigned", "Accept an unsigned receipt (with --plan)"), bool("--yes", "Skip the confirm prompt"), bool("--close-pr", "Also close the PR")], positionals: [{ name: "run", type: "dynamic", dynamic: "runs" }] }),
  cmd("verify-pr", "KEEP-MODERN", "bun", "Verify a PR against its linked issue in a sandbox", "VPR-2: fail-to-pass check, LOKI_VERIFY_PR=1", { flags: [{ name: "--out", type: "path", desc: "Result directory" }, bool("--json", "Print the verdict object on stdout")], positionals: [{ name: "pr", type: "string" }], subcommands: [sub("respond", "Fix open review comments on the PR branch, one commit each, reply with the sha", { positionals: [{ name: "pr", type: "string" }] })] }),
  cmd("answer", "KEEP-MODERN", "bun", "Answer a BLOCKED run; it continues under the same run id", "v10 blocked-run flow", { flags: [bool("--text", "Answer text inline")], positionals: [{ name: "run", type: "dynamic", dynamic: "runs" }] }),
  cmd("engine10", "KEEP-MODERN", "bun", "v10 engine router", "The v10 engine", {
    subcommands: [sub("run", "Run the v10 engine"), sub("status", "v10 status"), sub("verify", "v10 verify"), sub("keys", "v10 keys"), sub("dashboard", "v10 dashboard"), sub("modernize", "v10 modernize")],
  }),
  cmd("internal", "KEEP-MODERN", "bun", "Internal plumbing for the bash CLI", "Hidden plumbing", { hidden: true }),
  cmd("completion", "KEEP-MODERN", "bun", "Generate shell completions", "Hidden plumbing; completions install themselves", { hidden: true, positionals: [{ name: "shell", type: "enum", values: ["bash", "zsh", "fish"] }] }),
  cmd("__complete", "KEEP-MODERN", "bun", "Dynamic completion values", "Hidden plumbing for generated completions", { hidden: true, positionals: [{ name: "kind", type: "enum", values: ["providers", "models", "branches", "runs", "issues", "workspaces"] }] }),

  // ---- bash-dispatched, modern ----
  cmd("help", "KEEP-MODERN", "bash", "Show help", "Core", { aliases: ["--help", "-h"], positionals: [{ name: "command", type: "string" }] }),
  cmd("chat", "KEEP-MODERN", "bash", "Interactive chat with the active provider", "Provider-neutral conversational verb", { positionals: [{ name: "message", type: "string" }] }),
  cmd("edit", "KEEP-MODERN", "bash", "Make one small scoped edit", "Provider-neutral single-edit verb", { positionals: [{ name: "task", type: "string" }] }),
  cmd("diff", "KEEP-MODERN", "bash", "Show what the last run changed", "Passes extra args to git diff"),
  cmd("models", "KEEP-MODERN", "bash", "Show per-provider model routes", "Provider-neutral model tiers"),
  cmd("setup", "KEEP-MODERN", "bash", "Guided first-run setup wizard", "Onboarding gate"),
  cmd("quick", "UPDATE", "bash", "One small task", "Routes to the v10 lean path by default", { positionals: [{ name: "task", type: "string" }] }),
  cmd("quickstart", "KEEP-MODERN", "bash", "Guided first build", "Onboarding path", { positionals: [{ name: "idea", type: "string" }] }),
  cmd("init", "UPDATE", "bash", "Scaffold from a template", "Templates predate v10", { flags: [str("-t", "<template>", "Template name")] }),
  cmd("template", "KEEP-MODERN", "bash", "Manage PRD templates", "Engine-neutral"),
  cmd("verify", "UPDATE", "bash", "Deterministic PR verification", "Legacy proof vs v10 verify split", { flags: [bool("--fast", "PR-scoped fast verify"), bool("--pr", "PR mode"), json, dyn("--base", "branches", "Base branch")], positionals: [{ name: "base", type: "dynamic", dynamic: "branches" }] }),
  cmd("keys", "KEEP-MODERN", "bash", "Receipt-signing keys", "Trust moat", { subcommands: [sub("export", "Print the public signing key (JWK)")] }),
  cmd("review", "UPDATE", "bash", "Standalone code review with quality gates", "Gates are legacy-shaped"),
  cmd("dashboard", "UPDATE", "bash", "Operations UI server", "Overlaps Control Plane", { subcommands: [sub("start", "Start"), sub("stop", "Stop"), sub("status", "Status"), sub("url", "Print URL"), sub("open", "Open in browser")] }),
  cmd("config", "UPDATE", "bash", "Manage configuration", "Mixed legacy keys", { subcommands: [sub("show", "Show config"), sub("list", "List config (alias of show)"), sub("init", "Create config"), sub("edit", "Edit config"), sub("path", "Print config path"), sub("set", "Set a value"), sub("get", "Get a value")] }),
  cmd("mcp", "KEEP-MODERN", "bash", "Launch the MCP server (stdio)", "Engine-neutral", { subcommands: [sub("install", "Register loki-mode in an MCP client config", { flags: [str("--client", "<name>", "claude, cursor, vscode or windsurf"), bool("--project", "Project-level config"), bool("--global", "User-level config"), bool("--print", "Print, write nothing")] })] }),
  cmd("acp", "KEEP-MODERN", "bash", "Run Loki as an ACP agent", "Engine-neutral"),
  cmd("stop", "KEEP-MODERN", "bash", "Stop execution immediately", "Session control"),
  cmd("pause", "KEEP-MODERN", "both", "Pause after the current session", "Session control; Bun writes the Loki 10 run request, bash keeps the legacy PAUSE file"),
  cmd("resume", "KEEP-MODERN", "both", "Resume a paused or interrupted run", "Session control; Bun clears a Loki 10 pause, bash keeps the legacy resume"),
  cmd("cancel", "KEEP-MODERN", "both", "Cancel the active Loki 10 run at the next stage boundary", "Session control; Loki 10 only"),
  cmd("why", "KEEP-MODERN", "bash", "Explain how the last run ended", "Outcome explainer"),
  cmd("next", "KEEP-MODERN", "bash", "Run the right next step", "Guided flow"),
  cmd("logs", "KEEP-MODERN", "bash", "Tail recent log output", "Engine-neutral"),
  cmd("ship", "KEEP-MODERN", "bash", "Ship the verified result", "Delivery"),
  cmd("deploy", "KEEP-MODERN", "bash", "Deploy the built product", "Delivery"),
  cmd("import", "KEEP-MODERN", "bash", "Import issues or specs", "Spec intake"),
  cmd("github", "KEEP-MODERN", "bash", "GitHub integration", "Integration"),
  cmd("issue", "KEEP-MODERN", "bash", "Work an issue", "Issue-mode", { positionals: [{ name: "ref", type: "dynamic", dynamic: "issues" }] }),
  cmd("ci", "KEEP-MODERN", "bash", "CI helpers", "Engine-neutral"),
  cmd("modernize", "KEEP-MODERN", "both", "Code modernization", "Routed to engine10 modernize"),
  cmd("share", "KEEP-MODERN", "bash", "Share a run", "Engine-neutral"),
  cmd("assets", "KEEP-MODERN", "bash", "Export team assets", "Engine-neutral", { subcommands: [sub("export", "Export shareable assets", { positionals: [{ name: "file", type: "path" }] })] }),
  cmd("export", "UPDATE", "bash", "Export session data", "Duplicates report export", { flags: [bool("--sarif", "Write findings.sarif for a run (SARIF 2.1.0)")] }),
  cmd("notify", "KEEP-MODERN", "bash", "Notifications", "Engine-neutral", { subcommands: [sub("desktop", "Send a desktop notification (macOS or Linux notify-send)", { positionals: [{ name: "message", type: "string" }] })] }),
  cmd("tour", "KEEP-MODERN", "bash", "See a sample result", "Onboarding"),
  cmd("wow", "KEEP-MODERN", "bash", "Tiny real task, or the offline sample", "Onboarding: loki tour --live"),
  cmd("try", "KEEP-MODERN", "bash", "Try Loki on a public repo in a temp clone, keep only the receipt", "Onboarding: never touches your checkout", { flags: [bool("--dry-run", "Clone, print the clone path, task and estimate, no model call"), str("--provider", "<name>", "claude, opencode, codex, cline or aider"), str("--max-cost", "<usd>", "Hard per-run cap in USD (default 2)")], positionals: [{ name: "url", type: "string" }] }),
  cmd("factory", "KEEP-MODERN", "bash", "loki start with the autonomy policy printed", "propose, execute, operate unchanged"),
  cmd("welcome", "KEEP-MODERN", "bash", "First-run opener", "Onboarding"),
  cmd("onboard", "UPDATE", "bash", "Onboard to a codebase", "Overlaps wiki"),
  cmd("setup-skill", "KEEP-MODERN", "bash", "Install the skill symlinks", "Setup"),
  cmd("self-update", "KEEP-MODERN", "bash", "Update Loki", "Maintenance", { aliases: ["self_update", "update"] }),
  cmd("remote", "KEEP-MODERN", "bash", "Remote session", "Engine-neutral", { aliases: ["rc"] }),
  cmd("cockpit", "KEEP-MODERN", "bash", "Live multi-repo cockpit", "Engine-neutral"),
  cmd("code", "UPDATE", "bash", "Code intelligence", "Overlaps wiki"),
  cmd("context", "KEEP-MODERN", "bash", "Cross-project context", "Engine-neutral", { aliases: ["ctx"] }),
  cmd("secrets", "KEEP-MODERN", "bash", "Secrets handling", "Security"),
  cmd("api", "KEEP-MODERN", "bash", "Dashboard HTTP API", "Engine-neutral"),
  cmd("sandbox", "KEEP-MODERN", "bash", "Docker sandbox", "Isolation"),
  cmd("docker", "KEEP-MODERN", "bash", "Docker helpers", "Isolation"),
  cmd("web", "UPDATE", "bash", "Web UI", "Overlaps Control Plane UI"),
  cmd("preview", "KEEP-MODERN", "bash", "Preview the built app", "Delivery"),
  cmd("telemetry", "KEEP-MODERN", "bash", "Telemetry controls", "Privacy surface", { aliases: ["otel"] }),
  cmd("syslog", "UPDATE", "bash", "System log forwarding", "Legacy log paths"),
  cmd("explain", "KEEP-MODERN", "bash", "Explain code", "Knowledge"),
  cmd("docs", "KEEP-MODERN", "bash", "Open docs", "Core"),
  cmd("test", "UPDATE", "bash", "Run project tests", "Legacy runner"),
  cmd("bench", "KEEP-MODERN", "bash", "Benchmarks", "Engine-neutral"),
  cmd("voice", "UPDATE", "bash", "Voice input", "Experimental"),
  cmd("own", "UPDATE", "bash", "Hand off ownership", "Legacy handoff", { aliases: ["handoff"] }),
  cmd("secure", "KEEP-MODERN", "bash", "Security scan", "Security"),
  cmd("compliance", "KEEP-MODERN", "bash", "Compliance reports", "Enterprise"),
  cmd("enterprise", "KEEP-MODERN", "bash", "Enterprise features", "Enterprise"),
  cmd("projects", "KEEP-MODERN", "bash", "Project registry", "Engine-neutral"),
  cmd("audit", "KEEP-MODERN", "bash", "Audit log", "Enterprise"),
  cmd("cost", "UPDATE", "bash", "Cost report", "Duplicates report cost"),
  cmd("metrics", "UPDATE", "bash", "Metrics", "Duplicates report metrics"),
  cmd("sentrux", "UPDATE", "bash", "Architecture sensor", "Legacy gate input"),
  cmd("magic", "UPDATE", "bash", "Magic modules", "Legacy UI generator"),

  // ---- DROP-LEGACY (program LEGACY-ZERO): accepted but hidden, no subtree ----
  legacy("estimate", "Cost estimate for a PRD", "Estimates the legacy PRD flow"),
  legacy("plan", "Dry-run PRD analysis", "Legacy PRD flow"),
  legacy("grill", "Spec interrogation", "Legacy PRD flow"),
  legacy("spec", "Living-spec drift", "Legacy PRD flow"),
  legacy("intent", "Intent capture", "Legacy PRD flow"),
  legacy("backlog", "Run matching issues in parallel", "Drives legacy RARV per issue"),
  legacy("workspace", "Multi-repo workspace runs", "Drives legacy RARV"),
  legacy("council", "Completion council", "Legacy RARV gate"),
  legacy("compound", "Compound-learning pipeline", "Legacy memory pipeline"),
  legacy("cluster", "Cluster mode", "Legacy RARV"),
  legacy("optimize", "Optimize loop", "Legacy RARV"),
  legacy("ultracode", "Claude Dynamic Workflow run", "Legacy Claude-only"),
  legacy("monitor", "Monitor a legacy run", "Legacy engine state"),
  legacy("watch", "Rerun on PRD change", "PRD flow"),
  legacy("watchdog", "Legacy run watchdog", "Legacy engine"),
  legacy("cleanup", "Kill orphaned processes", "Legacy run.sh orphans"),
  legacy("state", "Legacy state store", "Legacy engine"),
  legacy("agent", "Legacy agent types", "Legacy engine"),
  legacy("agents", "User-configurable child agents (.loki/agents)", "Legacy engine"),
  legacy("trigger", "Event triggers", "Legacy engine"),
  legacy("failover", "Provider failover", "Legacy engine"),
  legacy("reset", "Reset legacy state", "Legacy engine"),
  legacy("merge", "Gated PR merge queue (pr, watch, run); also merges parallel worktrees", "Bash PR merge gate"),
  legacy("heal", "Legacy healing", "Legacy engine"),
  legacy("migrate", "Legacy migration", "Superseded by modernize"),
  legacy("dogfood", "Dogfood run", "Legacy engine"),
  cmd("steer", "KEEP-MODERN", "bash", "Nudge a running build", "Session control"),
  legacy("outcomes", "Outcome analytics", "Legacy outcome store"),
  legacy("worktree", "Worktree management", "Legacy parallel mode", ["wt"]),
  legacy("checkpoint", "Legacy checkpoints", "Legacy engine", ["cp"]),
  legacy("analyze", "Codebase analysis", "Legacy analyze flow"),
  legacy("demo", "Build the sample todo app", "Legacy engine demo"),

  // ---- DELETE: deprecated aliases ----
  cmd("run", "DELETE", "bash", "Deprecated alias of start", "Alias; use start"),
  cmd("trust-metrics", "DELETE", "bash", "Deprecated alias of trust detail", "Alias; use trust detail"),
  cmd("serve", "DELETE", "bash", "Deprecated alias of api start", "Alias; use api start"),
  cmd("open", "DELETE", "bash", "Deprecated alias of dashboard open", "Alias; use dashboard open"),
];

export function classOf(c: CmdSpec): CmdClass {
  return c.cls ?? "KEEP-MODERN";
}

/** Commands shown in completions and help: not hidden, KEEP-MODERN or UPDATE. */
export function visibleCommands(): CmdSpec[] {
  return REGISTRY.filter((c) => !c.hidden && (c.cls === "KEEP-MODERN" || c.cls === "UPDATE"));
}

export function allNames(c: CmdSpec): string[] {
  return [c.name, ...(c.aliases ?? [])];
}

export function findCommand(name: string): CmdSpec | undefined {
  return REGISTRY.find((c) => allNames(c).includes(name));
}

/** Every path ("a" and "a b c") the registry declares, subcommands included. */
export function registryPaths(): string[] {
  const out: string[] = [];
  const walk = (c: CmdSpec, prefix: string): void => {
    const p = prefix ? `${prefix} ${c.name}` : c.name;
    out.push(p);
    for (const s of c.subcommands ?? []) walk(s, p);
  };
  for (const c of REGISTRY) walk(c, "");
  return out;
}

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Closest of `names` within distance 2 (ties keep the first), else undefined. */
export function suggestWord(typo: string, names: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  for (const n of names) {
    const d = levenshtein(typo, n);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** Closest visible command name within distance 2, else undefined. */
export function suggestCommand(typo: string): string | undefined {
  return suggestWord(typo, visibleCommands().flatMap((c) => [...allNames(c)]));
}
