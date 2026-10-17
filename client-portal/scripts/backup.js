// Usage: node scripts/backup.js <dossier-de-sauvegarde> [nombre-de-copies-à-garder]
// Copies the live database safely (even while the site runs) and keeps the most recent copies.
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const [dir, keepArg = '14'] = process.argv.slice(2);
const keep = Number(keepArg);
if (!dir || !Number.isInteger(keep) || keep < 1) {
  console.error('Usage : node scripts/backup.js <dossier> [copies à garder]');
  process.exit(1);
}

const target = resolve(dir);
mkdirSync(target, { recursive: true });
// Opened as is: a backup never changes the schema.
const db = new DatabaseSync(resolve(process.env.DATABASE_FILE ?? 'data/portail.db'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(target, `portail-${stamp}.db`);
await backup(db, file);
db.close();
console.log(`Sauvegarde créée : ${file}`);

const copies = readdirSync(target)
  .filter((name) => /^portail-.*\.db$/.test(name))
  .sort()
  .reverse();
for (const old of copies.slice(keep)) rmSync(join(target, old));
