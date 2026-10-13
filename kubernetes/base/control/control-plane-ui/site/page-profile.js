// The signed-in user's own account and session.

import { sessionExpiresAt, signOut } from './auth.js';
import { formatDate, fullName, h, initials, mount } from './dom.js';
import { href } from './router.js';
import { cfg, grafanaUrl, session } from './session.js';
import { button, card, copyable, detailList, pageHeader, tag } from './ui.js';

const ROLE_TEXT = {
  'platform-admin': 'Manages every tenant, the synchronisation to Keycloak and Grafana, and can request time-boxed support access.',
  'tenant-admin': 'Manages the viewers and agents of your tenant and sees all support access to it.',
  viewer: 'Reads the dashboards of your tenant in Grafana.',
};

export function profilePage(view) {
  const me = session.me;
  const expires = sessionExpiresAt();

  mount(
    view,
    h(
      'div',
      { class: 'page' },
      pageHeader({ title: 'Profile', subtitle: 'Your account as the control plane knows it.', crumbs: [{ label: 'Account' }, { label: 'Profile' }] }),
      h(
        'div',
        { class: 'grid-2' },
        card({
          body: h(
            'div',
            { class: 'profile' },
            h('span', { class: 'avatar avatar-lg' }, initials(me)),
            h('div', {}, h('h2', {}, fullName(me)), h('p', { class: 'muted' }, me.email), tag(me.role)),
            h('p', { class: 'profile-role' }, ROLE_TEXT[me.role]),
          ),
        }),
        card({
          title: 'Account',
          icon: 'user',
          body: detailList([
            ['Username', h('code', {}, me.username)],
            ['User id', copyable(me.id)],
            ['Tenant', me.tenantKey ? (me.role === 'viewer' ? me.tenantKey : h('a', { href: href(`/tenants/${encodeURIComponent(me.tenantKey)}`) }, me.tenantKey)) : 'platform (all tenants)'],
            ['Status', tag(me.enabled ? 'enabled' : 'disabled')],
            ['Member since', formatDate(me.createdAt)],
          ]),
        }),
        card({
          title: 'Session',
          icon: 'lock',
          body: [
            detailList([
              ['Identity provider', h('code', {}, `${new URL(cfg.keycloakUrl).host} · realm ${cfg.realm}`)],
              ['Access token until', expires ? formatDate(expires) : '—'],
              ['Renewal', 'Automatic while this tab is open'],
            ]),
            h('div', { class: 'card-row' },
              button({ label: 'Open Grafana', icon: 'external', variant: 'secondary', href: grafanaUrl(), target: '_blank' }),
              button({ label: 'Sign out', icon: 'logout', variant: 'danger', onClick: () => signOut() }),
            ),
          ],
        }),
      ),
    ),
  );
}
