/** Pages of the firm (/admin). Each update runs in one transaction with its history event. */
import { nextClientLogin, transaction } from './db.js';
import {
  byKey,
  computeInvoiceTotals,
  CUSTOMS_OFFICES,
  DEFAULT_STAMP_MINOR,
  DOC_STATUS,
  DOC_TYPES,
  LABELS,
  LINE_KINDS,
  REGIMES,
  stagesFor,
} from './format.js';
import { HttpError } from './http.js';
import { invoiceDetail } from './routes-client.js';
import { generatePassword, hashPassword } from './security.js';
import { checkbox, code, day, idParam, money, oneOf, text } from './validate.js';

export const MAX_INVOICE_LINES = 8;

const HOLD_EVENTS = {
  attente_client: 'Dossier en attente de votre part',
  attente_paiement: 'En attente de paiement',
  bloque: 'Dossier bloqué',
  litige: 'Désaccord avec la douane',
  infraction: 'Infraction relevée par la douane',
  annule: 'Dossier annulé',
};

const DOC_STATUS_EVENTS = {
  a_fournir: 'Document demandé',
  envoye: 'Document signalé envoyé',
  recu: 'Document reçu',
  a_corriger: 'Document à corriger',
  valide: 'Document validé',
  a_venir: 'Document en préparation',
  remis: 'Document remis',
  non_requis: 'Document plus nécessaire',
};

const PAYERS = { client: 'Le client', cabinet: 'Le cabinet (débours)' };

/** A redirect target inside the admin area, or the fallback. */
function adminBack(value, fallback) {
  return typeof value === 'string' && /^\/admin(\/[a-z0-9-]+)*$/.test(value) ? value : fallback;
}

const short = (value) => {
  const s = String(value ?? '').trim();
  if (!s) return 'non renseigné';
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
};

