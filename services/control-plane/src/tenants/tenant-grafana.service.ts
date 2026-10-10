import {
  Injectable,
  Logger,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import {
  type GrafanaDatasourceDefinition,
  GrafanaAdminService,
} from '../grafana/grafana-admin.service';

import { defaultDashboards } from '../grafana/default-dashboards';

import {
  type TenantRecord,
  TenantRepository,
} from './tenant.repository';

/**
 * Grafana's built-in "Main Org." always has id 1. It is reused as the org
 * of the default tenant (admin-tenant).
 */
export const DEFAULT_GRAFANA_ORG_ID = 1;

/**
 * Name of an org that Grafana refused to delete and that was emptied
 * instead. Contains characters a tenant key cannot have, so it can never
 * collide with a live tenant's org.
 */
export function retiredOrgName(
  tenantKey: string,
): string {
  return `[deleted] ${tenantKey}`;
}

/**
 * Tenant <-> Grafana org mirror (decision D-01: one org per tenant).
 * Called only by the sync worker. Every step is idempotent.
 */
@Injectable()
export class TenantGrafanaService {
  private readonly logger =
    new Logger(TenantGrafanaService.name);

  constructor(
    private readonly tenants:
      TenantRepository,

    private readonly grafana:
      GrafanaAdminService,

    private readonly config:
      ConfigService,
  ) {}

  /**
   * Ensures the tenant's org and its datasources exist and that
   * tenants.grafana_org_id points to it. Returns the org id.
   */
  async provisionOrg(
    tenant: TenantRecord,
  ): Promise<number> {
    const orgId =
      await this.ensureOrg(tenant);

    /*
     * Org 1 datasources come from the Grafana provisioning ConfigMap
     * (provisioned datasources cannot be edited through the API).
     */
    if (orgId !== DEFAULT_GRAFANA_ORG_ID) {
      for (const datasource of this.datasources()) {
        await this.grafana.upsertDatasource(
          orgId,
          datasource,
        );
      }
    }

    for (const dashboard of defaultDashboards()) {
      await this.grafana.ensureDashboard(
        orgId,
        dashboard,
      );
    }

    if (tenant.grafanaOrgId !== orgId) {
      await this.tenants.setGrafanaOrgId(
        tenant.id,
        orgId,
      );
    }

    return orgId;
  }

  /**
   * Deletes the tenant's org (dashboards included). Never org 1.
   *
   * If Grafana refuses the delete (Grafana 13 bug, see
   * GrafanaAdminService.deleteOrg) the org is RETIRED instead: no members,
   * no datasources, no dashboards, renamed "[deleted] <tenant>". That is
   * the converged state for access; grafana_org_id is kept so the resync
   * retries the real delete until Grafana accepts it, then clears it.
   */
  async removeOrg(
    tenant: TenantRecord,
  ): Promise<void> {
    if (
      tenant.grafanaOrgId === null ||
      tenant.grafanaOrgId === DEFAULT_GRAFANA_ORG_ID
    ) {
      return;
    }

    const orgId =
      await this.findOwnOrg(tenant);

    if (orgId === null) {
      await this.tenants.clearGrafanaOrgId(
        tenant.id,
      );
      return;
    }

    const result =
      await this.grafana.deleteOrg(orgId);

    if (result === 'deleted') {
      this.logger.log(
        `Deleted Grafana org ${orgId} of tenant ${tenant.tenantKey}`,
      );

      await this.tenants.clearGrafanaOrgId(
        tenant.id,
      );
      return;
    }

    await this.grafana.retireOrg(
      orgId,
      retiredOrgName(tenant.tenantKey),
    );

    this.logger.warn(
      `Grafana refused to delete org ${orgId} of tenant ${tenant.tenantKey}; ` +
        'retired it (emptied + renamed), the resync will retry the delete',
    );
  }

  /**
   * The org that belongs to this tenant, by stored id when that org still
   * carries the tenant's (live or retired) name, else by name. After a
   * Grafana rebuild the stored id may belong to another tenant: never
   * touch it then. Never returns org 1.
   */
  private async findOwnOrg(
    tenant: TenantRecord,
  ): Promise<number | null> {
    const names = [
      tenant.tenantKey,
      retiredOrgName(tenant.tenantKey),
    ];

    const org =
      tenant.grafanaOrgId === null
        ? null
        : await this.grafana.getOrg(
            tenant.grafanaOrgId,
          );

    if (org && names.includes(org.name)) {
      return org.id;
    }

    for (const name of names) {
      const byName =
        await this.grafana.findOrgByName(name);

      if (byName && byName.id !== DEFAULT_GRAFANA_ORG_ID) {
        return byName.id;
      }
    }

    return null;
  }

  private async ensureOrg(
    tenant: TenantRecord,
  ): Promise<number> {
    if (
      tenant.tenantKey === this.defaultTenantKey()
    ) {
      const mainOrg =
        await this.grafana.getOrg(
          DEFAULT_GRAFANA_ORG_ID,
        );

      if (
        mainOrg &&
        mainOrg.name !== tenant.tenantKey
      ) {
        await this.grafana.renameOrg(
          DEFAULT_GRAFANA_ORG_ID,
          tenant.tenantKey,
        );
      }

      return DEFAULT_GRAFANA_ORG_ID;
    }

    return this.grafana.ensureOrg(
      tenant.tenantKey,
    );
  }

  private defaultTenantKey(): string {
    return this.config.get<string>(
      'GRAFANA_DEFAULT_TENANT',
      'admin-tenant',
    );
  }

  private datasources(): GrafanaDatasourceDefinition[] {
    const queryGatewayUrl =
      this.config.get<string>(
        'QUERY_GATEWAY_URL',
        'http://query-gateway:8080',
      );

    /*
     * Must stay identical to kubernetes/base/query/grafana/datasources.yaml
     * (org 1 provisioning).
     */
    return [
      {
        uid: 'opensearch',
        name: 'OpenSearch',
        type: 'grafana-opensearch-datasource',
        url: `${queryGatewayUrl}/query/opensearch`,
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
        url: `${queryGatewayUrl}/query/victoriametrics`,
        jsonData: {
          oauthPassThru: true,
        },
        isDefault: true,
      },
    ];
  }
}
