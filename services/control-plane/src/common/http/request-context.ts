import type { Actor } from '../auth/actor';
import type { TenantRecord } from '../../modules/tenants/tenant.repository';

/**
 * Fields that middleware and guards attach to the Express request.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by RequestContextMiddleware (X-Request-Id). */
      requestId?: string;
      /** Set by AuthGuard: the caller, loaded from the DB. */
      actor?: Actor;
      /**
       * Set by TenantScopeGuard. `null` only for legacy routes where a
       * platform admin may omit the tenant (list everything).
       */
      tenant?: TenantRecord | null;
    }
  }
}

export {};
