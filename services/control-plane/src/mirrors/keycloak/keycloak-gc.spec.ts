import type { KeycloakClient } from '../../integrations/keycloak/keycloak.client';
import type {
  KcClient,
  KcGroup,
  KcUser,
} from '../../integrations/keycloak/keycloak.types';
import type { AgentRepository } from '../../modules/agents/agent.repository';
import type { EnrollmentRepository } from '../../modules/enrollments/enrollment.repository';
import type { TenantRepository } from '../../modules/tenants/tenant.repository';
import type { UserRepository } from '../../modules/users/user.repository';

import { GC_CONFIRM_MS, KeycloakGarbageCollector } from './keycloak-gc';

const LIVE_AGENT = '11111111-1111-4111-8111-111111111111';
const OPEN_ENROLLMENT_AGENT = '22222222-2222-4222-8222-222222222222';
const DEAD_AGENT = '33333333-3333-4333-8333-333333333333';
const LIVE_USER = '44444444-4444-4444-8444-444444444444';
const DEAD_USER = '55555555-5555-4555-8555-555555555555';
const LIVE_TENANT = '66666666-6666-4666-8666-666666666666';
const DEAD_TENANT = '77777777-7777-4777-8777-777777777777';

function client(agentId: string, id = `uuid-${agentId.slice(0, 4)}`): KcClient {
  return { id, clientId: `otel-agent-${agentId}` };
}

function setup(
  opts: {
    clients?: KcClient[];
    users?: KcUser[];
    groups?: KcGroup[];
  } = {},
) {
  const keycloak = {
    listClients: jest
      .fn()
      .mockResolvedValue(
        opts.clients ?? [
          client(LIVE_AGENT),
          client(OPEN_ENROLLMENT_AGENT),
          client(DEAD_AGENT),
          { id: 'grafana-uuid', clientId: 'grafana' },
          { id: 'weird', clientId: 'otel-agent-not-a-uuid' },
        ],
      ),
    listUsers: jest.fn().mockResolvedValue(
      opts.users ?? [
        {
          id: 'kc-live',
          username: 'alice',
          attributes: { mtco_user_id: [LIVE_USER] },
        },
        {
          id: 'kc-dead',
          username: 'bob',
          attributes: { mtco_user_id: [DEAD_USER] },
        },
        { id: 'kc-foreign', username: 'manual', attributes: null },
      ],
    ),
    listGroups: jest.fn().mockResolvedValue(
      opts.groups ?? [
        {
          id: 'g-live',
          name: 'alpha-tenant',
          attributes: { mtco_tenant_id: [LIVE_TENANT] },
        },
        {
          id: 'g-dead',
          name: 'old-tenant',
          attributes: { mtco_tenant_id: [DEAD_TENANT] },
        },
        { id: 'g-foreign', name: 'admins', attributes: {} },
      ],
    ),
    deleteClient: jest.fn().mockResolvedValue(undefined),
    deleteUser: jest.fn().mockResolvedValue(undefined),
    deleteGroup: jest.fn().mockResolvedValue(undefined),
  };

  const gc = new KeycloakGarbageCollector(
    keycloak as unknown as KeycloakClient,
    {
      liveIds: jest.fn().mockResolvedValue([LIVE_AGENT]),
    } as unknown as AgentRepository,
    {
      openAgentIds: jest.fn().mockResolvedValue([OPEN_ENROLLMENT_AGENT]),
    } as unknown as EnrollmentRepository,
    {
      findActiveIds: jest.fn().mockResolvedValue([LIVE_USER]),
    } as unknown as UserRepository,
    {
      findActiveIds: jest.fn().mockResolvedValue([LIVE_TENANT]),
    } as unknown as TenantRepository,
  );

  return { gc, keycloak };
}

describe('KeycloakGarbageCollector', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('first sighting only records; a second run ≥ GC_CONFIRM_MS later deletes exactly our orphans', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-12T00:00:00Z') });
    const { gc, keycloak } = setup();

    await expect(gc.run()).resolves.toEqual({ deleted: 0, pending: 3 });
    expect(keycloak.deleteClient).not.toHaveBeenCalled();

    jest.setSystemTime(Date.now() + GC_CONFIRM_MS - 1);
    await expect(gc.run()).resolves.toEqual({ deleted: 0, pending: 3 });

    jest.setSystemTime(Date.now() + 1);
    await expect(gc.run()).resolves.toEqual({ deleted: 3, pending: 0 });

    // Live agent, open enrollment, other clients and non-UUID ids kept.
    expect(keycloak.deleteClient.mock.calls).toEqual([
      [`uuid-${DEAD_AGENT.slice(0, 4)}`],
    ]);
    expect(keycloak.deleteUser.mock.calls).toEqual([['kc-dead']]);
    expect(keycloak.deleteGroup.mock.calls).toEqual([['g-dead']]);
  });

  it('an object that stops being orphaned (inline create committed) is forgotten', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-12T00:00:00Z') });
    const { gc, keycloak } = setup();

    await gc.run();

    keycloak.listClients.mockResolvedValue([client(LIVE_AGENT)]);
    keycloak.listUsers.mockResolvedValue([]);
    keycloak.listGroups.mockResolvedValue([]);
    jest.setSystemTime(Date.now() + GC_CONFIRM_MS);
    await gc.run();

    keycloak.listClients.mockResolvedValue([client(DEAD_AGENT)]);
    jest.setSystemTime(Date.now() + GC_CONFIRM_MS);

    // Seen again, but as a NEW sighting: not deleted yet.
    await expect(gc.run()).resolves.toEqual({ deleted: 0, pending: 1 });
    expect(keycloak.deleteClient).not.toHaveBeenCalled();
  });

  it('refuses a kind when too much of it looks orphaned (bug / restored DB)', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-12T00:00:00Z') });
    const dead = Array.from({ length: 8 }, (_, i) =>
      client(`33333333-3333-4333-8333-33333333333${i}`, `dead-${i}`),
    );
    const { gc, keycloak } = setup({ clients: [...dead, client(LIVE_AGENT)] });

    await gc.run();
    jest.setSystemTime(Date.now() + GC_CONFIRM_MS);
    await gc.run();

    expect(keycloak.deleteClient).not.toHaveBeenCalled();
    expect(keycloak.deleteUser).toHaveBeenCalledWith('kc-dead');
  });

  it('pages through Keycloak listings', async () => {
    const { gc, keycloak } = setup();
    const page = Array.from({ length: 100 }, (_, i) => ({
      id: `u${i}`,
      username: `u${i}`,
    }));

    keycloak.listUsers.mockResolvedValueOnce(page).mockResolvedValueOnce([]);

    await gc.run();

    expect(keycloak.listUsers.mock.calls).toEqual([
      [0, 100],
      [100, 100],
    ]);
  });
});
