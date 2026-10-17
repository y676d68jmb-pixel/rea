import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/security.js';

/** Tiny browser: keeps the session cookie and reads the CSRF token from pages. */
class Browser {
  constructor(base) {
    this.base = base;
    this.cookie = '';
    this.csrf = '';
  }

  async request(path, { method = 'GET', form, headers = {} } = {}) {
    const res = await fetch(this.base + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const body = await res.text();
    const token = /name="_csrf" value="([^"]+)"/.exec(body);
    if (token) this.csrf = token[1];
    return { status: res.status, location: res.headers.get('location'), body };
  }

  get(path) {
    return this.request(path);
  }

  post(path, form = {}, options = {}) {
    return this.request(path, { method: 'POST', form: { _csrf: this.csrf, ...form }, ...options });
  }

  /** Follows a redirect and returns the target page. */
  async follow(response) {
    assert.equal(response.status, 303, `expected redirect, got ${response.status}: ${response.body.slice(0, 300)}`);
    return this.get(response.location);
  }

  async login(login, password) {
    await this.get('/connexion');
    const res = await this.post('/connexion', { login, password });
    // Load the landing page so the new session's CSRF token is known.
    let next = res;
    while (next.status === 303) next = await this.get(next.location);
    return res;
  }
}

let server;
let base;
let db;
const clock = { now: new Date('2026-10-17T09:00:00Z') };

