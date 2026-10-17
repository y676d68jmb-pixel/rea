import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * Schema version 1 (customs files). Later changes go into MIGRATIONS as numbered steps; this text stays frozen.
 * Reference lists (stages, regimes, documents…) live in format.js and are validated by the app,
 * so only stable values carry CHECK constraints here.
 */
const SCHEMA_V1 = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'client')),
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  must_change_password INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  flash TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE dossiers (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reference TEXT NOT NULL,
  client_reference TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL CHECK (direction IN ('import', 'export')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL,
  hold TEXT,
  hold_note TEXT NOT NULL DEFAULT '',
  regime TEXT,
  regime_code TEXT NOT NULL DEFAULT '',
  transport_mode TEXT,
  transport_doc TEXT NOT NULL DEFAULT '',
  vessel TEXT NOT NULL DEFAULT '',
  containers TEXT NOT NULL DEFAULT '',
  counterparty TEXT NOT NULL DEFAULT '',
  customs_office TEXT,
  customs_office_detail TEXT NOT NULL DEFAULT '',
  expected_on TEXT,
  manifest_ref TEXT NOT NULL DEFAULT '',
  declaration_number TEXT NOT NULL DEFAULT '',
  declaration_on TEXT,
  circuit TEXT CHECK (circuit IN ('vert', 'orange', 'rouge')),
  visit_on TEXT,
  visit_place TEXT NOT NULL DEFAULT '',
  bae_on TEXT,
  ct_status TEXT,
  ct_note TEXT NOT NULL DEFAULT '',
  duties_minor INTEGER CHECK (duties_minor >= 0),
  duties_payer TEXT CHECK (duties_payer IN ('client', 'cabinet')),
  duties_due_on TEXT,
  duties_paid_on TEXT,
  duties_receipt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE dossier_stages (
  id INTEGER PRIMARY KEY,
  dossier_id INTEGER NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  entered_on TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE dossier_documents (
  id INTEGER PRIMARY KEY,
  dossier_id INTEGER NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  label TEXT NOT NULL,
  responsible TEXT NOT NULL CHECK (responsible IN ('client', 'tiers', 'cabinet')),
  tiers_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  due_on TEXT,
  note TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dossier_id INTEGER REFERENCES dossiers(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('facture', 'provision')),
  number TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  stamp_minor INTEGER NOT NULL DEFAULT 0 CHECK (stamp_minor >= 0),
  legal_note TEXT NOT NULL DEFAULT '',
  issued_on TEXT NOT NULL,
  due_on TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('a_payer', 'payee', 'annulee')),
  paid_on TEXT,
  deducted_in INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('honoraires', 'frais', 'debours')),
  category TEXT,
  label TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  vat_rate_bp INTEGER CHECK (vat_rate_bp >= 0),
  receipt_ref TEXT NOT NULL DEFAULT ''
);

-- Provisions deducted on an invoice, kept even if the invoice is later cancelled
-- (invoices.deducted_in only says whether a provision is still available).
CREATE TABLE invoice_deductions (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  provision_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  provision_number TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0)
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dossier_id INTEGER REFERENCES dossiers(id) ON DELETE SET NULL,
  assignee TEXT NOT NULL CHECK (assignee IN ('cabinet', 'client')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  due_on TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dossier_id INTEGER REFERENCES dossiers(id) ON DELETE SET NULL,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_dossiers_reference ON dossiers(reference COLLATE NOCASE);
CREATE UNIQUE INDEX idx_invoices_number ON invoices(number COLLATE NOCASE);
CREATE INDEX idx_dossiers_client ON dossiers(client_id);
CREATE INDEX idx_dossier_stages ON dossier_stages(dossier_id);
CREATE INDEX idx_documents_dossier ON dossier_documents(dossier_id);
CREATE INDEX idx_invoices_client ON invoices(client_id);
CREATE INDEX idx_invoice_lines ON invoice_lines(invoice_id);
CREATE INDEX idx_invoice_deductions ON invoice_deductions(invoice_id);
CREATE INDEX idx_tasks_client ON tasks(client_id);
CREATE INDEX idx_events_client ON events(client_id, created_at);
CREATE INDEX idx_events_dossier ON events(dossier_id, created_at);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
`;

/**
 * Ordered schema changes after version 1: { version: 2, up(db) { db.exec('ALTER TABLE …') } }.
 * Each step runs in its own transaction together with the user_version bump.
 */
export const MIGRATIONS = [];

export class SchemaError extends Error {}

const userVersion = (db) => db.prepare('PRAGMA user_version').get().user_version;

export function openDb(file, { migrate = true } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  if (migrate) migrateDb(db, file);
  return db;
}

/**
 * Brings the database to the latest version. A file database is copied to
 * "<file>.avant-vN.db" before any step that changes an existing schema.
 */
export function migrateDb(db, file = ':memory:', migrations = MIGRATIONS) {
  const latest = 1 + migrations.length;
  const current = userVersion(db);
  if (current > latest) {
    throw new SchemaError(`La base de données (version ${current}) est plus récente que le portail (version ${latest}). Installez la dernière version du portail.`);
  }

  if (current === 0) {
    const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
    if (tables > 0) {
      throw new SchemaError(
        "Cette base de données a été créée par une version d'essai du portail, antérieure au suivi douane. " +
          'Renommez-la ou indiquez un autre fichier (DATABASE_FILE) pour repartir d’une base neuve.',
      );
    }
    runStep(db, 0, 1, () => db.exec(SCHEMA_V1));
  }

  for (const step of migrations) {
    if (userVersion(db) >= step.version) continue;
    if (file !== ':memory:') {
      const copy = `${file}.avant-v${step.version}.db`;
      if (!existsSync(copy)) db.prepare('VACUUM INTO ?').run(copy);
    }
    runStep(db, step.version - 1, step.version, () => step.up(db));
  }
}

function runStep(db, from, to, apply) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Another process may have migrated while we waited for the lock.
    if (userVersion(db) === from) {
      apply();
      db.exec(`PRAGMA user_version = ${Number(to)}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Next client login such as CL-0007. */
export function nextClientLogin(db) {
  const rows = db.prepare("SELECT login FROM users WHERE login LIKE 'CL-%'").all();
  let max = 0;
  for (const { login } of rows) {
    const n = Number.parseInt(login.slice(3), 10);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return `CL-${String(max + 1).padStart(4, '0')}`;
}
