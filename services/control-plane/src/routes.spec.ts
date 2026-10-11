import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { IS_PUBLIC_KEY, ROLES_KEY } from './common/auth/metadata';
import { HealthController } from './common/health/health.controller';
import { AgentsController } from './modules/agents/agents.controller';
import { EnrollmentsController } from './modules/enrollments/enrollments.controller';
import { SupportAccessController } from './modules/support-access/support-access.controller';
import { TenantsController } from './modules/tenants/tenants.controller';
import { UsersController } from './modules/users/users.controller';
import { MetricsController, SyncController } from './sync/sync.controller';

const CONTROLLERS = [
  AgentsController,
  EnrollmentsController,
  HealthController,
  MetricsController,
  SupportAccessController,
  SyncController,
  TenantsController,
  UsersController,
];

interface Route {
  route: string;
  access: string;
}

function join(...parts: unknown[]): string {
  const path = parts
    .flatMap((part) => (typeof part === 'string' ? [part] : []))
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

  return `/${path}`;
}

function inventory(): Route[] {
  const routes: Route[] = [];

  for (const controller of CONTROLLERS) {
    const base: unknown = Reflect.getMetadata(PATH_METADATA, controller);
    const prototype = controller.prototype as unknown as Record<
      string,
      unknown
    >;

    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[name];

      if (name === 'constructor' || typeof handler !== 'function') {
        continue;
      }

      const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);

      if (path === undefined) {
        continue;
      }

      const method =
        RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];

      const isPublic =
        Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true ||
        Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true;

      const roles = (Reflect.getMetadata(ROLES_KEY, handler) ??
        Reflect.getMetadata(ROLES_KEY, controller)) as string[] | undefined;

      routes.push({
        route: `${method} ${join(base, path)}`,
        access: isPublic
          ? 'public'
          : roles
            ? [...roles].sort().join(',')
            : 'MISSING',
      });
    }
  }

  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

describe('route inventory (v0.7 = same URLs as v0.6, CLAUDE.md §18.1.2)', () => {
  it('every route is @Public or has @Roles (fail closed)', () => {
    expect(inventory().filter((r) => r.access === 'MISSING')).toEqual([]);
  });

  it('exposes exactly the expected routes with the expected roles', () => {
    expect(inventory().map((r) => `${r.route} [${r.access}]`)).toEqual([
      'DELETE /agents/:agentId [platform-admin,tenant-admin]',
      'DELETE /tenants/:tenantId [platform-admin]',
      'DELETE /tenants/:tenantId/support-access/:grantId [platform-admin]',
      'DELETE /tenants/:tenantId/users/:userId [platform-admin,tenant-admin]',
      'GET /agents [platform-admin,tenant-admin]',
      'GET /agents/:agentId [platform-admin,tenant-admin]',
      'GET /healthz [public]',
      'GET /metrics [public]',
      'GET /readyz [public]',
      'GET /support-access [platform-admin]',
      'GET /sync/status [platform-admin]',
      'GET /tenants [platform-admin]',
      'GET /tenants/:tenantId [platform-admin]',
      'GET /tenants/:tenantId/support-access [platform-admin,tenant-admin]',
      'GET /tenants/:tenantId/users [platform-admin,tenant-admin]',
      'GET /tenants/:tenantId/users/:userId [platform-admin,tenant-admin]',
      'POST /agent-enrollments [tenant-admin]',
      'POST /agent-enrollments/exchange [public]',
      'POST /agents [tenant-admin]',
      'POST /agents/:agentId/disable [platform-admin,tenant-admin]',
      'POST /agents/:agentId/enable [platform-admin,tenant-admin]',
      'POST /sync/resync [platform-admin]',
      'POST /tenants [platform-admin]',
      'POST /tenants/:tenantId/support-access [platform-admin]',
      'POST /tenants/:tenantId/users [platform-admin,tenant-admin]',
      'POST /tenants/:tenantId/users/:userId/disable [platform-admin,tenant-admin]',
      'POST /tenants/:tenantId/users/:userId/enable [platform-admin,tenant-admin]',
    ]);
  });
});
