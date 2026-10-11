import { Injectable } from '@nestjs/common';

import { randomBytes } from 'node:crypto';

import { UpstreamClient } from '../../common/http/upstream-client';
import { MetricsService } from '../../common/metrics/metrics.service';
import { AppConfig } from '../../config/app-config';

export interface GrafanaOrg {
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

export type GrafanaOrgRole = 'Viewer' | 'Editor' | 'Admin';

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
 * Grafana HTTP API as the Grafana server admin (basic auth, secret
 * grafana-admin). Every method is idempotent.
 */
@Injectable()
export class GrafanaClient extends UpstreamClient {
  protected readonly service = 'grafana' as const;

  constructor(config: AppConfig, metrics: MetricsService) {
    super(config, metrics);
  }

  protected baseUrl(): string {
    return this.config.grafana.url;
  }

  protected authHeaders(): Promise<Record<string, string>> {
    const { adminUser, adminPassword } = this.config.grafana;

    return Promise.resolve({
      Authorization: `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString('base64')}`,
    });
  }

  private org(orgId: number): Record<string, string> {
    return { 'X-Grafana-Org-Id': String(orgId) };
  }

  // ------------------------------------------------------------------
  // Orgs
  // ------------------------------------------------------------------

  /**
   * Returns the org with this name, creating it if needed, and makes sure
   * the server admin is a member (required for X-Grafana-Org-Id).
   */
  async ensureOrg(name: string): Promise<number> {
    const existing = await this.findOrgByName(name);

    if (existing) {
      await this.ensureAdminMembership(existing.id);
      return existing.id;
    }

    const response = await this.request({
      method: 'POST',
      path: '/api/orgs',
      body: { name },
      accept: [409],
    });

    if (response.status === 409) {
      const raced = await this.findOrgByName(name);

      if (!raced) {
        throw new Error(`Grafana org ${name} conflict but not found`);
      }

      await this.ensureAdminMembership(raced.id);
      return raced.id;
    }

    const created = (await response.json()) as { orgId: number };

    return created.orgId;
  }

  async findOrgByName(name: string): Promise<GrafanaOrg | null> {
    const response = await this.request({
      method: 'GET',
      path: `/api/orgs/name/${encodeURIComponent(name)}`,
      accept: [404],
    });

    return response.status === 404
      ? null
      : ((await response.json()) as GrafanaOrg);
  }

  async getOrg(orgId: number): Promise<GrafanaOrg | null> {
    const response = await this.request({
      method: 'GET',
      path: `/api/orgs/${orgId}`,
      accept: [404],
    });

    return response.status === 404
      ? null
      : ((await response.json()) as GrafanaOrg);
  }

  async renameOrg(orgId: number, name: string): Promise<void> {
    await this.request({
      method: 'PUT',
      path: `/api/orgs/${orgId}`,
      body: { name },
    });
  }

  /**
   * Deletes an org; missing = 'deleted'. Returns 'refused' on 500:
   * Grafana 13.x cannot delete ANY org on unified storage
   * (grafana/grafana#127386); the caller retires the org instead.
   */
  async deleteOrg(orgId: number): Promise<'deleted' | 'refused'> {
    const response = await this.request({
      method: 'DELETE',
      path: `/api/orgs/${orgId}`,
      accept: [404, 500],
    });

    if (response.status === 500) {
      await response.text().catch(() => '');
      return 'refused';
    }

    return 'deleted';
  }

  /**
   * Empties an org that cannot be deleted, access first: every member
   * except the server admin, datasources, dashboards, folders (with their
   * alert rules), then renames it. Idempotent.
   */
  async retireOrg(orgId: number, retiredName: string): Promise<void> {
    const adminLogin = this.config.grafana.adminUser;

    const members = await this.json<{ userId: number; login: string }[]>({
      method: 'GET',
      path: `/api/orgs/${orgId}/users`,
    });

    for (const member of members) {
      if (member.login !== adminLogin) {
        await this.removeOrgUser(orgId, member.userId);
      }
    }

    const datasources = await this.json<{ uid: string }[]>({
      method: 'GET',
      path: '/api/datasources',
      headers: this.org(orgId),
    });

    for (const datasource of datasources) {
      await this.request({
        method: 'DELETE',
        path: `/api/datasources/uid/${encodeURIComponent(datasource.uid)}`,
        headers: this.org(orgId),
        accept: [404],
      });
    }

    const dashboards = await this.json<{ uid: string }[]>({
      method: 'GET',
      path: '/api/search',
      query: { type: 'dash-db', limit: 5000 },
      headers: this.org(orgId),
    });

    for (const dashboard of dashboards) {
      await this.request({
        method: 'DELETE',
        path: `/api/dashboards/uid/${encodeURIComponent(dashboard.uid)}`,
        headers: this.org(orgId),
        accept: [404],
      });
    }

    const folders = await this.json<{ uid: string }[]>({
      method: 'GET',
      path: '/api/folders',
      query: { limit: 1000 },
      headers: this.org(orgId),
    });

    for (const folder of folders) {
      await this.request({
        method: 'DELETE',
        path: `/api/folders/${encodeURIComponent(folder.uid)}`,
        query: { forceDeleteRules: true },
        headers: this.org(orgId),
        accept: [404],
      });
    }

    const org = await this.getOrg(orgId);

    if (org && org.name !== retiredName) {
      await this.renameOrg(orgId, retiredName);
    }
  }

