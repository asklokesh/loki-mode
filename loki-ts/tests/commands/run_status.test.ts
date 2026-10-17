// CLI-MODERN-2: `loki status` shows Loki 10 runs and never the legacy box.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readEvents } from "../../src/engine10/events.ts";
import { controlRunLink, issueStatusBody, issueStatusProjector, STATUS_MARKER, workItemBlockers, workItemId, workItemState, type WorkItemState } from "../../src/util/run_outputs.ts";
import type { EventEnvelope } from "../../src/engine10/types.ts";
import { NO_RUN_HINT, render, runIntentShow, runModernStatus, summarize } from "../../src/commands/run_status.ts";
import { DEFAULT_PUSH_SH } from "../../src/engine10/stages/pr.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "e10-modern-status-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const env = (): NodeJS.ProcessEnv => ({ LOKI_E10_REPO_DIR: dir, LOKI_CONTROL: "0", HOME: dir });

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof process.stdout.write;
  try { return { code: await runModernStatus(args, env()), out }; } finally { process.stdout.write = orig; }
}

function writeRun(id: string, opts: { done: boolean }): void {
  const runDir = join(dir, ".loki", "runs", id);
  const log = new EventLog(join(runDir, "events.jsonl"), id);
  log.append("run.started", null, { issue_ref: "acme/widgets#12", task_source: "issue" });
  log.append("stage.started", "implement", {});
  log.append("cost", "implement", { session_id: "s1", usd: 0.42 });
  if (opts.done) {
    log.append("stage.completed", "implement", { duration_s: 5 });
    writeFileSync(join(runDir, "receipt.json"), "{}");
    log.append("pr.opened", "pr", { url: "https://github.com/acme/widgets/pull/99", draft: false });
    log.append("run.completed", null, { verdict: "VERIFIED", pr_url: "https://github.com/acme/widgets/pull/99", cost_usd: 0.42 });
  }
}

