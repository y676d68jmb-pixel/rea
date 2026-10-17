// One test per defect found in review, each on its own fresh dossier.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, createClient, signInClient, startPortal } from './helpers.js';

const clock = { now: new Date('2026-10-17T09:00:00Z') };
let portal;
let admin;
let client;
let browser;
let n = 0;

before(async () => {
  portal = await startPortal(clock);
  admin = new Browser(portal.base);
  await admin.login('admin', 'admin-password-1');
  client = await createClient(portal, admin, 'Nadia');
  browser = await signInClient(portal, client);
});

after(() => portal.close());

async function newDossier(direction = 'import') {
  await admin.get(`/admin/clients/${client.clientId}`);
  const res = await admin.post(`/admin/clients/${client.clientId}/dossiers`, { direction, reference: `R-${++n}`, title: `Marchandise ${n}` });
  assert.equal(res.status, 303, res.body.slice(0, 300));
  const id = Number(res.location.split('/').pop());
  await admin.get(`/admin/dossiers/${id}`);
  return id;
}

const docOf = (id, type) => portal.one('SELECT * FROM dossier_documents WHERE dossier_id = ? AND doc_type = ?', id, type);
const flashOf = async (res) => (await admin.follow(res)).body;

describe('sign-in protections', () => {
  test('simultaneous wrong guesses are throttled like sequential ones', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => new Browser(portal.base).request('/connexion', {
        method: 'POST',
        form: { login: 'admin', password: `wrong-${i}` },
        headers: { 'x-test': String(i) },
      })),
    );
    const checked = results.filter((r) => r.status === 401).length;
    assert.ok(checked <= 5, `${checked} guesses were checked`);
    assert.ok(results.some((r) => r.status === 429));
  });

  test('the current-password check of a signed-in user is throttled', async () => {
    const other = await createClient(portal, admin, 'Karim');
    const session = await signInClient(portal, other);
    await session.get('/mot-de-passe');
    let last;
    for (let i = 0; i < 6; i++) last = await session.post('/mot-de-passe', { current: `bad-${i}`, next: 'something-long', confirm: 'something-long' });
    assert.equal(last.status, 429);
  });

  test('a malformed address gives 404, not a server error', async () => {
    assert.equal((await new Browser(portal.base).get('/admin/dossiers/%ZZ')).status, 404);
  });
});

describe('documents', () => {
  test('the quick check on « À traiter » keeps the due date and instructions', async () => {
    const id = await newDossier();
    const doc = docOf(id, 'liste_colisage');
    await admin.post(`/admin/documents/${doc.id}`, { status: 'a_fournir', due_on: '2026-10-20', note: 'Original signé + 2 copies', prev_status: 'a_fournir' });
    await browser.get('/espace');
    await browser.post(`/espace/documents/${doc.id}/envoye`, { back: '/espace' });
    await admin.get('/admin/taches');
    await admin.post(`/admin/documents/${doc.id}`, { status: 'a_fournir', note: 'Original signé + 2 copies', prev_status: 'envoye', back: '/admin/taches' });
    const after = docOf(id, 'liste_colisage');
    assert.deepEqual([after.status, after.due_on, after.note], ['a_fournir', '2026-10-20', 'Original signé + 2 copies']);
  });

  test('a row loaded before the client reported a document cannot undo the report', async () => {
    const id = await newDossier();
    const doc = docOf(id, 'titre_commerce');
    await browser.get('/espace');
    await browser.post(`/espace/documents/${doc.id}/envoye`, { back: '/espace' });
    const body = await flashOf(await admin.post(`/admin/documents/${doc.id}`, { status: 'a_fournir', due_on: '2026-10-25', note: '', prev_status: 'a_fournir' }));
    assert.match(body, /vient de changer d’état/);
    assert.equal(docOf(id, 'titre_commerce').status, 'envoye');
  });

  test('a finished dossier no longer asks for documents', async () => {
    const id = await newDossier();
    await admin.post(`/admin/dossiers/${id}/etape`, { stage: 'termine' });
    assert.equal(portal.one('SELECT stage FROM dossiers WHERE id = ?', id).stage, 'termine');
    const page = await browser.get('/espace/dossiers');
    assert.doesNotMatch(page.body.split('Terminés ou annulés')[1], /documents? à fournir/);
  });
});

