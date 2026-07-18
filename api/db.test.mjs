import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createStateStore } from './db.mjs';

test('SQLite säilitab oleku pärast andmebaasi taasavamist', () => {
  const directory = mkdtempSync(join(tmpdir(), 'objektiaeg-db-test-'));
  const databasePath = join(directory, 'test.sqlite');
  try {
    const first = createStateStore(databasePath);
    const state = first.load({ clients: [] });
    state.clients.push({ id: 'client-persistent', companyName: 'Püsiv Klient OÜ' });
    first.save(state);
    first.close();

    const second = createStateStore(databasePath);
    const restored = second.load({ clients: [] });
    assert.equal(restored.clients[0].companyName, 'Püsiv Klient OÜ');
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
