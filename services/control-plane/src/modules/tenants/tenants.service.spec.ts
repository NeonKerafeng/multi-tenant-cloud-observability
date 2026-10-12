import type { DatabaseService } from '../../common/db/database.service';
import { ACTORS, fakeDb, IDS, tenant } from '../../common/testing/fixtures';
import { AppConfig } from '../../config/app-config';
import type { KeycloakTenantMirror } from '../../mirrors/keycloak/keycloak-tenant.mirror';
import type { OutboxRepository } from '../../sync/outbox.repository';
import type { AgentRepository } from '../agents/agent.repository';
import type { EnrollmentRepository } from '../enrollments/enrollment.repository';
import type { SupportAccessRepository } from '../support-access/support-access.repository';
import type { UserRepository } from '../users/user.repository';

import type { TenantRepository } from './tenant.repository';
import { TenantsService } from './tenants.service';

function setup(opts: { insertError?: unknown } = {}) {
  const { db, tx } = fakeDb();

  const created = tenant({
    id: 'new',
    tenantKey: 'gamma-tenant',
    keycloakGroupId: null,
  });

  const tenants = {
    listActive: jest.fn().mockResolvedValue([tenant()]),
    insertActive: jest.fn(() =>
      opts.insertError
        ? Promise.reject(opts.insertError as Error)
        : Promise.resolve(created),
    ),
    findById: jest
      .fn()
      .mockResolvedValue({ ...created, keycloakGroupId: 'g-new' }),
    markDeleted: jest.fn().mockResolvedValue(undefined),
  };

  const users = {
    markTenantUsersDeleted: jest.fn().mockResolvedValue(['u1', 'u2']),
  };
  const agents = { revokeTenantAgents: jest.fn().mockResolvedValue(['a1']) };
  const grants = {
    revokeOpenForTenant: jest.fn().mockResolvedValue(['u2', 'admin1']),
  };
  const enrollments = {
    revokeOpenForTenant: jest.fn().mockResolvedValue(1),
  };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const keycloakTenants = { apply: jest.fn().mockResolvedValue(undefined) };

  const service = new TenantsService(
    db as unknown as DatabaseService,
    tenants as unknown as TenantRepository,
    users as unknown as UserRepository,
    agents as unknown as AgentRepository,
    grants as unknown as SupportAccessRepository,
    enrollments as unknown as EnrollmentRepository,
    outbox as unknown as OutboxRepository,
    keycloakTenants as unknown as KeycloakTenantMirror,
    AppConfig.forTest(),
  );

  return {
    service,
    tenants,
    users,
    agents,
    grants,
    enrollments,
    outbox,
    keycloakTenants,
    tx,
    created,
  };
}

describe('TenantsService.create', () => {
  it('row + inline Keycloak group + outbox in one transaction', async () => {
    const { service, tenants, keycloakTenants, outbox, tx, created } = setup();

    const view = await service.create(ACTORS.platformAdmin, 'gamma-tenant');

    expect(tenants.insertActive).toHaveBeenCalledWith(tx, 'gamma-tenant');
    expect(keycloakTenants.apply).toHaveBeenCalledWith(created, tx);
    expect(outbox.enqueue).toHaveBeenCalledWith(tx, 'tenant', 'new');
    expect(view).toEqual({
      tenantKey: 'gamma-tenant',
      vmAccountId: '2',
      grafanaOrgId: 7,
      status: 'active',
      createdAt: created.createdAt,
    });
  });

  it('a key used before → 409 tenant_key_reserved (never reused)', async () => {
    const { service, keycloakTenants } = setup({
      insertError: Object.assign(new Error('dup'), { code: '23505' }),
    });

    await expect(
      service.create(ACTORS.platformAdmin, 'beta-tenant'),
    ).rejects.toMatchObject({
      code: 'tenant_key_reserved',
    });
    expect(keycloakTenants.apply).not.toHaveBeenCalled();
  });
});

describe('TenantsService.delete', () => {
  it('cascades users, agents (Q1), grants and unused enrollments in one transaction and enqueues each once', async () => {
    const { service, tenants, users, agents, grants, enrollments, outbox, tx } =
      setup();

    await service.delete(ACTORS.platformAdmin, tenant());

    expect(tenants.markDeleted).toHaveBeenCalledWith(tx, IDS.alpha);
    expect(users.markTenantUsersDeleted).toHaveBeenCalledWith(tx, IDS.alpha);
    expect(agents.revokeTenantAgents).toHaveBeenCalledWith(tx, IDS.alpha);
    expect(grants.revokeOpenForTenant).toHaveBeenCalledWith(
      tx,
      IDS.alpha,
      'root-admin',
    );
    expect(enrollments.revokeOpenForTenant).toHaveBeenCalledWith(
      tx,
      IDS.alpha,
      IDS.platformAdmin,
    );
    expect(
      outbox.enqueue.mock.calls.map(
        (c: unknown[]) => `${String(c[1])}:${String(c[2])}`,
      ),
    ).toEqual([
      `tenant:${IDS.alpha}`,
      'user:u1',
      'user:u2',
      'user:admin1',
      'agent:a1',
    ]);
  });

  it('the platform tenant cannot be deleted', async () => {
    const { service, tenants } = setup();

    await expect(
      service.delete(
        ACTORS.platformAdmin,
        tenant({ tenantKey: 'admin-tenant' }),
      ),
    ).rejects.toMatchObject({ code: 'tenant_is_platform' });
    expect(tenants.markDeleted).not.toHaveBeenCalled();
  });
});
