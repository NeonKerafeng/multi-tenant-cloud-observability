// One tenant: header + tabs (overview, users, agents, enrollments,
// support). Platform admins reach any tenant, tenant admins their own.

import { api } from './api.js';
import { formatDate, h, icon, mount, timeEl } from './dom.js';
import { href, navigate } from './router.js';
import { grafanaUrl, isPlatformAdmin } from './session.js';
import { agentsTab } from './tab-agents.js';
import { enrollmentsTab } from './tab-enrollments.js';
import { supportTab } from './tab-support.js';
import { usersTab } from './tab-users.js';
import { button, card, confirmAction, kpi, loadInto, metaItem, pageHeader, tabs, tag, toast } from './ui.js';

const TABS = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'users', label: 'Users', icon: 'users' },
  { id: 'agents', label: 'Agents', icon: 'agent' },
  { id: 'enrollments', label: 'Enrollments', icon: 'key' },
  { id: 'support', label: 'Support access', icon: 'shield' },
];

const RENDER = {
  overview: overviewTab,
  users: usersTab,
  agents: agentsTab,
  enrollments: enrollmentsTab,
  support: supportTab,
};

export function tenantPage(view, { tenantKey, tab = 'overview' }) {
  const key = encodeURIComponent(tenantKey);
  const page = h('div', { class: 'page' });

  mount(view, page);

  if (!RENDER[tab]) {
    navigate(`/tenants/${key}`);
    return;
  }

  loadInto(
    page,
    () => api.tenants.get(tenantKey),
    (tenant) => {
      const body = h('div', { class: 'tab-body' });

      RENDER[tab](body, tenant);

      return [
        pageHeader({
          title: tenant.tenantKey,
          subtitle: 'Tenant',
          crumbs: isPlatformAdmin()
            ? [{ label: 'Platform', href: href('/') }, { label: 'Tenants', href: href('/tenants') }, { label: tenant.tenantKey }]
            : [{ label: 'My tenant' }, { label: tenant.tenantKey }],
          actions: [
            tenant.grafanaOrgId !== null &&
              button({ label: 'Open in Grafana', icon: 'external', variant: 'secondary', href: grafanaUrl(tenant.grafanaOrgId), target: '_blank' }),
          ].filter(Boolean),
          meta: [
            metaItem('Status', tag(tenant.status)),
            metaItem('VM account', h('code', {}, tenant.vmAccountId)),
            metaItem('Grafana org', tenant.grafanaOrgId === null ? tag('provisioning') : `#${tenant.grafanaOrgId}`),
            metaItem('Created', h('span', { title: formatDate(tenant.createdAt) }, timeEl(tenant.createdAt))),
          ],
        }),
        tabs(
          TABS.map((t) => ({ ...t, href: href(t.id === 'overview' ? `/tenants/${key}` : `/tenants/${key}/${t.id}`) })),
          tab,
        ),
        body,
      ];
    },
    { lines: 3 },
  );
}

