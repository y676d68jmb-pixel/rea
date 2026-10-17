import { SafeHtml, html } from './http.js';
import {
  CIRCUITS,
  CT_STATUS,
  CUSTOMS_OFFICES,
  DEBOURS_CATEGORIES,
  DIRECTIONS,
  DOC_CLIENT_TODO,
  DOC_STATUS,
  DOC_TYPES,
  HOLDS,
  LABELS,
  LINE_KINDS,
  PRIORITY,
  REGIMES,
  RESPONSIBLES,
  TASK_STATUS,
  TRANSPORT_MODES,
  VAT_RATES,
  WAITING,
  byKey,
  invoiceStatus,
  isClosed,
  progressOf,
  stageExplain,
  stagesFor,
  waitingOn,
} from './format.js';

// ---------- Building blocks ----------

const csrfField = (csrf) => html`<input type="hidden" name="_csrf" value="${csrf}">`;
const backField = (path) => html`<input type="hidden" name="back" value="${path}">`;
const badge = (group, key, label) => html`<span class="badge badge-${group} badge-${group}-${key}">${label}</span>`;
const dirBadge = (direction) => badge('dir', direction, LABELS.direction[direction]);
const empty = (text) => html`<p class="empty">${text}</p>`;
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

/** A <select> from an ordered list of {key, label} (or a label map). */
function selectInput(name, options, selected, { required = true, empty: emptyLabel, id } = {}) {
  const list = Array.isArray(options) ? options : Object.entries(options).map(([key, label]) => ({ key, label }));
  return html`<select name="${name}" ${id ? html`id="${id}"` : ''} ${required ? html`required` : ''}>
    ${emptyLabel !== undefined ? html`<option value="">${emptyLabel}</option>` : ''}
    ${list.map((o) => html`<option value="${o.key}" ${String(o.key) === String(selected ?? '') ? html`selected` : ''}>${o.label}</option>`)}
  </select>`;
}

// ---------- Icons (inline SVG, drawn with the text colour) ----------

const ICON_PATHS = {
  anchor: 'M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 7v14M5 13H3a9 9 0 0 0 18 0h-2M8 10.5h8',
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  todo: 'M9.5 6H20M9.5 12H20M9.5 18H20M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17',
  folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z',
  invoice: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4h4M12 7.5V12l3 2',
  users: 'M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 20v-1.5a4 4 0 0 0-3-3.85M15.5 4.15a3.5 3.5 0 0 1 0 6.7',
  inbox: 'M3 13h5l1.5 3h5L16 13h5M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z',
  ship: 'M2.5 16.5 4.5 20h15l2-3.5zM5 16.5V12h14v4.5M8 12V8h8v4M12 4v4',
  plane: 'M10.5 20.5 12 19l1.5 1.5v-4.2l7-2.8v-2.1l-7 1.6V6.5a1.5 1.5 0 0 0-3 0V13l-7-1.6v2.1l7 2.8z',
  truck: 'M2.5 6h11v10h-11zM13.5 9h4l3 3.5V16h-7M7 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM17 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  box: 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5l9 4.5 9-4.5M12 12v9',
  lock: 'M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
  logout: 'M14 4h4.5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H14M9.5 16.5 14 12 9.5 7.5M14 12H3.5',
  wallet: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H18v3.5M3 7.5V18a2 2 0 0 0 2 2h15.5V8.5H5.5A2.5 2.5 0 0 1 3 7.5zM16.5 14.25h.01',
  check: 'M5 12.5 9.5 17 19 7.5',
  arrow: 'M5 12h14M13 6l6 6-6 6',
};

function icon(name, cls = 'icon') {
  return new SafeHtml(`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICON_PATHS[name]}"/></svg>`);
}

const TRANSPORT_ICONS = { maritime: 'ship', aerien: 'plane', routier: 'truck' };
const transportIcon = (d) => icon(TRANSPORT_ICONS[d.transport_mode] ?? 'box');

/** The dossier's steps as a segmented bar, with "step x of n". */
function stageMeter(d) {
  if (d.hold === 'annule') return html`<p class="meter-caption"><span>Dossier annulé</span></p>`;
  const list = stagesFor(d.direction);
  const index = list.findIndex((s) => s.key === d.stage);
  const done = d.stage === 'termine';
  return html`<div class="meter" role="img" aria-label="Étape ${index + 1} sur ${list.length} : ${list[index]?.label ?? ''}">
      ${list.map((s, k) => html`<span class="seg${k < index || done ? ' seg-done' : k === index ? ' seg-current' : ''}"></span>`)}
    </div>
    <p class="meter-caption"><span>Étape ${index + 1} sur ${list.length}</span><span>${progressOf(d)} %</span></p>`;
}

/** Definition list of [label, value] rows; rows with an empty value are left out. */
function facts(rows) {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== '' && value !== false);
  if (!shown.length) return '';
  return html`<dl class="facts">${shown.map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}</dl>`;
}

function dossierOptions(dossiers) {
  return dossiers.map((d) => ({ key: d.id, label: `${d.reference} — ${d.title}` }));
}

function waitingLine(dossier) {
  const who = waitingOn(dossier, dossier.missing_docs ?? 0);
  return who ? html`<p class="waiting">En attente de : <strong>${WAITING[who]}</strong></p>` : '';
}

function holdBanner(dossier) {
  if (!dossier.hold) return '';
  const hold = byKey(HOLDS, dossier.hold);
  return html`<div class="banner banner-hold-${dossier.hold}" role="status">
    <strong>${hold.label}</strong>${dossier.hold_note ? html` — ${dossier.hold_note}` : ''}
    <small>${hold.explain}</small>
  </div>`;
}

function ctBanner(dossier) {
  if (dossier.ct_status === 'ape') {
    return html`<div class="banner banner-warn" role="status"><strong>Ne vendez pas cette marchandise avant l'accord définitif du contrôle technique (AMC).</strong>
      <small>${byKey(CT_STATUS, 'ape').explain}</small></div>`;
  }
  if (dossier.ct_status === 'refus') {
    return html`<div class="banner banner-danger" role="status"><strong>Contrôle technique défavorable.</strong>
      <small>${byKey(CT_STATUS, 'refus').explain}</small></div>`;
  }
  return '';
}

function stepper(ctx, dossier, stageRows) {
  const list = stagesFor(dossier.direction);
  const current = list.findIndex((s) => s.key === dossier.stage);
  const dates = new Map(stageRows.map((r) => [r.stage, r.entered_on]));
  return html`<ol class="steps">
    ${list.map((s, i) => {
      const state = i < current ? 'done' : i === current ? 'current' : 'todo';
      const date = i <= current ? dates.get(s.key) : null;
      return html`<li class="step step-${state}" ${state === 'current' ? html`aria-current="step"` : ''}>
        <span class="step-label">${s.label}</span>
        ${date ? html`<span class="step-date">${ctx.f.date(date)}</span>` : ''}
      </li>`;
    })}
  </ol>`;
}

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
  const base = admin ? '/admin/factures' : '/espace/factures';
  return html`<div class="table-wrap"><table class="responsive">
    <thead><tr><th>N°</th><th>Type</th><th>Objet</th><th>Dossier</th><th>Échéance</th><th class="num">Montant</th><th>État</th></tr></thead>
    <tbody>
    ${invoices.map((inv) => {
      const st = invoiceStatus(inv, today);
      return html`<tr>
        <td data-label="N°"><a href="${base}/${inv.id}">${inv.number}</a></td>
        <td data-label="Type">${LABELS.invoiceKind[inv.kind]}</td>
        <td data-label="Objet">${inv.label}</td><td data-label="Dossier">${inv.reference ?? '—'}</td>
        <td data-label="Échéance">${ctx.f.date(inv.due_on)}</td>
        <td data-label="Montant" class="num">${ctx.f.money(inv.amount_minor)}</td>
        <td data-label="État">${badge('inv', st.key, st.label)}${inv.deducted_in ? html`<br><small class="muted">déduite d'une facture</small>` : ''}</td>
      </tr>`;
    })}
    </tbody></table></div>`;
}

