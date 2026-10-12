/**
 * Route inventory read from the controllers' metadata. Only used by specs
 * (routes.spec.ts, app.http.spec.ts).
 */
import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { HealthController } from '../health/health.controller';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../auth/metadata';
import { AgentsController } from '../../modules/agents/agents.controller';
import { EnrollmentsController } from '../../modules/enrollments/enrollments.controller';
import { SupportAccessController } from '../../modules/support-access/support-access.controller';
import { TenantsController } from '../../modules/tenants/tenants.controller';
import {
  MeController,
  UsersController,
} from '../../modules/users/users.controller';
import { MetricsController, SyncController } from '../../sync/sync.controller';

export const ALL_CONTROLLERS: Type<unknown>[] = [
  AgentsController,
  EnrollmentsController,
  HealthController,
  MeController,
  MetricsController,
  SupportAccessController,
  SyncController,
  TenantsController,
  UsersController,
];

export interface RouteInfo {
  method: string;
  /** Controller path + method path, `:params`, without the global prefix. */
  path: string;
  /** 'public', the sorted roles joined by ',', or 'MISSING'. */
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

export function routeInventory(
  controllers: Type<unknown>[] = ALL_CONTROLLERS,
): RouteInfo[] {
  const routes: RouteInfo[] = [];

  for (const controller of controllers) {
    const base: unknown = Reflect.getMetadata(PATH_METADATA, controller);
    const prototype = controller.prototype as Record<string, unknown>;

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
        method,
        path: join(base, path),
        access: isPublic
          ? 'public'
          : roles
            ? [...roles].sort().join(',')
            : 'MISSING',
      });
    }
  }

  return routes.sort((a, b) =>
    `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
  );
}
