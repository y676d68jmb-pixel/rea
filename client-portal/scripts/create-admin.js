// Usage: npm run create-admin -- <identifiant> "<Nom affiché>"
// Creates an administrator (or resets their password) and prints a temporary password.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDb } from '../src/db.js';
import { generatePassword, hashPassword } from '../src/security.js';

const [login, name = 'Administrateur'] = process.argv.slice(2);
if (!login || !/^[\w.@-]{3,50}$/.test(login) || /^CL-/i.test(login)) {
  console.error('Usage : npm run create-admin -- <identifiant> "<Nom>"');
  console.error("L'identifiant (3 à 50 caractères : lettres, chiffres, . _ - @) ne doit pas commencer par CL- (réservé aux clients).");
  process.exit(1);
}

const dbFile = resolve(process.env.DATABASE_FILE ?? 'data/portail.db');
mkdirSync(dirname(dbFile), { recursive: true });
const db = openDb(dbFile);
const password = generatePassword(16);
const hash = await hashPassword(password);

const existing = db.prepare('SELECT id, role FROM users WHERE login = ?').get(login);
if (existing && existing.role !== 'admin') {
  console.error(`« ${login} » est déjà un compte client.`);
  process.exit(1);
}
if (existing) {
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, active = 1 WHERE id = ?').run(hash, existing.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  console.log(`Mot de passe de l'administrateur « ${login} » réinitialisé.`);
} else {
  db.prepare("INSERT INTO users (login, password_hash, role, name, created_at) VALUES (?, ?, 'admin', ?, ?)").run(
    login,
    hash,
    name,
    new Date().toISOString(),
  );
  console.log(`Administrateur « ${login} » créé.`);
}
console.log(`Mot de passe provisoire : ${password}`);
console.log('Il vous sera demandé de le changer à la première connexion.');
db.close();