before(async () => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO users (login, password_hash, role, name, must_change_password, created_at) VALUES ('admin', ?, 'admin', 'Cabinet', 0, ?)").run(
    await hashPassword('admin-password-1'),
    clock.now.toISOString(),
  );
  server = createServer(createApp({ db, siteName: 'Portail test', now: () => clock.now }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

function extractCredentials(body) {
  const m = /Identifiant : (CL-\d{4}) — mot de passe provisoire : (\w+)/.exec(body);
  assert.ok(m, 'credentials shown once after creation');
  return { login: m[1], password: m[2] };
}

async function createClient(admin, name) {
  const page = await admin.follow(await admin.post('/admin/clients', { name, company: `${name} SARL`, email: '', phone: '' }));
  const clientId = Number(/\/admin\/clients\/(\d+)\/dossiers/.exec(page.body)[1]);
  return { ...extractCredentials(page.body), clientId, page };
}

describe('portail client', () => {
  const admin = () => new Browser(base);
  let adminBrowser;
  let alice;
  let bob;

  before(async () => {
    adminBrowser = admin();
    const res = await adminBrowser.login('admin', 'admin-password-1');
    assert.equal(res.location, '/');
    alice = await createClient(adminBrowser, 'Alice');
    bob = await createClient(adminBrowser, 'Bob');
  });

  test('unauthenticated visitors are sent to the login page', async () => {
    const res = await new Browser(base).get('/espace');
    assert.equal(res.status, 303);
    assert.equal(res.location, '/connexion');
  });

  test('client logins are generated in sequence and the password is not shown again', async () => {
    assert.equal(alice.login, 'CL-0001');
    assert.equal(bob.login, 'CL-0002');
    const again = await adminBrowser.get(`/admin/clients/${alice.clientId}`);
    assert.ok(!again.body.includes(alice.password));
  });

  test('wrong password is rejected without revealing which field was wrong', async () => {
    const res = await new Browser(base).login(alice.login, 'nope');
    assert.equal(res.status, 401);
    assert.match(res.body, /Identifiant ou mot de passe incorrect/);
    const unknown = await new Browser(base).login('CL-9999', 'nope');
    assert.equal(unknown.status, 401);
  });

  test('admin builds a dossier, invoice and request for the client', async () => {
    const back = `/admin/clients/${alice.clientId}`;
    let res = await adminBrowser.post(`${back}/dossiers`, {
      reference: 'D-2026-01',
      title: 'Création de société',
      description: 'Statuts & immatriculation',
      status: 'en_cours',
      progress: '20',
    });
    assert.equal(res.location, back);
    const page = await adminBrowser.get(back);
    const dossierId = /\/admin\/dossiers\/(\d+)/.exec(page.body)[1];

    res = await adminBrowser.post(`/admin/dossiers/${dossierId}`, { status: 'attente_client', progress: '60', note: 'Statuts rédigés <b>ok</b>' });
    assert.equal(res.status, 303);

    res = await adminBrowser.post(`${back}/factures`, {
      number: 'F-001',
      label: 'Honoraires',
      dossier_id: dossierId,
      amount: '1 250,500',
      issued_on: '2026-09-01',
      due_on: '2026-09-30',
    });
    assert.equal(res.status, 303);
    res = await adminBrowser.post(`${back}/factures`, {
      number: 'F-002',
      label: 'Frais',
      dossier_id: '',
      amount: '100',
      issued_on: '2026-10-01',
      due_on: '2026-11-30',
    });
    assert.equal(res.status, 303);

    res = await adminBrowser.post(`${back}/taches`, { title: 'Envoyer la CIN', description: '', dossier_id: dossierId, priority: 'haute', due_on: '' });
    assert.equal(res.status, 303);
  });

  test('invalid admin input is reported and nothing is saved', async () => {
    const back = `/admin/clients/${alice.clientId}`;
    const page = await adminBrowser.follow(
      await adminBrowser.post(`${back}/factures`, { number: 'F-X', amount: '12,34567', issued_on: '2026-10-01', due_on: '2026-10-02' }),
    );
    assert.match(page.body, /Montant invalide/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE number = 'F-X'").get().n, 0);

    // A dossier belonging to another client cannot be attached.
    const dossierId = db.prepare('SELECT id FROM dossiers WHERE client_id = ?').get(alice.clientId).id;
    const other = await adminBrowser.follow(
      await adminBrowser.post(`/admin/clients/${bob.clientId}/taches`, { title: 'x', priority: 'basse', dossier_id: String(dossierId) }),
    );
    assert.match(other.body, /Dossier invalide/);
  });

  test('client must change the temporary password, then sees only their own data', async () => {
    const browser = new Browser(base);
    const res = await browser.login(alice.login, alice.password);
    assert.equal(res.location, '/mot-de-passe');

    const blocked = await browser.get('/espace');
    assert.equal(blocked.location, '/mot-de-passe');

    await browser.get('/mot-de-passe');
    const weak = await browser.post('/mot-de-passe', { current: alice.password, next: 'short', confirm: 'short' });
    assert.equal(weak.status, 400);
    const changed = await browser.post('/mot-de-passe', { current: alice.password, next: 'alice-new-password', confirm: 'alice-new-password' });
    assert.equal(changed.location, '/');
    alice.password = 'alice-new-password';

    const dash = await browser.get('/espace');
    assert.equal(dash.status, 200);
    assert.match(dash.body, /Création de société/);
    assert.match(dash.body, /En attente de votre part/);
    assert.match(dash.body, /<progress max="100" value="60">/);
    assert.match(dash.body, /1 en retard/);
    // Notes are escaped, never rendered as HTML.
    assert.match(dash.body, /Statuts rédigés &lt;b&gt;ok&lt;\/b&gt;/);

    const invoices = await browser.get('/espace/factures');
    assert.match(invoices.body, /F-001/);
    assert.match(invoices.body, /En retard/);
    assert.match(invoices.body, /F-002/);
    assert.match(invoices.body, /À payer/);

    const history = await browser.get('/espace/historique');
    assert.match(history.body, /Ouverture du dossier/);
    assert.match(history.body, /avancement : 20 % → 60 %/);
    assert.match(history.body, /Nouvelle facture n° F-001/);

    // Admin pages are hidden from clients.
    assert.equal((await browser.get('/admin')).status, 404);
  });

  test('a client cannot open or change another client’s dossier or task', async () => {
    const dossierId = db.prepare('SELECT id FROM dossiers WHERE client_id = ?').get(alice.clientId).id;
    const taskId = db.prepare("SELECT id FROM tasks WHERE client_id = ? AND assignee = 'client'").get(alice.clientId).id;

    const browser = new Browser(base);
    await browser.login(bob.login, bob.password);
    await browser.get('/mot-de-passe');
    await browser.post('/mot-de-passe', { current: bob.password, next: 'bob-new-password', confirm: 'bob-new-password' });

    assert.equal((await browser.get(`/espace/dossiers/${dossierId}`)).status, 404);
    await browser.get('/espace/taches');
    assert.equal((await browser.post(`/espace/taches/${taskId}/terminer`)).status, 404);
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId).status, 'nouvelle');
    const dash = await browser.get('/espace');
    assert.ok(!dash.body.includes('Création de société'));
  });

  test('client deposits a task and completes a requested one; admin sees and handles it', async () => {
    const browser = new Browser(base);
    await browser.login(alice.login, alice.password);
    await browser.get('/espace/taches');
    const dossierId = db.prepare('SELECT id FROM dossiers WHERE client_id = ?').get(alice.clientId).id;

    const res = await browser.post('/espace/taches', {
      title: 'Ajouter un associé',
      description: 'Merci de modifier les statuts',
      dossier_id: String(dossierId),
      priority: 'haute',
      due_on: '2026-11-15',
    });
    const page = await browser.follow(res);
    assert.match(page.body, /bien été transmise/);
    assert.match(page.body, /Ajouter un associé/);

    const requested = db.prepare("SELECT id FROM tasks WHERE client_id = ? AND assignee = 'client'").get(alice.clientId).id;
    await browser.post(`/espace/taches/${requested}/terminer`);
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(requested).status, 'terminee');

    const detail = await browser.get(`/espace/dossiers/${dossierId}`);
    assert.match(detail.body, /Nouvelle tâche déposée : « Ajouter un associé »/);
    assert.match(detail.body, /réalisée par le client/);

    const adminTasks = await adminBrowser.get('/admin/taches');
    assert.match(adminTasks.body, /Ajouter un associé/);
    const deposited = db.prepare("SELECT id FROM tasks WHERE title = 'Ajouter un associé'").get().id;
    await adminBrowser.post(`/admin/taches/${deposited}`, { status: 'en_cours' });
    const history = await browser.get('/espace/historique');
    assert.match(history.body, /Tâche « Ajouter un associé » : Nouvelle → En cours/);
  });

  test('marking an invoice paid records the payment date', async () => {
    const invoice = db.prepare("SELECT id FROM invoices WHERE number = 'F-001'").get();
    await adminBrowser.get(`/admin/clients/${alice.clientId}`);
    await adminBrowser.post(`/admin/factures/${invoice.id}`, { status: 'payee' });
    const row = db.prepare('SELECT status, paid_on FROM invoices WHERE id = ?').get(invoice.id);
    assert.deepEqual({ ...row }, { status: 'payee', paid_on: '2026-10-17' });
  });

  test('forms without a valid CSRF token or from another site are refused', async () => {
    const browser = new Browser(base);
    await browser.login(alice.login, alice.password);
    await browser.get('/espace/taches');
    const noToken = await browser.post('/espace/taches', { _csrf: 'forged', title: 'x', priority: 'basse' });
    assert.equal(noToken.status, 403);
    const crossSite = await browser.post('/espace/taches', { title: 'x', priority: 'basse' }, { headers: { origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403);
  });

  test('password reset signs the client out and forces a new password', async () => {
    const browser = new Browser(base);
    await browser.login(alice.login, alice.password);
    assert.equal((await browser.get('/espace')).status, 200);

    await adminBrowser.get(`/admin/clients/${alice.clientId}`);
    const page = await adminBrowser.follow(await adminBrowser.post(`/admin/clients/${alice.clientId}/mot-de-passe`));
    const temp = /provisoire pour CL-0001 : (\w+)/.exec(page.body)[1];

    assert.equal((await browser.get('/espace')).location, '/connexion');
    const res = await new Browser(base).login(alice.login, temp);
    assert.equal(res.location, '/mot-de-passe');
  });

  test('deactivated accounts cannot sign in', async () => {
    await adminBrowser.get(`/admin/clients/${bob.clientId}`);
    await adminBrowser.post(`/admin/clients/${bob.clientId}/activation`);
    const res = await new Browser(base).login(bob.login, 'bob-new-password');
    assert.equal(res.status, 401);
  });

  test('repeated failed logins are throttled', async () => {
    const browser = new Browser(base);
    for (let i = 0; i < 5; i++) await browser.login('CL-0042', `wrong-${i}`);
    const res = await browser.login('CL-0042', 'wrong-again');
    assert.equal(res.status, 429);
  });

  test('logout ends the session', async () => {
    const browser = new Browser(base);
    await browser.login('admin', 'admin-password-1');
    await browser.get('/admin');
    await browser.post('/deconnexion');
    assert.equal((await browser.get('/admin')).location, '/connexion');
  });
});
