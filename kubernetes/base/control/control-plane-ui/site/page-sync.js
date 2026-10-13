// Outbox synchronisation to Keycloak and Grafana (platform-admin).

import { api } from './api.js';
import { duration, h, icon, mount, shortId } from './dom.js';
import { href, onLeave } from './router.js';
import { button, card, confirmAction, dataTable, emptyState, loadInto, pageHeader, tag, toast } from './ui.js';

const REFRESH_MS = 10_000;
const TARGETS = [
  { id: 'keycloak', label: 'Keycloak', text: 'Users, groups and agent clients (identity).' },
  { id: 'grafana', label: 'Grafana', text: 'Organisations and user memberships (dashboards).' },
];

function targetHealth(t) {
  if (t.failing > 0) {
    return 'failing';
  }

  return t.pending > 0 && t.oldestPendingSeconds > 60 ? 'degraded' : 'healthy';
}

/** healthy | degraded | failing for the whole outbox. */
export function syncHealth(status) {
  const states = TARGETS.map((t) => targetHealth(status.targets[t.id]));

  return states.includes('failing') ? 'failing' : states.includes('degraded') ? 'degraded' : 'healthy';
}

function targetCard(target, t) {
  const health = targetHealth(t);

  return h(
    'section',
    { class: `target target-${health}` },
    h('header', { class: 'target-head' }, h('h2', {}, target.label), tag(health)),
    h('p', { class: 'muted small' }, target.text),
    h(
      'div',
      { class: 'target-stats' },
      h('div', {}, h('strong', {}, String(t.pending)), h('span', {}, 'pending')),
      h('div', {}, h('strong', {}, String(t.failing)), h('span', {}, 'failing (3+ tries)')),
      h('div', {}, h('strong', {}, duration(t.oldestPendingSeconds)), h('span', {}, 'oldest pending')),
    ),
  );
}

function resyncResult(result) {
  return h(
    'div',
    { class: 'resync-result' },
    h('h3', { class: 'section-title' }, icon('check', 16), 'Resync queued'),
    h(
      'div',
      { class: 'target-stats' },
      h('div', {}, h('strong', {}, String(result.tenantsQueued)), h('span', {}, 'tenants')),
      h('div', {}, h('strong', {}, String(result.usersQueued)), h('span', {}, 'users')),
      h('div', {}, h('strong', {}, String(result.agentsQueued)), h('span', {}, 'agents')),
      h('div', {}, h('strong', {}, String(result.orphansDeleted)), h('span', {}, 'orphans deleted')),
      h('div', {}, h('strong', {}, String(result.orphansPending)), h('span', {}, 'orphans pending')),
    ),
    result.orphansPending > 0 &&
      h('p', { class: 'muted small' }, 'Pending orphans are Keycloak objects seen for the first time without a database owner. A resync at least 2 minutes later deletes them if they are still orphaned.'),
  );
}

export function syncPage(view) {
  const content = h('div', { class: 'stack' });
  const resultSlot = h('div');
  const stamp = h('span', { class: 'muted small' });
  let auto = true;

  const refresh = (keep = false) =>
    loadInto(
      content,
      () => api.sync.status(),
      (status) => {
        mount(stamp, `Updated ${new Date().toLocaleTimeString()}`);

        return [
          h('div', { class: 'grid-2' }, TARGETS.map((t) => targetCard(t, status.targets[t.id]))),
          card({
            title: 'Recent errors',
            icon: 'alert',
            flush: true,
            body: dataTable({
              rows: status.recentErrors,
              rowKey: (e) => `${e.target}-${e.aggregateId}`,
              empty: emptyState({ icon: 'check', title: 'No recent errors', text: 'Every change reached Keycloak and Grafana.' }),
              columns: [
                { key: 'target', label: 'Target', render: (e) => tag(e.target, 'dark') },
                { key: 'aggregateType', label: 'Object', render: (e) => h('div', { class: 'stacked' }, h('strong', {}, e.aggregateType), h('code', { class: 'small', title: e.aggregateId }, shortId(e.aggregateId))) },
                { key: 'attempts', label: 'Attempts', sort: (e) => e.attempts, render: (e) => h('strong', { class: e.attempts >= 3 ? 'text-danger' : '' }, String(e.attempts)) },
                { key: 'lastError', label: 'Last error', render: (e) => h('span', { class: 'mono small wrap' }, e.lastError ?? '—') },
              ],
            }),
          }),
        ];
      },
      { lines: 5, keep },
    );

  const timer = setInterval(() => auto && document.visibilityState === 'visible' && refresh(true), REFRESH_MS);

  onLeave(() => clearInterval(timer));

  const autoToggle = h('label', { class: 'switch' },
    h('input', { type: 'checkbox', checked: true, onchange: (e) => (auto = e.target.checked) }),
    h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
    h('span', {}, 'Auto-refresh'),
  );

  mount(
    view,
    h(
      'div',
      { class: 'page' },
      pageHeader({
        title: 'Sync status',
        subtitle: 'The database is the source of truth; Keycloak and Grafana are mirrors kept in sync through the outbox.',
        crumbs: [{ label: 'Platform', href: href('/') }, { label: 'Sync status' }],
        actions: [
          stamp,
          autoToggle,
          button({ icon: 'sync', variant: 'ghost', title: 'Refresh now', onClick: () => refresh() }),
          button({
            label: 'Resync everything',
            icon: 'sync',
            variant: 'primary',
            id: 'resync',
            onClick: async () => {
              const result = await confirmAction({
                title: 'Resync everything?',
                message: 'Queues every tenant, user and agent for synchronisation again and garbage-collects Keycloak objects that no longer have an owner. Safe to run; it only repairs drift.',
                confirmLabel: 'Resync',
                tone: 'brand',
                action: () => api.sync.resync(),
              });

              if (result) {
                mount(resultSlot, card({ body: resyncResult(result) }));
                toast({ title: 'Resync queued', message: `${result.tenantsQueued + result.usersQueued + result.agentsQueued} object(s) queued.` });
                refresh();
              }
            },
          }),
        ],
      }),
      resultSlot,
      content,
    ),
  );

  refresh();
}
