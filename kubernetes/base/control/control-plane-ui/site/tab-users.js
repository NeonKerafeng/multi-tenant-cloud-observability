// Tenant users: list, create, enable/disable, delete.

import { api } from './api.js';
import { formatDate, fullName, h, icon, initials, mount, timeEl } from './dom.js';
import { canManageUser, creatableRoles, isPlatformAdmin } from './session.js';
import {
  button,
  card,
  confirmAction,
  copyable,
  dataTable,
  detailList,
  emptyState,
  formDialog,
  loadInto,
  modal,
  rowActions,
  tag,
  toast,
  toastError,
} from './ui.js';

const ROLE_LABELS = { 'tenant-admin': 'Tenant admin', viewer: 'Viewer' };

export function usersTab(container, tenant) {
  const content = h('div');
  const tenantKey = tenant.tenantKey;

  const reload = () =>
    loadInto(content, () => api.users.list(tenantKey), ({ items }) =>
      card({
        flush: true,
        body: dataTable({
          rows: items,
          search: (u) => `${u.username} ${u.email} ${fullName(u)}`,
          searchPlaceholder: 'Search name, username or email…',
          filters: [
            {
              id: 'role',
              label: 'Role',
              options: [
                { value: 'all', label: 'All roles' },
                { value: 'tenant-admin', label: 'Tenant admins', test: (u) => u.role === 'tenant-admin' },
                { value: 'viewer', label: 'Viewers', test: (u) => u.role === 'viewer' },
              ],
            },
            {
              id: 'state',
              label: 'Status',
              options: [
                { value: 'all', label: 'Any status' },
                { value: 'enabled', label: 'Enabled', test: (u) => u.enabled },
                { value: 'disabled', label: 'Disabled', test: (u) => !u.enabled },
              ],
            },
          ],
          onRowClick: (u) => showUser(u),
          empty: emptyState({
            icon: 'users',
            title: 'No users yet',
            text: isPlatformAdmin() ? 'Start with a tenant admin; they can add viewers themselves.' : 'Add viewers so your team can open the dashboards.',
            action: button({ label: 'New user', icon: 'plus', variant: 'primary', onClick: create }),
          }),
          columns: [
            {
              key: 'name',
              label: 'User',
              sort: (u) => fullName(u).toLowerCase(),
              render: (u) =>
                h('div', { class: 'person' }, h('span', { class: 'avatar avatar-sm' }, initials(u)), h('div', {}, h('strong', {}, fullName(u)), h('span', { class: 'muted small' }, u.username))),
            },
            { key: 'email', label: 'Email', sort: (u) => u.email, render: (u) => h('span', { class: 'truncate' }, u.email) },
            { key: 'role', label: 'Role', sort: (u) => u.role, render: (u) => tag(u.role) },
            { key: 'enabled', label: 'Status', sort: (u) => (u.enabled ? 0 : 1), render: (u) => tag(u.enabled ? 'enabled' : 'disabled') },
            { key: 'createdAt', label: 'Created', sort: (u) => u.createdAt, render: (u) => timeEl(u.createdAt) },
            {
              key: 'actions',
              label: '',
              class: 'col-actions',
              render: (u) =>
                canManageUser(u)
                  ? rowActions(
                      button({
                        icon: 'power',
                        variant: 'ghost',
                        size: 'sm',
                        title: u.enabled ? `Disable ${u.username}` : `Enable ${u.username}`,
                        onClick: () => setEnabled(u, !u.enabled),
                      }),
                      button({ icon: 'trash', variant: 'ghost-danger', size: 'sm', title: `Delete ${u.username}`, onClick: () => remove(u) }),
                    )
                  : h('span', { class: 'locked', title: 'Only a platform admin can manage tenant admins' }, icon('lock', 15)),
            },
          ],
        }),
      }),
    );

  async function create() {
    const roles = creatableRoles();
    let password = '';

    const created = await formDialog({
      title: 'New user',
      subtitle: `Account in tenant ${tenantKey}. The user signs in with this username and password.`,
      submitLabel: 'Create user',
      fields: [
        { name: 'firstName', label: 'First name', required: true, maxLength: 100, autocomplete: 'off' },
        { name: 'lastName', label: 'Last name', required: true, maxLength: 100, autocomplete: 'off' },
        { name: 'username', label: 'Username', required: true, mono: true, maxLength: 255, placeholder: `${tenantKey}-viewer`, hint: 'Lowercased, no spaces.', validate: (v) => (/^\S+$/.test(v.trim()) ? '' : 'No spaces allowed.') },
        { name: 'email', label: 'Email', type: 'email', required: true, maxLength: 254, placeholder: 'name@example.com' },
        { name: 'password', label: 'Initial password', type: 'password', required: true, generate: true, mono: true, autocomplete: 'new-password', hint: 'Use the wand to generate a strong one. Share it over a secure channel.', wide: true },
        {
          name: 'role',
          label: 'Role',
          type: 'select',
          value: 'viewer',
          disabled: roles.length === 1,
          options: roles.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
          hint: roles.length === 1 ? 'Tenant admins can create viewers only.' : 'Tenant admins manage viewers and agents; viewers only read dashboards.',
          wide: true,
        },
      ],
      onSubmit: (values) => {
        password = values.password;

        return api.users.create(tenantKey, {
          username: values.username.trim(),
          password: values.password,
          firstName: values.firstName.trim(),
          lastName: values.lastName.trim(),
          email: values.email.trim(),
          role: values.role,
        });
      },
    });

    if (!created) {
      return;
    }

    reload();

    const dialog = modal({
      title: 'User created',
      subtitle: `${fullName(created)} can sign in now.`,
      size: 'sm',
      body: [
        h('div', { class: 'alert alert-info' }, icon('info', 18), h('p', {}, 'The password is not stored in the UI; copy it now and share it securely.')),
        detailList([
          ['Username', copyable(created.username)],
          ['Password', copyable(password, { short: '•'.repeat(12) })],
          ['Role', tag(created.role)],
        ]),
      ],
      footer: [button({ label: 'Done', variant: 'primary', onClick: () => dialog.close() })],
    });
  }

  async function setEnabled(user, enabled) {
    if (!enabled) {
      const done = await confirmAction({
        title: `Disable ${user.username}?`,
        message: 'The user is blocked at their very next request and can no longer sign in. You can enable them again later.',
        confirmLabel: 'Disable user',
        tone: 'warn',
        action: () => api.users.setEnabled(tenantKey, user.id, false),
      });

      if (done) {
        toast({ title: 'User disabled', message: user.username });
        reload();
      }

      return;
    }

    try {
      await api.users.setEnabled(tenantKey, user.id, true);
      toast({ title: 'User enabled', message: user.username });
      reload();
    } catch (error) {
      toastError(error, 'Could not enable user');
    }
  }

  async function remove(user) {
    const done = await confirmAction({
      title: `Delete ${user.username}?`,
      message: `${fullName(user)} loses access immediately; the Keycloak and Grafana accounts are removed too. This cannot be undone.`,
      confirmLabel: 'Delete user',
      action: () => api.users.remove(tenantKey, user.id),
    });

    if (done) {
      toast({ title: 'User deleted', message: user.username });
      reload();
    }
  }

  function showUser(user) {
    const dialog = modal({
      title: fullName(user),
      subtitle: user.email,
      body: detailList([
        ['User id', copyable(user.id)],
        ['Username', h('code', {}, user.username)],
        ['Email', user.email],
        ['Role', tag(user.role)],
        ['Status', tag(user.enabled ? 'enabled' : 'disabled')],
        ['Tenant', user.tenantKey],
        ['Created', formatDate(user.createdAt)],
      ]),
      footer: [
        canManageUser(user) &&
          button({
            label: user.enabled ? 'Disable' : 'Enable',
            icon: 'power',
            variant: 'secondary',
            onClick: () => {
              dialog.close();
              setEnabled(user, !user.enabled);
            },
          }),
        canManageUser(user) &&
          button({
            label: 'Delete',
            icon: 'trash',
            variant: 'danger',
            onClick: () => {
              dialog.close();
              remove(user);
            },
          }),
        button({ label: 'Close', variant: 'primary', onClick: () => dialog.close() }),
      ].filter(Boolean),
    });
  }

  mount(
    container,
    h('div', { class: 'tab-toolbar' }, h('p', { class: 'muted' }, isPlatformAdmin() ? 'Tenant admins and viewers of this tenant.' : 'People of your tenant. You manage viewers; tenant admins are managed by the platform.'), h('div', { class: 'spacer' }),
      button({ icon: 'sync', variant: 'ghost', title: 'Refresh', onClick: () => reload() }),
      button({ label: 'New user', icon: 'plus', variant: 'primary', id: 'new-user', onClick: create }),
    ),
    content,
  );

  reload();
}
