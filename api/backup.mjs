import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function createDatabaseBackup({
  databasePath = process.env.DATABASE_PATH,
  backupDirectory = process.env.BACKUP_DIR ?? "/backups",
  now = new Date(),
} = {}) {
  if (!databasePath || databasePath === ":memory:" || !existsSync(databasePath))
    throw new Error("Varundatav SQLite'i andmebaas puudub");
  mkdirSync(backupDirectory, { recursive: true });
  const stamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const destination = resolve(backupDirectory, `objektiaeg-${stamp}.sqlite`);
  if (dirname(destination) !== resolve(backupDirectory))
    throw new Error("Varukoopia sihtkoht ei ole lubatud");

  const source = new DatabaseSync(databasePath);
  try {
    source.prepare("VACUUM INTO ?").run(destination);
  } finally {
    source.close();
  }

  const backup = new DatabaseSync(destination, { readOnly: true });
  let integrity;
  try {
    integrity = backup.prepare("PRAGMA integrity_check").get().integrity_check;
  } finally {
    backup.close();
  }
  if (integrity !== "ok") throw new Error(`Varukoopia terviklikkuse kontroll ebaõnnestus: ${integrity}`);
  return {
    path: destination,
    fileName: basename(destination),
    bytes: statSync(destination).size,
    integrity,
    createdAt: now.toISOString(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = createDatabaseBackup();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
