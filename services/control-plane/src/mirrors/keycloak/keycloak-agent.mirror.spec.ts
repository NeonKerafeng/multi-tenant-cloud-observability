import { agent, IDS } from '../../common/testing/fixtures';
import type { KeycloakClient } from '../../integrations/keycloak/keycloak.client';
import type {
  KcClient,
  KcProtocolMapper,
} from '../../integrations/keycloak/keycloak.types';
import type { AgentRepository } from '../../modules/agents/agent.repository';

import {
  KeycloakAgentMirror,
  LEGACY_AGENT_MAPPERS,
} from './keycloak-agent.mirror';

const SCOPE = { id: 'scope-1', name: 'mtco-agent' };
const BASIC = { id: 'scope-basic', name: 'basic' };

const CONVERGED_ATTRIBUTES = {
  agent_id: [IDS.agent],
  tenant_id: ['alpha-tenant'],
  vm_account_id: ['2'],
};

function client(overrides: Partial<KcClient> = {}): KcClient {
  return {
    id: 'client-uuid',
    clientId: `otel-agent-${IDS.agent}`,
    enabled: true,
    attributes: { mtco_agent_id: IDS.agent },
    ...overrides,
  };
}

function legacyMappers(): KcProtocolMapper[] {
  return LEGACY_AGENT_MAPPERS.map((name, i) => ({
    id: `m${i}`,
    name,
    protocol: 'openid-connect',
    protocolMapper: 'x',
    config: {},
  }));
}

function setup(
  found: KcClient | null,
  opts: {
    scopes?: { id: string; name: string }[];
    mappers?: KcProtocolMapper[];
    attributes?: Record<string, string[]> | null;
    realmScope?: { id: string; name: string } | null;
  } = {},
) {
  const keycloak = {
    getClient: jest.fn().mockResolvedValue(found),
    findClient: jest.fn().mockResolvedValue(found),
    createClient: jest.fn().mockResolvedValue('client-new'),
    updateClient: jest.fn().mockResolvedValue(undefined),
    deleteClient: jest.fn().mockResolvedValue(undefined),
    getServiceAccountUser: jest.fn().mockResolvedValue({
      id: 'sa',
      username: 'service-account-x',
      attributes:
        opts.attributes === undefined ? CONVERGED_ATTRIBUTES : opts.attributes,
    }),
    updateUser: jest.fn().mockResolvedValue(undefined),
    getClientDefaultScopes: jest
      .fn()
      .mockResolvedValue(opts.scopes ?? [BASIC, SCOPE]),
    findClientScope: jest
      .fn()
      .mockResolvedValue(
        opts.realmScope === undefined ? SCOPE : opts.realmScope,
      ),
    addClientDefaultScope: jest.fn().mockResolvedValue(undefined),
    getProtocolMappers: jest.fn().mockResolvedValue(opts.mappers ?? []),
    deleteProtocolMapper: jest.fn().mockResolvedValue(undefined),
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

  it('active and converged → no write at all', async () => {
    const { mirror, keycloak } = setup(client());

    await mirror.apply(agent());

    expect(keycloak.updateClient).not.toHaveBeenCalled();
    expect(keycloak.updateUser).not.toHaveBeenCalled();
    expect(keycloak.addClientDefaultScope).not.toHaveBeenCalled();
    expect(keycloak.deleteProtocolMapper).not.toHaveBeenCalled();
  });

  it('legacy client (v0.6–v0.8): scope added FIRST, then the 4 per-client mappers deleted', async () => {
    const { mirror, keycloak } = setup(client(), {
      scopes: [BASIC],
      mappers: [
        ...legacyMappers(),
        {
          id: 'other',
          name: 'something-else',
          protocol: 'p',
          protocolMapper: 'x',
          config: {},
        },
      ],
    });

    await mirror.apply(agent());

    expect(keycloak.addClientDefaultScope).toHaveBeenCalledWith(
      'client-uuid',
      'scope-1',
    );
    expect(
      keycloak.deleteProtocolMapper.mock.calls.map((c: unknown[]) => c[1]),
    ).toEqual(['m0', 'm1', 'm2', 'm3']);

    const scopeOrder =
      keycloak.addClientDefaultScope.mock.invocationCallOrder[0];
    const firstDelete =
      keycloak.deleteProtocolMapper.mock.invocationCallOrder[0];

    expect(scopeOrder).toBeLessThan(firstDelete);
  });

  it('missing realm scope → upstream error (outbox retries), mappers untouched', async () => {
    const { mirror, keycloak } = setup(client(), {
      scopes: [BASIC],
      mappers: legacyMappers(),
      realmScope: null,
    });

    await expect(mirror.apply(agent())).rejects.toMatchObject({
      code: 'upstream_bad_response',
    });
    expect(keycloak.deleteProtocolMapper).not.toHaveBeenCalled();
  });

  it('looks the scope id up once, again after an error', async () => {
    const { mirror, keycloak } = setup(client(), { scopes: [BASIC] });

    await mirror.apply(agent());
    await mirror.apply(agent());
    expect(keycloak.findClientScope).toHaveBeenCalledTimes(1);

    keycloak.addClientDefaultScope.mockRejectedValueOnce(new Error('404'));
    await expect(mirror.apply(agent())).rejects.toThrow('404');
    await mirror.apply(agent());
    expect(keycloak.findClientScope).toHaveBeenCalledTimes(2);
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
  it('creates the client, sets the FROZEN service-account attributes, adds the scope, returns the secret', async () => {
    const { mirror, keycloak, agents } = setup(null, {
      scopes: [BASIC],
      attributes: null,
    });

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
    expect(
      (keycloak.createClient.mock.calls as unknown[][])[0][0],
    ).not.toHaveProperty('defaultClientScopes');
    expect(keycloak.updateUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sa', attributes: CONVERGED_ATTRIBUTES }),
    );
    expect(keycloak.addClientDefaultScope).toHaveBeenCalledWith(
      'client-new',
      'scope-1',
    );
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

  it('is idempotent: a retried exchange reuses the existing client of the same agent id', async () => {
    const { mirror, keycloak } = setup(client());

    await mirror.issueCredentials(agent());

    expect(keycloak.createClient).not.toHaveBeenCalled();
    expect(keycloak.addClientDefaultScope).not.toHaveBeenCalled();
  });
});
