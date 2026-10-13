// Typed-by-convention client of control-plane /api/v1 (same origin, via
// the nginx proxy). One function per route of routes.spec.ts.

import { accessToken, signIn } from './auth.js';

const cfg = window.MTCO_CONFIG;

export class ApiError extends Error {
  constructor(status, code, message, details, requestId) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /** validation_failed details as { field: 'message; message' }. */
  fieldErrors() {
    if (!Array.isArray(this.details)) {
      return {};
    }

    return Object.fromEntries(this.details.map((d) => [d.field, d.messages.join('; ')]));
  }
}

async function request(method, path, body) {
  const token = await accessToken();

  if (!token) {
    await signIn();
    throw new ApiError(401, 'unauthenticated', 'Session expired, signing in again…');
  }

  let response;

  try {
    response = await fetch(`${cfg.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach control-plane (network error)');
  }

  if (response.status === 204) {
    return null;
  }

  const data = await response.json().catch(() => null);

  if (response.ok) {
    return data;
  }

  const error = data?.error ?? {};
  const failure = new ApiError(
    response.status,
    error.code ?? `http_${response.status}`,
    error.message ?? (response.statusText || `HTTP ${response.status}`),
    error.details,
    data?.requestId ?? response.headers.get('X-Request-Id'),
  );

  if (response.status === 401) {
    await signIn();
  }

  throw failure;
}

const seg = encodeURIComponent;
const tenant = (key) => `/tenants/${seg(key)}`;

export const api = {
  me: () => request('GET', '/me'),

  tenants: {
    list: () => request('GET', '/tenants'),
    get: (key) => request('GET', tenant(key)),
    create: (tenantKey) => request('POST', '/tenants', { tenantKey }),
    remove: (key) => request('DELETE', tenant(key)),
  },

  users: {
    list: (key) => request('GET', `${tenant(key)}/users`),
    get: (key, id) => request('GET', `${tenant(key)}/users/${seg(id)}`),
    create: (key, body) => request('POST', `${tenant(key)}/users`, body),
    setEnabled: (key, id, enabled) => request('PATCH', `${tenant(key)}/users/${seg(id)}`, { enabled }),
    remove: (key, id) => request('DELETE', `${tenant(key)}/users/${seg(id)}`),
  },

  agents: {
    list: (key) => request('GET', `${tenant(key)}/agents`),
    get: (key, id) => request('GET', `${tenant(key)}/agents/${seg(id)}`),
    setEnabled: (key, id, enabled) => request('PATCH', `${tenant(key)}/agents/${seg(id)}`, { enabled }),
    revoke: (key, id) => request('DELETE', `${tenant(key)}/agents/${seg(id)}`),
  },

  enrollments: {
    list: (key) => request('GET', `${tenant(key)}/agent-enrollments`),
    create: (key) => request('POST', `${tenant(key)}/agent-enrollments`),
    revoke: (key, id) => request('DELETE', `${tenant(key)}/agent-enrollments/${seg(id)}`),
  },

  support: {
    listAll: (activeOnly) => request('GET', `/support-access${activeOnly ? '?active=true' : ''}`),
    list: (key, activeOnly) => request('GET', `${tenant(key)}/support-access${activeOnly ? '?active=true' : ''}`),
    grant: (key, body) => request('POST', `${tenant(key)}/support-access`, body),
    revoke: (key, id) => request('DELETE', `${tenant(key)}/support-access/${seg(id)}`),
  },

  sync: {
    status: () => request('GET', '/admin/sync/status'),
    resync: () => request('POST', '/admin/sync/resync'),
  },
};
