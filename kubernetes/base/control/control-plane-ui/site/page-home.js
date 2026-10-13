// Home: platform overview (platform-admin) or the viewer landing page.
// Tenant admins are sent to their tenant.

import { api } from './api.js';
import { fullName, h, icon, mount, timeEl } from './dom.js';
import { createTenantDialog } from './page-tenants.js';
import { href, navigate } from './router.js';
import { syncHealth } from './page-sync.js';
import { grafanaUrl, isPlatformAdmin, isTenantAdmin, session } from './session.js';
import { button, card, dataTable, emptyState, kpi, loadInto, tag } from './ui.js';

function greeting() {
  const hour = new Date().getHours();

  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

function hero(title, text, actions) {
  return h(
    'section',
    { class: 'hero' },
    h('div', { class: 'hero-text' }, h('span', { class: 'eyebrow eyebrow-light' }, greeting()), h('h1', {}, title), h('p', {}, text)),
    h('div', { class: 'hero-actions' }, actions),
    h('div', { class: 'hero-stripes', 'aria-hidden': 'true' }),
  );
}

export function homePage(view) {
  if (isTenantAdmin()) {
    navigate(`/tenants/${encodeURIComponent(session.me.tenantKey)}`);
    return;
  }

  if (isPlatformAdmin()) {
    platformOverview(view);
    return;
  }

  viewerHome(view);
}

function platformOverview(view) {
  const me = session.me;
  const content = h('div', { class: 'stack' });

  mount(
    view,
    h(
      'div',
      { class: 'page' },
      hero(`${me.firstName ?? me.username}, here is your platform`, 'Tenants, synchronisation and support access at a glance.', [
        button({
          label: 'New tenant',
          icon: 'plus',
          variant: 'light',
          onClick: async () => {
            const created = await createTenantDialog();

            if (created) {
              navigate(`/tenants/${encodeURIComponent(created.tenantKey)}`);
            }
          },
        }),
        button({ label: 'Open Grafana', icon: 'external', variant: 'outline-light', href: grafanaUrl(), target: '_blank' }),
      ]),
      content,
    ),
  );

  loadInto(
    content,
    () => Promise.all([api.tenants.list(), api.support.listAll(true), api.sync.status()]),
    ([tenants, grants, sync]) => {
      const provisioned = tenants.items.filter((t) => t.grafanaOrgId !== null).length;
      const health = syncHealth(sync);
      const pending = sync.targets.keycloak.pending + sync.targets.grafana.pending;
      const recent = [...tenants.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);

      return [
        h(
          'div',
          { class: 'kpis' },
          kpi({ label: 'Tenants', value: String(tenants.items.length), icon: 'tenants', href: href('/tenants'), hint: 'active tenants' }),
          kpi({
            label: 'Grafana orgs',
            value: `${provisioned}/${tenants.items.length}`,
            icon: 'chart',
            tone: provisioned === tenants.items.length ? 'ok' : 'warn',
            hint: provisioned === tenants.items.length ? 'all provisioned' : 'provisioning…',
          }),
          kpi({ label: 'Support access', value: String(grants.items.length), icon: 'shield', tone: grants.items.length ? 'warn' : 'ok', href: href('/support-access'), hint: grants.items.length ? 'someone has access now' : 'nobody has access' }),
          kpi({ label: 'Sync', value: health, icon: 'sync', tone: health === 'healthy' ? 'ok' : health === 'degraded' ? 'warn' : 'danger', href: href('/sync'), hint: `${pending} event(s) pending` }),
        ),
        h(
          'div',
          { class: 'grid-2' },
          card({
            title: 'Newest tenants',
            icon: 'tenants',
            flush: true,
            actions: [button({ label: 'All tenants', variant: 'ghost', size: 'sm', href: href('/tenants') })],
            body: dataTable({
              rows: recent,
              rowKey: (t) => t.tenantKey,
              onRowClick: (t) => navigate(`/tenants/${encodeURIComponent(t.tenantKey)}`),
              empty: emptyState({ icon: 'tenants', title: 'No tenants yet', text: 'Create the first tenant to onboard a customer.' }),
              columns: [
                { key: 'tenantKey', label: 'Tenant', render: (t) => h('a', { class: 'strong-link', href: href(`/tenants/${encodeURIComponent(t.tenantKey)}`) }, t.tenantKey) },
                { key: 'vm', label: 'VM account', render: (t) => h('code', {}, t.vmAccountId) },
                { key: 'grafana', label: 'Grafana', render: (t) => (t.grafanaOrgId === null ? tag('provisioning') : h('span', {}, `org ${t.grafanaOrgId}`)) },
                { key: 'createdAt', label: 'Created', render: (t) => timeEl(t.createdAt) },
              ],
            }),
          }),
          card({
            title: 'Synchronisation',
            icon: 'sync',
            actions: [button({ label: 'Details', variant: 'ghost', size: 'sm', href: href('/sync') })],
            body: [
              h(
                'div',
                { class: 'target-mini' },
                ['keycloak', 'grafana'].map((name) => {
                  const t = sync.targets[name];

                  return h(
                    'div',
                    { class: 'target-mini-item' },
                    h('span', { class: 'target-name' }, name === 'keycloak' ? 'Keycloak' : 'Grafana'),
                    tag(t.failing ? 'failing' : t.pending ? 'pending' : 'healthy'),
                    h('span', { class: 'muted small' }, `${t.pending} pending · ${t.failing} failing`),
                  );
                }),
              ),
              sync.recentErrors.length === 0
                ? h('p', { class: 'muted ok-line' }, icon('check', 16), 'No recent synchronisation errors.')
                : h(
                    'ul',
                    { class: 'error-list' },
                    sync.recentErrors.slice(0, 3).map((e) => h('li', {}, h('strong', {}, `${e.target} · ${e.aggregateType}`), h('span', { class: 'muted small' }, ` ${e.attempts} attempt(s)`), h('p', { class: 'mono small' }, e.lastError ?? '—'))),
                  ),
            ],
          }),
        ),
      ];
    },
    { lines: 6 },
  );
}

function viewerHome(view) {
  const me = session.me;

  mount(
    view,
    h(
      'div',
      { class: 'page' },
      hero(`Welcome, ${me.firstName ?? me.username}`, `You have read-only access to the dashboards of tenant ${me.tenantKey}.`, [
        button({ label: 'Open Grafana', icon: 'external', variant: 'light', size: 'lg', href: grafanaUrl(), target: '_blank' }),
      ]),
      h(
        'div',
        { class: 'grid-2' },
        card({
          title: 'Where is my data?',
          icon: 'chart',
          body: [
            h('p', {}, 'Metrics and logs of your tenant live in Grafana. Sign in there with the same account; you land in your tenant’s organisation automatically.'),
            h('ul', { class: 'checklist' },
              h('li', {}, icon('check', 16), 'Dashboards and Explore are read-only for viewers.'),
              h('li', {}, icon('check', 16), 'Ask your tenant admin for more access or new users.'),
            ),
          ],
        }),
        card({
          title: 'Your account',
          icon: 'user',
          body: h('dl', { class: 'details' },
            h('dt', {}, 'Name'), h('dd', {}, fullName(me)),
            h('dt', {}, 'Username'), h('dd', {}, me.username),
            h('dt', {}, 'Tenant'), h('dd', {}, me.tenantKey),
            h('dt', {}, 'Role'), h('dd', {}, tag(me.role)),
          ),
        }),
      ),
    ),
  );
}
