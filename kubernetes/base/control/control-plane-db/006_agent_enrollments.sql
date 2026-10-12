-- TODO-23 v0.9: agent enrollments move from process memory to the DB
-- (I-05, I-22). One row per one-time token; the token itself is never
-- stored (sha256 hex only). The agent id is assigned at creation so a failed
-- exchange can be retried with the same token and lands on the same agent /
-- Keycloak client (no orphan).
BEGIN;

CREATE TABLE IF NOT EXISTS agent_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id UUID NOT NULL
    REFERENCES tenants(id)
    ON DELETE RESTRICT,

  token_hash TEXT NOT NULL UNIQUE,

  -- The agent this enrollment creates (agents.id once exchanged).
  agent_id UUID NOT NULL UNIQUE,

  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,

  used_at TIMESTAMPTZ,

  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES users(id),

  CONSTRAINT agent_enrollments_window_check
    CHECK (expires_at > created_at),

  CONSTRAINT agent_enrollments_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT agent_enrollments_revoked_check
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),

  CONSTRAINT agent_enrollments_used_or_revoked_check
    CHECK (used_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_agent_enrollments_tenant_created
  ON agent_enrollments (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_enrollments_open
  ON agent_enrollments (expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS enrollment_id UUID
    REFERENCES agent_enrollments(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_enrollment
  ON agents (enrollment_id)
  WHERE enrollment_id IS NOT NULL;

COMMIT;
