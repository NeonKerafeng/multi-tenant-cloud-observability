// Entry point: finish sign-in, load /me, draw the shell, route.

import { api, ApiError } from './api.js';
import { handleRedirect, isSignedIn, signOut } from './auth.js';
import { fullName, h, icon, initials, logo, mount } from './dom.js';
import { homePage } from './page-home.js';
import { profilePage } from './page-profile.js';
import { supportPage } from './page-support.js';
import { syncPage } from './page-sync.js';
import { tenantPage } from './page-tenant.js';
import { tenantsPage } from './page-tenants.js';
import { href, navigate, route, startRouter } from './router.js';
import { blockedScreen, fatalScreen, loginScreen } from './screens.js';
import { cfg, grafanaUrl, isPlatformAdmin, isTenantAdmin, role, session } from './session.js';
import { button, emptyState, tag } from './ui.js';

const root = document.getElementById('app');

// ---------------------------------------------------------------- theme

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);

  try {
    localStorage.setItem('mtco.theme', theme);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

function themeToggle() {
  const el = button({
    icon: 'moon',
    variant: 'ghost',
    title: 'Toggle dark mode',
    onClick: () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';

      setTheme(next);
      mount(el, icon(next === 'dark' ? 'sun' : 'moon', 17));
    },
  });

  mount(el, icon(document.documentElement.getAttribute('data-theme') === 'dark' ? 'sun' : 'moon', 17));

  return el;
}

// ---------------------------------------------------------------- navigation

function navItems() {
  if (isPlatformAdmin()) {
    return [
      { section: 'Platform' },
      { label: 'Overview', icon: 'dashboard', path: '/', exact: true },
      { label: 'Tenants', icon: 'tenants', path: '/tenants' },
      { label: 'Support access', icon: 'shield', path: '/support-access' },
      { label: 'Sync status', icon: 'sync', path: '/sync' },
      { section: 'Account' },
      { label: 'Profile', icon: 'user', path: '/profile' },
    ];
  }

  if (isTenantAdmin()) {
    const base = `/tenants/${encodeURIComponent(session.me.tenantKey)}`;

    return [
      { section: session.me.tenantKey },
      { label: 'Overview', icon: 'dashboard', path: base, exact: true },
      { label: 'Users', icon: 'users', path: `${base}/users` },
      { label: 'Agents', icon: 'agent', path: `${base}/agents` },
      { label: 'Enrollments', icon: 'key', path: `${base}/enrollments` },
      { label: 'Support access', icon: 'shield', path: `${base}/support` },
      { section: 'Account' },
      { label: 'Profile', icon: 'user', path: '/profile' },
    ];
  }

  return [
    { section: 'Workspace' },
    { label: 'Home', icon: 'dashboard', path: '/', exact: true },
    { label: 'Profile', icon: 'user', path: '/profile' },
  ];
}

function isActive(item, path) {
  return item.exact ? path === item.path : path === item.path || path.startsWith(`${item.path}/`);
}

const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' });
const view = h('main', { class: 'view', id: 'view', tabIndex: -1 });

function renderSidebar(path) {
  mount(
    sidebar,
    h(
      'nav',
      { class: 'nav', 'aria-label': 'Main' },
      navItems().map((item) =>
        item.section
          ? h('div', { class: 'nav-section' }, item.section)
          : h(
              'a',
              { class: ['nav-item', isActive(item, path) && 'active'], href: href(item.path), 'aria-current': isActive(item, path) ? 'page' : undefined },
              icon(item.icon, 18),
              h('span', {}, item.label),
            ),
      ),
    ),
    h(
      'div',
      { class: 'sidebar-foot' },
      button({ label: 'Open Grafana', icon: 'chart', variant: 'secondary', href: grafanaUrl(), target: '_blank' }),
      h('span', { class: 'muted small' }, 'MTCO control plane · API v1'),
    ),
  );
}

