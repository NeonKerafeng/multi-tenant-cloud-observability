import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import type { TenantRepository } from '../../modules/tenants/tenant.repository';
import { ACTORS, IDS, tenant } from '../testing/fixtures';

import type { Actor } from './actor';
import {
  TenantScopeGuard,
  type TenantScopeOptions,
} from './tenant-scope.guard';

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

function setup(
  options: TenantScopeOptions,
  actor: Actor,
  request: {
    params?: Record<string, string>;
    query?: Record<string, string>;
  } = {},
) {
  const req: Record<string, unknown> = {
    params: request.params ?? {},
    query: request.query ?? {},
    actor,
  };

  const context = {
    getHandler: () => 'h',
    getClass: () => 'c',
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;

  const all = [alpha, beta, gone];

  const tenants = {
    findByKey: jest.fn((key: string) =>
      Promise.resolve(all.find((t) => t.tenantKey === key) ?? null),
    ),
    findById: jest.fn((id: string) =>
      Promise.resolve(all.find((t) => t.id === id) ?? null),
    ),
  };

  const guard = new TenantScopeGuard(
    { getAllAndOverride: () => options } as unknown as Reflector,
    tenants as unknown as TenantRepository,
  );

  return { guard, context, req };
}

describe('TenantScopeGuard from param', () => {
  const param: TenantScopeOptions = { from: 'param', param: 'tenantKey' };

  it('platform admin: any active tenant', async () => {
    const { guard, context, req } = setup(param, ACTORS.platformAdmin, {
      params: { tenantKey: 'beta-tenant' },
    });

    await guard.canActivate(context);
    expect(req.tenant).toBe(beta);
  });

  it('tenant admin: own tenant', async () => {
    const { guard, context, req } = setup(param, ACTORS.alphaAdmin, {
      params: { tenantKey: 'alpha-tenant' },
    });

    await guard.canActivate(context);
    expect(req.tenant).toBe(alpha);
  });

  it('tenant admin: another tenant is forbidden', async () => {
    const { guard, context } = setup(param, ACTORS.alphaAdmin, {
      params: { tenantKey: 'beta-tenant' },
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it.each(['gone-tenant', 'nope'])('%s → 404 tenant_not_found', async (key) => {
    const { guard, context } = setup(param, ACTORS.platformAdmin, {
      params: { tenantKey: key },
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'tenant_not_found',
    });
  });
});

describe('TenantScopeGuard from actor-home (v0.7 legacy)', () => {
  it('uses the actor tenant', async () => {
    const { guard, context, req } = setup(
      { from: 'actor-home' },
      ACTORS.alphaAdmin,
    );

    await guard.canActivate(context);
    expect(req.tenant).toBe(alpha);
  });

  it('platform admin has none → tenant_required', async () => {
    const { guard, context } = setup(
      { from: 'actor-home' },
      ACTORS.platformAdmin,
    );

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'tenant_required',
    });
  });
});

describe('TenantScopeGuard from query (v0.7 legacy GET /agents)', () => {
  const query: TenantScopeOptions = { from: 'query', query: 'tenant' };

  it('platform admin without ?tenant → null (everything)', async () => {
    const { guard, context, req } = setup(query, ACTORS.platformAdmin);

    await guard.canActivate(context);
    expect(req.tenant).toBeNull();
  });

  it('platform admin with ?tenant → that tenant', async () => {
    const { guard, context, req } = setup(query, ACTORS.platformAdmin, {
      query: { tenant: 'beta-tenant' },
    });

    await guard.canActivate(context);
    expect(req.tenant).toBe(beta);
  });

  it('tenant admin without ?tenant → own tenant', async () => {
    const { guard, context, req } = setup(query, ACTORS.alphaAdmin);

    await guard.canActivate(context);
    expect(req.tenant).toBe(alpha);
  });

  it('tenant admin naming another tenant → forbidden', async () => {
    const { guard, context } = setup(query, ACTORS.alphaAdmin, {
      query: { tenant: 'beta-tenant' },
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
