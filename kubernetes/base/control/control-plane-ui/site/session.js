// Who is signed in (GET /me) + runtime config helpers.

export const cfg = window.MTCO_CONFIG;

export const session = {
  /** UserView of the signed-in user (role and tenant come from the DB). */
  me: null,
};

export function role() {
  return session.me?.role;
}

export function isPlatformAdmin() {
  return role() === 'platform-admin';
}

export function isTenantAdmin() {
  return role() === 'tenant-admin';
}

/** Mirrors users.policy.ts: may the signed-in user manage `target`? */
export function canManageUser(target) {
  if (target.role === 'platform-admin') {
    return false;
  }

  return isPlatformAdmin() || (isTenantAdmin() && target.role === 'viewer');
}

/** Roles the signed-in user may create (users.policy.ts). */
export function creatableRoles() {
  return isPlatformAdmin() ? ['viewer', 'tenant-admin'] : ['viewer'];
}

export function grafanaUrl(orgId) {
  const base = cfg.grafanaUrl.replace(/\/$/, '');

  return orgId ? `${base}/?orgId=${encodeURIComponent(orgId)}` : `${base}/`;
}
