import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';

const dbPath = path.join(__dirname, '../../todos.db');

let database: SqlJsDatabase | null = null;

// Initialize database
const initPromise = (async () => {
  const SQL = await initSqlJs();

  try {
    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      database = new SQL.Database(buffer);
      console.log('Loaded existing SQLite database');
    } else {
      database = new SQL.Database();
      console.log('Created new SQLite database');
    }
  } catch (error) {
    database = new SQL.Database();
    console.log('Created new SQLite database');
  }

  // Initialize schema
  database.run(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      completed BOOLEAN DEFAULT 0,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('Database schema initialized');

  return database;
})();

function saveToFile() {
  if (database) {
    const data = database.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  }
}

// Wrapper to provide sqlite3-like callback API
const db = {
  all: (sql: string, callback: (err: any, rows: any[]) => void) => {
    initPromise.then(() => {
      try {
        const stmt = database!.prepare(sql);
        const rows: any[] = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject());
        }
        stmt.free();
        callback(null, rows);
      } catch (err) {
        callback(err, []);
      }
    });
  },

  get: (sql: string, params: any[], callback: (err: any, row: any) => void) => {
    initPromise.then(() => {
      try {
        const stmt = database!.prepare(sql);
        stmt.bind(params);
        const row = stmt.step() ? stmt.getAsObject() : null;
        stmt.free();
        callback(null, row);
      } catch (err) {
        callback(err, null);
      }
    });
  },

  run: function(sql: string, params: any[], callback: (this: { lastID: number }, err: Error | null) => void) {
    initPromise.then(() => {
      try {
        database!.run(sql, params);
        saveToFile();
        const result = database!.exec('SELECT last_insert_rowid() as id');
        const lastID = result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] as number : 0;
        callback.call({ lastID }, null);
      } catch (err) {
        callback.call({ lastID: 0 }, err as Error);
      }
    });
  }
};

export const initDatabase = async (): Promise<void> => {
  await initPromise;
};

export default db;
