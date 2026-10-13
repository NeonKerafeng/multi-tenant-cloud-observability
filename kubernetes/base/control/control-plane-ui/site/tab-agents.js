// Tenant agents (OTel collectors on hosts): list, enable/disable, revoke.

import { api } from './api.js';
import { formatDate, h, mount, shortId, timeEl } from './dom.js';
import { href } from './router.js';
import {
  button,
  card,
  confirmAction,
  copyable,
  dataTable,
  detailList,
  emptyState,
  loadInto,
  modal,
  rowActions,
  skeleton,
  tag,
  toast,
  toastError,
} from './ui.js';

const STATUS_HELP = {
  provisioning: 'Being created in Keycloak; it becomes active in a moment.',
  active: 'Sends metrics and logs.',
  disabled: 'Data from this host is rejected until enabled again.',
  revoked: 'Permanently removed; enroll the host again to bring it back.',
};

export function agentsTab(container, tenant) {
  const content = h('div');
  const tenantKey = tenant.tenantKey;
  const key = encodeURIComponent(tenantKey);

  const reload = () =>
    loadInto(content, () => api.agents.list(tenantKey), ({ items }) =>
      card({
        flush: true,
        body: dataTable({
          rows: items,
          search: (a) => `${a.clientId} ${a.id}`,
          searchPlaceholder: 'Search client id or agent id…',
          filters: [
            {
              id: 'status',
              label: 'Status',
              value: 'live',
              options: [
                { value: 'live', label: 'Live (not revoked)', test: (a) => a.status !== 'revoked' },
                { value: 'active', label: 'Active', test: (a) => a.status === 'active' },
                { value: 'disabled', label: 'Disabled', test: (a) => a.status === 'disabled' },
                { value: 'provisioning', label: 'Provisioning', test: (a) => a.status === 'provisioning' },
                { value: 'revoked', label: 'Revoked', test: (a) => a.status === 'revoked' },
                { value: 'all', label: 'All agents' },
              ],
            },
          ],
          onRowClick: (a) => showAgent(a),
          empty: emptyState({
            icon: 'agent',
            title: 'No agents yet',
            text: 'Agents are enrolled with a one-time token: create one, then run bootstrap.sh on the host.',
            action: button({ label: 'Create enrollment token', icon: 'key', variant: 'primary', href: href(`/tenants/${key}/enrollments`) }),
          }),
          columns: [
            {
              key: 'clientId',
              label: 'Agent',
              sort: (a) => a.clientId,
              render: (a) => h('div', { class: 'stacked' }, h('code', { class: 'truncate', title: a.clientId }, a.clientId), h('span', { class: 'muted small' }, `id ${shortId(a.id)}`)),
            },
            { key: 'status', label: 'Status', sort: (a) => a.status, render: (a) => h('span', { title: STATUS_HELP[a.status] }, tag(a.status)) },
            { key: 'createdAt', label: 'Enrolled', sort: (a) => a.createdAt, render: (a) => timeEl(a.createdAt) },
            {
              key: 'actions',
              label: '',
              class: 'col-actions',
              render: (a) =>
                rowActions(
                  (a.status === 'active' || a.status === 'disabled') &&
                    button({ icon: 'power', variant: 'ghost', size: 'sm', title: a.enabled ? 'Disable agent' : 'Enable agent', onClick: () => setEnabled(a, !a.enabled) }),
                  a.status !== 'revoked' && button({ icon: 'ban', variant: 'ghost-danger', size: 'sm', title: 'Revoke agent', onClick: () => revoke(a) }),
                ),
            },
          ],
        }),
      }),
    );

  async function setEnabled(agent, enabled) {
    if (!enabled) {
      const done = await confirmAction({
        title: 'Disable this agent?',
        message: 'The host keeps running but its data is rejected until you enable the agent again.',
        details: h('code', {}, agent.clientId),
        confirmLabel: 'Disable agent',
        tone: 'warn',
        action: () => api.agents.setEnabled(tenantKey, agent.id, false),
      });

      if (done) {
        toast({ title: 'Agent disabled', message: agent.clientId });
        reload();
      }

      return;
    }

    try {
      await api.agents.setEnabled(tenantKey, agent.id, true);
      toast({ title: 'Agent enabled', message: agent.clientId });
      reload();
    } catch (error) {
      toastError(error, 'Could not enable agent');
    }
  }

  async function revoke(agent) {
    const done = await confirmAction({
      title: 'Revoke this agent?',
      message: 'Its credentials are deleted: the host can no longer send data. To bring the host back, enroll it again with a new token.',
      details: h('code', {}, agent.clientId),
      confirmLabel: 'Revoke agent',
      action: () => api.agents.revoke(tenantKey, agent.id),
    });

    if (done) {
      toast({ title: 'Agent revoked', message: agent.clientId });
      reload();
    }
  }

  function showAgent(agent) {
    const body = h('div');
    const dialog = modal({
      title: 'Agent',
      subtitle: agent.clientId,
      body,
      footer: [button({ label: 'Close', variant: 'primary', onClick: () => dialog.close() })],
    });

    mount(body, skeleton(4));
    loadInto(
      body,
      () => api.agents.get(tenantKey, agent.id),
      (a) =>
        detailList([
          ['Agent id', copyable(a.id)],
          ['Client id', copyable(a.clientId)],
          ['Status', h('div', { class: 'stacked' }, tag(a.status), h('span', { class: 'muted small' }, STATUS_HELP[a.status]))],
          ['Tenant', a.tenantKey],
          ['Enrolled', formatDate(a.createdAt)],
        ]),
    );
  }

  mount(
    container,
    h(
      'div',
      { class: 'tab-toolbar' },
      h('p', { class: 'muted' }, 'Collectors on the tenant’s hosts. Each agent has its own credentials and can be disabled or revoked at any time.'),
      h('div', { class: 'spacer' }),
      button({ icon: 'sync', variant: 'ghost', title: 'Refresh', onClick: () => reload() }),
      button({ label: 'Enroll a host', icon: 'key', variant: 'primary', href: href(`/tenants/${key}/enrollments`) }),
    ),
    content,
  );

  reload();
}