function taskList(ctx, tasks, { admin = false, back = '' } = {}) {
  if (!tasks.length) return empty('Aucune demande.');
  return html`<ul class="tasks">
    ${tasks.map(
      (t) => html`<li class="task">
        <div class="task-head">
          <strong>${t.title}</strong>
          ${badge('task', t.status, LABELS.taskStatus[t.status])}
          ${t.priority === 'haute' ? badge('prio', 'haute', 'Priorité haute') : ''}
        </div>
        ${t.description ? html`<p class="pre">${t.description}</p>` : ''}
        <small class="muted">
          ${admin && t.client_name ? html`${t.client_name} (${t.client_login}) · ` : ''}
          ${t.reference ? html`Dossier ${t.reference} · ` : ''}
          ${t.assignee === 'client' ? 'À faire par le client' : 'À traiter par le cabinet'} ·
          créée le ${ctx.f.dateTime(t.created_at)}${t.due_on ? html` · échéance ${ctx.f.date(t.due_on)}` : ''}
        </small>
        ${admin
          ? html`<form method="post" action="/admin/taches/${t.id}" class="row">${csrfField(ctx.csrf)}${back ? backField(back) : ''}
              ${selectInput('status', TASK_STATUS, t.status)}<button class="small">Mettre à jour</button></form>`
          : ''}
      </li>`,
    )}
  </ul>`;
}

function dueText(ctx, due) {
  if (!due) return '';
  const late = due < ctx.f.today();
  return html`<span class="${late ? 'late' : ''}">${late ? `en retard (échéance ${ctx.f.date(due)})` : `avant le ${ctx.f.date(due)}`}</span>`;
}

function sendButton(ctx, docId, back) {
  return html`<form method="post" action="/espace/documents/${docId}/envoye" class="inline-action">${csrfField(ctx.csrf)}${backField(back)}
    <button class="small">Je l'ai envoyé</button></form>`;
}

/** The client's to-do items (documents, requests, invoices, duties), most urgent first. */
function todoList(ctx, items, back) {
  if (!items.length) return empty('Rien à faire pour le moment.');
  return html`<ul class="todo">
    ${items.map((item) => {
      const dossierLink = item.reference ? html`<a href="/espace/dossiers/${item.dossier_id}">${item.reference}</a>` : '';
      let title;
      let detail = '';
      let action = '';
      switch (item.kind) {
        case 'document':
          title = item.status === 'a_corriger' ? html`Document à corriger : <strong>${item.label}</strong>` : html`Document à fournir : <strong>${item.label}</strong>`;
          detail = item.note ? html`<p class="${item.status === 'a_corriger' ? 'late' : 'muted'}">${item.note}</p>` : '';
          action = sendButton(ctx, item.id, back);
          break;
        case 'task':
          title = html`Demande du cabinet : <strong>${item.title}</strong>`;
          detail = item.description ? html`<p class="pre muted">${item.description}</p>` : '';
          action = html`<form method="post" action="/espace/taches/${item.id}/terminer" class="inline-action">${csrfField(ctx.csrf)}${backField(back)}
            <button class="small">Marquer comme fait</button></form>`;
          break;
        case 'hold':
          title = html`${item.hold === 'attente_paiement' ? 'Paiement attendu' : 'Votre réponse est attendue'} : <strong>${item.hold_note}</strong>`;
          detail = html`<p class="muted">Le dossier est arrêté tant que ce point n'est pas réglé.</p>`;
          action = html`<a class="button small secondary" href="/espace/dossiers/${item.dossier_id}">Voir le dossier</a>`;
          break;
        case 'invoice':
          title = html`${item.invoice_kind === 'provision' ? 'Provision' : 'Facture'} n° ${item.number} à régler : <strong>${ctx.f.money(item.amount_minor)}</strong>`;
          action = html`<a class="button small secondary" href="/espace/factures/${item.id}">Voir</a>`;
          break;
        default:
          title = html`Droits et taxes à payer à la douane : <strong>${ctx.f.money(item.duties_minor)}</strong>`;
          detail = html`<p class="muted">Payez-les ou transmettez-nous la preuve de paiement : la douane ne délivre pas le bon à enlever avant.</p>`;
      }
      return html`<li class="todo-item">
        <div class="todo-main">
          <div>${title}</div>
          <small class="muted">${dossierLink}${dossierLink && item.due_on ? ' · ' : ''}${dueText(ctx, item.due_on)}</small>
          ${detail}
        </div>
        ${action}
      </li>`;
    })}
  </ul>
  ${items.some((i) => i.kind === 'document') ? html`<p class="hint">${ctx.documentsHint}</p>` : ''}`;
}

function dossierStatusLine(dossier) {
  if (dossier.hold) {
    return html`<p class="status">${badge('hold', dossier.hold, LABELS.hold[dossier.hold])}${dossier.hold_note ? html` ${dossier.hold_note}` : ''}</p>`;
  }
  if (dossier.missing_docs > 0) return html`<p class="status status-todo">${plural(dossier.missing_docs, 'document à fournir', 'documents à fournir')}</p>`;
  return waitingLine(dossier);
}

function dossierCards(ctx, dossiers, hrefFor) {
  if (!dossiers.length) return empty('Aucun dossier en cours.');
  return html`<div class="grid">
    ${dossiers.map(
      (d) => html`<a class="card dossier" href="${hrefFor(d)}">
        <div class="card-head">
          <span class="transport">${transportIcon(d)}</span>
          <span class="ref">${d.reference}</span>${dirBadge(d.direction)}
        </div>
        <h3>${d.title}</h3>
        <p class="stage-name">${LABELS.stage[d.stage]}</p>
        ${stageMeter(d)}
        ${dossierStatusLine(d)}
        <small class="muted">Mis à jour le ${ctx.f.dateTime(d.updated_at)}</small>
      </a>`,
    )}
  </div>`;
}

function officeText(d) {
  if (!d.customs_office) return '';
  return [LABELS.office[d.customs_office], d.customs_office_detail].filter(Boolean).join(' — ');
}

function customsFacts(ctx, d) {
  const circuit = d.circuit ? byKey(CIRCUITS, d.circuit) : null;
  const ct = d.ct_status ? byKey(CT_STATUS, d.ct_status) : null;
  const duties = d.duties_minor !== null && d.duties_minor !== undefined
    ? html`${ctx.f.money(d.duties_minor)} — ${d.duties_payer === 'client' ? 'à payer par vous' : 'avancés par le cabinet pour votre compte'}${
        d.duties_paid_on
          ? html`<br><span class="ok">Payés le ${ctx.f.date(d.duties_paid_on)}${d.duties_receipt ? ` (quittance n° ${d.duties_receipt})` : ''}</span>`
          : d.duties_due_on ? html`<br>${dueText(ctx, d.duties_due_on)}` : ''}`
    : '';
  return facts([
    ['Déclaration en douane', d.declaration_number ? `n° ${d.declaration_number}${d.declaration_on ? ` du ${ctx.f.date(d.declaration_on)}` : ''}` : ''],
    ['Circuit de contrôle', circuit ? html`${badge('circuit', circuit.key, circuit.label)}<br><small>${circuit.explain}</small>` : ''],
    ['Visite de la marchandise', d.visit_on ? `${ctx.f.date(d.visit_on)}${d.visit_place ? ` — ${d.visit_place}` : ''}` : ''],
    ['Contrôle technique', ct ? html`${badge('ct', ct.key, ct.label)}<br><small>${d.ct_note || ct.explain}</small>` : ''],
    ['Droits et taxes', duties],
    ['Bon à enlever', d.bae_on ? `délivré le ${ctx.f.date(d.bae_on)}` : ''],
  ]);
}

function infoFacts(ctx, d, { admin = false } = {}) {
  const mode = d.transport_mode ? byKey(TRANSPORT_MODES, d.transport_mode) : null;
  return facts([
    ['Votre référence', admin ? '' : d.client_reference],
    ['Référence du client', admin ? d.client_reference : ''],
    ['Régime', LABELS.regime[d.regime] ?? ''],
    ['Code régime (interne)', admin ? d.regime_code : ''],
    ['Transport', mode?.label ?? ''],
    [mode?.docLabel ?? 'Titre de transport', d.transport_doc],
    [mode?.carrierLabel ?? 'Navire ou vol', d.vessel],
    ['Conteneurs', d.containers],
    [d.direction === 'import' ? 'Fournisseur' : 'Acheteur', d.counterparty],
    ['Bureau de douane', officeText(d)],
    [d.direction === 'import' ? 'Arrivée prévue' : 'Départ prévu', ctx.f.date(d.expected_on)],
    ['Manifeste (interne)', admin ? d.manifest_ref : ''],
    ['Précisions', d.description ? html`<span class="pre">${d.description}</span>` : ''],
  ]);
}

function documentGroups(ctx, dossier, documents, { back }) {
  const groups = [
    ['client', 'Documents à nous transmettre'],
    ['tiers', 'Documents attendus d’autres intervenants'],
    ['cabinet', 'Documents que nous vous remettrons'],
  ];
  const open = !isClosed(dossier);
  return groups.map(([responsible, title]) => {
    const list = documents.filter((doc) => doc.responsible === responsible);
    if (!list.length) return '';
    return html`<h3>${title}</h3><ul class="docs">
      ${list.map(
        (doc) => html`<li class="doc">
          <div class="doc-main">
            <span>${doc.label}${doc.tiers_name ? html` <small class="muted">(${doc.tiers_name})</small>` : ''}</span>
            ${badge('doc', doc.status, LABELS.docStatus[doc.status])}
            ${doc.note ? html`<p class="${doc.status === 'a_corriger' ? 'late' : 'muted'}">${doc.note}</p>` : ''}
            ${DOC_CLIENT_TODO.includes(doc.status) && doc.due_on ? html`<small>${dueText(ctx, doc.due_on)}</small>` : ''}
          </div>
          ${open && responsible === 'client' && DOC_CLIENT_TODO.includes(doc.status) ? sendButton(ctx, doc.id, back) : ''}
        </li>`,
      )}
    </ul>`;
  });
}

// ---------- Layout ----------

export function layout(ctx, title, body) {
  const { user, csrf, flash, path } = ctx;
  const link = (href, iconName, label, match = (p) => p === href, count = 0) =>
    html`<a href="${href}" ${path && match(path) ? html`aria-current="page"` : ''}>${icon(iconName)}<span>${label}</span>${
      count ? html`<span class="count" aria-label="${count} à faire">${count}</span>` : ''}</a>`;
  const links = !user
    ? ''
    : user.role === 'admin'
      ? html`${link('/admin', 'users', 'Clients', (p) => p === '/admin' || p.startsWith('/admin/clients') || p.startsWith('/admin/factures'))}
          ${link('/admin/dossiers', 'folder', 'Dossiers', (p) => p.startsWith('/admin/dossiers'))}
          ${link('/admin/taches', 'inbox', 'À traiter')}`
      : html`${link('/espace', 'home', 'Accueil')}
          ${link('/espace/a-faire', 'todo', 'À faire', undefined, ctx.todoCount)}
          ${link('/espace/dossiers', 'folder', 'Dossiers', (p) => p.startsWith('/espace/dossiers'))}
          ${link('/espace/factures', 'invoice', 'Factures', (p) => p.startsWith('/espace/factures'))}
          ${link('/espace/historique', 'history', 'Historique')}`;
  const initials = user ? user.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() : '';

  return html`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0b2a5b">
  <title>${title} · ${ctx.siteName}</title>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body class="${user ? 'app' : 'public'}">
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="/"><span class="brand-mark">${icon('anchor')}</span><span class="brand-name">${ctx.siteName}</span></a>
      ${user
        ? html`<nav class="mainnav" aria-label="Navigation principale">${links}</nav>
          <details class="account">
            <summary aria-label="Mon compte"><span class="avatar">${initials}</span><span class="account-name">${user.name}</span></summary>
            <div class="account-menu">
              <p><strong>${user.name}</strong><br><small>${user.login}</small></p>
              <a href="/mot-de-passe">${icon('lock')}<span>Mot de passe</span></a>
              <form method="post" action="/deconnexion">${csrfField(csrf)}<button class="menu-item">${icon('logout')}<span>Déconnexion</span></button></form>
            </div>
          </details>`
        : ''}
    </div>
  </header>
  <main>
    ${(flash ?? []).map((f) => html`<div class="flash flash-${f.type}" role="status">${f.text}</div>`)}
    ${body}
  </main>
  ${user ? html`<nav class="tabbar" aria-label="Navigation">${links}</nav>` : ''}
