jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

import type { ConfigService } from '@nestjs/config';

import type { GrafanaAdminService } from '../grafana/grafana-admin.service';

import { TenantGrafanaService } from './tenant-grafana.service';
import type { TenantRecord, TenantRepository } from './tenant.repository';

function tenant(tenantKey: string, grafanaOrgId: number | null): TenantRecord {
  return {
    id: `id-${tenantKey}`,
    tenantKey,
    vmAccountId: '1',
    keycloakGroupId: 'g',
    grafanaOrgId,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

function setup() {
  const repo = { setGrafanaOrgId: jest.fn().mockResolvedValue(undefined) };

  const grafana = {
    getOrg: jest.fn().mockResolvedValue({ id: 1, name: 'Main Org.' }),
    renameOrg: jest.fn().mockResolvedValue(undefined),
    ensureOrg: jest.fn().mockResolvedValue(7),
    deleteOrg: jest.fn().mockResolvedValue(undefined),
    upsertDatasource: jest.fn().mockResolvedValue(undefined),
  };

  const service = new TenantGrafanaService(
    repo as unknown as TenantRepository,
    grafana as unknown as GrafanaAdminService,
    {
      get: jest.fn((_key: string, fallback: string) => fallback),
    } as unknown as ConfigService,
  );

  return { service, repo, grafana };
}

describe('TenantGrafanaService', () => {
  it('uses (and renames) org 1 for the default tenant, leaving its provisioned datasources alone', async () => {
    const { service, grafana, repo } = setup();

    await expect(service.provisionOrg(tenant('admin-tenant', null))).resolves.toBe(1);

    expect(grafana.renameOrg).toHaveBeenCalledWith(1, 'admin-tenant');
    expect(grafana.ensureOrg).not.toHaveBeenCalled();
    expect(grafana.upsertDatasource).not.toHaveBeenCalled();
    expect(repo.setGrafanaOrgId).toHaveBeenCalledWith('id-admin-tenant', 1);
  });

  it('creates an org and both datasources for a normal tenant', async () => {
    const { service, grafana, repo } = setup();

    await expect(service.provisionOrg(tenant('alpha-tenant', null))).resolves.toBe(7);

    expect(grafana.ensureOrg).toHaveBeenCalledWith('alpha-tenant');
    expect(
      (grafana.upsertDatasource.mock.calls as [number, { uid: string; url: string }][]).map(
        ([org, ds]) => [org, ds.uid, ds.url],
      ),
    ).toEqual([
      [7, 'opensearch', 'http://query-gateway:8080/query/opensearch'],
      [7, 'victoriametrics', 'http://query-gateway:8080/query/victoriametrics'],
    ]);
    expect(repo.setGrafanaOrgId).toHaveBeenCalledWith('id-alpha-tenant', 7);
  });

  it('does not rewrite grafana_org_id when already correct', async () => {
    const { service, repo } = setup();

    await service.provisionOrg(tenant('alpha-tenant', 7));

    expect(repo.setGrafanaOrgId).not.toHaveBeenCalled();
  });

  it('never deletes org 1', async () => {
    const { service, grafana } = setup();

    await service.removeOrg(tenant('admin-tenant', 1));

    expect(grafana.deleteOrg).not.toHaveBeenCalled();
  });

  it('deletes the org of a normal tenant', async () => {
    const { service, grafana } = setup();

    await service.removeOrg(tenant('alpha-tenant', 7));

    expect(grafana.deleteOrg).toHaveBeenCalledWith(7);
  });
});
