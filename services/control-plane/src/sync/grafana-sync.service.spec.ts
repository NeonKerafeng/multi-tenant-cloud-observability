jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

import type { DatabaseService } from '../database/database.service';
import type {
  GrafanaAdminService,
  GrafanaOrgMembership,
} from '../grafana/grafana-admin.service';
import type {
  ActiveSupportGrant,
  SupportAccessRepository,
} from '../support-access/support-access.repository';
import type { TenantGrafanaService } from '../tenants/tenant-grafana.service';
import type {
  TenantRecord,
  TenantRepository,
} from '../tenants/tenant.repository';
import type { UserRecord, UserRepository } from '../users/user.repository';

import { GrafanaSyncService } from './grafana-sync.service';
import type { OutboxRepository } from './outbox.repository';

function tenant(
  id: string,
  grafanaOrgId: number | null,
  status: TenantRecord['status'] = 'active',
): TenantRecord {
  return {
    id,
    tenantKey: `${id}-key`,
    vmAccountId: '1',
    keycloakGroupId: 'g',
    grafanaOrgId,
    status,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'u1',
    keycloakUserId: 'kc1',
    tenantId: 'alpha',
    tenantKey: 'alpha-key',
    username: 'alice',
    email: 'alice@example.com',
    role: 'viewer',
    enabled: true,
    grafanaUserId: null,
    status: 'active',
    ...overrides,
  };
}

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
  const tenants = opts.tenants ?? [tenant('alpha', 7)];

  const tenantRepo = {
    findAll: jest.fn().mockResolvedValue(tenants),
    findById: jest.fn((id: string) =>
      Promise.resolve(tenants.find((t) => t.id === id) ?? null),
    ),
  };

  const userRepo = {
    findById: jest.fn().mockResolvedValue(opts.user ?? user()),
    setGrafanaUserId: jest.fn().mockResolvedValue(undefined),
    findIdsByTenant: jest.fn().mockResolvedValue(['u1', 'u2']),
    findPlatformAdminIds: jest.fn().mockResolvedValue(['admin1']),
  };

  const grafana = {
    getUser: jest.fn().mockResolvedValue(null),
    lookupUser: jest
      .fn()
      .mockResolvedValue(opts.existingGrafanaUser ?? null),
    createUser: jest.fn().mockResolvedValue(42),
    deleteUser: jest.fn().mockResolvedValue(undefined),
    getUserOrgs: jest.fn().mockResolvedValue(opts.orgs ?? []),
    addOrgUser: jest.fn().mockResolvedValue(undefined),
    updateOrgUserRole: jest.fn().mockResolvedValue(undefined),
    removeOrgUser: jest.fn().mockResolvedValue(undefined),
  };

  const tenantGrafana = {
    provisionOrg: jest.fn().mockResolvedValue(7),
    removeOrg: jest.fn().mockResolvedValue(undefined),
  };

  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };

  const supportAccess = {
    findActiveGrantsForUser: jest.fn().mockResolvedValue(opts.grants ?? []),
    findOpenUserIdsByTenant: jest.fn().mockResolvedValue(['admin1']),
  };

  const service = new GrafanaSyncService(
    {} as DatabaseService,
    outbox as unknown as OutboxRepository,
    tenantRepo as unknown as TenantRepository,
    userRepo as unknown as UserRepository,
    tenantGrafana as unknown as TenantGrafanaService,
    grafana as unknown as GrafanaAdminService,
    supportAccess as unknown as SupportAccessRepository,
  );

  return { service, grafana, userRepo, tenantGrafana, outbox, supportAccess };
}

describe('GrafanaSyncService.syncUser', () => {
  it('creates a missing Grafana user in its tenant org and removes other orgs', async () => {
    const { service, grafana, userRepo } = setup({
      orgs: [{ orgId: 1, name: 'Main Org.', role: 'Viewer' }],
    });

    await service.syncUser('u1');

    expect(grafana.createUser).toHaveBeenCalledWith({
      login: 'alice',
      email: 'alice@example.com',
      name: 'alice',
      orgId: 7,
    });
    expect(userRepo.setGrafanaUserId).toHaveBeenCalledWith('u1', 42);
    expect(grafana.addOrgUser).toHaveBeenCalledWith(
      7,
      'alice@example.com',
      'Viewer',
    );
    expect(grafana.removeOrgUser).toHaveBeenCalledWith(1, 42);
  });

  it('reuses an existing Grafana account found by email (no duplicate)', async () => {
    const { service, grafana, userRepo } = setup({
      existingGrafanaUser: { id: 5 },
      orgs: [{ orgId: 7, name: 'alpha-key', role: 'Viewer' }],
    });

    await service.syncUser('u1');

    expect(grafana.createUser).not.toHaveBeenCalled();
    expect(userRepo.setGrafanaUserId).toHaveBeenCalledWith('u1', 5);
    expect(grafana.addOrgUser).not.toHaveBeenCalled();
    expect(grafana.removeOrgUser).not.toHaveBeenCalled();
  });

  it('fixes a wrong org role', async () => {
    const { service, grafana } = setup({
      user: user({ role: 'tenant-admin', grafanaUserId: 5 }),
      orgs: [{ orgId: 7, name: 'alpha-key', role: 'Admin' }],
    });
    grafana.getUser.mockResolvedValue({ id: 5 });

    await service.syncUser('u1');

    expect(grafana.updateOrgUserRole).toHaveBeenCalledWith(7, 5, 'Editor');
  });

  it('deletes the Grafana account of a disabled user (Grafana cannot disable SSO users)', async () => {
    const { service, grafana, userRepo } = setup({
      user: user({ enabled: false, grafanaUserId: 5 }),
    });

    await service.syncUser('u1');

    expect(grafana.deleteUser).toHaveBeenCalledWith(5);
    expect(userRepo.setGrafanaUserId).toHaveBeenCalledWith('u1', null);
    expect(grafana.createUser).not.toHaveBeenCalled();
  });

  it('deletes the Grafana account of a deleted user', async () => {
    const { service, grafana, userRepo } = setup({
      user: user({ status: 'deleted', grafanaUserId: 5 }),
    });

    await service.syncUser('u1');

    expect(grafana.deleteUser).toHaveBeenCalledWith(5);
    expect(userRepo.setGrafanaUserId).toHaveBeenCalledWith('u1', null);
    expect(grafana.addOrgUser).not.toHaveBeenCalled();
  });

  it('deletes the Grafana account when the tenant is gone', async () => {
    const { service, grafana } = setup({
      user: user({ grafanaUserId: 5 }),
      tenants: [tenant('alpha', 7, 'deleted')],
    });

    await service.syncUser('u1');

    expect(grafana.deleteUser).toHaveBeenCalledWith(5);
  });

  it('retries later when the tenant org does not exist yet', async () => {
    const { service, grafana } = setup({
      tenants: [tenant('alpha', null)],
    });

    await expect(service.syncUser('u1')).rejects.toThrow(/not provisioned/);
    expect(grafana.createUser).not.toHaveBeenCalled();
  });
});

