import { ACTORS, tenant } from '../../common/testing/fixtures';
import { AppConfig } from '../../config/app-config';
import type { AgentsService } from '../agents/agents.service';
import type {
  TenantRecord,
  TenantRepository,
} from '../tenants/tenant.repository';

import { EnrollmentsService } from './enrollments.service';

function setup(current: TenantRecord | null = tenant()) {
  const agents = {
    issue: jest.fn().mockResolvedValue({
      agent: {
        id: 'agent-1',
        clientId: 'otel-agent-agent-1',
        tenantKey: 'alpha-tenant',
      },
      clientSecret: 's3cret',
    }),
  };

  const tenants = { findById: jest.fn().mockResolvedValue(current) };

  const service = new EnrollmentsService(
    agents as unknown as AgentsService,
    tenants as unknown as TenantRepository,
    AppConfig.forTest(),
  );

  return { service, agents };
}

describe('EnrollmentsService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('exchange returns the FROZEN fields used by client/bootstrap.sh', async () => {
    const { service } = setup();

    const { enrollmentToken } = service.create(ACTORS.alphaAdmin, tenant());

    await expect(service.exchange(enrollmentToken)).resolves.toEqual({
      agentId: 'agent-1',
      clientId: 'otel-agent-agent-1',
      tenantKey: 'alpha-tenant',
      clientSecret: 's3cret',
      tokenUrl:
        'http://kc.example:8080/realms/observability/protocol/openid-connect/token',
      gatewayEndpoint: 'http://otel.example:4318',
    });
  });

  it('a token works once', async () => {
    const { service } = setup();
    const { enrollmentToken } = service.create(ACTORS.alphaAdmin, tenant());

    await service.exchange(enrollmentToken);

    await expect(service.exchange(enrollmentToken)).rejects.toMatchObject({
      code: 'enrollment_invalid',
      status: 403,
    });
  });

  it('expires after ENROLLMENT_TTL_MINUTES', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-10T00:00:00Z') });

    const { service, agents } = setup();
    const { enrollmentToken, expiresAt } = service.create(
      ACTORS.alphaAdmin,
      tenant(),
    );

    expect(expiresAt).toBe('2026-10-10T00:10:00.000Z');

    jest.setSystemTime(new Date('2026-10-10T00:10:01Z'));

    await expect(service.exchange(enrollmentToken)).rejects.toMatchObject({
      code: 'enrollment_expired',
      status: 410,
    });
    expect(agents.issue).not.toHaveBeenCalled();
  });

  it('a tenant deleted in between → 400 tenant_not_active', async () => {
    const { service, agents } = setup(tenant({ status: 'deleted' }));
    const { enrollmentToken } = service.create(ACTORS.alphaAdmin, tenant());

    await expect(service.exchange(enrollmentToken)).rejects.toMatchObject({
      code: 'tenant_not_active',
    });
    expect(agents.issue).not.toHaveBeenCalled();
  });
});
