/** Labels, dates and money formatting (French). */

export const DOSSIER_STATUS = {
  ouvert: 'Ouvert',
  en_cours: 'En cours',
  attente_client: 'En attente de votre part',
  suspendu: 'Suspendu',
  termine: 'Terminé',
};

export const INVOICE_STATUS = {
  a_payer: 'À payer',
  payee: 'Payée',
  annulee: 'Annulée',
};

export const TASK_STATUS = {
  nouvelle: 'Nouvelle',
  en_cours: 'En cours',
  terminee: 'Terminée',
  refusee: 'Refusée',
};

export const PRIORITY = {
  basse: 'Basse',
  normale: 'Normale',
  haute: 'Haute',
};

export function createFormatters({ currency = 'TND', timeZone = 'Africa/Tunis', now = () => new Date() } = {}) {
  const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency });
  const digits = money.resolvedOptions().maximumFractionDigits;
  const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone });
  const dateOnly = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'UTC' });
  const isoDay = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone });

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
    dateTime: (iso) => (iso ? dateTime.format(new Date(iso)) : ''),
    date: (day) => (day ? dateOnly.format(new Date(`${day}T00:00:00Z`)) : ''),
    today: () => isoDay.format(now()),
  };
}

export function isOverdue(invoice, today) {
  return invoice.status === 'a_payer' && invoice.due_on < today;
}

export function invoiceStatus(invoice, today) {
  if (isOverdue(invoice, today)) return { key: 'en_retard', label: 'En retard' };
  return { key: invoice.status, label: INVOICE_STATUS[invoice.status] ?? invoice.status };
}
