import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SchemaError, migrateDb, openDb } from '../src/db.js';
import {
  DOC_TYPES,
  HOLDS,
  OPEN_DOSSIER_SQL,
  STAGES,
  computeInvoiceTotals,
  createFormatters,
  isClosed,
  progressOf,
  stagesFor,
  waitingOn,
} from '../src/format.js';
import { HttpError } from '../src/http.js';
import { day, integer, money, oneOf } from '../src/validate.js';

describe('invoice totals', () => {
  test('adds VAT per rate on fees, débours without VAT, stamp, minus provisions', () => {
    const totals = computeInvoiceTotals(
      [
        { kind: 'honoraires', amount_minor: 1_000_000, vat_rate_bp: 1900 },
        { kind: 'frais', amount_minor: 50_000, vat_rate_bp: 1900 },
        { kind: 'frais', amount_minor: 20_000, vat_rate_bp: 700 },
        { kind: 'debours', amount_minor: 500_000, vat_rate_bp: null },
      ],
      1000,
      300_000,
    );
    assert.equal(totals.taxable_minor, 1_070_000);
    assert.deepEqual(totals.vat, [
      { rate_bp: 1900, base_minor: 1_050_000, vat_minor: 199_500 },
      { rate_bp: 700, base_minor: 20_000, vat_minor: 1_400 },
    ]);
    assert.equal(totals.debours_minor, 500_000);
    assert.equal(totals.gross_minor, 1_070_000 + 200_900 + 500_000 + 1000);
    assert.equal(totals.net_minor, totals.gross_minor - 300_000);
  });

  test('rounds VAT half up on the per-rate sum, exactly for large amounts', () => {
    assert.equal(computeInvoiceTotals([{ kind: 'honoraires', amount_minor: 25, vat_rate_bp: 1900 }]).vat_minor, 5); // 4.75
    assert.equal(computeInvoiceTotals([{ kind: 'honoraires', amount_minor: 5, vat_rate_bp: 700 }]).vat_minor, 0); // 0.35
    const big = computeInvoiceTotals([{ kind: 'honoraires', amount_minor: 999_999_999_999, vat_rate_bp: 1900 }]);
    assert.equal(big.vat_minor, 190_000_000_000); // 189 999 999 999.81
    assert.throws(() => computeInvoiceTotals([{ kind: 'debours', amount_minor: Number.MAX_SAFE_INTEGER }], Number.MAX_SAFE_INTEGER), RangeError);
  });
});