</body>
</html>`;
}

// ---------- Public pages ----------

export function loginPage(ctx, { error, login = '' } = {}) {
  return layout(
    ctx,
    'Connexion',
    html`<section class="login">
      <div class="login-visual">
        <div class="login-copy">
          <p class="eyebrow">Espace client · ${ctx.siteName}</p>
          <h1>Vos dédouanements, suivis en temps réel.</h1>
          <p>Avancement de chaque dossier import et export, documents à fournir, droits et taxes, factures : tout au même endroit.</p>
          <ul class="login-points">
            <li>${icon('check')}Les étapes de la douane, au fil de l'eau</li>
            <li>${icon('check')}Les documents attendus et ceux que nous vous remettons</li>
            <li>${icon('check')}Vos factures, provisions et débours détaillés</li>
          </ul>
        </div>
      </div>
      <div class="login-panel">
        <div class="card login-card">
          <h2>Connexion</h2>
          <p class="muted">Utilisez l'identifiant et le mot de passe fournis par le cabinet.</p>
          ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
          <form method="post" action="/connexion" class="stack">
            <label>Identifiant<input name="login" value="${login}" autocomplete="username" placeholder="CL-0001" required autofocus></label>
            <label>Mot de passe<input type="password" name="password" autocomplete="current-password" required></label>
            <button class="wide">Se connecter</button>
          </form>
        </div>
      </div>
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
      ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
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

// ---------- Client pages ----------

