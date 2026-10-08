import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';

interface GrafanaOrg {
  id: number;
  name: string;
}

export interface GrafanaDatasourceDefinition {
  uid: string;
  name: string;
  type: string;
  url: string;
  jsonData: Record<string, unknown>;
  isDefault?: boolean;
}

export type GrafanaOrgRole =
  | 'Viewer'
  | 'Editor'
  | 'Admin';

export interface GrafanaUser {
  id: number;
  login: string;
  email: string;
  isDisabled?: boolean;
}

export interface GrafanaOrgMembership {
  orgId: number;
  name: string;
  role: GrafanaOrgRole | 'None';
}

/**
 * Thin client for the Grafana HTTP API, authenticated as the Grafana
 * server admin (basic auth, secret grafana-admin).
 *
 * Every method is idempotent so that tenant provisioning and the
 * reconcile endpoint can be retried safely.
 */
@Injectable()
export class GrafanaAdminService {
  constructor(
    private readonly config: ConfigService,
  ) {}

  /**
   * Returns the org with this name, creating it if needed, and makes
   * sure the admin user is a member (required for X-Grafana-Org-Id).
   */
  async ensureOrg(
    name: string,
  ): Promise<number> {
    const existing =
      await this.findOrgByName(name);

    if (existing) {
      await this.ensureAdminMembership(
        existing.id,
      );

      return existing.id;
    }

    const response =
      await this.request(
        'POST',
        '/api/orgs',
        { name },
      );

    if (response.status === 409) {
      const raced =
        await this.findOrgByName(name);

      if (!raced) {
        throw new Error(
          `Grafana org ${name} conflict but not found`,
        );
      }

      await this.ensureAdminMembership(
        raced.id,
      );

      return raced.id;
    }

    await this.assertOk(
      response,
      'create Grafana org',
    );

    const created =
      (await response.json()) as {
        orgId: number;
      };

    return created.orgId;
  }

  async findOrgByName(
    name: string,
  ): Promise<GrafanaOrg | null> {
    const response =
      await this.request(
        'GET',
        `/api/orgs/name/${encodeURIComponent(name)}`,
      );

    if (response.status === 404) {
      return null;
    }

    await this.assertOk(
      response,
      'read Grafana org',
    );

    return (await response.json()) as GrafanaOrg;
  }

  async getOrg(
    orgId: number,
  ): Promise<GrafanaOrg | null> {
    const response =
      await this.request(
        'GET',
        `/api/orgs/${orgId}`,
      );

    if (response.status === 404) {
      return null;
    }

    await this.assertOk(
      response,
      'read Grafana org',
    );

    return (await response.json()) as GrafanaOrg;
  }

  async renameOrg(
    orgId: number,
    name: string,
  ): Promise<void> {
    const response =
      await this.request(
        'PUT',
        `/api/orgs/${orgId}`,
        { name },
      );

    await this.assertOk(
      response,
      'rename Grafana org',
    );
  }

  /**
   * Deletes an org. A missing org counts as success.
   */
  async deleteOrg(
    orgId: number,
  ): Promise<void> {
    const response =
      await this.request(
        'DELETE',
        `/api/orgs/${orgId}`,
      );

    if (response.status === 404) {
      return;
    }

    await this.assertOk(
      response,
      'delete Grafana org',
    );
  }

  /**
   * Creates or updates a datasource (matched by uid) inside an org.
   */
  async upsertDatasource(
    orgId: number,
    datasource: GrafanaDatasourceDefinition,
  ): Promise<void> {
    const body = {
      ...datasource,
      access: 'proxy',
      isDefault:
        datasource.isDefault ?? false,
    };

    const existing =
      await this.request(
        'GET',
        `/api/datasources/uid/${encodeURIComponent(datasource.uid)}`,
        undefined,
        orgId,
      );

    if (existing.status === 404) {
      const created =
        await this.request(
          'POST',
          '/api/datasources',
          body,
          orgId,
        );

      await this.assertOk(
        created,
        `create datasource ${datasource.uid}`,
      );

      return;
    }

    await this.assertOk(
      existing,
      `read datasource ${datasource.uid}`,
    );

    const updated =
      await this.request(
        'PUT',
        `/api/datasources/uid/${encodeURIComponent(datasource.uid)}`,
        body,
        orgId,
      );

    await this.assertOk(
      updated,
      `update datasource ${datasource.uid}`,
    );
  }

  // ---------------------------------------------------------------
  // Users and org membership (control-plane is the only writer).
  // ---------------------------------------------------------------

  async getUser(
    userId: number,
  ): Promise<GrafanaUser | null> {
    const response =
      await this.request(
        'GET',
        `/api/users/${userId}`,
      );

    if (response.status === 404) {
      return null;
    }

    await this.assertOk(
      response,
      'read Grafana user',
    );

    return (await response.json()) as GrafanaUser;
  }

