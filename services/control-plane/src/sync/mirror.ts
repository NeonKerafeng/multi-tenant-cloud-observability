/**
 * Mirrors: Keycloak and Grafana are one-way copies of the control-plane
 * DB. Each (target, aggregate) pair has exactly one MirrorHandler.
 *
 * A handler is level-triggered and idempotent: it ignores WHAT changed,
 * reads the CURRENT row and makes the target match. Running it twice, out
 * of order or concurrently is harmless. A thrown error = "not converged
 * yet": the outbox retries with backoff.
 */

export type Target = 'keycloak' | 'grafana';

export type Aggregate = 'tenant' | 'user' | 'agent';

/** Which mirrors care about which aggregate (one outbox row per target). */
export const MIRROR_TARGETS: Readonly<Record<Aggregate, readonly Target[]>> = {
  tenant: ['keycloak', 'grafana'],
  user: ['keycloak', 'grafana'],
  agent: ['keycloak'],
};

export const ALL_TARGETS: readonly Target[] = ['keycloak', 'grafana'];

export const AGGREGATES: readonly Aggregate[] = ['tenant', 'user', 'agent'];

export interface MirrorHandler {
  readonly target: Target;
  readonly aggregate: Aggregate;
  sync(aggregateId: string): Promise<void>;
}

/** DI token: MirrorHandler[] (provided by MirrorsModule). */
export const MIRROR_HANDLERS = Symbol('MIRROR_HANDLERS');
