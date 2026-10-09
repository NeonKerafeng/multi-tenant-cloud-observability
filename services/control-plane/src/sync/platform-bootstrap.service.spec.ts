jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

import type { ConfigService } from '@nestjs/config';

import type { DatabaseService } from '../database/database.service';
import type { KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import type {
  TenantRecord,
  TenantRepository,
} from '../tenants/tenant.repository';
import type { KeycloakUsersService } from '../users/keycloak-users.service';
import type { UserRecord, UserRepository } from '../users/user.repository';

import type { OutboxRepository } from './outbox.repository';
import { PlatformBootstrapService } from './platform-bootstrap.service';

function tenant(
  key: string,
  groupId: string | null,
  status: TenantRecord['status'] = 'active',
): TenantRecord {
  return {
    id: `id-${key}`,
    tenantKey: key,
    vmAccountId: '1',
    keycloakGroupId: groupId,
    grafanaOrgId: null,
    status,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

function known(overrides: Partial<UserRecord>): UserRecord {
  return {
    id: 'u-old',
    keycloakUserId: 'kc-old',
    tenantId: null,
    tenantKey: null,
    username: 'root',
    email: 'root@example.com',
    role: 'platform-admin',
    enabled: true,
    grafanaUserId: null,
    status: 'active',
    ...overrides,
  };
}

function setup(opts: {
  tenants?: TenantRecord[];
  env?: Record<string, string>;
  admins?: string[];
  byUsername?: UserRecord | null;
} = {}) {
  const env: Record<string, string> = opts.env ?? {
    PLATFORM_ADMIN_USERNAME: 'root',
    PLATFORM_ADMIN_EMAIL: 'root@example.com',
    PLATFORM_ADMIN_PASSWORD: 'a-long-password',
  };

  const tx = { query: jest.fn() };
  const db = {
    transaction: jest.fn((fn: (q: unknown) => Promise<unknown>) => fn(tx)),
  };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const tenants = {
    findAll: jest.fn().mockResolvedValue(
      opts.tenants ?? [tenant('admin-tenant', null), tenant('alpha', 'g-alpha')],
    ),
    markActive: jest.fn().mockResolvedValue(undefined),
  };
  const users = {
    findPlatformAdminIds: jest.fn().mockResolvedValue(opts.admins ?? []),
    findByUsername: jest.fn().mockResolvedValue(opts.byUsername ?? null),
    adopt: jest.fn().mockResolvedValue('u-root'),
  };
  const keycloak = {
    ensureTenantGroup: jest.fn().mockResolvedValue('g-admin'),
  };
  const keycloakUsers = {
    ensurePlatformAdmin: jest.fn().mockResolvedValue({
      id: 'kc-root',
      username: 'root',
      email: 'root@example.com',
      enabled: true,
      created: true,
    }),
  };
  const config = {
    get: jest.fn((key: string, fallback?: string) => env[key] ?? fallback),
  };

  const service = new PlatformBootstrapService(
    db as unknown as DatabaseService,
    outbox as unknown as OutboxRepository,
    tenants as unknown as TenantRepository,
    users as unknown as UserRepository,
    keycloak as unknown as KeycloakAdminService,
    keycloakUsers as unknown as KeycloakUsersService,
    config as unknown as ConfigService,
  );

  return { service, tx, outbox, tenants, users, keycloak, keycloakUsers };
}

describe('PlatformBootstrapService', () => {
  it('creates the missing Keycloak group of a seeded tenant and mirrors it', async () => {
    const { service, tx, tenants, keycloak, outbox } = setup();

    await service.run();

    expect(keycloak.ensureTenantGroup).toHaveBeenCalledTimes(1);
    expect(keycloak.ensureTenantGroup).toHaveBeenCalledWith('admin-tenant', '1');
    expect(tenants.markActive).toHaveBeenCalledWith('id-admin-tenant', 'g-admin', tx);
    expect(outbox.enqueue).toHaveBeenCalledWith(tx, 'tenant', 'id-admin-tenant');
  });

  it('creates the initial platform admin in Keycloak and the DB, then syncs it', async () => {
    const { service, users, keycloakUsers, outbox } = setup();

    await service.run();

    expect(keycloakUsers.ensurePlatformAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'root', email: 'root@example.com' }),
    );
    expect(users.adopt).toHaveBeenCalledWith(
      expect.objectContaining({ keycloakUserId: 'kc-root' }),
      null,
      'platform-admin',
    );
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.anything(), 'user', 'u-root');
  });

  it('does nothing for the admin when one already exists', async () => {
    const { service, keycloakUsers } = setup({ admins: ['u-x'] });

    await service.run();

    expect(keycloakUsers.ensurePlatformAdmin).not.toHaveBeenCalled();
  });

  it('never resurrects an initial admin that was deleted', async () => {
    const { service, keycloakUsers } = setup({
      byUsername: known({ status: 'deleted' }),
    });

    await service.run();

    expect(keycloakUsers.ensurePlatformAdmin).not.toHaveBeenCalled();
  });

  it('never promotes a tenant user that has the same username', async () => {
    const { service, keycloakUsers } = setup({
      byUsername: known({ role: 'viewer', tenantId: 'alpha' }),
    });

    await service.run();

    expect(keycloakUsers.ensurePlatformAdmin).not.toHaveBeenCalled();
  });

  it('skips the admin when not configured or the password is too short', async () => {
    for (const env of <Record<string, string>[]>[
      {},
      {
        PLATFORM_ADMIN_USERNAME: 'root',
        PLATFORM_ADMIN_EMAIL: 'root@example.com',
        PLATFORM_ADMIN_PASSWORD: 'short',
      },
    ]) {
      const { service, keycloakUsers } = setup({ env });

      await service.run();

      expect(keycloakUsers.ensurePlatformAdmin).not.toHaveBeenCalled();
    }
  });

  it('a Keycloak outage surfaces as an error (the caller retries)', async () => {
    const { service, keycloak } = setup();
    keycloak.ensureTenantGroup.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(service.run()).rejects.toThrow(/ECONNREFUSED/);
  });
});
