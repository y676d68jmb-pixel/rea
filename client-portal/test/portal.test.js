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

  async follow(response) {
    assert.equal(response.status, 303, `expected redirect, got ${response.status}: ${response.body.slice(0, 400)}`);
    return this.get(response.location);
  }

  async login(login, password) {
    await this.get('/connexion');
    const res = await this.post('/connexion', { login, password });
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

const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);

async function createClient(admin, name) {
  const page = await admin.follow(await admin.post('/admin/clients', { name, company: `${name} SARL`, email: '', phone: '' }));
  const m = /Identifiant : (CL-\d{4}) — mot de passe provisoire : (\w+)/.exec(page.body);
  assert.ok(m, 'credentials shown once after creation');
  const clientId = one('SELECT id FROM users WHERE login = ?', m[1]).id;
  return { login: m[1], password: m[2], clientId };
}

async function signInClient(client) {
  const browser = new Browser(base);
  const res = await browser.login(client.login, client.password);
  if (res.location === '/mot-de-passe') {
    const next = `${client.login}-new-password`;
    await browser.post('/mot-de-passe', { current: client.password, next, confirm: next });
    client.password = next;
  }
  return browser;
}

describe('portail de dédouanement', () => {
  let admin;
  let alice;
  let bob;
  let importId;
  let aliceBrowser;

  before(async () => {
    admin = new Browser(base);
    const res = await admin.login('admin', 'admin-password-1');
    assert.equal(res.location, '/');
    alice = await createClient(admin, 'Alice');
    bob = await createClient(admin, 'Bob');
  });

  test('unauthenticated visitors are sent to the login page', async () => {
    const res = await new Browser(base).get('/espace');
    assert.equal(res.location, '/connexion');
  });

  test('opening an import file seeds its document checklist and history', async () => {
    await admin.get(`/admin/clients/${alice.clientId}`);
    const res = await admin.post(`/admin/clients/${alice.clientId}/dossiers`, {
      direction: 'import',
      reference: 'IMP-2026-0001',
      client_reference: 'PO-5531',
      title: 'Pièces détachées <auto>',
      regime: 'mise_consommation',
      transport_mode: 'maritime',
      customs_office: 'rades',
      expected_on: '2026-10-25',
    });
    assert.match(res.location, /^\/admin\/dossiers\/\d+$/);
    importId = Number(res.location.split('/').pop());
    const dossier = one('SELECT * FROM dossiers WHERE id = ?', importId);
    assert.equal(dossier.stage, 'ouverture');
    const docs = all('SELECT doc_type, responsible, status FROM dossier_documents WHERE dossier_id = ? ORDER BY position', importId);
    assert.deepEqual(
      docs.map((d) => d.doc_type),
      ['titre_commerce', 'liste_colisage', 'titre_transport', 'remise_declaration', 'remise_bae', 'remise_quittance', 'remise_tce'],
    );
    assert.ok(docs.filter((d) => d.responsible === 'cabinet').every((d) => d.status === 'a_venir'));
    assert.equal(one('SELECT COUNT(*) AS n FROM dossier_stages WHERE dossier_id = ?', importId).n, 1);
    assert.match(one('SELECT message FROM events WHERE dossier_id = ?', importId).message, /Ouverture du dossier IMP-2026-0001 \(Importation\)/);
  });

  test('duplicate references and regimes of the other direction are refused', async () => {
    const page = await admin.follow(
      await admin.post(`/admin/clients/${bob.clientId}/dossiers`, { direction: 'export', reference: 'imp-2026-0001', title: 'x' }),
    );
    assert.match(page.body, /déjà utilisée/);
    const wrong = await admin.follow(
      await admin.post(`/admin/clients/${bob.clientId}/dossiers`, { direction: 'export', reference: 'EXP-1', title: 'x', regime: 'mise_consommation' }),
    );
    assert.match(wrong.body, /ne correspond pas à un dossier d&#39;exportation/);
    assert.equal(one("SELECT COUNT(*) AS n FROM dossiers WHERE client_id = ?", bob.clientId).n, 0);
  });

  test('the client sees what to provide and can report a document as sent', async () => {
    aliceBrowser = await signInClient(alice);
    const dash = await aliceBrowser.get('/espace');
    assert.match(dash.body, /À faire \(3\)/);
    assert.match(dash.body, /3 documents à fournir/);
    assert.match(dash.body, /Pièces détachées &lt;auto&gt;/);
    assert.match(dash.body, /Liste de colisage/);

    const doc = one("SELECT id FROM dossier_documents WHERE dossier_id = ? AND doc_type = 'liste_colisage'", importId);
    const page = await aliceBrowser.follow(await aliceBrowser.post(`/espace/documents/${doc.id}/envoye`, { back: '/espace' }));
    assert.match(page.body, /Nous vérifions « Liste de colisage »/);
    assert.equal(one('SELECT status FROM dossier_documents WHERE id = ?', doc.id).status, 'envoye');
    assert.match(page.body, /À faire \(2\)/);
    // A second report of the same document is refused.
    assert.equal((await aliceBrowser.post(`/espace/documents/${doc.id}/envoye`)).status, 404);
  });

  test('a client cannot act on documents that are not theirs to send', async () => {
    const bobBrowser = await signInClient(bob);
    await bobBrowser.get('/espace');
    const aliceDoc = one("SELECT id FROM dossier_documents WHERE dossier_id = ? AND doc_type = 'titre_commerce'", importId);
    assert.equal((await bobBrowser.post(`/espace/documents/${aliceDoc.id}/envoye`)).status, 404);
    assert.equal(one('SELECT status FROM dossier_documents WHERE id = ?', aliceDoc.id).status, 'a_fournir');
    assert.equal((await bobBrowser.get(`/espace/dossiers/${importId}`)).status, 404);
    assert.ok(!(await bobBrowser.get('/espace')).body.includes('Pièces détachées'));

    const firmDoc = one("SELECT id FROM dossier_documents WHERE dossier_id = ? AND responsible = 'cabinet'", importId);
    await aliceBrowser.get('/espace');
    assert.equal((await aliceBrowser.post(`/espace/documents/${firmDoc.id}/envoye`)).status, 404);
  });

  test('the firm checks reported documents and can ask for a correction', async () => {
    const tasksPage = await admin.get('/admin/taches');
    assert.match(tasksPage.body, /Liste de colisage/);
    const doc = one("SELECT id FROM dossier_documents WHERE dossier_id = ? AND doc_type = 'liste_colisage'", importId);
    const refused = await admin.follow(await admin.post(`/admin/documents/${doc.id}`, { status: 'a_corriger', note: '', back: '/admin/taches' }));
    assert.match(refused.body, /Indiquez ce qu’il faut corriger/);
    await admin.post(`/admin/documents/${doc.id}`, { status: 'a_corriger', note: 'Le poids ne correspond pas à la facture', back: '/admin/taches' });
    const page = await aliceBrowser.get('/espace');
    assert.match(page.body, /Document à corriger/);
    assert.match(page.body, /Le poids ne correspond pas à la facture/);
    // A cabinet document cannot take a client-side status.
    const firmDoc = one("SELECT id FROM dossier_documents WHERE dossier_id = ? AND doc_type = 'remise_bae'", importId);
    await admin.get(`/admin/dossiers/${importId}`);
    const bad = await admin.follow(await admin.post(`/admin/documents/${firmDoc.id}`, { status: 'valide', note: '' }));
    assert.match(bad.body, /Valeur invalide/);
  });

  test('steps follow the direction, going back needs a reason, and history keeps dates', async () => {
    await admin.get(`/admin/dossiers/${importId}`);
    let page = await admin.follow(await admin.post(`/admin/dossiers/${importId}/etape`, { stage: 'embarquement' }));
    assert.match(page.body, /ne concerne pas un dossier d&#39;importation/);
    await admin.post(`/admin/dossiers/${importId}/etape`, { stage: 'controle', entered_on: '2026-10-16', note: 'Déclaration acceptée' });
    assert.equal(one('SELECT stage FROM dossiers WHERE id = ?', importId).stage, 'controle');
    page = await admin.follow(await admin.post(`/admin/dossiers/${importId}/etape`, { stage: 'documents' }));
    assert.match(page.body, /Indiquez la raison du retour/);
    page = await admin.follow(await admin.post(`/admin/dossiers/${importId}/etape`, { stage: 'controle', entered_on: '2026-12-01' }));
    assert.match(page.body, /dans le futur/);

    const client = await aliceBrowser.get(`/espace/dossiers/${importId}`);
    assert.match(client.body, /<progress max="100" value="60">/);
    assert.match(client.body, /Étape franchie : Contrôle de la douane\. Déclaration acceptée/);
    assert.match(client.body, /step step-current" aria-current="step">\s*<span class="step-label">Contrôle de la douane<\/span>\s*<span class="step-date">16 oct\. 2026/);
    // A skipped step shows as done, without a date.
    assert.match(client.body, /step step-done"\s*>\s*<span class="step-label">Arrivée de la marchandise<\/span>\s*<\/li>/);
  });

  test('customs details, duties and holds reach the client', async () => {
    await admin.get(`/admin/dossiers/${importId}`);
    await admin.post(`/admin/dossiers/${importId}/douane`, {
      declaration_number: '2026/123456', declaration_on: '2026-10-16', circuit: 'rouge', visit_on: '2026-10-20', visit_place: 'MAD Radès', bae_on: '',
    });
    await admin.post(`/admin/dossiers/${importId}/droits`, {
      duties_amount: '12 345,678', duties_payer: 'client', duties_due_on: '2026-10-19', duties_paid_on: '', duties_receipt: '',
    });
    await admin.post(`/admin/dossiers/${importId}/situation`, { hold: 'attente_paiement', hold_note: 'Droits à régler à la recette' });

    const page = await aliceBrowser.get(`/espace/dossiers/${importId}`);
    assert.match(page.body, /Circuit rouge/);
    assert.match(page.body, /20 oct\. 2026 — MAD Radès/);
    assert.match(page.body, /n° 2026\/123456 du 16 oct\. 2026/);
    assert.match(page.body, /En attente de paiement<\/strong> — Droits à régler à la recette/);
    const dash = await aliceBrowser.get('/espace');
    assert.match(dash.body, /Droits et taxes à payer à la douane : <strong>12[\s ]345,678/);

    const history = await aliceBrowser.get('/espace/historique');
    assert.match(history.body, /Circuit attribué par la douane : Circuit rouge/);
    assert.match(history.body, /Droits et taxes liquidés : 12[\s ]345,678\sTND, à payer par vous avant le 19 oct\. 2026/);

    await admin.post(`/admin/dossiers/${importId}/droits`, {
      duties_amount: '12345,678', duties_payer: 'client', duties_due_on: '2026-10-19', duties_paid_on: '2026-10-17', duties_receipt: 'Q-778',
    });
    assert.doesNotMatch((await aliceBrowser.get('/espace')).body, /Droits et taxes à payer à la douane/);
  });

  test('a dossier cannot be finished while on hold or pending technical control', async () => {
    let page = await admin.follow(await admin.post(`/admin/dossiers/${importId}/etape`, { stage: 'termine' }));
    assert.match(page.body, /Retirez d&#39;abord la situation/);
    await admin.post(`/admin/dossiers/${importId}/situation`, { hold: '', hold_note: '' });
    await admin.post(`/admin/dossiers/${importId}/controle-technique`, { ct_status: 'ape', ct_note: '' });
    assert.match((await aliceBrowser.get(`/espace/dossiers/${importId}`)).body, /Ne vendez pas cette marchandise/);
    page = await admin.follow(await admin.post(`/admin/dossiers/${importId}/etape`, { stage: 'termine' }));
    assert.match(page.body, /contrôle technique n&#39;est pas terminé/);

    await admin.post(`/admin/dossiers/${importId}/situation`, { hold: 'annule', hold_note: 'Commande annulée par le fournisseur' });
    page = await admin.follow(await admin.post(`/admin/dossiers/${importId}/etape`, { stage: 'bae' }));
    assert.match(page.body, /Le dossier est annulé/);
    assert.doesNotMatch((await aliceBrowser.get('/espace')).body, /Pièces détachées/);
    await admin.post(`/admin/dossiers/${importId}/situation`, { hold: '', hold_note: '' });
    assert.match(one('SELECT message FROM events WHERE dossier_id = ? ORDER BY id DESC', importId).message, /Dossier réactivé/);
  });

  test('editing details logs what the client sees, never internal fields', async () => {
    const d = one('SELECT * FROM dossiers WHERE id = ?', importId);
    const before = one('SELECT COUNT(*) AS n FROM events').n;
    await admin.post(`/admin/dossiers/${importId}/infos`, {
      direction: 'import', reference: d.reference, client_reference: d.client_reference, title: d.title, description: '',
      regime: d.regime, regime_code: 'CF 405', transport_mode: 'maritime', transport_doc: 'MEDU1234567', vessel: '', containers: 'MSCU1234567',
      counterparty: '', customs_office: 'rades', customs_office_detail: '', expected_on: '2026-10-25', manifest_ref: 'Escale 512',
    });
    const message = one('SELECT message FROM events ORDER BY id DESC').message;
    assert.equal(one('SELECT COUNT(*) AS n FROM events').n, before + 1);
    assert.match(message, /Conteneurs : non renseigné → MSCU1234567/);
    assert.doesNotMatch(message, /CF 405|Escale/);
    const page = await aliceBrowser.get(`/espace/dossiers/${importId}`);
    assert.match(page.body, /Connaissement \(BL\)<\/dt><dd>MEDU1234567/);
    assert.doesNotMatch(page.body, /CF 405|Escale 512/);
    // Direction is locked once the file has started.
    const locked = await admin.follow(await admin.post(`/admin/dossiers/${importId}/infos`, { ...d, direction: 'export' }));
    assert.match(locked.body, /ne peut plus changer/);
  });

  test('switching direction at opening swaps the untouched checklist', async () => {
    await admin.get(`/admin/clients/${bob.clientId}`);
    const res = await admin.post(`/admin/clients/${bob.clientId}/dossiers`, { direction: 'import', reference: 'B-1', title: 'Huile d’olive' });
    const id = Number(res.location.split('/').pop());
    await admin.post(`/admin/dossiers/${id}/infos`, { direction: 'export', reference: 'B-1', title: 'Huile d’olive' });
    const types = all('SELECT doc_type FROM dossier_documents WHERE dossier_id = ? ORDER BY doc_type', id).map((r) => r.doc_type);
    assert.ok(!types.includes('titre_transport') && !types.includes('remise_bae'));
    assert.ok(types.includes('remise_declaration_export') && types.includes('liste_colisage'));
    assert.equal(new Set(types).size, types.length, 'no duplicates');
  });

  test('provisions, detailed invoices and deductions', async () => {
    const back = `/admin/clients/${alice.clientId}`;
    await admin.get(`${back}/factures/nouvelle?dossier=${importId}`);
    let res = await admin.post(`${back}/provisions`, { number: 'P-001', amount: '500', due_on: '2026-10-20', dossier_id: String(importId), label: '' });
    const provision = one("SELECT * FROM invoices WHERE number = 'P-001'");
    assert.equal(res.location, `/admin/factures/${provision.id}`);
    assert.match((await aliceBrowser.get('/espace')).body, /Provision n° P-001 à régler : <strong>500,000/);

    await admin.get(`/admin/factures/${provision.id}`);
    await admin.post(`/admin/factures/${provision.id}`, { status: 'payee', paid_on: '2026-10-17' });

    const lines = {
      number: 'F-001', label: 'Dédouanement', dossier_id: String(importId), issued_on: '2026-10-17', due_on: '2026-11-16', stamp: '1,000', legal_note: '',
      l1_kind: 'honoraires', l1_label: 'Honoraires de dédouanement', l1_amount: '300', l1_vat: '1900',
      l2_kind: 'debours', l2_label: 'Droits et taxes', l2_amount: '1200', l2_category: 'droits_taxes', l2_receipt: 'Q-778',
      [`deduct_${provision.id}`]: '1',
    };
    await admin.get(`${back}/factures/nouvelle`);
    const preview = await admin.post(`${back}/factures`, { ...lines, action: 'apercu' });
    assert.equal(preview.status, 200);
    assert.match(preview.body, /Aperçu/);
    assert.match(preview.body, /Net à payer<\/td><td class="num">1[\s ]058,000/);
    assert.equal(one("SELECT COUNT(*) AS n FROM invoices WHERE number = 'F-001'").n, 0, 'a preview stores nothing');

    const missingReceipt = await admin.post(`${back}/factures`, { ...lines, l2_receipt: '', action: 'emettre' });
    assert.equal(missingReceipt.status, 400);
    assert.match(missingReceipt.body, /justificatif/);

    const tooMuch = await admin.post(`${back}/factures`, { ...lines, l2_amount: '', l2_label: '', action: 'emettre' });
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.body, /dépassent le total/);

    res = await admin.post(`${back}/factures`, { ...lines, action: 'emettre' });
    const invoice = one("SELECT * FROM invoices WHERE number = 'F-001'");
    assert.equal(res.location, `/admin/factures/${invoice.id}`);
    assert.equal(invoice.amount_minor, 1_058_000); // 300 + 57 TVA + 1200 + 1 timbre − 500
    assert.equal(one('SELECT deducted_in FROM invoices WHERE id = ?', provision.id).deducted_in, invoice.id);

    // Same provision cannot be used twice, even with a forged checkbox.
    const again = await admin.post(`${back}/factures`, { ...lines, number: 'F-002', action: 'emettre' });
    assert.equal(one("SELECT amount_minor FROM invoices WHERE number = 'F-002'").amount_minor, 1_558_000);
    assert.equal(again.status, 303);

    const page = await aliceBrowser.get(`/espace/factures/${invoice.id}`);
    assert.match(page.body, /Prestations du cabinet/);
    assert.match(page.body, /TVA 19 % sur 300,000/);
    assert.match(page.body, /justificatif Q-778/);
    assert.match(page.body, /Provision déjà versée n° P-001/);
    assert.match(page.body, /Net à payer<\/td><td class="num">1[\s ]058,000/);

    const bobBrowser = await signInClient(bob);
    assert.equal((await bobBrowser.get(`/espace/factures/${invoice.id}`)).status, 404);

    // A deducted provision is locked; cancelling the invoice releases it.
    await admin.get(`/admin/factures/${provision.id}`);
    const locked = await admin.follow(await admin.post(`/admin/factures/${provision.id}`, { status: 'a_payer' }));
    assert.match(locked.body, /déduite sur la facture n° F-001/);
    await admin.get(`/admin/factures/${invoice.id}`);
    await admin.post(`/admin/factures/${invoice.id}`, { status: 'annulee' });
    assert.equal(one('SELECT deducted_in FROM invoices WHERE id = ?', provision.id).deducted_in, null);
    const cancelled = await admin.follow(await admin.post(`/admin/factures/${invoice.id}`, { status: 'payee' }));
    assert.match(cancelled.body, /annulée ne peut plus changer/);
  });

  test('overdue invoices are flagged and duplicate invoice numbers refused', async () => {
    clock.now = new Date('2026-12-20T09:00:00Z');
    try {
      // Sessions last 12 hours, so both sides sign in again two months later.
      const client = await signInClient(alice);
      const firm = new Browser(base);
      await firm.login('admin', 'admin-password-1');
      const list = await client.get('/espace/factures');
      assert.match(list.body, /F-002/);
      assert.match(list.body, /En retard/);
      await firm.get(`/admin/clients/${alice.clientId}/factures/nouvelle`);
      const dup = await firm.post(`/admin/clients/${alice.clientId}/factures`, {
        number: 'f-002', issued_on: '2026-12-20', due_on: '2026-12-30', stamp: '', l1_kind: 'honoraires', l1_label: 'x', l1_amount: '1', l1_vat: '1900', action: 'emettre',
      });
      assert.equal(dup.status, 400);
      assert.match(dup.body, /déjà utilisé/);
    } finally {
      // Signing in two months later purged the earlier sessions: sign the shared browsers in again.
      clock.now = new Date('2026-10-17T09:00:00Z');
      await admin.login('admin', 'admin-password-1');
      aliceBrowser = await signInClient(alice);
    }
  });

  test('requests both ways and free messages', async () => {
    await aliceBrowser.get('/espace/a-faire');
    await aliceBrowser.post('/espace/taches', { title: 'Accélérer la livraison', description: '', dossier_id: String(importId), priority: 'haute', due_on: '' });
    assert.match((await admin.get('/admin/taches')).body, /Accélérer la livraison/);

    await admin.get(`/admin/dossiers/${importId}`);
    await admin.post(`/admin/clients/${alice.clientId}/taches`, {
      title: 'Être présent à la visite', description: '', dossier_id: String(importId), priority: 'haute', due_on: '2026-10-20', back: `/admin/dossiers/${importId}`,
    });
    await admin.post(`/admin/dossiers/${importId}/message`, { message: 'Le navire est annoncé pour jeudi.' });
    const todo = await aliceBrowser.get('/espace/a-faire');
    assert.match(todo.body, /Demande du cabinet : <strong>Être présent à la visite/);
    const task = one("SELECT id FROM tasks WHERE title = 'Être présent à la visite'");
    await aliceBrowser.post(`/espace/taches/${task.id}/terminer`, { back: '/espace/a-faire' });
    assert.equal(one('SELECT status FROM tasks WHERE id = ?', task.id).status, 'terminee');
    assert.match((await aliceBrowser.get('/espace/historique')).body, /Le navire est annoncé pour jeudi\./);
  });

  test('admin pages are hidden from clients', async () => {
    assert.equal((await aliceBrowser.get('/admin')).status, 404);
    assert.equal((await aliceBrowser.get(`/admin/dossiers/${importId}`)).status, 404);
  });

  test('forms without a valid CSRF token or from another site are refused', async () => {
    await aliceBrowser.get('/espace/a-faire');
    assert.equal((await aliceBrowser.post('/espace/taches', { _csrf: 'forged', title: 'x', priority: 'basse' })).status, 403);
    const crossSite = await aliceBrowser.post('/espace/taches', { title: 'x', priority: 'basse' }, { headers: { origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403);
  });

  test('password reset signs the client out and forces a new password', async () => {
    const browser = await signInClient(alice);
    assert.equal((await browser.get('/espace')).status, 200);
    await admin.get(`/admin/clients/${alice.clientId}`);
    const page = await admin.follow(await admin.post(`/admin/clients/${alice.clientId}/mot-de-passe`));
    const temp = /provisoire pour CL-0001 : (\w+)/.exec(page.body)[1];
    assert.equal((await browser.get('/espace')).location, '/connexion');
    assert.equal((await new Browser(base).login(alice.login, temp)).location, '/mot-de-passe');
  });

  test('deactivated accounts cannot sign in', async () => {
    await admin.get(`/admin/clients/${bob.clientId}`);
    await admin.post(`/admin/clients/${bob.clientId}/activation`);
    assert.equal((await new Browser(base).login(bob.login, bob.password)).status, 401);
  });

  test('repeated failed logins are throttled', async () => {
    const browser = new Browser(base);
    for (let i = 0; i < 5; i++) await browser.login('CL-0042', `wrong-${i}`);
    assert.equal((await browser.login('CL-0042', 'wrong-again')).status, 429);
  });

  test('logout ends the session', async () => {
    const browser = new Browser(base);
    await browser.login('admin', 'admin-password-1');
    await browser.post('/deconnexion');
    assert.equal((await browser.get('/admin')).location, '/connexion');
  });
});