export function clientDashboard(ctx, { todo, openDossiers, closedCount, unpaidTotal, overdueCount, events }) {
  const firstName = ctx.user.name.split(/\s+/)[0];
  return layout(
    ctx,
    'Tableau de bord',
    html`<section class="hero">
      <div class="hero-inner">
        <p class="eyebrow">${ctx.f.date(ctx.f.today())}</p>
        <h1>Bonjour ${firstName}</h1>
        <p>${todo.length
          ? `${plural(todo.length, 'point demande', 'points demandent')} votre attention.`
          : 'Rien à faire de votre côté pour le moment : nous nous occupons du reste.'}</p>
      </div>
    </section>
    <div class="kpis">
      <a class="kpi${todo.length ? ' kpi-alert' : ''}" href="/espace/a-faire">
        <span class="kpi-icon">${icon('todo')}</span><span class="kpi-value">${todo.length}</span><span class="kpi-label">À faire</span></a>
      <a class="kpi" href="/espace/dossiers">
        <span class="kpi-icon">${icon('folder')}</span><span class="kpi-value">${openDossiers.length}</span><span class="kpi-label">Dossiers en cours</span></a>
      <a class="kpi" href="/espace/factures">
        <span class="kpi-icon">${icon('wallet')}</span><span class="kpi-value">${ctx.f.money(unpaidTotal)}</span>
        <span class="kpi-label">Reste à payer${overdueCount ? html` · <span class="late">${plural(overdueCount, 'en retard', 'en retard')}</span>` : ''}</span></a>
    </div>
    ${todo.length ? html`<section class="card attention"><h2>À faire (${todo.length})</h2>${todoList(ctx, todo, '/espace')}</section>` : ''}
    <div class="section-head"><h2>Dossiers en cours</h2>${closedCount ? html`<a href="/espace/dossiers">${plural(closedCount, 'dossier terminé', 'dossiers terminés')} ${icon('arrow')}</a>` : ''}</div>
    ${dossierCards(ctx, openDossiers, (d) => `/espace/dossiers/${d.id}`)}
    <div class="section-head"><h2>Dernières nouvelles</h2><a href="/espace/historique">Tout l'historique ${icon('arrow')}</a></div>
    <section class="card">${timeline(ctx, events, { showDossier: true })}</section>`,
  );
}

export function clientDossiersPage(ctx, { openDossiers, closedDossiers }) {
  return layout(
    ctx,
    'Dossiers',
    html`<h1>Mes dossiers</h1>
    <h2>En cours</h2>
    ${dossierCards(ctx, openDossiers, (d) => `/espace/dossiers/${d.id}`)}
    <h2>Terminés ou annulés</h2>
    ${closedDossiers.length ? dossierCards(ctx, closedDossiers, (d) => `/espace/dossiers/${d.id}`) : empty('Aucun.')}`,
  );
}

export function clientDossierPage(ctx, { dossier: d, stages, documents, invoices, tasks, events }) {
  const back = `/espace/dossiers/${d.id}`;
  const stage = byKey(stagesFor(d.direction), d.stage);
  const todoDocs = isClosed(d) ? [] : documents.filter((doc) => doc.responsible === 'client' && DOC_CLIENT_TODO.includes(doc.status));
  const customs = customsFacts(ctx, d);
  return layout(
    ctx,
    d.reference,
    html`<p class="back"><a href="/espace">← Tableau de bord</a></p>
    <section class="card dossier-head">
      <div class="card-head">
        <span class="transport transport-lg">${transportIcon(d)}</span>
        <span class="ref">${d.reference}${d.client_reference ? html` · votre réf. ${d.client_reference}` : ''}</span>${dirBadge(d.direction)}
      </div>
      <h1>${d.title}</h1>
      ${holdBanner(d)}
      ${ctBanner(d)}
      <div class="now">
        <p class="stage-name">${stage?.label}</p>
        ${stageMeter(d)}
        ${d.hold === 'annule' ? '' : html`<p>${stage ? stageExplain(stage, d.direction) : ''}</p>${waitingLine(d)}`}
      </div>
    </section>

    ${todoDocs.length
      ? html`<section class="card attention"><h2>À fournir</h2>
          ${todoList(ctx, todoDocs.map((doc) => ({ ...doc, kind: 'document', reference: null })), back)}</section>`
      : ''}

    <h2>Avancement</h2>
    ${stepper(ctx, d, stages)}

    ${customs ? html`<h2>Douane</h2>${customs}` : ''}

    <h2>Informations</h2>
    ${infoFacts(ctx, d) || empty('Pas encore d’informations.')}

    <h2>Documents</h2>
    ${documents.length ? documentGroups(ctx, d, documents, { back }) : empty('Aucun document listé.')}

    <h2>Factures liées</h2>
    ${invoiceTable(ctx, invoices)}

    ${tasks.length ? html`<h2>Demandes</h2>${taskList(ctx, tasks)}` : ''}

    <h2>Historique du dossier</h2>
    ${timeline(ctx, events)}`,
  );
}

export function clientTodoPage(ctx, { todo, requests, dossiers }) {
  return layout(
    ctx,
    'À faire',
    html`<h1>À faire</h1>
    ${todoList(ctx, todo, '/espace/a-faire')}
    <h2>Écrire au cabinet</h2>
    <section class="card">
      <form method="post" action="/espace/taches" class="stack">
        ${csrfField(ctx.csrf)}
        <label>Objet<input name="title" maxlength="200" required placeholder="Ex. : Pouvez-vous accélérer le dossier ?"></label>
        <label>Message<textarea name="description" rows="4" maxlength="5000"></textarea></label>
        <div class="row">
          <label>Dossier ${selectInput('dossier_id', dossierOptions(dossiers), '', { required: false, empty: '— Aucun —' })}</label>
          <label>Priorité ${selectInput('priority', PRIORITY, 'normale')}</label>
          <label>Réponse souhaitée avant le<input type="date" name="due_on"></label>
        </div>
        <button>Envoyer au cabinet</button>
      </form>
    </section>
    <h2>Vos demandes au cabinet</h2>
    ${taskList(ctx, requests)}`,
  );
}

export function clientInvoicesPage(ctx, { invoices }) {
  return layout(ctx, 'Factures', html`<h1>Mes factures</h1>${invoiceTable(ctx, invoices)}`);
}

export function clientHistoryPage(ctx, { events }) {
  return layout(ctx, 'Historique', html`<h1>Historique de mes dossiers</h1>${timeline(ctx, events, { showDossier: true })}`);
}

// ---------- Invoice detail (client and firm) ----------

function totalsTable(ctx, totals, lines, deductions = []) {
  const taxable = lines.filter((l) => l.kind !== 'debours');
  const debours = lines.filter((l) => l.kind === 'debours');
  const money = ctx.f.money;
  return html`<div class="table-wrap"><table class="invoice">
    ${taxable.length
      ? html`<tbody>
          <tr class="section"><th colspan="2">Prestations du cabinet (soumises à TVA)</th></tr>
          ${taxable.map((l) => html`<tr><td>${l.label} <small class="muted">${LABELS.lineKind[l.kind]} · TVA ${LABELS.vat[String(l.vat_rate_bp ?? 0)] ?? `${(l.vat_rate_bp ?? 0) / 100} %`}</small></td><td class="num">${money(l.amount_minor)}</td></tr>`)}
          <tr class="subtotal"><td>Total hors taxes</td><td class="num">${money(totals.taxable_minor)}</td></tr>
          ${totals.vat.map((v) => html`<tr><td>TVA ${v.rate_bp / 100} % sur ${money(v.base_minor)}</td><td class="num">${money(v.vat_minor)}</td></tr>`)}
        </tbody>`
      : ''}
    ${debours.length
      ? html`<tbody>
          <tr class="section"><th colspan="2">Débours</th></tr>
          <tr><td colspan="2"><small class="muted">Sommes avancées pour votre compte (droits de douane, port, transport…), refacturées au prix coûtant, sans TVA, justificatifs à l'appui.</small></td></tr>
          ${debours.map((l) => html`<tr><td>${l.label} <small class="muted">${LABELS.debours[l.category] ?? ''}${l.receipt_ref ? ` · justificatif ${l.receipt_ref}` : ''}</small></td><td class="num">${money(l.amount_minor)}</td></tr>`)}
          <tr class="subtotal"><td>Total débours</td><td class="num">${money(totals.debours_minor)}</td></tr>
        </tbody>`
      : ''}
    <tbody>
      ${totals.stamp_minor ? html`<tr><td>Timbre fiscal</td><td class="num">${money(totals.stamp_minor)}</td></tr>` : ''}
      ${totals.deduction_minor
        ? html`<tr><td>Total</td><td class="num">${money(totals.gross_minor)}</td></tr>
            ${deductions.map((p) => html`<tr><td>Provision déjà versée n° ${p.provision_number ?? p.number}</td><td class="num">− ${money(p.amount_minor)}</td></tr>`)}`
        : ''}
      <tr class="grand"><td>Net à payer</td><td class="num">${money(totals.net_minor)}</td></tr>
    </tbody>
  </table></div>`;
}

