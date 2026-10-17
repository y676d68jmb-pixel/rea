import { readFileSync } from 'node:fs';
import { nextClientLogin, transaction } from './db.js';
import { DOSSIER_STATUS, INVOICE_STATUS, PRIORITY, TASK_STATUS, createFormatters, isOverdue } from './format.js';
import { HttpError, Router, SafeHtml, parseCookies, readForm, serializeCookie } from './http.js';
import {
  LoginLimiter,
  MIN_PASSWORD_LENGTH,
  burnPasswordCheck,
  generatePassword,
  hashPassword,
  randomToken,
  safeEqual,
  sha256,
  verifyPassword,
} from './security.js';
import * as views from './views.js';

const SESSION_COOKIE = 'sid';
const SESSION_HOURS = 12;
const STYLESHEET = readFileSync(new URL('../public/style.css', import.meta.url));

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

// ---------- Form validation ----------

function text(form, key, { max = 200, required = false, label = key } = {}) {
  const value = String(form[key] ?? '').trim();
  if (required && !value) throw new HttpError(400, `Le champ « ${label} » est obligatoire.`);
  if (value.length > max) throw new HttpError(400, `Le champ « ${label} » est trop long (${max} caractères maximum).`);
  return value;
}

function oneOf(form, key, allowed) {
  const value = form[key];
  if (!Object.hasOwn(allowed, value)) throw new HttpError(400, 'Valeur invalide.');
  return value;
}

function percent(form, key) {
  const value = String(form[key] ?? '').trim();
  if (!/^\d{1,3}$/.test(value) || Number(value) > 100) throw new HttpError(400, "L'avancement doit être compris entre 0 et 100.");
  return Number(value);
}

function day(form, key, { required = false, label = key } = {}) {
  const value = String(form[key] ?? '').trim();
  if (!value) {
    if (required) throw new HttpError(400, `Le champ « ${label} » est obligatoire.`);
    return null;
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `Date invalide pour « ${label} ».`);
  }
  return value;
}

function idParam(value) {
  if (!/^\d{1,15}$/.test(value)) throw new HttpError(404, 'Page introuvable.');
  return Number(value);
}

