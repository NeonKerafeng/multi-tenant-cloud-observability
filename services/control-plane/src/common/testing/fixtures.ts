/**
 * Shared test fixtures (records and actors). Only used by *.spec.ts.
 */
import type { AgentRecord } from '../../modules/agents/agent.repository';
import type { TenantRecord } from '../../modules/tenants/tenant.repository';
import type { UserRecord } from '../../modules/users/user.repository';
import type { Actor } from '../auth/actor';

export const IDS = {
  adminTenant: '00000000-0000-4000-8000-000000000001',
  alpha: '00000000-0000-4000-8000-0000000000a1',
  beta: '00000000-0000-4000-8000-0000000000b1',
  platformAdmin: '00000000-0000-4000-8000-0000000000f1',
  alphaAdmin: '00000000-0000-4000-8000-0000000000a2',
  alphaViewer: '00000000-0000-4000-8000-0000000000a3',
  betaAdmin: '00000000-0000-4000-8000-0000000000b2',
  agent: '00000000-0000-4000-8000-0000000000c1',
};

export function tenant(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id: IDS.alpha,
    tenantKey: 'alpha-tenant',
    vmAccountId: '2',
    keycloakGroupId: 'g-alpha',
    grafanaOrgId: 7,
    status: 'active',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

export function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: IDS.alphaViewer,
    keycloakUserId: 'kc-viewer',
    tenantId: IDS.alpha,
    tenantKey: 'alpha-tenant',
    username: 'alice',
    email: 'alice@example.com',
    firstName: 'Alice',
    lastName: 'A',
    role: 'viewer',
    enabled: true,
    grafanaUserId: null,
    status: 'active',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

export function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: IDS.agent,
    tenantId: IDS.alpha,
    tenantKey: 'alpha-tenant',
    vmAccountId: '2',
    clientId: `otel-agent-${IDS.agent}`,
    clientUuid: 'client-uuid',
    status: 'active',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    revokedAt: null,
    ...overrides,
  };
}

export const ACTORS: Record<
  'platformAdmin' | 'alphaAdmin' | 'alphaViewer' | 'betaAdmin',
  Actor
> = {
  platformAdmin: {
    userId: IDS.platformAdmin,
    keycloakUserId: 'kc-root',
    username: 'root-admin',
    email: 'root@example.com',
    role: 'platform-admin',
    tenantId: null,
    tenantKey: null,
  },
  alphaAdmin: {
    userId: IDS.alphaAdmin,
    keycloakUserId: 'kc-alpha-admin',
    username: 'alpha-admin',
    email: 'alpha-admin@example.com',
    role: 'tenant-admin',
    tenantId: IDS.alpha,
    tenantKey: 'alpha-tenant',
  },
  alphaViewer: {
    userId: IDS.alphaViewer,
    keycloakUserId: 'kc-viewer',
    username: 'alice',
    email: 'alice@example.com',
    role: 'viewer',
    tenantId: IDS.alpha,
    tenantKey: 'alpha-tenant',
  },
  betaAdmin: {
    userId: IDS.betaAdmin,
    keycloakUserId: 'kc-beta-admin',
    username: 'beta-admin',
    email: 'beta-admin@example.com',
    role: 'tenant-admin',
    tenantId: IDS.beta,
    tenantKey: 'beta-tenant',
  },
};

/** A Queryable whose transaction just runs the callback. */
export function fakeDb() {
  const tx = { query: jest.fn() };

  return {
    tx,
    db: {
      query: jest.fn(),
      transaction: jest.fn((fn: (q: unknown) => Promise<unknown>) => fn(tx)),
    },
  };
}