export function registerAdminRoutes({ db, q, f, router, flash, render, redirect, logEvent, nowIso }) {
  // ---------- Helpers ----------

  function clientOf(id) {
    const client = q.userById.get(id);
    if (!client || client.role !== 'client') throw new HttpError(404, 'Client introuvable.');
    return client;
  }

  function dossierOf(id) {
    const dossier = q.dossier.get(id);
    if (!dossier) throw new HttpError(404, 'Dossier introuvable.');
    return dossier;
  }

  /** Optional dossier from a form, which must belong to the client. */
  function dossierFor(form, clientId) {
    const raw = String(form.dossier_id ?? '').trim();
    if (!raw) return null;
    const dossier = /^\d{1,15}$/.test(raw) ? q.dossier.get(Number(raw)) : undefined;
    if (!dossier || dossier.client_id !== clientId) throw new HttpError(400, 'Dossier invalide.');
    return dossier.id;
  }

  function regimeFor(form, direction) {
    const regime = oneOf(form, 'regime', LABELS.regime, { required: false, label: 'Régime' });
    if (regime && !['both', direction].includes(byKey(REGIMES, regime).direction)) {
      throw new HttpError(400, `Ce régime ne correspond pas à un dossier d'${direction === 'import' ? 'importation' : 'exportation'}.`);
    }
    return regime;
  }

  function officeFor(form) {
    const office = oneOf(form, 'customs_office', LABELS.office, { required: false, label: 'Bureau de douane' });
    const detail = text(form, 'customs_office_detail', { max: 200, label: 'Précision sur le lieu' });
    if (office && byKey(CUSTOMS_OFFICES, office).detail && !detail) {
      throw new HttpError(400, 'Précisez le lieu de dédouanement (nom du MAD, du bureau ou du poste).');
    }
    return { office, detail };
  }

  function assertReferenceFree(reference, exceptId = null) {
    const existing = q.dossierByReference.get(reference);
    if (existing && existing.id !== exceptId) throw new HttpError(400, `La référence « ${reference} » est déjà utilisée par un autre dossier.`);
  }

  /** Adds the required documents of a direction, except types already on the dossier. */
  function seedDocuments(dossierId, direction, skip = new Set()) {
    const insert = db.prepare(
      `INSERT INTO dossier_documents (dossier_id, doc_type, label, responsible, status, position, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let position = q.maxDocumentPosition.get(dossierId).n;
    for (const type of DOC_TYPES) {
      if (!type.required || !['both', direction].includes(type.applies) || skip.has(type.key)) continue;
      position += 1;
      insert.run(dossierId, type.key, type.label, type.responsible, type.responsible === 'cabinet' ? 'a_venir' : 'a_fournir', position, nowIso());
    }
  }

  /** A dossier has started once it went past opening or a document was acted on. */
  function hasStarted(dossier) {
    const history = q.dossierStages.all(dossier.id);
    if (history.some((row) => row.stage !== 'ouverture')) return true;
    return q.dossierDocuments.all(dossier.id).some((doc) => !['a_fournir', 'a_venir'].includes(doc.status));
  }

  const touch = (dossierId) => db.prepare('UPDATE dossiers SET updated_at = ? WHERE id = ?').run(nowIso(), dossierId);

  // ---------- Overview pages ----------

  router.get('/admin', (ctx) => render(ctx, 'adminHomePage', { clients: q.clients.all() }));

  router.get('/admin/dossiers', (ctx) => {
    const all = ctx.query.get('tous') === '1';
    render(ctx, 'adminDossiersPage', { dossiers: q.allDossiers.all(all ? 1 : 0), all });
  });

  router.get('/admin/taches', (ctx) =>
    render(ctx, 'adminTasksPage', { tasks: q.openTasks.all(), documents: q.documentsToCheck.all() }),
  );

  // ---------- Clients ----------

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
      dossiers: q.clientDossiers.all(client.id),
      invoices: q.clientInvoices.all(client.id),
      tasks: q.clientTasks.all(client.id),
      events: q.clientEvents.all(client.id, 30),
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

  // ---------- Dossiers ----------

  router.post('/admin/clients/:id/dossiers', (ctx) => {
    const client = clientOf(idParam(ctx.params.id));
    ctx.back = `/admin/clients/${client.id}`;
    const direction = oneOf(ctx.form, 'direction', LABELS.direction, { label: 'Sens' });
    const reference = code(ctx.form, 'reference', { label: 'Référence' });
    const title = text(ctx.form, 'title', { required: true, label: 'Marchandise' });
    const clientReference = text(ctx.form, 'client_reference', { max: 100, label: 'Référence du client' });
    const description = text(ctx.form, 'description', { max: 5000 });
    const regime = regimeFor(ctx.form, direction);
    const transportMode = oneOf(ctx.form, 'transport_mode', LABELS.transport, { required: false, label: 'Transport' });
    const { office, detail } = officeFor(ctx.form);
    const expectedOn = day(ctx.form, 'expected_on', { label: direction === 'import' ? 'Arrivée prévue' : 'Départ prévu' });
    assertReferenceFree(reference);
    const at = nowIso();
    const id = transaction(db, () => {
      const result = db
        .prepare(
          `INSERT INTO dossiers (client_id, reference, client_reference, direction, title, description, stage, regime,
             transport_mode, customs_office, customs_office_detail, expected_on, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'ouverture', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(client.id, reference, clientReference, direction, title, description, regime, transportMode, office, detail, expectedOn, at, at);
      const dossierId = Number(result.lastInsertRowid);
      db.prepare('INSERT INTO dossier_stages (dossier_id, stage, entered_on, actor_id, created_at) VALUES (?, ?, ?, ?, ?)').run(
        dossierId, 'ouverture', f.today(), ctx.user.id, at,
      );
      seedDocuments(dossierId, direction);
      logEvent(client.id, dossierId, ctx.user.id, `Ouverture du dossier ${reference} (${LABELS.direction[direction]}) : « ${title} »`);
      return dossierId;
    });
    flash(ctx, 'success', 'Dossier créé avec sa liste de documents.');
    redirect(ctx.res, `/admin/dossiers/${id}`);
  });

  router.get('/admin/dossiers/:id', (ctx) => {
    const dossier = dossierOf(idParam(ctx.params.id));
    render(ctx, 'adminDossierPage', {
      dossier,
      client: q.userById.get(dossier.client_id),
      stages: q.dossierStages.all(dossier.id),
      documents: q.dossierDocuments.all(dossier.id),
      invoices: q.dossierInvoices.all(dossier.id),
      tasks: q.dossierTasks.all(dossier.id),
      events: q.dossierEvents.all(dossier.id),
    });
  });

  router.post('/admin/dossiers/:id/etape', (ctx) => {
    const dossier = dossierOf(idParam(ctx.params.id));
    ctx.back = `/admin/dossiers/${dossier.id}`;
    const list = stagesFor(dossier.direction);
    const stage = oneOf(ctx.form, 'stage', LABELS.stage, { label: 'Étape' });
    const newIndex = list.findIndex((s) => s.key === stage);
    if (newIndex < 0) throw new HttpError(400, `L'étape « ${LABELS.stage[stage]} » ne concerne pas un dossier d'${dossier.direction === 'import' ? 'importation' : 'exportation'}.`);
    const enteredOn = day(ctx.form, 'entered_on', { label: 'Date' }) ?? f.today();
    if (enteredOn > f.today()) throw new HttpError(400, 'La date ne peut pas être dans le futur.');
    const note = text(ctx.form, 'note', { max: 1000, label: 'Commentaire' });
    if (dossier.hold === 'annule') throw new HttpError(400, 'Le dossier est annulé : retirez d’abord la situation « Annulé ».');
    if (stage === dossier.stage) {
      flash(ctx, 'info', 'Le dossier est déjà à cette étape.');
      return redirect(ctx.res, ctx.back);
    }
    const oldIndex = list.findIndex((s) => s.key === dossier.stage);
    if (newIndex < oldIndex && !note) throw new HttpError(400, 'Indiquez la raison du retour à une étape précédente.');
    if (stage === 'termine') {
      if (dossier.hold) throw new HttpError(400, `Retirez d'abord la situation « ${LABELS.hold[dossier.hold]} » avant de terminer le dossier.`);
      if (['depose', 'prelevement', 'ape'].includes(dossier.ct_status)) {
        throw new HttpError(400, `Le contrôle technique n'est pas terminé (${LABELS.ct[dossier.ct_status]}).`);
      }
    }
    const label = LABELS.stage[stage];
    const message =
      newIndex < oldIndex
        ? `Retour à l'étape « ${label} » : ${note}`
        : [stage === 'termine' ? 'Dossier terminé' : `Étape franchie : ${label}`, note].filter(Boolean).join('. ');
    transaction(db, () => {
      db.prepare('UPDATE dossiers SET stage = ?, updated_at = ? WHERE id = ?').run(stage, nowIso(), dossier.id);
      db.prepare('INSERT INTO dossier_stages (dossier_id, stage, entered_on, note, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        dossier.id, stage, enteredOn, note, ctx.user.id, nowIso(),
      );
      logEvent(dossier.client_id, dossier.id, ctx.user.id, message);
    });
    flash(ctx, 'success', `Étape mise à jour : ${label}.`);
    redirect(ctx.res, ctx.back);
  });

  router.post('/admin/dossiers/:id/situation', (ctx) => {
    const dossier = dossierOf(idParam(ctx.params.id));
    ctx.back = `/admin/dossiers/${dossier.id}`;
    const hold = oneOf(ctx.form, 'hold', LABELS.hold, { required: false, label: 'Situation' });
    const note = hold ? text(ctx.form, 'hold_note', { max: 500, required: true, label: 'Motif (affiché au client)' }) : '';
    if (hold && dossier.stage === 'termine') {
      throw new HttpError(400, 'Le dossier est terminé : revenez d’abord à une étape précédente pour signaler une situation particulière.');
    }
    if (hold === dossier.hold && note === dossier.hold_note) {
      flash(ctx, 'info', 'Aucune modification.');
      return redirect(ctx.res, ctx.back);
    }
    const message = hold
      ? `${HOLD_EVENTS[hold]} : ${note}`
      : dossier.hold === 'annule'
        ? 'Dossier réactivé'
        : 'Reprise du traitement normal';
    transaction(db, () => {
      db.prepare('UPDATE dossiers SET hold = ?, hold_note = ?, updated_at = ? WHERE id = ?').run(hold, note, nowIso(), dossier.id);
      logEvent(dossier.client_id, dossier.id, ctx.user.id, message);
    });
    flash(ctx, 'success', 'Situation mise à jour.');
    redirect(ctx.res, ctx.back);
  });

  router.post('/admin/dossiers/:id/douane', (ctx) => {
    const d = dossierOf(idParam(ctx.params.id));
    ctx.back = `/admin/dossiers/${d.id}`;
    const v = {
      declaration_number: text(ctx.form, 'declaration_number', { max: 50, label: 'N° de déclaration' }),
      declaration_on: day(ctx.form, 'declaration_on', { label: 'Date de la déclaration' }),
      circuit: oneOf(ctx.form, 'circuit', LABELS.circuit, { required: false, label: 'Circuit' }),
      visit_on: day(ctx.form, 'visit_on', { label: 'Date de visite' }),
      visit_place: text(ctx.form, 'visit_place', { max: 200, label: 'Lieu de visite' }),
      bae_on: day(ctx.form, 'bae_on', { label: 'Date du BAE' }),
    };
    if ((v.declaration_on && v.declaration_on > f.today()) || (v.bae_on && v.bae_on > f.today())) {
      throw new HttpError(400, 'Les dates de déclaration et de BAE ne peuvent pas être dans le futur.');
    }
    const parts = [];
    if ((v.declaration_number !== d.declaration_number || v.declaration_on !== d.declaration_on) && v.declaration_number) {
      parts.push(`Déclaration enregistrée sous le n° ${v.declaration_number}${v.declaration_on ? ` du ${f.date(v.declaration_on)}` : ''}`);
    }
    if (v.circuit !== d.circuit) {
      if (!d.circuit) parts.push(`Circuit attribué par la douane : ${LABELS.circuit[v.circuit]}`);
      else if (v.circuit) parts.push(`Circuit modifié par la douane : ${LABELS.circuit[d.circuit]} → ${LABELS.circuit[v.circuit]}`);
      else parts.push('Circuit de contrôle retiré');
    }
    if (v.visit_on !== d.visit_on || v.visit_place !== d.visit_place) {
      if (v.visit_on) parts.push(`Visite de la marchandise prévue le ${f.date(v.visit_on)}${v.visit_place ? ` (${v.visit_place})` : ''}`);
      else if (d.visit_on) parts.push('Visite de la marchandise annulée');
    }
    if (v.bae_on !== d.bae_on && v.bae_on) parts.push(`Bon à enlever délivré le ${f.date(v.bae_on)}`);
    const changed = Object.keys(v).some((k) => (v[k] ?? null) !== (d[k] ?? null) && !(v[k] === '' && d[k] === ''));
    if (!changed) {
      flash(ctx, 'info', 'Aucune modification.');
      return redirect(ctx.res, ctx.back);
    }
    transaction(db, () => {
      db.prepare(
        `UPDATE dossiers SET declaration_number = ?, declaration_on = ?, circuit = ?, visit_on = ?, visit_place = ?, bae_on = ?, updated_at = ?
         WHERE id = ?`,
      ).run(v.declaration_number, v.declaration_on, v.circuit, v.visit_on, v.visit_place, v.bae_on, nowIso(), d.id);
      logEvent(d.client_id, d.id, ctx.user.id, parts.length ? parts.join('. ') : 'Informations douanières mises à jour');
    });
    flash(ctx, 'success', 'Informations douanières enregistrées.');
    redirect(ctx.res, ctx.back);
  });

  router.post('/admin/dossiers/:id/droits', (ctx) => {
    const d = dossierOf(idParam(ctx.params.id));
    ctx.back = `/admin/dossiers/${d.id}`;
    const v = {
      duties_minor: money(ctx.form, 'duties_amount', f, { label: 'Montant des droits et taxes' }),
      duties_payer: oneOf(ctx.form, 'duties_payer', PAYERS, { required: false, label: 'Payé par' }),
      duties_due_on: day(ctx.form, 'duties_due_on', { label: 'À payer avant le' }),
      duties_paid_on: day(ctx.form, 'duties_paid_on', { label: 'Payés le' }),
      duties_receipt: text(ctx.form, 'duties_receipt', { max: 100, label: 'N° de quittance' }),
    };
    if (v.duties_minor > 0 && !v.duties_payer) throw new HttpError(400, 'Indiquez qui paie les droits et taxes.');
    if (v.duties_minor === 0) Object.assign(v, { duties_payer: null, duties_due_on: null });
    if (v.duties_paid_on && v.duties_minor === null) throw new HttpError(400, 'Indiquez le montant des droits et taxes payés.');
    if (v.duties_paid_on && v.duties_paid_on > f.today()) throw new HttpError(400, 'La date de paiement ne peut pas être dans le futur.');
    const parts = [];
    if (v.duties_minor !== d.duties_minor || v.duties_payer !== d.duties_payer || v.duties_due_on !== d.duties_due_on) {
      if (v.duties_minor === 0) {
        parts.push('Aucun droit ni taxe à payer pour ce dossier');
      } else if (v.duties_minor !== null) {
        const who = v.duties_payer === 'client'
          ? `à payer par vous${v.duties_due_on ? ` avant le ${f.date(v.duties_due_on)}` : ''}`
          : 'avancés par le cabinet pour votre compte';
        parts.push(`Droits et taxes liquidés : ${f.money(v.duties_minor)}, ${who}`);
      } else if (d.duties_minor !== null) {
        parts.push('Montant des droits et taxes retiré');
      }
    }
    if (v.duties_paid_on && (v.duties_paid_on !== d.duties_paid_on || v.duties_receipt !== d.duties_receipt)) {
      parts.push(`Droits et taxes payés le ${f.date(v.duties_paid_on)}${v.duties_receipt ? ` (quittance n° ${v.duties_receipt})` : ''}`);
    }
    const changed = Object.keys(v).some((k) => (v[k] ?? null) !== (d[k] ?? null) && !(v[k] === '' && d[k] === ''));
    if (!changed) {
      flash(ctx, 'info', 'Aucune modification.');
      return redirect(ctx.res, ctx.back);
    }
    transaction(db, () => {
      db.prepare(
        `UPDATE dossiers SET duties_minor = ?, duties_payer = ?, duties_due_on = ?, duties_paid_on = ?, duties_receipt = ?, updated_at = ?
         WHERE id = ?`,
      ).run(v.duties_minor, v.duties_payer, v.duties_due_on, v.duties_paid_on, v.duties_receipt, nowIso(), d.id);
      logEvent(d.client_id, d.id, ctx.user.id, parts.length ? parts.join('. ') : 'Informations sur les droits et taxes mises à jour');
    });
    flash(ctx, 'success', 'Droits et taxes enregistrés.');
    redirect(ctx.res, ctx.back);
  });

  router.post('/admin/dossiers/:id/controle-technique', (ctx) => {
    const d = dossierOf(idParam(ctx.params.id));
    ctx.back = `/admin/dossiers/${d.id}`;
    const status = oneOf(ctx.form, 'ct_status', LABELS.ct, { required: false, label: 'Contrôle technique' });
    const note = text(ctx.form, 'ct_note', { max: 500, label: 'Précision' });
    if (d.stage === 'termine' && ['depose', 'prelevement', 'ape'].includes(status)) {
      throw new HttpError(400, 'Le dossier est terminé : revenez d’abord à une étape précédente si le contrôle technique est encore en cours.');
    }
    if (status === d.ct_status && note === d.ct_note) {
      flash(ctx, 'info', 'Aucune modification.');
      return redirect(ctx.res, ctx.back);
    }
    const head = status ? `Contrôle technique : ${LABELS.ct[status]}` : 'Contrôle technique : non concerné';
    transaction(db, () => {
      db.prepare('UPDATE dossiers SET ct_status = ?, ct_note = ?, updated_at = ? WHERE id = ?').run(status, note, nowIso(), d.id);
      logEvent(d.client_id, d.id, ctx.user.id, [head, note].filter(Boolean).join('. '));
    });
    flash(ctx, 'success', 'Contrôle technique mis à jour.');
    redirect(ctx.res, ctx.back);
  });

  router.post('/admin/dossiers/:id/infos', (ctx) => {
    const d = dossierOf(idParam(ctx.params.id));
    ctx.back = `/admin/dossiers/${d.id}`;
    const direction = oneOf(ctx.form, 'direction', LABELS.direction, { label: 'Sens' });
    if (direction !== d.direction && hasStarted(d)) {
      throw new HttpError(400, "Le sens import/export ne peut plus changer une fois le dossier commencé.");
    }
    const { office, detail } = officeFor(ctx.form);
    const v = {
      reference: code(ctx.form, 'reference', { label: 'Référence' }),
      client_reference: text(ctx.form, 'client_reference', { max: 100 }),
      title: text(ctx.form, 'title', { required: true, label: 'Marchandise' }),
      description: text(ctx.form, 'description', { max: 5000 }),
      regime: regimeFor(ctx.form, direction),
      regime_code: text(ctx.form, 'regime_code', { max: 50 }),
      transport_mode: oneOf(ctx.form, 'transport_mode', LABELS.transport, { required: false, label: 'Transport' }),
      transport_doc: text(ctx.form, 'transport_doc', { max: 100 }),
      vessel: text(ctx.form, 'vessel', { max: 100 }),
      containers: text(ctx.form, 'containers', { max: 500 }),
      counterparty: text(ctx.form, 'counterparty', { max: 200 }),
      customs_office: office,
      customs_office_detail: detail,
      expected_on: day(ctx.form, 'expected_on', { label: 'Date prévue' }),
      manifest_ref: text(ctx.form, 'manifest_ref', { max: 100 }),
    };
    if (v.reference.toLowerCase() !== d.reference.toLowerCase()) assertReferenceFree(v.reference, d.id);

    // Fields the client sees, logged as "label : before → after". Internal fields are never logged.
    const shown = {
      reference: ['Référence', (x) => x.reference],
      client_reference: ['Votre référence', (x) => x.client_reference],
      title: ['Marchandise', (x) => x.title],
      regime: ['Régime', (x) => LABELS.regime[x.regime]],
      transport_mode: ['Transport', (x) => LABELS.transport[x.transport_mode]],
      transport_doc: ['Titre de transport', (x) => x.transport_doc],
      vessel: ['Navire ou vol', (x) => x.vessel],
      containers: ['Conteneurs', (x) => x.containers],
      counterparty: [direction === 'import' ? 'Fournisseur' : 'Acheteur', (x) => x.counterparty],
      customs_office: ['Bureau de douane', (x) => [LABELS.office[x.customs_office], x.customs_office_detail].filter(Boolean).join(' — ')],
      expected_on: [direction === 'import' ? 'Arrivée prévue' : 'Départ prévu', (x) => f.date(x.expected_on)],
    };
    const changes = [];
    if (direction !== d.direction) changes.push(`sens : ${LABELS.direction[d.direction]} → ${LABELS.direction[direction]}`);
    for (const [label, read] of Object.values(shown)) {
      const before = read(d) ?? '';
      const after = read(v) ?? '';
      if (before !== after) changes.push(`${label} : ${short(before)} → ${short(after)}`);
    }
    if (v.description !== d.description) changes.push('précisions modifiées');
    const internalChanged = v.regime_code !== d.regime_code || v.manifest_ref !== d.manifest_ref;
    if (!changes.length && !internalChanged) {
      flash(ctx, 'info', 'Aucune modification.');
      return redirect(ctx.res, ctx.back);
    }
    transaction(db, () => {
      db.prepare(
        `UPDATE dossiers SET direction = ?, reference = ?, client_reference = ?, title = ?, description = ?, regime = ?, regime_code = ?,
           transport_mode = ?, transport_doc = ?, vessel = ?, containers = ?, counterparty = ?, customs_office = ?,
           customs_office_detail = ?, expected_on = ?, manifest_ref = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        direction, v.reference, v.client_reference, v.title, v.description, v.regime, v.regime_code, v.transport_mode, v.transport_doc,
        v.vessel, v.containers, v.counterparty, v.customs_office, v.customs_office_detail, v.expected_on, v.manifest_ref, nowIso(), d.id,
      );
      if (direction !== d.direction) {
        // Drop untouched items that only concern the old direction, then add the new direction's required ones.
        for (const doc of q.dossierDocuments.all(d.id)) {
          const type = byKey(DOC_TYPES, doc.doc_type);
          if (type?.applies === d.direction && ['a_fournir', 'a_venir'].includes(doc.status)) {
            db.prepare('DELETE FROM dossier_documents WHERE id = ?').run(doc.id);
          }
        }
        seedDocuments(d.id, direction, new Set(q.dossierDocuments.all(d.id).map((doc) => doc.doc_type)));
      }
      if (changes.length) logEvent(d.client_id, d.id, ctx.user.id, `Informations mises à jour — ${changes.join(' ; ')}`);
    });
    flash(ctx, 'success', 'Informations enregistrées.');
    redirect(ctx.res, ctx.back);
  });

  router.post('/admin/dossiers/:id/message', (ctx) => {
    const d = dossierOf(idParam(ctx.params.id));
    ctx.back = `/admin/dossiers/${d.id}`;
    const message = text(ctx.form, 'message', { required: true, max: 2000, label: 'Message' });
    transaction(db, () => {
      touch(d.id);
      logEvent(d.client_id, d.id, ctx.user.id, message);
    });
    flash(ctx, 'success', 'Message ajouté à l’historique du client.');
    redirect(ctx.res, ctx.back);
  });

  // ---------- Documents ----------

  router.post('/admin/dossiers/:id/documents', (ctx) => {
    const d = dossierOf(idParam(ctx.params.id));
    ctx.back = `/admin/dossiers/${d.id}`;
    const type = byKey(DOC_TYPES, oneOf(ctx.form, 'doc_type', LABELS.docType, { label: 'Document' }));
    const customLabel = text(ctx.form, 'label', { max: 200, required: type.key === 'autre', label: 'Intitulé du document' });
    const label = customLabel || type.label;
    const responsible = oneOf(ctx.form, 'responsible', LABELS.responsible, { required: false, label: 'Fourni par' }) ?? type.responsible;
    const tiersName = responsible === 'tiers' ? text(ctx.form, 'tiers_name', { max: 100, label: 'Intervenant' }) : '';
    const dueOn = day(ctx.form, 'due_on', { label: 'À fournir avant le' });
    const note = text(ctx.form, 'note', { max: 500, label: 'Consigne' });
    const status = responsible === 'cabinet' ? 'a_venir' : 'a_fournir';
    const message =
      responsible === 'client'
        ? [`Document demandé : ${label}${dueOn ? `, avant le ${f.date(dueOn)}` : ''}`, note].filter(Boolean).join('. ')
        : responsible === 'tiers'
          ? `Document attendu${tiersName ? ` de ${tiersName}` : ' d’un autre intervenant'} : ${label}`
          : `Document que nous vous remettrons : ${label}`;
    transaction(db, () => {
      db.prepare(
        `INSERT INTO dossier_documents (dossier_id, doc_type, label, responsible, tiers_name, status, due_on, note, position, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(d.id, type.key, label, responsible, tiersName, status, dueOn, note, q.maxDocumentPosition.get(d.id).n + 1, nowIso());
      touch(d.id);
      logEvent(d.client_id, d.id, ctx.user.id, message);
    });
    flash(ctx, 'success', 'Document ajouté à la liste.');
    redirect(ctx.res, ctx.back);
  });

  router.post('/admin/documents/:id', (ctx) => {
    const doc = q.document.get(idParam(ctx.params.id));
    if (!doc) throw new HttpError(404, 'Document introuvable.');
    const d = dossierOf(doc.dossier_id);
    ctx.back = adminBack(ctx.form.back, `/admin/dossiers/${d.id}`);
    const allowed = Object.fromEntries(DOC_STATUS.filter((s) => s.for.includes(doc.responsible)).map((s) => [s.key, s.label]));
    if (ctx.form.prev_status && ctx.form.prev_status !== doc.status) {
      throw new HttpError(400, `« ${doc.label} » vient de changer d’état (${LABELS.docStatus[doc.status]}). Vérifiez puis recommencez.`);
    }
    const status = oneOf(ctx.form, 'status', allowed, { label: 'État' });
    // Fields a form does not send keep their stored value.
    const note = 'note' in ctx.form ? text(ctx.form, 'note', { max: 500, label: 'Consigne' }) : doc.note;
    const dueOn = 'due_on' in ctx.form ? day(ctx.form, 'due_on', { label: 'Échéance' }) : doc.due_on;
    if (status === 'a_corriger' && !note) throw new HttpError(400, 'Indiquez ce qu’il faut corriger : le client verra ce message.');
    if (status === doc.status && note === doc.note && dueOn === doc.due_on) {
      flash(ctx, 'info', 'Aucune modification.');
      return redirect(ctx.res, ctx.back);
    }
    const message =
      status !== doc.status
        ? `${DOC_STATUS_EVENTS[status]} : ${doc.label}${status === 'a_corriger' ? ` — ${note}` : ''}`
        : [`Document « ${doc.label} » : consigne mise à jour${dueOn ? `, à fournir avant le ${f.date(dueOn)}` : ''}`, note].filter(Boolean).join('. ');
    transaction(db, () => {
      db.prepare('UPDATE dossier_documents SET status = ?, note = ?, due_on = ?, updated_at = ? WHERE id = ?').run(status, note, dueOn, nowIso(), doc.id);
      touch(d.id);
      logEvent(d.client_id, d.id, ctx.user.id, message);
    });
    flash(ctx, 'success', `« ${doc.label} » : ${allowed[status]}.`);
    redirect(ctx.res, ctx.back);
  });

  // ---------- Tasks ----------

  router.post('/admin/clients/:id/taches', (ctx) => {
    const client = clientOf(idParam(ctx.params.id));
    ctx.back = adminBack(ctx.form.back, `/admin/clients/${client.id}`);
    const title = text(ctx.form, 'title', { required: true, label: 'Titre' });
    const description = text(ctx.form, 'description', { max: 5000 });
    const priority = oneOf(ctx.form, 'priority', LABELS.priority, { label: 'Priorité' });
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
    flash(ctx, 'success', 'Demande ajoutée pour le client.');
    redirect(ctx.res, ctx.back);
  });

  router.post('/admin/taches/:id', (ctx) => {
    const task = q.task.get(idParam(ctx.params.id));
    if (!task) throw new HttpError(404, 'Tâche introuvable.');
    const status = oneOf(ctx.form, 'status', LABELS.taskStatus, { label: 'État' });
    if (status !== task.status) {
      transaction(db, () => {
        db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), task.id);
        logEvent(task.client_id, task.dossier_id, ctx.user.id, `Tâche « ${task.title} » : ${LABELS.taskStatus[task.status]} → ${LABELS.taskStatus[status]}`);
      });
      flash(ctx, 'success', 'Tâche mise à jour.');
    }
    redirect(ctx.res, adminBack(ctx.form.back, `/admin/clients/${task.client_id}`));
  });

  // ---------- Invoices ----------

  /** Reads the invoice form, collecting every error so the form can be shown again with them. */
  function readInvoiceForm(form, client) {
    const errors = [];
    const attempt = (fn, fallback = null) => {
      try {
        return fn();
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        errors.push(error.message);
        return fallback;
      }
    };
    const number = attempt(() => code(form, 'number', { label: 'N° de facture' }), '');
    if (number && q.invoiceByNumber.get(number)) errors.push(`Le numéro « ${number} » est déjà utilisé.`);
    const label = attempt(() => text(form, 'label', { max: 200, label: 'Objet' }), '');
    const dossierId = attempt(() => dossierFor(form, client.id));
    const issuedOn = attempt(() => day(form, 'issued_on', { required: true, label: "Date d'émission" }));
    const dueOn = attempt(() => day(form, 'due_on', { required: true, label: 'Échéance' }));
    if (issuedOn && dueOn && dueOn < issuedOn) errors.push("L'échéance doit être postérieure à la date d'émission.");
    const stamp = attempt(() => money(form, 'stamp', f, { label: 'Timbre fiscal' })) ?? 0;
    const legalNote = attempt(() => text(form, 'legal_note', { max: 300, label: 'Mention' }), '');

    const lines = [];
    for (let i = 1; i <= MAX_INVOICE_LINES; i++) {
      const p = `l${i}_`;
      if (!String(form[`${p}label`] ?? '').trim() && !String(form[`${p}amount`] ?? '').trim()) continue;
      const kind = attempt(() => oneOf(form, `${p}kind`, LABELS.lineKind, { label: `Ligne ${i} : type` }));
      const lineLabel = attempt(() => text(form, `${p}label`, { required: true, max: 200, label: `Ligne ${i} : libellé` }), '');
      const amount = attempt(() => money(form, `${p}amount`, f, { required: true, label: `Ligne ${i} : montant` }));
      const taxable = kind && byKey(LINE_KINDS, kind).taxable;
      const vat = taxable ? attempt(() => oneOf(form, `${p}vat`, LABELS.vat, { label: `Ligne ${i} : TVA` })) : null;
      const category = kind === 'debours' ? attempt(() => oneOf(form, `${p}category`, LABELS.debours, { label: `Ligne ${i} : nature du débours` })) : null;
      const receipt = kind === 'debours'
        ? attempt(() => text(form, `${p}receipt`, { required: true, max: 100, label: `Ligne ${i} : justificatif (quittance, facture du tiers)` }), '')
        : '';
      if (kind && amount !== null) {
        lines.push({ position: i, kind, label: lineLabel, amount_minor: amount, vat_rate_bp: vat === null ? null : Number(vat), category, receipt_ref: receipt });
      }
    }
    if (!lines.length && !errors.length) errors.push('Ajoutez au moins une ligne.');

    const available = q.availableProvisions.all(client.id);
    const provisions = available.filter((p) => checkbox(form, `deduct_${p.id}`));
    for (const key of Object.keys(form)) {
      const m = /^deduct_(\d+)$/.exec(key);
      if (!m || !checkbox(form, key) || available.some((p) => p.id === Number(m[1]))) continue;
      const gone = q.invoice.get(Number(m[1]));
      errors.push(gone && gone.client_id === client.id
        ? `La provision n° ${gone.number} n'est plus disponible (déjà déduite, annulée ou pas encore payée). Vérifiez les provisions à déduire.`
        : 'Une provision cochée n’existe pas pour ce client.');
    }
    const deductionMinor = provisions.reduce((sum, p) => sum + p.amount_minor, 0);
    let totals = null;
    try {
      totals = computeInvoiceTotals(lines, stamp, deductionMinor);
      if (totals.net_minor < 0) {
        errors.push(`Les provisions déduites (${f.money(deductionMinor)}) dépassent le total de la facture (${f.money(totals.gross_minor)}). Décochez une provision ; le trop-perçu se règle hors du portail.`);
      }
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      errors.push('Les montants sont trop élevés.');
      totals = null;
    }
    return { invoice: { number, label, dossierId, issuedOn, dueOn, stamp, legalNote }, lines, provisions, totals, errors };
  }

  function invoiceFormData(client, values, extra = {}) {
    return {
      client,
      dossiers: q.clientDossiers.all(client.id),
      provisions: q.availableProvisions.all(client.id),
      values,
      maxLines: MAX_INVOICE_LINES,
      ...extra,
    };
  }

  router.get('/admin/clients/:id/factures/nouvelle', (ctx) => {
    const client = clientOf(idParam(ctx.params.id));
    const dossierId = ctx.query.get('dossier') ?? '';
    render(ctx, 'adminInvoiceFormPage', invoiceFormData(client, {
      dossier_id: dossierId,
      issued_on: f.today(),
      due_on: f.dayFromToday(30),
      stamp: f.moneyInput(DEFAULT_STAMP_MINOR),
      l1_kind: 'honoraires',
      l1_vat: '1900',
      l1_label: 'Honoraires de dédouanement',
    }));
  });

  router.post('/admin/clients/:id/factures', (ctx) => {
    const client = clientOf(idParam(ctx.params.id));
    const parsed = readInvoiceForm(ctx.form, client);
    const { invoice, lines, provisions, totals, errors } = parsed;
    if (ctx.form.action !== 'emettre' || errors.length) {
      return render(ctx, 'adminInvoiceFormPage', invoiceFormData(client, ctx.form, { totals, errors, preview: true }), errors.length ? 400 : 200);
    }
    const id = transaction(db, () => {
      const paid = totals.net_minor === 0;
      const result = db
        .prepare(
          `INSERT INTO invoices (client_id, dossier_id, kind, number, label, amount_minor, stamp_minor, legal_note, issued_on, due_on, status, paid_on, created_at)
           VALUES (?, ?, 'facture', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(client.id, invoice.dossierId, invoice.number, invoice.label, totals.net_minor, invoice.stamp, invoice.legalNote,
          invoice.issuedOn, invoice.dueOn, paid ? 'payee' : 'a_payer', paid ? f.today() : null, nowIso());
      const invoiceId = Number(result.lastInsertRowid);
      const insertLine = db.prepare(
        `INSERT INTO invoice_lines (invoice_id, position, kind, category, label, amount_minor, vat_rate_bp, receipt_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const line of lines) {
        insertLine.run(invoiceId, line.position, line.kind, line.category, line.label, line.amount_minor, line.vat_rate_bp, line.receipt_ref);
      }
      for (const provision of provisions) {
        const changed = db
          .prepare("UPDATE invoices SET deducted_in = ? WHERE id = ? AND kind = 'provision' AND status = 'payee' AND deducted_in IS NULL")
          .run(invoiceId, provision.id).changes;
        if (Number(changed) !== 1) throw new HttpError(409, `La provision n° ${provision.number} vient d'être déduite ailleurs. Rechargez la page.`);
        db.prepare('INSERT INTO invoice_deductions (invoice_id, provision_id, provision_number, amount_minor) VALUES (?, ?, ?, ?)').run(
          invoiceId, provision.id, provision.number, provision.amount_minor,
        );
      }
      const summary = [
        totals.taxable_minor ? `prestations ${f.money(totals.taxable_minor)} HT` : '',
        totals.debours_minor ? `débours ${f.money(totals.debours_minor)}` : '',
        totals.deduction_minor ? `provision déduite ${f.money(totals.deduction_minor)}` : '',
      ].filter(Boolean).join(', ');
      logEvent(client.id, invoice.dossierId, ctx.user.id, paid
        ? `Facture n° ${invoice.number} émise et réglée par les provisions déduites (${summary})`
        : `Facture n° ${invoice.number} émise : ${f.money(totals.net_minor)} à payer${summary ? ` (${summary})` : ''}, échéance le ${f.date(invoice.dueOn)}`);
      return invoiceId;
    });
    flash(ctx, 'success', `Facture ${invoice.number} émise.`);
    redirect(ctx.res, `/admin/factures/${id}`);
  });

  router.post('/admin/clients/:id/provisions', (ctx) => {
    const client = clientOf(idParam(ctx.params.id));
    ctx.back = `/admin/clients/${client.id}/factures/nouvelle`;
    const number = code(ctx.form, 'number', { label: 'N° de la demande' });
    if (q.invoiceByNumber.get(number)) throw new HttpError(400, `Le numéro « ${number} » est déjà utilisé.`);
    const label = text(ctx.form, 'label', { max: 200, label: 'Objet' }) || 'Provision pour droits, taxes et frais';
    const dossierId = dossierFor(ctx.form, client.id);
    if (dossierId) ctx.back += `?dossier=${dossierId}`;
    const amount = money(ctx.form, 'amount', f, { required: true, label: 'Montant' });
    if (!amount) throw new HttpError(400, 'Le montant doit être supérieur à zéro.');
    const dueOn = day(ctx.form, 'due_on', { required: true, label: 'À régler avant le' });
    const issuedOn = f.today();
    if (dueOn < issuedOn) throw new HttpError(400, "L'échéance ne peut pas être passée.");
    const id = transaction(db, () => {
      const result = db
        .prepare(
          `INSERT INTO invoices (client_id, dossier_id, kind, number, label, amount_minor, issued_on, due_on, status, created_at)
           VALUES (?, ?, 'provision', ?, ?, ?, ?, ?, 'a_payer', ?)`,
        )
        .run(client.id, dossierId, number, label, amount, issuedOn, dueOn, nowIso());
      logEvent(client.id, dossierId, ctx.user.id, `Demande de provision n° ${number} de ${f.money(amount)}, à régler avant le ${f.date(dueOn)}`);
      return Number(result.lastInsertRowid);
    });
    flash(ctx, 'success', `Demande de provision ${number} envoyée au client.`);
    redirect(ctx.res, `/admin/factures/${id}`);
  });

  router.get('/admin/factures/:id', (ctx) => {
    const invoice = q.invoice.get(idParam(ctx.params.id));
    if (!invoice) throw new HttpError(404, 'Facture introuvable.');
    const detail = invoiceDetail(q, invoice);
    render(ctx, 'invoicePage', { ...detail, client: q.userById.get(invoice.client_id) });
  });

  router.post('/admin/factures/:id', (ctx) => {
    const invoice = q.invoice.get(idParam(ctx.params.id));
    if (!invoice) throw new HttpError(404, 'Facture introuvable.');
    ctx.back = `/admin/factures/${invoice.id}`;
    const status = oneOf(ctx.form, 'status', LABELS.invoiceStatus, { label: 'État' });
    const kindLabel = invoice.kind === 'provision' ? 'Demande de provision' : 'Facture';
    if (status === invoice.status) {
      const paidOn = status === 'payee' ? day(ctx.form, 'paid_on', { label: 'Payée le' }) : null;
      if (!paidOn || paidOn === invoice.paid_on) {
        flash(ctx, 'info', 'Aucune modification.');
        return redirect(ctx.res, ctx.back);
      }
      if (paidOn > f.today()) throw new HttpError(400, 'La date de paiement ne peut pas être dans le futur.');
      transaction(db, () => {
        db.prepare('UPDATE invoices SET paid_on = ? WHERE id = ?').run(paidOn, invoice.id);
        logEvent(invoice.client_id, invoice.dossier_id, ctx.user.id, `${kindLabel} n° ${invoice.number} : date de paiement corrigée au ${f.date(paidOn)}`);
      });
      flash(ctx, 'success', 'Date de paiement corrigée.');
      return redirect(ctx.res, ctx.back);
    }
    if (invoice.status === 'annulee') throw new HttpError(400, 'Une facture annulée ne peut plus changer : émettez-en une nouvelle.');
    if (invoice.deducted_in) {
      const used = q.invoice.get(invoice.deducted_in);
      throw new HttpError(400, `Cette provision a été déduite sur la facture n° ${used?.number ?? invoice.deducted_in} : annulez d'abord cette facture.`);
    }
    const paidOn = status === 'payee' ? day(ctx.form, 'paid_on', { label: 'Payée le' }) ?? f.today() : null;
    if (paidOn && paidOn > f.today()) throw new HttpError(400, 'La date de paiement ne peut pas être dans le futur.');
    transaction(db, () => {
      db.prepare('UPDATE invoices SET status = ?, paid_on = ? WHERE id = ?').run(status, paidOn, invoice.id);
      if (status === 'annulee') db.prepare('UPDATE invoices SET deducted_in = NULL WHERE deducted_in = ?').run(invoice.id);
      const suffix = status === 'payee' ? ` le ${f.date(paidOn)}` : '';
      logEvent(invoice.client_id, invoice.dossier_id, ctx.user.id, `${kindLabel} n° ${invoice.number} : ${LABELS.invoiceStatus[status]}${suffix}`);
    });
    flash(ctx, 'success', `${kindLabel} ${invoice.number} : ${LABELS.invoiceStatus[status]}.`);
    redirect(ctx.res, ctx.back);
  });

}