export function invoicePage(ctx, { invoice: inv, lines, deductions, totals, client, deductedIn }) {
  const admin = ctx.user.role === 'admin';
  const st = invoiceStatus(inv, ctx.f.today());
  const kind = LABELS.invoiceKind[inv.kind];
  const backLink = admin ? html`<a href="/admin/clients/${inv.client_id}">← ${client?.name ?? 'Client'}</a>` : html`<a href="/espace/factures">← Factures</a>`;
  return layout(
    ctx,
    `${kind} ${inv.number}`,
    html`<p>${backLink}</p>
    <section class="card">
      <h1>${kind} n° ${inv.number} ${badge('inv', st.key, st.label)}</h1>
      ${facts([
        ['Objet', inv.label],
        ['Dossier', inv.reference ? (admin ? html`<a href="/admin/dossiers/${inv.dossier_id}">${inv.reference}</a>` : html`<a href="/espace/dossiers/${inv.dossier_id}">${inv.reference}</a>`) : ''],
        ['Émise le', ctx.f.date(inv.issued_on)],
        ['À régler avant le', inv.status === 'a_payer' ? ctx.f.date(inv.due_on) : ''],
        ['Payée le', ctx.f.date(inv.paid_on)],
      ])}
      ${inv.kind === 'provision'
        ? html`<p class="amount">${ctx.f.money(inv.amount_minor)}</p>
            <p class="muted">Avance demandée pour régler pour votre compte les droits, taxes et frais du dossier. Elle sera déduite de la facture finale.</p>
            ${inv.deducted_in ? html`<p>Déduite sur la facture ${deductedIn ? deductedIn.number : ''}.</p>` : ''}`
        : totals
          ? totalsTable(ctx, totals, lines, deductions)
          : html`<p class="amount">${ctx.f.money(inv.amount_minor)}</p><p class="muted">Détail non disponible.</p>`}
      ${inv.legal_note ? html`<p class="muted">${inv.legal_note}</p>` : ''}
      <p class="hint">Copie pour information. La facture officielle vous est transmise par le cabinet.</p>
    </section>
    ${admin
      ? html`<section class="card">
          <h2>Changer l'état</h2>
          ${inv.status === 'annulee'
            ? empty('Facture annulée : émettez-en une nouvelle si nécessaire.')
            : inv.deducted_in
              ? empty('Provision déjà déduite sur une facture : annulez d’abord cette facture pour la modifier.')
              : html`<form method="post" action="/admin/factures/${inv.id}" class="row">${csrfField(ctx.csrf)}
                  <label>État ${selectInput('status', [{ key: 'a_payer', label: 'À payer' }, { key: 'payee', label: 'Payée' }, { key: 'annulee', label: 'Annulée' }], inv.status)}</label>
                  <label>Payée le<input type="date" name="paid_on" value="${inv.paid_on ?? ''}"></label>
                  <button class="small">Enregistrer</button></form>`}
        </section>`
      : ''}`,
  );
}

// ---------- Admin pages ----------

export function adminHomePage(ctx, { clients }) {
  return layout(
    ctx,
    'Clients',
    html`<h1>Clients</h1>
    ${!clients.length
      ? empty('Aucun client pour le moment.')
      : html`<div class="table-wrap"><table class="responsive">
        <thead><tr><th>Identifiant</th><th>Client</th><th class="num">Dossiers en cours</th><th class="num">Bloqués / en attente</th><th class="num">Documents à vérifier</th><th class="num">Demandes</th><th class="num">Reste à payer</th><th>Compte</th></tr></thead>
        <tbody>${clients.map(
          (c) => html`<tr>
            <td data-label="Identifiant"><a href="/admin/clients/${c.id}">${c.login}</a></td><td data-label="Client">${c.name}${c.company ? html`<br><small class="muted">${c.company}</small>` : ''}</td>
            <td data-label="Dossiers en cours" class="num">${c.open_dossiers}</td><td data-label="Bloqués / en attente" class="num">${c.held_dossiers || '—'}</td>
            <td data-label="Documents à vérifier" class="num">${c.docs_to_check || '—'}</td><td data-label="Demandes" class="num">${c.open_tasks || '—'}</td>
            <td data-label="Reste à payer" class="num">${ctx.f.money(c.unpaid)}</td>
            <td data-label="Compte">${c.active ? badge('account', 'actif', 'Actif') : badge('account', 'inactif', 'Désactivé')}</td>
          </tr>`,
        )}</tbody></table></div>`}
    <details class="card" ${clients.length ? '' : html`open`}>
      <summary>+ Nouveau client</summary>
      <p class="muted">Un identifiant (CL-xxxx) et un mot de passe provisoire sont générés automatiquement.</p>
      <form method="post" action="/admin/clients" class="stack">
        ${csrfField(ctx.csrf)}
        <div class="row">
          <label>Nom du contact<input name="name" maxlength="200" required></label>
          <label>Société<input name="company" maxlength="200"></label>
        </div>
        <div class="row">
          <label>E-mail<input type="email" name="email" maxlength="200"></label>
          <label>Téléphone<input name="phone" maxlength="50"></label>
        </div>
        <button>Créer le client</button>
      </form>
    </details>`,
  );
}

function adminDossierTable(ctx, dossiers, { showClient = true } = {}) {
  if (!dossiers.length) return empty('Aucun dossier.');
  return html`<div class="table-wrap"><table class="responsive">
    <thead><tr><th>Dossier</th>${showClient ? html`<th>Client</th>` : ''}<th>Étape</th><th>Situation</th><th class="num">Docs manquants</th><th class="num">À vérifier</th><th>Mis à jour</th></tr></thead>
    <tbody>${dossiers.map(
      (d) => html`<tr>
        <td data-label="Dossier"><span class="cell-title"><span class="transport">${transportIcon(d)}</span><a href="/admin/dossiers/${d.id}">${d.reference}</a> ${dirBadge(d.direction)}</span><small class="muted">${d.title}</small></td>
        ${showClient ? html`<td data-label="Client"><a href="/admin/clients/${d.client_id}">${d.client_name}</a></td>` : ''}
        <td data-label="Étape">${LABELS.stage[d.stage]}${d.circuit ? html` ${badge('circuit', d.circuit, LABELS.circuit[d.circuit])}` : ''}</td>
        <td data-label="Situation">${d.hold ? badge('hold', d.hold, LABELS.hold[d.hold]) : '—'}</td>
        <td data-label="Docs manquants" class="num">${d.missing_docs || '—'}</td><td data-label="À vérifier" class="num">${d.docs_to_check || '—'}</td>
        <td data-label="Mis à jour">${ctx.f.dateTime(d.updated_at)}</td>
      </tr>`,
    )}</tbody></table></div>`;
}

export function adminDossiersPage(ctx, { dossiers, all }) {
  return layout(
    ctx,
    'Dossiers',
    html`<h1>${all ? 'Tous les dossiers' : 'Dossiers en cours'}</h1>
    <p class="muted">Les dossiers bloqués ou en attente apparaissent en premier, puis ceux mis à jour il y a le plus longtemps.</p>
    <p>${all ? html`<a href="/admin/dossiers">Voir seulement les dossiers en cours</a>` : html`<a href="/admin/dossiers?tous=1">Voir aussi les dossiers terminés</a>`}</p>
    ${adminDossierTable(ctx, dossiers)}`,
  );
}

