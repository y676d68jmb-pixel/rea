import { html } from './http.js';
import { DOSSIER_STATUS, PRIORITY, TASK_STATUS, INVOICE_STATUS, invoiceStatus } from './format.js';

// ---------- Building blocks ----------

const csrfField = (csrf) => html`<input type="hidden" name="_csrf" value="${csrf}">`;

const badge = (key, label) => html`<span class="badge badge-${key}">${label}</span>`;

function select(name, options, selected, { required = true, empty } = {}) {
  return html`<select name="${name}" ${required ? html`required` : ''}>
    ${empty !== undefined ? html`<option value="">${empty}</option>` : ''}
    ${Object.entries(options).map(
      ([value, label]) => html`<option value="${value}" ${String(value) === String(selected) ? html`selected` : ''}>${label}</option>`,
    )}
  </select>`;
}

const progressBar = (value) =>
  html`<div class="progress"><progress max="100" value="${value}">${value} %</progress><span>${value} %</span></div>`;

const empty = (text) => html`<p class="empty">${text}</p>`;

function dossierOptions(dossiers) {
  return Object.fromEntries(dossiers.map((d) => [d.id, `${d.reference} — ${d.title}`]));
}

export function layout(ctx, title, body) {
  const { user, csrf, flash } = ctx;
  const nav = !user
    ? ''
    : user.role === 'admin'
      ? html`<a href="/admin">Clients</a><a href="/admin/taches">Tâches</a>`
      : html`<a href="/espace">Tableau de bord</a><a href="/espace/factures">Factures</a><a href="/espace/taches">Tâches</a><a href="/espace/historique">Historique</a>`;

  return html`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · ${ctx.siteName}</title>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/">${ctx.siteName}</a>
    ${user
      ? html`<nav>${nav}<a href="/mot-de-passe">Mot de passe</a>
        <form method="post" action="/deconnexion" class="inline">${csrfField(csrf)}<button class="link">Déconnexion</button></form></nav>`
      : ''}
  </header>
  <main>
    ${user ? html`<p class="whoami">Connecté : <strong>${user.name}</strong> (${user.login})</p>` : ''}
    ${(flash ?? []).map((f) => html`<div class="flash flash-${f.type}">${f.text}</div>`)}
    ${body}
  </main>
</body>
</html>`;
}

// ---------- Public pages ----------

export function loginPage(ctx, { error, login = '' } = {}) {
  return layout(
    ctx,
    'Connexion',
    html`<section class="card narrow">
      <h1>Espace client</h1>
      <p>Connectez-vous avec l'identifiant et le mot de passe fournis par le cabinet.</p>
      ${error ? html`<div class="flash flash-error">${error}</div>` : ''}
      <form method="post" action="/connexion" class="stack">
        <label>Identifiant<input name="login" value="${login}" autocomplete="username" required autofocus></label>
        <label>Mot de passe<input type="password" name="password" autocomplete="current-password" required></label>
        <button>Se connecter</button>
      </form>
    </section>`,
  );
}

export function changePasswordPage(ctx, { error } = {}) {
  return layout(
    ctx,
    'Mot de passe',
    html`<section class="card narrow">
      <h1>Changer de mot de passe</h1>
      ${ctx.user.must_change_password ? html`<p>Pour votre sécurité, choisissez un nouveau mot de passe avant de continuer.</p>` : ''}
      ${error ? html`<div class="flash flash-error">${error}</div>` : ''}
      <form method="post" action="/mot-de-passe" class="stack">
        ${csrfField(ctx.csrf)}
        <label>Mot de passe actuel<input type="password" name="current" autocomplete="current-password" required></label>
        <label>Nouveau mot de passe (10 caractères minimum)<input type="password" name="next" minlength="10" autocomplete="new-password" required></label>
        <label>Confirmer<input type="password" name="confirm" minlength="10" autocomplete="new-password" required></label>
        <button>Enregistrer</button>
      </form>
    </section>`,
  );
}

export function errorPage(ctx, status, message) {
  return layout(ctx, `Erreur ${status}`, html`<section class="card narrow"><h1>Erreur ${status}</h1><p>${message}</p><p><a href="/">Retour à l'accueil</a></p></section>`);
}

// ---------- Shared tables ----------

function timeline(ctx, events, { showDossier = false } = {}) {
  if (!events.length) return empty('Aucun événement pour le moment.');
  return html`<ol class="timeline">
    ${events.map(
      (e) => html`<li>
        <time>${ctx.f.dateTime(e.created_at)}</time>
        <div>${showDossier && e.reference ? html`<strong>${e.reference}</strong> · ` : ''}${e.message}
        ${e.actor_name ? html`<span class="muted"> — ${e.actor_name}</span>` : ''}</div>
      </li>`,
    )}
  </ol>`;
}

