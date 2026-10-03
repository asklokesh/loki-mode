// loki-ts/src/engine10/warm.ts -- D61 slice 5: warm engine. In-memory repo map, test map and
// intake results keyed by (repoDir, HEAD^{tree}, dirty-file hash), served over a unix socket (never
// a TCP port). Behind LOKI_SPEED=1. The cold path stays the reference: a miss or a dead daemon never changes a result, it only costs time.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, resolve } from "node:path";
import { homeLokiDir } from "../util/paths.ts";
import { buildRepoMap, type RepoMap } from "../engine10/repomap.ts";
import { buildTestMap } from "../engine10/testmap.ts";
import type { TestMap } from "../engine10/types.ts";

export function speedEnabled(): boolean {
  return process.env["LOKI_SPEED"] === "1";
}
/** LOKI_WARM_SOCK overrides (tests use a temp dir); default ~/.loki/run/engine.sock. */
export function warmSocketPath(): string {
  const o = process.env["LOKI_WARM_SOCK"];
  return o && o.trim() ? o.trim() : resolve(homeLokiDir(), "run", "engine.sock");
}

function git(repoDir: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8", env: process.env });
  return r.status === 0 ? r.stdout : null;
}
const MAX_HASHED_BYTES = 1_000_000;
/** sha256 over the sorted `git status --porcelain` lines plus the content of each dirty file, so
 *  an edit that keeps the same status line still changes the hash. "" for a clean tree. */
export function dirtyHash(repoDir: string): string {
  const out = git(repoDir, ["status", "--porcelain", "-uall"]);
  if (out === null || out.trim() === "") return "";
  const h = createHash("sha256");
  for (const line of out.split("\n").filter(Boolean).sort()) {
    h.update(line + "\n");
    const rel = line.slice(3).split(" -> ").pop()!.replace(/^"|"$/g, "");
    try {
      const p = resolve(repoDir, rel);
      if (existsSync(p) && statSync(p).isFile() && statSync(p).size <= MAX_HASHED_BYTES) h.update(readFileSync(p));
    } catch {
      // unreadable file: the status line alone still keys it
    }
  }
  return h.digest("hex");
}

export function warmKey(repoDir: string): string | null {
  const tree = git(repoDir, ["rev-parse", "HEAD^{tree}"]);
  if (tree === null) return null;
  return `${resolve(repoDir)}|${tree.trim()}|${dirtyHash(repoDir)}`;
}

export interface WarmReply {
  ok: boolean;
  key?: string;
  hit?: boolean;
  repomap?: RepoMap;
  testmap?: TestMap;
  intake?: unknown;
  error?: string;
}

interface Entry {
  repomap?: RepoMap;
  testmap?: TestMap;
  intake?: unknown;
}

export class WarmEngine {
  private entries = new Map<string, Entry>();
  constructor(private readonly maxEntries = 8) {}
  /** Maps for the repo's current key; builds on a miss. A changed key (new tree or dirty edit)
   *  is simply a different entry, so a stale map is never served. */
  get(repoDir: string): WarmReply {
    const key = warmKey(repoDir);
    if (key === null) return { ok: false, error: "not a git repo" };
    let e = this.entries.get(key);
    const hit = e?.repomap !== undefined && e.testmap !== undefined;
    if (!e || !hit) {
      e = { ...e, repomap: buildRepoMap(repoDir), testmap: buildTestMap(repoDir) };
      this.entries.set(key, e);
      while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
    }
    return { ok: true, key, hit, repomap: e.repomap, testmap: e.testmap, intake: e.intake };
  }
  /** Stores an intake result under the repo's current key. */
  putIntake(repoDir: string, intake: unknown): WarmReply {
    const key = warmKey(repoDir);
    if (key === null) return { ok: false, error: "not a git repo" };
    this.entries.set(key, { ...this.entries.get(key), intake });
    return { ok: true, key };
  }
  size(): number {
    return this.entries.size;
  }
}
/** Dashboard hook: starts the warm socket only under LOKI_SPEED=1; never throws. */
export function startWarmIfEnabled(): WarmServer | null {
  if (!speedEnabled()) return null;
  try {
    return startWarmServer();
  } catch {
    return null;
  }
}

export interface WarmServer {
  path: string;
  stop(): void;
}
/** Serves newline-delimited JSON requests ({op:"get"|"put_intake"|"ping", repoDir, intake?}) on a
 *  unix socket. Removes a stale socket file first. */
export function startWarmServer(path: string = warmSocketPath(), engine: WarmEngine = new WarmEngine()): WarmServer {
  mkdirSync(dirname(path), { recursive: true });
  try {
    unlinkSync(path);
  } catch {
    // none to remove
  }
  const server: Server = createServer((sock) => {
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let reply: WarmReply;
        try {
          const req = JSON.parse(line) as { op?: string; repoDir?: string; intake?: unknown };
          if (req.op === "ping") reply = { ok: true };
          else if (typeof req.repoDir !== "string") reply = { ok: false, error: "repoDir required" };
          else if (req.op === "get") reply = engine.get(req.repoDir);
          else if (req.op === "put_intake") reply = engine.putIntake(req.repoDir, req.intake);
          else reply = { ok: false, error: "unknown op" };
        } catch (err) {
          reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        sock.write(JSON.stringify(reply) + "\n");
      }
    });
  });
  server.on("error", () => {});
  server.listen(path);
  return {
    path,
    stop: () => {
      server.close();
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    },
  };
}
