import { Injectable, Logger } from '@nestjs/common';

import type { Queryable } from '../../common/db/database.service';
import { KeycloakClient } from '../../integrations/keycloak/keycloak.client';
import {
  AGENT_MARKER,
  type KcClient,
  type KcProtocolMapper,
} from '../../integrations/keycloak/keycloak.types';
import {
  type AgentRecord,
  AgentRepository,
} from '../../modules/agents/agent.repository';
import type { MirrorHandler } from '../../sync/mirror';

export interface AgentCredentials {
  clientId: string;
  clientUuid: string;
  clientSecret: string;
}

/** Claims every agent token carries (FROZEN contract, §18.3.5). */
const AGENT_MAPPERS: KcProtocolMapper[] = [
  {
    name: 'otel-gateway-audience',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-audience-mapper',
    consentRequired: false,
    config: {
      'included.client.audience': 'otel-gateway',
      'id.token.claim': 'false',
      'access.token.claim': 'true',
      'introspection.token.claim': 'true',
    },
  },
  ...['agent_id', 'tenant_id', 'vm_account_id'].map(
    (attribute): KcProtocolMapper => ({
      name: attribute.replaceAll('_', '-'),
      protocol: 'openid-connect',
      protocolMapper: 'oidc-usermodel-attribute-mapper',
      consentRequired: false,
      config: {
        'user.attribute': attribute,
        'claim.name': attribute,
        'jsonType.label': 'String',
        multivalued: 'false',
        'aggregate.attrs': 'false',
        'id.token.claim': 'false',
        'access.token.claim': 'true',
        'userinfo.token.claim': 'false',
        'introspection.token.claim': 'true',
      },
    }),
  ),
];

/**
 * Agent → confidential Keycloak client `otel-agent-<id>` (service account
 * only). active → enabled, disabled → disabled, revoked → deleted.
 * Credentials are issued inline (the secret is returned once to the host
 * and never stored). v0.9 replaces the per-client mappers with a shared
 * client scope (I-33).
 */
@Injectable()
export class KeycloakAgentMirror implements MirrorHandler {
  readonly target = 'keycloak' as const;
  readonly aggregate = 'agent' as const;

  private readonly logger = new Logger(KeycloakAgentMirror.name);

  constructor(
    private readonly keycloak: KeycloakClient,
    private readonly agents: AgentRepository,
  ) {}

  async sync(agentId: string): Promise<void> {
    const agent = await this.agents.findById(agentId);

    if (agent) {
      await this.apply(agent);
    }
  }

  async apply(agent: AgentRecord, q?: Queryable): Promise<void> {
    if (agent.status === 'revoked') {
      const client = await this.resolve(agent);

      if (client) {
        await this.keycloak.deleteClient(client.id);
        this.logger.log(`Agent ${agent.id}: Keycloak client deleted`);
      }

      if (agent.clientUuid !== null) {
        await this.agents.setClientUuid(agent.id, null, q);
      }

      return;
    }

    if (agent.status === 'provisioning') {
      // Credential issuance in progress (inline); nothing to converge.
      return;
    }

    const client = await this.resolve(agent);

    if (!client) {
      // Re-creating it would give a secret the host does not have: the
      // agent must be re-enrolled. Nothing to retry.
      this.logger.warn(
        `Agent ${agent.id} (${agent.status}) has no Keycloak client; re-enroll the host`,
      );
      return;
    }

    const enabled = agent.status === 'active';

    if (
      client.enabled !== enabled ||
      client.attributes?.[AGENT_MARKER] !== agent.id
    ) {
      await this.keycloak.updateClient({
        ...client,
        enabled,
        attributes: { ...(client.attributes ?? {}), [AGENT_MARKER]: agent.id },
      });
    }

    if (client.id !== agent.clientUuid) {
      await this.agents.setClientUuid(agent.id, client.id, q);
    }
  }

  /**
   * Creates (or completes) the client and returns its secret. Idempotent
   * for the same agent id. Runs inside the caller's transaction.
   */
  async issueCredentials(
    agent: AgentRecord,
    q?: Queryable,
  ): Promise<AgentCredentials> {
    const existing = await this.resolve(agent);

    const clientUuid =
      existing?.id ??
      (await this.keycloak.createClient({
        clientId: agent.clientId,
        enabled: true,
        protocol: 'openid-connect',
        publicClient: false,
        clientAuthenticatorType: 'client-secret',
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: true,
        attributes: { [AGENT_MARKER]: agent.id },
      }));

    const serviceAccount =
      await this.keycloak.getServiceAccountUser(clientUuid);

    await this.keycloak.updateUser({
      ...serviceAccount,
      attributes: {
        ...(serviceAccount.attributes ?? {}),
        agent_id: [agent.id],
        tenant_id: [agent.tenantKey],
        vm_account_id: [agent.vmAccountId],
      },
    });

    const present = new Set(
      (await this.keycloak.getProtocolMappers(clientUuid)).map(
        (mapper) => mapper.name,
      ),
    );

    for (const mapper of AGENT_MAPPERS) {
      if (!present.has(mapper.name)) {
        await this.keycloak.createProtocolMapper(clientUuid, mapper);
      }
    }

    const clientSecret = await this.keycloak.getClientSecret(clientUuid);

    await this.agents.setClientUuid(agent.id, clientUuid, q);

    return { clientId: agent.clientId, clientUuid, clientSecret };
  }

  private async resolve(agent: AgentRecord): Promise<KcClient | null> {
    if (agent.clientUuid) {
      const stored = await this.keycloak.getClient(agent.clientUuid);

      if (stored && stored.clientId === agent.clientId) {
        return stored;
      }
    }

    return this.keycloak.findClient(agent.clientId);
  }
}
