BEGIN;

-- One Grafana org per tenant (decision D-01).
-- NULL until the tenant has been mirrored into Grafana
-- (tenant creation or POST /tenants/grafana/reconcile).
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS grafana_org_id BIGINT UNIQUE;

COMMIT;
