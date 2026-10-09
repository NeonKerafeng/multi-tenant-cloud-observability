BEGIN;

-- One Grafana org per tenant (decision D-01).
-- NULL until the tenant has been mirrored into Grafana
-- (set by the control-plane sync worker).
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS grafana_org_id BIGINT UNIQUE;

COMMIT;
