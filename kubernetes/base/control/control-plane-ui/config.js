// Runtime configuration of the control-plane UI (TODO-01).
//
// TODO-04 door: this file is the ONLY place the UI knows where Keycloak,
// Grafana and the host-facing control-plane URL are. It is mounted from the
// ConfigMap control-plane-ui-config (no rebuild; an overlay can replace it).
// The browser must reach keycloakUrl, and tokens from it must carry the
// issuer control-plane expects (today http://localhost:8080/realms/observability).
window.MTCO_CONFIG = {
  keycloakUrl: 'http://localhost:8080',
  realm: 'observability',
  clientId: 'control-plane-ui',
  apiBase: '/api/v1',
  grafanaUrl: 'http://localhost:3000',
  // Shown in the enrollment instructions (control-plane as seen by hosts).
  publicApiUrl: 'http://172.31.16.77:18081',
  // Optional label in the top bar; remove it to hide the chip.
  environment: 'development',
};
