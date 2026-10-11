import { tenant, user } from '../../common/testing/fixtures';
import type {
  GrafanaClient,
  GrafanaOrgMembership,
} from '../../integrations/grafana/grafana.client';
import type {
  ActiveSupportGrant,
  SupportAccessRepository,
} from '../../modules/support-access/support-access.repository';
import type {
  TenantRecord,
  TenantRepository,
} from '../../modules/tenants/tenant.repository';
import type {
  UserRecord,
  UserRepository,
} from '../../modules/users/user.repository';

import { GrafanaUserMirror } from './grafana-user.mirror';

function platformAdmin(overrides: Partial<UserRecord> = {}): UserRecord {
  return user({
    role: 'platform-admin',
    tenantId: null,
    tenantKey: null,
    ...overrides,
  });
}

function setup(opts: {
  user?: UserRecord;
  tenants?: TenantRecord[];
  orgs?: GrafanaOrgMembership[];
  existingGrafanaUser?: { id: number } | null;
  grants?: ActiveSupportGrant[];
}) {
  const tenants = opts.tenants ?? [tenant()];

  const tenantRepo = {
    findById: jest.fn((id: string) =>
      Promise.resolve(tenants.find((t) => t.id === id) ?? null),
    ),
  };

  const userRepo = {
    findById: jest.fn().mockResolvedValue(opts.user ?? user()),
    setGrafanaUserId: jest.fn().mockResolvedValue(undefined),
  };

  const grafana = {
    getUser: jest.fn().mockResolvedValue(null),
    lookupUser: jest.fn().mockResolvedValue(opts.existingGrafanaUser ?? null),
    createUser: jest.fn().mockResolvedValue(42),
    deleteUser: jest.fn().mockResolvedValue(undefined),
    getUserOrgs: jest.fn().mockResolvedValue(opts.orgs ?? []),
    addOrgUser: jest.fn().mockResolvedValue(undefined),
    updateOrgUserRole: jest.fn().mockResolvedValue(undefined),
    removeOrgUser: jest.fn().mockResolvedValue(undefined),
  };

  const supportAccess = {
    findActiveGrantsForUser: jest.fn().mockResolvedValue(opts.grants ?? []),
  };

  const mirror = new GrafanaUserMirror(
    grafana as unknown as GrafanaClient,
    userRepo as unknown as UserRepository,
    tenantRepo as unknown as TenantRepository,
    supportAccess as unknown as SupportAccessRepository,
  );

  return { mirror, grafana, userRepo };
}

describe('GrafanaUserMirror (tenant users)', () => {
  it('creates a missing Grafana user in its tenant org and removes other orgs', async () => {
    const { mirror, grafana, userRepo } = setup({
      orgs: [{ orgId: 1, name: 'Main Org.', role: 'Viewer' }],
    });

    await mirror.sync('u1');

    expect(grafana.createUser).toHaveBeenCalledWith({
      login: 'alice',
      email: 'alice@example.com',
      name: 'alice',
      orgId: 7,
    });
    expect(userRepo.setGrafanaUserId).toHaveBeenCalledWith(user().id, 42);
    expect(grafana.addOrgUser).toHaveBeenCalledWith(
      7,
      'alice@example.com',
      'Viewer',
    );
    expect(grafana.removeOrgUser).toHaveBeenCalledWith(1, 42);
  });

  it('reuses an existing Grafana account found by email (no duplicate)', async () => {
    const { mirror, grafana, userRepo } = setup({
      existingGrafanaUser: { id: 5 },
      orgs: [{ orgId: 7, name: 'alpha-tenant', role: 'Viewer' }],
    });

    await mirror.sync('u1');

    expect(grafana.createUser).not.toHaveBeenCalled();
    expect(userRepo.setGrafanaUserId).toHaveBeenCalledWith(user().id, 5);
    expect(grafana.addOrgUser).not.toHaveBeenCalled();
    expect(grafana.removeOrgUser).not.toHaveBeenCalled();
  });

  it('fixes a wrong org role (tenant-admin = Editor, never Admin)', async () => {
    const { mirror, grafana } = setup({
      user: user({ role: 'tenant-admin', grafanaUserId: 5 }),
      orgs: [{ orgId: 7, name: 'alpha-tenant', role: 'Admin' }],
    });
    grafana.getUser.mockResolvedValue({
      id: 5,
      login: 'alice',
      email: 'alice@example.com',
    });

    await mirror.sync('u1');

    expect(grafana.updateOrgUserRole).toHaveBeenCalledWith(7, 5, 'Editor');
  });

  it('ignores a stored id that now belongs to someone else (Grafana rebuilt)', async () => {
    const { mirror, grafana } = setup({
      user: user({ grafanaUserId: 2 }),
      existingGrafanaUser: null,
    });
    grafana.getUser.mockResolvedValue({
      id: 2,
      login: 'alpha-admin',
      email: 'x@example.com',
    });

    await mirror.sync('u1');

    expect(grafana.createUser).toHaveBeenCalled();
  });

  it.each([
    ['a disabled user', { enabled: false, grafanaUserId: 5 }],
    ['a deleted user', { status: 'deleted' as const, grafanaUserId: 5 }],
  ])('deletes the Grafana account of %s', async (_label, overrides) => {
    const { mirror, grafana, userRepo } = setup({ user: user(overrides) });

    await mirror.sync('u1');

    expect(grafana.deleteUser).toHaveBeenCalledWith(5);
    expect(userRepo.setGrafanaUserId).toHaveBeenCalledWith(user().id, null);
    expect(grafana.addOrgUser).not.toHaveBeenCalled();
  });

  it('deletes the Grafana account when the tenant is gone', async () => {
    const { mirror, grafana } = setup({
      user: user({ grafanaUserId: 5 }),
      tenants: [tenant({ status: 'deleted' })],
    });

    await mirror.sync('u1');

    expect(grafana.deleteUser).toHaveBeenCalledWith(5);
  });

  it('retries later when the tenant org does not exist yet', async () => {
    const { mirror, grafana } = setup({
      tenants: [tenant({ grafanaOrgId: null })],
    });

    await expect(mirror.sync('u1')).rejects.toThrow(/not provisioned/);
    expect(grafana.createUser).not.toHaveBeenCalled();
  });
});