describe("loki status (Loki 10)", () => {
  test("a completed run shows id, ref, cost, outcome, PR and receipt", async () => {
    writeRun("e10-20261003T000000Z-aaaa", { done: true });
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(out).toContain("e10-20261003T000000Z-aaaa");
    expect(out).toContain("VERIFIED");
    expect(out).toContain("acme/widgets#12");
    expect(out).toContain("$0.42");
    expect(out).toContain("https://github.com/acme/widgets/pull/99");
    expect(out).toContain("receipt.json");
  });

  test("text and json status carry last event age and seq (P12-19)", async () => {
    writeRun("e10-20261003T000000Z-aaaa", { done: true });
    const { out } = await run([]);
    expect(out).toMatch(/last event \d+s ago \(seq 5\)/);
    const j = JSON.parse((await run(["--json"])).out);
    expect(j.last_event_seq).toBe(5);
    expect(j.last_event_ago_s).toBeGreaterThanOrEqual(0);
  });
  test("a running Control Plane yields a per-run deep link (P12-19)", async () => {
    writeRun("e10-20261003T000000Z-aaaa", { done: true });
    const orig = process.stdout.write.bind(process.stdout);
    let out = "";
    process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof process.stdout.write;
    try { await runModernStatus([], { ...env(), LOKI_CONTROL: "1", LOKI_CONTROL_URL: "http://127.0.0.1:47821/" }); } finally { process.stdout.write = orig; }
    expect(out).toMatch(/Control Plane run: http:\/\/127\.0\.0\.1:47821\/#\/runs\/[0-9a-f]{16}\/e10-20261003T000000Z-aaaa/);
    expect(controlRunLink(null, dir, "r")).toBeNull();
    expect(controlRunLink("javascript:x", dir, "r")).toBeNull();
  });

  test("--badge is routed to the deploy badge, not rejected as an unknown flag", async () => {
    const prev = process.env.LOKI_DIR;
    process.env.LOKI_DIR = join(dir, ".loki");
    try {
      const { code, out } = await run(["--badge"]);
      expect(code).toBe(0);
      expect(out.toLowerCase()).not.toContain("unknown flag");
    } finally {
      if (prev === undefined) delete process.env.LOKI_DIR; else process.env.LOKI_DIR = prev;
    }
  });

  test("--probe is routed to the deploy probe, not rejected as an unknown flag", async () => {
    const prev = process.env.LOKI_DIR;
    process.env.LOKI_DIR = join(dir, ".loki");
    try {
      const { code, out } = await run(["--probe"]);
      expect(code).toBe(0);
      expect(out.toLowerCase()).not.toContain("unknown flag");
      expect(out).toContain("No deploy to probe");
    } finally {
      if (prev === undefined) delete process.env.LOKI_DIR; else process.env.LOKI_DIR = prev;
    }
  });

  test("a live run is preferred over a newer-named completed one and shows its stage", async () => {
    writeRun("e10-20261003T000000Z-aaaa", { done: false });
    const { out } = await run([]);
    expect(out).toContain("executing, implement");
  });

  test("only a stale STATUS.txt: no legacy box, one hint line", async () => {
    mkdirSync(join(dir, ".loki"), { recursive: true });
    writeFileSync(join(dir, ".loki", "STATUS.txt"), "Updated: Wed Jan 7 2026\nPhase: BOOTSTRAP\n");
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(out).toBe(`${NO_RUN_HINT}\n`);
    expect(out).not.toMatch(/BOOTSTRAP|Phase|analyze|Loki Mode Status/);
  });

  test("no runs at all: exactly one hint line", async () => {
    const { out } = await run([]);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(out).toContain("loki");
  });

  test("--json parses and carries the same fields", async () => {
    writeRun("e10-20261003T000000Z-aaaa", { done: true });
    const j = JSON.parse((await run(["--json"])).out);
    expect(j.run_id).toBe("e10-20261003T000000Z-aaaa");
    expect(j.ref).toBe("acme/widgets#12");
    expect(j.outcome).toBe("VERIFIED");
    expect(j.cost_usd).toBeCloseTo(0.42);
    expect(j.pr_url).toBe("https://github.com/acme/widgets/pull/99");
    expect(j.receipt_path).toContain("receipt.json");
    expect(j.control_plane_url).toBeNull();
  });

  test("--json with no runs still parses", async () => {
    const j = JSON.parse((await run(["--json"])).out);
    expect(j.run_id).toBeNull();
    expect(j.hint).toBe(NO_RUN_HINT);
  });

  describe("Control Plane URL (A6a)", () => {
    let srv: ReturnType<typeof Bun.serve>;
    beforeEach(() => { srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ service: "loki-control", pid: process.pid }) }); });
    afterEach(() => { srv.stop(true); });
    async function runWith(e: NodeJS.ProcessEnv, args: string[]): Promise<string> {
      const orig = process.stdout.write.bind(process.stdout);
      let out = "";
      process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof process.stdout.write;
      try { await runModernStatus(args, e); } finally { process.stdout.write = orig; }
      return out;
    }

    test("prints the URL the running CP listens on when instance.json is absent (LOKI_CONTROL_PORT)", async () => {
      writeRun("e10-20261003T000000Z-cccc", { done: true });
      const out = await runWith({ LOKI_E10_REPO_DIR: dir, HOME: dir, LOKI_CONTROL_PORT: String(srv.port) }, []);
      expect(out).toContain(`Control Plane: http://127.0.0.1:${srv.port}`);
    });

    test("a stale instance.json (dead pid) does not hide a live CP", async () => {
      mkdirSync(join(dir, ".loki", "control"), { recursive: true });
      writeFileSync(join(dir, ".loki", "control", "instance.json"), JSON.stringify({ pid: 2147483646, url: "http://127.0.0.1:1" }));
      const j = JSON.parse(await runWith({ LOKI_E10_REPO_DIR: dir, HOME: dir, LOKI_CONTROL_PORT: String(srv.port) }, ["--json"]));
      expect(j.control_plane_url).toBe(`http://127.0.0.1:${srv.port}`);
    });

    test("no runs: the text output still names the CP URL", async () => {
      const out = await runWith({ LOKI_E10_REPO_DIR: dir, HOME: dir, LOKI_CONTROL_PORT: String(srv.port) }, []);
      expect(out).toContain(`Control Plane: http://127.0.0.1:${srv.port}`);
    });

    test("nothing listening: no Control Plane line", async () => {
      const out = await runWith({ LOKI_E10_REPO_DIR: dir, HOME: dir, LOKI_CONTROL_PORT: "1" }, []);
      expect(out).not.toContain("Control Plane:");
    });
  });
});

