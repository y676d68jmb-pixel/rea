/**
 * Customs-brokerage vocabulary (French), dates and money.
 * Every list is ordered: the order is the one shown in forms and, for STAGES, the order of the procedure.
 * Sources: Ministère du Commerce, « Manuel des procédures à l'importation » (2022) and « … à l'exportation »;
 * douane.gov.tn (bureaux); LF 2026 (droit de timbre 1,000 DT par facture).
 */

const toMap = (list) => Object.fromEntries(list.map((item) => [item.key, item.label]));

// ---------- Dossier ----------

export const DIRECTIONS = [
  { key: 'import', label: 'Importation' },
  { key: 'export', label: 'Exportation' },
];

/** Who a dossier is waiting on (shown as « En attente de : … »). */
export const WAITING = {
  client: 'vous',
  cabinet: 'le cabinet',
  douane: 'la douane',
  port: 'le port ou le transporteur',
  banque: "votre banque ou l'administration",
};

/**
 * Ordered steps of a customs file. `applies` is import, export or both; `pct` drives the progress bar;
 * `waiting` is the default party the step waits on (see waitingOn for the rules that override it).
 */
export const STAGES = [
  { key: 'ouverture', label: 'Dossier ouvert', applies: 'both', pct: 5, waiting: 'cabinet',
    explain: 'Nous avons ouvert votre dossier et préparé la liste des documents nécessaires.' },
  { key: 'documents', label: 'Réception des documents', applies: 'both', pct: 15, waiting: 'cabinet',
    explain: 'Nous rassemblons et vérifions les documents. La liste « À fournir » indique ce qui manque encore.' },
  { key: 'banque', label: 'Domiciliation bancaire et autorisations', applies: 'both', pct: 25, waiting: 'banque',
    explain: "La facture (titre de commerce extérieur) est domiciliée par votre banque et, si le produit l'exige, l'autorisation ou le certificat est obtenu." },
  { key: 'arrivee', label: 'Arrivée de la marchandise', applies: 'import', pct: 35, waiting: 'port',
    explain: 'Nous attendons le navire, l’avion ou le camion et l’enregistrement du manifeste, sans lequel la déclaration est impossible.' },
  { key: 'transfert', label: 'Transfert vers le lieu de dédouanement', applies: 'import', pct: 42, waiting: 'port',
    explain: 'La marchandise est acheminée sous contrôle douanier vers le magasin et aire de dédouanement (MAD) ou le bureau où elle sera dédouanée.' },
  { key: 'reservation', label: 'Réservation du transport', applies: 'export', pct: 35, waiting: 'port',
    explain: 'Le transport est réservé ; pour un envoi par bateau, le port délivre le bon de mise à quai.' },
  { key: 'declaration', label: 'Déclaration déposée en douane', applies: 'both', pct: 50, waiting: 'douane',
    explain: 'Nous avons enregistré la déclaration en douane et déposé le dossier au bureau.' },
  { key: 'controle', label: 'Contrôle de la douane', applies: 'both', pct: 60, waiting: 'douane',
    explain: 'La douane vérifie la déclaration : sans contrôle (circuit vert), contrôle des documents (orange) ou visite de la marchandise (rouge).' },
  { key: 'droits', label: 'Paiement des droits et taxes', applies: 'both', pct: 70, waiting: 'cabinet',
    explain: 'La douane a calculé les droits et taxes ; ils doivent être payés ou garantis avant la sortie de la marchandise.' },
  { key: 'bae', label: 'Bon à enlever (BAE) délivré', applies: 'both', pct: 78, waiting: 'cabinet',
    explain: {
      import: 'La douane a donné son accord : la marchandise est dédouanée et peut sortir.',
      export: "La douane autorise l'exportation ; restent l'entrée au port et l'embarquement.",
    } },
  { key: 'enlevement', label: "Sortie du port ou de l'aéroport", applies: 'import', pct: 86, waiting: 'port',
    explain: 'Nous réglons les formalités du transporteur et du port (bon à délivrer, scanner, pesée) puis la marchandise sort.' },
  { key: 'empotage', label: 'Empotage et plombage', applies: 'export', pct: 82, waiting: 'cabinet',
    explain: 'La marchandise est chargée dans le conteneur, qui est plombé avant de partir vers le port.' },
  { key: 'embarquement', label: 'Entrée au port et chargement', applies: 'export', pct: 88, waiting: 'port',
    explain: 'La marchandise entre au port, passe à la pesée et au scanner, puis est chargée.' },
  { key: 'livree', label: 'Marchandise livrée', applies: 'import', pct: 95, waiting: 'cabinet',
    explain: 'La marchandise vous a été livrée ou remise à votre transporteur. Nous finalisons les documents.' },
  { key: 'expediee', label: 'Marchandise expédiée', applies: 'export', pct: 95, waiting: 'cabinet',
    explain: "La marchandise est partie et la douane a visé l'embarquement. Nous finalisons les documents." },
  { key: 'termine', label: 'Dossier terminé', applies: 'both', pct: 100, waiting: null,
    explain: 'Les opérations sont terminées. La douane peut encore contrôler après coup : conservez vos documents.' },
];

