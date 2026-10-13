// Mock of nginx (static + headers) + control-plane /api/v1 + Keycloak OIDC,
// for headless E2E tests of the UI. Mirrors the real contracts.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SITE = process.argv[2];
const PORT = Number(process.argv[3] || 9100);
const ORIGIN = `http://localhost:${PORT}`;
const KC = `${ORIGIN}/kc/realms/observability/protocol/openid-connect`;

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' http: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

const log = { refresh: 0, calls: [] };
let n = 0;
const uuid = () => crypto.randomUUID();
const now = () => new Date();
const iso = (d) => d.toISOString();
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

// ------------------------------------------------------------- state
const S = {
  tenants: [
    { tenantKey: 'alpha-tenant', vmAccountId: '2', grafanaOrgId: 2, status: 'active', createdAt: ago(60 * 24 * 9) },
    { tenantKey: 'beta-tenant', vmAccountId: '3', grafanaOrgId: null, status: 'active', createdAt: ago(30) },
  ],
  users: [
    { id: uuid(), tenantKey: null, username: 'dat', email: 'dat@example.com', firstName: 'Dat', lastName: 'Le', role: 'platform-admin', enabled: true, createdAt: ago(60 * 24 * 20) },
    { id: uuid(), tenantKey: 'alpha-tenant', username: 'alpha-admin', email: 'alpha-admin@example.com', firstName: 'Alpha', lastName: 'Admin', role: 'tenant-admin', enabled: true, createdAt: ago(60 * 24 * 8) },
    { id: uuid(), tenantKey: 'alpha-tenant', username: 'alpha-viewer', email: 'alpha-viewer@example.com', firstName: 'Alpha', lastName: 'Viewer', role: 'viewer', enabled: true, createdAt: ago(60 * 24 * 7) },
    { id: uuid(), tenantKey: 'alpha-tenant', username: 'off-user', email: 'off@example.com', firstName: 'Off', lastName: 'User', role: 'viewer', enabled: false, createdAt: ago(60 * 5) },
  ],
  agents: [
    { id: uuid(), tenantKey: 'alpha-tenant', clientId: `otel-agent-${uuid()}`, status: 'active', createdAt: ago(60 * 24 * 6) },
    { id: uuid(), tenantKey: 'alpha-tenant', clientId: `otel-agent-${uuid()}`, status: 'disabled', createdAt: ago(60 * 24 * 3) },
    { id: uuid(), tenantKey: 'alpha-tenant', clientId: `otel-agent-${uuid()}`, status: 'revoked', createdAt: ago(60 * 24 * 2) },
  ],
  enrollments: [],
  grants: [],
  tokens: {}, // access token -> { username, exp }
  codes: {}, // code -> { username, challenge, redirect }
};
S.enrollments.push(
  { id: uuid(), tenantKey: 'alpha-tenant', createdBy: 'alpha-admin', createdAt: ago(60 * 24 * 6), expiresAt: ago(60 * 24 * 6 - 10), usedAt: ago(60 * 24 * 6 - 3), revokedAt: null, revokedBy: null, agentId: S.agents[0].id },
  { id: uuid(), tenantKey: 'alpha-tenant', createdBy: 'dat', createdAt: ago(120), expiresAt: ago(110), usedAt: null, revokedAt: null, revokedBy: null, agentId: null },
  { id: uuid(), tenantKey: 'alpha-tenant', createdBy: 'dat', createdAt: ago(3), expiresAt: new Date(Date.now() + 7 * 60000).toISOString(), usedAt: null, revokedAt: null, revokedBy: null, agentId: null },
);
S.grants.push(
  { id: uuid(), tenantKey: 'alpha-tenant', username: 'dat', role: 'Viewer', reason: 'TICKET-7 alpha dashboards empty since deploy', grantedBy: 'dat', createdAt: ago(20), expiresAt: new Date(Date.now() + 40 * 60000).toISOString(), revokedAt: null, revokedBy: null },
  { id: uuid(), tenantKey: 'alpha-tenant', username: 'dat', role: 'Editor', reason: 'TICKET-3 fix broken panel query', grantedBy: 'dat', createdAt: ago(60 * 30), expiresAt: ago(60 * 29), revokedAt: null, revokedBy: null },
);
let nextVm = 4;
const usedKeys = new Set(S.tenants.map((t) => t.tenantKey));

