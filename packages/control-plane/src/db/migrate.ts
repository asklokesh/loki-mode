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
  // source, the bundled server and the bundled CLI sit at different depths
  const migrationsFolder = [
    join(import.meta.dir, "../../drizzle"), // src/db (source checkout)
    join(import.meta.dir, "../drizzle"), // packages/control-plane/dist (bundled server)
    join(import.meta.dir, "../../packages/control-plane/drizzle"), // loki-ts/dist (bundled CLI; also an installed npm package)
  ].find((d) => existsSync(join(d, "meta/_journal.json")));
  if (!migrationsFolder) throw new Error("drizzle migrations folder not found");
  migrate(db, { migrationsFolder });
  return { db, sqlite };
}
