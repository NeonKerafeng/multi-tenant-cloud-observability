import { Injectable } from '@nestjs/common';

import { UpstreamBadResponseError } from '../../common/errors/upstream-error';
import { UpstreamClient } from '../../common/http/upstream-client';
import { MetricsService } from '../../common/metrics/metrics.service';
import { AppConfig } from '../../config/app-config';

import type {
  KcClient,
  KcGroup,
  KcProtocolMapper,
  KcRole,
  KcUser,
} from './keycloak.types';

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

/** Refresh the admin token this long before it expires. */
const TOKEN_MARGIN_MS = 30 * 1000;

/**
 * The ONE Keycloak admin API client (service account
 * `control-plane-admin`, client_credentials). Token cached until 30 s
 * before expiry, refreshed once on 401, concurrent callers share one
 * token request. Methods are thin and literal; desired-state logic lives
 * in the Keycloak mirrors.
 */
@Injectable()
export class KeycloakClient extends UpstreamClient {
  protected readonly service = 'keycloak' as const;

  private token: { value: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;
  private readonly roles = new Map<string, KcRole>();

  constructor(config: AppConfig, metrics: MetricsService) {
    super(config, metrics);
  }

  protected baseUrl(): string {
    return this.config.keycloak.url;
  }

  protected async authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.adminToken()}` };
  }

  protected onUnauthorized(): boolean {
    this.token = null;
    return true;
  }

  private get admin(): string {
    return `/admin/realms/${encodeURIComponent(this.config.keycloak.realm)}`;
  }

  private adminToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) {
      return Promise.resolve(this.token.value);
    }

    this.tokenRequest ??= this.fetchToken().finally(() => {
      this.tokenRequest = null;
    });

    return this.tokenRequest;
  }

  private async fetchToken(): Promise<string> {
    const token = await this.json<TokenResponse>({
      method: 'POST',
      path: `/realms/${encodeURIComponent(this.config.keycloak.realm)}/protocol/openid-connect/token`,
      form: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.keycloak.adminClientId,
        client_secret: this.config.keycloak.adminClientSecret,
      }),
      auth: false,
    });

    if (!token.access_token) {
      throw new UpstreamBadResponseError(
        'keycloak',
        200,
        'token response without access_token',
      );
    }

    this.token = {
      value: token.access_token,
      expiresAt:
        Date.now() + Math.max(token.expires_in * 1000 - TOKEN_MARGIN_MS, 5000),
    };

    return token.access_token;
  }

  // ------------------------------------------------------------------
  // Groups
  // ------------------------------------------------------------------

  async getGroup(id: string): Promise<KcGroup | null> {
    const response = await this.request({
      method: 'GET',
      path: `${this.admin}/groups/${encodeURIComponent(id)}`,
      accept: [404],
    });

    return response.status === 404
      ? null
      : ((await response.json()) as KcGroup);
  }

  /** Top-level group with exactly this name, or null. */
  async findTopLevelGroup(name: string): Promise<KcGroup | null> {
    const groups = await this.json<KcGroup[]>({
      method: 'GET',
      path: `${this.admin}/groups`,
      query: { search: name, exact: true, briefRepresentation: false },
    });

    const match = groups.find((group) => group.name === name);

    return match ? ((await this.getGroup(match.id)) ?? null) : null;
  }

  async createGroup(group: Omit<KcGroup, 'id'>): Promise<string> {
    const response = await this.request({
      method: 'POST',
      path: `${this.admin}/groups`,
      body: group,
    });

    return this.locationId(response, 'create group');
  }

  async updateGroup(group: KcGroup): Promise<void> {
    await this.request({
      method: 'PUT',
      path: `${this.admin}/groups/${encodeURIComponent(group.id)}`,
      body: group,
    });
  }

  /** Missing group = success. */
  async deleteGroup(id: string): Promise<void> {
    await this.request({
      method: 'DELETE',
      path: `${this.admin}/groups/${encodeURIComponent(id)}`,
      accept: [404],
    });
  }

  // ------------------------------------------------------------------
  // Users
  // ------------------------------------------------------------------

  async getUser(id: string): Promise<KcUser | null> {
    const response = await this.request({
      method: 'GET',
      path: `${this.admin}/users/${encodeURIComponent(id)}`,
      accept: [404],
    });

    return response.status === 404 ? null : ((await response.json()) as KcUser);
  }

  async findUserByUsername(username: string): Promise<KcUser | null> {
    const users = await this.json<KcUser[]>({
      method: 'GET',
      path: `${this.admin}/users`,
      query: { username, exact: true, briefRepresentation: false },
    });

    const wanted = username.toLowerCase();

    return users.find((user) => user.username.toLowerCase() === wanted) ?? null;
  }

  /** Returns the id, or null on 409 (username/email already used). */
  async createUser(user: Omit<KcUser, 'id'>): Promise<string | null> {
    const response = await this.request({
      method: 'POST',
      path: `${this.admin}/users`,
      body: user,
      accept: [409],
    });

    return response.status === 409
      ? null
      : this.locationId(response, 'create user');
  }

  /** PUT of the FULL representation (read-modify-write by the caller). */
  async updateUser(user: KcUser): Promise<void> {
    await this.request({
      method: 'PUT',
      path: `${this.admin}/users/${encodeURIComponent(user.id)}`,
      body: user,
    });
  }

  async deleteUser(id: string): Promise<void> {
    await this.request({
      method: 'DELETE',
      path: `${this.admin}/users/${encodeURIComponent(id)}`,
      accept: [404],
    });
  }

  async resetPassword(id: string, password: string): Promise<void> {
    await this.request({
      method: 'PUT',
      path: `${this.admin}/users/${encodeURIComponent(id)}/reset-password`,
      body: { type: 'password', value: password, temporary: false },
    });
  }

  /** Ends every session (refresh tokens stop working). */
  async logoutUser(id: string): Promise<void> {
    await this.request({
      method: 'POST',
      path: `${this.admin}/users/${encodeURIComponent(id)}/logout`,
      accept: [404],
    });
  }

  getUserGroups(id: string): Promise<KcGroup[]> {
    return this.json<KcGroup[]>({
      method: 'GET',
      path: `${this.admin}/users/${encodeURIComponent(id)}/groups`,
      query: { briefRepresentation: true, first: 0, max: 1000 },
    });
  }

  async addUserToGroup(userId: string, groupId: string): Promise<void> {
    await this.request({
      method: 'PUT',
      path: `${this.admin}/users/${encodeURIComponent(userId)}/groups/${encodeURIComponent(groupId)}`,
    });
  }

  async removeUserFromGroup(userId: string, groupId: string): Promise<void> {
    await this.request({
      method: 'DELETE',
      path: `${this.admin}/users/${encodeURIComponent(userId)}/groups/${encodeURIComponent(groupId)}`,
      accept: [404],
    });
  }

  getUserRealmRoles(id: string): Promise<KcRole[]> {
    return this.json<KcRole[]>({
      method: 'GET',
      path: `${this.admin}/users/${encodeURIComponent(id)}/role-mappings/realm`,
    });
  }

  async realmRole(name: string): Promise<KcRole> {
    const cached = this.roles.get(name);

    if (cached) {
      return cached;
    }

    const role = await this.json<KcRole>({
      method: 'GET',
      path: `${this.admin}/roles/${encodeURIComponent(name)}`,
    });

    this.roles.set(name, role);

    return role;
  }

  async addUserRealmRoles(id: string, roles: KcRole[]): Promise<void> {
    if (roles.length === 0) {
      return;
    }

    await this.request({
      method: 'POST',
      path: `${this.admin}/users/${encodeURIComponent(id)}/role-mappings/realm`,
      body: roles,
    });
  }

  async removeUserRealmRoles(id: string, roles: KcRole[]): Promise<void> {
    if (roles.length === 0) {
      return;
    }

    await this.request({
      method: 'DELETE',
      path: `${this.admin}/users/${encodeURIComponent(id)}/role-mappings/realm`,
      body: roles,
    });
  }

  // ------------------------------------------------------------------
  // Clients (agents)
  // ------------------------------------------------------------------

  async getClient(uuid: string): Promise<KcClient | null> {
    const response = await this.request({
      method: 'GET',
      path: `${this.admin}/clients/${encodeURIComponent(uuid)}`,
      accept: [404],
    });

    return response.status === 404
      ? null
      : ((await response.json()) as KcClient);
  }

  async findClient(clientId: string): Promise<KcClient | null> {
    const clients = await this.json<KcClient[]>({
      method: 'GET',
      path: `${this.admin}/clients`,
      query: { clientId },
    });

    return clients.find((client) => client.clientId === clientId) ?? null;
  }

  async createClient(client: Omit<KcClient, 'id'>): Promise<string> {
    const response = await this.request({
      method: 'POST',
      path: `${this.admin}/clients`,
      body: client,
    });

    return this.locationId(response, 'create client');
  }

  async updateClient(client: KcClient): Promise<void> {
    await this.request({
      method: 'PUT',
      path: `${this.admin}/clients/${encodeURIComponent(client.id)}`,
      body: client,
    });
  }

  async deleteClient(uuid: string): Promise<void> {
    await this.request({
      method: 'DELETE',
      path: `${this.admin}/clients/${encodeURIComponent(uuid)}`,
      accept: [404],
    });
  }

  getServiceAccountUser(uuid: string): Promise<KcUser> {
    return this.json<KcUser>({
      method: 'GET',
      path: `${this.admin}/clients/${encodeURIComponent(uuid)}/service-account-user`,
    });
  }

  async getClientSecret(uuid: string): Promise<string> {
    const secret = await this.json<{ value?: string }>({
      method: 'GET',
      path: `${this.admin}/clients/${encodeURIComponent(uuid)}/client-secret`,
    });

    if (!secret.value) {
      throw new UpstreamBadResponseError(
        'keycloak',
        200,
        'client secret missing',
      );
    }

    return secret.value;
  }

  getProtocolMappers(uuid: string): Promise<KcProtocolMapper[]> {
    return this.json<KcProtocolMapper[]>({
      method: 'GET',
      path: `${this.admin}/clients/${encodeURIComponent(uuid)}/protocol-mappers/models`,
    });
  }

  async createProtocolMapper(
    uuid: string,
    mapper: KcProtocolMapper,
  ): Promise<void> {
    await this.request({
      method: 'POST',
      path: `${this.admin}/clients/${encodeURIComponent(uuid)}/protocol-mappers/models`,
      body: mapper,
    });
  }
}
