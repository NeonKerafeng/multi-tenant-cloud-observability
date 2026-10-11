export type Role = 'platform-admin' | 'tenant-admin' | 'viewer';

export const ROLES: readonly Role[] = [
  'platform-admin',
  'tenant-admin',
  'viewer',
];

/**
 * The caller of a request, loaded from the control-plane DB (NOT from
 * token claims): role and tenant changes and disabling take effect on the
 * next request, not when the token expires (I-35).
 */
export interface Actor {
  userId: string;
  keycloakUserId: string;
  username: string;
  email: string;
  role: Role;
  /** null for platform admins. */
  tenantId: string | null;
  tenantKey: string | null;
}

export function isPlatformAdmin(actor: Actor): boolean {
  return actor.role === 'platform-admin';
}
