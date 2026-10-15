// CPE24-P2a rollback hardening (allowlist, no symlinks) and CPE24-P4a legacy control loopback Host. New file: no existing control-plane test owns checkpoint rollback.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDb } from "../../src/db/migrate.ts";
import { rollbackCheckpoint } from "../../src/server/routes/checkpoints.ts";
import { controlMapped } from "../../src/server/legacy/routes-control.ts";

const mkRepo = () => {
  const repo = mkdtempSync(join(tmpdir(), "cp-rb-"));
  mkdirSync(join(repo, ".loki", "state", "checkpoints", "chk-1"), { recursive: true });
  return { repo, loki: join(repo, ".loki"), cp: join(repo, ".loki", "state", "checkpoints", "chk-1") };
};

test("rollback restores allowlisted names and ignores a planted audit/", () => {
  const { repo, loki, cp } = mkRepo();
  try {
    writeFileSync(join(cp, "session.json"), '{"a":1}');
    mkdirSync(join(cp, "audit")); writeFileSync(join(cp, "audit", "chain.jsonl"), "FORGED");
    mkdirSync(join(loki, "audit")); writeFileSync(join(loki, "audit", "chain.jsonl"), "REAL");
    const r = rollbackCheckpoint(repo, "chk-1");
    expect(r?.restored).toBe(1);
    expect(readFileSync(join(loki, "session.json"), "utf8")).toBe('{"a":1}');
    expect(readFileSync(join(loki, "audit", "chain.jsonl"), "utf8")).toBe("REAL");
    expect(r?.errors.some((e) => e.startsWith("audit:"))).toBe(true);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("rollback refuses nested symlinks and a symlinked destination", () => {
  const { repo, loki, cp } = mkRepo();
  const outside = mkdtempSync(join(tmpdir(), "cp-out-"));
  try {
    writeFileSync(join(outside, "secret"), "S");
    mkdirSync(join(cp, "queue")); writeFileSync(join(cp, "queue", "ok.json"), "{}");
    symlinkSync(join(outside, "secret"), join(cp, "queue", "evil"));
    const r = rollbackCheckpoint(repo, "chk-1");
    expect(existsSync(join(loki, "queue", "ok.json"))).toBe(true);
    expect(existsSync(join(loki, "queue", "evil"))).toBe(false);
    expect(r?.errors.some((e) => e.includes("nested symlink"))).toBe(true);
    rmSync(join(cp, "queue"), { recursive: true, force: true });
    rmSync(join(loki, "queue"), { recursive: true, force: true });
    symlinkSync(outside, join(loki, "queue"));
    mkdirSync(join(cp, "queue")); writeFileSync(join(cp, "queue", "x"), "1");
    const r2 = rollbackCheckpoint(repo, "chk-1");
    expect(r2?.errors.some((e) => e.includes("destination is a symlink"))).toBe(true);
    expect(existsSync(join(outside, "x"))).toBe(false);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("legacy control POSTs need a loopback peer and a loopback Host", async () => {
  const { db, sqlite } = openDb(":memory:");
  const repo = mkdtempSync(join(tmpdir(), "cp-ctl-"));
  try {
    const table = controlMapped(db, repo);
    const app = new Hono();
    app.post("/api/control/pause", (c) => table["POST /api/control/pause"]!(c));
    const peer = (address: string) => ({ requestIP: () => ({ address }) });
    const go = (host: string, ip: string) => app.request("/api/control/pause", { method: "POST", headers: { host } }, peer(ip));
    expect((await go("evil.example", "127.0.0.1")).status).toBe(403);
    expect((await go("127.0.0.1:57374", "10.0.0.5")).status).toBe(403);
    expect((await go("127.0.0.1:57374", "127.0.0.1")).status).not.toBe(403);
  } finally { sqlite.close(); rmSync(repo, { recursive: true, force: true }); }
});
