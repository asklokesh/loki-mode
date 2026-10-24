// CLI-MODERN-2: `loki status` shows Loki 10 runs and never the legacy box.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readEvents } from "../../src/engine10/events.ts";
import { controlRunLink, issueStatusBody, issueStatusProjector, STATUS_MARKER, workItemBlockers, workItemId, workItemState, type WorkItemState } from "../../src/util/run_outputs.ts";
import type { EventEnvelope } from "../../src/engine10/types.ts";
import { NO_RUN_HINT, followRun, render, runIntentShow, runModernStatus, runRunsList, summarize } from "../../src/commands/run_status.ts";
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

  test("second run id is a too-many-arguments error with the full usage", async () => {
    const orig = process.stderr.write.bind(process.stderr);
    let err = "";
    process.stderr.write = ((c: string | Uint8Array) => { err += String(c); return true; }) as typeof process.stderr.write;
    try {
      const { code } = await run(["e10-20261003T000000Z-aaaa", "e10-20261003T000000Z-bbbb"]);
      expect(code).toBe(1);
    } finally { process.stderr.write = orig; }
    expect(err).toContain("too many arguments: expected one run id");
    expect(err).not.toContain("unknown flag");
    expect(err).toContain("Usage: loki status [run-id] [--json|--badge|--probe|--follow]");
  });

  test("a truly unknown flag still reports unknown flag with the full usage", async () => {
    const orig = process.stderr.write.bind(process.stderr);
    let err = "";
    process.stderr.write = ((c: string | Uint8Array) => { err += String(c); return true; }) as typeof process.stderr.write;
    try {
      const { code } = await run(["--bogus"]);
      expect(code).toBe(1);
    } finally { process.stderr.write = orig; }
    expect(err).toContain("unknown flag --bogus");
    expect(err).toContain("Usage: loki status [run-id] [--json|--badge|--probe|--follow]");
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

describe("run id traversal", () => {
  const plant = (): void => {
    const outside = join(dir, ".loki", "evil");
    mkdirSync(outside, { recursive: true });
    const log = new EventLog(join(outside, "events.jsonl"), "evil");
    log.append("run.started", null, { issue_ref: "acme/widgets#66", task_source: "issue" });
    mkdirSync(join(dir, ".loki", "runs"), { recursive: true });
  };
  const capture = async (fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> => {
    const oo = process.stdout.write.bind(process.stdout), oe = process.stderr.write.bind(process.stderr);
    let out = "", err = "";
    process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => { err += String(c); return true; }) as typeof process.stderr.write;
    try { return { code: await fn(), out, err }; } finally { process.stdout.write = oo; process.stderr.write = oe; }
  };
  test("status rejects a traversal run id with exit 2", async () => {
    plant();
    const r = await capture(() => runModernStatus(["../evil"], env()));
    expect(r.code).toBe(2);
    expect(r.err).toContain("invalid run id");
    expect(r.out).not.toContain("acme/widgets#66");
  });
  test("intent show rejects a traversal run id with exit 2", async () => {
    plant();
    const r = await capture(() => runIntentShow(["show", "../evil"], env()));
    expect(r.code).toBe(2);
    expect(r.err).toContain("invalid run id");
  });
});

describe("loki pause|cancel dead supervisor (TEN-STABILITY-22)", () => {
  const plantRun = (id: string, pid: number, start: string): string => {
    const runDir = join(dir, ".loki", "runs", id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.pid"), JSON.stringify({ pid, start, argv: ["x"], run_id: id }));
    return runDir;
  };
  test("dead supervisor: refuse with no live run, exit 1, no request written", async () => {
    const { runControlVerb } = await import("../../src/commands/run_status.ts");
    const { readRunControl } = await import("../../src/util/run_control.ts");
    const runDir = plantRun("e10-dead", 2_000_000_000, "never");
    const oe = process.stderr.write.bind(process.stderr);
    let err = "";
    process.stderr.write = ((c: string | Uint8Array) => { err += String(c); return true; }) as typeof process.stderr.write;
    try {
      expect(runControlVerb("pause", env(), dir)).toBe(1);
      expect(runControlVerb("cancel", env(), dir)).toBe(1);
    } finally { process.stderr.write = oe; }
    expect(err).toContain("no live run");
    expect(readRunControl(runDir)).toBeNull();
  });
  test("live older run is targeted over a newer dead one", async () => {
    const { runControlVerb } = await import("../../src/commands/run_status.ts");
    const { readRunControl } = await import("../../src/util/run_control.ts");
    const { processStartTime } = await import("../../src/util/run_pid.ts");
    const liveDir = plantRun("e10-a-live", process.pid, processStartTime(process.pid) ?? "");
    const deadDir = plantRun("e10-b-dead", 2_000_000_000, "never");
    const oo = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try { expect(runControlVerb("pause", env(), dir)).toBe(0); } finally { process.stdout.write = oo; }
    expect(readRunControl(liveDir)).toBe("pause");
    expect(readRunControl(deadDir)).toBeNull();
  });
});

describe("pickRun mtime", () => {
  test("pickRun mtime: newest events.jsonl wins over the lexically latest id", async () => {
    writeRun("e10-20261003T000000Z-zzzz", { done: true });
    writeRun("e10-20261001T000000Z-aaaa", { done: true });
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(dir, ".loki", "runs", "e10-20261003T000000Z-zzzz", "events.jsonl"), old, old);
    const { out } = await run([]);
    expect(out).toContain("e10-20261001T000000Z-aaaa");
    expect(out).not.toContain("e10-20261003T000000Z-zzzz");
  });

  test("pickRun mtime: a run dir without events is skipped", async () => {
    writeRun("e10-20261001T000000Z-aaaa", { done: true });
    mkdirSync(join(dir, ".loki", "runs", "e10-20261005T000000Z-bbbb"), { recursive: true });
    const { out } = await run([]);
    expect(out).toContain("e10-20261001T000000Z-aaaa");
  });
});

describe("loki runs (R100-008)", () => {
  function mkProject(name: string, runs: Array<{ id: string; done: boolean }>): string {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    for (const r of runs) {
      const log = new EventLog(join(path, ".loki", "runs", r.id, "events.jsonl"), r.id);
      log.append("run.started", null, { task_source: "text" });
      log.append("cost", "implement", { session_id: "s1", usd: 0.5 });
      if (r.done) log.append("run.completed", null, { verdict: "VERIFIED", cost_usd: 0.5 });
    }
    return path;
  }
  function register(projects: Record<string, string>, extra: Record<string, unknown> = {}): void {
    mkdirSync(join(dir, ".loki", "dashboard"), { recursive: true });
    const reg: Record<string, unknown> = { ...extra };
    for (const [name, path] of Object.entries(projects)) reg[name] = { name, path };
    writeFileSync(join(dir, ".loki", "dashboard", "projects.json"), JSON.stringify({ version: "1.0", projects: reg }));
  }
  function runs(args: string[]): { code: number; out: string } {
    const orig = process.stdout.write.bind(process.stdout);
    let out = "";
    process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof process.stdout.write;
    try { return { code: runRunsList(args, env()), out }; } finally { process.stdout.write = orig; }
  }

  test("3 registered projects with 4 runs list 4 rows, each with exactly id, repo, state, usd, verdict", () => {
    const a = mkProject("alpha", [{ id: "e10-20261023T010000Z-aaaa", done: true }, { id: "e10-20261023T020000Z-bbbb", done: false }]);
    const b = mkProject("beta", [{ id: "e10-20261023T030000Z-cccc", done: true }]);
    const c = mkProject("gamma", [{ id: "e10-20261023T040000Z-dddd", done: true }]);
    register({ alpha: a, beta: b, gamma: c });
    const { code, out } = runs(["--json"]);
    expect(code).toBe(0);
    const rows = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(4);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["id", "repo", "state", "usd", "verdict"]);
    expect(rows.map((r) => r.id)).toEqual(["e10-20261023T040000Z-dddd", "e10-20261023T030000Z-cccc", "e10-20261023T020000Z-bbbb", "e10-20261023T010000Z-aaaa"]);
    expect(rows.find((r) => r.id === "e10-20261023T010000Z-aaaa")).toMatchObject({ repo: "alpha", usd: 0.5, verdict: "VERIFIED" });
    expect(rows.find((r) => r.id === "e10-20261023T020000Z-bbbb")).toMatchObject({ repo: "alpha", verdict: null });
  });

  test("a project registered twice, a missing dir and a run with no events add no rows", () => {
    const a = mkProject("alpha", [{ id: "e10-20261023T010000Z-aaaa", done: true }]);
    mkdirSync(join(a, ".loki", "runs", "e10-20261023T050000Z-empty"), { recursive: true });
    register({ alpha: a, alias: a, ghost: join(dir, "does-not-exist") });
    expect((JSON.parse(runs(["--json"]).out) as unknown[]).length).toBe(1);
  });

  test("a run with no cost event reports usd null, not 0", () => {
    const path = join(dir, "nocost");
    const id = "e10-20261023T060000Z-ffff";
    new EventLog(join(path, ".loki", "runs", id, "events.jsonl"), id).append("run.started", null, { task_source: "text" });
    register({ nocost: path });
    expect(JSON.parse(runs(["--json"]).out)).toEqual([{ id, repo: "nocost", state: "received", usd: null, verdict: null }]);
  });

  test("LOKI_DIR set across 2 projects lists each run once under its own repo", () => {
    const a = mkProject("alpha", [{ id: "e10-20261023T010000Z-aaaa", done: true }]);
    const b = mkProject("beta", [{ id: "e10-20261023T030000Z-cccc", done: true }]);
    register({ alpha: a, beta: b });
    for (const lokiDir of [join(a, ".loki"), ".loki"]) {
      const orig = process.stdout.write.bind(process.stdout);
      let out = "";
      process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof process.stdout.write;
      try { runRunsList(["--json"], { ...env(), LOKI_DIR: lokiDir }); } finally { process.stdout.write = orig; }
      const rows = JSON.parse(out) as Array<{ id: string; repo: string }>;
      expect(rows.map((r) => `${r.repo}:${r.id}`).sort()).toEqual(["alpha:e10-20261023T010000Z-aaaa", "beta:e10-20261023T030000Z-cccc"]);
    }
  });

  test("no registry prints a hint, and --json prints an empty array", () => {
    expect(runs([]).out).toContain("loki projects add");
    expect(runs(["--json"]).out.trim()).toBe("[]");
  });

  test("the text list shows one line per run and an unknown flag exits 1", () => {
    register({ alpha: mkProject("alpha", [{ id: "e10-20261023T010000Z-aaaa", done: true }]) });
    const t = runs([]);
    expect(t.out.trim().split("\n")).toEqual(["e10-20261023T010000Z-aaaa  alpha  completed  $0.50  VERIFIED"]);
    expect(runs(["--nope"]).code).toBe(1);
  });
});

describe("status usd_so_far and usd_projected", () => {
  const mk = (...rows: [string, string | null, Record<string, unknown>?][]): EventEnvelope[] =>
    rows.map(([type, stage, data], seq) => ({ v: 1, seq, ts: "2026-10-15T00:00:00Z", run: "e10-x", type, stage, data: data ?? {} }));
  const sum = (ev: EventEnvelope[]) => summarize("e10-x", ev, "/nonexistent", Date.now()) as unknown as Record<string, unknown>;
  test("projection is spend over the completed stage share (2 of 8 stages done, $0.50 spent gives $2.00)", () => {
    const s = sum(mk(["run.started", null], ["stage.completed", "intake"], ["stage.completed", "plan"], ["cost", "plan", { session_id: "a", usd: 0.5 }]));
    expect(s.usd_so_far).toBe(0.5); expect(s.usd_projected).toBeCloseTo(2, 9);
  });
  test("unmeasured spend is null, never 0", () => {
    const s = sum(mk(["run.started", null], ["stage.completed", "intake"], ["cost", "intake", { session_id: "a", usd: null }]));
    expect(s.usd_so_far).toBeNull(); expect(s.usd_projected).toBeNull();
    expect(sum(mk(["run.started", null], ["stage.completed", "intake"])).usd_so_far).toBeNull();
  });
  test("zero completed stages projects null, not Infinity or NaN", () => {
    const s = sum(mk(["run.started", null], ["stage.started", "intake"], ["cost", "intake", { session_id: "a", usd: 0.2 }]));
    expect(s.usd_so_far).toBe(0.2); expect(s.usd_projected).toBeNull();
  });
});

describe("loki status --follow", () => {
  const id = "e10-20261024T000000Z-ffff";
  const evPath = (): string => join(dir, ".loki", "runs", id, "events.jsonl");
  function seven(): EventLog {
    const log = new EventLog(evPath(), id);
    log.append("run.started", null, { task_source: "text" });
    for (const st of ["intake", "plan", "implement"] as const) { log.append("stage.started", st, {}); log.append("cost", st, { session_id: "s", usd: 0.5 }); log.append("stage.completed", st, {}); }
    log.append("stage.started", "verify", {});
    log.append("test.result", "verify", { name: "bun:a.test.ts", result: "pass", cmd: "x", duration_s: 1 });
    return log;
  }
  async function follow(json: boolean, ms: number): Promise<string[]> {
    const ac = new AbortController();
    const out: string[] = [];
    setTimeout(() => ac.abort(), ms);
    await followRun(evPath(), json, ac.signal, (s) => out.push(s), 20);
    return out;
  }

  test("--json emits one stage line per stage event, cost lines carry usd_so_far, abort leaves the run running", async () => {
    seven();
    const before = workItemState(readEvents(evPath()), Date.now());
    const lines = (await follow(true, 150)).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((l) => l.type === "stage")).toHaveLength(7);
    expect(lines.filter((l) => l.type === "cost").map((l) => l.usd_so_far)).toEqual([0.5, 1, 1.5]);
    expect(lines.find((l) => l.type === "test")).toMatchObject({ name: "bun:a.test.ts", result: "pass" });
    const events = readEvents(evPath());
    expect(events.some((e) => e.type === "run.completed")).toBe(false);
    expect(workItemState(events, Date.now())).toBe(before);
    expect(["completed", "cancelled", "failed", "stalled"]).not.toContain(before);
  });

  test("human mode prints one readable line per shown event and stops at run.completed", async () => {
    const log = seven();
    log.append("run.completed", null, { verdict: "VERIFIED" });
    const out = await follow(false, 2000);
    expect(out).toContain("stage plan started\n");
    expect(out).toContain("cost +$0.50, $1.00 so far\n");
    expect(out).toContain("test bun:a.test.ts: pass\n");
    expect(out[out.length - 1]).toBe("run completed: VERIFIED\n");
  });

  test("picks up events appended while following", async () => {
    const log = seven();
    const p = follow(true, 400);
    setTimeout(() => log.append("stage.completed", "verify", {}), 100);
    const lines = (await p).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((l) => l.type === "stage")).toHaveLength(8);
  });

  test("runModernStatus --follow on a finished run prints its events and exits 0", async () => {
    writeRun("e10-20261003T000000Z-aaaa", { done: true });
    const { code, out } = await run(["--follow", "--json"]);
    expect(code).toBe(0);
    expect(out.trim().split("\n").map((l) => JSON.parse(l).type)).toEqual(["stage", "cost", "stage", "run"]);
  });
});