  async lookupUser(
    loginOrEmail: string,
  ): Promise<GrafanaUser | null> {
    const response =
      await this.request(
        'GET',
        `/api/users/lookup?loginOrEmail=${encodeURIComponent(loginOrEmail)}`,
      );

    if (response.status === 404) {
      return null;
    }

    await this.assertOk(
      response,
      'look up Grafana user',
    );

    return (await response.json()) as GrafanaUser;
  }

  /**
   * Pre-provisions a user. The password is random and never used:
   * people sign in through Keycloak, matched by email
   * (GF_AUTH_OAUTH_ALLOW_INSECURE_EMAIL_LOOKUP) and the login form is
   * disabled.
   */
  async createUser(
    input: {
      login: string;
      email: string;
      name: string;
      orgId: number;
    },
  ): Promise<number> {
    const response =
      await this.request(
        'POST',
        '/api/admin/users',
        {
          login: input.login,
          email: input.email,
          name: input.name,
          password: randomBytes(32).toString('hex'),
          OrgId: input.orgId,
        },
      );

    await this.assertOk(
      response,
      'create Grafana user',
    );

    const created =
      (await response.json()) as {
        id: number;
      };

    return created.id;
  }

  /** Deletes a user. A missing user counts as success. */
  async deleteUser(
    userId: number,
  ): Promise<void> {
    const response =
      await this.request(
        'DELETE',
        `/api/admin/users/${userId}`,
      );

    if (response.status === 404) {
      return;
    }

    await this.assertOk(
      response,
      'delete Grafana user',
    );
  }

  async getUserOrgs(
    userId: number,
  ): Promise<GrafanaOrgMembership[]> {
    const response =
      await this.request(
        'GET',
        `/api/users/${userId}/orgs`,
      );

    await this.assertOk(
      response,
      'read Grafana user orgs',
    );

    return (await response.json()) as GrafanaOrgMembership[];
  }

  async addOrgUser(
    orgId: number,
    login: string,
    role: GrafanaOrgRole,
  ): Promise<void> {
    const response =
      await this.request(
        'POST',
        `/api/orgs/${orgId}/users`,
        {
          loginOrEmail: login,
          role,
        },
      );

    // 409 = already a member (role is reconciled separately).
    if (response.status === 409) {
      return;
    }

    await this.assertOk(
      response,
      'add user to Grafana org',
    );
  }

  async updateOrgUserRole(
    orgId: number,
    userId: number,
    role: GrafanaOrgRole,
  ): Promise<void> {
    const response =
      await this.request(
        'PATCH',
        `/api/orgs/${orgId}/users/${userId}`,
        { role },
      );

    await this.assertOk(
      response,
      'update Grafana org role',
    );
  }

  /** Removes a membership. Missing membership counts as success. */
  async removeOrgUser(
    orgId: number,
    userId: number,
  ): Promise<void> {
    const response =
      await this.request(
        'DELETE',
        `/api/orgs/${orgId}/users/${userId}`,
      );

    if (response.status === 404) {
      return;
    }

    await this.assertOk(
      response,
      'remove user from Grafana org',
    );
  }

  private async ensureAdminMembership(
    orgId: number,
  ): Promise<void> {
    const response =
      await this.request(
        'POST',
        `/api/orgs/${orgId}/users`,
        {
          loginOrEmail:
            this.config.getOrThrow<string>(
              'GRAFANA_ADMIN_USER',
            ),
          role: 'Admin',
        },
      );

    // 409 = already a member.
    if (response.status === 409) {
      return;
    }

    await this.assertOk(
      response,
      'add admin to Grafana org',
    );
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    orgId?: number,
  ): Promise<Response> {
    const baseUrl =
      this.config.getOrThrow<string>(
        'GRAFANA_URL',
      );

    const user =
      this.config.getOrThrow<string>(
        'GRAFANA_ADMIN_USER',
      );

    const password =
      this.config.getOrThrow<string>(
        'GRAFANA_ADMIN_PASSWORD',
      );

    const headers: Record<string, string> = {
      Authorization:
        `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
      Accept: 'application/json',
    };

    if (body !== undefined) {
      headers['Content-Type'] =
        'application/json';
    }

    if (orgId !== undefined) {
      headers['X-Grafana-Org-Id'] =
        String(orgId);
    }

    return fetch(
      `${baseUrl}${path}`,
      {
        method,
        headers,
        body:
          body === undefined
            ? undefined
            : JSON.stringify(body),
      },
    );
  }

  private async assertOk(
    response: Response,
    action: string,
  ): Promise<void> {
    if (response.ok) {
      return;
    }

    const detail =
      await response.text().catch(() => '');

    throw new Error(
      `Failed to ${action}: ${response.status} ${detail.slice(0, 300)}`,
    );
  }
}