// Login identities (Keycloak side) that are not in control-plane DB.
const KC_ONLY = { ghost: 'not_registered' };

const enrollmentState = (e) => (e.usedAt ? 'used' : e.revokedAt ? 'revoked' : new Date(e.expiresAt) < now() ? 'expired' : 'pending');
const enrollmentView = (e) => ({ ...e, agentId: e.usedAt ? e.agentId : null, state: enrollmentState(e) });
const agentView = (a) => ({ ...a, enabled: a.status === 'active' });
const grantView = (g) => ({ ...g, active: g.revokedAt === null && new Date(g.expiresAt) > now() });

// ------------------------------------------------------------- helpers
function send(res, status, body, headers = {}) {
  const rid = `rid-${(n += 1)}`;
  res.writeHead(status, { 'X-Request-Id': rid, ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}
function fail(res, status, code, message, details) {
  send(res, status, { error: { code, message, ...(details ? { details } : {}) }, requestId: `rid-${n + 1}` });
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

// ------------------------------------------------------------- keycloak
function keycloak(req, res, url) {
  const p = url.pathname.replace('/kc/realms/observability/protocol/openid-connect', '');
  if (p === '/auth') {
    const q = url.searchParams;
    if (q.get('client_id') !== 'control-plane-ui' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || q.get('response_type') !== 'code') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('bad auth request');
    }
    const links = ['dat', 'alpha-admin', 'alpha-viewer', 'off-user', 'ghost', 'shortlived'].map((u) => {
      const code = `code-${u}-${(n += 1)}`;
      S.codes[code] = { username: u, challenge: q.get('code_challenge'), redirect: q.get('redirect_uri') };
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      return `<a id="login-${u}" href="${back}">${u}</a>`;
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!doctype html><title>Keycloak (mock)</title><h1>Mock Keycloak</h1>${links.join('<br>')}`);
  }
  if (p === '/token' && req.method === 'POST') {
    // CORS like Keycloak webOrigins (not needed same-origin, kept for realism)
    return readBody(req).then((raw) => {
      const f = new URLSearchParams(raw);
      if (f.get('client_id') !== 'control-plane-ui') return send(res, 401, { error: 'invalid_client' });
      let username;
      if (f.get('grant_type') === 'authorization_code') {
        const c = S.codes[f.get('code')];
        delete S.codes[f.get('code')];
        if (!c) return send(res, 400, { error: 'invalid_grant', error_description: 'Code not valid' });
        const challenge = crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url');
        if (challenge !== c.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        if (f.get('redirect_uri') !== c.redirect) return send(res, 400, { error: 'invalid_grant', error_description: 'Incorrect redirect_uri' });
        username = c.username;
      } else if (f.get('grant_type') === 'refresh_token') {
        log.refresh += 1;
        username = (f.get('refresh_token') || '').replace(/^rt-/, '');
      } else {
        return send(res, 400, { error: 'unsupported_grant_type' });
      }
      const access = `at-${username}-${(n += 1)}`;
      const ttl = username === 'shortlived' ? 33 : 300;
      S.tokens[access] = { username: username === 'shortlived' ? 'dat' : username, exp: Date.now() + ttl * 1000 };
      send(res, 200, { access_token: access, refresh_token: `rt-${username}`, id_token: `id-${username}`, expires_in: ttl, token_type: 'Bearer' });
    });
  }
  if (p === '/logout') {
    const to = url.searchParams.get('post_logout_redirect_uri');
    res.writeHead(302, { Location: to || ORIGIN });
    return res.end();
  }
  res.writeHead(404);
  res.end();
}

// ------------------------------------------------------------- api
function validation(res, problems) {
  if (problems.length === 0) return false;
  fail(res, 400, 'validation_failed', 'Request validation failed', problems.map(([field, m]) => ({ field, messages: [m] })));
  return true;
}

async function apiRoute(req, res, url) {
  const p = url.pathname.replace(/^\/api\/v1/, '');
  log.calls.push(`${req.method} ${p}`);
  const auth = req.headers.authorization || '';
  const tok = S.tokens[auth.replace(/^Bearer /, '')];
  if (!tok || tok.exp < Date.now()) return fail(res, 401, 'unauthenticated', 'Invalid or expired access token');
  if (KC_ONLY[tok.username]) return fail(res, 403, 'not_registered', 'This account is not registered in control-plane');
  const actor = S.users.find((u) => u.username === tok.username);
  if (!actor) return fail(res, 403, 'not_registered', 'This account is not registered in control-plane');
  if (!actor.enabled) return fail(res, 403, 'account_disabled', 'This account is disabled');
  const body = req.method === 'POST' || req.method === 'PATCH' ? JSON.parse((await readBody(req)) || '{}') : {};
  const role = (...roles) => {
    if (!roles.includes(actor.role)) {
      fail(res, 403, 'forbidden', `Role ${actor.role} may not perform this operation`);
      return false;
    }
    return true;
  };
  const seg = p.split('/').filter(Boolean).map(decodeURIComponent);
  const M = req.method;

  if (M === 'GET' && p === '/me') return send(res, 200, actor);
  if (p === '/tenants' && M === 'GET') return role('platform-admin') && send(res, 200, { items: S.tenants.filter((t) => t.status === 'active') });
  if (p === '/tenants' && M === 'POST') {
    if (!role('platform-admin')) return;
    const key = String(body.tenantKey ?? '').trim();
    if (validation(res, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(key) ? [] : [['tenantKey', 'tenantKey must be 1-63 lowercase letters, digits or hyphens, not starting or ending with a hyphen']])) return;
    if (usedKeys.has(key)) return fail(res, 409, 'tenant_key_taken', 'Tenant key already used');
    usedKeys.add(key);
    const t = { tenantKey: key, vmAccountId: String(nextVm++), grafanaOrgId: null, status: 'active', createdAt: iso(now()) };
    S.tenants.push(t);
    setTimeout(() => (t.grafanaOrgId = Number(t.vmAccountId) + 10), 1500);
    return send(res, 201, t);
  }
  if (M === 'GET' && p === '/support-access') {
    if (!role('platform-admin')) return;
    const active = url.searchParams.get('active') === 'true';
    return send(res, 200, { items: S.grants.map(grantView).filter((g) => !active || g.active) });
  }
  if (p === '/admin/sync/status' && M === 'GET') {
    return role('platform-admin') && send(res, 200, {
      targets: { keycloak: { pending: 0, failing: 0, oldestPendingSeconds: 0 }, grafana: { pending: 1, failing: 1, oldestPendingSeconds: 340 } },
      recentErrors: [{ target: 'grafana', aggregateType: 'tenant', aggregateId: uuid(), attempts: 4, lastError: 'grafana POST /api/orgs -> 500 Internal Server Error' }],
    });
  }
  if (p === '/admin/sync/resync' && M === 'POST') {
    return role('platform-admin') && send(res, 202, { tenantsQueued: S.tenants.length, usersQueued: S.users.length - 1, agentsQueued: S.agents.length, orphansDeleted: 0, orphansPending: 1 });
  }

  if (seg[0] === 'tenants' && seg[1]) {
    if (!role('platform-admin', 'tenant-admin')) return;
    const t = S.tenants.find((x) => x.tenantKey === seg[1] && x.status === 'active');
    if (!t) return fail(res, 404, 'tenant_not_found', 'Tenant not found');
    if (actor.role === 'tenant-admin' && actor.tenantKey !== t.tenantKey) return fail(res, 403, 'forbidden', 'Cannot access another tenant');
    const key = t.tenantKey;
    const sub = seg[2];
    const id = seg[3];

    if (!sub) {
      if (M === 'GET') return send(res, 200, t);
      if (M === 'DELETE') {
        if (!role('platform-admin')) return;
        t.status = 'deleted';
        S.users = S.users.filter((u) => u.tenantKey !== key);
        return send(res, 204);
      }
    }
    if (sub === 'users') {
      const list = S.users.filter((u) => u.tenantKey === key);
      if (!id && M === 'GET') return send(res, 200, { items: list });
      if (!id && M === 'POST') {
        const problems = [];
        if (!/^\S+$/.test(String(body.username ?? '').trim())) problems.push(['username', 'username must not contain whitespace']);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.email ?? ''))) problems.push(['email', 'email must be an email']);
        if (!body.password) problems.push(['password', 'password must be longer than or equal to 1 characters']);
        if (!body.firstName) problems.push(['firstName', 'firstName must be longer than or equal to 1 characters']);
        if (!body.lastName) problems.push(['lastName', 'lastName must be longer than or equal to 1 characters']);
        if (!['tenant-admin', 'viewer'].includes(body.role)) problems.push(['role', 'role must be one of the following values: tenant-admin, viewer']);
        const extra = Object.keys(body).filter((k) => !['username', 'email', 'password', 'firstName', 'lastName', 'role'].includes(k));
        extra.forEach((k) => problems.push([k, `property ${k} should not exist`]));
        if (validation(res, problems)) return;
        if (actor.role === 'tenant-admin' && body.role !== 'viewer') return fail(res, 403, 'forbidden', `A tenant-admin cannot create ${body.role} users`);
        if (S.users.some((u) => u.username === body.username.toLowerCase())) return fail(res, 409, 'username_taken', 'Username already exists');
        const u = { id: uuid(), tenantKey: key, username: body.username.toLowerCase(), email: body.email.toLowerCase(), firstName: body.firstName, lastName: body.lastName, role: body.role, enabled: true, createdAt: iso(now()) };
        S.users.push(u);
        return send(res, 201, u);
      }
      const u = list.find((x) => x.id === id);
      if (!u) return fail(res, 404, 'user_not_found', 'User not found');
      const manage = () => {
        if (u.role === 'platform-admin' || (actor.role === 'tenant-admin' && u.role !== 'viewer')) {
          fail(res, 403, 'forbidden', `A ${actor.role} cannot manage ${u.role} users`);
          return false;
        }
        return true;
      };
      if (M === 'GET') return send(res, 200, u);
      if (M === 'PATCH') {
        if (!manage()) return;
        if (Object.keys(body).some((k) => k !== 'enabled')) return validation(res, [['x', 'property should not exist']]);
        if (typeof body.enabled === 'boolean') u.enabled = body.enabled;
        return send(res, 200, u);
      }
      if (M === 'DELETE') {
        if (!manage()) return;
        S.users = S.users.filter((x) => x !== u);
        return send(res, 204);
      }
    }
    if (sub === 'agents') {
      const list = S.agents.filter((a) => a.tenantKey === key);
      if (!id && M === 'GET') return send(res, 200, { items: list.map(agentView) });
      const a = list.find((x) => x.id === id);
      if (!a) return fail(res, 404, 'agent_not_found', 'Agent not found');
      if (M === 'GET') return send(res, 200, agentView(a));
      if (M === 'PATCH') {
        if (a.status === 'revoked') return fail(res, 409, 'agent_revoked', 'Agent is revoked');
        if (typeof body.enabled === 'boolean') a.status = body.enabled ? 'active' : 'disabled';
        return send(res, 200, agentView(a));
      }
      if (M === 'DELETE') {
        a.status = 'revoked';
        return send(res, 204);
      }
    }
    if (sub === 'agent-enrollments') {
      if (!id && M === 'GET') return send(res, 200, { items: S.enrollments.filter((e) => e.tenantKey === key).map(enrollmentView) });
      if (!id && M === 'POST') {
        if (Object.keys(body).length) return validation(res, [['body', 'no body expected']]);
        const e = { id: uuid(), tenantKey: key, createdBy: actor.username, createdAt: iso(now()), expiresAt: new Date(Date.now() + 10 * 60000).toISOString(), usedAt: null, revokedAt: null, revokedBy: null, agentId: uuid() };
        S.enrollments.push(e);
        return send(res, 201, { ...enrollmentView(e), enrollmentToken: crypto.randomBytes(24).toString('base64url') });
      }
      const e = S.enrollments.find((x) => x.id === id && x.tenantKey === key);
      if (!e) return fail(res, 404, 'enrollment_not_found', 'Enrollment not found');
      if (M === 'DELETE') {
        if (enrollmentState(e) !== 'pending') return fail(res, 409, 'enrollment_not_pending', 'Only pending enrollments can be revoked');
        e.revokedAt = iso(now());
        e.revokedBy = actor.username;
        return send(res, 204);
      }
    }
    if (sub === 'support-access') {
      if (!id && M === 'GET') {
        const active = url.searchParams.get('active') === 'true';
        return send(res, 200, { items: S.grants.filter((g) => g.tenantKey === key).map(grantView).filter((g) => !active || g.active) });
      }
      if (!id && M === 'POST') {
        if (!role('platform-admin')) return;
        const problems = [];
        const reason = String(body.reason ?? '').trim();
        if (reason.length < 10 || reason.length > 500) problems.push(['reason', 'reason is required (10-500 characters), e.g. a ticket id and what you need to check']);
        if (body.minutes !== undefined && (!Number.isInteger(body.minutes) || body.minutes < 5)) problems.push(['minutes', 'minutes must not be less than 5']);
        if (body.role !== undefined && !['Viewer', 'Editor'].includes(body.role)) problems.push(['role', 'role must be one of the following values: Viewer, Editor']);
        if (validation(res, problems)) return;
        if ((body.minutes ?? 60) > 480) return fail(res, 400, 'support_access_too_long', 'At most 480 minutes');
        const g = { id: uuid(), tenantKey: key, username: actor.username, role: body.role ?? 'Viewer', reason, grantedBy: actor.username, createdAt: iso(now()), expiresAt: new Date(Date.now() + (body.minutes ?? 60) * 60000).toISOString(), revokedAt: null, revokedBy: null };
        S.grants.push(g);
        return send(res, 201, grantView(g));
      }
      if (id && M === 'DELETE') {
        if (!role('platform-admin')) return;
        const g = S.grants.find((x) => x.id === id && x.tenantKey === key);
        if (!g) return fail(res, 404, 'grant_not_found', 'Grant not found');
        g.revokedAt = iso(now());
        g.revokedBy = actor.username;
        return send(res, 204);
      }
    }
  }
  return fail(res, 404, 'route_not_found', `Cannot ${M} ${p}`);
}

// ------------------------------------------------------------- static
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const SEC = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, ORIGIN);
    if (url.pathname === '/__log') return send(res, 200, log);
    if (url.pathname.startsWith('/kc/')) return keycloak(req, res, url);
    if (url.pathname.startsWith('/api/')) return apiRoute(req, res, url).catch((e) => fail(res, 500, 'internal', String(e)));
    if (url.pathname.startsWith('/grafana')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<title>Grafana (mock)</title>grafana');
    }
    let file = path.join(SITE, path.normalize(url.pathname));
    if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(SITE, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', ...SEC });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log(`mock on ${ORIGIN}`));
