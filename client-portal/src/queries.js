/**
 * Every read the routes need. Client-facing reads take the client id and filter on it in SQL,
 * so ownership is checked in one place.
 */
import { DOC_CLIENT_TODO, OPEN_DOSSIER_SQL } from './format.js';

const TODO_STATUSES = DOC_CLIENT_TODO.map((s) => `'${s}'`).join(', ');
const MISSING_DOCS_SQL = `(SELECT COUNT(*) FROM dossier_documents x
  WHERE x.dossier_id = d.id AND x.responsible = 'client' AND x.status IN (${TODO_STATUSES}))`;
const TO_CHECK_SQL = `(SELECT COUNT(*) FROM dossier_documents x WHERE x.dossier_id = d.id AND x.status = 'envoye')`;

// Client order: files that need the client first, then other open files, then closed ones.
const DOSSIER_ORDER = `CASE
    WHEN NOT ${OPEN_DOSSIER_SQL} THEN 2
    WHEN d.hold IN ('attente_client', 'attente_paiement') OR ${MISSING_DOCS_SQL} > 0 THEN 0
    ELSE 1 END, d.updated_at DESC`;

export function createQueries(db) {
  const st = (sql) => db.prepare(sql);

  const s = {
    userByLogin: st('SELECT * FROM users WHERE login = ?'),
    userById: st('SELECT * FROM users WHERE id = ?'),
    session: st(
      `SELECT s.token_hash, s.csrf, s.flash, u.id, u.login, u.name, u.role, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    ),
    insertSession: st('INSERT INTO sessions (token_hash, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)'),
    deleteSession: st('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: st('DELETE FROM sessions WHERE user_id = ?'),
    purgeSessions: st('DELETE FROM sessions WHERE expires_at <= ?'),
    setFlash: st('UPDATE sessions SET flash = ? WHERE token_hash = ?'),
    insertEvent: st('INSERT INTO events (client_id, dossier_id, actor_id, message, created_at) VALUES (?, ?, ?, ?, ?)'),

    clientEvents: st(
      `SELECT e.*, d.reference, a.name AS actor_name FROM events e
       LEFT JOIN dossiers d ON d.id = e.dossier_id LEFT JOIN users a ON a.id = e.actor_id
       WHERE e.client_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    ),
    dossierEvents: st(
      `SELECT e.*, a.name AS actor_name FROM events e LEFT JOIN users a ON a.id = e.actor_id
       WHERE e.dossier_id = ? ORDER BY e.created_at DESC, e.id DESC`,
    ),

    clientDossiers: st(
      `SELECT d.*, ${MISSING_DOCS_SQL} AS missing_docs, ${TO_CHECK_SQL} AS docs_to_check
       FROM dossiers d WHERE d.client_id = ? ORDER BY ${DOSSIER_ORDER}`,
    ),
    dossier: st(`SELECT d.*, ${MISSING_DOCS_SQL} AS missing_docs FROM dossiers d WHERE d.id = ?`),
    clientDossier: st(`SELECT d.*, ${MISSING_DOCS_SQL} AS missing_docs FROM dossiers d WHERE d.id = ? AND d.client_id = ?`),
    dossierByReference: st('SELECT id FROM dossiers WHERE reference = ? COLLATE NOCASE'),
    allDossiers: st(
      `SELECT d.*, u.name AS client_name, u.login AS client_login,
         ${MISSING_DOCS_SQL} AS missing_docs, ${TO_CHECK_SQL} AS docs_to_check
       FROM dossiers d JOIN users u ON u.id = d.client_id
       WHERE ? = 1 OR ${OPEN_DOSSIER_SQL}
       ORDER BY CASE WHEN NOT ${OPEN_DOSSIER_SQL} THEN 2 WHEN d.hold IS NOT NULL THEN 0 ELSE 1 END, d.updated_at ASC`,
    ),
    dossierStages: st('SELECT * FROM dossier_stages WHERE dossier_id = ? ORDER BY entered_on, id'),

    dossierDocuments: st(
      `SELECT * FROM dossier_documents WHERE dossier_id = ?
       ORDER BY CASE responsible WHEN 'client' THEN 0 WHEN 'tiers' THEN 1 ELSE 2 END, position, id`,
    ),
    document: st('SELECT * FROM dossier_documents WHERE id = ?'),
    /** A document the client may mark as sent: theirs, still to provide, on an open dossier. */
    clientSendableDocument: st(
      `SELECT x.* FROM dossier_documents x JOIN dossiers d ON d.id = x.dossier_id
       WHERE x.id = ? AND d.client_id = ? AND x.responsible = 'client'
         AND x.status IN (${TODO_STATUSES}) AND ${OPEN_DOSSIER_SQL}`,
    ),
    maxDocumentPosition: st('SELECT COALESCE(MAX(position), 0) AS n FROM dossier_documents WHERE dossier_id = ?'),
    documentsToCheck: st(
      `SELECT x.*, d.reference, d.client_id, u.name AS client_name, u.login AS client_login
       FROM dossier_documents x JOIN dossiers d ON d.id = x.dossier_id JOIN users u ON u.id = d.client_id
       WHERE x.status = 'envoye' ORDER BY x.updated_at`,
    ),

    clientInvoices: st(
      `SELECT i.*, d.reference FROM invoices i LEFT JOIN dossiers d ON d.id = i.dossier_id
       WHERE i.client_id = ? ORDER BY i.issued_on DESC, i.id DESC`,
    ),
    dossierInvoices: st('SELECT i.*, NULL AS reference FROM invoices i WHERE i.dossier_id = ? ORDER BY i.issued_on DESC, i.id DESC'),
    invoice: st('SELECT i.*, d.reference FROM invoices i LEFT JOIN dossiers d ON d.id = i.dossier_id WHERE i.id = ?'),
    clientInvoice: st('SELECT i.*, d.reference FROM invoices i LEFT JOIN dossiers d ON d.id = i.dossier_id WHERE i.id = ? AND i.client_id = ?'),
    invoiceByNumber: st('SELECT id FROM invoices WHERE number = ? COLLATE NOCASE'),
    invoiceLines: st('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position, id'),
    deductedProvisions: st("SELECT * FROM invoices WHERE deducted_in = ? AND kind = 'provision' ORDER BY id"),
    availableProvisions: st(
      "SELECT * FROM invoices WHERE client_id = ? AND kind = 'provision' AND status = 'payee' AND deducted_in IS NULL ORDER BY issued_on, id",
    ),

    clientTasks: st(
      `SELECT t.*, d.reference FROM tasks t LEFT JOIN dossiers d ON d.id = t.dossier_id
       WHERE t.client_id = ?
       ORDER BY CASE WHEN t.status IN ('nouvelle', 'en_cours') THEN 0 ELSE 1 END, t.created_at DESC`,
    ),
    dossierTasks: st("SELECT t.*, NULL AS reference FROM tasks t WHERE t.dossier_id = ? ORDER BY t.created_at DESC"),
    task: st('SELECT * FROM tasks WHERE id = ?'),
    openTasks: st(
      `SELECT t.*, d.reference, u.name AS client_name, u.login AS client_login FROM tasks t
       JOIN users u ON u.id = t.client_id LEFT JOIN dossiers d ON d.id = t.dossier_id
       WHERE t.status IN ('nouvelle', 'en_cours')
       ORDER BY t.assignee, CASE t.priority WHEN 'haute' THEN 0 WHEN 'normale' THEN 1 ELSE 2 END, t.created_at`,
    ),

    clients: st(
      `SELECT u.*,
         (SELECT COUNT(*) FROM dossiers d WHERE d.client_id = u.id AND ${OPEN_DOSSIER_SQL}) AS open_dossiers,
         (SELECT COUNT(*) FROM dossiers d WHERE d.client_id = u.id AND ${OPEN_DOSSIER_SQL} AND d.hold IS NOT NULL) AS held_dossiers,
         (SELECT COUNT(*) FROM dossier_documents x JOIN dossiers d ON d.id = x.dossier_id
            WHERE d.client_id = u.id AND x.status = 'envoye') AS docs_to_check,
         (SELECT COUNT(*) FROM tasks t WHERE t.client_id = u.id AND t.assignee = 'cabinet' AND t.status IN ('nouvelle', 'en_cours')) AS open_tasks,
         (SELECT COALESCE(SUM(amount_minor), 0) FROM invoices i WHERE i.client_id = u.id AND i.status = 'a_payer') AS unpaid
       FROM users u WHERE u.role = 'client' ORDER BY u.login`,
    ),

    todoDocuments: st(
      `SELECT x.id, x.label, x.status, x.due_on, x.note, d.id AS dossier_id, d.reference
       FROM dossier_documents x JOIN dossiers d ON d.id = x.dossier_id
       WHERE d.client_id = ? AND x.responsible = 'client' AND x.status IN (${TODO_STATUSES}) AND ${OPEN_DOSSIER_SQL}`,
    ),
    todoTasks: st(
      `SELECT t.id, t.title, t.description, t.status, t.due_on, t.dossier_id, d.reference FROM tasks t
       LEFT JOIN dossiers d ON d.id = t.dossier_id
       WHERE t.client_id = ? AND t.assignee = 'client' AND t.status IN ('nouvelle', 'en_cours')`,
    ),
    todoInvoices: st(
      `SELECT i.id, i.kind AS invoice_kind, i.number, i.amount_minor, i.due_on, i.dossier_id, d.reference FROM invoices i
       LEFT JOIN dossiers d ON d.id = i.dossier_id
       WHERE i.client_id = ? AND i.status = 'a_payer' AND i.due_on <= ?`,
    ),
    todoDuties: st(
      `SELECT d.id AS dossier_id, d.reference, d.duties_minor, d.duties_due_on FROM dossiers d
       WHERE d.client_id = ? AND d.duties_payer = 'client' AND d.duties_minor IS NOT NULL
         AND d.duties_paid_on IS NULL AND ${OPEN_DOSSIER_SQL}`,
    ),
  };

  /**
   * Everything the client must do, most urgent first: documents to send, tasks the firm asked for,
   * invoices due within 7 days or overdue, and customs duties the client pays directly.
   */
  function clientTodo(clientId, f) {
    const items = [
      ...s.todoDocuments.all(clientId).map((r) => ({ kind: 'document', ...r })),
      ...s.todoTasks.all(clientId).map((r) => ({ kind: 'task', ...r })),
      ...s.todoInvoices.all(clientId, f.dayFromToday(7)).map((r) => ({ kind: 'invoice', ...r })),
      ...s.todoDuties.all(clientId).map((r) => ({ kind: 'duties', ...r, due_on: r.duties_due_on })),
    ];
    return items.sort((a, b) => {
      if (a.due_on && b.due_on) return a.due_on < b.due_on ? -1 : a.due_on > b.due_on ? 1 : 0;
      return a.due_on ? -1 : b.due_on ? 1 : 0;
    });
  }

  return { ...s, clientTodo };
}