export function adminTasksPage(ctx, { tasks, documents }) {
  const back = '/admin/taches';
  return layout(
    ctx,
    'À traiter',
    html`<h1>À traiter</h1>
    <h2>Documents signalés envoyés par les clients</h2>
    ${!documents.length
      ? empty('Aucun document en attente de vérification.')
      : html`<ul class="docs">${documents.map(
          (doc) => html`<li class="doc">
            <div class="doc-main">
              <strong>${doc.label}</strong>
              <small class="muted"><a href="/admin/dossiers/${doc.dossier_id}">${doc.reference}</a> · ${doc.client_name} · signalé le ${ctx.f.dateTime(doc.updated_at)}</small>
            </div>
            <form method="post" action="/admin/documents/${doc.id}" class="row">${csrfField(ctx.csrf)}${backField(back)}
              <input type="hidden" name="prev_status" value="${doc.status}">
              ${selectInput('status', [{ key: 'recu', label: 'Reçu, en vérification' }, { key: 'valide', label: 'Reçu et validé' }, { key: 'a_corriger', label: 'À corriger' }, { key: 'a_fournir', label: 'Pas reçu' }], 'valide')}
              <input name="note" value="${doc.note}" maxlength="500" placeholder="Consigne (obligatoire si à corriger)" aria-label="Consigne">
              <button class="small">OK</button></form>
          </li>`,
        )}</ul>`}
    <h2>Demandes des clients</h2>
    ${taskList(ctx, tasks.filter((t) => t.assignee === 'cabinet'), { admin: true, back })}
    <h2>Demandes en attente chez les clients</h2>
    ${taskList(ctx, tasks.filter((t) => t.assignee === 'client'), { admin: true, back })}`,
  );
}

function regimeOptions(direction) {
  return REGIMES.filter((r) => !direction || r.direction === 'both' || r.direction === direction);
}

function newDossierForm(ctx, client) {
  return html`<form method="post" action="/admin/clients/${client.id}/dossiers" class="stack">
    ${csrfField(ctx.csrf)}
    <div class="row">
      <label>Sens ${selectInput('direction', DIRECTIONS, '', { empty: '— Choisir —' })}</label>
      <label>Référence du dossier<input name="reference" maxlength="50" required placeholder="IMP-2026-0142"></label>
      <label>Référence du client<input name="client_reference" maxlength="100" placeholder="Commande, facture fournisseur…"></label>
    </div>
    <label>Marchandise<input name="title" maxlength="200" required placeholder="Ex. : Pièces détachées auto — 3 palettes"></label>
    <div class="row">
      <label>Régime ${selectInput('regime', REGIMES, '', { required: false, empty: '— À préciser —' })}</label>
      <label>Transport ${selectInput('transport_mode', TRANSPORT_MODES, '', { required: false, empty: '— À préciser —' })}</label>
    </div>
    <div class="row">
      <label>Bureau de douane ${selectInput('customs_office', CUSTOMS_OFFICES, '', { required: false, empty: '— À préciser —' })}</label>
      <label>Précision sur le lieu<input name="customs_office_detail" maxlength="200" placeholder="Nom du MAD, du bureau…"></label>
      <label>Arrivée ou départ prévu<input type="date" name="expected_on"></label>
    </div>
    <label>Précisions (visibles par le client)<textarea name="description" rows="2" maxlength="5000"></textarea></label>
    <button>Créer le dossier</button>
  </form>`;
}

function clientTaskForm(ctx, client, dossiers, { dossierId = '', back = '' } = {}) {
  return html`<form method="post" action="/admin/clients/${client.id}/taches" class="stack">
    ${csrfField(ctx.csrf)}${back ? backField(back) : ''}
    <label>Demande<input name="title" maxlength="200" required placeholder="Ex. : Être présent à la visite de la marchandise"></label>
    <label>Précisions<textarea name="description" rows="2" maxlength="5000"></textarea></label>
    <div class="row">
      <label>Dossier ${selectInput('dossier_id', dossierOptions(dossiers), dossierId, { required: false, empty: '— Aucun —' })}</label>
      <label>Priorité ${selectInput('priority', PRIORITY, 'normale')}</label>
      <label>Échéance<input type="date" name="due_on"></label>
    </div>
    <button>Ajouter la demande</button>
  </form>`;
}

export function adminClientPage(ctx, { client, dossiers, invoices, tasks, events }) {
  return layout(
    ctx,
    client.name,
    html`<p><a href="/admin">← Clients</a></p>
    <section class="card">
      <h1>${client.name} <small class="muted">${client.login}</small></h1>
      <p>${client.company}${client.email ? html` · <a href="mailto:${client.email}">${client.email}</a>` : ''}${client.phone ? html` · ${client.phone}` : ''}</p>
      <div class="row">
        <form method="post" action="/admin/clients/${client.id}/mot-de-passe" class="inline">${csrfField(ctx.csrf)}
          <button class="secondary">Réinitialiser le mot de passe</button></form>
        <form method="post" action="/admin/clients/${client.id}/activation" class="inline">${csrfField(ctx.csrf)}
          <button class="secondary">${client.active ? 'Désactiver le compte' : 'Réactiver le compte'}</button></form>
      </div>
    </section>

    <h2>Dossiers</h2>
    ${adminDossierTable(ctx, dossiers, { showClient: false })}
    <details class="card" ${dossiers.length ? '' : html`open`}>
      <summary>+ Nouveau dossier</summary>
      ${newDossierForm(ctx, client)}
    </details>

    <h2>Factures et provisions</h2>
    ${invoiceTable(ctx, invoices, { admin: true })}
    <p><a class="button secondary" href="/admin/clients/${client.id}/factures/nouvelle">+ Nouvelle facture ou provision</a></p>

    <h2>Demandes</h2>
    ${taskList(ctx, tasks, { admin: true, back: `/admin/clients/${client.id}` })}
    <details class="card">
      <summary>+ Demander quelque chose au client</summary>
      ${clientTaskForm(ctx, client, dossiers.filter((d) => !isClosed(d)))}
    </details>

    <h2>Historique</h2>
    ${timeline(ctx, events, { showDossier: true })}`,
  );
}

function adminDocumentRow(ctx, doc, back) {
  const statuses = DOC_STATUS.filter((s) => s.for.includes(doc.responsible));
  return html`<li class="doc">
    <div class="doc-main">
      <span>${doc.label}${doc.tiers_name ? html` <small class="muted">(${doc.tiers_name})</small>` : ''}</span>
      ${badge('doc', doc.status, LABELS.docStatus[doc.status])}
    </div>
    <form method="post" action="/admin/documents/${doc.id}" class="row">${csrfField(ctx.csrf)}${backField(back)}
      <input type="hidden" name="prev_status" value="${doc.status}">
      ${selectInput('status', statuses, doc.status)}
      <input type="date" name="due_on" value="${doc.due_on ?? ''}" aria-label="Échéance">
      <input name="note" value="${doc.note}" maxlength="500" placeholder="Consigne visible par le client" aria-label="Consigne">
      <button class="small">OK</button>
    </form>
  </li>`;
}

