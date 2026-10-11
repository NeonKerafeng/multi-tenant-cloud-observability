import type { DatabaseService } from '../../common/db/database.service';
import { ACTORS, fakeDb, IDS, tenant } from '../../common/testing/fixtures';
import { AppConfig } from '../../config/app-config';
import type { OutboxRepository } from '../../sync/outbox.repository';

import type {
  SupportAccessRecord,
  SupportAccessRepository,
} from './support-access.repository';
import { SupportAccessService } from './support-access.service';

const GRANT_ID = '11111111-2222-4333-8444-555555555555';

function record(
  overrides: Partial<SupportAccessRecord> = {},
): SupportAccessRecord {
  return {
    id: GRANT_ID,
    userId: IDS.platformAdmin,
    username: 'root-admin',
    tenantId: IDS.alpha,
    tenantKey: 'alpha-tenant',
    role: 'Viewer',
    reason: 'TICKET-42 dashboard broken',
    grantedBy: 'root-admin',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

function setup(
  opts: {
    revokeResult?: string | null;
    claimed?: { id: string; userId: string }[];
  } = {},
) {
  const { db, tx } = fakeDb();

  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };

  const grants = {
    create: jest.fn().mockResolvedValue(GRANT_ID),
    findById: jest.fn().mockResolvedValue(record()),
    list: jest.fn().mockResolvedValue([record()]),
    revoke: jest
      .fn()
      .mockResolvedValue(
        opts.revokeResult === undefined ? IDS.platformAdmin : opts.revokeResult,
      ),
    claimExpired: jest.fn().mockResolvedValue(opts.claimed ?? []),
  };

  const service = new SupportAccessService(
    db as unknown as DatabaseService,
    outbox as unknown as OutboxRepository,
    grants as unknown as SupportAccessRepository,
    AppConfig.forTest(),
  );

  return { service, outbox, grants, tx };
}

describe('SupportAccessService.grant', () => {
  it('Viewer for 60 min by default, for the caller, enqueued (Grafana) in the same transaction', async () => {
    const { service, grants, outbox, tx } = setup();

    const view = await service.grant(ACTORS.platformAdmin, tenant(), {
      reason: 'TICKET-42 dashboard broken',
    });

    expect(grants.create).toHaveBeenCalledWith(tx, {
      userId: IDS.platformAdmin,
      tenantId: IDS.alpha,
      role: 'Viewer',
      reason: 'TICKET-42 dashboard broken',
      grantedBy: 'root-admin',
      minutes: 60,
    });
    expect(outbox.enqueue).toHaveBeenCalledWith(tx, 'user', IDS.platformAdmin, [
      'grafana',
    ]);
    expect(view).toMatchObject({
      id: GRANT_ID,
      tenantKey: 'alpha-tenant',
      active: true,
    });
  });

  it('respects SUPPORT_ACCESS_MAX_MINUTES', async () => {
    const { service, grants } = setup();

    await expect(
      service.grant(ACTORS.platformAdmin, tenant(), {
        reason: 'TICKET-42 long',
        minutes: 481,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(grants.create).not.toHaveBeenCalled();
  });

  it('refuses the platform org itself', async () => {
    const { service } = setup();

    await expect(
      service.grant(ACTORS.platformAdmin, tenant({ grafanaOrgId: 1 }), {
        reason: 'TICKET-42 dashboard broken',
      }),
    ).rejects.toMatchObject({ code: 'tenant_is_platform' });
  });
});

describe('SupportAccessService.revoke / list', () => {
  it('revoking enqueues the admin to lose access', async () => {
    const { service, grants, outbox, tx } = setup();

    await service.revoke(ACTORS.platformAdmin, tenant(), GRANT_ID);

    expect(grants.revoke).toHaveBeenCalledWith(tx, GRANT_ID, 'root-admin');
    expect(outbox.enqueue).toHaveBeenCalledWith(tx, 'user', IDS.platformAdmin, [
      'grafana',
    ]);
  });

  it('revoking an already ended grant enqueues nothing', async () => {
    const { service, outbox } = setup({ revokeResult: null });

    await service.revoke(ACTORS.platformAdmin, tenant(), GRANT_ID);

    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('a grant of another tenant is not found through this tenant', async () => {
    const { service, grants } = setup();

    await expect(
      service.revoke(ACTORS.platformAdmin, tenant({ id: IDS.beta }), GRANT_ID),
    ).rejects.toMatchObject({ code: 'grant_not_found' });
    expect(grants.revoke).not.toHaveBeenCalled();
  });

  it('lists per tenant (tenant admin oversight)', async () => {
    const { service, grants } = setup();

    await service.listForTenant(ACTORS.alphaAdmin, tenant(), true);

    expect(grants.list).toHaveBeenCalledWith(IDS.alpha, true);
  });
});

describe('SupportAccessService.sweepExpired', () => {
  it('enqueues each affected admin once', async () => {
    const { service, outbox } = setup({
      claimed: [
        { id: 'g1', userId: 'u-admin' },
        { id: 'g2', userId: 'u-admin' },
        { id: 'g3', userId: 'u-other' },
      ],
    });

    await expect(service.sweepExpired()).resolves.toBe(3);

    expect(outbox.enqueue.mock.calls.map((call: unknown[]) => call[2])).toEqual(
      ['u-admin', 'u-other'],
    );
  });
});
