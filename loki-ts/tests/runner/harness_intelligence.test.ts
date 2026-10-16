// Targeted tests for harness intelligence features 5-8.
//
// Coverage maps 1:1 to the acceptance list in docs/HARNESS-INTELLIGENCE-PLAN.md:
//   override precedence, session ceiling, namespace/privacy/freshness,
//   overlap serialization, stale SHA rejection, auth no-retry, transient retry,
//   compile revise, repeated-signature stop, truthful state artifacts.
//
// Every feature is DEFAULT OFF, and the first describe block proves it: with no
// flags set, all four modules are passthrough. That is what keeps the 60
// byte-exact build_prompt parity fixtures green.
import { describe, expect, it, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { attribute, attributeFullSuite, discoverCommands, ensureProfile, loadProfile, manifestHash, profileBrief, commandProfilePath, renderProfile, repoReadiness, type BaselineRunner, type CommandProfile, type ProfileCommand } from "../../src/runner/repo_profile.ts";
import { runIntake } from "../../src/engine10/stages/intake.ts";
import { verifyStage } from "../../src/engine10/stages/verify.ts";
import type { RunContext, TestRef } from "../../src/engine10/types.ts";
import { briefContext } from "../../src/e10ext/context.ts";
import { runDoctor } from "../../src/commands/doctor.ts";


import { routeTaskClass, requestTier } from "../../src/runner/capability_router.ts";
import {
  buildProfile,
  readProfile,
  profileFragment,
  redactEvidence,
} from "../../src/runner/repo_profile.ts";
import {
  planManifest,
  validateResult,
  scopesOverlap,
  writeManifest,
  readManifest,
  isIntegrationOwner,
  type ExecManifest,
} from "../../src/runner/exec_manifest.ts";
import { decideRecovery, signatureRepeated } from "../../src/runner/recovery_policy.ts";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(resolve(tmpdir(), "loki-hi-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Base env for the "on" cases. Tests pass env explicitly rather than mutating
// process.env, so no case can leak into another (or into a parallel shard).
const ON = {
  router: { LOKI_CAPABILITY_ROUTER: "1" } as NodeJS.ProcessEnv,
  profile: { LOKI_REPO_PROFILE: "1" } as NodeJS.ProcessEnv,
  manifest: { LOKI_EXEC_MANIFEST: "1" } as NodeJS.ProcessEnv,
  recovery: { LOKI_RECOVERY_POLICY: "1" } as NodeJS.ProcessEnv,
};

describe("default-off (parity protection)", () => {
  it("router is passthrough with no flag", () => {
    const d = routeTaskClass("planning", "sonnet", { env: {} });
    expect(d.model).toBe("sonnet");
    expect(d.reason).toBe("router_off");
  });

  it("profile injects nothing with no flag", () => {
    const root = tmp();
    writeFileSync(resolve(root, "package.json"), '{"scripts":{"test":"bun test"}}');
    expect(profileFragment({ repoRoot: root, lokiDirOverride: resolve(root, ".loki"), env: {} })).toBe("");
  });

  it("manifest plans nothing with no flag", () => {
    const m = planManifest({
      baseSha: "abc",
      integrationOwner: "lead",
      streams: [{ name: "a", paths: ["src"], acceptance: "tests pass" }],
      env: {},
    });
    expect(m).toBeNull();
  });

  it("recovery reproduces legacy shouldStopRetrying with no flag", () => {
    // Legacy: transient retries, permanent stops. Same as before this feature.
    expect(decideRecovery({ output: "rate limit exceeded" }, { env: {} }).action).toBe("retry");
    expect(decideRecovery({ output: "invalid_api_key" }, { env: {} }).action).toBe("stop");
  });
});

describe("feature 5: capability router", () => {
  it("explicit model override wins over task-class routing", () => {
    const d = routeTaskClass("planning", "sonnet", {
      env: { ...ON.router, LOKI_CLAUDE_MODEL_PLANNING: "my-pinned-model" },
    });
    expect(d.model).toBe("my-pinned-model");
    expect(d.reason).toBe("explicit_override");
  });

  it("empty-string pin counts as UNSET (matches envPinned semantics)", () => {
    const d = routeTaskClass("planning", "sonnet", {
      env: { ...ON.router, LOKI_CLAUDE_MODEL_PLANNING: "" },
    });
    expect(d.reason).toBe("task_class");
    expect(d.model).toBe("opus");
  });

  it("session ceiling clamps a stronger request DOWN", () => {
    // Planning wants "planning" tier, but the session is pinned to sonnet.
    const d = routeTaskClass("planning", "sonnet", {
      env: { ...ON.router, LOKI_SESSION_MODEL: "sonnet" },
    });
    expect(d.tier).toBe("development");
    expect(d.reason).toBe("session_ceiling");
  });

  it("session ceiling never raises a weaker request UP", () => {
    // Verification wants "fast"; an opus session must not promote it.
    const d = routeTaskClass("verification", "sonnet", {
      env: { ...ON.router, LOKI_SESSION_MODEL: "opus" },
    });
    expect(d.tier).toBe("fast");
    expect(d.reason).toBe("task_class");
  });

  it("recovery never routes below implementation strength", () => {
    expect(routeTaskClass("recovery", "haiku", { env: ON.router }).tier).toBe("development");
  });

  it("unknown task class is passthrough, not a guess", () => {
    const d = routeTaskClass("wat", "sonnet", { env: ON.router });
    expect(d.model).toBe("sonnet");
    expect(d.reason).toBe("unknown_task_class");
  });

  it("requestTier resolves a tier and honors pins (recovery's only interface)", () => {
    expect(requestTier("development", {})).toBe("sonnet");
    expect(requestTier("development", { LOKI_MODEL_DEVELOPMENT: "pinned" })).toBe("pinned");
  });
});

describe("feature 6: repository profile", () => {
  function repoWith(files: Record<string, string>): { root: string; loki: string } {
    const root = tmp();
    for (const [name, body] of Object.entries(files)) writeFileSync(resolve(root, name), body);
    return { root, loki: resolve(root, ".loki") };
  }

  it("namespace is the repo basename, never an absolute host path", () => {
    const { root, loki } = repoWith({ "go.mod": "module x" });
    const p = buildProfile({ repoRoot: root, lokiDirOverride: loki });
    expect(p.namespace).not.toContain("/");
    expect(p.namespace).toBe(basename(root));
  });

  it("privacy: evidence paths are repo-relative, and script BODIES are never recorded", () => {
    const { root, loki } = repoWith({
      "package.json": '{"scripts":{"test":"bun test --token=SECRET123"}}',
    });
    const p = buildProfile({ repoRoot: root, lokiDirOverride: loki });
    const raw = readFileSync(resolve(loki, "profile", "repo-profile.json"), "utf8");
    expect(raw).not.toContain("SECRET123");
    for (const f of p.facts) expect(f.evidence.startsWith("/")).toBe(false);
  });

  it("redactEvidence reduces an absolute path outside the repo to a basename", () => {
    expect(redactEvidence("/Users/someone/private/x.json", "/repo")).toBe("x.json");
    expect(redactEvidence("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(redactEvidence("src/a.ts", "/repo")).toBe("src/a.ts");
  });

  it("freshness: a content-hash mismatch marks the profile stale and blocks injection", () => {
    const { root, loki } = repoWith({ "package.json": '{"scripts":{"test":"t"}}' });
    buildProfile({ repoRoot: root, lokiDirOverride: loki });
    expect(readProfile({ repoRoot: root, lokiDirOverride: loki }).status).toBe("fresh");

    // Change the evidence input; the recorded hash no longer describes the repo.
    writeFileSync(resolve(root, "package.json"), '{"scripts":{"test":"t","build":"b"}}');
    expect(readProfile({ repoRoot: root, lokiDirOverride: loki }).status).toBe("stale_hash");
    expect(profileFragment({ repoRoot: root, lokiDirOverride: loki, env: ON.profile })).toBe("");
  });

  it("freshness: an expired TTL blocks injection even when the hash matches", () => {
    const { root, loki } = repoWith({ "Cargo.toml": "[package]" });
    buildProfile({ repoRoot: root, lokiDirOverride: loki, now: new Date("2020-01-01T00:00:00Z") });
    const res = readProfile({ repoRoot: root, lokiDirOverride: loki, now: new Date("2020-01-03T00:00:00Z") });
    expect(res.status).toBe("stale_ttl");
  });

  it("an unrecognized schema_version is treated as ABSENT, not an error", () => {
    const { root, loki } = repoWith({ "go.mod": "module x" });
    buildProfile({ repoRoot: root, lokiDirOverride: loki });
    const p = resolve(loki, "profile", "repo-profile.json");
    const obj = JSON.parse(readFileSync(p, "utf8"));
    obj.schema_version = 999;
    writeFileSync(p, JSON.stringify(obj));
    expect(readProfile({ repoRoot: root, lokiDirOverride: loki }).status).toBe("absent");
  });

  it("a corrupt profile is unreadable, never a throw", () => {
    const { root, loki } = repoWith({ "go.mod": "module x" });
    buildProfile({ repoRoot: root, lokiDirOverride: loki });
    writeFileSync(resolve(loki, "profile", "repo-profile.json"), "{not json");
    expect(readProfile({ repoRoot: root, lokiDirOverride: loki }).status).toBe("unreadable");
  });

  it("injection is bounded and truncation is explicit, never silent", () => {
    const { root, loki } = repoWith({
      "package.json": '{"scripts":{"build":"b","test":"t","lint":"l"}}',
      "Makefile": "all:",
      "go.mod": "module x",
    });
    buildProfile({ repoRoot: root, lokiDirOverride: loki });
    const env = { ...ON.profile, LOKI_REPO_PROFILE_MAX_CHARS: "80" };
    const frag = profileFragment({ repoRoot: root, lokiDirOverride: loki, env });
    expect(frag.length).toBeLessThanOrEqual(80);
    expect(frag).toContain("(truncated)");
  });

  it("a fresh profile injects evidence-backed facts", () => {
    const { root, loki } = repoWith({ "package.json": '{"scripts":{"test":"t"}}' });
    buildProfile({ repoRoot: root, lokiDirOverride: loki });
    const frag = profileFragment({ repoRoot: root, lokiDirOverride: loki, env: ON.profile });
    expect(frag).toContain("script.test");
    expect(frag).toContain("(from package.json)");
  });
});

describe("feature 7: execution manifest", () => {
  const streams = [
    { name: "api", paths: ["src/api"], acceptance: "api tests pass" },
    { name: "web", paths: ["src/web"], acceptance: "web tests pass" },
    { name: "wide", paths: ["src"], acceptance: "all tests pass" },
  ];

  it("scope overlap compares on segment boundaries, not bare prefixes", () => {
    expect(scopesOverlap("src", "src/runner")).toBe(true);
    expect(scopesOverlap("src", "src")).toBe(true);
    // The mistake this guards: "src" must NOT swallow "srcery".
    expect(scopesOverlap("src", "srcery")).toBe(false);
    expect(scopesOverlap("src/api", "src/web")).toBe(false);
  });

  it("non-overlapping streams share a wave; an overlapping stream is SERIALIZED", () => {
    const m = planManifest({ baseSha: "sha1", integrationOwner: "lead", streams, env: ON.manifest })!;
    const byName = Object.fromEntries(m.streams.map((s) => [s.name, s.wave]));
    expect(byName["api"]).toBe(0);
    expect(byName["web"]).toBe(0); // disjoint from api -> parallel
    expect(byName["wide"]).toBe(1); // contains both -> pushed to a later wave
  });

  it("a stream with no path scope or no acceptance criteria is rejected at plan time", () => {
    expect(() =>
      planManifest({
        baseSha: "s", integrationOwner: "lead", env: ON.manifest,
        streams: [{ name: "bad", paths: [], acceptance: "x" }],
      }),
    ).toThrow(/no path scope/);
    expect(() =>
      planManifest({
        baseSha: "s", integrationOwner: "lead", env: ON.manifest,
        streams: [{ name: "bad", paths: ["src"], acceptance: "  " }],
      }),
    ).toThrow(/no acceptance criteria/);
  });

  it("a stale base SHA is REJECTED", () => {
    const m = planManifest({ baseSha: "sha1", integrationOwner: "lead", streams, env: ON.manifest })!;
    const v = validateResult(m, {
      name: "api", baseSha: "sha-OLD", changedPaths: ["src/api/x.ts"], acceptanceMet: true,
    });
    expect(v.verdict).toBe("rejected_stale_base");
    expect(v.detail).toContain("sha-OLD");
  });

  it("an out-of-scope edit is REJECTED and names the offending path", () => {
    const m = planManifest({ baseSha: "sha1", integrationOwner: "lead", streams, env: ON.manifest })!;
    const v = validateResult(m, {
      name: "api", baseSha: "sha1", changedPaths: ["src/web/y.ts"], acceptanceMet: true,
    });
    expect(v.verdict).toBe("rejected_out_of_scope");
    expect(v.detail).toContain("src/web/y.ts");
  });

  it("unmet acceptance is REJECTED; a fully valid result is accepted", () => {
    const m = planManifest({ baseSha: "sha1", integrationOwner: "lead", streams, env: ON.manifest })!;
    expect(
      validateResult(m, { name: "api", baseSha: "sha1", changedPaths: ["src/api/x.ts"], acceptanceMet: false }).verdict,
    ).toBe("rejected_acceptance");
    expect(
      validateResult(m, { name: "api", baseSha: "sha1", changedPaths: ["src/api/x.ts"], acceptanceMet: true }).verdict,
    ).toBe("accepted");
  });

  it("an unknown stream is rejected before any other rule", () => {
    const m = planManifest({ baseSha: "sha1", integrationOwner: "lead", streams, env: ON.manifest })!;
    expect(
      validateResult(m, { name: "ghost", baseSha: "nope", changedPaths: [], acceptanceMet: true }).verdict,
    ).toBe("rejected_unknown_stream");
  });

  it("exactly one integration owner", () => {
    const m = planManifest({ baseSha: "s", integrationOwner: "lead", streams, env: ON.manifest })!;
    expect(isIntegrationOwner(m, "lead")).toBe(true);
    expect(isIntegrationOwner(m, "someone-else")).toBe(false);
    expect(isIntegrationOwner(m, "")).toBe(false);
  });

  it("state artifacts are truthful: what is written round-trips exactly", () => {
    const loki = resolve(tmp(), ".loki");
    const m = planManifest({
      baseSha: "sha1", integrationOwner: "lead", streams,
      profileSnapshot: "language=go", env: ON.manifest,
    })!;
    writeManifest(m, loki);
    const back = readManifest(loki) as ExecManifest;
    expect(back).toEqual(m);
    // The manifest READS the profile snapshot and never writes learned memory.
    expect(back.profile_snapshot).toBe("language=go");
  });

  it("an unknown manifest schema_version reads as absent", () => {
    const loki = resolve(tmp(), ".loki");
    const m = planManifest({ baseSha: "s", integrationOwner: "lead", streams, env: ON.manifest })!;
    const p = writeManifest(m, loki);
    writeFileSync(p, JSON.stringify({ ...m, schema_version: 999 }));
    expect(readManifest(loki)).toBeNull();
  });
});

describe("feature 8: recovery policy", () => {
  const E = ON.recovery;

  it("auth failure -> STOP with no retry", () => {
    const d = decideRecovery({ output: "invalid_api_key provided" }, { env: E, history: [] });
    expect(d.action).toBe("stop");
    expect(d.reason).toBe("permanent:auth");
  });

  it("transient failure -> RETRY", () => {
    const d = decideRecovery({ output: "ECONNRESET while reading" }, { env: E, history: [] });
    expect(d.action).toBe("retry");
    expect(d.reason).toContain("transient");
  });

  it("an UNRECOGNIZED failure still retries (fail-safe direction preserved)", () => {
    const d = decideRecovery({ output: "something nobody has seen before" }, { env: E, history: [] });
    expect(d.action).toBe("retry");
  });

  it("a rate limit is transient even though it looks quota-adjacent", () => {
    const d = decideRecovery({ output: "429 rate limit exceeded, quota" }, { env: E, history: [] });
    expect(d.action).toBe("retry");
  });

  it("compile failure -> REVISE, driven by exit code", () => {
    const d = decideRecovery({ output: "ok", buildExitCode: 1 }, { env: E, history: [] });
    expect(d.action).toBe("revise");
    expect(d.reason).toBe("build_failed");
  });

  it("COMPILE HAZARD: agent prose about compile errors does NOT trigger revise", () => {
    // An agent that BUILT a compiler emits this text as normal output. Without
    // a build exit code there is no compile signal, so this must retry.
    const d = decideRecovery(
      { output: "error: compilation failed\nSyntaxError: unexpected token\ncannot find symbol" },
      { env: E, history: [] },
    );
    expect(d.action).toBe("retry");
  });

  it("a build exit code of 0 is a PASS and yields no revise", () => {
    expect(decideRecovery({ output: "fine", buildExitCode: 0 }, { env: E, history: [] }).action).toBe("retry");
  });

  it("repeated signature at threshold -> STOP (circuit breaker)", () => {
    const history = [{ error_class: "unknown" }, { error_class: "unknown" }, { error_class: "unknown" }];
    const d = decideRecovery({ output: "an unrecognized problem" }, { env: E, history });
    expect(d.action).toBe("stop");
    expect(d.reason).toBe("repeated_signature:unknown");
  });

  it("the breaker counts a CONSECUTIVE tail streak, not a lifetime total", () => {
    // Three past failures, but the streak was broken -> not stuck now.
    const broken = [
      { error_class: "unknown" }, { error_class: "unknown" }, { error_class: "unknown" },
      { error_class: "rate_limited" },
    ];
    expect(signatureRepeated(broken, "unknown", 3)).toBe(false);
    expect(signatureRepeated(broken, "rate_limited", 1)).toBe(true);
  });

  it("caps: attempts, time, and cost each ESCALATE", () => {
    const base = { output: "transient blip", attempts: 0 };
    expect(decideRecovery({ ...base, attempts: 3 }, { env: E, history: [] }).reason).toBe("cap_attempts");
    expect(decideRecovery({ ...base, elapsedSeconds: 99_999 }, { env: E, history: [] }).reason).toBe("cap_time");
    expect(
      decideRecovery({ ...base, costSpent: 50 }, { env: { ...E, LOKI_RECOVERY_MAX_COST: "10" }, history: [] }).reason,
    ).toBe("cap_cost");
  });

  it("a corrupt tree -> CHECKPOINT_ROLLBACK", () => {
    const d = decideRecovery({ output: "blip", treeCorrupt: true }, { env: E, history: [] });
    expect(d.action).toBe("checkpoint_rollback");
  });

  it("provider unavailable -> FAILOVER requesting a TIER, never a model ID", () => {
    const d = decideRecovery({ output: "blip", providerUnavailable: true }, { env: E, history: [] });
    expect(d.action).toBe("failover");
    expect(d.requestTier).toBe("development");
    // Ownership boundary: recovery hands a tier to the router, which owns models.
    expect(requestTier(d.requestTier!, {})).toBe("sonnet");
  });

  it("a permanent failure outranks every cap and the breaker", () => {
    const d = decideRecovery(
      { output: "invalid_api_key", attempts: 99, treeCorrupt: true },
      { env: E, history: [{ error_class: "auth_error" }] },
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toBe("permanent:auth");
  });

  it("truthful artifacts: every decision names the exact rule that fired", () => {
    // No decision may report an action without a reason identifying its rule.
    for (const sig of [
      { output: "invalid_api_key" },
      { output: "ECONNRESET" },
      { output: "x", buildExitCode: 2 },
      { output: "x", treeCorrupt: true },
      { output: "x", attempts: 99 },
    ]) {
      const d = decideRecovery(sig, { env: E, history: [] });
      expect(d.reason.length).toBeGreaterThan(0);
      expect(d.reason).not.toContain("undefined");
    }
  });
});

// Documented flags must be reachable through process.env -- the path the runner
// actually supplies them by. A flag only ever tested via an injected env object
// is a doc claim, not a feature.
describe("documented flags reach through process.env", () => {
  const touched = [
    "LOKI_REPO_PROFILE", "LOKI_REPO_PROFILE_TTL_SECONDS", "LOKI_REPO_PROFILE_MAX_CHARS",
    "LOKI_RECOVERY_POLICY", "LOKI_RECOVERY_MAX_COST", "LOKI_RECOVERY_MAX_ATTEMPTS",
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of touched) saved[k] = process.env[k];
  afterEach(() => {
    for (const k of touched) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("LOKI_REPO_PROFILE_TTL_SECONDS expires a profile via process.env", () => {
    const root = tmp();
    const loki = resolve(root, ".loki");
    writeFileSync(resolve(root, "go.mod"), "module x");
    // Built 10s ago; a 1s TTL must expire it.
    buildProfile({ repoRoot: root, lokiDirOverride: loki, now: new Date(Date.now() - 10_000) });
    process.env["LOKI_REPO_PROFILE"] = "1";
    process.env["LOKI_REPO_PROFILE_TTL_SECONDS"] = "1";
    expect(profileFragment({ repoRoot: root, lokiDirOverride: loki })).toBe("");
    process.env["LOKI_REPO_PROFILE_TTL_SECONDS"] = "3600";
    expect(profileFragment({ repoRoot: root, lokiDirOverride: loki })).toContain("language=go");
  });

  it("LOKI_REPO_PROFILE_MAX_CHARS bounds injection via process.env", () => {
    const root = tmp();
    const loki = resolve(root, ".loki");
    writeFileSync(resolve(root, "package.json"), '{"scripts":{"build":"b","test":"t","lint":"l"}}');
    writeFileSync(resolve(root, "Makefile"), "all:");
    buildProfile({ repoRoot: root, lokiDirOverride: loki });
    process.env["LOKI_REPO_PROFILE"] = "1";
    process.env["LOKI_REPO_PROFILE_MAX_CHARS"] = "70";
    const frag = profileFragment({ repoRoot: root, lokiDirOverride: loki });
    expect(frag.length).toBeLessThanOrEqual(70);
    expect(frag).toContain("(truncated)");
  });

  it("LOKI_RECOVERY_MAX_COST and _MAX_ATTEMPTS escalate via process.env", () => {
    process.env["LOKI_RECOVERY_POLICY"] = "1";
    process.env["LOKI_RECOVERY_MAX_COST"] = "10";
    expect(decideRecovery({ output: "blip", costSpent: 50 }, { history: [] }).reason).toBe("cap_cost");
    delete process.env["LOKI_RECOVERY_MAX_COST"];
    process.env["LOKI_RECOVERY_MAX_ATTEMPTS"] = "2";
    expect(decideRecovery({ output: "blip", attempts: 2 }, { history: [] }).reason).toBe("cap_attempts");
  });

  it("recovery is wired into autonomous.ts and is default-off there", async () => {
    // The vertical slice is real only if the runner calls it. Assert the import
    // exists and that the legacy path is preserved when the flag is unset.
    const src = readFileSync(resolve(import.meta.dir, "../../src/runner/autonomous.ts"), "utf8");
    expect(src).toContain('from "./recovery_policy.ts"');
    expect(src).toContain("decideRecovery(");
    delete process.env["LOKI_RECOVERY_POLICY"];
    expect(decideRecovery({ output: "invalid_api_key" }, { history: [] }).action).toBe("stop");
    expect(decideRecovery({ output: "ECONNRESET" }, { history: [] }).action).toBe("retry");
    // Caps must NOT fire while the policy is off (legacy behavior has no caps).
    expect(decideRecovery({ output: "ECONNRESET", attempts: 99 }, { history: [] }).action).toBe("retry");
  });
});

describe("integrated slice: the four features compose", () => {
  it("a failed stream routes recovery through the manifest, profile, and router", () => {
    const root = tmp();
    const loki = resolve(root, ".loki");
    mkdirSync(loki, { recursive: true });
    writeFileSync(resolve(root, "package.json"), '{"scripts":{"test":"bun test"}}');

    // 6: profile the repo, then snapshot it read-only for the manifest.
    buildProfile({ repoRoot: root, lokiDirOverride: loki });
    const snapshot = profileFragment({ repoRoot: root, lokiDirOverride: loki, env: ON.profile });
    expect(snapshot).toContain("script.test");

    // 7: plan with that snapshot; overlapping scopes serialize.
    const m = planManifest({
      baseSha: "sha1", integrationOwner: "lead", profileSnapshot: snapshot, env: ON.manifest,
      streams: [
        { name: "impl", paths: ["src/api"], acceptance: "tests pass" },
        { name: "sweep", paths: ["src"], acceptance: "tests pass" },
      ],
    })!;
    expect(m.streams.find((s) => s.name === "sweep")!.wave).toBe(1);

    // The impl stream comes back having failed its build.
    const v = validateResult(m, {
      name: "impl", baseSha: "sha1", changedPaths: ["src/api/x.ts"], acceptanceMet: false,
    });
    expect(v.verdict).toBe("rejected_acceptance");

    // 8: a build failure maps to revise...
    const rec = decideRecovery({ output: "iteration output", buildExitCode: 1 }, { env: ON.recovery, history: [] });
    expect(rec.action).toBe("revise");

    // 5: ...and the re-attempt routes as "recovery", never below sonnet.
    const route = routeTaskClass("recovery", "haiku", { env: ON.router });
    expect(route.tier).toBe("development");
    expect(route.model).toBe("sonnet");

    // The profile was never re-written by the parallel path (read-only snapshot).
    expect(readProfile({ repoRoot: root, lokiDirOverride: loki }).status).toBe("fresh");
  });
});

// REPOMEM: repo profile discovery, baseline, reuse, attribution (pre-existing vs introduced), brief and doctor --repo. Real git repos, real node test runs.
describe("repo baseline profile (REPOMEM)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const git = (d: string, a: string[]): string => execFileSync("git", a, { cwd: d, encoding: "utf8" }).trim();
  function repo(files: Record<string, string>): string {
    const d = mkdtempSync(join(tmpdir(), "e10-repomem-"));
    dirs.push(d);
    git(d, ["init", "-q"]); git(d, ["config", "user.email", "t@t.test"]); git(d, ["config", "user.name", "t"]);
    for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), c); }
    git(d, ["add", "-A"]); git(d, ["commit", "-q", "-m", "base"]);
    writeFileSync(join(d, ".git", "info", "exclude"), ".loki/\n"); // intake does this before the profile is written
    return d;
  }
  const T = "const t=require('node:test');const assert=require('node:assert');";
  const GOOD = T + "t('good',()=>{assert.strictEqual(1,1);});\n";
  const OLD_RED = T + "t('old bug',()=>{assert.strictEqual(1,2);});\n";
  const NODE = { "package.json": JSON.stringify({ scripts: { test: "node --test", lint: "eslint .", typecheck: "tsc --noEmit", build: "echo build" } }), "good.test.js": GOOD, "old.test.js": OLD_RED };
  const never: BaselineRunner = () => { throw new Error("baseline must not run"); };

  describe("discoverCommands", () => {
    test("node: scripts become test/lint/typecheck/build, the npm placeholder test is ignored, lockfile picks the manager", () => {
      const d = repo({ ...NODE, "pnpm-lock.yaml": "" });
      expect(discoverCommands(d).map((c) => `${c.kind}=${c.cmd}`)).toEqual(["test=pnpm test", "lint=pnpm run lint", "typecheck=pnpm run typecheck", "build=pnpm run build"]);
      const e = repo({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
      expect(discoverCommands(e)).toEqual([]);
    });
    test("python: pytest, ruff, mypy from pyproject; a venv python wins", () => {
      const d = repo({ "pyproject.toml": "[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n", ".venv/bin/python": "" });
      expect(discoverCommands(d).map((c) => `${c.kind}=${c.cmd}`)).toEqual([`test=${join(".venv", "bin", "python")} -m pytest -q`, "lint=ruff check .", "typecheck=mypy ."]);
    });
    test("make: targets named test, lint, build", () => {
      const d = repo({ Makefile: ".PHONY: test\ntest:\n\techo t\nlint:\n\techo l\nbuild: lint\n\techo b\nVAR := x\n" });
      expect(discoverCommands(d).map((c) => `${c.kind}=${c.cmd}`)).toEqual(["test=make test", "lint=make lint", "build=make build"]);
    });
    test("go and cargo manifests; CI fills only a kind no manifest named and skips shell-compound lines", () => {
      expect(discoverCommands(repo({ "go.mod": "module x\n" })).map((c) => c.cmd)).toEqual(["go test ./...", "go vet ./...", "go build ./..."]);
      expect(discoverCommands(repo({ "Cargo.toml": "[package]\n" })).map((c) => c.cmd)).toEqual(["cargo test", "cargo clippy", "cargo build"]);
      const d = repo({ ".github/workflows/ci.yml": "jobs:\n  a:\n    steps:\n      - run: npm run lint\n      - run: npm test && curl x\n" });
      expect(discoverCommands(d).map((c) => `${c.kind}=${c.cmd}[${c.source}]`)).toEqual(["lint=npm run lint[.github/workflows/ci.yml]"]);
    });
  });

  describe("baseline and persistence", () => {
    test("a pre-existing failure is recorded with its id; the profile is persisted with revision and manifest hash; no litter in the tree", () => {
      const d = repo(NODE);
      const r = ensureProfile(d)!;
      expect(r.reused).toBe(false);
      const p = loadProfile(d)!;
      expect(p.revision).toBe(git(d, ["rev-parse", "HEAD"]));
      expect(p.manifest_hash).toBe(manifestHash(d));
      expect(p.baseline).toMatchObject({ ran: true, command: "npm test", attributable: true });
      expect(p.baseline.exit_code).not.toBe(0);
      expect(p.baseline.failing_ids).toContain("old bug");
      const t = p.commands.find((c) => c.kind === "test")!;
      expect(t).toMatchObject({ validated: true, failing_ids: p.baseline.failing_ids });
      expect(p.commands.filter((c) => c.kind !== "test").every((c) => c.validated === null)).toBe(true);
      expect(git(d, ["ls-files", "--others", "--exclude-standard"])).toBe("");
    }, 60_000);
    test("a green baseline records exit 0 and no failing ids", () => {
      const d = repo({ "package.json": NODE["package.json"], "good.test.js": GOOD });
      const p = ensureProfile(d)!.profile;
      expect(p.baseline).toMatchObject({ exit_code: 0, failing_ids: [], attributable: true });
    }, 60_000);
    test("reuse while the manifest hash and HEAD match; new HEAD re-runs only the baseline; a manifest edit rediscovers", () => {
      const d = repo(NODE);
      let runs = 0;
      const run: BaselineRunner = () => { runs++; return { code: 0, timedOut: false, out: "" }; };
      expect(ensureProfile(d, { run })!.reused).toBe(false); expect(runs).toBe(1);
      expect(ensureProfile(d, { run: never })!.reused).toBe(true);
      writeFileSync(join(d, "README.md"), "x"); git(d, ["add", "README.md"]); git(d, ["commit", "-q", "-m", "docs"]);
      const moved = ensureProfile(d, { run })!;
      expect(moved.reused).toBe(false); expect(runs).toBe(2);
      expect(moved.profile.commands.map((c) => c.cmd)).toEqual(["npm test", "npm run lint", "npm run typecheck", "npm run build"]);
      writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "bun test" } })); git(d, ["commit", "-q", "-am", "scripts"]);
      expect(ensureProfile(d, { run })!.profile.commands.map((c) => c.cmd)).toEqual(["npm test"]);
      expect(runs).toBe(3);
    });
    test("a timed-out or unparseable baseline is not attributable and says why; a repo with no test command records no baseline", () => {
      const d = repo(NODE);
      const to = ensureProfile(d, { run: () => ({ code: null, timedOut: true, out: "" }), timeoutS: 1 })!.profile;
      expect(to.baseline).toMatchObject({ timed_out: true, attributable: false, reason: "timed out" });
      expect(to.commands[0]).toMatchObject({ validated: false });
      const e = repo({ "README.md": "x" });
      expect(ensureProfile(e)!.profile.baseline).toMatchObject({ ran: false, reason: "no test command discovered" });
      expect(renderProfile(ensureProfile(e)!.profile)).toContain("not run (no test command discovered)");
    });
  });

  describe("attribution", () => {
    const prof = (d: string, ids: string[], attributable = true): string => {
      const base = git(d, ["rev-parse", "HEAD"]);
      mkdirSync(join(d, ".loki", "state"), { recursive: true });
      writeFileSync(commandProfilePath(d), JSON.stringify({ version: 1, revision: base, manifest_hash: "h", created_at: "t", commands: [], baseline: { ran: true, command: "npm test", exit_code: 1, duration_s: 1, timed_out: false, failing_ids: ids, attributable } }));
      return base;
    };
    test("only a check whose every id is in the baseline is pre-existing; one new id makes it introduced; unknown ids never excuse", () => {
      const d = repo(NODE), base = prof(d, ["a", "b"]);
      const a = attribute(d, base, [{ name: "n:1", ids: ["a"], eligible: true }, { name: "n:2", ids: ["a", "new"], eligible: true }, { name: "n:3", eligible: true }, { name: "n:4", ids: ["b"], eligible: false }]);
      expect(a.preExistingChecks).toEqual(["n:1"]);
      expect(a.introducedChecks).toEqual(["n:2", "n:3", "n:4"]);
      expect(a.line).toBe("baseline: 1 pre-existing failing check(s) (not blocking), 3 introduced (blocking)");
    });
    test("stale revision, unattributable or empty baseline: everything is introduced", () => {
      const d = repo(NODE), base = prof(d, ["a"]);
      expect(attribute(d, "0".repeat(40), [{ name: "n", ids: ["a"], eligible: true }]).preExistingChecks).toEqual([]);
      prof(d, ["a"], false);
      expect(attribute(d, base, [{ name: "n", ids: ["a"], eligible: true }]).preExistingChecks).toEqual([]);
      prof(d, []);
      expect(attribute(d, base, [{ name: "n", ids: ["a"], eligible: true }]).line).toBeNull();
    });
  });

  describe("verify and brief wiring", () => {
    function ctxFor(d: string, base: string, impacted: TestRef[]): RunContext {
      return { repoDir: d, runDir: join(d, ".loki"), baseSha: base, emit: () => {}, tests: { detect: async () => ({ runners: [], tests: impacted }), impacted: (_m: unknown, f: string[]) => (f.length ? impacted : []) },
        outputs: () => ({ intake: { task: "", tree: undefined }, wall: { files: [] } }) } as unknown as RunContext;
    }
    const node = (path: string): TestRef => ({ runner: "node", path }) as TestRef;
    test("a baseline-red test the agent did not touch never blocks; a test the agent broke always blocks; the line says so", async () => {
      const d = repo({ ...NODE, "feat.js": "exports.v=1;\n", "feat.test.js": T + "const {v}=require('./feat.js');t('feat',()=>{assert.strictEqual(v,1);});\n" });
      ensureProfile(d);
      const base = git(d, ["rev-parse", "HEAD"]);
      writeFileSync(join(d, "feat.js"), "exports.v=2;\n");
      const out = (await verifyStage.run(ctxFor(d, base, [node("old.test.js"), node("feat.test.js")]), new AbortController().signal)).data as Record<string, unknown>;
      expect(out["pre_red_checks"]).toEqual(["node:old.test.js"]);
      expect(out["introduced_checks"]).toEqual(["node:feat.test.js"]);
      expect(out["baseline_line"]).toBe("baseline: 1 pre-existing failing check(s) (not blocking), 1 introduced (blocking)");
      expect((out["failures_grouped"] as unknown[]).length).toBe(1);
    }, 120_000);
    describe("medium tier full suite (REPOMEM, v11.5.1)", () => {
      const FEAT = { "feat.js": "exports.v=1;\n", "feat.test.js": T + "t('feat',()=>{assert.ok(true);});\n", "other.test.js": T + "const {v}=require('./feat.js');t('other',()=>{assert.strictEqual(v,1);});\n" };
      const medium = async (d: string, impacted: TestRef[], edit: () => void): Promise<Record<string, unknown>> => {
        ensureProfile(d);
        const base = git(d, ["rev-parse", "HEAD"]);
        edit();
        const ctx = { ...ctxFor(d, base, impacted), tests: { detect: async () => ({ runners: ["npm"], tests: impacted }), impacted: (_m: unknown, f: string[]) => (f.length ? impacted : []) } } as unknown as RunContext;
        const prev = process.env["LOKI_RISK_TIER"];
        process.env["LOKI_RISK_TIER"] = "medium";
        try { return (await verifyStage.run(ctx, new AbortController().signal)).data as Record<string, unknown>; } finally { if (prev === undefined) delete process.env["LOKI_RISK_TIER"]; else process.env["LOKI_RISK_TIER"] = prev; }
      };
      const fullFails = (out: Record<string, unknown>): string[] => (out["failures_grouped"] as { signature: string }[]).map((f) => f.signature).filter((n) => n.startsWith("full suite"));
      test("red baseline, only pre-existing ids fail the full suite: listed pre-existing, not a failure", async () => {
        const d = repo({ ...NODE, ...FEAT });
        const out = await medium(d, [node("feat.test.js")], () => writeFileSync(join(d, "feat.js"), "exports.v=1;\nexports.w=2;\n"));
        expect((out["checks"] as { name: string; result: string }[]).find((c) => c.name === "full suite: npm")?.result).toBe("fail");
        expect(out["pre_red_checks"]).toContain("full suite: npm");
        expect(out["pre_red"]).toContain("old bug");
        expect(fullFails(out)).toEqual([]);
      }, 120_000);
      test("one new failing id in the full suite blocks", async () => {
        const d = repo({ ...NODE, ...FEAT });
        const out = await medium(d, [node("feat.test.js")], () => writeFileSync(join(d, "feat.js"), "exports.v=2;\n"));
        expect(out["pre_red_checks"]).not.toContain("full suite: npm");
        expect(fullFails(out).length).toBe(1);
      }, 120_000);
      test("unparseable full-suite failure output excuses nothing", async () => {
        const d = repo({ ...NODE, ...FEAT });
        const out = await medium(d, [node("feat.test.js")], () => writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('boom');process.exit(1)\"" } })));
        expect(out["pre_red_checks"]).not.toContain("full suite: npm");
        expect(fullFails(out).length).toBe(1);
      }, 120_000);
      test("a baseline-red id that a changed test file also fails is never excused", async () => {
        const d = repo({ ...NODE, ...FEAT });
        const out = await medium(d, [node("old.test.js")], () => writeFileSync(join(d, "old.test.js"), OLD_RED + "// edited\n"));
        expect(out["pre_red_checks"]).not.toContain("full suite: npm");
        expect(fullFails(out).length).toBe(1);
      }, 120_000);
      test("B1: the real run fails baseline id B plus a flaky new id X; a re-run would show only B: still blocked, nothing is re-run", async () => {
        const d = repo({ ...NODE, ...FEAT }), arm = join(d, "..", `armed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        writeFileSync(join(d, "flaky.test.js"), T + `const fs=require('node:fs');t('flaky x',()=>{if(fs.existsSync(${JSON.stringify(arm)})){fs.unlinkSync(${JSON.stringify(arm)});assert.fail('x');}});\n`);
        git(d, ["add", "flaky.test.js"]); git(d, ["commit", "-q", "-m", "flaky"]);
        const out = await medium(d, [node("feat.test.js")], () => { writeFileSync(join(d, "feat.js"), "exports.v=1;\nexports.w=2;\n"); writeFileSync(arm, "1"); });
        expect(out["pre_red_checks"]).not.toContain("full suite: npm");
        expect(fullFails(out).length).toBe(1);
      }, 120_000);
      test("attributeFullSuite attributes on the check's own ids: different baseline command, id in a changed file, blocked id, missing or empty ids are not excused", () => {
        const d = repo(NODE);
        const base = git(d, ["rev-parse", "HEAD"]);
        mkdirSync(join(d, ".loki", "state"), { recursive: true });
        writeFileSync(commandProfilePath(d), JSON.stringify({ version: 1, revision: base, manifest_hash: "h", created_at: "t", commands: [], baseline: { ran: true, command: "npm test", exit_code: 1, duration_s: 1, timed_out: false, failing_ids: ["src/a.py::t"], attributable: true } }));
        const f = (cmd: string, ids?: string[]): { name: string; cmd: string; result: string; ids?: string[] }[] => [{ name: "full suite: x", cmd, result: "fail", ...(ids ? { ids } : {}) }];
        const ok = ["src/a.py::t"];
        expect(attributeFullSuite(d, base, f("npm test --silent", ok), [], []).preExistingChecks).toEqual(["full suite: x"]);
        const narrow = attributeFullSuite(d, base, f("python -m pytest -q", ok), [], []);
        expect(narrow.preExistingChecks).toEqual([]);
        expect(narrow.line).toContain("not comparable");
        expect(attributeFullSuite(d, base, f("npm test", ok), [], ["src/a.py"]).preExistingChecks).toEqual([]);
        expect(attributeFullSuite(d, base, f("npm test", ok), ["src/a.py::t"], []).preExistingChecks).toEqual([]);
        expect(attributeFullSuite(d, base, f("npm test", [...ok, "new"]), [], []).preExistingChecks).toEqual([]);
        expect(attributeFullSuite(d, base, f("npm test"), [], []).preExistingChecks).toEqual([]);
        expect(attributeFullSuite(d, base, f("npm test", []), [], []).preExistingChecks).toEqual([]);
      });
    });
    test("without a profile verify behaves as before: no baseline fields, every failure stays", async () => {
      const d = repo({ "old.test.js": OLD_RED, "x.js": "1\n" });
      const base = git(d, ["rev-parse", "HEAD"]);
      writeFileSync(join(d, "x.js"), "2\n");
      const out = (await verifyStage.run(ctxFor(d, base, [node("old.test.js")]), new AbortController().signal)).data as Record<string, unknown>;
      expect(out["baseline_line"]).toBeUndefined();
      expect(out["pre_red_checks"]).toEqual([]);
      expect((out["failures_grouped"] as unknown[]).length).toBe(1);
    }, 120_000);
    test("the implementer brief carries the validated commands and the known-red ids, byte-stable across calls", () => {
      const d = repo(NODE);
      ensureProfile(d);
      const brief = profileBrief(d);
      expect(brief).toContain("test: npm test (validated on the untouched tree)");
      expect(brief).toContain("lint: npm run lint");
      expect(brief).toContain("old bug");
      expect(profileBrief(d)).toBe(brief);
      const ctx = ctxFor(d, git(d, ["rev-parse", "HEAD"]), []);
      expect(briefContext(ctx, { select: () => [], cmd: () => ["x", [], undefined, "."] })).toContain(brief);
      expect(profileBrief(repo({ "README.md": "x" }))).toBe("");
    }, 60_000);
    test("loki doctor --repo prints the profile, builds it on demand, --json prints it raw; --fix refreshes it", async () => {
      const d = repo(NODE), cwd = process.cwd(), chunks: string[] = [], w = process.stdout.write.bind(process.stdout);
      const cap = async (a: string[]): Promise<string> => { chunks.length = 0; process.stdout.write = ((s: string) => (chunks.push(String(s)), true)) as typeof process.stdout.write; try { await runDoctor(a); } finally { process.stdout.write = w; } return chunks.join(""); };
      try {
        process.chdir(d);
        process.env.LOKI_REPO_BASELINE = "0";
        try { expect(await cap(["--repo"])).toContain("none yet"); } finally { delete process.env.LOKI_REPO_BASELINE; }
        expect(loadProfile(d)).toBeNull();
        const built = await cap(["--repo"]); // FV-readiness-env-2: an absent profile is built on demand
        expect(built).toContain("npm test");
        expect(built).toContain("Readiness:");
        expect(loadProfile(d)!.baseline.command).toBe("npm test");
        rmSync(commandProfilePath(d));
        const fixed = await cap(["--repo", "--fix"]); // --fix means build/refresh the profile
        expect(fixed).toContain("baseline:");
        expect(loadProfile(d)).not.toBeNull();
        const before = readFileSync(commandProfilePath(d), "utf8");
        const text = await cap(["--repo"]);
        expect(text).toContain("npm test");
        expect(text).toContain("baseline:");
        expect(JSON.parse(await cap(["--repo", "--json"])).baseline.command).toBe("npm test");
        expect(readFileSync(commandProfilePath(d), "utf8")).toBe(before);
      } finally { process.chdir(cwd); }
    }, 60_000);
  });

  describe("repoReadiness (FV-readiness-env-1)", () => {
    const base = (over: Partial<CommandProfile["baseline"]> = {}): CommandProfile["baseline"] => ({ ran: true, command: "npm test", exit_code: 0, duration_s: 1, timed_out: false, failing_ids: [], attributable: true, ...over });
    const cmd = (kind: ProfileCommand["kind"], validated: boolean | null = true): ProfileCommand => ({ kind, cmd: `run ${kind}`, source: "package.json", validated, exit_code: 0, duration_s: 1, failing_ids: [] });
    const prof = (commands: ProfileCommand[], baseline = base()): CommandProfile => ({ version: 1, revision: "abc", manifest_hash: "h", created_at: "t", commands, baseline });
    const all = [cmd("test"), cmd("lint"), cmd("typecheck"), cmd("build")];
    test("clean profile scores 100; each gap costs points and carries a fix", () => {
      expect(repoReadiness(prof(all))).toMatchObject({ score: 100, grade: "A", findings: [] });
      const none = repoReadiness(prof([cmd("lint"), cmd("typecheck"), cmd("build")], base({ ran: false })));
      expect(none.score).toBe(70);
      expect(none.findings.map((f) => f.id)).toContain("no-test-command");
      expect(none.findings.every((f) => f.fix.length > 0 && f.message.length > 0)).toBe(true);
      const bare = repoReadiness(prof([cmd("test")]));
      expect(bare.score).toBe(75);
      expect(bare.findings.map((f) => f.id)).toEqual(expect.arrayContaining(["no-lint", "no-typecheck", "no-build"]));
    });
    test("red baseline names the failing ids; unattributable and timed-out baselines are flagged", () => {
      const red = repoReadiness(prof(all, base({ exit_code: 1, failing_ids: ["a", "b"] })));
      expect(red.score).toBe(80);
      const f = red.findings.find((x) => x.id === "baseline-red")!;
      expect(f.message).toContain("2");
      expect(f.fix).toContain("will not blame these on your change");
      expect(repoReadiness(prof(all, base({ timed_out: true, attributable: false }))).findings.map((x) => x.id)).toContain("baseline-unattributable");
      expect(repoReadiness(prof([{ ...cmd("test"), validated: false }, cmd("lint"), cmd("typecheck"), cmd("build")], base({ attributable: false }))).findings.map((x) => x.id)).toContain("command-not-runnable");
    });
    test("host not ready caps the score and surfaces the host fix", () => {
      const r = repoReadiness(prof(all), { firstTaskReady: false, fix: "npm install -g @anthropic-ai/claude-code" });
      expect(r.score).toBeLessThanOrEqual(40);
      expect(r.findings.find((x) => x.id === "host-not-ready")!.fix).toContain("claude-code");
    });
    test("renderProfile and doctor --repo --json carry readiness", async () => {
      const text = renderProfile(prof([cmd("test")]));
      expect(text).toContain("Readiness: 75/100 (C)");
      expect(text).toContain("Fix:");
      expect(renderProfile(prof(all))).toContain("Readiness: 100/100 (A)");
      const d = repo(NODE), cwd = process.cwd(), chunks: string[] = [], w = process.stdout.write.bind(process.stdout);
      try {
        process.chdir(d); ensureProfile(d);
        process.stdout.write = ((s: string) => (chunks.push(String(s)), true)) as typeof process.stdout.write;
        try { await runDoctor(["--repo", "--json"]); } finally { process.stdout.write = w; }
        const j = JSON.parse(chunks.join(""));
        expect(j.baseline.command).toBe("npm test");
        expect(typeof j.readiness.score).toBe("number");
        expect(Array.isArray(j.readiness.findings)).toBe(true);
      } finally { process.chdir(cwd); }
    }, 60_000);
  });

  describe("intake wiring", () => {
    const ictx = (d: string): RunContext => ({ runId: "e10-t", repoDir: d, runDir: join(d, ".loki", "runs", "e10-t"), baseSha: "", branch: "loki/e10-t", provider: "claude", model: "m", deep: false, capS: 900, emit: () => {},
      sessions: { run() { throw new Error("no session"); } }, tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] }, cost: {}, clock: { now: () => Date.now() }, outputs: () => ({}) }) as unknown as RunContext;
    test("a failing intake still prints the Readiness line when the supervisor would have folded it; a completed folded intake prints none", async () => {
      const grab = async (fn: () => Promise<unknown>): Promise<{ err: unknown; out: string }> => {
        const errs: string[] = [], we = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((s: string) => (errs.push(String(s)), true)) as typeof process.stderr.write;
        let err: unknown = null;
        try { await fn(); } catch (e) { err = e; } finally { process.stderr.write = we; }
        return { err, out: errs.join("") };
      };
      process.env.LOKI_E10_READINESS_FOLD = "1"; const speed = process.env.LOKI_SPEED; process.env.LOKI_SPEED = "0"; // the sync already-done check is what throws
      try {
        const ok = await grab(() => runIntake(ictx(repo(NODE)), new AbortController().signal, { taskText: "unrelated zzqx" }));
        expect(ok.err).toBeNull();
        expect(ok.out).not.toMatch(/Readiness:/); // folded into the last line by the supervisor
        const d = repo({ ...NODE, "src/search-command.ts": "export function search(q: string): string[] { return [q]; }\n", "CHANGELOG.md": "## 1.0\n- Added global search command palette\n" }), c = { ...ictx(d), tests: { detect: async () => ({ runners: [], tests: [{ path: "src/search-command.test.ts" }] }), impacted: () => [] } } as unknown as RunContext;
        const bad = await grab(() => runIntake(c, new AbortController().signal, { taskText: "Add global search (Cmd+K)" }));
        expect(String(bad.err)).toContain("no session");
        expect(bad.out).toMatch(/Readiness: \d+\/100 \([A-F]\)/);
      } finally { delete process.env.LOKI_E10_READINESS_FOLD; if (speed === undefined) delete process.env.LOKI_SPEED; else process.env.LOKI_SPEED = speed; }
    }, 60_000);
    test("intake writes the profile on the untouched tree and a second intake reuses it; LOKI_REPO_BASELINE=0 skips it", async () => {
      const d = repo(NODE);
      const errs: string[] = [], we = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((s: string) => (errs.push(String(s)), true)) as typeof process.stderr.write;
      try { expect((await runIntake(ictx(d), new AbortController().signal, { taskText: "t" })).status).toBe("completed"); } finally { process.stderr.write = we; }
      expect(errs.join("")).toMatch(/Readiness: \d+\/100 \([A-F]\)/); // FV-readiness-env-3: loki start surfaces the score
      const p = loadProfile(d)!;
      expect(p.baseline.failing_ids).toContain("old bug");
      expect(git(d, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
      const before = readFileSync(commandProfilePath(d), "utf8");
      await runIntake(ictx(d), new AbortController().signal, { taskText: "t" });
      expect(readFileSync(commandProfilePath(d), "utf8")).toBe(before);
      const e = repo(NODE);
      process.env.LOKI_REPO_BASELINE = "0";
      try { await runIntake(ictx(e), new AbortController().signal, { taskText: "t" }); } finally { delete process.env.LOKI_REPO_BASELINE; }
      expect(loadProfile(e)).toBeNull();
    }, 60_000);
  });
});