describe('GrafanaUserMirror (platform admins, model C)', () => {
  it('without a grant: only the platform org, removed from tenant orgs', async () => {
    const { mirror, grafana } = setup({
      user: platformAdmin(),
      orgs: [
        { orgId: 1, name: 'admin-tenant', role: 'Admin' },
        { orgId: 7, name: 'alpha-tenant', role: 'Editor' },
      ],
    });

    await mirror.sync('u1');

    expect(grafana.updateOrgUserRole).toHaveBeenCalledWith(1, 42, 'Editor');
    expect(grafana.addOrgUser).not.toHaveBeenCalled();
    expect(grafana.removeOrgUser).toHaveBeenCalledWith(7, 42);
    expect(grafana.removeOrgUser).toHaveBeenCalledTimes(1);
  });

  it('with an active grant: joins that tenant org with the grant role', async () => {
    const { mirror, grafana } = setup({
      user: platformAdmin(),
      grants: [{ grafanaOrgId: 7, role: 'Viewer' }],
      orgs: [{ orgId: 1, name: 'admin-tenant', role: 'Editor' }],
    });

    await mirror.sync('u1');

    expect(grafana.addOrgUser).toHaveBeenCalledWith(
      7,
      'alice@example.com',
      'Viewer',
    );
    expect(grafana.addOrgUser).toHaveBeenCalledTimes(1);
    expect(grafana.removeOrgUser).not.toHaveBeenCalled();
  });

  it('several grants on one org: the strongest role wins', async () => {
    const { mirror, grafana } = setup({
      user: platformAdmin(),
      grants: [
        { grafanaOrgId: 7, role: 'Viewer' },
        { grafanaOrgId: 7, role: 'Editor' },
      ],
      orgs: [
        { orgId: 1, name: 'admin-tenant', role: 'Editor' },
        { orgId: 7, name: 'alpha-tenant', role: 'Viewer' },
      ],
    });

    await mirror.sync('u1');

    expect(grafana.updateOrgUserRole).toHaveBeenCalledWith(7, 42, 'Editor');
  });

  it('a grant never lowers the platform org role', async () => {
    const { mirror, grafana } = setup({
      user: platformAdmin(),
      grants: [{ grafanaOrgId: 1, role: 'Viewer' }],
      orgs: [{ orgId: 1, name: 'admin-tenant', role: 'Editor' }],
    });

    await mirror.sync('u1');

    expect(grafana.updateOrgUserRole).not.toHaveBeenCalled();
    expect(grafana.removeOrgUser).not.toHaveBeenCalled();
  });
});
