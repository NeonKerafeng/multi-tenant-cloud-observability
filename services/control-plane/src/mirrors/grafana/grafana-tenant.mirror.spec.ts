import type { DatabaseService } from '../../common/db/database.service';
import { IDS, tenant } from '../../common/testing/fixtures';
import { AppConfig } from '../../config/app-config';
import type { GrafanaClient } from '../../integrations/grafana/grafana.client';
import type { SupportAccessRepository } from '../../modules/support-access/support-access.repository';
import type {
  TenantRecord,
  TenantRepository,
} from '../../modules/tenants/tenant.repository';
import type { UserRepository } from '../../modules/users/user.repository';
import type { OutboxRepository } from '../../sync/outbox.repository';

import { GrafanaTenantMirror } from './grafana-tenant.mirror';

const admin = tenant({
  id: IDS.adminTenant,
  tenantKey: 'admin-tenant',
  grafanaOrgId: null,
});

function setup(current: TenantRecord) {
  const tenants = {
    findById: jest.fn().mockResolvedValue(current),
    setGrafanaOrgId: jest.fn().mockResolvedValue(undefined),
  };

  const grafana = {
    getOrg: jest.fn((id: number) =>
      Promise.resolve(
        id === 7 ? { id: 7, name: 'alpha-tenant' } : { id, name: 'Main Org.' },
      ),
    ),
    findOrgByName: jest.fn().mockResolvedValue(null),
    renameOrg: jest.fn().mockResolvedValue(undefined),
    ensureOrg: jest.fn().mockResolvedValue(7),
    deleteOrg: jest.fn().mockResolvedValue('deleted'),
    retireOrg: jest.fn().mockResolvedValue(undefined),
    upsertDatasource: jest.fn().mockResolvedValue(undefined),
    ensureDashboard: jest.fn().mockResolvedValue(true),
  };

  const users = { findIdsByTenant: jest.fn().mockResolvedValue(['u1', 'u2']) };
  const supportAccess = {
    findOpenUserIdsByTenant: jest.fn().mockResolvedValue(['u2', 'admin1']),
  };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };

  const mirror = new GrafanaTenantMirror(
    grafana as unknown as GrafanaClient,
    tenants as unknown as TenantRepository,
    users as unknown as UserRepository,
    supportAccess as unknown as SupportAccessRepository,
    outbox as unknown as OutboxRepository,
    {} as DatabaseService,
    AppConfig.forTest(),
  );

  return { mirror, grafana, tenants, outbox };
}

describe('GrafanaTenantMirror (active)', () => {
  it('org 1 for the platform tenant (renamed), provisioned datasources left alone', async () => {
    const { mirror, grafana, tenants } = setup(admin);

    await mirror.sync(admin.id);

    expect(grafana.renameOrg).toHaveBeenCalledWith(1, 'admin-tenant');
    expect(grafana.ensureOrg).not.toHaveBeenCalled();
    expect(grafana.upsertDatasource).not.toHaveBeenCalled();
    expect(tenants.setGrafanaOrgId).toHaveBeenCalledWith(IDS.adminTenant, 1);
  });

  it('creates an org with both datasources and the default dashboard', async () => {
    const { mirror, grafana, tenants } = setup(tenant({ grafanaOrgId: null }));

    await mirror.sync(IDS.alpha);

    expect(grafana.ensureOrg).toHaveBeenCalledWith('alpha-tenant');
    expect(
      (
        grafana.upsertDatasource.mock.calls as [
          number,
          { uid: string; url: string },
        ][]
      ).map(([org, ds]) => [org, ds.uid, ds.url]),
    ).toEqual([
      [7, 'opensearch', 'http://query-gateway:8080/query/opensearch'],
      [7, 'victoriametrics', 'http://query-gateway:8080/query/victoriametrics'],
    ]);
    expect(grafana.ensureDashboard).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ uid: 'mtco-host-overview' }),
    );
    expect(tenants.setGrafanaOrgId).toHaveBeenCalledWith(IDS.alpha, 7);
  });

  it('re-syncs (Grafana only) the tenant users and open grant holders, once each', async () => {
    const { mirror, outbox } = setup(tenant());

    await mirror.sync(IDS.alpha);

    expect(
      outbox.enqueue.mock.calls.map((call: unknown[]) => [call[2], call[3]]),
    ).toEqual([
      ['u1', ['grafana']],
      ['u2', ['grafana']],
      ['admin1', ['grafana']],
    ]);
  });
});

describe('GrafanaTenantMirror (deleted)', () => {
  it('deletes the org and clears the pointer', async () => {
    const { mirror, grafana, tenants } = setup(tenant({ status: 'deleted' }));

    await mirror.sync(IDS.alpha);

    expect(grafana.deleteOrg).toHaveBeenCalledWith(7);
    expect(tenants.setGrafanaOrgId).toHaveBeenCalledWith(IDS.alpha, null);
  });

  it('retires when Grafana refuses (grafana#127386) and keeps the pointer', async () => {
    const { mirror, grafana, tenants } = setup(tenant({ status: 'deleted' }));
    grafana.deleteOrg.mockResolvedValue('refused');

    await mirror.sync(IDS.alpha);

    expect(grafana.retireOrg).toHaveBeenCalledWith(7, '[deleted] alpha-tenant');
    expect(tenants.setGrafanaOrgId).not.toHaveBeenCalled();
  });

  it('never deletes org 1, nor another tenant org behind a stale id', async () => {
    const platform = setup(tenant({ status: 'deleted', grafanaOrgId: 1 }));
    await platform.mirror.sync(IDS.alpha);
    expect(platform.grafana.deleteOrg).not.toHaveBeenCalled();

    const stale = setup(
      tenant({ status: 'deleted', tenantKey: 'beta-tenant', grafanaOrgId: 7 }),
    );
    await stale.mirror.sync(IDS.alpha);
    expect(stale.grafana.deleteOrg).not.toHaveBeenCalled();
    expect(stale.tenants.setGrafanaOrgId).toHaveBeenCalledWith(IDS.alpha, null);
  });
});
