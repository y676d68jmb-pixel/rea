import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/security.js';

/** Tiny browser: keeps the session cookie and reads the CSRF token from pages. */
export class Browser {
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


/** Starts the portal on an in-memory database with one admin (admin / admin-password-1). */
export async function startPortal(clock) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (login, password_hash, role, name, must_change_password, created_at) VALUES ('admin', ?, 'admin', 'Cabinet', 0, ?)").run(
    await hashPassword('admin-password-1'),
    clock.now.toISOString(),
  );
  const server = createServer(createApp({ db, siteName: 'Portail test', now: () => clock.now }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db,
    base,
    one: (sql, ...params) => db.prepare(sql).get(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params),
    close() {
      server.close();
      db.close();
    },
  };
}

/** Creates a client from the admin page and returns its one-time credentials. */
export async function createClient(portal, admin, name) {
  const page = await admin.follow(await admin.post('/admin/clients', { name, company: `${name} SARL`, email: '', phone: '' }));
  const m = /Identifiant : (CL-\d{4}) — mot de passe provisoire : (\w+)/.exec(page.body);
  assert.ok(m, 'credentials shown once after creation');
  return { login: m[1], password: m[2], clientId: portal.one('SELECT id FROM users WHERE login = ?', m[1]).id };
}

/** Signs a client in, changing the temporary password on first login. */
export async function signInClient(portal, client) {
  const browser = new Browser(portal.base);
  const res = await browser.login(client.login, client.password);
  if (res.location === '/mot-de-passe') {
    const next = `${client.login}-new-password`;
    await browser.post('/mot-de-passe', { current: client.password, next, confirm: next });
    client.password = next;
  }
  return browser;
}
