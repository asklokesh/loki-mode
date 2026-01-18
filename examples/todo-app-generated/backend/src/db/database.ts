import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';

const dbPath = path.join(__dirname, '../../todos.db');

let db: SqlJsDatabase | null = null;
let SQL: any = null;

export async function initDb(): Promise<SqlJsDatabase> {
  if (db) return db;

  SQL = await initSqlJs();

  // Try to load existing database
  try {
    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      db = new SQL.Database(buffer);
      console.log(`Loaded existing SQLite database from ${dbPath}`);
    } else {
      db = new SQL.Database();
      console.log(`Created new SQLite database at ${dbPath}`);
    }
  } catch (error) {
    console.log('Creating new database');
    db = new SQL.Database();
  }

  return db;
}

export function getDatabase(): SqlJsDatabase {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function saveDatabase(): void {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

export function closeDatabase(): void {
  if (db) {
    saveDatabase();
    db.close();
    db = null;
    console.log('Database connection closed');
  }
}
