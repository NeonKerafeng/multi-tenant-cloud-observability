# control-plane-ui E2E

Headless browser tests of the web UI (`kubernetes/base/control/control-plane-ui/site`)
against `mock-server.js`, which mimics:

- nginx (static files + the same security headers as `nginx.conf`),
- control-plane `/api/v1` (routes, roles, validation errors of v0.9),
- Keycloak OIDC (authorization code + PKCE S256 checked, refresh, logout).

Flows: platform admin (tenants, users, enrollments, agents, support access,
sync, dark mode, delete tenant, sign out), mobile layout, tenant admin,
viewer, blocked accounts (not registered / disabled), deep link after
login, token refresh. Any console error or CSP violation fails the run.

```bash
npm install --no-save playwright@1.56.0   # once, anywhere on NODE_PATH
npx playwright install chromium            # once
bash testing/control-plane-ui/run.sh       # ONLY=tenantAdminFlow for one flow
```

Screenshots land in `testing/control-plane-ui/shots/` (gitignored).
