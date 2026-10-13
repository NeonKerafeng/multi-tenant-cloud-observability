// Full-page screens shown outside the app shell: sign-in, blocked, fatal.

import { signIn, signOut } from './auth.js';
import { h, icon, logo, mount } from './dom.js';
import { cfg } from './session.js';
import { button } from './ui.js';

function brandPanel() {
  return h(
    'section',
    { class: 'auth-brand' },
    h('div', { class: 'auth-brand-inner' },
      h('div', { class: 'auth-logo' }, logo(56), h('span', {}, 'MTCO')),
      h('h1', {}, 'One control plane', h('br'), 'for every tenant.'),
      h('p', {}, 'Multi-tenant metrics and logs: tenants, people, agents and audited support access in one place.'),
      h(
        'ul',
        { class: 'auth-points' },
        [
          ['tenants', 'Isolated tenants with their own Grafana org'],
          ['key', 'One-time enrollment tokens for agents'],
          ['shield', 'Time-boxed, audited support access'],
        ].map(([name, text]) => h('li', {}, h('span', { class: 'auth-point-icon' }, icon(name, 18)), text)),
      ),
    ),
    h('div', { class: 'auth-stripes', 'aria-hidden': 'true' }),
  );
}

function authLayout(...content) {
  return h('div', { class: 'auth' }, brandPanel(), h('section', { class: 'auth-main' }, h('div', { class: 'auth-card' }, content)));
}

export function loginScreen(root, error) {
  mount(
    root,
    authLayout(
      h('span', { class: 'eyebrow' }, 'Control Plane'),
      h('h2', {}, 'Sign in'),
      h('p', { class: 'muted' }, 'Use your MTCO account. You will be redirected to the identity provider (Keycloak) and back.'),
      error &&
        h('div', { class: 'alert alert-error' }, icon('alert', 18), h('div', {}, h('strong', {}, 'Sign-in failed'), h('p', {}, error))),
      button({ label: 'Sign in with SSO', icon: 'lock', variant: 'primary', size: 'lg', id: 'sign-in', onClick: () => signIn() }),
      h('p', { class: 'auth-foot muted small' }, `Realm ${cfg.realm} · ${new URL(cfg.keycloakUrl).host}`),
    ),
  );
}

const BLOCKED = {
  not_registered: {
    title: 'Account not registered',
    text: 'You signed in, but this account is not registered in the MTCO control plane. Ask your tenant administrator to create your user.',
  },
  account_disabled: {
    title: 'Account disabled',
    text: 'This account has been disabled by an administrator. Contact your tenant administrator if you think this is a mistake.',
  },
};

export function blockedScreen(root, error) {
  const info = BLOCKED[error.code] ?? { title: 'Access denied', text: error.message };

  mount(
    root,
    authLayout(
      h('div', { class: 'auth-state-icon' }, icon('ban', 28)),
      h('h2', {}, info.title),
      h('p', { class: 'muted' }, info.text),
      error.requestId && h('p', { class: 'muted mono small' }, `request ${error.requestId}`),
      button({ label: 'Sign out', icon: 'logout', variant: 'secondary', size: 'lg', onClick: () => signOut() }),
    ),
  );
}

export function fatalScreen(root, error, retry) {
  mount(
    root,
    authLayout(
      h('div', { class: 'auth-state-icon' }, icon('alert', 28)),
      h('h2', {}, 'Control plane unavailable'),
      h('p', { class: 'muted' }, error.message),
      error.requestId && h('p', { class: 'muted mono small' }, `request ${error.requestId}`),
      h('div', { class: 'auth-actions' },
        button({ label: 'Try again', icon: 'sync', variant: 'primary', onClick: retry }),
        button({ label: 'Sign out', icon: 'logout', variant: 'ghost', onClick: () => signOut() }),
      ),
    ),
  );
}
