jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

import type { ConfigService } from '@nestjs/config';

import type { AuthUser } from '../auth/auth-user';
import type { DatabaseService } from '../database/database.service';
import type { OutboxRepository } from '../sync/outbox.repository';
import type {
  TenantRecord,
  TenantRepository,
} from '../tenants/tenant.repository';

import type {
  SupportAccessRecord,
  SupportAccessRepository,
} from './support-access.repository';
import { SupportAccessService } from './support-access.service';

const GRANT_ID = '11111111-2222-4333-8444-555555555555';

function actor(
  roles: string[],
  groups: string[] = [],
): AuthUser {
  return {
    sub: 'kc-admin',
    username: 'root-admin',
    roles,
    groups,
  } as unknown as AuthUser;
}

const platformAdmin = actor(['platform-admin']);
const alphaAdmin = actor(['tenant-admin'], ['alpha-tenant']);
const betaAdmin = actor(['tenant-admin'], ['beta-tenant']);

function tenant(
  key: string,
  grafanaOrgId: number | null,
  status: TenantRecord['status'] = 'active',
): TenantRecord {
  return {
    id: `id-${key}`,
    tenantKey: key,
    vmAccountId: '1',
    keycloakGroupId: 'g',
    grafanaOrgId,
    status,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

function record(
  overrides: Partial<SupportAccessRecord> = {},
): SupportAccessRecord {
  return {
    id: GRANT_ID,
    userId: 'u-admin',
    username: 'root-admin',
    tenantId: 'id-alpha-tenant',
    tenantKey: 'alpha-tenant',
    role: 'Viewer',
    reason: 'TICKET-42 dashboard broken',
    grantedBy: 'root-admin',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

function setup(opts: {
  tenants?: TenantRecord[];
  adminUserId?: string | null;
  revokeResult?: string | null;
  claimed?: { id: string; userId: string }[];
} = {}) {
  const tenants = opts.tenants ?? [
    tenant('admin-tenant', 1),
    tenant('alpha-tenant', 7),
  ];

  const tx = { query: jest.fn() };

  const db = {
    transaction: jest.fn((fn: (q: unknown) => Promise<unknown>) => fn(tx)),
  };

  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };

  const tenantRepo = {
    findByKey: jest.fn((key: string) =>
      Promise.resolve(tenants.find((t) => t.tenantKey === key) ?? null),
    ),
  };

  const grants = {
    findPlatformAdminUserId: jest
      .fn()
      .mockResolvedValue(
        opts.adminUserId === undefined ? 'u-admin' : opts.adminUserId,
      ),
    create: jest.fn().mockResolvedValue(GRANT_ID),
    findById: jest.fn().mockResolvedValue(record()),
    list: jest.fn().mockResolvedValue([record()]),
    revoke: jest
      .fn()
      .mockResolvedValue(
        opts.revokeResult === undefined ? 'u-admin' : opts.revokeResult,
      ),
    claimExpired: jest.fn().mockResolvedValue(opts.claimed ?? []),
  };

  const config = {
    get: jest.fn(() => undefined),
  };

  const service = new SupportAccessService(
    db as unknown as DatabaseService,
    outbox as unknown as OutboxRepository,
    tenantRepo as unknown as TenantRepository,
    grants as unknown as SupportAccessRepository,
    config as unknown as ConfigService,
  );

  return { service, outbox, grants, tx };
}

describe('SupportAccessService.grant', () => {
  it('creates a Viewer grant for 60 min and enqueues the admin in the same transaction', async () => {
    const { service, grants, outbox, tx } = setup();

    const response = await service.grant(platformAdmin, 'alpha-tenant', {
      reason: '  TICKET-42 dashboard broken  ',
    });

    expect(grants.create).toHaveBeenCalledWith(tx, {
      userId: 'u-admin',
      tenantId: 'id-alpha-tenant',
      role: 'Viewer',
      reason: 'TICKET-42 dashboard broken',
      grantedBy: 'root-admin',
      minutes: 60,
    });
    expect(outbox.enqueue).toHaveBeenCalledWith(tx, 'user', 'u-admin');
    expect(response).toMatchObject({ id: GRANT_ID, active: true });
  });

  it('only platform admins can grant', async () => {
    const { service, grants } = setup();

    await expect(
      service.grant(alphaAdmin, 'alpha-tenant', {
        reason: 'TICKET-42 dashboard broken',
      }),
    ).rejects.toThrow(/platform-admin/);
    expect(grants.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ reason: 'short' }, /reason/],
    [{ reason: 'TICKET-42 dashboard broken', minutes: 1 }, /minutes/],
    [{ reason: 'TICKET-42 dashboard broken', minutes: 481 }, /minutes/],
    [{ reason: 'TICKET-42 dashboard broken', minutes: '60' }, /minutes/],
    [{ reason: 'TICKET-42 dashboard broken', role: 'Admin' }, /role/],
  ])('rejects invalid input %j', async (input, message) => {
    const { service, grants } = setup();

    await expect(
      service.grant(platformAdmin, 'alpha-tenant', input),
    ).rejects.toThrow(message);
    expect(grants.create).not.toHaveBeenCalled();
  });

  it('refuses the platform org itself', async () => {
    const { service } = setup();

    await expect(
      service.grant(platformAdmin, 'admin-tenant', {
        reason: 'TICKET-42 dashboard broken',
      }),
    ).rejects.toThrow(/platform org/);
  });

  it('refuses a tenant that is not active', async () => {
    const { service } = setup({
      tenants: [tenant('alpha-tenant', 7, 'deleting')],
    });

    await expect(
      service.grant(platformAdmin, 'alpha-tenant', {
        reason: 'TICKET-42 dashboard broken',
      }),
    ).rejects.toThrow(/deleting/);
  });

  it('asks for a resync when the admin is not registered yet', async () => {
    const { service } = setup({ adminUserId: null });

    await expect(
      service.grant(platformAdmin, 'alpha-tenant', {
        reason: 'TICKET-42 dashboard broken',
      }),
    ).rejects.toThrow(/resync/);
  });
});

describe('SupportAccessService oversight', () => {
  it('the tenant admin can list grants on their own tenant', async () => {
    const { service, grants } = setup();

    await service.listForTenant(alphaAdmin, 'alpha-tenant', true);

    expect(grants.list).toHaveBeenCalledWith('id-alpha-tenant', true);
  });

  it('another tenant admin cannot', async () => {
    const { service } = setup();

    await expect(
      service.listForTenant(betaAdmin, 'alpha-tenant', false),
    ).rejects.toThrow(/tenant-admin/);
  });

  it('the tenant admin can revoke; the admin is enqueued to lose access', async () => {
    const { service, grants, outbox, tx } = setup();

    await service.revoke(alphaAdmin, 'alpha-tenant', GRANT_ID);

    expect(grants.revoke).toHaveBeenCalledWith(tx, GRANT_ID, 'root-admin');
    expect(outbox.enqueue).toHaveBeenCalledWith(tx, 'user', 'u-admin');
  });

  it('revoking an already ended grant enqueues nothing', async () => {
    const { service, outbox } = setup({ revokeResult: null });

    await service.revoke(platformAdmin, 'alpha-tenant', GRANT_ID);

    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('a grant of another tenant is not found through this tenant', async () => {
    const { service, grants } = setup({
      tenants: [tenant('alpha-tenant', 7), tenant('beta-tenant', 8)],
    });

    await expect(
      service.revoke(betaAdmin, 'beta-tenant', GRANT_ID),
    ).rejects.toThrow(/not found/);
    expect(grants.revoke).not.toHaveBeenCalled();
  });
});

describe('SupportAccessService.sweepExpired', () => {
  it('enqueues each affected admin once', async () => {
    const { service, outbox } = setup({
      claimed: [
        { id: 'g1', userId: 'u-admin' },
        { id: 'g2', userId: 'u-admin' },
        { id: 'g3', userId: 'u-other' },
      ],
    });

    await expect(service.sweepExpired()).resolves.toBe(3);

    expect(outbox.enqueue.mock.calls.map((call: unknown[]) => call[2])).toEqual([
      'u-admin',
      'u-other',
    ]);
  });
});
