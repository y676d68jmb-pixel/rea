import { readFileSync } from 'node:fs';
import { createFormatters } from './format.js';
import { HttpError, Router, SafeHtml, parseCookies, readForm, serializeCookie } from './http.js';
import { createQueries } from './queries.js';
import { registerAdminRoutes } from './routes-admin.js';
import { registerClientRoutes } from './routes-client.js';
import {
  LoginLimiter,
  MIN_PASSWORD_LENGTH,
  burnPasswordCheck,
  hashPassword,
  randomToken,
  safeEqual,
  sha256,
  verifyPassword,
} from './security.js';
import * as views from './views.js';

const SESSION_COOKIE = 'sid';
const SESSION_HOURS = 12;
const DEFAULT_STYLESHEET_URL = new URL('../public/style.css', import.meta.url);

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export function createApp({
  db,
  siteName = 'Espace client',
  documentsHint = 'Transmettez vos documents au cabinet par e-mail ou déposez-les au bureau, en indiquant la référence du dossier.',
  secureCookies = false,
  trustProxy = false,
  currency = 'TND',
  timeZone = 'Africa/Tunis',
  now = () => new Date(),
  stylesheet = readFileSync(DEFAULT_STYLESHEET_URL),
}) {
  const f = createFormatters({ currency, timeZone, now });
  const nowIso = () => now().toISOString();
  const loginLimiter = new LoginLimiter({ maxAttempts: 5, now: () => now().getTime() });
  const ipLimiter = new LoginLimiter({ maxAttempts: 30, now: () => now().getTime() });
  const passwordLimiter = new LoginLimiter({ maxAttempts: 5, now: () => now().getTime() });
  const router = new Router();
  const q = createQueries(db);

  // ---------- Sessions and flash messages ----------

  function startSession(res, userId) {
    q.purgeSessions.run(nowIso());
    const token = randomToken();
    const expires = new Date(now().getTime() + SESSION_HOURS * 3600 * 1000).toISOString();
    q.insertSession.run(sha256(token), userId, randomToken(), expires);
    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_HOURS * 3600, secure: secureCookies }));
    return sha256(token);
  }

  function flash(ctx, type, message) {
    if (!ctx.session) return;
    const list = ctx.session.flash ? JSON.parse(ctx.session.flash) : [];
    list.push({ type, text: message });
    ctx.session.flash = JSON.stringify(list);
    q.setFlash.run(ctx.session.flash, ctx.session.token_hash);
  }

  function takeFlash(ctx) {
    if (!ctx.session?.flash) return [];
    const list = JSON.parse(ctx.session.flash);
    q.setFlash.run(null, ctx.session.token_hash);
    return list;
  }

  // ---------- Responses ----------

  function send(res, status, body, type = 'text/html; charset=utf-8') {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
    res.end(body instanceof SafeHtml ? body.value : body);
  }

  function redirect(res, location) {
    res.writeHead(303, { ...SECURITY_HEADERS, Location: location });
    res.end();
  }

  function viewContext(ctx, flashList) {
    let todoCount = 0;
    if (ctx.user?.role === 'client' && !ctx.user.must_change_password) {
      try {
        todoCount = q.clientTodo(ctx.user.id, f).length;
      } catch {
        // The badge is a convenience; an error page must still render.
      }
    }
    return { user: ctx.user, csrf: ctx.session?.csrf, flash: flashList, f, siteName, documentsHint, todoCount, path: ctx.path };
  }

  function render(ctx, page, data, status = 200) {
    send(ctx.res, status, views[page](viewContext(ctx, takeFlash(ctx)), data));
  }

  const logEvent = (clientId, dossierId, actorId, message) =>
    q.insertEvent.run(clientId, dossierId ?? null, actorId ?? null, message, nowIso());

  const deps = { db, q, f, router, flash, render, redirect, logEvent, nowIso };

  // ---------- Public routes ----------

  router.get('/', (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/connexion');
    return redirect(ctx.res, ctx.user.role === 'admin' ? '/admin' : '/espace');
  });

  router.get('/static/style.css', (ctx) => {
    ctx.res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    ctx.res.end(stylesheet);
  });

  router.get('/connexion', (ctx) => {
    if (ctx.user) return redirect(ctx.res, '/');
    render(ctx, 'loginPage', {});
  });

  router.post('/connexion', async (ctx) => {
    const login = String(ctx.form.login ?? '').trim().slice(0, 100);
    const password = String(ctx.form.password ?? '').slice(0, 200);
    const key = `${ctx.ip}|${login.toLowerCase()}`;
    if (loginLimiter.isBlocked(key) || ipLimiter.isBlocked(ctx.ip)) {
      return render(ctx, 'loginPage', { login, error: 'Trop de tentatives. Réessayez dans 15 minutes.' }, 429);
    }
    // Count the attempt before the slow password check, so simultaneous guesses cannot all slip through.
    loginLimiter.fail(key);
    ipLimiter.fail(ctx.ip);
    const user = login ? q.userByLogin.get(login) : undefined;
    const ok = user && user.active ? await verifyPassword(password, user.password_hash) : (await burnPasswordCheck(password), false);
    if (!ok) return render(ctx, 'loginPage', { login, error: 'Identifiant ou mot de passe incorrect.' }, 401);
    loginLimiter.reset(key);
    ipLimiter.undo(ctx.ip);
    if (ctx.session) q.deleteSession.run(ctx.session.token_hash);
    startSession(ctx.res, user.id);
    redirect(ctx.res, user.must_change_password ? '/mot-de-passe' : '/');
  });

  router.post('/deconnexion', (ctx) => {
    if (ctx.session) q.deleteSession.run(ctx.session.token_hash);
    ctx.res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: secureCookies }));
    redirect(ctx.res, '/connexion');
  });

  router.get('/mot-de-passe', (ctx) => render(ctx, 'changePasswordPage', {}));

  router.post('/mot-de-passe', async (ctx) => {
    const { current = '', next = '', confirm = '' } = ctx.form;
    const fail = (error) => render(ctx, 'changePasswordPage', { error }, 400);
    const user = q.userById.get(ctx.user.id);
    const key = `user:${user.id}`;
    if (passwordLimiter.isBlocked(key)) {
      return render(ctx, 'changePasswordPage', { error: 'Trop de tentatives. Réessayez dans 15 minutes.' }, 429);
    }
    passwordLimiter.fail(key);
    if (!(await verifyPassword(current, user.password_hash))) return fail('Le mot de passe actuel est incorrect.');
    passwordLimiter.reset(key);
    if (next.length < MIN_PASSWORD_LENGTH) return fail(`Le nouveau mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`);
    if (next.length > 200) return fail('Le nouveau mot de passe est trop long.');
    if (next !== confirm) return fail('Les deux mots de passe ne correspondent pas.');
    if (next === current) return fail("Le nouveau mot de passe doit être différent de l'ancien.");
    const hash = await hashPassword(next);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, user.id);
    // Sign out every other device and rotate the current session.
    q.deleteUserSessions.run(user.id);
    ctx.session = { token_hash: startSession(ctx.res, user.id), flash: null };
    flash(ctx, 'success', 'Votre mot de passe a été modifié.');
    redirect(ctx.res, '/');
  });

  registerClientRoutes(deps);
  registerAdminRoutes(deps);

  // ---------- Request pipeline ----------

  function loadSession(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return {};
    const row = q.session.get(sha256(token), nowIso());
    if (!row) return {};
    const { token_hash, csrf, flash: pending, ...user } = row;
    return { session: { token_hash, csrf, flash: pending }, user };
  }

  function clientIp(req) {
    if (trustProxy) {
      // The last entry is the address our own proxy saw; earlier ones can be forged by the visitor.
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1).trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function authorize(ctx, pathname) {
    const isPublic = pathname === '/' || pathname === '/connexion' || pathname.startsWith('/static/');
    if (isPublic) return true;
    if (!ctx.user) {
      if (ctx.method === 'GET') redirect(ctx.res, '/connexion');
      else throw new HttpError(401, 'Session expirée, veuillez vous reconnecter.');
      return false;
    }
    if (ctx.user.must_change_password && pathname !== '/mot-de-passe' && pathname !== '/deconnexion') {
      if (ctx.method === 'GET') redirect(ctx.res, '/mot-de-passe');
      else throw new HttpError(403, "Veuillez d'abord changer votre mot de passe.");
      return false;
    }
    if (pathname.startsWith('/admin') && ctx.user.role !== 'admin') throw new HttpError(404, 'Page introuvable.');
    if (pathname.startsWith('/espace') && ctx.user.role !== 'client') throw new HttpError(404, 'Page introuvable.');
    return true;
  }

  return async function handle(req, res) {
    const ctx = { req, res, method: req.method, ip: clientIp(req), form: {}, query: new URLSearchParams() };
    try {
      const url = new URL(req.url, 'http://localhost');
      ctx.path = url.pathname;
      ctx.query = url.searchParams;
      Object.assign(ctx, loadSession(req));
      const match = router.match(req.method === 'HEAD' ? 'GET' : req.method, url.pathname);
      if (!match) throw new HttpError(404, 'Page introuvable.');
      if (match.methodNotAllowed) throw new HttpError(405, 'Méthode non autorisée.');
      ctx.params = match.params;

      if (req.method === 'POST') {
        if (!sameOrigin(req)) throw new HttpError(403, 'Requête refusée.');
        ctx.form = await readForm(req);
        // Login creates a fresh session, so it has no CSRF token yet; the origin check covers it.
        if (ctx.session && url.pathname !== '/connexion' && !safeEqual(ctx.form._csrf ?? '', ctx.session.csrf)) {
          throw new HttpError(403, 'Formulaire expiré. Rechargez la page et réessayez.');
        }
      }
      if (!authorize(ctx, url.pathname)) return;
      await match.handler(ctx);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      if (error instanceof HttpError && error.status === 400 && ctx.back && ctx.session) {
        flash(ctx, 'error', error.message);
        return redirect(res, ctx.back);
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      const message = status === 500 ? 'Une erreur inattendue est survenue.' : error.message;
      send(res, status, views.errorPage(viewContext(ctx, []), status, message));
    }
  };
}

function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return origin !== 'null';
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
