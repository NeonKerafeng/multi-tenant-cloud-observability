// Support access: time-boxed, audited access of a platform admin to a
// tenant's Grafana org. Platform admins grant/revoke; tenant admins see it.

import { api } from './api.js';
import { formatDate, h, icon, mount, timeEl } from './dom.js';
import { href } from './router.js';
import { grafanaUrl, isPlatformAdmin, session } from './session.js';
import { button, card, confirmAction, dataTable, emptyState, formDialog, loadInto, rowActions, tag, toast } from './ui.js';

export function grantState(grant) {
  return grant.active ? 'active' : grant.revokedAt ? 'revoked' : 'expired';
}

/** Shared by the tenant tab and the platform-wide page. */
export function grantsTable({ rows, showTenant, onRevoke, empty, state = 'all' }) {
  return dataTable({
    rows: [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    search: (g) => `${g.username} ${g.reason} ${g.grantedBy} ${g.tenantKey}`,
    searchPlaceholder: 'Search person, reason or tenant…',
    filters: [
      {
        id: 'state',
        label: 'State',
        value: state,
        options: [
          { value: 'all', label: 'All grants' },
          { value: 'active', label: 'Active', test: (g) => g.active },
          { value: 'expired', label: 'Expired', test: (g) => grantState(g) === 'expired' },
          { value: 'revoked', label: 'Revoked', test: (g) => grantState(g) === 'revoked' },
        ],
      },
    ],
    empty,
    columns: [
      { key: 'state', label: 'State', sort: (g) => grantState(g), render: (g) => tag(grantState(g)) },
      showTenant && {
        key: 'tenantKey',
        label: 'Tenant',
        sort: (g) => g.tenantKey,
        render: (g) => h('a', { class: 'strong-link', href: href(`/tenants/${encodeURIComponent(g.tenantKey)}/support`) }, g.tenantKey),
      },
      { key: 'username', label: 'Who', sort: (g) => g.username, render: (g) => h('div', { class: 'stacked' }, h('strong', {}, g.username), h('span', { class: 'muted small' }, `granted by ${g.grantedBy}`)) },
      { key: 'role', label: 'Grafana role', render: (g) => tag(g.role) },
      { key: 'reason', label: 'Reason', render: (g) => h('span', { class: 'reason', title: g.reason }, g.reason) },
      { key: 'createdAt', label: 'Granted', sort: (g) => g.createdAt, render: (g) => timeEl(g.createdAt) },
      {
        key: 'expiresAt',
        label: 'Ends',
        sort: (g) => g.revokedAt ?? g.expiresAt,
        render: (g) =>
          g.revokedAt
            ? h('div', { class: 'stacked' }, h('span', { title: formatDate(g.revokedAt) }, `revoked ${timeEl(g.revokedAt).textContent}`), h('span', { class: 'muted small' }, `by ${g.revokedBy ?? '—'}`))
            : h('span', { class: g.active ? 'countdown' : 'muted', title: formatDate(g.expiresAt) }, g.active && icon('clock', 14), timeEl(g.expiresAt)),
      },
      onRevoke && {
        key: 'actions',
        label: '',
        class: 'col-actions',
        render: (g) => rowActions(g.active && button({ icon: 'ban', variant: 'ghost-danger', size: 'sm', title: 'Revoke access', onClick: () => onRevoke(g) })),
      },
    ].filter(Boolean),
  });
}

/** Resolves to true when the grant was revoked. */
export async function revokeGrant(grant) {
  const done = await confirmAction({
    title: `Revoke access of ${grant.username}?`,
    message: `Their Grafana access to ${grant.tenantKey} ends immediately.`,
    confirmLabel: 'Revoke access',
    action: () => api.support.revoke(grant.tenantKey, grant.id),
  });

  if (done) {
    toast({ title: 'Support access revoked', message: `${grant.username} · ${grant.tenantKey}` });
  }

  return Boolean(done);
}

export function supportTab(container, tenant) {
  const content = h('div');
  const tenantKey = tenant.tenantKey;
  const platform = isPlatformAdmin();

  const reload = () =>
    loadInto(content, () => api.support.list(tenantKey), ({ items }) =>
      card({
        flush: true,
        body: grantsTable({
          rows: items,
          onRevoke: platform ? async (g) => (await revokeGrant(g)) && reload() : null,
          empty: emptyState({
            icon: 'shield',
            title: 'No support access so far',
            text: platform ? 'Request access when you need to look into this tenant’s dashboards. Every grant is audited.' : 'No platform admin has accessed your tenant. Every access would be listed here.',
            action: platform && button({ label: 'Request access', icon: 'shield', variant: 'primary', onClick: grant }),
          }),
        }),
      }),
    );

  async function grant() {
    const created = await formDialog({
      title: 'Request support access',
      subtitle: `Gives you (${session.me.username}) temporary access to the Grafana org of ${tenantKey}.`,
      submitLabel: 'Grant access',
      fields: [
        {
          name: 'reason',
          label: 'Reason',
          type: 'textarea',
          required: true,
          minLength: 10,
          maxLength: 500,
          placeholder: 'TICKET-42 dashboard shows no data',
          hint: 'Audited and visible to the tenant admins: a ticket id and what you need to check (10–500 characters).',
          wide: true,
        },
        { name: 'minutes', label: 'Duration (minutes)', type: 'number', required: true, value: '60', min: 5, max: 480, hint: '5 to 480 minutes.' },
        {
          name: 'role',
          label: 'Grafana role',
          type: 'select',
          value: 'Viewer',
          options: [
            { value: 'Viewer', label: 'Viewer (read only)' },
            { value: 'Editor', label: 'Editor (can change dashboards)' },
          ],
        },
      ],
      onSubmit: (values) => api.support.grant(tenantKey, { reason: values.reason.trim(), minutes: values.minutes, role: values.role }),
    });

    if (created) {
      toast({ title: 'Support access granted', message: `${created.role} on ${tenantKey} until ${formatDate(created.expiresAt)}.` });
      reload();
    }
  }

  mount(
    container,
    h(
      'div',
      { class: 'tab-toolbar' },
      h(
        'p',
        { class: 'muted' },
        platform
          ? 'Temporary access of platform admins to this tenant’s Grafana org. Every grant is audited and visible to the tenant.'
          : 'Platform admins who had temporary access to your Grafana org, and why. Access always ends automatically.',
      ),
      h('div', { class: 'spacer' }),
      button({ icon: 'sync', variant: 'ghost', title: 'Refresh', onClick: () => reload() }),
      platform && tenant.grafanaOrgId !== null && button({ label: 'Grafana', icon: 'external', variant: 'secondary', href: grafanaUrl(tenant.grafanaOrgId), target: '_blank' }),
      platform && button({ label: 'Request access', icon: 'shield', variant: 'primary', id: 'grant-access', onClick: grant }),
    ),
    content,
  );

  reload();
}
