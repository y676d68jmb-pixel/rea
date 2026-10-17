import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SchemaError, openDb } from './db.js';
import { createApp } from './app.js';

const dbFile = resolve(process.env.DATABASE_FILE ?? 'data/portail.db');
mkdirSync(dirname(dbFile), { recursive: true });
let db;
try {
  db = openDb(dbFile);
} catch (error) {
  if (!(error instanceof SchemaError)) throw error;
  console.error(`Base de données ${dbFile} : ${error.message}`);
  process.exit(1);
}

const app = createApp({
  db,
  siteName: process.env.SITE_NAME ?? 'Espace client',
  ...(process.env.DOCUMENTS_HINT ? { documentsHint: process.env.DOCUMENTS_HINT } : {}),
  secureCookies: process.env.COOKIE_SECURE !== '0' && process.env.NODE_ENV === 'production',
  trustProxy: process.env.TRUST_PROXY === '1',
  currency: process.env.CURRENCY ?? 'TND',
  timeZone: process.env.TIME_ZONE ?? 'Africa/Tunis',
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const server = createServer(app);
server.listen(port, host, () => {
  console.log(`Portail client disponible sur http://${host}:${port}`);
  if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
    console.log('Aucun administrateur : lancez « npm run create-admin -- <identifiant> "<Nom>" ».');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