function invoiceTable(ctx, invoices, { admin = false } = {}) {
  if (!invoices.length) return empty('Aucune facture.');
  const today = ctx.f.today();
  return html`<div class="table-wrap"><table>
    <thead><tr><th>N°</th><th>Objet</th><th>Dossier</th><th>Émise le</th><th>Échéance</th><th class="num">Montant</th><th>État</th>${admin ? html`<th>Modifier</th>` : ''}</tr></thead>
    <tbody>
    ${invoices.map((inv) => {
      const st = invoiceStatus(inv, today);
      return html`<tr>
        <td>${inv.number}</td><td>${inv.label}</td><td>${inv.reference ?? '—'}</td>
        <td>${ctx.f.date(inv.issued_on)}</td><td>${ctx.f.date(inv.due_on)}</td>
        <td class="num">${ctx.f.money(inv.amount_minor)}</td>
        <td>${badge(st.key, st.label)}${inv.paid_on ? html`<br><small class="muted">le ${ctx.f.date(inv.paid_on)}</small>` : ''}</td>
        ${admin
          ? html`<td><form method="post" action="/admin/factures/${inv.id}" class="row">${csrfField(ctx.csrf)}
              ${select('status', INVOICE_STATUS, inv.status)}<button class="small">OK</button></form></td>`
          : ''}
      </tr>`;
    })}
    </tbody></table></div>`;
}

function taskList(ctx, tasks, { admin = false, clientCanComplete = false } = {}) {
  if (!tasks.length) return empty('Aucune tâche.');
  return html`<ul class="tasks">
    ${tasks.map(
      (t) => html`<li class="task">
        <div class="task-head">
          <strong>${t.title}</strong>
          ${badge(t.status, TASK_STATUS[t.status])} ${badge(`prio-${t.priority}`, `Priorité ${PRIORITY[t.priority].toLowerCase()}`)}
        </div>
        ${t.description ? html`<p class="pre">${t.description}</p>` : ''}
        <small class="muted">
          ${admin && t.client_name ? html`${t.client_name} (${t.client_login}) · ` : ''}
          ${t.reference ? html`Dossier ${t.reference} · ` : ''}
          ${t.assignee === 'client' ? 'À faire par le client' : 'À traiter par le cabinet'} ·
          créée le ${ctx.f.dateTime(t.created_at)}${t.due_on ? html` · échéance ${ctx.f.date(t.due_on)}` : ''}
        </small>
        ${admin
          ? html`<form method="post" action="/admin/taches/${t.id}" class="row">${csrfField(ctx.csrf)}
              ${select('status', TASK_STATUS, t.status)}<button class="small">Mettre à jour</button></form>`
          : clientCanComplete && t.assignee === 'client' && (t.status === 'nouvelle' || t.status === 'en_cours')
            ? html`<form method="post" action="/espace/taches/${t.id}/terminer" class="row">${csrfField(ctx.csrf)}
                <button class="small">Marquer comme fait</button></form>`
            : ''}
      </li>`,
    )}
  </ul>`;
}

function dossierCards(dossiers, hrefFor) {
  if (!dossiers.length) return empty('Aucun dossier.');
  return html`<div class="grid">
    ${dossiers.map(
      (d) => html`<a class="card dossier" href="${hrefFor(d)}">
        <div class="muted">${d.reference}</div>
        <h3>${d.title}</h3>
        ${badge(d.status, DOSSIER_STATUS[d.status])}
        ${progressBar(d.progress)}
      </a>`,
    )}
  </div>`;
}

// ---------- Client pages ----------

export function clientDashboard(ctx, { dossiers, unpaidTotal, overdueCount, openTasks, events }) {
  const active = dossiers.filter((d) => d.status !== 'termine').length;
  return layout(
    ctx,
    'Tableau de bord',
    html`<h1>Bonjour ${ctx.user.name}</h1>
    <div class="stats">
      <div class="stat"><span>${active}</span>dossier(s) en cours</div>
      <div class="stat"><span>${ctx.f.money(unpaidTotal)}</span>à régler${overdueCount ? html` <em class="danger">(${overdueCount} en retard)</em>` : ''}</div>
      <div class="stat"><span>${openTasks}</span>tâche(s) ouverte(s)</div>
    </div>
    <h2>Mes dossiers</h2>
    ${dossierCards(dossiers, (d) => `/espace/dossiers/${d.id}`)}
    <h2>Dernières actualités</h2>
    ${timeline(ctx, events, { showDossier: true })}
    <p><a href="/espace/historique">Voir tout l'historique →</a></p>`,
  );
}