describe('GrafanaSyncService platform admins (model C)', () => {
  it('without a grant: only the platform org, removed from tenant orgs', async () => {
    const { service, grafana } = setup({
      user: platformAdmin(),
      tenants: [tenant('admin', 1), tenant('alpha', 7), tenant('beta', 8)],
      orgs: [
        { orgId: 1, name: 'admin-key', role: 'Admin' },
        { orgId: 7, name: 'alpha-key', role: 'Editor' },
      ],
    });

    await service.syncUser('u1');

    expect(grafana.updateOrgUserRole).toHaveBeenCalledWith(1, 42, 'Editor');
    expect(grafana.addOrgUser).not.toHaveBeenCalled();
    expect(grafana.removeOrgUser).toHaveBeenCalledWith(7, 42);
    expect(grafana.removeOrgUser).toHaveBeenCalledTimes(1);
  });

  it('with an active grant: joins that tenant org with the grant role', async () => {
    const { service, grafana } = setup({
      user: platformAdmin(),
      grants: [{ grafanaOrgId: 7, role: 'Viewer' }],
      orgs: [{ orgId: 1, name: 'admin-key', role: 'Editor' }],
    });

    await service.syncUser('u1');

    expect(grafana.addOrgUser).toHaveBeenCalledWith(7, 'alice@example.com', 'Viewer');
    expect(grafana.addOrgUser).toHaveBeenCalledTimes(1);
    expect(grafana.removeOrgUser).not.toHaveBeenCalled();
  });

  it('several grants on one org: the strongest role wins', async () => {
    const { service, grafana } = setup({
      user: platformAdmin(),
      grants: [
        { grafanaOrgId: 7, role: 'Viewer' },
        { grafanaOrgId: 7, role: 'Editor' },
      ],
      orgs: [
        { orgId: 1, name: 'admin-key', role: 'Editor' },
        { orgId: 7, name: 'alpha-key', role: 'Viewer' },
      ],
    });

    await service.syncUser('u1');

    expect(grafana.updateOrgUserRole).toHaveBeenCalledWith(7, 42, 'Editor');
  });

  it('a grant never lowers the platform org role', async () => {
    const { service, grafana } = setup({
      user: platformAdmin(),
      grants: [{ grafanaOrgId: 1, role: 'Viewer' }],
      orgs: [{ orgId: 1, name: 'admin-key', role: 'Editor' }],
    });

    await service.syncUser('u1');

    expect(grafana.updateOrgUserRole).not.toHaveBeenCalled();
    expect(grafana.removeOrgUser).not.toHaveBeenCalled();
  });
});

describe('GrafanaSyncService.syncTenant', () => {
  it('provisions an active tenant and re-syncs its users and grant holders', async () => {
    const { service, tenantGrafana, outbox, supportAccess } = setup({});

    await service.syncTenant('alpha');

    expect(tenantGrafana.provisionOrg).toHaveBeenCalled();
    expect(supportAccess.findOpenUserIdsByTenant).toHaveBeenCalledWith('alpha');
    expect(outbox.enqueue.mock.calls.map((call: unknown[]) => call[2])).toEqual([
      'u1',
      'u2',
      'admin1',
    ]);
  });

  it('removes the org of a deleted tenant', async () => {
    const { service, tenantGrafana } = setup({
      tenants: [tenant('alpha', 7, 'deleted')],
    });

    await service.syncTenant('alpha');

    expect(tenantGrafana.removeOrg).toHaveBeenCalled();
    expect(tenantGrafana.provisionOrg).not.toHaveBeenCalled();
  });

  it('does nothing while the tenant is still provisioning', async () => {
    const { service, tenantGrafana, outbox } = setup({
      tenants: [tenant('alpha', null, 'provisioning')],
    });

    await service.syncTenant('alpha');

    expect(tenantGrafana.provisionOrg).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