describe('dossier rules', () => {
  test('a hold waiting on the client shows up in « À faire »', async () => {
    const id = await newDossier();
    for (const doc of portal.all("SELECT id FROM dossier_documents WHERE dossier_id = ? AND responsible = 'client'", id)) {
      await admin.post(`/admin/documents/${doc.id}`, { status: 'non_requis', note: '', due_on: '' });
    }
    await admin.post(`/admin/dossiers/${id}/situation`, { hold: 'attente_paiement', hold_note: 'Provision P-9 à régler' });
    const page = await browser.get('/espace/a-faire');
    assert.match(page.body, /Paiement attendu : <strong>Provision P-9 à régler/);
    assert.match((await browser.get('/espace')).body, /À faire \(\d+\)/);
    await admin.post(`/admin/dossiers/${id}/situation`, { hold: '', hold_note: '' });
  });

  test('requests on a cancelled dossier leave « À faire »', async () => {
    const id = await newDossier();
    await admin.post(`/admin/clients/${client.clientId}/taches`, { title: 'Venir à la visite R', description: '', dossier_id: String(id), priority: 'haute', due_on: '' });
    assert.match((await browser.get('/espace/a-faire')).body, /Venir à la visite R/);
    await admin.post(`/admin/dossiers/${id}/situation`, { hold: 'annule', hold_note: 'Annulé' });
    assert.doesNotMatch((await browser.get('/espace/a-faire')).body, /Venir à la visite R/);
  });

  test('a finished dossier cannot be put on hold or back under technical control', async () => {
    const id = await newDossier();
    await admin.post(`/admin/dossiers/${id}/etape`, { stage: 'termine' });
    assert.match(await flashOf(await admin.post(`/admin/dossiers/${id}/situation`, { hold: 'attente_client', hold_note: 'x' })), /Le dossier est terminé/);
    assert.match(await flashOf(await admin.post(`/admin/dossiers/${id}/controle-technique`, { ct_status: 'ape', ct_note: '' })), /Le dossier est terminé/);
    const d = portal.one('SELECT hold, ct_status FROM dossiers WHERE id = ?', id);
    assert.deepEqual([d.hold, d.ct_status], [null, null]);
  });

  test('going back to « Dossier ouvert » does not unlock the direction', async () => {
    const id = await newDossier();
    await admin.post(`/admin/dossiers/${id}/etape`, { stage: 'declaration' });
    await admin.post(`/admin/dossiers/${id}/etape`, { stage: 'ouverture', note: 'Erreur de saisie' });
    const d = portal.one('SELECT * FROM dossiers WHERE id = ?', id);
    const body = await flashOf(await admin.post(`/admin/dossiers/${id}/infos`, { direction: 'export', reference: d.reference, title: d.title }));
    assert.match(body, /ne peut plus changer/);
  });

  test('duties of zero ask nothing of the client', async () => {
    const id = await newDossier();
    await admin.post(`/admin/dossiers/${id}/droits`, { duties_amount: '0', duties_payer: '', duties_due_on: '', duties_paid_on: '', duties_receipt: '' });
    assert.doesNotMatch((await browser.get('/espace/a-faire')).body, /Droits et taxes à payer/);
    assert.match(portal.one('SELECT message FROM events WHERE dossier_id = ? ORDER BY id DESC', id).message, /Aucun droit ni taxe à payer/);
  });

  test('declaration and BAE dates cannot be in the future', async () => {
    const id = await newDossier();
    const body = await flashOf(await admin.post(`/admin/dossiers/${id}/douane`, { declaration_number: '1', declaration_on: '2027-01-01', circuit: '', visit_on: '', visit_place: '', bae_on: '' }));
    assert.match(body, /ne peuvent pas être dans le futur/);
  });

  test('references with accents are refused so duplicates are always caught', async () => {
    await admin.get(`/admin/clients/${client.clientId}`);
    const body = await flashOf(await admin.post(`/admin/clients/${client.clientId}/dossiers`, { direction: 'import', reference: 'RÉF-1', title: 'x' }));
    assert.match(body, /lettres sans accent/);
  });
});

