BEGIN;

-- ---------------------------------------------------------------
-- support_access: time-boxed ("just-in-time") access of a platform
-- admin to ONE tenant's Grafana org.
--
-- By default platform admins are members of the platform org only
-- (Grafana org 1). A grant adds them to a tenant org until expires_at
-- or until it is revoked (by a platform admin or that tenant's admin).
--
-- Rows are never deleted: the table doubles as the audit log.
-- expiry_synced_at is set once the end of the grant (expiry or
-- revocation) has been enqueued to the outbox, so every grant ends
-- with exactly one sync of its user.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  tenant_id UUID NOT NULL
    REFERENCES tenants(id)
    ON DELETE RESTRICT,

  role TEXT NOT NULL DEFAULT 'Viewer',
  reason TEXT NOT NULL,

  granted_by TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,

  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,

  expiry_synced_at TIMESTAMPTZ,

  CONSTRAINT support_access_role_check
    CHECK (role IN ('Viewer', 'Editor')),

  CONSTRAINT support_access_reason_check
    CHECK (length(btrim(reason)) BETWEEN 10 AND 500),

  CONSTRAINT support_access_window_check
    CHECK (expires_at > created_at)
);

-- Grants still in effect (or whose end is not yet synced) per user.
CREATE INDEX IF NOT EXISTS idx_support_access_open_user
  ON support_access(user_id)
  WHERE expiry_synced_at IS NULL;

-- Sweeper: open grants ordered by expiry.
CREATE INDEX IF NOT EXISTS idx_support_access_open_expiry
  ON support_access(expires_at)
  WHERE expiry_synced_at IS NULL;

-- Audit listing per tenant, newest first.
CREATE INDEX IF NOT EXISTS idx_support_access_tenant_created
  ON support_access(tenant_id, created_at DESC);

COMMIT;