export function adminDossierPage(ctx, { dossier: d, client, stages, documents, invoices, tasks, events }) {
  const back = `/admin/dossiers/${d.id}`;
  const list = stagesFor(d.direction);
  const index = list.findIndex((s) => s.key === d.stage);
  const next = d.hold === 'annule' ? null : list[index + 1];
  const groups = [
    ['client', 'Documents à fournir par le client'],
    ['tiers', 'Documents attendus d’autres intervenants'],
    ['cabinet', 'Documents à remettre au client'],
  ];
  return layout(
    ctx,
    d.reference,
    html`<p class="back"><a href="/admin/clients/${client.id}">← ${client.name}</a> · <a href="/admin/dossiers">Tous les dossiers</a></p>
    <section class="card dossier-head">
      <div class="card-head">
        <span class="transport transport-lg">${transportIcon(d)}</span>
        <span class="ref">${d.reference}${d.client_reference ? html` · réf. client ${d.client_reference}` : ''}</span>${dirBadge(d.direction)}
      </div>
      <h1>${d.title}</h1>
      ${holdBanner(d)}
      ${ctBanner(d)}
      <p class="stage-name">${LABELS.stage[d.stage]}</p>
      ${stageMeter(d)}
      ${waitingLine(d)}
      ${d.missing_docs ? html`<p class="status status-todo">${plural(d.missing_docs, 'document manquant', 'documents manquants')} chez le client</p>` : ''}
    </section>

    <div class="columns">
    <aside class="col-side">
    <section class="card">
      <h2>Étape</h2>
      ${next
        ? html`<form method="post" action="/admin/dossiers/${d.id}/etape" class="row">${csrfField(ctx.csrf)}
            <input type="hidden" name="stage" value="${next.key}">
            <button>Passer à : ${next.label}</button></form>`
        : ''}
      <form method="post" action="/admin/dossiers/${d.id}/etape" class="stack">${csrfField(ctx.csrf)}
        <div class="row">
          <label>Étape ${selectInput('stage', list, d.stage)}</label>
          <label>Date<input type="date" name="entered_on" value="${ctx.f.today()}" max="${ctx.f.today()}"></label>
        </div>
        <label>Commentaire visible par le client (obligatoire pour revenir en arrière)<input name="note" maxlength="1000"></label>
        <button class="small secondary">Enregistrer l'étape</button>
      </form>
      <details><summary>Voir toutes les étapes</summary>${stepper(ctx, d, stages)}</details>
    </section>

    <section class="card">
      <h2>Situation particulière</h2>
      <form method="post" action="/admin/dossiers/${d.id}/situation" class="stack">${csrfField(ctx.csrf)}
        <div class="row">
          <label>Situation ${selectInput('hold', HOLDS, d.hold, { required: false, empty: 'Aucune — traitement normal' })}</label>
          <label>Motif affiché au client<input name="hold_note" value="${d.hold_note}" maxlength="500"></label>
        </div>
        <button class="small">Enregistrer</button>
      </form>
    </section>

    <section class="card">
      <h2>Message au client</h2>
      <form method="post" action="/admin/dossiers/${d.id}/message" class="stack">${csrfField(ctx.csrf)}
        <textarea name="message" rows="2" maxlength="2000" required placeholder="Ajouté à l'historique du dossier, visible par le client"></textarea>
        <button class="small">Publier</button>
      </form>
    </section>

    </aside>
    <div class="col-main">
    <section class="card">
      <h2>Documents</h2>
      ${groups.map(([responsible, title]) => {
        const docs = documents.filter((doc) => doc.responsible === responsible);
        return docs.length ? html`<h3>${title}</h3><ul class="docs">${docs.map((doc) => adminDocumentRow(ctx, doc, back))}</ul>` : '';
      })}
      <details>
        <summary>+ Ajouter un document à la liste</summary>
        <form method="post" action="/admin/dossiers/${d.id}/documents" class="stack">${csrfField(ctx.csrf)}
          <div class="row">
            <label>Document ${selectInput('doc_type', DOC_TYPES.filter((t) => t.applies === 'both' || t.applies === d.direction), 'autre')}</label>
            <label>Intitulé (si « Autre » ou pour préciser)<input name="label" maxlength="200"></label>
          </div>
          <div class="row">
            <label>Fourni par ${selectInput('responsible', RESPONSIBLES, '', { required: false, empty: '— Selon le document —' })}</label>
            <label>Intervenant (si autre intervenant)<input name="tiers_name" maxlength="100" placeholder="Agent maritime, banque…"></label>
            <label>À fournir avant le<input type="date" name="due_on"></label>
          </div>
          <label>Consigne visible par le client<input name="note" maxlength="500"></label>
          <button class="small">Ajouter</button>
        </form>
      </details>
    </section>

    <section class="card">
      <h2>Douane</h2>
      <form method="post" action="/admin/dossiers/${d.id}/douane" class="stack">${csrfField(ctx.csrf)}
        <div class="row">
          <label>N° de déclaration<input name="declaration_number" value="${d.declaration_number}" maxlength="50"></label>
          <label>Date d'enregistrement<input type="date" name="declaration_on" value="${d.declaration_on ?? ''}"></label>
          <label>Circuit ${selectInput('circuit', CIRCUITS, d.circuit, { required: false, empty: 'Pas encore attribué' })}</label>
        </div>
        <div class="row">
          <label>Visite de la marchandise le<input type="date" name="visit_on" value="${d.visit_on ?? ''}"></label>
          <label>Lieu de la visite<input name="visit_place" value="${d.visit_place}" maxlength="200"></label>
          <label>BAE délivré le<input type="date" name="bae_on" value="${d.bae_on ?? ''}"></label>
        </div>
        <button class="small">Enregistrer</button>
      </form>
    </section>

    <section class="card">
      <h2>Droits et taxes</h2>
      <form method="post" action="/admin/dossiers/${d.id}/droits" class="stack">${csrfField(ctx.csrf)}
        <div class="row">
          <label>Montant liquidé (${ctx.f.currency})<input name="duties_amount" value="${ctx.f.moneyInput(d.duties_minor)}" inputmode="decimal"></label>
          <label>Payé par ${selectInput('duties_payer', [{ key: 'client', label: 'Le client' }, { key: 'cabinet', label: 'Le cabinet (débours)' }], d.duties_payer, { required: false, empty: '—' })}</label>
          <label>À payer avant le<input type="date" name="duties_due_on" value="${d.duties_due_on ?? ''}"></label>
        </div>
        <div class="row">
          <label>Payés le<input type="date" name="duties_paid_on" value="${d.duties_paid_on ?? ''}"></label>
          <label>N° de quittance<input name="duties_receipt" value="${d.duties_receipt}" maxlength="100"></label>
        </div>
        <button class="small">Enregistrer</button>
      </form>
    </section>

    <section class="card">
      <h2>Contrôle technique</h2>
      <form method="post" action="/admin/dossiers/${d.id}/controle-technique" class="stack">${csrfField(ctx.csrf)}
        <div class="row">
          <label>État ${selectInput('ct_status', CT_STATUS, d.ct_status, { required: false, empty: 'Non concerné' })}</label>
          <label>Précision visible par le client<input name="ct_note" value="${d.ct_note}" maxlength="500"></label>
        </div>
        <button class="small">Enregistrer</button>
      </form>
    </section>

    <details class="card">
      <summary>Informations du dossier</summary>
      ${infoFacts(ctx, d, { admin: true })}
      <form method="post" action="/admin/dossiers/${d.id}/infos" class="stack">${csrfField(ctx.csrf)}
        <div class="row">
          <label>Sens ${d.stage === 'ouverture'
            ? selectInput('direction', DIRECTIONS, d.direction)
            : html`<input type="hidden" name="direction" value="${d.direction}"><input value="${LABELS.direction[d.direction]}" disabled>`}</label>
          <label>Référence<input name="reference" value="${d.reference}" maxlength="50" required></label>
          <label>Référence du client<input name="client_reference" value="${d.client_reference}" maxlength="100"></label>
        </div>
        <label>Marchandise<input name="title" value="${d.title}" maxlength="200" required></label>
        <div class="row">
          <label>Régime ${selectInput('regime', regimeOptions(d.direction), d.regime, { required: false, empty: '— À préciser —' })}</label>
          <label>Code régime (interne)<input name="regime_code" value="${d.regime_code}" maxlength="50"></label>
        </div>
        <div class="row">
          <label>Transport ${selectInput('transport_mode', TRANSPORT_MODES, d.transport_mode, { required: false, empty: '— À préciser —' })}</label>
          <label>N° BL / LTA / CMR<input name="transport_doc" value="${d.transport_doc}" maxlength="100"></label>
          <label>Navire ou vol<input name="vessel" value="${d.vessel}" maxlength="100"></label>
        </div>
        <div class="row">
          <label>Conteneurs<input name="containers" value="${d.containers}" maxlength="500"></label>
          <label>${d.direction === 'import' ? 'Fournisseur' : 'Acheteur'}<input name="counterparty" value="${d.counterparty}" maxlength="200"></label>
        </div>
        <div class="row">
          <label>Bureau de douane ${selectInput('customs_office', CUSTOMS_OFFICES, d.customs_office, { required: false, empty: '— À préciser —' })}</label>
          <label>Précision sur le lieu<input name="customs_office_detail" value="${d.customs_office_detail}" maxlength="200"></label>
          <label>${d.direction === 'import' ? 'Arrivée prévue' : 'Départ prévu'}<input type="date" name="expected_on" value="${d.expected_on ?? ''}"></label>
        </div>
        <label>Manifeste (interne)<input name="manifest_ref" value="${d.manifest_ref}" maxlength="100"></label>
        <label>Précisions (visibles par le client)<textarea name="description" rows="2" maxlength="5000">${d.description}</textarea></label>
        <button class="small">Enregistrer</button>
      </form>
    </details>

    <h2>Factures et provisions</h2>
    ${invoiceTable(ctx, invoices, { admin: true })}
    <p><a class="button secondary" href="/admin/clients/${client.id}/factures/nouvelle?dossier=${d.id}">+ Nouvelle facture ou provision</a></p>

    <h2>Demandes</h2>
    ${taskList(ctx, tasks, { admin: true, back })}
    <details class="card">
      <summary>+ Demander quelque chose au client</summary>
      ${clientTaskForm(ctx, client, [d], { dossierId: d.id, back })}
    </details>

    <h2>Historique</h2>
    <section class="card">${timeline(ctx, events)}</section>
    </div>
    </div>`,
  );
}