describe('invoices', () => {
  async function paidProvision(number, amount) {
    await admin.get(`/admin/clients/${client.clientId}/factures/nouvelle`);
    await admin.post(`/admin/clients/${client.clientId}/provisions`, { number, amount, due_on: '2026-10-30', dossier_id: '', label: '' });
    const p = portal.one('SELECT id FROM invoices WHERE number = ?', number);
    await admin.get(`/admin/factures/${p.id}`);
    await admin.post(`/admin/factures/${p.id}`, { status: 'payee', paid_on: '2026-10-17' });
    return p.id;
  }

  const invoiceForm = (number, extra) => ({
    number, label: '', dossier_id: '', issued_on: '2026-10-17', due_on: '2026-11-16', stamp: '1,000', legal_note: '',
    l1_kind: 'honoraires', l1_label: 'Honoraires', l1_amount: '300', l1_vat: '1900', action: 'emettre', ...extra,
  });

  test('a cancelled invoice keeps the amount and deductions it was issued with', async () => {
    const pid = await paidProvision('PR-1', '100');
    await admin.get(`/admin/clients/${client.clientId}/factures/nouvelle`);
    await admin.post(`/admin/clients/${client.clientId}/factures`, invoiceForm('FA-1', { [`deduct_${pid}`]: '1' }));
    const inv = portal.one("SELECT * FROM invoices WHERE number = 'FA-1'");
    assert.equal(inv.amount_minor, 258_000); // 300 + 57 + 1 − 100
    await admin.get(`/admin/factures/${inv.id}`);
    await admin.post(`/admin/factures/${inv.id}`, { status: 'annulee' });
    const page = await browser.get(`/espace/factures/${inv.id}`);
    assert.match(page.body, /Provision déjà versée n° PR-1/);
    assert.match(page.body, /Net à payer<\/td><td class="num">258,000/);
    assert.equal(portal.one('SELECT deducted_in FROM invoices WHERE id = ?', pid).deducted_in, null, 'provision released');
  });

  test('the client sees which invoice a provision was deducted on', async () => {
    const pid = await paidProvision('PR-2', '50');
    await admin.get(`/admin/clients/${client.clientId}/factures/nouvelle`);
    await admin.post(`/admin/clients/${client.clientId}/factures`, invoiceForm('FA-2', { [`deduct_${pid}`]: '1' }));
    assert.match((await browser.get(`/espace/factures/${pid}`)).body, /Déduite sur la facture FA-2/);
  });

  test('an invoice fully covered by provisions is announced as settled', async () => {
    const pid = await paidProvision('PR-3', '358');
    await admin.get(`/admin/clients/${client.clientId}/factures/nouvelle`);
    await admin.post(`/admin/clients/${client.clientId}/factures`, invoiceForm('FA-3', { [`deduct_${pid}`]: '1' }));
    const inv = portal.one("SELECT status, amount_minor FROM invoices WHERE number = 'FA-3'");
    assert.deepEqual([inv.status, inv.amount_minor], ['payee', 0]);
    assert.match(portal.one('SELECT message FROM events ORDER BY id DESC').message, /émise et réglée par les provisions déduites/);
  });

  test('the payment date of a paid invoice can be corrected', async () => {
    const pid = await paidProvision('PR-4', '10');
    await admin.post(`/admin/factures/${pid}`, { status: 'payee', paid_on: '2026-10-15' });
    assert.equal(portal.one('SELECT paid_on FROM invoices WHERE id = ?', pid).paid_on, '2026-10-15');
    assert.match(portal.one('SELECT message FROM events ORDER BY id DESC').message, /date de paiement corrigée au 15 oct\. 2026/);
  });
});