function userMenu() {
  const me = session.me;
  const menu = h(
    'div',
    { class: 'menu', role: 'menu', hidden: true },
    h('div', { class: 'menu-head' }, h('strong', {}, fullName(me)), h('span', { class: 'muted small' }, me.email)),
    h('a', { class: 'menu-item', role: 'menuitem', href: href('/profile') }, icon('user', 16), 'Profile'),
    h('a', { class: 'menu-item', role: 'menuitem', href: grafanaUrl(), target: '_blank', rel: 'noopener noreferrer' }, icon('chart', 16), 'Grafana', icon('external', 14)),
    h('button', { class: 'menu-item', role: 'menuitem', type: 'button', id: 'sign-out', onclick: () => signOut() }, icon('logout', 16), 'Sign out'),
  );

  const trigger = h(
    'button',
    {
      class: 'user-chip',
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      id: 'user-menu',
      onclick: (event) => {
        event.stopPropagation();
        menu.hidden = !menu.hidden;
        trigger.setAttribute('aria-expanded', String(!menu.hidden));
      },
    },
    h('span', { class: 'avatar' }, initials(me)),
    h('span', { class: 'user-chip-text' }, h('strong', {}, me.username), h('span', { class: 'muted small' }, me.tenantKey ?? 'platform')),
    tag(me.role),
  );

  document.addEventListener('click', (event) => {
    if (!menu.hidden && !menu.contains(event.target)) {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
  });

  return h('div', { class: 'user-menu' }, trigger, menu);
}

function renderShell() {
  const toggleNav = h(
    'button',
    {
      class: 'btn btn-ghost btn-icon nav-toggle',
      type: 'button',
      'aria-label': 'Menu',
      'aria-controls': 'sidebar',
      onclick: () => document.body.classList.toggle('nav-open'),
    },
    icon('menu', 20),
  );

  mount(
    root,
    h(
      'div',
      { class: 'shell' },
      h(
        'header',
        { class: 'topbar' },
        toggleNav,
        h('a', { class: 'brand', href: href('/') }, h('span', { class: 'brand-mark' }, logo(28)), h('span', { class: 'brand-text' }, h('strong', {}, 'MTCO'), h('span', {}, 'Control Plane'))),
        cfg.environment && h('span', { class: 'env-chip' }, cfg.environment),
        h('div', { class: 'spacer' }),
        themeToggle(),
        userMenu(),
      ),
      sidebar,
      h('div', { class: 'scrim', onclick: () => document.body.classList.remove('nav-open') }),
      view,
    ),
  );
}

// ---------------------------------------------------------------- routes

const PLATFORM = ['platform-admin'];
const ADMINS = ['platform-admin', 'tenant-admin'];

route('/', { render: homePage });
route('/tenants', { roles: PLATFORM, render: tenantsPage });
route('/tenants/:tenantKey/:tab?', { roles: ADMINS, render: tenantPage });
route('/support-access', { roles: PLATFORM, render: supportPage });
route('/sync', { roles: PLATFORM, render: syncPage });
route('/profile', { render: profilePage });

function notAvailable(title, text) {
  mount(
    view,
    h('div', { class: 'page' }, emptyState({ icon: 'lock', title, text, action: button({ label: 'Go home', icon: 'arrowLeft', variant: 'primary', href: href('/') }) })),
  );
}

function renderRoute(match, path) {
  document.body.classList.remove('nav-open');
  renderSidebar(path);
  view.scrollTop = 0;
  window.scrollTo(0, 0);

  if (!match) {
    notAvailable('Page not found', `Nothing lives at ${path}.`);
    return;
  }

  const { handler, params } = match;

  if (handler.roles && !handler.roles.includes(role())) {
    notAvailable('Not available for your role', `This page needs one of: ${handler.roles.join(', ')}.`);
    return;
  }

  // Tenant admins only ever see their own tenant (the API enforces it too).
  if (params.tenantKey && isTenantAdmin() && params.tenantKey !== session.me.tenantKey) {
    navigate(`/tenants/${encodeURIComponent(session.me.tenantKey)}`);
    return;
  }

  handler.render(view, params);
  view.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- start

async function start() {
  try {
    await handleRedirect();
  } catch (error) {
    loginScreen(root, error.message);
    return;
  }

  if (!isSignedIn()) {
    loginScreen(root);
    return;
  }

  try {
    session.me = await api.me();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'unauthenticated') {
      return; // redirecting to Keycloak
    }

    if (error instanceof ApiError && error.status === 403) {
      blockedScreen(root, error);
    } else {
      fatalScreen(root, error, start);
    }

    return;
  }

  document.title = `MTCO · ${session.me.username}`;
  renderShell();
  startRouter(renderRoute);
}

start();