function overviewTab(container, tenant) {
  const key = encodeURIComponent(tenant.tenantKey);
  const content = h('div', { class: 'stack' });

  mount(container, content);

  loadInto(
    content,
    () =>
      Promise.all([
        api.users.list(tenant.tenantKey),
        api.agents.list(tenant.tenantKey),
        api.enrollments.list(tenant.tenantKey),
        api.support.list(tenant.tenantKey, true),
      ]),
    ([users, agents, enrollments, grants]) => {
      const admins = users.items.filter((u) => u.role === 'tenant-admin').length;
      const viewers = users.items.filter((u) => u.role === 'viewer').length;
      const active = agents.items.filter((a) => a.status === 'active').length;
      const live = agents.items.filter((a) => a.status !== 'revoked').length;
      const pendingTokens = enrollments.items.filter((e) => e.state === 'pending').length;

      const steps = [
        { done: admins > 0, title: 'Create a tenant admin', text: 'Someone on the customer side who manages viewers and agents.', tab: 'users' },
        { done: viewers > 0, title: 'Add viewers', text: 'Read-only Grafana access for the tenant’s team.', tab: 'users' },
        { done: active > 0, title: 'Enroll a first agent', text: 'Create a one-time token and run bootstrap.sh on the host.', tab: 'enrollments' },
        { done: tenant.grafanaOrgId !== null && active > 0, title: 'See data in Grafana', text: 'Dashboards appear once an agent sends metrics and logs.', link: tenant.grafanaOrgId !== null ? grafanaUrl(tenant.grafanaOrgId) : null },
      ];

      const remaining = steps.filter((s) => !s.done).length;

      return [
        h(
          'div',
          { class: 'kpis' },
          kpi({ label: 'Users', value: String(users.items.length), icon: 'users', href: href(`/tenants/${key}/users`), hint: `${admins} admin(s) · ${viewers} viewer(s)` }),
          kpi({ label: 'Active agents', value: `${active}/${live}`, icon: 'agent', tone: live > active ? 'warn' : 'ok', href: href(`/tenants/${key}/agents`), hint: live === 0 ? 'no agents yet' : live > active ? `${live - active} not active` : 'all live agents active' }),
          kpi({ label: 'Pending tokens', value: String(pendingTokens), icon: 'key', tone: 'info', href: href(`/tenants/${key}/enrollments`), hint: 'unused enrollment tokens' }),
          kpi({ label: 'Support access', value: String(grants.items.length), icon: 'shield', tone: grants.items.length ? 'warn' : 'ok', href: href(`/tenants/${key}/support`), hint: grants.items.length ? 'active grant(s) now' : 'no platform access now' }),
        ),
        h(
          'div',
          { class: 'grid-2' },
          card({
            title: remaining === 0 ? 'Tenant is fully onboarded' : `Onboarding · ${steps.length - remaining}/${steps.length} done`,
            icon: 'check',
            body: h(
              'ol',
              { class: 'steps' },
              steps.map((s) =>
                h(
                  'li',
                  { class: ['step', s.done && 'done'] },
                  h('span', { class: 'step-mark' }, s.done ? icon('check', 14) : ''),
                  h('div', { class: 'step-text' }, h('strong', {}, s.title), h('p', { class: 'muted small' }, s.text)),
                  s.done
                    ? null
                    : s.tab
                      ? button({ label: 'Go', variant: 'ghost', size: 'sm', href: href(`/tenants/${key}/${s.tab}`) })
                      : s.link && button({ label: 'Open', icon: 'external', variant: 'ghost', size: 'sm', href: s.link, target: '_blank' }),
                ),
              ),
            ),
          }),
          isPlatformAdmin() ? dangerZone(tenant) : aboutCard(tenant),
        ),
      ];
    },
    { lines: 6 },
  );
}

function aboutCard(tenant) {
  return card({
    title: 'About this tenant',
    icon: 'info',
    body: [
      h('p', {}, 'You administer this tenant: create viewer accounts, enroll agents on your hosts and review platform support access.'),
      h('ul', { class: 'checklist' },
        h('li', {}, icon('check', 16), `Metrics are stored under VM account ${tenant.vmAccountId}.`),
        h('li', {}, icon('check', 16), 'Logs and metrics are isolated from every other tenant.'),
        h('li', {}, icon('check', 16), 'Every platform support access is time-boxed and audited.'),
      ),
    ],
  });
}

function dangerZone(tenant) {
  return card({
    title: 'Danger zone',
    icon: 'alert',
    class: 'card-danger',
    body: [
      h('p', {}, 'Deleting the tenant removes its users, agents, enrollment tokens and support grants. Keycloak and Grafana follow automatically. The key ', h('code', {}, tenant.tenantKey), ' can never be used again.'),
      button({
        label: 'Delete tenant',
        icon: 'trash',
        variant: 'danger',
        id: 'delete-tenant',
        onClick: async () => {
          const done = await confirmAction({
            title: `Delete ${tenant.tenantKey}?`,
            message: 'This cannot be undone. All users of this tenant lose access immediately and its agents stop being accepted.',
            confirmLabel: 'Delete tenant',
            typeToConfirm: tenant.tenantKey,
            action: () => api.tenants.remove(tenant.tenantKey),
          });

          if (done) {
            toast({ title: 'Tenant deleted', message: `${tenant.tenantKey} is gone; Keycloak and Grafana clean-up runs in the background.` });
            navigate('/tenants');
          }
        },
      }),
    ],
  });
}
