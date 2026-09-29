BEGIN;

CREATE SEQUENCE IF NOT EXISTS vm_account_id_seq
  AS BIGINT
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  NO MAXVALUE
  CACHE 1
  NO CYCLE;

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_key TEXT NOT NULL UNIQUE,

  vm_account_id BIGINT NOT NULL UNIQUE
    DEFAULT nextval('vm_account_id_seq'),

  keycloak_group_id TEXT UNIQUE,

  status TEXT NOT NULL DEFAULT 'provisioning',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT tenants_key_format_check
    CHECK (
      tenant_key ~
      '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
    ),

  CONSTRAINT tenants_status_check
    CHECK (
      status IN (
        'provisioning',
        'active',
        'error',
        'deleting',
        'deleted'
      )
    )
);

CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY,

  tenant_id UUID NOT NULL
    REFERENCES tenants(id)
    ON DELETE RESTRICT,

  keycloak_client_id TEXT NOT NULL UNIQUE,

  keycloak_client_uuid TEXT UNIQUE,

  status TEXT NOT NULL DEFAULT 'provisioning',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,

  CONSTRAINT agents_status_check
    CHECK (
      status IN (
        'provisioning',
        'active',
        'disabled',
        'revoked',
        'error'
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_agents_tenant_id
  ON agents(tenant_id);

CREATE INDEX IF NOT EXISTS idx_agents_status
  ON agents(status);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenants_set_updated_at
  ON tenants;

CREATE TRIGGER tenants_set_updated_at
BEFORE UPDATE ON tenants
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS agents_set_updated_at
  ON agents;

CREATE TRIGGER agents_set_updated_at
BEFORE UPDATE ON agents
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

INSERT INTO tenants (
  tenant_key,
  vm_account_id,
  status
)
VALUES
  ('admin-tenant', 1, 'active'),
  ('test-tenant', 2, 'active')
ON CONFLICT (tenant_key) DO NOTHING;

SELECT setval(
  'vm_account_id_seq',
  GREATEST(
    COALESCE(
      (
        SELECT MAX(vm_account_id)
        FROM tenants
      ),
      0
    ) + 1,
    1
  ),
  false
);

COMMIT;