export const HOLDS = [
  { key: 'attente_client', label: 'En attente de votre part',
    explain: 'Il nous faut un document ou une réponse de votre part pour continuer : voir « À faire ».' },
  { key: 'attente_paiement', label: 'En attente de paiement',
    explain: 'Les droits et taxes ou la provision doivent être réglés : sans paiement ni garantie, la douane ne délivre pas le bon à enlever.' },
  { key: 'bloque', label: 'Bloqué',
    explain: 'Le dossier est arrêté par un obstacle extérieur (manifeste, banque, contrôle technique, port…). Le motif est indiqué ci-dessous.' },
  { key: 'litige', label: 'Désaccord avec la douane',
    explain: 'La douane conteste un point de la déclaration (valeur, origine ou espèce de la marchandise). Nous traitons le dossier avec elle ; la sortie peut être retardée.' },
  { key: 'infraction', label: 'Infraction relevée par la douane',
    explain: "La douane a relevé une irrégularité (par exemple au scanner) qui doit être réglée avant l'enlèvement. Nous vous expliquons les suites." },
  { key: 'annule', label: 'Annulé', explain: "Ce dossier est annulé ; aucune autre opération n'est prévue." },
];

export const CIRCUITS = [
  { key: 'vert', label: 'Circuit vert', explain: 'Déclaration acceptée sans contrôle.' },
  { key: 'orange', label: 'Circuit orange', explain: 'La douane contrôle les documents ; elle peut demander une précision ou décider de voir la marchandise.' },
  { key: 'rouge', label: 'Circuit rouge', explain: 'La douane examine la marchandise lors d’une visite ; la présence de votre représentant est requise et des échantillons peuvent être prélevés.' },
];

/** Contrôle technique à l'importation: the decisions belong to the control body, never to the client. */
export const CT_STATUS = [
  { key: 'depose', label: 'Demande déposée', explain: 'La demande de contrôle technique a été déposée ; nous attendons la décision.' },
  { key: 'prelevement', label: 'Prélèvement d’échantillons (D41)', explain: 'Des échantillons sont prélevés avant le dédouanement, en présence de l’importateur ; le résultat conditionne la suite.' },
  { key: 'ape', label: 'Enlèvement provisoire (APE)', explain: 'La marchandise peut sortir mais doit rester stockée sans être vendue jusqu’à l’inspection et l’accord définitif (AMC).' },
  { key: 'amc', label: 'Conformité accordée (AMC)', explain: 'Le contrôle technique est favorable : la marchandise peut être commercialisée.' },
  { key: 'refus', label: 'Refusé', explain: 'Le contrôle technique est défavorable : la marchandise doit être réexportée ou détruite. Nous vous contactons.' },
];

