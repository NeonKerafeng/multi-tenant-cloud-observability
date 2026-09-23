import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
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
}
