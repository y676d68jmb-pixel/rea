/** Form field parsers. Each returns the clean value or throws HttpError(400) with a French message. */
import { HttpError } from './http.js';

export function text(form, key, { max = 200, required = false, label = key } = {}) {
  const value = String(form[key] ?? '').trim();
  if (required && !value) throw new HttpError(400, `Le champ « ${label} » est obligatoire.`);
  if (value.length > max) throw new HttpError(400, `Le champ « ${label} » est trop long (${max} caractères maximum).`);
  return value;
}

/** A key of the label map, or null when empty and optional. */
export function oneOf(form, key, labels, { required = true, label = key } = {}) {
  const value = String(form[key] ?? '');
  if (!value && !required) return null;
  if (!Object.hasOwn(labels, value)) throw new HttpError(400, `Valeur invalide pour « ${label} ».`);
  return value;
}

export function integer(form, key, { min = 0, max = 1_000_000_000, required = false, label = key } = {}) {
  const value = String(form[key] ?? '').trim();
  if (!value) {
    if (required) throw new HttpError(400, `Le champ « ${label} » est obligatoire.`);
    return null;
  }
  if (!/^\d{1,12}$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new HttpError(400, `Nombre invalide pour « ${label} » (entre ${min} et ${max}).`);
  }
  return Number(value);
}

export function day(form, key, { required = false, label = key } = {}) {
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

/** Money in minor units using the formatter's parser, or null when empty and optional. */
export function money(form, key, f, { required = false, label = key } = {}) {
  const raw = String(form[key] ?? '').trim();
  if (!raw) {
    if (required) throw new HttpError(400, `Le champ « ${label} » est obligatoire.`);
    return null;
  }
  const value = f.parseMoney(raw);
  if (value === null) throw new HttpError(400, `Montant invalide pour « ${label} » (exemple : 1 250,500).`);
  return value;
}

export function checkbox(form, key) {
  return form[key] === '1' || form[key] === 'on';
}

export function idParam(value) {
  if (!/^\d{1,15}$/.test(value)) throw new HttpError(404, 'Page introuvable.');
  return Number(value);
}