export const REGIMES = [
  { key: 'mise_consommation', label: 'Importation définitive (mise à la consommation)', direction: 'import' },
  { key: 'mise_consommation_avantage', label: 'Importation avec avantage fiscal', direction: 'import' },
  { key: 'ete_intrants', label: 'Entreprise totalement exportatrice (intrants)', direction: 'import' },
  { key: 'entrepot', label: 'Entrepôt douanier', direction: 'import' },
  { key: 'admission_temporaire', label: 'Admission temporaire', direction: 'import' },
  { key: 'perfectionnement_actif', label: 'Perfectionnement actif', direction: 'import' },
  { key: 'reimportation', label: 'Réimportation', direction: 'import' },
  { key: 'exportation', label: 'Exportation définitive', direction: 'export' },
  { key: 'exportation_temporaire', label: 'Exportation temporaire', direction: 'export' },
  { key: 'reexportation', label: 'Réexportation', direction: 'export' },
  { key: 'perfectionnement_passif', label: 'Perfectionnement passif', direction: 'export' },
  { key: 'transit', label: 'Transit', direction: 'both' },
  { key: 'autre', label: 'Autre régime', direction: 'both' },
];

export const TRANSPORT_MODES = [
  { key: 'maritime', label: 'Maritime', docLabel: 'Connaissement (BL)', carrierLabel: 'Navire' },
  { key: 'aerien', label: 'Aérien', docLabel: 'Lettre de transport aérien (LTA)', carrierLabel: 'Vol' },
  { key: 'routier', label: 'Routier', docLabel: 'Lettre de voiture (CMR)', carrierLabel: 'Camion' },
  { key: 'autre', label: 'Autre', docLabel: 'Titre de transport', carrierLabel: 'Moyen de transport' },
];

/** Bureaux de douane (douane.gov.tn). `detail` asks the firm to name the exact place. */
export const CUSTOMS_OFFICES = [
  { key: 'rades', label: 'Radès Port' },
  { key: 'goulette_nord', label: 'La Goulette-Nord' },
  { key: 'goulette_sud', label: 'La Goulette-Sud (Radès Malaha)' },
  { key: 'bizerte', label: 'Bizerte Port' },
  { key: 'sousse', label: 'Sousse Port' },
  { key: 'sfax', label: 'Sfax Port' },
  { key: 'gabes', label: 'Gabès Ghannouch' },
  { key: 'zarzis', label: 'Zarzis Port' },
  { key: 'tunis_carthage', label: 'Aéroport Tunis-Carthage' },
  { key: 'enfidha', label: 'Aéroport Enfidha-Hammamet' },
  { key: 'monastir', label: 'Aéroport Monastir' },
  { key: 'sfax_aeroport', label: 'Aéroport Sfax-Thyna' },
  { key: 'djerba', label: 'Aéroport Djerba-Zarzis' },
  { key: 'ras_jedir', label: 'Ras Jedir (frontière libyenne)' },
  { key: 'frontiere_algerie', label: 'Frontière algérienne', detail: true },
  { key: 'mad', label: 'Magasin et aire de dédouanement (MAD)', detail: true },
  { key: 'bureau_rattachement', label: 'Bureau de rattachement', detail: true },
  { key: 'zone_franche', label: 'Zone franche (Bizerte / Zarzis)', detail: true },
  { key: 'autre', label: 'Autre bureau', detail: true },
];

// ---------- Documents ----------

/**
 * Document types. `responsible`: client (the client sends it), tiers (a third party issues it),
 * cabinet (the firm hands it back to the client). `required` items are added to every new dossier
 * of the matching direction; the others are added on request.
 */
