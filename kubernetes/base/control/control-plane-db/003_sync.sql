BEGIN;

-- ---------------------------------------------------------------
-- users: control-plane is the source of truth for human users.
-- Keycloak (login) and Grafana (org membership) are mirrors.
-- tenant_id is NULL for platform admins (bootstrap identities).
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  keycloak_user_id TEXT NOT NULL UNIQUE,

  tenant_id UUID
    REFERENCES tenants(id)
    ON DELETE RESTRICT,

  username TEXT NOT NULL,
  email TEXT NOT NULL,

  role TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,

  grafana_user_id BIGINT UNIQUE,

  status TEXT NOT NULL DEFAULT 'active',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT users_role_check
    CHECK (role IN ('platform-admin', 'tenant-admin', 'viewer')),

  CONSTRAINT users_status_check
    CHECK (status IN ('active', 'deleted')),

  CONSTRAINT users_tenant_role_check
    CHECK (
      (role = 'platform-admin' AND tenant_id IS NULL)
      OR (role <> 'platform-admin' AND tenant_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_users_tenant_id
  ON users(tenant_id);

DROP TRIGGER IF EXISTS users_set_updated_at
  ON users;

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------
-- outbox: written in the SAME transaction as the business change.
-- A worker converges mirrors (Grafana) to the current DB state.
-- Events are "level-triggered": the handler re-reads the current
-- row, so ordering and duplicates are harmless.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,

  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,

  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  last_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,

  CONSTRAINT outbox_aggregate_type_check
    CHECK (aggregate_type IN ('tenant', 'user'))
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox(next_attempt_at)
  WHERE processed_at IS NULL;

-- At most one pending event per aggregate (dedupe).
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_pending_aggregate
  ON outbox(aggregate_type, aggregate_id)
  WHERE processed_at IS NULL;

-- Wake the worker immediately (LISTEN outbox_new).
CREATE OR REPLACE FUNCTION outbox_notify()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('outbox_new', '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS outbox_notify_insert
  ON outbox;

CREATE TRIGGER outbox_notify_insert
AFTER INSERT ON outbox
FOR EACH STATEMENT
EXECUTE FUNCTION outbox_notify();

COMMIT;