describe("work-item state (one vocabulary)", () => {
  const mk = (...rows: [string, string | null, Record<string, unknown>?][]): EventEnvelope[] =>
    rows.map(([type, stage, data], seq) => ({ v: 1, seq, ts: "2026-10-15T00:00:00Z", run: "e10-x", type, stage, data: data ?? {} }));
  const S = (t: string, st: string) => [t, st] as [string, string];
  const cases: [string, EventEnvelope[], WorkItemState][] = [
    ["received", mk(["run.started", null]), "received"],
    ["prepared", mk(["run.started", null], ["stage.completed", "intake"]), "prepared"],
    ["planned", mk(["run.started", null], ["stage.completed", "intake"], ["stage.completed", "plan"]), "planned"],
    ["executing", mk(["run.started", null], ["stage.completed", "plan"], ["stage.started", "implement"]), "executing"],
    ["validating", mk(["run.started", null], ["stage.completed", "implement"], S("stage.started", "verify")), "validating"],
    ["ready_to_ship", mk(["run.started", null], ["stage.completed", "implement"], ["receipt.sealed", "seal"]), "ready_to_ship"],
    ["completed", mk(["run.started", null], ["run.completed", null, { verdict: "VERIFIED" }]), "completed"],
    ["waiting_for_input", mk(["run.started", null], ["run.completed", null, { verdict: "SPEC_CONFLICT" }]), "waiting_for_input"],
    ["budget_stopped", mk(["run.started", null], ["cap.hit", null], ["run.completed", null, { verdict: "PARTIAL" }]), "budget_stopped"],
    ["failed", mk(["run.started", null], ["run.completed", null, { verdict: "FAILED" }]), "failed"],
    ["cancelled", mk(["run.started", null], ["run.completed", null, { cancelled: true }]), "cancelled"],
  ];
  for (const [name, ev, want] of cases) test(name, () => expect(workItemState(ev)).toBe(want));
  test("stalled only with a clock and 30m of silence", () => {
    const ev = mk(["run.started", null], ["stage.started", "implement"]);
    expect(workItemState(ev)).toBe("executing");
    expect(workItemState(ev, Date.parse("2026-10-15T00:31:00Z"))).toBe("stalled");
    expect(workItemState(ev, Date.parse("2026-10-15T00:10:00Z"))).toBe("executing");
  });
  describe("P12-08 extended lifecycle (transition table)", () => {
    // Only states with a real engine writer: pr.opened (supervisor) and deep.started (supervisor, detached post-PR verify).
    const seqs: [string, EventEnvelope[], WorkItemState][] = [
      ["pr opened, not observed -> delivering", mk(["run.started", null], ["stage.completed", "implement"], ["receipt.sealed", "seal"], ["pr.opened", "pr"]), "delivering"],
      ["pr opened then deep verify started -> observing", mk(["run.started", null], ["pr.opened", "pr"], ["deep.started", "deep", { pid: 1 }]), "observing"],
      ["run.completed after pr.opened stays terminal", mk(["run.started", null], ["pr.opened", "pr"], ["run.completed", null, { verdict: "VERIFIED" }]), "completed"],
    ];
    for (const [name, ev, want] of seqs) test(name, () => expect(workItemState(ev)).toBe(want));
    test("delivering falls to stalled after 30m silence", () => {
      expect(workItemState(seqs[0]![1], Date.parse("2026-10-15T01:00:00Z"))).toBe("stalled");
    });
    const conflict = mk(["run.started", null, { issue_ref: "o/r#5" }], ["stage.completed", "implement", { spec_conflict_reason: "spec says A and B" }], ["run.completed", null, { verdict: "SPEC_CONFLICT" }]);
    test("blockers are a separate field, never in the state string (real writer: implement spec_conflict_reason)", () => {
      expect(workItemBlockers(conflict)).toEqual(["spec_conflict: spec says A and B"]);
      expect(workItemState(conflict)).toBe("waiting_for_input");
      expect(workItemBlockers(seqs[0]![1])).toEqual([]);
      expect(workItemBlockers(mk(["run.started", null], ["run.completed", null, { verdict: "SPEC_CONFLICT" }]))).toEqual(["spec_conflict: unspecified"]);
    });
    test("blockers use the LATEST implement stage.completed (a re-run supersedes the earlier one)", () => {
      const rerun = mk(["run.started", null], ["stage.completed", "implement", { spec_conflict_reason: "old reason" }], ["stage.completed", "implement", { spec_conflict_reason: "new reason" }], ["run.completed", null, { verdict: "SPEC_CONFLICT" }]);
      expect(workItemBlockers(rerun)).toEqual(["spec_conflict: new reason"]);
    });
    test("render shows the Blockers line only when there are blockers", () => {
      const text = (ev: EventEnvelope[]): string => render({ ...summarize("e10-x", ev, dir, Date.now()), control_plane_url: null } as never);
      expect(text(conflict)).toContain("  Blockers: spec_conflict: spec says A and B");
      expect(text(seqs[0]![1])).not.toContain("Blockers");
    });
    test("work_item_id is keyed by the issue ref and spans runs; summarize and status --json carry it", async () => {
      const a = mk(["run.started", null, { issue_ref: "o/r#5" }]), b = mk(["run.started", null, { issue_ref: "o/r#5" }, ]);
      expect(workItemId(a)).toBe("o/r#5");
      expect(workItemId(b)).toBe(workItemId(a));
      expect(workItemId(mk(["run.started", null]))).toBeNull();
      expect(summarize("e10-x", a, dir, Date.now()).work_item_id).toBe("o/r#5");
      writeRun("e10-20261003T000002Z-ffff", { done: false });
      expect(JSON.parse((await run(["--json"])).out).work_item_id).toBe("acme/widgets#12");
    });
    test("the existing 12 states are unchanged (11 in the table plus stalled)", () => {
      expect(new Set(cases.map(([, , w]) => w)).size).toBe(11);
    });
  });
  test("text status renders the state; the verdict stays detail", () => {
    const first = (ev: EventEnvelope[]): string => render({ ...summarize("e10-x", ev, dir, Date.now()), control_plane_url: null } as never).split("\n")[0]!;
    expect(first(mk(["run.started", null], ["run.completed", null, { verdict: "SPEC_CONFLICT" }]))).toMatch(/^Loki 10 run e10-x: waiting_for_input/);
    expect(first(mk(["run.started", null], ["cap.hit", null], ["run.completed", null, { verdict: "PARTIAL" }]))).toMatch(/^Loki 10 run e10-x: budget_stopped/);
  });
  test("the projector reaches the real push script only with the pinned origin (main() env has no pin)", async () => {
    const bin = join(dir, "bin"), ghLog = join(dir, "gh.log"); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${ghLog}"\nexit 0\n`); chmodSync(join(bin, "gh"), 0o755);
    const runDir = join(dir, ".loki", "runs", "r3"), eventsPath = join(runDir, "events.jsonl");
    new EventLog(eventsPath, "r3").append("run.started", null, {});
    const base: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` }; delete base._LOKI_ORIGIN_PINNED; delete base._LOKI_PINNED_ORIGIN;
    const o = { pushSh: DEFAULT_PUSH_SH, env: base, repoDir: dir, runDir, runId: "r3", issueRef: "octocat/hello#9", eventsPath };
    expect((await issueStatusProjector(o)())!.ok).toBe(false);
    expect((await issueStatusProjector({ ...o, origin: "https://github.com/octocat/hello.git" })())!.ok).toBe(true);
    expect(readFileSync(ghLog, "utf8")).toContain("octocat/hello");
  });
  test("loki status --json emits state", async () => {
    writeRun("e10-20261003T000000Z-dddd", { done: true });
    expect(JSON.parse((await run(["--json"])).out).state).toBe("completed");
    writeRun("e10-20261003T000001Z-eeee", { done: false });
    expect(JSON.parse((await run(["--json", "e10-20261003T000001Z-eeee"])).out).state).toBe("executing");
  });
});

describe("loki intent show <run>", () => {
  const show = async (args: string[]): Promise<{ code: number; out: string; err: string }> => {
    const oo = process.stdout.write.bind(process.stdout);
    const oe = process.stderr.write.bind(process.stderr);
    let out = ""; let err = "";
    process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => { err += String(c); return true; }) as typeof process.stderr.write;
    try { return { code: await runIntentShow(args, env()), out, err }; } finally { process.stdout.write = oo; process.stderr.write = oe; }
  };
  const mk = (id: string, planData: Record<string, unknown>): string => {
    const runDir = join(dir, ".loki", "runs", id);
    const log = new EventLog(join(runDir, "events.jsonl"), id);
    log.append("run.started", null, {});
    log.append("stage.completed", "plan", planData);
    return runDir;
  };

  test("prints card and the answer", async () => {
    const rd = mk("r1", { intent_enabled: true, intent_card: ["What I think you want: a thing", "Acceptance: it works", "Acceptance: tests pass"] });
    writeFileSync(join(rd, "intent-answer.txt"), "y\n");
    const r = await show(["show", "r1"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("What I think you want:");
    expect(r.out).toContain("Acceptance: it works");
    expect(r.out).toContain("answered: y");
  });
  test("no card prints NOT STATED", async () => {
    mk("r2", { plan: "x" });
    const r = await show(["show", "r2"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Intent: NOT STATED by plan");
    expect(r.out).not.toContain("answered:");
  });
  test("unknown run exits 1", async () => {
    const r = await show(["show", "nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no such run");
  });
});

describe("issue status projector (FV-gh-steer-3)", () => {
  const stub = (): { sh: string; log: string } => {
    const sh = join(dir, "push-stub.sh"), log = join(dir, "push.log");
    writeFileSync(sh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncp "$4" "${log}.body"\nexit 0\n`, { mode: 0o755 });
    return { sh, log };
  };
  test("the body carries the marker, plan state and PR link, and flattens untrusted reason text", () => {
    const runDir = join(dir, ".loki", "runs", "r1"), log = new EventLog(join(runDir, "events.jsonl"), "r1");
    log.append("run.started", null, {});
    const none = issueStatusBody(readEvents(join(runDir, "events.jsonl")), { runId: "r1", steerRevs: 0 });
    expect(none).toContain(STATUS_MARKER);
    expect(none).toContain("Plan: pending");
    log.append("stage.completed", "plan", { plan: "SECRET PLAN TEXT" });
    const evs = readEvents(join(runDir, "events.jsonl"));
    const body = issueStatusBody(evs, { runId: "r1", steerRevs: 2, prUrl: "https://github.com/o/r/pull/3", outcome: "BLOCKED", reason: "x <!-- loki-status --> @victim `rm`\nline2" });
    expect(body).toContain("Plan: ready");
    expect(body).toContain("Operator steers applied: 2");
    expect(body).toContain("Pull request: https://github.com/o/r/pull/3");
    expect(body).not.toContain("SECRET PLAN TEXT");
    expect(body).toMatch(/Last event: seq \d+/);
    expect(body).not.toContain("Control Plane:");
    expect(issueStatusBody(evs, { runId: "r1", steerRevs: 0, controlUrl: "http://127.0.0.1:47821/#/runs/abc/r1" })).toContain("Control Plane: http://127.0.0.1:47821/#/runs/abc/r1");
    expect(body.match(/<!-- loki-status -->/g)!.length).toBe(1);
    expect(body).not.toMatch(/@victim|`rm`/);
  });
  test("each projection upserts via issue-comment --update; an unchanged body is not re-posted", async () => {
    const { sh, log } = stub(), runDir = join(dir, ".loki", "runs", "r2"), eventsPath = join(runDir, "events.jsonl");
    const ev = new EventLog(eventsPath, "r2"); ev.append("run.started", null, {});
    const project = issueStatusProjector({ pushSh: sh, env: process.env, repoDir: dir, runDir, runId: "r2", issueRef: "acme/widgets#12", eventsPath });
    expect((await project())!.ok).toBe(true);
    expect((await project())!.ok).toBe(true); // identical body: skipped
    ev.append("stage.completed", "plan", {});
    const calls = await Promise.all([project(), project({ prUrl: "https://github.com/o/r/pull/3" })]); // concurrent: serialised
    expect(calls.every((c) => c?.ok)).toBe(true);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.length).toBe(3);
    for (const l of lines) expect(l).toMatch(/^issue-comment --update acme\/widgets#12 .*status-comment\.md$/);
    expect(readFileSync(`${log}.body`, "utf8")).toContain("Pull request: https://github.com/o/r/pull/3");
    expect(existsSync(join(runDir, "status-comment.md"))).toBe(true);
  });
});
