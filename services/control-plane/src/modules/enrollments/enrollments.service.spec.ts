import { createHash } from 'node:crypto';

import type { DatabaseService } from '../../common/db/database.service';
import { ACTORS, fakeDb, IDS, tenant } from '../../common/testing/fixtures';
import { AppConfig } from '../../config/app-config';
import type { AgentsService } from '../agents/agents.service';
import type {
  TenantRecord,
  TenantRepository,
} from '../tenants/tenant.repository';

import type {
  EnrollmentRecord,
  EnrollmentRepository,
} from './enrollment.repository';
import { EnrollmentsService } from './enrollments.service';

const ENROLLMENT_ID = '22222222-2222-4222-8222-222222222222';
const AGENT_ID = '33333333-3333-4333-8333-333333333333';

function enrollment(
  overrides: Partial<EnrollmentRecord> = {},
): EnrollmentRecord {
  return {
    id: ENROLLMENT_ID,
    tenantId: IDS.alpha,
    tenantKey: 'alpha-tenant',
    agentId: AGENT_ID,
    createdBy: IDS.alphaAdmin,
    createdByUsername: 'alpha-admin',
    createdAt: new Date('2026-10-12T00:00:00Z'),
    expiresAt: new Date('2026-10-12T00:10:00Z'),
    usedAt: null,
    revokedAt: null,
    revokedByUsername: null,
    expired: false,
    ...overrides,
  };
}

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function setup(
  opts: {
    locked?: EnrollmentRecord | null;
    found?: EnrollmentRecord | null;
    tenant?: TenantRecord | null;
    revoked?: boolean;
  } = {},
) {
  const { db, tx } = fakeDb();

  const enrollments = {
    create: jest.fn((_q: unknown, input: { agentId: string }) =>
      Promise.resolve(enrollment({ agentId: input.agentId })),
    ),
    findById: jest
      .fn()
      .mockResolvedValue(opts.found === undefined ? enrollment() : opts.found),
    listByTenant: jest
      .fn()
      .mockResolvedValue([enrollment(), enrollment({ usedAt: new Date() })]),
    lockByTokenHash: jest
      .fn()
      .mockResolvedValue(
        opts.locked === undefined ? enrollment() : opts.locked,
      ),
    markUsed: jest.fn().mockResolvedValue(undefined),
    revoke: jest.fn().mockResolvedValue(opts.revoked ?? true),
  };

  const tenants = {
    findById: jest
      .fn()
      .mockResolvedValue(opts.tenant === undefined ? tenant() : opts.tenant),
  };

  const agents = {
    issue: jest.fn((_tx: unknown, _t: unknown, ref: { agentId: string }) =>
      Promise.resolve({
        agent: {
          id: ref.agentId,
          clientId: `otel-agent-${ref.agentId}`,
          tenantKey: 'alpha-tenant',
        },
        clientSecret: 's3cret',
      }),
    ),
  };

  const service = new EnrollmentsService(
    db as unknown as DatabaseService,
    enrollments as unknown as EnrollmentRepository,
    tenants as unknown as TenantRepository,
    agents as unknown as AgentsService,
    AppConfig.forTest(),
  );

  return { service, enrollments, agents, tenants, tx, db };
}

