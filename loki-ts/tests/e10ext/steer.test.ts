// Operator steer on engine10: HUMAN_INPUT.md is injected into the next plan/implement brief once, then archived.
import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, utimesSync, lstatSync, linkSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINISH_LINE } from "../../src/e10ext/context.ts";
import { STEER_BEGIN, STEER_END, consumeSteer, type IntentRevision, readIntentRevisions, staleAtSeal, staleReason, staleWallRevisions, withSteer } from "../../src/util/steer.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const repo = (steer?: string): string => {
  const d = mkdtempSync(join(tmpdir(), "steer-test-")); dirs.push(d);
  mkdirSync(join(d, ".loki"));
  if (steer !== undefined) writeFileSync(join(d, ".loki", "HUMAN_INPUT.md"), steer);
  return d;
};
const archived = (d: string): string[] => { try { return readdirSync(join(d, ".loki", "logs")); } catch { return []; } };

describe("engine10 steer", () => {
  test("implement brief gets the block before FINISH_LINE, file archived", () => {
    const d = repo("## Operator directive\nskip the docs\n");
    const brief = `rules\n\ntask\n\n${FINISH_LINE}`;
    const out = withSteer({ stage: "implement", brief }, d).brief as string;
    expect(out.startsWith("rules\n\ntask\n\n")).toBe(true);
    expect(out.endsWith(FINISH_LINE)).toBe(true);
    expect(out).toContain(STEER_BEGIN);
    expect(out).toContain("skip the docs");
    expect(out).toContain(STEER_END);
    expect(existsSync(join(d, ".loki", "HUMAN_INPUT.md"))).toBe(false);
    expect(archived(d).some((f) => f.startsWith("human-input-"))).toBe(true);
  });

  test("applies once", () => {
    const d = repo("do X");
    expect((withSteer({ stage: "plan", brief: "b" }, d).brief as string)).toContain("do X");
    expect(withSteer({ stage: "implement", brief: "b" }, d).brief).toBe("b");
  });

  test("other stages and absent file leave the brief untouched and keep the file", () => {
    const d = repo("do X");
    expect(withSteer({ stage: "verify", brief: "b" }, d).brief).toBe("b");
    expect(existsSync(join(d, ".loki", "HUMAN_INPUT.md"))).toBe(true);
    expect(withSteer({ stage: "implement", brief: "b" }, repo()).brief).toBe("b");
  });

  test("symlink rejected, empty file archived without injection, opt-out honoured", () => {
    const d = repo();
    writeFileSync(join(d, "target.md"), "evil");
    symlinkSync(join(d, "target.md"), join(d, ".loki", "HUMAN_INPUT.md"));
    expect(consumeSteer(d)).toBeNull();
    expect(existsSync(join(d, ".loki", "HUMAN_INPUT.md"))).toBe(false);
    expect(consumeSteer(repo("  \n"))).toBeNull();
    const o = repo("x");
    expect(consumeSteer(o, { LOKI_PROMPT_INJECTION: "0" })).toBeNull();
    expect(existsSync(join(o, ".loki", "HUMAN_INPUT.md"))).toBe(true);
  });
  test("a regular steer swapped for a symlink (live or dangling) still refuses with the symlink reason and never reads the target", () => {
    for (const target of ["secret.md", "missing.md"]) {
      const d = repo("real");
      writeFileSync(join(d, "secret.md"), "SECRET");
      rmSync(join(d, ".loki", "HUMAN_INPUT.md"));
      symlinkSync(join(d, target), join(d, ".loki", "HUMAN_INPUT.md"));
      const sink: IntentRevision[] = [];
      expect(consumeSteer(d, {}, () => new Date(), sink)).toBeNull();
      expect(sink.map((r) => [r.unapplied, r.reason])).toEqual([[true, "symlink"]]);
      expect(existsSync(join(d, ".loki", "HUMAN_INPUT.md"))).toBe(false);
      expect(archived(d)).toEqual([]);
    }
  });
  test("the content comes from the opened fd: the claimed path swapped to a symlink after the open is not followed", () => {
    const d = repo("REAL");
    writeFileSync(join(d, "secret.md"), "SECRET");
    let swapped = false;
    const afterOpen = (c: string): void => { swapped = true; renameSync(c, join(d, "moved.md")); symlinkSync(join(d, "secret.md"), c); };
    expect(consumeSteer(d, {}, () => new Date(), undefined, { afterOpen })).toBe("REAL");
    expect(swapped).toBe(true);
  });
  test("a steer written between the read and the archive is not lost: it becomes a fresh inbox file consumed next", () => {
    const d = repo("FIRST");
    const f = join(d, ".loki", "HUMAN_INPUT.md");
    let wrote = false;
    const afterClaim = (): void => { wrote = true; writeFileSync(f, "SECOND"); };
    expect(consumeSteer(d, {}, () => new Date(), undefined, { afterClaim })).toBe("FIRST");
    expect(wrote).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("SECOND");
    expect(consumeSteer(d)).toBe("SECOND");
    expect(archived(d).filter((n) => n.startsWith("human-input-")).length).toBe(2);
  });
  test("content appended after the open (size changed since any fstat) is read to EOF, not truncated", () => {
    const d = repo("A".repeat(10));
    const extra = "B".repeat(200000);
    const afterOpen = (c: string): void => appendFileSync(c, extra);
    expect(consumeSteer(d, {}, () => new Date(), undefined, { afterOpen })).toBe("A".repeat(10) + extra);
  });
  test("growth past 1 MiB after the open is still quarantined as oversize with an unapplied record", () => {
    const d = repo("x");
    const sink: IntentRevision[] = [];
    const afterOpen = (c: string): void => appendFileSync(c, "y".repeat(1024 * 1024 + 5));
    expect(consumeSteer(d, {}, () => new Date(), sink, { afterOpen })).toBeNull();
    expect(sink.map((r) => [r.unapplied, r.reason])).toEqual([[true, "over 1 MiB"]]);
  });
  test("two consumers choosing the same archive name never replace an earlier archive", () => {
    const d = repo("MINE");
    const fixed = new Date("2026-10-16T01:02:03.000Z");
    const taken = join(d, ".loki", "logs", "human-input-20261016T010203.md");
    const afterOpen = (): void => { mkdirSync(join(d, ".loki", "logs"), { recursive: true }); writeFileSync(taken, "OTHER"); };
    expect(consumeSteer(d, {}, () => fixed, undefined, { afterOpen })).toBe("MINE");
    expect(readFileSync(taken, "utf8")).toBe("OTHER");
    expect(archived(d).filter((n) => n.startsWith("human-input-")).map((n) => readFileSync(join(d, ".loki", "logs", n), "utf8")).sort()).toEqual(["MINE", "OTHER"]);
  });
  test("a non-file steer restored in place never replaces a fresh steer written meanwhile", () => {
    const d = repo();
    const f = join(d, ".loki", "HUMAN_INPUT.md");
    execFileSync("mkfifo", [f]);
    const sink: IntentRevision[] = [];
    const beforeRestore = (): void => writeFileSync(f, "FRESH");
    expect(consumeSteer(d, {}, () => new Date(), sink, { beforeRestore })).toBeNull();
    expect(readFileSync(f, "utf8")).toBe("FRESH");
    expect(sink.map((r) => [r.unapplied, r.reason])).toEqual([[true, "not a regular file"]]);
    expect(archived(d).some((n) => n.startsWith("human-input-REJECTED-NOTFILE-"))).toBe(true);
    expect(consumeSteer(d)).toBe("FRESH");
  });
  test("a hard-link failure (no-hardlink filesystem) never renames over a fresh steer: the non-file entry is quarantined", () => {
    const d = repo();
    const f = join(d, ".loki", "HUMAN_INPUT.md");
    execFileSync("mkfifo", [f]);
    const sink: IntentRevision[] = [];
    const link = ((): never => { throw Object.assign(new Error("no hard links"), { code: "EPERM" }); }) as unknown as typeof linkSync;
    expect(consumeSteer(d, {}, () => new Date(), sink, { beforeRestore: () => writeFileSync(f, "FRESH"), link })).toBeNull();
    expect(readFileSync(f, "utf8")).toBe("FRESH");
    expect(sink.map((r) => [r.unapplied, r.reason])).toEqual([[true, "not a regular file"]]);
    expect(archived(d).some((n) => n.startsWith("human-input-REJECTED-NOTFILE-"))).toBe(true);
  });
  const deadPid = (): number => spawnSync("true").pid!;
  test("a claim orphaned by a dead consumer is archived and reported unapplied; a live pid's claim is left alone", () => {
    const d = repo();
    mkdirSync(join(d, ".loki", "logs"));
    const gone = `.claim-${deadPid()}-abc123`, live = `.claim-${process.ppid}-abc123`;
    writeFileSync(join(d, ".loki", "logs", gone), "LOST");
    writeFileSync(join(d, ".loki", "logs", live), "BUSY");
    const sink: IntentRevision[] = [];
    expect(consumeSteer(d, {}, () => new Date(), sink)).toBeNull();
    expect(sink.map((r) => [r.unapplied, r.reason])).toEqual([[true, "orphaned claim"]]);
    const names = archived(d);
    expect(names).toContain(live);
    expect(names).not.toContain(gone);
    const o = names.find((n) => n.startsWith("human-input-ORPHAN-"))!;
    expect(readFileSync(join(d, ".loki", "logs", o), "utf8")).toBe("LOST");
  });
  test("a stale claim is orphaned even when its pid answers (recycled pid); a fresh one is left alone", () => {
    const d = repo();
    const logs = join(d, ".loki", "logs");
    mkdirSync(logs);
    const stale = `.claim-${process.ppid}-aaaaaa`, fresh = `.claim-${process.ppid}-bbbbbb`;
    writeFileSync(join(logs, stale), "OLD"); writeFileSync(join(logs, fresh), "NEW");
    const old = new Date(Date.now() - 11 * 60 * 1000); utimesSync(join(logs, stale), old, old);
    const sink: IntentRevision[] = [];
    expect(consumeSteer(d, {}, () => new Date(), sink)).toBeNull();
    expect(sink.map((r) => [r.unapplied, r.reason])).toEqual([[true, "orphaned claim"]]);
    const names = archived(d);
    expect(names).not.toContain(stale);
    expect(names).toContain(fresh);
    const o = names.find((n) => n.startsWith("human-input-ORPHAN-"))!;
    expect(readFileSync(join(logs, o), "utf8")).toBe("OLD");
  });
  test("an orphan sharing an inode with an ORPHAN archive (unlink failed after link) is removed without a new archive or record", () => {
    const d = repo();
    const logs = join(d, ".loki", "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "human-input-ORPHAN-20200101T000000.md"), "LOST");
    linkSync(join(logs, "human-input-ORPHAN-20200101T000000.md"), join(logs, `.claim-${deadPid()}-abc123`));
    const sink: IntentRevision[] = [];
    expect(consumeSteer(d, {}, () => new Date(), sink)).toBeNull();
    expect(sink).toEqual([]);
    expect(archived(d)).toEqual(["human-input-ORPHAN-20200101T000000.md"]);
  });
  test("an orphan hard-linked to a NORMAL archive WITH an applied marker (unlink failed after record) is only removed: no ORPHAN archive, no record", () => {
    const d = repo();
    const logs = join(d, ".loki", "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "human-input-20200101T000000.md"), "APPLIED");
    writeFileSync(join(logs, ".applied-human-input-20200101T000000.md"), "done\n");
    const claim = join(logs, `.claim-${deadPid()}-abc123`);
    linkSync(join(logs, "human-input-20200101T000000.md"), claim);
    const sink: IntentRevision[] = [];
    expect(consumeSteer(d, {}, () => new Date(), sink)).toBeNull();
    expect(sink).toEqual([]);
    expect(existsSync(claim)).toBe(false);
    expect(archived(d).filter((n) => n.startsWith("human-input-"))).toEqual(["human-input-20200101T000000.md"]);
  });
  test("P12-02g: a consumer killed after the link and before the revision record leaves a claim on a NORMAL archive with no marker: reported unapplied, Seal refuses", () => {
    const d = repo("KILLED");
    const logs = join(d, ".loki", "logs");
    // Real consume, stopped (simulated kill) inside the link-to-unlink window: afterArchive throws, then we rebuild the post-kill disk state.
    const sink0: IntentRevision[] = [];
    consumeSteer(d, {}, () => new Date(), sink0, { afterArchive: () => { throw new Error("killed"); } });
    const normal = readdirSync(logs).find((n) => /^human-input-\d/.test(n))!;
    for (const n of readdirSync(logs)) if (n.startsWith(".applied-")) rmSync(join(logs, n));
    const claim = join(logs, `.claim-${deadPid()}-abc123`);
    linkSync(join(logs, normal), claim);
    const sink: IntentRevision[] = [];
    expect(consumeSteer(d, {}, () => new Date(), sink)).toBeNull();
    expect(sink.map((r) => [r.unapplied, r.reason])).toEqual([[true, "orphaned claim"]]);
    expect(existsSync(claim)).toBe(false);
    expect(readdirSync(logs).some((n) => n.startsWith("human-input-ORPHAN-"))).toBe(true);
    expect(staleReason(sink)).toContain("could not be applied");
    expect(staleWallRevisions(sink, undefined).length).toBe(1);
  });
  test("P12-02g: a normal consume writes the applied marker and the revision record before the claim is unlinked", () => {
    const d = repo("## Operator directive rev 1 (t) actor=a source=cli\nbody\n");
    const logs = join(d, ".loki", "logs");
    let seenClaim = false;
    const sink: IntentRevision[] = [];
    consumeSteer(d, {}, () => new Date(), sink, { afterArchive: () => { seenClaim = readdirSync(logs).some((n) => n.startsWith(".claim-")); } });
    expect(seenClaim).toBe(true);
    const normal = readdirSync(logs).find((n) => /^human-input-\d/.test(n))!;
    expect(existsSync(join(logs, `.applied-${normal}`))).toBe(true);
    expect(readdirSync(logs).some((n) => n.startsWith(".claim-"))).toBe(false);
    expect(sink.length).toBe(1);
  });
  test("a claim another sweeper removes mid-sweep (ENOENT) is not reported stranded", () => {
    const d = repo();
    const logs = join(d, ".loki", "logs");
    mkdirSync(logs);
    const claim = join(logs, `.claim-${deadPid()}-abc123`);
    writeFileSync(claim, "RACE");
    const link = ((): never => { rmSync(claim); throw Object.assign(new Error("gone"), { code: "ENOENT" }); }) as unknown as typeof linkSync;
    const sink: IntentRevision[] = [];
    consumeSteer(d, {}, () => new Date(), sink, { link });
    expect(sink).toEqual([]);
  });
  test("a new orphan repeating an old archive's text is still archived and reported", () => {
    const d = repo();
    const logs = join(d, ".loki", "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "human-input-ORPHAN-20200101T000000.md"), "SAME");
    writeFileSync(join(logs, `.claim-${deadPid()}-abc123`), "SAME");
    const sink: IntentRevision[] = [];
    consumeSteer(d, {}, () => new Date(), sink);
    expect(sink.map((r) => r.reason)).toEqual(["orphaned claim"]);
    expect(archived(d).filter((n) => n.startsWith("human-input-ORPHAN-")).length).toBe(2);
  });
  test("a FIFO orphan does not hang the sweep", () => {
    const d = repo();
    const logs = join(d, ".loki", "logs");
    mkdirSync(logs);
    execFileSync("mkfifo", [join(logs, `.claim-${deadPid()}-abc123`)]);
    const t0 = Date.now();
    const sink: IntentRevision[] = [];
    consumeSteer(d, {}, () => new Date(), sink);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(sink.length).toBe(1);
  });
  test("a directory orphan is archived", () => {
    const d = repo();
    const logs = join(d, ".loki", "logs");
    mkdirSync(join(logs, `.claim-${deadPid()}-abc123`), { recursive: true });
    const sink: IntentRevision[] = [];
    consumeSteer(d, {}, () => new Date(), sink);
    expect(sink.map((r) => r.reason)).toEqual(["orphaned claim"]);
    expect(archived(d).some((n) => n.startsWith("human-input-ORPHAN-"))).toBe(true);
    expect(archived(d).some((n) => n.startsWith(".claim-"))).toBe(false);
  });
  test("a steer written 20 minutes before its claim is not swept while the consumer is live", () => {
    const d = repo("OLD STEER");
    const f = join(d, ".loki", "HUMAN_INPUT.md");
    const old = new Date(Date.now() - 20 * 60 * 1000); utimesSync(f, old, old);
    const other = join(d, ".loki", "logs", `.claim-${process.ppid}-ffffff`);
    let survived = false, nestedSink: IntentRevision[] = [];
    const out = consumeSteer(d, {}, () => new Date(), undefined, { afterClaim: (c) => {
      // another consumer with a live pid sweeping right now must see a freshly stamped claim
      linkSync(c, other);
      consumeSteer(d, {}, () => new Date(), nestedSink);
      survived = existsSync(other); rmSync(other, { force: true });
    } });
    expect(out).toBe("OLD STEER");
    expect(survived).toBe(true);
    expect(nestedSink).toEqual([]);
  });
  test("an orphan that cannot be archived is reported with its stranded path and a distinct remedy", () => {
    const d = repo();
    mkdirSync(join(d, ".loki", "logs"));
    const gone = `.claim-${deadPid()}-abc123`;
    writeFileSync(join(d, ".loki", "logs", gone), "LOST");
    const link = ((): never => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }) as unknown as typeof linkSync;
    const sink: IntentRevision[] = [];
    consumeSteer(d, {}, () => new Date(), sink, { link });
    expect(sink[0]).toMatchObject({ unapplied: true, reason: `steer stranded at .loki/logs/${gone}` });
    expect(staleReason(sink)).toContain("Recover or delete the stranded file");
    expect(existsSync(join(d, ".loki", "logs", gone))).toBe(true);
  });
  test("a failure after the archive (revision record) still yields an unapplied record, and the steer text is not dropped", () => {
    const d = repo("KEEP");
    const sink: IntentRevision[] = [];
    const afterArchive = (): void => { throw new Error("record boom"); };
    expect(consumeSteer(d, {}, () => new Date(), sink, { afterArchive })).toBe("KEEP");
    expect(sink.map((r) => [r.unapplied, r.reason])).toEqual([[true, "steer applied but its revision record failed"]]);
  });
  test("a hard-link failure while archiving falls back to a collision-proof rename and keeps the steer", () => {
    const d = repo("TXT");
    const link = ((): never => { throw Object.assign(new Error("no hard links"), { code: "ENOTSUP" }); }) as unknown as typeof linkSync;
    expect(consumeSteer(d, {}, () => new Date(), undefined, { link })).toBe("TXT");
    expect(archived(d).filter((n) => n.startsWith("human-input-")).length).toBe(1);
    expect(archived(d).some((n) => n.startsWith(".claim-"))).toBe(false);
  });
  test("P12-02g: a no-hardlink filesystem (EPERM) still records the revision and writes the applied marker", () => {
    const d = repo("## Operator directive rev 1 (t) actor=a source=cli\nbody\n");
    const link = ((): never => { throw Object.assign(new Error("no hard links"), { code: "EPERM" }); }) as unknown as typeof linkSync;
    const sink: IntentRevision[] = [];
    expect(consumeSteer(d, {}, () => new Date(), sink, { link })).toContain("body");
    expect(sink.map((r) => [r.rev, r.unapplied])).toEqual([[1, undefined]]);
    const logs = join(d, ".loki", "logs");
    const normal = readdirSync(logs).find((n) => /^human-input-.*\.md$/.test(n))!;
    expect(existsSync(join(logs, `.applied-${normal}`))).toBe(true);
    expect(readFileSync(join(d, ".loki", "intent-revisions.jsonl"), "utf8")).toContain('"rev":1');
  });
  test("P12-02g: a sweep prunes an .applied- marker whose archive is gone and keeps one whose archive exists", () => {
    const d = repo();
    const logs = join(d, ".loki", "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "human-input-20200101T000000.md"), "X");
    writeFileSync(join(logs, ".applied-human-input-20200101T000000.md"), "d");
    writeFileSync(join(logs, ".applied-human-input-19990101T000000.md"), "d");
    consumeSteer(d, {}, () => new Date(), []);
    expect(existsSync(join(logs, ".applied-human-input-20200101T000000.md"))).toBe(true);
    expect(existsSync(join(logs, ".applied-human-input-19990101T000000.md"))).toBe(false);
  });
  test("a non-file steer with no fresh steer is restored in place", () => {
    const d = repo();
    const f = join(d, ".loki", "HUMAN_INPUT.md");
    execFileSync("mkfifo", [f]);
    expect(consumeSteer(d)).toBeNull();
    expect(lstatSync(f).isFIFO()).toBe(true);
  });
  test("a unix socket at the steer path refuses as not a regular file", async () => {
    const d = repo();
    const srv = createServer();
    await new Promise<void>((res, rej) => { srv.once("error", rej); srv.listen(join(d, ".loki", "HUMAN_INPUT.md"), res); });
    try {
      const sink: IntentRevision[] = [];
      expect(consumeSteer(d, {}, () => new Date(), sink)).toBeNull();
      expect(sink.map((r) => [r.unapplied, r.reason])).toEqual([[true, "not a regular file"]]);
    } finally { srv.close(); }
  });
  test("an oversize steer with mode 000 is still quarantined with the over 1 MiB reason", () => {
    const d = repo("x".repeat(1024 * 1024 + 1));
    const f = join(d, ".loki", "HUMAN_INPUT.md");
    chmodSync(f, 0o000);
    const sink: IntentRevision[] = [];
    expect(consumeSteer(d, {}, () => new Date(), sink)).toBeNull();
    expect(sink.map((r) => [r.unapplied, r.reason])).toEqual([[true, "over 1 MiB"]]);
    expect(existsSync(f)).toBe(false);
    expect(archived(d).some((n) => n.startsWith("human-input-REJECTED-TOOLARGE-"))).toBe(true);
  });
  test("header-bearing steers are archived with a numbered revision record, rev incrementing across steers", () => {
    const hdr = (n: number, src: string): string => `## Operator directive rev ${n} (2026-10-15T00:00:0${n}Z) actor=alice source=${src}\n`;
    const d = repo(`${hdr(1, "cli")}keep the old API\n\n${hdr(2, "https://github.com/o/r/issues/7#issuecomment-9")}also add tests\n\n`);
    const text = consumeSteer(d)!;
    expect(text).toContain("keep the old API");
    expect(text).toContain("also add tests");
    const log = () => readFileSync(join(d, ".loki", "intent-revisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log().map((r) => r.rev)).toEqual([1, 2]);
    expect(log()[0]).toMatchObject({ actor: "alice", source: "cli" });
    expect(log()[1].source).toBe("https://github.com/o/r/issues/7#issuecomment-9");
    expect(JSON.stringify(log())).not.toContain("keep the old API");
    writeFileSync(join(d, ".loki", "HUMAN_INPUT.md"), `${hdr(3, "chat")}third\n`);
    consumeSteer(d);
    expect(log().map((r) => r.rev)).toEqual([1, 2, 3]);
  });

  test("a headerless steer still gets the next revision number with null actor", () => {
    const d = repo("plain note");
    consumeSteer(d);
    writeFileSync(join(d, ".loki", "HUMAN_INPUT.md"), "another");
    consumeSteer(d);
    const rows = readFileSync(join(d, ".loki", "intent-revisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((r) => r.rev)).toEqual([1, 2]);
    expect(rows[0].actor).toBeNull();
  });

  test("consume returns the records to the sink even when the repo file is a /dev/null symlink; staleness is judged on Wall start in memory", () => {
    const d = repo("## Operator directive rev 1 (2026-10-15T00:00:01Z) actor=alice source=chat\nchange it\n");
    symlinkSync("/dev/null", join(d, ".loki", "intent-revisions.jsonl"));
    const sink: IntentRevision[] = [];
    consumeSteer(d, process.env, () => new Date(5000), sink);
    expect(sink.map((r) => [r.rev, r.actor, r.source, r.at])).toEqual([[1, "alice", "chat", 5000]]);
    const wall = (startMs: number) => [{ stage: "wall", startMs }];
    expect(staleWallRevisions(sink, wall(4000)).map((r) => r.rev)).toEqual([1]);
    expect(staleWallRevisions(sink, wall(5000)).map((r) => r.rev)).toEqual([1]); // same tick: the Wall never receives steers, so a tie is late
    expect(staleWallRevisions(sink, wall(5001))).toEqual([]);
    expect(staleWallRevisions(sink, [])).toEqual([]); // no Wall yet
    expect(staleWallRevisions(sink, [...wall(4000), ...wall(6000)])).toEqual([]); // re-authored
    expect(staleWallRevisions(undefined, wall(1))).toEqual([]);
  });
  test("audit file replaced by a directory, or unreadable (chmod 000): the sink still gets the record and the steer is still injected", () => {
    const hdr1 = "## Operator directive rev 1 (2026-10-15T00:00:01Z) actor=alice source=chat\nchange it\n";
    const d1 = repo(hdr1), sink1: IntentRevision[] = [];
    mkdirSync(join(d1, ".loki", "intent-revisions.jsonl"));
    expect(consumeSteer(d1, process.env, () => new Date(5000), sink1)).toContain("change it");
    expect(sink1.map((r) => r.rev)).toEqual([1]);
    const d2 = repo(hdr1), sink2: IntentRevision[] = [], f = join(d2, ".loki", "intent-revisions.jsonl");
    writeFileSync(f, "{\"rev\":4}\n"); chmodSync(f, 0);
    try { expect(consumeSteer(d2, process.env, () => new Date(5000), sink2)).toContain("change it"); } finally { chmodSync(f, 0o600); }
    expect(sink2.map((r) => r.rev)).toEqual([1]);
  });
  test("staleAtSeal consumes a steer still pending and counts it stale even with no Wall in the timeline", () => {
    const d = repo("## Operator directive rev 1 (2026-10-15T00:00:01Z) actor=alice source=chat\nlate\n");
    const ctx: { intentRevisions?: IntentRevision[]; timeline?: { stage: string; startMs: number }[] } = { timeline: [] };
    expect(staleAtSeal(d, ctx).map((r) => r.rev)).toEqual([1]);
    expect(ctx.intentRevisions?.map((r) => r.rev)).toEqual([1]);
    expect(staleAtSeal(d, ctx)).toEqual([]); // nothing pending any more, and no Wall
  });
  test("readIntentRevisions (status comment count) skips torn lines and earlier runs", () => {
    const d = repo();
    const row = (rev: number, at: number): string => JSON.stringify({ rev, actor: "a", source: "cli", sha256: "f".repeat(64), consumed_at: new Date(at).toISOString() });
    writeFileSync(join(d, ".loki", "intent-revisions.jsonl"), `${row(1, 100)}\n{torn\n${row(2, 5000)}\n`);
    expect(readIntentRevisions(d, 1000).map((r) => r.rev)).toEqual([2]);
  });
});
