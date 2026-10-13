// Agent enrollment tokens: create (shown once), list, revoke pending.

import { api } from './api.js';
import { formatDate, h, icon, mount, relative, shortId, timeEl } from './dom.js';
import { href, onLeave } from './router.js';
import { cfg } from './session.js';
import { button, card, codeBlock, confirmAction, copyButton, dataTable, emptyState, loadInto, modal, rowActions, tag, toast, toastError } from './ui.js';

export function enrollmentsTab(container, tenant) {
  const content = h('div');
  const tenantKey = tenant.tenantKey;
  const key = encodeURIComponent(tenantKey);

  const reload = () =>
    loadInto(content, () => api.enrollments.list(tenantKey), ({ items }) =>
      card({
        flush: true,
        body: dataTable({
          rows: [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          search: (e) => `${e.id} ${e.createdBy} ${e.agentId ?? ''}`,
          searchPlaceholder: 'Search id, creator or agent…',
          filters: [
            {
              id: 'state',
              label: 'State',
              options: [
                { value: 'all', label: 'All states' },
                ...['pending', 'used', 'expired', 'revoked'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1), test: (e) => e.state === s })),
              ],
            },
          ],
          empty: emptyState({
            icon: 'key',
            title: 'No enrollment tokens yet',
            text: 'A token lets one host register itself as an agent of this tenant. It works once and expires quickly.',
            action: button({ label: 'New enrollment token', icon: 'plus', variant: 'primary', onClick: create }),
          }),
          columns: [
            { key: 'state', label: 'State', sort: (e) => e.state, render: (e) => tag(e.state) },
            {
              key: 'createdAt',
              label: 'Created',
              sort: (e) => e.createdAt,
              render: (e) => h('div', { class: 'stacked' }, timeEl(e.createdAt), h('span', { class: 'muted small' }, `by ${e.createdBy}`)),
            },
            {
              key: 'expiresAt',
              label: 'Expires',
              sort: (e) => e.expiresAt,
              render: (e) => (e.state === 'pending' ? h('span', { class: 'countdown', title: formatDate(e.expiresAt) }, icon('clock', 14), relative(e.expiresAt)) : h('span', { class: 'muted', title: formatDate(e.expiresAt) }, formatDate(e.expiresAt))),
            },
            {
              key: 'outcome',
              label: 'Outcome',
              render: (e) => {
                if (e.state === 'used') {
                  return h('div', { class: 'stacked' }, h('a', { href: href(`/tenants/${key}/agents`) }, `agent ${shortId(e.agentId)}`), h('span', { class: 'muted small' }, timeEl(e.usedAt)));
                }

                if (e.state === 'revoked') {
                  return h('div', { class: 'stacked' }, h('span', {}, `by ${e.revokedBy ?? '—'}`), h('span', { class: 'muted small' }, timeEl(e.revokedAt)));
                }

                return h('span', { class: 'muted' }, e.state === 'pending' ? 'waiting for the host' : 'never used');
              },
            },
            { key: 'id', label: 'Id', render: (e) => h('code', { title: e.id }, shortId(e.id)) },
            {
              key: 'actions',
              label: '',
              class: 'col-actions',
              render: (e) => rowActions(e.state === 'pending' && button({ icon: 'ban', variant: 'ghost-danger', size: 'sm', title: 'Revoke token', onClick: () => revoke(e) })),
            },
          ],
        }),
      }),
    );

  async function create() {
    let created;

    try {
      created = await api.enrollments.create(tenantKey);
    } catch (error) {
      toastError(error, 'Could not create an enrollment token');
      return;
    }

    reload();
    showToken(created);
  }

  async function revoke(enrollment) {
    const done = await confirmAction({
      title: 'Revoke this token?',
      message: 'A host that has not used it yet can no longer enroll with it.',
      details: h('code', {}, enrollment.id),
      confirmLabel: 'Revoke token',
      action: () => api.enrollments.revoke(tenantKey, enrollment.id),
    });

    if (done) {
      toast({ title: 'Token revoked' });
      reload();
    }
  }

  mount(
    container,
    h(
      'div',
      { class: 'tab-toolbar' },
      h('p', { class: 'muted' }, 'One-time tokens that let a host enroll itself as an agent. Only the token travels to the host, never a secret.'),
      h('div', { class: 'spacer' }),
      button({ icon: 'sync', variant: 'ghost', title: 'Refresh', onClick: () => reload() }),
      button({ label: 'New enrollment token', icon: 'plus', variant: 'primary', id: 'new-enrollment', onClick: create }),
    ),
    content,
  );

  reload();
}

function showToken(created) {
  const countdown = h('strong', { class: 'countdown' });
  const tick = () => {
    const left = new Date(created.expiresAt).getTime() - Date.now();

    if (left <= 0) {
      mount(countdown, 'expired');
      countdown.classList.add('expired');
      clearInterval(timer);
      return;
    }

    const minutes = Math.floor(left / 60000);
    const seconds = Math.floor((left % 60000) / 1000);

    mount(countdown, `${minutes}:${String(seconds).padStart(2, '0')}`);
  };
  const timer = setInterval(tick, 1000);

  tick();
  onLeave(() => clearInterval(timer));

  const url = cfg.publicApiUrl || '<control-plane URL reachable from the host>';

  const dialog = modal({
    title: 'Enrollment token',
    subtitle: `Tenant ${created.tenantKey} · works once`,
    size: 'lg',
    onClose: () => clearInterval(timer),
    body: [
      h('div', { class: 'alert alert-warn' }, icon('alert', 18), h('p', {}, 'This token is shown only once. Send it to the host owner over a secure channel, and nothing else.')),
      h('div', { class: 'token' }, h('code', { class: 'token-value', id: 'enrollment-token' }, created.enrollmentToken), copyButton(created.enrollmentToken, { label: 'Copy token' })),
      h('p', { class: 'token-expiry' }, icon('clock', 16), 'Expires in ', countdown, h('span', { class: 'muted' }, ` (${formatDate(created.expiresAt)})`)),
      h('h3', { class: 'section-title' }, 'On the host'),
      h(
        'ol',
        { class: 'howto' },
        h('li', {}, 'Copy the ', h('code', {}, 'client/'), ' folder of the repository (', h('code', {}, 'bootstrap.sh'), ' and ', h('code', {}, 'otel/'), ') to the host.'),
        h('li', {}, 'In that folder, as root, run:', codeBlock(`sudo ./bootstrap.sh ${url}`)),
        h('li', {}, 'Paste the token when asked. If the exchange fails half-way, run it again with the ', h('strong', {}, 'same'), ' token.'),
      ),
    ],
    footer: [button({ label: 'Done', variant: 'primary', onClick: () => dialog.close() })],
  });
}
