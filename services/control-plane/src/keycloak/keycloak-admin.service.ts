import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface CreateAgentIdentityInput {
  agentId: string;
  tenantId: string;
  vmAccountId: string;
}

export interface AgentIdentity {
  clientId: string;
  clientSecret: string;
}

export interface ManagedAgentIdentity {
  agentId: string;
  clientId: string;
  tenantId: string;
  vmAccountId: string;
  enabled: boolean;
}

export interface ManagedTenant {
  tenantId: string;
  vmAccountId: string;
}

type KeycloakGroupRepresentation = {
  id: string;
  name: string;
  attributes?: Record<string, string[]>;
};

type KeycloakClientRepresentation =
  Record<string, unknown> & {
    id: string;
    clientId: string;
    enabled?: boolean;
  };

type KeycloakUserRepresentation = {
  id: string;
  attributes?: Record<string, string[]>;
};

@Injectable()
export class KeycloakAdminService {
  constructor(private readonly config: ConfigService) {}

  async getAdminAccessToken(): Promise<string> {
    const baseUrl =
      this.config.getOrThrow<string>('KEYCLOAK_URL');

    const realm =
      this.config.getOrThrow<string>('KEYCLOAK_REALM');

    const clientId =
      this.config.getOrThrow<string>(
        'KEYCLOAK_ADMIN_CLIENT_ID',
      );

    const clientSecret =
      this.config.getOrThrow<string>(
        'KEYCLOAK_ADMIN_CLIENT_SECRET',
      );

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });

    const response = await fetch(
      `${baseUrl}/realms/${realm}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded',
        },
        body,
      },
    );

    if (!response.ok) {
      throw new Error(
        `Keycloak token request failed: ${response.status}`,
      );
    }

    const token =
      (await response.json()) as TokenResponse;

    return token.access_token;
  }

  async createAgentIdentity(
    input: CreateAgentIdentityInput,
  ): Promise<AgentIdentity> {
    const baseUrl =
      this.config.getOrThrow<string>('KEYCLOAK_URL');

    const realm =
      this.config.getOrThrow<string>('KEYCLOAK_REALM');

    const token = await this.getAdminAccessToken();

    const clientId = `otel-agent-${input.agentId}`;

    const createResponse = await fetch(
      `${baseUrl}/admin/realms/${realm}/clients`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientId,
          enabled: true,
          protocol: 'openid-connect',
          publicClient: false,
          clientAuthenticatorType: 'client-secret',
          standardFlowEnabled: false,
          directAccessGrantsEnabled: false,
          serviceAccountsEnabled: true,
        }),
      },
    );

    if (!createResponse.ok) {
      throw new Error(
        `Keycloak client creation failed: ${createResponse.status}`,
      );
    }

    const location = createResponse.headers.get('location');

    if (!location) {
      throw new Error(
        'Keycloak did not return client location',
      );
    }

    const clientUuid = location.split('/').pop();

    if (!clientUuid) {
      throw new Error(
        'Unable to determine Keycloak client UUID',
      );
    }

    const serviceAccountResponse = await fetch(
      `${baseUrl}/admin/realms/${realm}/clients/${clientUuid}/service-account-user`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!serviceAccountResponse.ok) {
      throw new Error(
        `Failed to get service account: ${serviceAccountResponse.status}`,
      );
    }

    const serviceAccount =
      (await serviceAccountResponse.json()) as {
        id: string;
      };

    const attributesResponse = await fetch(
      `${baseUrl}/admin/realms/${realm}/users/${serviceAccount.id}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          attributes: {
            agent_id: [input.agentId],
            tenant_id: [input.tenantId],
            vm_account_id: [input.vmAccountId],
          },
        }),
      },
    );

    if (!attributesResponse.ok) {
      throw new Error(
        `Failed to set agent attributes: ${attributesResponse.status}`,
      );
    }

    await this.createProtocolMapper(
      clientUuid,
      token,
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
    );

    for (const attribute of [
      'agent_id',
      'tenant_id',
      'vm_account_id',
    ]) {
      await this.createProtocolMapper(
        clientUuid,
        token,
        {
          name: attribute.replaceAll('_', '-'),
          protocol: 'openid-connect',
          protocolMapper:
            'oidc-usermodel-attribute-mapper',
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
        },
      );
    }

    const secretResponse = await fetch(
      `${baseUrl}/admin/realms/${realm}/clients/${clientUuid}/client-secret`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!secretResponse.ok) {
      throw new Error(
        `Failed to get agent client secret: ${secretResponse.status}`,
      );
    }

    const secret =
      (await secretResponse.json()) as {
        value: string;
      };

    return {
      clientId,
      clientSecret: secret.value,
    };
  }

  async listAgentIdentities(): Promise<ManagedAgentIdentity[]> {
    const baseUrl =
      this.config.getOrThrow<string>('KEYCLOAK_URL');

    const realm =
      this.config.getOrThrow<string>('KEYCLOAK_REALM');

    const token = await this.getAdminAccessToken();

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/clients?first=0&max=1000`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to list Keycloak clients: ${response.status}`,
      );
    }

    const clients =
      (await response.json()) as KeycloakClientRepresentation[];

    const agentClients = clients.filter((client) =>
      client.clientId.startsWith('otel-agent-'),
    );

    const agents: ManagedAgentIdentity[] = [];

    for (const client of agentClients) {
      const agent =
        await this.toManagedAgentIdentity(client, token);

      if (agent) {
        agents.push(agent);
      }
    }

    return agents;
  }

  async getAgentIdentity(
    agentId: string,
  ): Promise<ManagedAgentIdentity | null> {
    const token = await this.getAdminAccessToken();

    const client =
      await this.findAgentClient(agentId, token);

    if (!client) {
      return null;
    }

    return this.toManagedAgentIdentity(client, token);
  }

  async setAgentEnabled(
    agentId: string,
    enabled: boolean,
  ): Promise<ManagedAgentIdentity | null> {
    const baseUrl =
      this.config.getOrThrow<string>('KEYCLOAK_URL');

    const realm =
      this.config.getOrThrow<string>('KEYCLOAK_REALM');

    const token = await this.getAdminAccessToken();

    const client =
      await this.findAgentClient(agentId, token);

    if (!client) {
      return null;
    }

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/clients/${client.id}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...client,
          enabled,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to update agent client: ${response.status}`,
      );
    }

    return this.toManagedAgentIdentity(
      {
        ...client,
        enabled,
      },
      token,
    );
  }

  async deleteAgentIdentity(
    agentId: string,
  ): Promise<boolean> {
    const baseUrl =
      this.config.getOrThrow<string>('KEYCLOAK_URL');

    const realm =
      this.config.getOrThrow<string>('KEYCLOAK_REALM');

    const token = await this.getAdminAccessToken();

    const client =
      await this.findAgentClient(agentId, token);

    if (!client) {
      return false;
    }

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/clients/${client.id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to delete agent client: ${response.status}`,
      );
    }

    return true;
  }

  private async findAgentClient(
    agentId: string,
    token: string,
  ): Promise<KeycloakClientRepresentation | null> {
    const baseUrl =
      this.config.getOrThrow<string>('KEYCLOAK_URL');

    const realm =
      this.config.getOrThrow<string>('KEYCLOAK_REALM');

    const clientId = `otel-agent-${agentId}`;

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/clients?clientId=${encodeURIComponent(clientId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to find agent client: ${response.status}`,
      );
    }

    const clients =
      (await response.json()) as KeycloakClientRepresentation[];

    return (
      clients.find(
        (client) => client.clientId === clientId,
      ) ?? null
    );
  }

  private async toManagedAgentIdentity(
    client: KeycloakClientRepresentation,
    token: string,
  ): Promise<ManagedAgentIdentity | null> {
    const baseUrl =
      this.config.getOrThrow<string>('KEYCLOAK_URL');

    const realm =
      this.config.getOrThrow<string>('KEYCLOAK_REALM');

    const serviceAccountResponse = await fetch(
      `${baseUrl}/admin/realms/${realm}/clients/${client.id}/service-account-user`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!serviceAccountResponse.ok) {
      return null;
    }

    const serviceAccount =
      (await serviceAccountResponse.json()) as {
        id: string;
      };

    const userResponse = await fetch(
      `${baseUrl}/admin/realms/${realm}/users/${serviceAccount.id}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!userResponse.ok) {
      throw new Error(
        `Failed to read agent attributes: ${userResponse.status}`,
      );
    }

    const user =
      (await userResponse.json()) as KeycloakUserRepresentation;

    const attributes = user.attributes ?? {};

    const agentId = attributes.agent_id?.[0];
    const tenantId = attributes.tenant_id?.[0];
    const vmAccountId = attributes.vm_account_id?.[0];

    if (!agentId || !tenantId || !vmAccountId) {
      return null;
    }

    return {
      agentId,
      clientId: client.clientId,
      tenantId,
      vmAccountId,
      enabled: client.enabled ?? false,
    };
  }

  private async createProtocolMapper(
    clientUuid: string,
    token: string,
    mapper: Record<string, unknown>,
  ): Promise<void> {
    const baseUrl =
      this.config.getOrThrow<string>('KEYCLOAK_URL');

    const realm =
      this.config.getOrThrow<string>('KEYCLOAK_REALM');

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/clients/${clientUuid}/protocol-mappers/models`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(mapper),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to create protocol mapper: ${response.status}`,
      );
    }
  }

  async listTenants(): Promise<ManagedTenant[]> {
    const baseUrl =
      this.config.getOrThrow<string>('KEYCLOAK_URL');

    const realm =
      this.config.getOrThrow<string>('KEYCLOAK_REALM');

    const token = await this.getAdminAccessToken();

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/groups?first=0&max=1000&briefRepresentation=false`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to list Keycloak groups: ${response.status}`,
      );
    }

    const groups =
      (await response.json()) as KeycloakGroupRepresentation[];

    return groups
      .map((group) => this.toManagedTenant(group))
      .filter(
        (tenant): tenant is ManagedTenant =>
          tenant !== null,
      );
  }

  async getTenant(
    tenantId: string,
  ): Promise<ManagedTenant | null> {
    const token = await this.getAdminAccessToken();

    const group =
      await this.findTenantGroup(tenantId, token);

    if (!group) {
      return null;
    }

    return this.toManagedTenant(group);
  }

  async createTenant(
    tenantId: string,
    vmAccountId: string,
  ): Promise<ManagedTenant> {
    const baseUrl =
      this.config.getOrThrow<string>('KEYCLOAK_URL');

    const realm =
      this.config.getOrThrow<string>('KEYCLOAK_REALM');

    const token = await this.getAdminAccessToken();

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/groups`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: tenantId,
          attributes: {
            vm_account_id: [vmAccountId],
            mtco_tenant: ['true'],
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to create tenant group: ${response.status}`,
      );
    }

    return {
      tenantId,
      vmAccountId,
    };
  }

  async deleteTenant(
    tenantId: string,
  ): Promise<boolean> {
    const baseUrl =
      this.config.getOrThrow<string>('KEYCLOAK_URL');

    const realm =
      this.config.getOrThrow<string>('KEYCLOAK_REALM');

    const token = await this.getAdminAccessToken();

    const group =
      await this.findTenantGroup(tenantId, token);

    if (!group) {
      return false;
    }

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/groups/${group.id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to delete tenant group: ${response.status}`,
      );
    }

    return true;
  }

  private async findTenantGroup(
    tenantId: string,
    token: string,
  ): Promise<KeycloakGroupRepresentation | null> {
    const baseUrl =
      this.config.getOrThrow<string>('KEYCLOAK_URL');

    const realm =
      this.config.getOrThrow<string>('KEYCLOAK_REALM');

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/groups?first=0&max=1000&briefRepresentation=false`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to find tenant group: ${response.status}`,
      );
    }

    const groups =
      (await response.json()) as KeycloakGroupRepresentation[];

    return (
      groups.find(
        (group) => group.name === tenantId,
      ) ?? null
    );
  }

  private toManagedTenant(
    group: KeycloakGroupRepresentation,
  ): ManagedTenant | null {
    const vmAccountId =
      group.attributes?.vm_account_id?.[0];

    if (
      !vmAccountId ||
      !/^\d+$/.test(vmAccountId)
    ) {
      return null;
    }

    return {
      tenantId: group.name,
      vmAccountId,
    };
  }
}
