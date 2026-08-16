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
import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

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