  /** Creates or updates a datasource (matched by uid) inside an org. */
  async upsertDatasource(
    orgId: number,
    datasource: GrafanaDatasourceDefinition,
  ): Promise<void> {
    const body = {
      ...datasource,
      access: 'proxy',
      isDefault: datasource.isDefault ?? false,
    };

    const existing = await this.request({
      method: 'GET',
      path: `/api/datasources/uid/${encodeURIComponent(datasource.uid)}`,
      headers: this.org(orgId),
      accept: [404],
    });

    if (existing.status === 404) {
      await this.request({
        method: 'POST',
        path: '/api/datasources',
        body,
        headers: this.org(orgId),
      });
      return;
    }

    await existing.body?.cancel().catch(() => undefined);

    await this.request({
      method: 'PUT',
      path: `/api/datasources/uid/${encodeURIComponent(datasource.uid)}`,
      body,
      headers: this.org(orgId),
    });
  }

  /**
   * Creates the dashboard if no dashboard with its uid exists. Never
   * overwrites: a tenant's edited copy wins. Returns true if created.
   */
  async ensureDashboard(
    orgId: number,
    dashboard: { uid: string; title: string },
  ): Promise<boolean> {
    const existing = await this.request({
      method: 'GET',
      path: `/api/dashboards/uid/${encodeURIComponent(dashboard.uid)}`,
      headers: this.org(orgId),
      accept: [404],
    });

    if (existing.status !== 404) {
      await existing.body?.cancel().catch(() => undefined);
      return false;
    }

    const response = await this.request({
      method: 'POST',
      path: '/api/dashboards/db',
      body: {
        dashboard: { ...dashboard, id: null },
        overwrite: false,
        message: 'Provisioned by control-plane',
      },
      headers: this.org(orgId),
      // 412 = created concurrently by another replica: fine.
      accept: [412],
    });

    return response.status !== 412;
  }

  // ------------------------------------------------------------------
  // Users and org membership (control-plane is the only writer).
  // ------------------------------------------------------------------

  async getUser(userId: number): Promise<GrafanaUser | null> {
    const response = await this.request({
      method: 'GET',
      path: `/api/users/${userId}`,
      accept: [404],
    });

    return response.status === 404
      ? null
      : ((await response.json()) as GrafanaUser);
  }

  async lookupUser(loginOrEmail: string): Promise<GrafanaUser | null> {
    const response = await this.request({
      method: 'GET',
      path: '/api/users/lookup',
      query: { loginOrEmail },
      accept: [404],
    });

    return response.status === 404
      ? null
      : ((await response.json()) as GrafanaUser);
  }

  /**
   * Pre-provisions a user. The random password is never used: people sign
   * in through Keycloak, matched by email (login form disabled).
   */
  async createUser(input: {
    login: string;
    email: string;
    name: string;
    orgId: number;
  }): Promise<number> {
    const created = await this.json<{ id: number }>({
      method: 'POST',
      path: '/api/admin/users',
      body: {
        login: input.login,
        email: input.email,
        name: input.name,
        password: randomBytes(32).toString('hex'),
        OrgId: input.orgId,
      },
    });

    return created.id;
  }

  async deleteUser(userId: number): Promise<void> {
    await this.request({
      method: 'DELETE',
      path: `/api/admin/users/${userId}`,
      accept: [404],
    });
  }

  getUserOrgs(userId: number): Promise<GrafanaOrgMembership[]> {
    return this.json<GrafanaOrgMembership[]>({
      method: 'GET',
      path: `/api/users/${userId}/orgs`,
    });
  }

  async addOrgUser(
    orgId: number,
    login: string,
    role: GrafanaOrgRole,
  ): Promise<void> {
    // 409 = already a member (the role is reconciled separately).
    await this.request({
      method: 'POST',
      path: `/api/orgs/${orgId}/users`,
      body: { loginOrEmail: login, role },
      accept: [409],
    });
  }

  async updateOrgUserRole(
    orgId: number,
    userId: number,
    role: GrafanaOrgRole,
  ): Promise<void> {
    await this.request({
      method: 'PATCH',
      path: `/api/orgs/${orgId}/users/${userId}`,
      body: { role },
    });
  }

  async removeOrgUser(orgId: number, userId: number): Promise<void> {
    await this.request({
      method: 'DELETE',
      path: `/api/orgs/${orgId}/users/${userId}`,
      accept: [404],
    });
  }

  private async ensureAdminMembership(orgId: number): Promise<void> {
    await this.request({
      method: 'POST',
      path: `/api/orgs/${orgId}/users`,
      body: { loginOrEmail: this.config.grafana.adminUser, role: 'Admin' },
      accept: [409],
    });
  }
}
