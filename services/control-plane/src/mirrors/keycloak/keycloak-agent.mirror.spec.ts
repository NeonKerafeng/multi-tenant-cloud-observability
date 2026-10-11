import { agent, IDS } from '../../common/testing/fixtures';
import type { KeycloakClient } from '../../integrations/keycloak/keycloak.client';
import type { KcClient } from '../../integrations/keycloak/keycloak.types';
import type { AgentRepository } from '../../modules/agents/agent.repository';

import { KeycloakAgentMirror } from './keycloak-agent.mirror';

function client(overrides: Partial<KcClient> = {}): KcClient {
  return {
    id: 'client-uuid',
    clientId: `otel-agent-${IDS.agent}`,
    enabled: true,
    attributes: { mtco_agent_id: IDS.agent },
    ...overrides,
  };
}

function setup(found: KcClient | null) {
  const keycloak = {
    getClient: jest.fn().mockResolvedValue(found),
    findClient: jest.fn().mockResolvedValue(found),
    createClient: jest.fn().mockResolvedValue('client-new'),
    updateClient: jest.fn().mockResolvedValue(undefined),
    deleteClient: jest.fn().mockResolvedValue(undefined),
    getServiceAccountUser: jest.fn().mockResolvedValue({
      id: 'sa',
      username: 'service-account-x',
      attributes: null,
    }),
    updateUser: jest.fn().mockResolvedValue(undefined),
    getProtocolMappers: jest.fn().mockResolvedValue([{ name: 'agent-id' }]),
    createProtocolMapper: jest.fn().mockResolvedValue(undefined),
    getClientSecret: jest.fn().mockResolvedValue('s3cret'),
  };

  const agents = { setClientUuid: jest.fn().mockResolvedValue(undefined) };

  const mirror = new KeycloakAgentMirror(
    keycloak as unknown as KeycloakClient,
    agents as unknown as AgentRepository,
  );

  return { mirror, keycloak, agents };
}

describe('KeycloakAgentMirror.apply', () => {
  it('disabled agent → client disabled', async () => {
    const { mirror, keycloak } = setup(client());

    await mirror.apply(agent({ status: 'disabled' }));

    expect(keycloak.updateClient).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('active and converged → no write', async () => {
    const { mirror, keycloak } = setup(client());

    await mirror.apply(agent());

    expect(keycloak.updateClient).not.toHaveBeenCalled();
  });

  it('revoked → client deleted, pointer cleared', async () => {
    const { mirror, keycloak, agents } = setup(client());

    await mirror.apply(agent({ status: 'revoked' }));

    expect(keycloak.deleteClient).toHaveBeenCalledWith('client-uuid');
    expect(agents.setClientUuid).toHaveBeenCalledWith(
      IDS.agent,
      null,
      undefined,
    );
  });

  it('missing client of an active agent: warn, no retry loop, no re-creation', async () => {
    const { mirror, keycloak } = setup(null);

    await expect(mirror.apply(agent())).resolves.toBeUndefined();
    expect(keycloak.createClient).not.toHaveBeenCalled();
  });
});

describe('KeycloakAgentMirror.issueCredentials', () => {
  it('creates the client, sets the FROZEN service-account attributes and mappers, returns the secret', async () => {
    const { mirror, keycloak, agents } = setup(null);

    const credentials = await mirror.issueCredentials(
      agent({ clientUuid: null, status: 'provisioning' }),
    );

    expect(keycloak.createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: `otel-agent-${IDS.agent}`,
        serviceAccountsEnabled: true,
        publicClient: false,
        standardFlowEnabled: false,
      }),
    );
    expect(keycloak.updateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sa',
        attributes: {
          agent_id: [IDS.agent],
          tenant_id: ['alpha-tenant'],
          vm_account_id: ['2'],
        },
      }),
    );
    expect(
      (
        keycloak.createProtocolMapper.mock.calls as [string, { name: string }][]
      ).map(([, mapper]) => mapper.name),
    ).toEqual(['otel-gateway-audience', 'tenant-id', 'vm-account-id']);
    expect(agents.setClientUuid).toHaveBeenCalledWith(
      IDS.agent,
      'client-new',
      undefined,
    );
    expect(credentials).toEqual({
      clientId: `otel-agent-${IDS.agent}`,
      clientUuid: 'client-new',
      clientSecret: 's3cret',
    });
  });

  it('is idempotent: reuses an existing client', async () => {
    const { mirror, keycloak } = setup(client());

    await mirror.issueCredentials(agent());

    expect(keycloak.createClient).not.toHaveBeenCalled();
  });
});
