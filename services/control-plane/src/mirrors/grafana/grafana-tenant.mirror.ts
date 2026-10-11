import { Injectable, Logger } from '@nestjs/common';

import { DatabaseService } from '../../common/db/database.service';
import { AppConfig } from '../../config/app-config';
import { defaultDashboards } from '../../integrations/grafana/default-dashboards';
import {
  GrafanaClient,
  type GrafanaDatasourceDefinition,
} from '../../integrations/grafana/grafana.client';
import { SupportAccessRepository } from '../../modules/support-access/support-access.repository';
import {
  type TenantRecord,
  TenantRepository,
} from '../../modules/tenants/tenant.repository';
import { UserRepository } from '../../modules/users/user.repository';
import type { MirrorHandler } from '../../sync/mirror';
import { OutboxRepository } from '../../sync/outbox.repository';

/**
 * Grafana's built-in org always has id 1; it is the org of the platform
 * tenant (GRAFANA_DEFAULT_TENANT, admin-tenant).
 */
export const DEFAULT_GRAFANA_ORG_ID = 1;

/**
 * Name of an org that Grafana refused to delete and that was emptied
 * instead. Contains characters a tenant key cannot have.
 */
export function retiredOrgName(tenantKey: string): string {
  return `[deleted] ${tenantKey}`;
}

/**
 * Tenant → Grafana org (D-01: one org per tenant).
 * active  → org + both datasources + default dashboards; grafana_org_id set.
 * deleted → org deleted; if Grafana refuses (grafana#127386) it is RETIRED
 *           (no members/datasources/dashboards, renamed) and the pointer is
 *           kept so the resync retries the delete until Grafana accepts.
 * Then the users whose memberships depend on this org are re-synced in
 * Grafana: the tenant's users and platform admins with an open grant.
 */
@Injectable()
export class GrafanaTenantMirror implements MirrorHandler {
  readonly target = 'grafana' as const;
  readonly aggregate = 'tenant' as const;

  private readonly logger = new Logger(GrafanaTenantMirror.name);

  constructor(
    private readonly grafana: GrafanaClient,
    private readonly tenants: TenantRepository,
    private readonly users: UserRepository,
    private readonly supportAccess: SupportAccessRepository,
    private readonly outbox: OutboxRepository,
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
  ) {}

  async sync(tenantId: string): Promise<void> {
    const tenant = await this.tenants.findById(tenantId);

    if (!tenant) {
      return;
    }

    if (tenant.status === 'active') {
      await this.provisionOrg(tenant);
    } else {
      await this.removeOrg(tenant);
    }

    const userIds = new Set([
      ...(await this.users.findIdsByTenant(tenant.id)),
      ...(await this.supportAccess.findOpenUserIdsByTenant(tenant.id)),
    ]);

    for (const userId of userIds) {
      await this.outbox.enqueue(this.db, 'user', userId, ['grafana']);
    }
  }

  async provisionOrg(tenant: TenantRecord): Promise<number> {
    const orgId = await this.ensureOrg(tenant);

    // Org 1 datasources come from the Grafana provisioning ConfigMap
    // (provisioned datasources cannot be edited through the API).
    if (orgId !== DEFAULT_GRAFANA_ORG_ID) {
      for (const datasource of this.datasources()) {
        await this.grafana.upsertDatasource(orgId, datasource);
      }
    }

    for (const dashboard of defaultDashboards()) {
      await this.grafana.ensureDashboard(orgId, dashboard);
    }

    if (tenant.grafanaOrgId !== orgId) {
      await this.tenants.setGrafanaOrgId(tenant.id, orgId);
    }

    return orgId;
  }

  async removeOrg(tenant: TenantRecord): Promise<void> {
    if (
      tenant.grafanaOrgId === null ||
      tenant.grafanaOrgId === DEFAULT_GRAFANA_ORG_ID
    ) {
      return;
    }

    const orgId = await this.findOwnOrg(tenant);

    if (orgId === null) {
      await this.tenants.setGrafanaOrgId(tenant.id, null);
      return;
    }

    if ((await this.grafana.deleteOrg(orgId)) === 'deleted') {
      this.logger.log(
        `Deleted Grafana org ${orgId} of tenant ${tenant.tenantKey}`,
      );
      await this.tenants.setGrafanaOrgId(tenant.id, null);
      return;
    }

    await this.grafana.retireOrg(orgId, retiredOrgName(tenant.tenantKey));

    this.logger.warn(
      `Grafana refused to delete org ${orgId} of tenant ${tenant.tenantKey}; ` +
        'retired it (emptied + renamed), the resync will retry the delete',
    );
  }

  /**
   * The org of this tenant: the stored id while it still carries the
   * tenant's (live or retired) name, else by name. After a Grafana
   * rebuild a stored id may belong to another tenant: never touch it then.
   * Never returns org 1.
   */
  private async findOwnOrg(tenant: TenantRecord): Promise<number | null> {
    const names = [tenant.tenantKey, retiredOrgName(tenant.tenantKey)];

    const org =
      tenant.grafanaOrgId === null
        ? null
        : await this.grafana.getOrg(tenant.grafanaOrgId);

    if (org && names.includes(org.name)) {
      return org.id;
    }

    for (const name of names) {
      const byName = await this.grafana.findOrgByName(name);

      if (byName && byName.id !== DEFAULT_GRAFANA_ORG_ID) {
        return byName.id;
      }
    }

    return null;
  }

  private async ensureOrg(tenant: TenantRecord): Promise<number> {
    if (tenant.tenantKey === this.config.grafana.defaultTenant) {
      const mainOrg = await this.grafana.getOrg(DEFAULT_GRAFANA_ORG_ID);

      if (mainOrg && mainOrg.name !== tenant.tenantKey) {
        await this.grafana.renameOrg(DEFAULT_GRAFANA_ORG_ID, tenant.tenantKey);
      }

      return DEFAULT_GRAFANA_ORG_ID;
    }

    return this.grafana.ensureOrg(tenant.tenantKey);
  }

  /** Must stay identical to kubernetes/base/query/grafana/datasources.yaml. */
  private datasources(): GrafanaDatasourceDefinition[] {
    const base = this.config.queryGatewayUrl;

    return [
      {
        uid: 'opensearch',
        name: 'OpenSearch',
        type: 'grafana-opensearch-datasource',
        url: `${base}/query/opensearch`,
        jsonData: {
          flavor: 'opensearch',
          version: '3.8.0',
          database: 'otel-logs*',
          timeField: '@timestamp',
          oauthPassThru: true,
        },
      },
      {
        uid: 'victoriametrics',
        name: 'VictoriaMetrics',
        type: 'prometheus',
        url: `${base}/query/victoriametrics`,
        jsonData: { oauthPassThru: true },
        isDefault: true,
      },
    ];
  }
}
