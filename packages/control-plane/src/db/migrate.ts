import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof openDb>["db"];

/** Opens the SQLite file (":memory:" for tests) and applies drizzle/ migrations. Runs on boot. */
export function openDb(path: string) {
  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const db = drizzle(sqlite, { schema });
  // src/db/ (source) and dist/ (bundled server) sit at different depths under packages/control-plane
  const migrationsFolder = [join(import.meta.dir, "../../drizzle"), join(import.meta.dir, "../drizzle")].find((d) => existsSync(join(d, "meta/_journal.json")));
  if (!migrationsFolder) throw new Error("drizzle migrations folder not found");
  migrate(db, { migrationsFolder });
  return { db, sqlite };
}
