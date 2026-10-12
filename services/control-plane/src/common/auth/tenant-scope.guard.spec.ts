import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import type { TenantRepository } from '../../modules/tenants/tenant.repository';
import { ACTORS, IDS, tenant } from '../testing/fixtures';

import type { Actor } from './actor';
import { TenantScopeGuard } from './tenant-scope.guard';

const alpha = tenant();
const beta = tenant({
  id: IDS.beta,
  tenantKey: 'beta-tenant',
  grafanaOrgId: 8,
});
const gone = tenant({
  id: 'gone',
  tenantKey: 'gone-tenant',
  status: 'deleted',
});

function setup(actor: Actor, tenantKey?: string, scoped = true) {
  const req: Record<string, unknown> = {
    params: tenantKey === undefined ? {} : { tenantKey },
    actor,
  };

  const context = {
    getHandler: () => 'h',
    getClass: () => 'c',
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;

  const tenants = {
    findByKey: jest.fn((key: string) =>
      Promise.resolve(
        [alpha, beta, gone].find((t) => t.tenantKey === key) ?? null,
      ),
    ),
  };

  const guard = new TenantScopeGuard(
    { getAllAndOverride: () => scoped } as unknown as Reflector,
    tenants as unknown as TenantRepository,
  );

  return { guard, context, req, tenants };
}

describe('TenantScopeGuard', () => {
  it('platform admin: any active tenant', async () => {
    const { guard, context, req } = setup(ACTORS.platformAdmin, 'beta-tenant');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.tenant).toBe(beta);
  });

  it('tenant admin and viewer: their own tenant', async () => {
    for (const actor of [ACTORS.alphaAdmin, ACTORS.alphaViewer]) {
      const { guard, context, req } = setup(actor, 'alpha-tenant');

      await guard.canActivate(context);
      expect(req.tenant).toBe(alpha);
    }
  });

  it('another tenant → 403 forbidden', async () => {
    const { guard, context, req } = setup(ACTORS.alphaAdmin, 'beta-tenant');

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
    expect(req.tenant).toBeUndefined();
  });

  it.each([
    ['unknown', 'nope'],
    ['deleted', 'gone-tenant'],
    ['empty', ''],
  ])(
    '%s tenant → 404 tenant_not_found (platform admin too)',
    async (_l, key) => {
      const { guard, context } = setup(ACTORS.platformAdmin, key);

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: 'tenant_not_found',
        status: 404,
      });
    },
  );

  it('routes without @TenantScope are untouched', async () => {
    const { guard, context, tenants } = setup(
      ACTORS.alphaAdmin,
      'beta-tenant',
      false,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(tenants.findByKey).not.toHaveBeenCalled();
  });
});