describe('EnrollmentsService.create', () => {
  it('stores only the sha256 of the token, a pre-assigned agent id, the creator and the TTL', async () => {
    const { service, enrollments, tx, db } = setup();

    const created = await service.create(ACTORS.alphaAdmin, tenant());

    const input = enrollments.create.mock.calls[0][1] as unknown as Record<
      string,
      unknown
    >;

    expect(enrollments.create.mock.calls[0][0]).toBe(db);
    expect(input).toMatchObject({
      tenantId: IDS.alpha,
      tokenHash: sha256(created.enrollmentToken),
      createdBy: IDS.alphaAdmin,
      ttlMinutes: 10,
    });
    expect(input.agentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(input).not.toHaveProperty('token');
    expect(created.enrollmentToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created).toMatchObject({
      id: ENROLLMENT_ID,
      state: 'pending',
      agentId: null,
    });
    expect(tx.query).not.toHaveBeenCalled();
  });
});

describe('EnrollmentsService.exchange', () => {
  it('valid token: one transaction → agent with the pre-assigned id, enrollment used, FROZEN fields', async () => {
    const { service, enrollments, agents, tx } = setup();

    const result = await service.exchange('tok', '10.0.0.9');

    expect(enrollments.lockByTokenHash).toHaveBeenCalledWith(tx, sha256('tok'));
    expect(agents.issue).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ id: IDS.alpha }),
      {
        agentId: AGENT_ID,
        enrollmentId: ENROLLMENT_ID,
      },
    );
    expect(enrollments.markUsed).toHaveBeenCalledWith(tx, ENROLLMENT_ID);
    expect(result).toEqual({
      agentId: AGENT_ID,
      clientId: `otel-agent-${AGENT_ID}`,
      tenantKey: 'alpha-tenant',
      clientSecret: 's3cret',
      tokenUrl:
        'http://kc.example:8080/realms/observability/protocol/openid-connect/token',
      gatewayEndpoint: 'http://otel.example:4318',
    });
  });

  it.each([
    ['unknown token', { locked: null }, 'enrollment_invalid', 403],
    [
      'used token',
      { locked: enrollment({ usedAt: new Date() }) },
      'enrollment_used',
      410,
    ],
    [
      'revoked token',
      {
        locked: enrollment({
          revokedAt: new Date(),
          revokedByUsername: 'alpha-admin',
        }),
      },
      'enrollment_revoked',
      410,
    ],
    [
      'expired token',
      { locked: enrollment({ expired: true }) },
      'enrollment_expired',
      410,
    ],
    [
      'deleted tenant',
      { tenant: tenant({ status: 'deleted' }) },
      'tenant_not_active',
      400,
    ],
  ])('%s → %s (%d), nothing issued', async (_label, opts, code, status) => {
    const { service, agents, enrollments } = setup(opts);

    await expect(service.exchange('tok', '10.0.0.9')).rejects.toMatchObject({
      code,
      status,
    });
    expect(agents.issue).not.toHaveBeenCalled();
    expect(enrollments.markUsed).not.toHaveBeenCalled();
  });

  it('a failure mid-way (Keycloak down) rolls back; a retry with the SAME token reuses the SAME agent id', async () => {
    const { service, agents, enrollments } = setup();

    agents.issue.mockRejectedValueOnce(new Error('keycloak down'));

    await expect(service.exchange('tok', '10.0.0.9')).rejects.toThrow(
      'keycloak down',
    );
    expect(enrollments.markUsed).not.toHaveBeenCalled();

    await expect(service.exchange('tok', '10.0.0.9')).resolves.toMatchObject({
      agentId: AGENT_ID,
    });

    expect(agents.issue.mock.calls.map((call) => call[2].agentId)).toEqual([
      AGENT_ID,
      AGENT_ID,
    ]);
  });
});

describe('EnrollmentsService.revoke / list', () => {
  it('revokes an unused enrollment of the tenant', async () => {
    const { service, enrollments, db } = setup();

    await service.revoke(ACTORS.alphaAdmin, tenant(), ENROLLMENT_ID);

    expect(enrollments.revoke).toHaveBeenCalledWith(
      db,
      ENROLLMENT_ID,
      IDS.alphaAdmin,
    );
  });

  it('a used enrollment → 409 enrollment_used', async () => {
    const { service, enrollments } = setup({
      found: enrollment({ usedAt: new Date() }),
    });

    await expect(
      service.revoke(ACTORS.alphaAdmin, tenant(), ENROLLMENT_ID),
    ).rejects.toMatchObject({
      code: 'enrollment_used',
      status: 409,
    });
    expect(enrollments.revoke).not.toHaveBeenCalled();
  });

  it('another tenant or a malformed id → 404 enrollment_not_found', async () => {
    const other = setup({ found: enrollment({ tenantId: IDS.beta }) });

    await expect(
      other.service.revoke(ACTORS.alphaAdmin, tenant(), ENROLLMENT_ID),
    ).rejects.toMatchObject({
      code: 'enrollment_not_found',
    });

    const malformed = setup();

    await expect(
      malformed.service.revoke(ACTORS.alphaAdmin, tenant(), 'x'),
    ).rejects.toMatchObject({
      code: 'enrollment_not_found',
    });
    expect(malformed.enrollments.findById).not.toHaveBeenCalled();
  });

  it('lists with states; the agent id shows only once used', async () => {
    const { service } = setup();

    const items = await service.list(ACTORS.alphaAdmin, tenant());

    expect(items.map((item) => [item.state, item.agentId])).toEqual([
      ['pending', null],
      ['used', AGENT_ID],
    ]);
  });
});