export function clientDossierPage(ctx, { dossier, events, tasks, invoices }) {
  return layout(
    ctx,
    dossier.reference,
    html`<p><a href="/espace">← Tableau de bord</a></p>
    <section class="card">
      <div class="muted">${dossier.reference}</div>
      <h1>${dossier.title}</h1>
      ${badge(dossier.status, DOSSIER_STATUS[dossier.status])}
      ${progressBar(dossier.progress)}
      ${dossier.description ? html`<p class="pre">${dossier.description}</p>` : ''}
      <small class="muted">Ouvert le ${ctx.f.dateTime(dossier.created_at)} · mis à jour le ${ctx.f.dateTime(dossier.updated_at)}</small>
    </section>
    <h2>Historique du dossier</h2>
    ${timeline(ctx, events)}
    <h2>Tâches liées</h2>
    ${taskList(ctx, tasks, { clientCanComplete: true })}
    <h2>Factures liées</h2>
    ${invoiceTable(ctx, invoices)}`,
  );
}

export function clientInvoicesPage(ctx, { invoices }) {
  return layout(ctx, 'Factures', html`<h1>Mes factures</h1>${invoiceTable(ctx, invoices)}`);
}

export function clientTasksPage(ctx, { tasks, dossiers }) {
  const forClient = tasks.filter((t) => t.assignee === 'client');
  const forFirm = tasks.filter((t) => t.assignee === 'cabinet');
  return layout(
    ctx,
    'Tâches',
    html`<h1>Tâches</h1>
    <section class="card">
      <h2>Déposer une nouvelle tâche</h2>
      <form method="post" action="/espace/taches" class="stack">
        ${csrfField(ctx.csrf)}
        <label>Titre<input name="title" maxlength="200" required></label>
        <label>Description<textarea name="description" rows="4" maxlength="5000"></textarea></label>
        <div class="row">
          <label>Dossier ${select('dossier_id', dossierOptions(dossiers), '', { required: false, empty: '— Aucun —' })}</label>
          <label>Priorité ${select('priority', PRIORITY, 'normale')}</label>
          <label>Échéance souhaitée<input type="date" name="due_on"></label>
        </div>
        <button>Envoyer au cabinet</button>
      </form>
    </section>
    <h2>À faire de votre côté</h2>
    ${taskList(ctx, forClient, { clientCanComplete: true })}
    <h2>Vos demandes au cabinet</h2>
    ${taskList(ctx, forFirm)}`,
  );
}

export function clientHistoryPage(ctx, { events }) {
  return layout(ctx, 'Historique', html`<h1>Historique de mes dossiers</h1>${timeline(ctx, events, { showDossier: true })}`);
}

// ---------- Admin pages ----------

export function adminHomePage(ctx, { clients }) {
  return layout(
    ctx,
    'Clients',
    html`<h1>Clients</h1>
    <section class="card">
      <h2>Nouveau client</h2>
      <p class="muted">Un identifiant (CL-xxxx) et un mot de passe provisoire sont générés automatiquement.</p>
      <form method="post" action="/admin/clients" class="stack">
        ${csrfField(ctx.csrf)}
        <div class="row">
          <label>Nom<input name="name" maxlength="200" required></label>
          <label>Société<input name="company" maxlength="200"></label>
        </div>
        <div class="row">
          <label>E-mail<input type="email" name="email" maxlength="200"></label>
          <label>Téléphone<input name="phone" maxlength="50"></label>
        </div>
        <button>Créer le client</button>
      </form>
    </section>
    ${!clients.length
      ? empty('Aucun client pour le moment.')
      : html`<div class="table-wrap"><table>
        <thead><tr><th>Identifiant</th><th>Nom</th><th>Société</th><th class="num">Dossiers actifs</th><th class="num">Tâches à traiter</th><th class="num">Reste à payer</th><th>Compte</th></tr></thead>
        <tbody>${clients.map(
          (c) => html`<tr>
            <td><a href="/admin/clients/${c.id}">${c.login}</a></td><td>${c.name}</td><td>${c.company}</td>
            <td class="num">${c.active_dossiers}</td><td class="num">${c.open_tasks}</td>
            <td class="num">${ctx.f.money(c.unpaid)}</td>
            <td>${c.active ? badge('payee', 'Actif') : badge('annulee', 'Désactivé')}</td>
          </tr>`,
        )}</tbody></table></div>`}`,
  );
}

