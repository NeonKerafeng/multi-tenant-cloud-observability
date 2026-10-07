import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import type { AuthUser } from '../auth/auth-user';

import type { HttpProxyService } from './http-proxy.service';
import { VictoriaMetricsController } from './victoriametrics.controller';

/*
 * @nestjs/config, @nestjs/axios and @nestjs/passport ship as ESM-only packages that Jest
 * (CommonJS) cannot load. The controller only needs them as DI tokens here.
 */
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('./http-proxy.service', () => ({ HttpProxyService: class {} }));
jest.mock('../auth/jwt-auth.guard', () => ({ JwtAuthGuard: class {} }));

type AuthenticatedRequest = Request & { user: AuthUser };

const viewer: AuthUser = {
  sub: 'u1',
  username: 'viewer-a',
  roles: ['viewer'],
  groups: ['tenant-a'],
  vmAccountIds: ['2'],
};

const platformAdmin: AuthUser = {
  sub: 'u0',
  username: 'root',
  roles: ['platform-admin'],
  groups: ['admin-tenant'],
  vmAccountIds: ['1'],
};

function setup() {
  const forward = jest
    .fn<Promise<void>, unknown[]>()
    .mockResolvedValue(undefined);

  const proxy = { forward } as unknown as HttpProxyService;

  const config = {
    getOrThrow: jest.fn().mockReturnValue('http://vmselect:8481'),
  } as unknown as ConfigService;

  const controller = new VictoriaMetricsController(proxy, config);

  const call = (user: AuthUser, path: string, method = 'GET') =>
    controller.proxyRequest(
      {
        method,
        originalUrl: `/query/victoriametrics${path}`,
        user,
      } as unknown as AuthenticatedRequest,
      {} as Response,
    );

  const targetPath = (): string => forward.mock.calls[0][5] as string;

  return { call, forward, targetPath };
}

describe('VictoriaMetricsController', () => {
  it('routes a tenant user to its own account', async () => {
    const { call, targetPath } = setup();

    await call(viewer, '/api/v1/query?query=up');

    expect(targetPath()).toBe('/select/2/prometheus/api/v1/query?query=up');
  });

  it('routes platform-admin to the multitenant endpoint', async () => {
    const { call, targetPath } = setup();

    await call(platformAdmin, '/api/v1/query_range?query=up');

    expect(targetPath()).toBe(
      '/select/multitenant/prometheus/api/v1/query_range?query=up',
    );
  });

  it.each([
    '/api/v1/../../../../multitenant/prometheus/api/v1/query?query=up',
    '/api/v1/%2e%2e/%2e%2e/%2e%2e/%2e%2e/multitenant/prometheus/api/v1/query',
    '/api/v1/../../../../1/prometheus/api/v1/query?query=up',
    '/api/v1/..%5c..%5c..%5c..%5cmultitenant/prometheus/api/v1/query',
  ])('blocks traversal to other tenants: %s', async (path) => {
    const { call, forward } = setup();

    await expect(call(viewer, path)).rejects.toThrow(ForbiddenException);
    expect(forward).not.toHaveBeenCalled();
  });

  it('blocks admin endpoints', async () => {
    const { call, forward } = setup();

    await expect(
      call(viewer, '/api/v1/admin/tsdb/delete_series?match[]=up'),
    ).rejects.toThrow(ForbiddenException);
    expect(forward).not.toHaveBeenCalled();
  });

  it('blocks non-read methods', async () => {
    const { call } = setup();

    await expect(call(viewer, '/api/v1/query', 'DELETE')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('blocks users without an observability role', async () => {
    const { call, forward } = setup();

    await expect(
      call({ ...viewer, roles: ['offline_access'] }, '/api/v1/query?query=up'),
    ).rejects.toThrow(ForbiddenException);
    expect(forward).not.toHaveBeenCalled();
  });

  it('blocks users in zero or several tenant groups', async () => {
    const { call } = setup();

    await expect(
      call({ ...viewer, groups: [] }, '/api/v1/query'),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      call({ ...viewer, groups: ['a', 'b'] }, '/api/v1/query'),
    ).rejects.toThrow(ForbiddenException);
  });
});
