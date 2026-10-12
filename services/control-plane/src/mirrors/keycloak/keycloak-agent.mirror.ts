import { Injectable, Logger } from '@nestjs/common';

import type { Queryable } from '../../common/db/database.service';
import { UpstreamBadResponseError } from '../../common/errors/upstream-error';
import { KeycloakClient } from '../../integrations/keycloak/keycloak.client';
import {
  AGENT_MARKER,
  type KcClient,
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

/**
 * Realm client scope created by the keycloak-bootstrap Job. Its 4 mappers
 * (audience otel-gateway + agent_id, tenant_id, vm_account_id from the
 * service-account user attributes) give every agent token the FROZEN
 * claims (§18.3.5). It is ADDED to the client's default scopes, so the
 * realm defaults (basic → sub, …) stay exactly as before.
 */
export const AGENT_CLIENT_SCOPE = 'mtco-agent';

/**
 * v0.6–v0.8 created these 4 mappers on every agent client (I-33). The
 * mirror removes them once the client has the scope (claims unchanged).
 */
export const LEGACY_AGENT_MAPPERS = [
  'otel-gateway-audience',
  'agent-id',
  'tenant-id',
  'vm-account-id',
];

/**
 * Agent → confidential Keycloak client `otel-agent-<id>` (service account
 * only). active → enabled, disabled → disabled, revoked → deleted.
 * Credentials are issued inline by the enrollment exchange (the secret is
 * returned once to the host and never stored).
 */
@Injectable()
export class KeycloakAgentMirror implements MirrorHandler {
  readonly target = 'keycloak' as const;
  readonly aggregate = 'agent' as const;

  private readonly logger = new Logger(KeycloakAgentMirror.name);

  /** Id of the mtco-agent scope (stable; dropped on any scope error). */
  private scopeId: string | null = null;

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

    await this.ensureClaims(agent, client.id);

    if (client.id !== agent.clientUuid) {
      await this.agents.setClientUuid(agent.id, client.id, q);
    }
  }

  /**
   * Creates (or completes) the client and returns its secret. Idempotent
   * for the same agent id: a retried exchange (same enrollment → same
   * agent id) lands on the same client. Runs inside the caller's
   * transaction.
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

    await this.ensureClaims(agent, clientUuid);

    const clientSecret = await this.keycloak.getClientSecret(clientUuid);

    await this.agents.setClientUuid(agent.id, clientUuid, q);

    return { clientId: agent.clientId, clientUuid, clientSecret };
  }

  /**
   * The claims of the agent's tokens: service-account attributes (read by
   * the scope's mappers) + the mtco-agent scope; then the legacy
   * per-client mappers go (scope FIRST, so no token is ever minted
   * without the claims).
   */
  private async ensureClaims(
    agent: AgentRecord,
    clientUuid: string,
  ): Promise<void> {
    const serviceAccount =
      await this.keycloak.getServiceAccountUser(clientUuid);

    const wanted = {
      agent_id: [agent.id],
      tenant_id: [agent.tenantKey],
      vm_account_id: [agent.vmAccountId],
    };

    const current = serviceAccount.attributes ?? {};

    if (
      Object.entries(wanted).some(
        ([key, [value]]) =>
          current[key]?.length !== 1 || current[key]?.[0] !== value,
      )
    ) {
      await this.keycloak.updateUser({
        ...serviceAccount,
        attributes: { ...current, ...wanted },
      });
    }

    const scopes = await this.keycloak.getClientDefaultScopes(clientUuid);

    if (!scopes.some((scope) => scope.name === AGENT_CLIENT_SCOPE)) {
      await this.addScope(clientUuid);
    }

    const legacy = (await this.keycloak.getProtocolMappers(clientUuid)).filter(
      (mapper) => mapper.id && LEGACY_AGENT_MAPPERS.includes(mapper.name),
    );

    for (const mapper of legacy) {
      await this.keycloak.deleteProtocolMapper(clientUuid, mapper.id as string);
    }

    if (legacy.length > 0) {
      this.logger.log(
        `Agent ${agent.id}: moved to client scope ${AGENT_CLIENT_SCOPE} (${legacy.length} legacy mapper(s) removed)`,
      );
    }
  }

  private async addScope(clientUuid: string): Promise<void> {
    try {
      if (this.scopeId === null) {
        const scope = await this.keycloak.findClientScope(AGENT_CLIENT_SCOPE);

        if (!scope) {
          throw new UpstreamBadResponseError(
            'keycloak',
            404,
            `client scope ${AGENT_CLIENT_SCOPE} missing: run the keycloak-bootstrap Job`,
          );
        }

        this.scopeId = scope.id;
      }

      await this.keycloak.addClientDefaultScope(clientUuid, this.scopeId);
    } catch (error) {
      // The scope may have been re-created with a new id: look it up again.
      this.scopeId = null;
      throw error;
    }
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
