BEGIN;

-- ---------------------------------------------------------------
-- v0.7 (TODO-23): DB is the source of truth for Keycloak too.
-- ---------------------------------------------------------------

-- users: names live in the DB; the Keycloak id is assigned by the
-- Keycloak user mirror (NULL until mirrored, and again after deletion).
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE users ALTER COLUMN keycloak_user_id DROP NOT NULL;

-- Usernames and emails are unique among ACTIVE users (case-insensitive);
-- a deleted user's username can be reused.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_active_username
  ON users (lower(username)) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_active_email
  ON users (lower(email)) WHERE status = 'active';

-- tenants: active | deleted only. A failed create now rolls back instead
-- of leaving an 'error' row; mirror progress lives in the outbox.
UPDATE tenants SET status = 'active' WHERE status = 'provisioning';
UPDATE tenants
  SET status = 'deleted', deleted_at = COALESCE(deleted_at, now())
  WHERE status IN ('error', 'deleting');
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('active', 'deleted'));
ALTER TABLE tenants ALTER COLUMN status SET DEFAULT 'active';

-- agents: no 'error' (a failed issuance rolls back).
UPDATE agents
  SET status = 'revoked', revoked_at = COALESCE(revoked_at, now())
  WHERE status = 'error';
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_status_check;
ALTER TABLE agents ADD CONSTRAINT agents_status_check
  CHECK (status IN ('provisioning', 'active', 'disabled', 'revoked'));

-- outbox: one row per (target, aggregate) + lost-update guard (I-30).
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS target TEXT NOT NULL DEFAULT 'grafana';
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS requested_seq BIGINT NOT NULL DEFAULT 1;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS claimed_seq BIGINT;

ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_aggregate_type_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_aggregate_type_check
  CHECK (aggregate_type IN ('tenant', 'user', 'agent'));

ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_target_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_target_check
  CHECK (target IN ('keycloak', 'grafana'));

DROP INDEX IF EXISTS uq_outbox_pending_aggregate;
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_pending_target_aggregate
  ON outbox (target, aggregate_type, aggregate_id)
  WHERE processed_at IS NULL;

COMMIT;
