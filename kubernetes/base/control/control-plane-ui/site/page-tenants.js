// Tenants list (platform-admin) + the "new tenant" dialog.

import { api } from './api.js';
import { h, mount, timeEl } from './dom.js';
import { href, navigate } from './router.js';
import { grafanaUrl } from './session.js';
import { button, card, dataTable, emptyState, formDialog, loadInto, pageHeader, rowActions, tag, toast } from './ui.js';

// Same rule as control-plane (common/http/validation.ts TENANT_KEY_RE).
const TENANT_KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Resolves to the created TenantView, or null. */
export async function createTenantDialog() {
  const created = await formDialog({
    title: 'New tenant',
    subtitle: 'Creates the tenant, its Keycloak group and (asynchronously) its Grafana organisation.',
    submitLabel: 'Create tenant',
    fields: [
      {
        name: 'tenantKey',
        label: 'Tenant key',
        required: true,
        mono: true,
        placeholder: 'gamma-tenant',
        maxLength: 63,
        hint: '1–63 lowercase letters, digits or hyphens. It is the tenant’s id in URLs and can never be reused, even after deletion.',
        validate: (value) => (TENANT_KEY_RE.test(value.trim()) ? '' : 'Use 1–63 lowercase letters, digits or hyphens, not starting or ending with a hyphen.'),
        wide: true,
      },
    ],
    onSubmit: ({ tenantKey }) => api.tenants.create(tenantKey.trim()),
  });

  if (created) {
    toast({ title: 'Tenant created', message: `${created.tenantKey} (VM account ${created.vmAccountId}). Grafana org is being provisioned.` });
  }

  return created;
}

export function tenantsPage(view) {
  const content = h('div');

  const reload = () =>
    loadInto(
      content,
      () => api.tenants.list(),
      ({ items }) =>
        card({
          flush: true,
          body: dataTable({
            rows: items,
            rowKey: (t) => t.tenantKey,
            search: (t) => `${t.tenantKey} ${t.vmAccountId}`,
            searchPlaceholder: 'Search tenants…',
            filters: [
              {
                id: 'grafana',
                label: 'Grafana org',
                options: [
                  { value: 'all', label: 'All Grafana states' },
                  { value: 'ready', label: 'Grafana org ready', test: (t) => t.grafanaOrgId !== null },
                  { value: 'pending', label: 'Provisioning', test: (t) => t.grafanaOrgId === null },
                ],
              },
            ],
            onRowClick: (t) => navigate(`/tenants/${encodeURIComponent(t.tenantKey)}`),
            empty: emptyState({
              icon: 'tenants',
              title: 'No tenants yet',
              text: 'A tenant is an isolated customer space: its users, agents and Grafana org.',
              action: button({ label: 'New tenant', icon: 'plus', variant: 'primary', onClick: create }),
            }),
            columns: [
              {
                key: 'tenantKey',
                label: 'Tenant',
                sort: (t) => t.tenantKey,
                render: (t) => h('a', { class: 'strong-link', href: href(`/tenants/${encodeURIComponent(t.tenantKey)}`) }, t.tenantKey),
              },
              { key: 'status', label: 'Status', render: (t) => tag(t.status) },
              { key: 'vmAccountId', label: 'VM account', sort: (t) => Number(t.vmAccountId), render: (t) => h('code', {}, t.vmAccountId) },
              {
                key: 'grafanaOrgId',
                label: 'Grafana org',
                sort: (t) => t.grafanaOrgId ?? Infinity,
                render: (t) => (t.grafanaOrgId === null ? tag('provisioning') : h('span', {}, `#${t.grafanaOrgId}`)),
              },
              { key: 'createdAt', label: 'Created', sort: (t) => t.createdAt, render: (t) => timeEl(t.createdAt) },
              {
                key: 'actions',
                label: '',
                class: 'col-actions',
                render: (t) =>
                  rowActions(
                    t.grafanaOrgId !== null &&
                      button({ icon: 'chart', variant: 'ghost', size: 'sm', title: 'Open in Grafana', href: grafanaUrl(t.grafanaOrgId), target: '_blank' }),
                    button({ icon: 'chevronRight', variant: 'ghost', size: 'sm', title: 'Open tenant', href: href(`/tenants/${encodeURIComponent(t.tenantKey)}`) }),
                  ),
              },
            ],
          }),
        }),
      { lines: 8 },
    );

  async function create() {
    const created = await createTenantDialog();

    if (created) {
      navigate(`/tenants/${encodeURIComponent(created.tenantKey)}`);
    }
  }

  mount(
    view,
    h(
      'div',
      { class: 'page' },
      pageHeader({
        title: 'Tenants',
        subtitle: 'Every customer space on the platform. Deleted tenant keys are never reused.',
        crumbs: [{ label: 'Platform', href: href('/') }, { label: 'Tenants' }],
        actions: [
          button({ icon: 'sync', variant: 'ghost', title: 'Refresh', onClick: () => reload() }),
          button({ label: 'New tenant', icon: 'plus', variant: 'primary', id: 'new-tenant', onClick: create }),
        ],
      }),
      content,
    ),
  );

  reload();
}
