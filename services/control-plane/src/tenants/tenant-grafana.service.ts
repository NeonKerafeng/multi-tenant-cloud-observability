import { Injectable } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import {
  type GrafanaDatasourceDefinition,
  GrafanaAdminService,
} from '../grafana/grafana-admin.service';

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
 * Tenant <-> Grafana org mirror (decision D-01: one org per tenant).
 * Called only by the sync worker. Every step is idempotent.
 */
@Injectable()
export class TenantGrafanaService {
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
   */
  async removeOrg(
    tenant: TenantRecord,
  ): Promise<void> {
    if (
      tenant.grafanaOrgId !== null &&
      tenant.grafanaOrgId !== DEFAULT_GRAFANA_ORG_ID
    ) {
      await this.grafana.deleteOrg(
        tenant.grafanaOrgId,
      );
    }
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