export function adminClientPage(ctx, { client, dossiers, invoices, tasks, events }) {
  const today = ctx.f.today();
  return layout(
    ctx,
    client.name,
    html`<p><a href="/admin">← Clients</a></p>
    <section class="card">
      <h1>${client.name} <small class="muted">${client.login}</small></h1>
      <p>${client.company} ${client.email ? html` · <a href="mailto:${client.email}">${client.email}</a>` : ''} ${client.phone ? html` · ${client.phone}` : ''}</p>
      <div class="row">
        <form method="post" action="/admin/clients/${client.id}/mot-de-passe" class="inline">${csrfField(ctx.csrf)}
          <button class="secondary">Réinitialiser le mot de passe</button></form>
        <form method="post" action="/admin/clients/${client.id}/activation" class="inline">${csrfField(ctx.csrf)}
          <button class="secondary">${client.active ? 'Désactiver le compte' : 'Réactiver le compte'}</button></form>
      </div>
    </section>

    <h2>Dossiers</h2>
    ${!dossiers.length
      ? empty('Aucun dossier.')
      : dossiers.map(
          (d) => html`<section class="card">
          <div class="muted">${d.reference}</div>
          <h3>${d.title}</h3>
          ${badge(d.status, DOSSIER_STATUS[d.status])} ${progressBar(d.progress)}
          <form method="post" action="/admin/dossiers/${d.id}" class="stack">
            ${csrfField(ctx.csrf)}
            <div class="row">
              <label>État ${select('status', DOSSIER_STATUS, d.status)}</label>
              <label>Avancement (%)<input type="number" name="progress" min="0" max="100" value="${d.progress}" required></label>
            </div>
            <label>Message visible par le client (ajouté à l'historique)<textarea name="note" rows="2" maxlength="2000"></textarea></label>
            <button class="small">Mettre à jour le dossier</button>
          </form>
        </section>`,
        )}
    <details class="card">
      <summary>+ Nouveau dossier</summary>
      <form method="post" action="/admin/clients/${client.id}/dossiers" class="stack">
        ${csrfField(ctx.csrf)}
        <div class="row">
          <label>Référence<input name="reference" maxlength="50" required></label>
          <label>Titre<input name="title" maxlength="200" required></label>
        </div>
        <label>Description<textarea name="description" rows="3" maxlength="5000"></textarea></label>
        <div class="row">
          <label>État ${select('status', DOSSIER_STATUS, 'ouvert')}</label>
          <label>Avancement (%)<input type="number" name="progress" min="0" max="100" value="0" required></label>
        </div>
        <button>Créer le dossier</button>
      </form>
    </details>

    <h2>Factures</h2>
    ${invoiceTable(ctx, invoices, { admin: true })}
    <details class="card">
      <summary>+ Nouvelle facture</summary>
      <form method="post" action="/admin/clients/${client.id}/factures" class="stack">
        ${csrfField(ctx.csrf)}
        <div class="row">
          <label>Numéro<input name="number" maxlength="50" required></label>
          <label>Objet<input name="label" maxlength="200"></label>
          <label>Dossier ${select('dossier_id', dossierOptions(dossiers), '', { required: false, empty: '— Aucun —' })}</label>
        </div>
        <div class="row">
          <label>Montant (${ctx.f.currency})<input name="amount" inputmode="decimal" placeholder="1 250,000" required></label>
          <label>Date d'émission<input type="date" name="issued_on" value="${today}" required></label>
          <label>Échéance<input type="date" name="due_on" required></label>
        </div>
        <button>Ajouter la facture</button>
      </form>
    </details>

    <h2>Tâches</h2>
    ${taskList(ctx, tasks, { admin: true })}
    <details class="card">
      <summary>+ Demander quelque chose au client</summary>
      <form method="post" action="/admin/clients/${client.id}/taches" class="stack">
        ${csrfField(ctx.csrf)}
        <label>Titre<input name="title" maxlength="200" required placeholder="Ex. : Envoyer le relevé bancaire de mars"></label>
        <label>Description<textarea name="description" rows="3" maxlength="5000"></textarea></label>
        <div class="row">
          <label>Dossier ${select('dossier_id', dossierOptions(dossiers), '', { required: false, empty: '— Aucun —' })}</label>
          <label>Priorité ${select('priority', PRIORITY, 'normale')}</label>
          <label>Échéance<input type="date" name="due_on"></label>
        </div>
        <button>Ajouter la tâche</button>
      </form>
    </details>

    <h2>Historique</h2>
    ${timeline(ctx, events, { showDossier: true })}`,
  );
}

export function adminTasksPage(ctx, { tasks }) {
  return layout(ctx, 'Tâches', html`<h1>Tâches ouvertes</h1>${taskList(ctx, tasks, { admin: true })}`);
}