export function createApp({
  db,
  siteName = 'Espace client',
  secureCookies = false,
  trustProxy = false,
  currency = 'TND',
  timeZone = 'Africa/Tunis',
  now = () => new Date(),
}) {
  const f = createFormatters({ currency, timeZone, now });
  const nowIso = () => now().toISOString();
  const loginLimiter = new LoginLimiter({ maxAttempts: 5, now: () => now().getTime() });
  const ipLimiter = new LoginLimiter({ maxAttempts: 30, now: () => now().getTime() });
  const router = new Router();

  // ---------- Data helpers ----------

  const q = {
    userByLogin: db.prepare('SELECT * FROM users WHERE login = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    session: db.prepare(
      `SELECT s.token_hash, s.csrf, s.flash, u.id, u.login, u.name, u.role, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    ),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    setFlash: db.prepare('UPDATE sessions SET flash = ? WHERE token_hash = ?'),
    insertEvent: db.prepare('INSERT INTO events (client_id, dossier_id, actor_id, message, created_at) VALUES (?, ?, ?, ?, ?)'),
    events: db.prepare(
      `SELECT e.*, d.reference, a.name AS actor_name FROM events e
       LEFT JOIN dossiers d ON d.id = e.dossier_id LEFT JOIN users a ON a.id = e.actor_id
       WHERE e.client_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    ),
    dossierEvents: db.prepare(
      `SELECT e.*, a.name AS actor_name FROM events e LEFT JOIN users a ON a.id = e.actor_id
       WHERE e.dossier_id = ? ORDER BY e.created_at DESC, e.id DESC`,
    ),
    dossiers: db.prepare(
      `SELECT * FROM dossiers WHERE client_id = ?
       ORDER BY CASE status WHEN 'termine' THEN 1 ELSE 0 END, updated_at DESC`,
    ),
    dossier: db.prepare('SELECT * FROM dossiers WHERE id = ?'),
    invoices: db.prepare(
      `SELECT i.*, d.reference FROM invoices i LEFT JOIN dossiers d ON d.id = i.dossier_id
       WHERE i.client_id = ? ORDER BY i.issued_on DESC, i.id DESC`,
    ),
    dossierInvoices: db.prepare('SELECT i.*, NULL AS reference FROM invoices i WHERE i.dossier_id = ? ORDER BY i.issued_on DESC'),
    invoice: db.prepare('SELECT * FROM invoices WHERE id = ?'),
    tasks: db.prepare(
      `SELECT t.*, d.reference FROM tasks t LEFT JOIN dossiers d ON d.id = t.dossier_id
       WHERE t.client_id = ?
       ORDER BY CASE WHEN t.status IN ('nouvelle', 'en_cours') THEN 0 ELSE 1 END, t.created_at DESC`,
    ),
    dossierTasks: db.prepare("SELECT t.*, NULL AS reference FROM tasks t WHERE t.dossier_id = ? ORDER BY t.created_at DESC"),
    task: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    openFirmTasks: db.prepare(
      `SELECT t.*, d.reference, u.name AS client_name, u.login AS client_login FROM tasks t
       JOIN users u ON u.id = t.client_id LEFT JOIN dossiers d ON d.id = t.dossier_id
       WHERE t.status IN ('nouvelle', 'en_cours')
       ORDER BY CASE t.priority WHEN 'haute' THEN 0 WHEN 'normale' THEN 1 ELSE 2 END, t.created_at`,
    ),
    clients: db.prepare(
      `SELECT u.*,
         (SELECT COUNT(*) FROM dossiers d WHERE d.client_id = u.id AND d.status != 'termine') AS active_dossiers,
         (SELECT COUNT(*) FROM tasks t WHERE t.client_id = u.id AND t.assignee = 'cabinet' AND t.status IN ('nouvelle', 'en_cours')) AS open_tasks,
         (SELECT COALESCE(SUM(amount_minor), 0) FROM invoices i WHERE i.client_id = u.id AND i.status = 'a_payer') AS unpaid
       FROM users u WHERE u.role = 'client' ORDER BY u.login`,
    ),
  };

  const logEvent = (clientId, dossierId, actorId, message) =>
    q.insertEvent.run(clientId, dossierId ?? null, actorId ?? null, message, nowIso());

  function clientOf(id) {
    const client = q.userById.get(id);
    if (!client || client.role !== 'client') throw new HttpError(404, 'Client introuvable.');
    return client;
  }

  function dossierFor(form, clientId) {
    const raw = String(form.dossier_id ?? '').trim();
    if (!raw) return null;
    const dossier = /^\d{1,15}$/.test(raw) ? q.dossier.get(Number(raw)) : undefined;
    if (!dossier || dossier.client_id !== clientId) throw new HttpError(400, 'Dossier invalide.');
    return dossier.id;
  }

  // ---------- Session helpers ----------

  function startSession(res, userId) {
    q.purgeSessions.run(nowIso());
    const token = randomToken();
    const expires = new Date(now().getTime() + SESSION_HOURS * 3600 * 1000).toISOString();
    q.insertSession.run(sha256(token), userId, randomToken(), expires);
    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_HOURS * 3600, secure: secureCookies }));
    return sha256(token);
  }

  function flash(ctx, type, message) {
    if (!ctx.session) return;
    const list = ctx.session.flash ? JSON.parse(ctx.session.flash) : [];
    list.push({ type, text: message });
    ctx.session.flash = JSON.stringify(list);
    q.setFlash.run(ctx.session.flash, ctx.session.token_hash);
  }

  function takeFlash(ctx) {
    if (!ctx.session?.flash) return [];
    const list = JSON.parse(ctx.session.flash);
    q.setFlash.run(null, ctx.session.token_hash);
    return list;
  }

  // ---------- Responses ----------

  function send(res, status, body, type = 'text/html; charset=utf-8') {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
    res.end(body instanceof SafeHtml ? body.value : body);
  }

  function redirect(res, location) {
    res.writeHead(303, { ...SECURITY_HEADERS, Location: location });
    res.end();
  }

  function render(ctx, page, data, status = 200) {
    const viewCtx = { user: ctx.user, csrf: ctx.session?.csrf, flash: takeFlash(ctx), f, siteName };
    send(ctx.res, status, views[page](viewCtx, data));
  }

  // ---------- Public routes ----------

  router.get('/', (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/connexion');
    return redirect(ctx.res, ctx.user.role === 'admin' ? '/admin' : '/espace');
  });

  router.get('/static/style.css', (ctx) => {
    ctx.res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    ctx.res.end(STYLESHEET);
  });

  router.get('/connexion', (ctx) => {
    if (ctx.user) return redirect(ctx.res, '/');
    render(ctx, 'loginPage', {});
  });

  router.post('/connexion', async (ctx) => {
    const login = String(ctx.form.login ?? '').trim().slice(0, 100);
    const password = String(ctx.form.password ?? '').slice(0, 200);
    const key = `${ctx.ip}|${login.toLowerCase()}`;
    if (loginLimiter.isBlocked(key) || ipLimiter.isBlocked(ctx.ip)) {
      return render(ctx, 'loginPage', { login, error: 'Trop de tentatives. Réessayez dans 15 minutes.' }, 429);
    }
    const user = login ? q.userByLogin.get(login) : undefined;
    const ok = user && user.active ? await verifyPassword(password, user.password_hash) : (await burnPasswordCheck(password), false);
    if (!ok) {
      loginLimiter.fail(key);
      ipLimiter.fail(ctx.ip);
      return render(ctx, 'loginPage', { login, error: 'Identifiant ou mot de passe incorrect.' }, 401);
    }
    loginLimiter.reset(key);
    if (ctx.session) q.deleteSession.run(ctx.session.token_hash);
    startSession(ctx.res, user.id);
    redirect(ctx.res, user.must_change_password ? '/mot-de-passe' : '/');
  });

  router.post('/deconnexion', (ctx) => {
    if (ctx.session) q.deleteSession.run(ctx.session.token_hash);
    ctx.res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: secureCookies }));
    redirect(ctx.res, '/connexion');
  });

  router.get('/mot-de-passe', (ctx) => render(ctx, 'changePasswordPage', {}));

  router.post('/mot-de-passe', async (ctx) => {
    const { current = '', next = '', confirm = '' } = ctx.form;
    const fail = (error) => render(ctx, 'changePasswordPage', { error }, 400);
    const user = q.userById.get(ctx.user.id);
    if (!(await verifyPassword(current, user.password_hash))) return fail('Le mot de passe actuel est incorrect.');
    if (next.length < MIN_PASSWORD_LENGTH) return fail(`Le nouveau mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`);
    if (next.length > 200) return fail('Le nouveau mot de passe est trop long.');
    if (next !== confirm) return fail('Les deux mots de passe ne correspondent pas.');
    if (next === current) return fail("Le nouveau mot de passe doit être différent de l'ancien.");
    const hash = await hashPassword(next);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, user.id);
    // Sign out every other device and rotate the current session.
    q.deleteUserSessions.run(user.id);
    ctx.session = { token_hash: startSession(ctx.res, user.id), flash: null };
    flash(ctx, 'success', 'Votre mot de passe a été modifié.');
    redirect(ctx.res, '/');
  });

  // ---------- Client routes ----------

  router.get('/espace', (ctx) => {
    const id = ctx.user.id;
    const invoices = q.invoices.all(id);
    const today = f.today();
    const unpaid = invoices.filter((i) => i.status === 'a_payer');
    render(ctx, 'clientDashboard', {
      dossiers: q.dossiers.all(id),
      unpaidTotal: unpaid.reduce((sum, i) => sum + i.amount_minor, 0),
      overdueCount: unpaid.filter((i) => isOverdue(i, today)).length,
      openTasks: q.tasks.all(id).filter((t) => t.status === 'nouvelle' || t.status === 'en_cours').length,
      events: q.events.all(id, 10),
    });
  });

  router.get('/espace/dossiers/:id', (ctx) => {
    const dossier = q.dossier.get(idParam(ctx.params.id));
    if (!dossier || dossier.client_id !== ctx.user.id) throw new HttpError(404, 'Dossier introuvable.');
    render(ctx, 'clientDossierPage', {
      dossier,
      events: q.dossierEvents.all(dossier.id),
      tasks: q.dossierTasks.all(dossier.id),
      invoices: q.dossierInvoices.all(dossier.id),
    });
  });

  router.get('/espace/factures', (ctx) => render(ctx, 'clientInvoicesPage', { invoices: q.invoices.all(ctx.user.id) }));

  router.get('/espace/historique', (ctx) => render(ctx, 'clientHistoryPage', { events: q.events.all(ctx.user.id, 500) }));

  router.get('/espace/taches', (ctx) =>
    render(ctx, 'clientTasksPage', { tasks: q.tasks.all(ctx.user.id), dossiers: q.dossiers.all(ctx.user.id) }),
  );

  router.post('/espace/taches', (ctx) => {
    ctx.back = '/espace/taches';
    const clientId = ctx.user.id;
    const title = text(ctx.form, 'title', { required: true, label: 'Titre' });
    const description = text(ctx.form, 'description', { max: 5000 });
    const priority = oneOf(ctx.form, 'priority', PRIORITY);
    const dueOn = day(ctx.form, 'due_on', { label: 'Échéance' });
    const dossierId = dossierFor(ctx.form, clientId);
    const at = nowIso();
    transaction(db, () => {
      db.prepare(
        `INSERT INTO tasks (client_id, dossier_id, assignee, title, description, priority, status, due_on, created_by, created_at, updated_at)
         VALUES (?, ?, 'cabinet', ?, ?, ?, 'nouvelle', ?, ?, ?, ?)`,
      ).run(clientId, dossierId, title, description, priority, dueOn, clientId, at, at);
      logEvent(clientId, dossierId, clientId, `Nouvelle tâche déposée : « ${title} »`);
    });
    flash(ctx, 'success', 'Votre tâche a bien été transmise au cabinet.');
    redirect(ctx.res, '/espace/taches');
  });

  router.post('/espace/taches/:id/terminer', (ctx) => {
    const task = q.task.get(idParam(ctx.params.id));
    if (!task || task.client_id !== ctx.user.id) throw new HttpError(404, 'Tâche introuvable.');
    if (task.assignee === 'client' && (task.status === 'nouvelle' || task.status === 'en_cours')) {
      transaction(db, () => {
        db.prepare("UPDATE tasks SET status = 'terminee', updated_at = ? WHERE id = ?").run(nowIso(), task.id);
        logEvent(task.client_id, task.dossier_id, ctx.user.id, `Tâche « ${task.title} » réalisée par le client`);
      });
      flash(ctx, 'success', 'Tâche marquée comme faite. Merci !');
    }
    redirect(ctx.res, '/espace/taches');
  });

  // ---------- Admin routes ----------

  router.get('/admin', (ctx) => render(ctx, 'adminHomePage', { clients: q.clients.all() }));

  router.get('/admin/taches', (ctx) => render(ctx, 'adminTasksPage', { tasks: q.openFirmTasks.all() }));

  router.post('/admin/clients', async (ctx) => {
    ctx.back = '/admin';
    const name = text(ctx.form, 'name', { required: true, label: 'Nom' });
    const company = text(ctx.form, 'company');
    const email = text(ctx.form, 'email');
    const phone = text(ctx.form, 'phone', { max: 50 });
    const password = generatePassword();
    const hash = await hashPassword(password);
    const { id, login } = transaction(db, () => {
      const newLogin = nextClientLogin(db);
      const result = db
        .prepare('INSERT INTO users (login, password_hash, role, name, company, email, phone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(newLogin, hash, 'client', name, company, email, phone, nowIso());
      return { id: Number(result.lastInsertRowid), login: newLogin };
    });
    flash(ctx, 'success', `Client créé. Identifiant : ${login} — mot de passe provisoire : ${password} (notez-le, il ne sera plus affiché).`);
    redirect(ctx.res, `/admin/clients/${id}`);
  });

  router.get('/admin/clients/:id', (ctx) => {
    const client = clientOf(idParam(ctx.params.id));
    render(ctx, 'adminClientPage', {
      client,
      dossiers: q.dossiers.all(client.id),
      invoices: q.invoices.all(client.id),
      tasks: q.tasks.all(client.id),
      events: q.events.all(client.id, 50),
    });
  });

  router.post('/admin/clients/:id/mot-de-passe', async (ctx) => {
    const client = clientOf(idParam(ctx.params.id));
    const password = generatePassword();
    const hash = await hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, client.id);
    q.deleteUserSessions.run(client.id);
    flash(ctx, 'success', `Nouveau mot de passe provisoire pour ${client.login} : ${password} (notez-le, il ne sera plus affiché).`);
    redirect(ctx.res, `/admin/clients/${client.id}`);
  });

  router.post('/admin/clients/:id/activation', (ctx) => {
    const client = clientOf(idParam(ctx.params.id));
    const active = client.active ? 0 : 1;
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active, client.id);
    if (!active) q.deleteUserSessions.run(client.id);
    flash(ctx, 'success', active ? 'Compte réactivé.' : 'Compte désactivé : le client ne peut plus se connecter.');
    redirect(ctx.res, `/admin/clients/${client.id}`);
  });

  router.post('/admin/clients/:id/dossiers', (ctx) => {
    const client = clientOf(idParam(ctx.params.id));
    ctx.back = `/admin/clients/${client.id}`;
    const reference = text(ctx.form, 'reference', { required: true, max: 50, label: 'Référence' });
    const title = text(ctx.form, 'title', { required: true, label: 'Titre' });
    const description = text(ctx.form, 'description', { max: 5000 });
    const status = oneOf(ctx.form, 'status', DOSSIER_STATUS);
    const progress = percent(ctx.form, 'progress');
    const at = nowIso();
    transaction(db, () => {
      const result = db
        .prepare(
          'INSERT INTO dossiers (client_id, reference, title, description, status, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(client.id, reference, title, description, status, progress, at, at);
      logEvent(client.id, Number(result.lastInsertRowid), ctx.user.id, `Ouverture du dossier « ${title} »`);
    });
    flash(ctx, 'success', 'Dossier créé.');
    redirect(ctx.res, ctx.back);
  });

  router.post('/admin/dossiers/:id', (ctx) => {
    const dossier = q.dossier.get(idParam(ctx.params.id));
    if (!dossier) throw new HttpError(404, 'Dossier introuvable.');
    ctx.back = `/admin/clients/${dossier.client_id}`;
    const status = oneOf(ctx.form, 'status', DOSSIER_STATUS);
    const progress = percent(ctx.form, 'progress');
    const note = text(ctx.form, 'note', { max: 2000 });
    const changes = [];
    if (status !== dossier.status) changes.push(`état : ${DOSSIER_STATUS[dossier.status]} → ${DOSSIER_STATUS[status]}`);
    if (progress !== dossier.progress) changes.push(`avancement : ${dossier.progress} % → ${progress} %`);
    if (!changes.length && !note) {
      flash(ctx, 'info', 'Aucune modification.');
      return redirect(ctx.res, ctx.back);
    }
    const message = [changes.length ? `Mise à jour — ${changes.join(', ')}` : '', note].filter(Boolean).join('. ');
    transaction(db, () => {
      db.prepare('UPDATE dossiers SET status = ?, progress = ?, updated_at = ? WHERE id = ?').run(status, progress, nowIso(), dossier.id);
      logEvent(dossier.client_id, dossier.id, ctx.user.id, message);
    });
    flash(ctx, 'success', `Dossier ${dossier.reference} mis à jour.`);
    redirect(ctx.res, ctx.back);
  });

  router.post('/admin/clients/:id/factures', (ctx) => {
    const client = clientOf(idParam(ctx.params.id));
    ctx.back = `/admin/clients/${client.id}`;
    const number = text(ctx.form, 'number', { required: true, max: 50, label: 'Numéro' });
    const label = text(ctx.form, 'label');
    const dossierId = dossierFor(ctx.form, client.id);
    const amount = f.parseMoney(ctx.form.amount);
    if (amount === null) throw new HttpError(400, 'Montant invalide.');
    const issuedOn = day(ctx.form, 'issued_on', { required: true, label: "Date d'émission" });
    const dueOn = day(ctx.form, 'due_on', { required: true, label: 'Échéance' });
    if (dueOn < issuedOn) throw new HttpError(400, "L'échéance doit être postérieure à la date d'émission.");
    transaction(db, () => {
      db.prepare(
        `INSERT INTO invoices (client_id, dossier_id, number, label, amount_minor, issued_on, due_on, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'a_payer', ?)`,
      ).run(client.id, dossierId, number, label, amount, issuedOn, dueOn, nowIso());
      logEvent(client.id, dossierId, ctx.user.id, `Nouvelle facture n° ${number} de ${f.money(amount)}, échéance le ${f.date(dueOn)}`);
    });
    flash(ctx, 'success', 'Facture ajoutée.');
    redirect(ctx.res, ctx.back);
  });

  router.post('/admin/factures/:id', (ctx) => {
    const invoice = q.invoice.get(idParam(ctx.params.id));
    if (!invoice) throw new HttpError(404, 'Facture introuvable.');
    ctx.back = `/admin/clients/${invoice.client_id}`;
    const status = oneOf(ctx.form, 'status', INVOICE_STATUS);
    if (status !== invoice.status) {
      const paidOn = status === 'payee' ? f.today() : null;
      transaction(db, () => {
        db.prepare('UPDATE invoices SET status = ?, paid_on = ? WHERE id = ?').run(status, paidOn, invoice.id);
        logEvent(invoice.client_id, invoice.dossier_id, ctx.user.id, `Facture n° ${invoice.number} : ${INVOICE_STATUS[status]}`);
      });
      flash(ctx, 'success', `Facture ${invoice.number} mise à jour.`);
    }
    redirect(ctx.res, ctx.back);
  });

  router.post('/admin/clients/:id/taches', (ctx) => {
    const client = clientOf(idParam(ctx.params.id));
    ctx.back = `/admin/clients/${client.id}`;
    const title = text(ctx.form, 'title', { required: true, label: 'Titre' });
    const description = text(ctx.form, 'description', { max: 5000 });
    const priority = oneOf(ctx.form, 'priority', PRIORITY);
    const dueOn = day(ctx.form, 'due_on', { label: 'Échéance' });
    const dossierId = dossierFor(ctx.form, client.id);
    const at = nowIso();
    transaction(db, () => {
      db.prepare(
        `INSERT INTO tasks (client_id, dossier_id, assignee, title, description, priority, status, due_on, created_by, created_at, updated_at)
         VALUES (?, ?, 'client', ?, ?, ?, 'nouvelle', ?, ?, ?, ?)`,
      ).run(client.id, dossierId, title, description, priority, dueOn, ctx.user.id, at, at);
      logEvent(client.id, dossierId, ctx.user.id, `Le cabinet vous demande : « ${title} »`);
    });
    flash(ctx, 'success', 'Tâche ajoutée pour le client.');
    redirect(ctx.res, ctx.back);
  });

  router.post('/admin/taches/:id', (ctx) => {
    const task = q.task.get(idParam(ctx.params.id));
    if (!task) throw new HttpError(404, 'Tâche introuvable.');
    const status = oneOf(ctx.form, 'status', TASK_STATUS);
    if (status !== task.status) {
      transaction(db, () => {
        db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), task.id);
        logEvent(task.client_id, task.dossier_id, ctx.user.id, `Tâche « ${task.title} » : ${TASK_STATUS[task.status]} → ${TASK_STATUS[status]}`);
      });
      flash(ctx, 'success', 'Tâche mise à jour.');
    }
    const referer = safeBack(ctx.req.headers.referer, ctx.req.headers.host);
    redirect(ctx.res, referer ?? `/admin/clients/${task.client_id}`);
  });

  // ---------- Request pipeline ----------

  function loadSession(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return {};
    const row = q.session.get(sha256(token), nowIso());
    if (!row) return {};
    const { token_hash, csrf, flash: pending, ...user } = row;
    return { session: { token_hash, csrf, flash: pending }, user };
  }

  function clientIp(req) {
    if (trustProxy) {
      // The last entry is the address our own proxy saw; earlier ones can be forged by the visitor.
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1).trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function authorize(ctx, pathname) {
    const isPublic = pathname === '/' || pathname === '/connexion' || pathname.startsWith('/static/');
    if (isPublic) return true;
    if (!ctx.user) {
      if (ctx.method === 'GET') redirect(ctx.res, '/connexion');
      else throw new HttpError(401, 'Session expirée, veuillez vous reconnecter.');
      return false;
    }
    if (ctx.user.must_change_password && pathname !== '/mot-de-passe' && pathname !== '/deconnexion') {
      if (ctx.method === 'GET') redirect(ctx.res, '/mot-de-passe');
      else throw new HttpError(403, "Veuillez d'abord changer votre mot de passe.");
      return false;
    }
    if (pathname.startsWith('/admin') && ctx.user.role !== 'admin') throw new HttpError(404, 'Page introuvable.');
    if (pathname.startsWith('/espace') && ctx.user.role !== 'client') throw new HttpError(404, 'Page introuvable.');
    return true;
  }

  return async function handle(req, res) {
    const ctx = { req, res, method: req.method, ip: clientIp(req), form: {} };
    try {
      const url = new URL(req.url, 'http://localhost');
      Object.assign(ctx, loadSession(req));
      const match = router.match(req.method === 'HEAD' ? 'GET' : req.method, url.pathname);
      if (!match) throw new HttpError(404, 'Page introuvable.');
      if (match.methodNotAllowed) throw new HttpError(405, 'Méthode non autorisée.');
      ctx.params = match.params;

      if (req.method === 'POST') {
        if (!sameOrigin(req)) throw new HttpError(403, 'Requête refusée.');
        ctx.form = await readForm(req);
        // Login creates a fresh session, so it has no CSRF token yet; the origin check covers it.
        if (ctx.session && url.pathname !== '/connexion' && !safeEqual(ctx.form._csrf ?? '', ctx.session.csrf)) {
          throw new HttpError(403, 'Formulaire expiré. Rechargez la page et réessayez.');
        }
      }
      if (!authorize(ctx, url.pathname)) return;
      await match.handler(ctx);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      if (error instanceof HttpError && error.status === 400 && ctx.back && ctx.session) {
        flash(ctx, 'error', error.message);
        return redirect(res, ctx.back);
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      const message = status === 500 ? 'Une erreur inattendue est survenue.' : error.message;
      const viewCtx = { user: ctx.user, csrf: ctx.session?.csrf, flash: [], f, siteName };
      send(res, status, views.errorPage(viewCtx, status, message));
    }
  };
}

function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return origin !== 'null';
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function safeBack(referer, host) {
  if (!referer) return null;
  try {
    const url = new URL(referer);
    return url.host === host && url.pathname.startsWith('/admin') ? url.pathname : null;
  } catch {
    return null;
  }
}