export const DOC_TYPES = [
  { key: 'titre_commerce', label: 'Facture définitive domiciliée par votre banque (ou autorisation)', applies: 'both', responsible: 'client', required: true },
  { key: 'liste_colisage', label: 'Liste de colisage', applies: 'both', responsible: 'client', required: true },
  { key: 'titre_transport', label: 'Copie du titre de transport (connaissement, LTA ou CMR)', applies: 'import', responsible: 'client', required: true },
  { key: 'bl_original', label: 'Connaissement original ou endossé par la banque (ou télex release)', applies: 'import', responsible: 'client', required: false },
  { key: 'fret_assurance', label: 'Facture de fret et attestation d’assurance', applies: 'import', responsible: 'client', required: false },
  { key: 'certificat_origine', label: "Certificat d'origine (EUR.1, EUR-MED ou déclaration sur facture)", applies: 'both', responsible: 'client', required: false },
  { key: 'surveillance_prealable', label: 'Fiche de surveillance préalable', applies: 'import', responsible: 'client', required: false },
  { key: 'dossier_technique', label: 'Dossier du contrôle technique (fiche technique, étiquetage, certificats d’analyse)', applies: 'both', responsible: 'client', required: false },
  { key: 'certificat_sanitaire', label: 'Certificat sanitaire, phytosanitaire ou vétérinaire', applies: 'both', responsible: 'client', required: false },
  { key: 'declaration_export_pays', label: "Déclaration d'exportation du pays d'expédition (pas de déclaration de transit)", applies: 'import', responsible: 'client', required: false },
  { key: 'avantage_fiscal', label: 'Documents d’avantage fiscal (attestation, soumission)', applies: 'import', responsible: 'client', required: false },
  { key: 'reservation', label: 'Confirmation de réservation du transport (booking)', applies: 'export', responsible: 'client', required: false },
  { key: 'mandat', label: 'Mandat de dédouanement signé', applies: 'both', responsible: 'client', required: false },
  { key: 'avis_arrivee', label: "Avis d'arrivée", applies: 'import', responsible: 'tiers', required: false },
  { key: 'bon_mise_a_quai', label: 'Bon de mise à quai', applies: 'export', responsible: 'tiers', required: false },
  { key: 'remise_declaration', label: 'Copie de la déclaration en douane', applies: 'import', responsible: 'cabinet', required: true },
  { key: 'remise_bae', label: 'Bon à enlever (BAE)', applies: 'import', responsible: 'cabinet', required: true },
  { key: 'remise_quittance', label: 'Quittance des droits et taxes', applies: 'import', responsible: 'cabinet', required: true },
  { key: 'remise_tce', label: 'Facture visée par la douane, à remettre à votre banque', applies: 'both', responsible: 'cabinet', required: true },
  { key: 'remise_declaration_export', label: "Déclaration d'exportation visée à l'embarquement", applies: 'export', responsible: 'cabinet', required: true },
  { key: 'remise_origine', label: "Certificat d'origine visé", applies: 'export', responsible: 'cabinet', required: false },
  { key: 'autre', label: 'Autre document', applies: 'both', responsible: 'client', required: false },
];

export const RESPONSIBLES = [
  { key: 'client', label: 'Le client' },
  { key: 'tiers', label: 'Un autre intervenant' },
  { key: 'cabinet', label: 'Le cabinet (à remettre au client)' },
];

/** Statuses a document can take, depending on who provides it. */
export const DOC_STATUS = [
  { key: 'a_fournir', label: 'À fournir', for: ['client', 'tiers'] },
  { key: 'envoye', label: 'Envoyé, en attente de vérification', for: ['client', 'tiers'] },
  { key: 'recu', label: 'Reçu, en vérification', for: ['client', 'tiers'] },
  { key: 'a_corriger', label: 'À corriger', for: ['client', 'tiers'] },
  { key: 'valide', label: 'Reçu et validé', for: ['client', 'tiers'] },
  { key: 'a_venir', label: 'En préparation', for: ['cabinet'] },
  { key: 'remis', label: 'Remis', for: ['cabinet'] },
  { key: 'non_requis', label: 'Non requis', for: ['client', 'tiers', 'cabinet'] },
];

/** Statuses that mean the client still has something to send. */
export const DOC_CLIENT_TODO = ['a_fournir', 'a_corriger'];

// ---------- Invoices ----------

export const INVOICE_KINDS = [
  { key: 'facture', label: 'Facture' },
  { key: 'provision', label: 'Demande de provision' },
];

export const INVOICE_STATUS = [
  { key: 'a_payer', label: 'À payer' },
  { key: 'payee', label: 'Payée' },
  { key: 'annulee', label: 'Annulée' },
];

