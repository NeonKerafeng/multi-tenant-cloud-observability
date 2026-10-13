// OIDC Authorization Code + PKCE (S256) against Keycloak, no library.
// Tokens live in sessionStorage (this tab only, gone when it closes);
// Keycloak's own SSO cookie makes the next sign-in silent.

const cfg = window.MTCO_CONFIG;
const oidc = `${cfg.keycloakUrl}/realms/${encodeURIComponent(cfg.realm)}/protocol/openid-connect`;

const TOKENS = 'mtco.tokens';
const PKCE = 'mtco.pkce';
const REFRESH_MARGIN_MS = 30_000;

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomString(size) {
  return base64url(crypto.getRandomValues(new Uint8Array(size)));
}

async function challengeOf(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));

  return base64url(digest);
}

function redirectUri() {
  return `${location.origin}/`;
}

function readJson(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function load() {
  return readJson(TOKENS);
}

function save(response) {
  sessionStorage.setItem(
    TOKENS,
    JSON.stringify({
      access: response.access_token,
      refresh: response.refresh_token,
      idToken: response.id_token ?? load()?.idToken,
      expiresAt: Date.now() + response.expires_in * 1000,
    }),
  );
}

function clear() {
  sessionStorage.removeItem(TOKENS);
}

async function tokenRequest(form) {
  const response = await fetch(`${oidc}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, ...form }),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    clear();
    throw new Error(body.error_description ?? `Token request failed (HTTP ${response.status})`);
  }

  save(body);
}

export function isSignedIn() {
  return load() !== null;
}

/** Access-token expiry (ms since epoch), for the profile page. */
export function sessionExpiresAt() {
  return load()?.expiresAt ?? null;
}

/** Redirects to Keycloak; comes back to the current hash route. */
export async function signIn(returnTo = location.hash) {
  const verifier = randomString(48);
  const state = randomString(16);

  sessionStorage.setItem(PKCE, JSON.stringify({ verifier, state, returnTo }));

  const url = new URL(`${oidc}/auth`);

  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid',
    state,
    code_challenge: await challengeOf(verifier),
    code_challenge_method: 'S256',
  }).toString();

  location.assign(url);
}

/**
 * Finishes a login redirect (?code=…): exchanges the code and restores
 * the route the user was on. Returns false when the URL is not a redirect.
 */
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);

  if (!params.has('code') && !params.has('error')) {
    return false;
  }

  const saved = readJson(PKCE);

  sessionStorage.removeItem(PKCE);
  history.replaceState(null, '', `/${saved?.returnTo ?? ''}`);

  if (params.has('error')) {
    throw new Error(params.get('error_description') ?? params.get('error'));
  }

  if (!saved || saved.state !== params.get('state')) {
    throw new Error('Login state mismatch; please sign in again');
  }

  await tokenRequest({
    grant_type: 'authorization_code',
    code: params.get('code'),
    redirect_uri: redirectUri(),
    code_verifier: saved.verifier,
  });

  return true;
}

let refreshing = null;

/** A valid access token (refreshed shortly before expiry), or null. */
export async function accessToken() {
  const tokens = load();

  if (!tokens) {
    return null;
  }

  if (Date.now() < tokens.expiresAt - REFRESH_MARGIN_MS) {
    return tokens.access;
  }

  refreshing ??= tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh,
  }).finally(() => {
    refreshing = null;
  });

  try {
    await refreshing;
  } catch {
    return null;
  }

  return load()?.access ?? null;
}

/** Ends the Keycloak SSO session too, then comes back to the UI. */
export function signOut() {
  const tokens = load();

  clear();

  const url = new URL(`${oidc}/logout`);

  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    post_logout_redirect_uri: redirectUri(),
    ...(tokens?.idToken ? { id_token_hint: tokens.idToken } : {}),
  }).toString();

  location.assign(url);
}
