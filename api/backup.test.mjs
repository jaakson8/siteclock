import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDatabaseBackup } from "./backup.mjs";
import { createStateStore } from "./db.mjs";

test("SQLite hot-backup on terviklik ja taastatavalt loetav", () => {
  const directory = mkdtempSync(join(tmpdir(), "objektiaeg-backup-test-"));
  try {
    const sourcePath = join(directory, "source.sqlite");
    const backupDirectory = join(directory, "backups");
    const store = createStateStore(sourcePath);
    store.load({ workers: [{ id: "worker-test", name: "Test Töötaja" }] });
    store.close();

    const result = createDatabaseBackup({
      databasePath: sourcePath,
      backupDirectory,
      now: new Date("2026-07-18T12:00:00.000Z"),
    });
    assert.equal(result.integrity, "ok");
    assert.ok(result.bytes > 0);
    assert.ok(existsSync(result.path));

    const restored = createStateStore(result.path);
    assert.equal(restored.load({ workers: [] }).workers[0].name, "Test Töötaja");
    restored.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
