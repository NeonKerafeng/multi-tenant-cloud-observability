// Support access across all tenants (platform-admin).

import { api } from './api.js';
import { h, mount } from './dom.js';
import { href } from './router.js';
import { grantsTable, revokeGrant } from './tab-support.js';
import { button, card, emptyState, loadInto, pageHeader } from './ui.js';

export function supportPage(view) {
  const content = h('div');

  const reload = () =>
    loadInto(
      content,
      () => api.support.listAll(false),
      ({ items }) =>
        card({
          flush: true,
          body: grantsTable({
            rows: items,
            showTenant: true,
            state: 'active',
            onRevoke: async (g) => (await revokeGrant(g)) && reload(),
            empty: emptyState({
              icon: 'shield',
              title: 'No support access yet',
              text: 'Grant yourself time-boxed access from a tenant’s Support access tab.',
              action: button({ label: 'Go to tenants', icon: 'tenants', variant: 'primary', href: href('/tenants') }),
            }),
          }),
        }),
      { lines: 6 },
    );

  mount(
    view,
    h(
      'div',
      { class: 'page' },
      pageHeader({
        title: 'Support access',
        subtitle: 'Time-boxed access of platform admins to tenant Grafana orgs. Everything here is audited and visible to the tenants.',
        crumbs: [{ label: 'Platform', href: href('/') }, { label: 'Support access' }],
        actions: [button({ icon: 'sync', variant: 'ghost', title: 'Refresh', onClick: () => reload() })],
      }),
      content,
    ),
  );

  reload();
}