/**
 * Invoice line kinds. Honoraires and frais refacturés carry VAT; débours are sums paid in the
 * client's name, re-invoiced at cost without VAT and with the third party's receipt.
 */
export const LINE_KINDS = [
  { key: 'honoraires', label: 'Honoraires', taxable: true },
  { key: 'frais', label: 'Frais refacturés (soumis à TVA)', taxable: true },
  { key: 'debours', label: 'Débours (sans TVA)', taxable: false },
];

export const DEBOURS_CATEGORIES = [
  { key: 'droits_taxes', label: 'Droits et taxes de douane' },
  { key: 'port', label: 'Frais de port et de manutention' },
  { key: 'magasinage', label: 'Magasinage' },
  { key: 'transport', label: 'Transport' },
  { key: 'controles', label: 'Scanner, pesage et contrôles' },
  { key: 'certificats', label: 'Certificats et autorisations' },
  { key: 'agent', label: 'Agent maritime ou compagnie aérienne' },
  { key: 'autre', label: 'Autre débours' },
];

/** VAT rates in basis points (1900 = 19 %). */
export const VAT_RATES = [
  { key: '1900', label: '19 %' },
  { key: '1300', label: '13 %' },
  { key: '700', label: '7 %' },
  { key: '0', label: '0 % (exonéré ou en suspension)' },
];

export const DEFAULT_STAMP_MINOR = 1000; // droit de timbre : 1,000 DT par facture

/**
 * Totals of an invoice from its lines. VAT is computed per rate on the sum of the taxable lines,
 * rounded half up to the minor unit, with BigInt so large amounts stay exact.
 */
export function computeInvoiceTotals(lines, stampMinor = 0, deductionMinor = 0) {
  let taxable = 0n;
  let debours = 0n;
  const byRate = new Map();
  for (const line of lines) {
    const amount = BigInt(line.amount_minor);
    if (line.kind === 'debours') {
      debours += amount;
    } else {
      taxable += amount;
      const rate = BigInt(line.vat_rate_bp ?? 0);
      byRate.set(rate, (byRate.get(rate) ?? 0n) + amount);
    }
  }
  const vat = [...byRate.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([rate, base]) => ({ rate_bp: Number(rate), base_minor: base, vat_minor: (base * rate + 5000n) / 10000n }));
  const vatTotal = vat.reduce((sum, v) => sum + v.vat_minor, 0n);
  const gross = taxable + vatTotal + debours + BigInt(stampMinor);
  const net = gross - BigInt(deductionMinor);
  const toNumber = (value) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new RangeError('Montant trop élevé.');
    return n;
  };
  return {
    taxable_minor: toNumber(taxable),
    vat: vat.map((v) => ({ rate_bp: v.rate_bp, base_minor: toNumber(v.base_minor), vat_minor: toNumber(v.vat_minor) })),
    vat_minor: toNumber(vatTotal),
    debours_minor: toNumber(debours),
    stamp_minor: toNumber(stampMinor),
    gross_minor: toNumber(gross),
    deduction_minor: toNumber(deductionMinor),
    net_minor: toNumber(net),
  };
}

// ---------- Tasks ----------

export const TASK_STATUS = [
  { key: 'nouvelle', label: 'Nouvelle' },
  { key: 'en_cours', label: 'En cours' },
  { key: 'terminee', label: 'Terminée' },
  { key: 'refusee', label: 'Refusée' },
];

export const PRIORITY = [
  { key: 'basse', label: 'Basse' },
  { key: 'normale', label: 'Normale' },
  { key: 'haute', label: 'Haute' },
];

// ---------- Label maps (for validation and display) ----------