export function adminInvoiceFormPage(ctx, { client, dossiers, provisions, values, maxLines, totals, errors = [], preview = false }) {
  const v = (key) => values[key] ?? '';
  const lineRows = [];
  for (let i = 1; i <= maxLines; i++) {
    const p = `l${i}_`;
    lineRows.push(html`<fieldset class="line">
      <legend>Ligne ${i}</legend>
      <div class="row">
        <label>Type ${selectInput(`${p}kind`, LINE_KINDS, v(`${p}kind`) || (i === 1 ? 'honoraires' : 'debours'), { required: false })}</label>
        <label>Libellé<input name="${p}label" value="${v(`${p}label`)}" maxlength="200"></label>
        <label>Montant HT (${ctx.f.currency})<input name="${p}amount" value="${v(`${p}amount`)}" inputmode="decimal"></label>
      </div>
      <div class="row">
        <label>TVA (honoraires et frais) ${selectInput(`${p}vat`, VAT_RATES, v(`${p}vat`) || '1900', { required: false })}</label>
        <label>Nature (débours) ${selectInput(`${p}category`, DEBOURS_CATEGORIES, v(`${p}category`), { required: false, empty: '—' })}</label>
        <label>Justificatif (débours)<input name="${p}receipt" value="${v(`${p}receipt`)}" maxlength="100" placeholder="Quittance n°, facture du tiers…"></label>
      </div>
    </fieldset>`);
  }
  const previewLines = [];
  if (totals) {
    for (let i = 1; i <= maxLines; i++) {
      const p = `l${i}_`;
      const amount = ctx.f.parseMoney(v(`${p}amount`));
      if (!v(`${p}label`) || amount === null || !Object.hasOwn(LABELS.lineKind, v(`${p}kind`))) continue;
      const taxable = byKey(LINE_KINDS, v(`${p}kind`)).taxable;
      previewLines.push({ kind: v(`${p}kind`), label: v(`${p}label`), amount_minor: amount, vat_rate_bp: taxable ? Number(v(`${p}vat`) || 0) : null, category: v(`${p}category`), receipt_ref: v(`${p}receipt`) });
    }
  }
  const chosen = provisions.filter((pr) => values[`deduct_${pr.id}`]);
  return layout(
    ctx,
    'Nouvelle facture',
    html`<p><a href="/admin/clients/${client.id}">← ${client.name}</a></p>
    <h1>Nouvelle facture</h1>
    ${errors.length ? html`<div class="flash flash-error" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
    ${preview && totals && !errors.length
      ? html`<section class="card attention"><h2>Aperçu</h2>${totalsTable(ctx, totals, previewLines, chosen)}<p class="muted">Vérifiez puis cliquez sur « Émettre la facture » en bas du formulaire.</p></section>`
      : ''}
    <form method="post" action="/admin/clients/${client.id}/factures" class="stack card">
      ${csrfField(ctx.csrf)}
      <div class="row">
        <label>N° de facture<input name="number" value="${v('number')}" maxlength="50" required></label>
        <label>Objet<input name="label" value="${v('label')}" maxlength="200"></label>
        <label>Dossier ${selectInput('dossier_id', dossierOptions(dossiers), v('dossier_id'), { required: false, empty: '— Aucun —' })}</label>
      </div>
      <div class="row">
        <label>Émise le<input type="date" name="issued_on" value="${v('issued_on')}" required></label>
        <label>À régler avant le<input type="date" name="due_on" value="${v('due_on')}" required></label>
        <label>Timbre fiscal (${ctx.f.currency})<input name="stamp" value="${v('stamp')}" inputmode="decimal"></label>
      </div>
      <p class="muted">Remplissez seulement les lignes utiles. Honoraires et frais refacturés : montant hors taxes, TVA ajoutée. Débours : sommes payées pour le client, sans TVA, avec la référence du justificatif.</p>
      ${lineRows}
      ${provisions.length
        ? html`<fieldset class="line"><legend>Provisions payées à déduire</legend>
            ${provisions.map((pr) => html`<label class="check"><input type="checkbox" name="deduct_${pr.id}" value="1" ${values[`deduct_${pr.id}`] ? html`checked` : ''}>
              N° ${pr.number} — ${ctx.f.money(pr.amount_minor)} (payée le ${ctx.f.date(pr.paid_on)})</label>`)}
          </fieldset>`
        : ''}
      <label>Mention particulière (ex. : suspension de TVA, attestation n° …)<input name="legal_note" value="${v('legal_note')}" maxlength="300"></label>
      <div class="row">
        <button name="action" value="apercu" class="secondary">Aperçu</button>
        <button name="action" value="emettre">Émettre la facture</button>
      </div>
    </form>

    <h2>Demande de provision</h2>
    <form method="post" action="/admin/clients/${client.id}/provisions" class="stack card">
      ${csrfField(ctx.csrf)}
      <p class="muted">Avance demandée au client avant de payer pour lui les droits, taxes et frais. Une fois payée, elle se déduit d'une facture.</p>
      <div class="row">
        <label>N° de la demande<input name="number" maxlength="50" required></label>
        <label>Montant (${ctx.f.currency})<input name="amount" inputmode="decimal" required></label>
        <label>À régler avant le<input type="date" name="due_on" required></label>
      </div>
      <div class="row">
        <label>Objet<input name="label" maxlength="200" placeholder="Provision pour droits, taxes et frais"></label>
        <label>Dossier ${selectInput('dossier_id', dossierOptions(dossiers), v('dossier_id'), { required: false, empty: '— Aucun —' })}</label>
      </div>
      <button>Envoyer la demande de provision</button>
    </form>`,
  );
}
