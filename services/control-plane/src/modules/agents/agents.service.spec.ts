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
    setStatus: jest.fn().mockResolvedValue(undefined),
    markRevoked: jest.fn().mockResolvedValue(undefined),
  };

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
    outbox as unknown as OutboxRepository,
    keycloakAgents as unknown as KeycloakAgentMirror,
  );

  return { service, agents, outbox, keycloakAgents, tx, db };
}

describe('AgentsService', () => {
  it("issue (in the exchange's transaction): row with the enrollment's agent id + credentials + active + outbox, secret returned once", async () => {
    const { service, agents, keycloakAgents, outbox, tx, db } = setup();

    const issued = await service.issue(tx, tenant(), {
      agentId: IDS.agent,
      enrollmentId: 'enrollment-1',
    });

    expect(agents.insert).toHaveBeenCalledWith(tx, {
      id: IDS.agent,
      tenantId: IDS.alpha,
      status: 'provisioning',
      enrollmentId: 'enrollment-1',
    });
    expect(db.transaction).not.toHaveBeenCalled();
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

  it('a PATCH without a change writes nothing', async () => {
    const { service, agents, outbox } = setup();

    await service.update(ACTORS.alphaAdmin, tenant(), IDS.agent, {
      enabled: true,
    });
    await service.update(ACTORS.alphaAdmin, tenant(), IDS.agent, {});

    expect(agents.setStatus).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
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

  it('a malformed id is a plain 404 (no DB lookup)', async () => {
    const { service, agents } = setup();

    await expect(
      service.get(ACTORS.alphaAdmin, tenant(), 'not-a-uuid'),
    ).rejects.toMatchObject({ code: 'agent_not_found' });
    expect(agents.findLiveById).not.toHaveBeenCalled();
  });

  it('lists the live agents of the tenant', async () => {
    const { service, agents } = setup();

    await expect(
      service.list(ACTORS.alphaAdmin, tenant()),
    ).resolves.toHaveLength(1);
    expect(agents.listLiveByTenant).toHaveBeenCalledWith(IDS.alpha);
  });
});
