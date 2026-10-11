import type { DatabaseService } from '../../common/db/database.service';
import {
  ACTORS,
  agent,
  fakeDb,
  IDS,
  tenant,
} from '../../common/testing/fixtures';
import type { KeycloakAgentMirror } from '../../mirrors/keycloak/keycloak-agent.mirror';
import type { OutboxRepository } from '../../sync/outbox.repository';
import type { TenantRepository } from '../tenants/tenant.repository';

import type { AgentRecord, AgentRepository } from './agent.repository';
import { AgentsService } from './agents.service';

function setup(found: AgentRecord | null = agent()) {
  const { db, tx } = fakeDb();

  const agents = {
    insert: jest.fn((_q: unknown, a: { id: string }) =>
      Promise.resolve(
        agent({ id: a.id, status: 'provisioning', clientUuid: null }),
      ),
    ),
    findById: jest.fn((id: string) => Promise.resolve(agent({ id }))),
    findLiveById: jest.fn().mockResolvedValue(found),
    listLiveByTenant: jest.fn().mockResolvedValue([agent()]),
    listLive: jest.fn().mockResolvedValue([agent()]),
    setStatus: jest.fn().mockResolvedValue(undefined),
    markRevoked: jest.fn().mockResolvedValue(undefined),
  };

  const tenants = { findById: jest.fn().mockResolvedValue(tenant()) };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const keycloakAgents = {
    issueCredentials: jest.fn().mockResolvedValue({
      clientId: 'otel-agent-x',
      clientUuid: 'cu',
      clientSecret: 's3cret',
    }),
  };

  const service = new AgentsService(
    db as unknown as DatabaseService,
    agents as unknown as AgentRepository,
    tenants as unknown as TenantRepository,
    outbox as unknown as OutboxRepository,
    keycloakAgents as unknown as KeycloakAgentMirror,
  );

  return { service, agents, outbox, keycloakAgents, tx };
}

describe('AgentsService', () => {
  it('issue: row (provisioning) + credentials inline + active + outbox, secret returned once', async () => {
    const { service, agents, keycloakAgents, outbox, tx } = setup();

    const issued = await service.issue(tenant());

    expect(agents.insert).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ tenantId: IDS.alpha, status: 'provisioning' }),
    );
    expect(keycloakAgents.issueCredentials).toHaveBeenCalled();
    expect(agents.setStatus).toHaveBeenCalledWith(
      tx,
      expect.any(String),
      'active',
    );
    expect(outbox.enqueue).toHaveBeenCalledWith(
      tx,
      'agent',
      expect.any(String),
    );
    expect(issued.clientSecret).toBe('s3cret');
    expect(issued.agent).not.toHaveProperty('clientSecret');
  });

  it('disable = status + outbox; the mirror disables the Keycloak client', async () => {
    const { service, agents, outbox, tx } = setup();

    await service.update(ACTORS.alphaAdmin, tenant(), IDS.agent, {
      enabled: false,
    });

    expect(agents.setStatus).toHaveBeenCalledWith(tx, IDS.agent, 'disabled');
    expect(outbox.enqueue).toHaveBeenCalledWith(tx, 'agent', IDS.agent);
  });

  it('delete = revoke + outbox', async () => {
    const { service, agents, outbox, tx } = setup();

    await service.delete(ACTORS.alphaAdmin, tenant(), IDS.agent);

    expect(agents.markRevoked).toHaveBeenCalledWith(tx, IDS.agent);
    expect(outbox.enqueue).toHaveBeenCalledWith(tx, 'agent', IDS.agent);
  });

  it('an agent of another tenant is not found through this tenant', async () => {
    const { service } = setup(agent({ tenantId: IDS.beta }));

    await expect(
      service.get(ACTORS.alphaAdmin, tenant(), IDS.agent),
    ).rejects.toMatchObject({
      code: 'agent_not_found',
    });
  });

  it('legacy tenantOfAgent: tenant admin of another tenant → forbidden', async () => {
    const { service } = setup();

    await expect(
      service.tenantOfAgent(ACTORS.betaAdmin, IDS.agent),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      service.tenantOfAgent(ACTORS.platformAdmin, IDS.agent),
    ).resolves.toMatchObject({
      id: IDS.alpha,
    });
  });

  it('listAll is for platform admins only', async () => {
    const { service } = setup();

    await expect(service.listAll(ACTORS.alphaAdmin)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(service.listAll(ACTORS.platformAdmin)).resolves.toHaveLength(
      1,
    );
  });
});