export const LABELS = {
  direction: toMap(DIRECTIONS),
  stage: toMap(STAGES),
  hold: toMap(HOLDS),
  circuit: toMap(CIRCUITS),
  ct: toMap(CT_STATUS),
  regime: toMap(REGIMES),
  transport: toMap(TRANSPORT_MODES),
  office: toMap(CUSTOMS_OFFICES),
  docType: toMap(DOC_TYPES),
  responsible: toMap(RESPONSIBLES),
  docStatus: toMap(DOC_STATUS),
  invoiceKind: toMap(INVOICE_KINDS),
  invoiceStatus: toMap(INVOICE_STATUS),
  lineKind: toMap(LINE_KINDS),
  debours: toMap(DEBOURS_CATEGORIES),
  vat: toMap(VAT_RATES),
  taskStatus: toMap(TASK_STATUS),
  priority: toMap(PRIORITY),
};

export const byKey = (list, key) => list.find((item) => item.key === key);

// ---------- Dossier rules ----------

export function stagesFor(direction) {
  return STAGES.filter((s) => s.applies === 'both' || s.applies === direction);
}

export function stageExplain(stage, direction) {
  return typeof stage.explain === 'string' ? stage.explain : stage.explain[direction];
}

export function isClosed(dossier) {
  return dossier.stage === 'termine' || dossier.hold === 'annule';
}

/** SQL condition matching open dossiers (alias d). Must stay equivalent to isClosed. */
export const OPEN_DOSSIER_SQL = "(d.stage != 'termine' AND (d.hold IS NULL OR d.hold != 'annule'))";

export function progressOf(dossier) {
  if (dossier.hold === 'annule') return null;
  return byKey(STAGES, dossier.stage)?.pct ?? 0;
}

/**
 * Who the dossier is waiting on, as a key of WAITING, or null.
 * A hold wins; then missing client documents; then unpaid duties the client pays; then the step's default.
 */
export function waitingOn(dossier, missingDocs = 0) {
  switch (dossier.hold) {
    case 'attente_client':
    case 'attente_paiement':
      return 'client';
    case 'litige':
    case 'infraction':
      return 'douane';
    case 'bloque':
    case 'annule':
      return null;
    default:
      break;
  }
  if (dossier.stage === 'termine') return null;
  if (missingDocs > 0) return 'client';
  if (dossier.stage === 'droits' && dossier.duties_payer === 'client' && !dossier.duties_paid_on) return 'client';
  return byKey(STAGES, dossier.stage)?.waiting ?? null;
}

// ---------- Formatting ----------

export function createFormatters({ currency = 'TND', timeZone = 'Africa/Tunis', now = () => new Date() } = {}) {
  const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency });
  const digits = money.resolvedOptions().maximumFractionDigits;
  const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone });
  const dateOnly = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'UTC' });
  const isoDay = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone });
  const today = () => isoDay.format(now());

  return {
    currency,
    digits,
    money: (minor) => money.format(minor / 10 ** digits),
    /** Parses "1 234,500" or "1234.5" into minor units, or returns null. */
    parseMoney(text) {
      const cleaned = String(text ?? '').replace(/[\s  ]/g, '').replace(',', '.');
      const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(cleaned);
      if (!m) return null;
      const fraction = m[2] ?? '';
      if (fraction.length > digits) return null;
      const minor = Number(m[1]) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
      return Number.isSafeInteger(minor) ? minor : null;
    },
    /** Minor units back to the form input format ("1250,500"). */
    moneyInput(minor) {
      if (minor == null) return '';
      const s = String(minor).padStart(digits + 1, '0');
      return digits ? `${s.slice(0, -digits)},${s.slice(-digits)}` : s;
    },
    dateTime: (iso) => (iso ? dateTime.format(new Date(iso)) : ''),
    date: (day) => (day ? dateOnly.format(new Date(`${day}T00:00:00Z`)) : ''),
    today,
    /** YYYY-MM-DD shifted by a number of days from today. */
    dayFromToday(days) {
      const d = new Date(`${today()}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    },
  };
}

export function isOverdue(invoice, today) {
  return invoice.status === 'a_payer' && invoice.due_on < today;
}

export function invoiceStatus(invoice, today) {
  if (isOverdue(invoice, today)) return { key: 'en_retard', label: 'En retard' };
  return { key: invoice.status, label: LABELS.invoiceStatus[invoice.status] ?? invoice.status };
}
