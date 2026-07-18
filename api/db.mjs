import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function createStateStore(databasePath) {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const read = database.prepare('SELECT state_json FROM app_state WHERE id = 1');
  const write = database.prepare(`
    INSERT INTO app_state (id, state_json, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
  `);

  return {
    load(defaultState) {
      const row = read.get();
      if (!row) {
        write.run(JSON.stringify(defaultState), new Date().toISOString());
        return defaultState;
      }
      return { ...defaultState, ...JSON.parse(row.state_json) };
    },
    save(state) {
      write.run(JSON.stringify(state), new Date().toISOString());
    },
    health() {
      return database.prepare('SELECT 1 AS ok').get().ok === 1;
    },
    close() {
      database.close();
    },
  };
}
