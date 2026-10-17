/** Pages of the client area (/espace). Every read is scoped to the signed-in client. */
import { computeInvoiceTotals, isClosed, isOverdue, LABELS } from './format.js';
import { HttpError } from './http.js';
import { day, idParam, oneOf, text } from './validate.js';
import { transaction } from './db.js';

/** A redirect target inside the client area, or the fallback. */
export function clientBack(value, fallback) {
  return typeof value === 'string' && /^\/espace(\/[a-z0-9-]+)*$/.test(value) ? value : fallback;
}

export function registerClientRoutes({ db, q, f, router, flash, render, redirect, logEvent, nowIso }) {
  router.get('/espace', (ctx) => {
    const id = ctx.user.id;
    const dossiers = q.clientDossiers.all(id);
    const invoices = q.clientInvoices.all(id);
    const today = f.today();
    const unpaid = invoices.filter((i) => i.status === 'a_payer');
    render(ctx, 'clientDashboard', {
      todo: q.clientTodo(id, f),
      openDossiers: dossiers.filter((d) => !isClosed(d)),
      closedCount: dossiers.filter(isClosed).length,
      unpaidTotal: unpaid.reduce((sum, i) => sum + i.amount_minor, 0),
      overdueCount: unpaid.filter((i) => isOverdue(i, today)).length,
      events: q.clientEvents.all(id, 8),
    });
  });

  router.get('/espace/dossiers', (ctx) => {
    const dossiers = q.clientDossiers.all(ctx.user.id);
    render(ctx, 'clientDossiersPage', {
      openDossiers: dossiers.filter((d) => !isClosed(d)),
      closedDossiers: dossiers.filter(isClosed),
    });
  });

  router.get('/espace/dossiers/:id', (ctx) => {
    const dossier = q.clientDossier.get(idParam(ctx.params.id), ctx.user.id);
    if (!dossier) throw new HttpError(404, 'Dossier introuvable.');
    render(ctx, 'clientDossierPage', {
      dossier,
      stages: q.dossierStages.all(dossier.id),
      documents: q.dossierDocuments.all(dossier.id).filter((doc) => doc.status !== 'non_requis'),
      invoices: q.dossierInvoices.all(dossier.id),
      tasks: q.dossierTasks.all(dossier.id),
      events: q.dossierEvents.all(dossier.id),
    });
  });

  router.post('/espace/documents/:id/envoye', (ctx) => {
    const doc = q.clientSendableDocument.get(idParam(ctx.params.id), ctx.user.id);
    if (!doc) throw new HttpError(404, 'Document introuvable ou déjà traité.');
    const dossier = q.dossier.get(doc.dossier_id);
    transaction(db, () => {
      db.prepare("UPDATE dossier_documents SET status = 'envoye', updated_at = ? WHERE id = ?").run(nowIso(), doc.id);
      db.prepare('UPDATE dossiers SET updated_at = ? WHERE id = ?').run(nowIso(), dossier.id);
      logEvent(dossier.client_id, dossier.id, ctx.user.id, `Envoi signalé par le client : ${doc.label}`);
    });
    flash(ctx, 'success', `Merci ! Nous vérifions « ${doc.label} » dès réception.`);
    redirect(ctx.res, clientBack(ctx.form.back, `/espace/dossiers/${dossier.id}`));
  });

  router.get('/espace/a-faire', (ctx) => {
    const id = ctx.user.id;
    render(ctx, 'clientTodoPage', {
      todo: q.clientTodo(id, f),
      requests: q.clientTasks.all(id).filter((t) => t.assignee === 'cabinet'),
      dossiers: q.clientDossiers.all(id).filter((d) => !isClosed(d)),
    });
  });

  router.post('/espace/taches', (ctx) => {
    ctx.back = '/espace/a-faire';
    const clientId = ctx.user.id;
    const title = text(ctx.form, 'title', { required: true, label: 'Objet' });
    const description = text(ctx.form, 'description', { max: 5000 });
    const priority = oneOf(ctx.form, 'priority', LABELS.priority, { label: 'Priorité' });
    const dueOn = day(ctx.form, 'due_on', { label: 'Échéance' });
    let dossierId = null;
    if (ctx.form.dossier_id) {
      const dossier = q.clientDossier.get(idParam(String(ctx.form.dossier_id)), clientId);
      if (!dossier) throw new HttpError(400, 'Dossier invalide.');
      dossierId = dossier.id;
    }
    const at = nowIso();
    transaction(db, () => {
      db.prepare(
        `INSERT INTO tasks (client_id, dossier_id, assignee, title, description, priority, status, due_on, created_by, created_at, updated_at)
         VALUES (?, ?, 'cabinet', ?, ?, ?, 'nouvelle', ?, ?, ?, ?)`,
      ).run(clientId, dossierId, title, description, priority, dueOn, clientId, at, at);
      logEvent(clientId, dossierId, clientId, `Nouvelle demande au cabinet : « ${title} »`);
    });
    flash(ctx, 'success', 'Votre demande a bien été transmise au cabinet.');
    redirect(ctx.res, '/espace/a-faire');
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
    redirect(ctx.res, clientBack(ctx.form.back, '/espace/a-faire'));
  });

  router.get('/espace/factures', (ctx) => render(ctx, 'clientInvoicesPage', { invoices: q.clientInvoices.all(ctx.user.id) }));

  router.get('/espace/factures/:id', (ctx) => {
    const invoice = q.clientInvoice.get(idParam(ctx.params.id), ctx.user.id);
    if (!invoice) throw new HttpError(404, 'Facture introuvable.');
    render(ctx, 'invoicePage', invoiceDetail(q, invoice));
  });

  router.get('/espace/historique', (ctx) => render(ctx, 'clientHistoryPage', { events: q.clientEvents.all(ctx.user.id, 500) }));
}

/**
 * Lines, deducted provisions and totals of a stored invoice. Lines and deductions are fixed once issued,
 * so the totals shown always match the stored amount, even after a cancellation.
 */
export function invoiceDetail(q, invoice) {
  const lines = q.invoiceLines.all(invoice.id);
  const deductions = q.invoiceDeductions.all(invoice.id);
  const deductionMinor = deductions.reduce((sum, p) => sum + p.amount_minor, 0);
  const totals = lines.length ? computeInvoiceTotals(lines, invoice.stamp_minor, deductionMinor) : null;
  // A provision is only ever deducted on an invoice of the same client.
  const deductedIn = invoice.deducted_in ? q.invoice.get(invoice.deducted_in) : null;
  return { invoice, lines, deductions, totals, deductedIn };
}