describe('dossier rules', () => {
  test('each direction gets its own ordered steps', () => {
    const imp = stagesFor('import').map((s) => s.key);
    const exp = stagesFor('export').map((s) => s.key);
    assert.ok(imp.includes('arrivee') && !imp.includes('embarquement'));
    assert.ok(exp.includes('embarquement') && !exp.includes('arrivee'));
    for (const list of [imp, exp]) {
      assert.equal(list[0], 'ouverture');
      assert.equal(list.at(-1), 'termine');
      const pcts = list.map((k) => STAGES.find((s) => s.key === k).pct);
      assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b), 'progress grows along the steps');
    }
  });

  test('a hold decides who the dossier waits on, then missing documents, then duties', () => {
    const base = { stage: 'controle', hold: null, duties_payer: null, duties_paid_on: null };
    assert.equal(waitingOn(base), 'douane');
    assert.equal(waitingOn(base, 2), 'client');
    assert.equal(waitingOn({ ...base, hold: 'attente_paiement' }), 'client');
    assert.equal(waitingOn({ ...base, hold: 'infraction' }), 'douane');
    assert.equal(waitingOn({ ...base, hold: 'bloque' }), null);
    assert.equal(waitingOn({ ...base, stage: 'droits', duties_payer: 'client' }), 'client');
    assert.equal(waitingOn({ ...base, stage: 'droits', duties_payer: 'client', duties_paid_on: '2026-10-01' }), 'cabinet');
    assert.equal(waitingOn({ ...base, stage: 'termine' }, 3), null);
  });

  test('a cancelled dossier has no progress bar and counts as closed', () => {
    assert.equal(progressOf({ stage: 'controle', hold: 'annule' }), null);
    assert.equal(progressOf({ stage: 'controle', hold: null }), 60);
  });

  test('the SQL "open dossier" filter matches isClosed for every stage and hold', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO users (id, login, password_hash, role, name, created_at) VALUES (1, 'c', 'x', 'client', 'C', 'now')").run();
    const insert = db.prepare(
      "INSERT INTO dossiers (client_id, reference, direction, title, stage, hold, created_at, updated_at) VALUES (1, ?, 'import', 't', ?, ?, 'now', 'now')",
    );
    let n = 0;
    for (const stage of STAGES) for (const hold of [null, ...HOLDS.map((h) => h.key)]) insert.run(`R${n++}`, stage.key, hold);
    const open = new Set(db.prepare(`SELECT reference FROM dossiers d WHERE ${OPEN_DOSSIER_SQL}`).all().map((r) => r.reference));
    for (const row of db.prepare('SELECT * FROM dossiers').all()) assert.equal(open.has(row.reference), !isClosed(row), row.reference);
  });

  test('every required document belongs to a known responsible party', () => {
    for (const type of DOC_TYPES) assert.ok(['client', 'tiers', 'cabinet'].includes(type.responsible), type.key);
  });
});

describe('form parsing', () => {
  const f = createFormatters({ currency: 'TND' });
  test('money uses millimes and refuses more than 3 decimals', () => {
    assert.equal(money({ a: '1 250,5' }, 'a', f), 1_250_500);
    assert.equal(money({ a: '' }, 'a', f), null);
    assert.throws(() => money({ a: '1,2345' }, 'a', f), HttpError);
    assert.equal(f.moneyInput(1_250_500), '1250,500');
    assert.equal(f.moneyInput(5), '0,005');
  });
  test('dates, integers and lists are checked', () => {
    assert.throws(() => day({ d: '2026-02-30' }, 'd'), HttpError);
    assert.equal(day({ d: '2026-02-28' }, 'd'), '2026-02-28');
    assert.equal(integer({ n: '12' }, 'n'), 12);
    assert.throws(() => integer({ n: '-1' }, 'n'), HttpError);
    assert.equal(oneOf({ k: '' }, 'k', { a: 'A' }, { required: false }), null);
    assert.throws(() => oneOf({ k: 'b' }, 'k', { a: 'A' }), HttpError);
  });
});

describe('database versions', () => {
  test('a new database gets the current schema', () => {
    const db = openDb(':memory:');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  });

  test('a database from the early trial version is refused instead of being modified', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    assert.throws(() => migrateDb(db), SchemaError);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
  });

  test('a database newer than the code is refused', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA user_version = 9');
    assert.throws(() => migrateDb(db), SchemaError);
  });

  test('a later step backs up the file first, applies once, and rolls back on failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portail-'));
    try {
      const file = join(dir, 'portail.db');
      openDb(file).close();
      const step = { version: 2, up: (db) => db.exec("ALTER TABLE dossiers ADD COLUMN vessel_eta TEXT NOT NULL DEFAULT ''") };

      const db = openDb(file, { migrate: false });
      migrateDb(db, file, [step]);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
      assert.ok(existsSync(`${file}.avant-v2.db`), 'backup taken before the change');
      migrateDb(db, file, [step]); // second run is a no-op
      db.close();

      const failing = { version: 3, up: (d) => d.exec('ALTER TABLE nope ADD COLUMN x TEXT') };
      const db2 = openDb(file, { migrate: false });
      assert.throws(() => migrateDb(db2, file, [step, failing]));
      assert.equal(db2.prepare('PRAGMA user_version').get().user_version, 2);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
