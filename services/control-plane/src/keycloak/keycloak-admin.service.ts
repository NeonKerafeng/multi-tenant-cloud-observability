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
}
