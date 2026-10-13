// Full E2E of the control-plane UI against mock-server.js (see README.md).
const { chromium } = require('playwright');
const assert = require('assert');

const BASE = 'http://localhost:9100';
const E = process.env.OUT || __dirname;
const ONLY = process.env.ONLY;
const problems = [];
let step = '';

async function newPage(browser, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('console', (m) => {
    const text = m.text();
    if ((m.type() === 'error' || m.type() === 'warning') && !text.startsWith('Failed to load resource')) {
      problems.push(`[${step}] console ${m.type()}: ${text}`);
    }
  });
  page.on('pageerror', (e) => problems.push(`[${step}] pageerror: ${e.message}`));
  return page;
}

async function login(page, user, path = '/') {
  await page.goto(BASE + path);
  await page.click('#sign-in');
  await page.click(`#login-${user}`);
}

const shot = (page, name, fullPage = false) => page.screenshot({ path: `${E}/shots/${name}.png`, fullPage });
const modal = (page) => page.locator('.modal');
const toastText = (page) => page.locator('.toast').last().innerText();
const row = (page, text) => page.locator('tbody tr', { hasText: text });

async function platformFlow(browser) {
  const page = await newPage(browser);

  step = 'login dat';
  await login(page, 'dat');
  await page.waitForSelector('.kpis');
  assert.equal(await page.locator('.kpi', { hasText: 'Tenants' }).locator('.kpi-value').innerText(), '2');
  await shot(page, '02-overview', true);

  step = 'tenants list';
  await page.click('a.nav-item:has-text("Tenants")');
  await page.waitForSelector('tbody tr[data-key="alpha-tenant"]');
  await shot(page, '03-tenants');

  step = 'create tenant invalid';
  await page.click('#new-tenant');
  await page.fill('input[name=tenantKey]', 'Bad_Key');
  await page.click('.modal-foot button:has-text("Create tenant")');
  assert.match(await page.locator('.field-error').first().innerText(), /lowercase/);
  await shot(page, '04-new-tenant-error');

  step = 'create tenant ok';
  await page.fill('input[name=tenantKey]', 'gamma-tenant');
  await page.keyboard.press('Enter');
  await page.waitForURL(/#\/tenants\/gamma-tenant$/);
  await page.waitForSelector('.page-meta');
  assert.match(await toastText(page), /Tenant created/);
  await page.waitForSelector('.steps');
  await shot(page, '05-tenant-overview', true);

  step = 'users empty + server validation';
  await page.click('a.tab:has-text("Users")');
  await page.waitForSelector('.empty');
  await page.click('#new-user');
  await page.fill('input[name=firstName]', 'Gamma');
  await page.fill('input[name=lastName]', 'Admin');
  await page.fill('input[name=username]', 'gamma-admin');
  await page.fill('input[name=email]', 'x@y');
  await page.click('button[title="Generate a strong password"]');
  assert.ok((await page.inputValue('input[name=password]')).length === 20);
  await page.selectOption('select[name=role]', 'tenant-admin');
  await page.click('.modal-foot button:has-text("Create user")');
  await page.waitForSelector('.field-error:has-text("email must be an email")');
  await shot(page, '06-new-user-server-error');

  step = 'users create';
  await page.fill('input[name=email]', 'gamma-admin@example.com');
  await page.click('.modal-foot button:has-text("Create user")');
  await page.waitForSelector('.modal h2:has-text("User created")');
  await shot(page, '07-user-created');
  await page.click('.modal-foot button:has-text("Done")');
  await row(page, 'gamma-admin').waitFor();

  step = 'users disable/enable/delete';
  await page.click('button[title="Disable gamma-admin"]');
  await page.click('.modal-foot button:has-text("Disable user")');
  await row(page, 'gamma-admin').locator('.tag:has-text("disabled")').waitFor();
  await page.click('button[title="Enable gamma-admin"]');
  await row(page, 'gamma-admin').locator('.tag:has-text("enabled")').waitFor();
  await row(page, 'gamma-admin').locator('td').first().click();
  await page.waitForSelector('.modal .details');
  await shot(page, '08-user-detail');
  await page.click('.modal-foot button:has-text("Delete")');
  await page.click('.modal-foot button:has-text("Delete user")');
  await page.waitForSelector('.empty');

  step = 'enrollments';
  await page.click('a.tab:has-text("Enrollments")');
  await page.waitForSelector('#new-enrollment');
  await page.click('#new-enrollment');
  await page.waitForSelector('#enrollment-token');
  assert.ok((await page.innerText('#enrollment-token')).length > 20);
  assert.match(await page.locator('.codeblock').innerText(), /sudo \.\/bootstrap\.sh http:\/\/172\.31\.16\.77:18081/);
  await page.waitForTimeout(1100);
  await shot(page, '09-token');
  await page.click('.modal-foot button:has-text("Done")');
  await page.waitForSelector('tbody .tag:has-text("pending")');
  await page.click('button[title="Revoke token"]');
  await page.click('.modal-foot button:has-text("Revoke token")');
  await page.waitForSelector('tbody .tag:has-text("revoked")');

  step = 'agents alpha';
  await page.goto(`${BASE}/#/tenants/alpha-tenant/agents`);
  await page.waitForSelector('tbody tr .tag');
  assert.equal(await page.locator('tbody tr').count(), 2);
  await shot(page, '10-agents');
  await page.click('button[title="Disable agent"]');
  await page.click('.modal-foot button:has-text("Disable agent")');
  await page.waitForFunction(() => document.querySelectorAll('tbody .tag-warn').length === 2);
  await page.locator('button[title="Enable agent"]').first().click();
  await page.waitForSelector('tbody .tag-ok');
  await page.locator('button[title="Revoke agent"]').first().click();
  await page.click('.modal-foot button:has-text("Revoke agent")');
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
  await page.selectOption('.table-toolbar select', 'all');
  assert.equal(await page.locator('tbody tr').count(), 3);

  step = 'support tab';
  await page.click('a.tab:has-text("Support access")');
  await page.waitForSelector('#grant-access');
  await shot(page, '11-support');
  await page.click('#grant-access');
  await page.fill('textarea[name=reason]', 'short');
  await page.click('.modal-foot button:has-text("Grant access")');
  await page.waitForSelector('.field-error:not(:empty)');
  await page.fill('textarea[name=reason]', 'TICKET-99 check alpha logs ingestion');
  await page.fill('input[name=minutes]', '30');
  await page.selectOption('select[name=role]', 'Editor');
  await shot(page, '12-grant-form');
  await page.click('.modal-foot button:has-text("Grant access")');
  await page.waitForSelector('tbody tr:has-text("TICKET-99")');
  assert.match(await toastText(page), /Support access granted/);
  await row(page, 'TICKET-99').locator('button[title="Revoke access"]').click();
  await page.click('.modal-foot button:has-text("Revoke access")');
  await row(page, 'TICKET-99').locator('.tag:has-text("revoked")').waitFor();

  step = 'users alpha';
  await page.click('a.tab:has-text("Users")');
  await page.waitForSelector('tbody tr:has-text("alpha-viewer")');
  await shot(page, '13-users');

  step = 'sync';
  await page.click('a.nav-item:has-text("Sync status")');
  await page.waitForSelector('.target');
  await shot(page, '14-sync', true);
  await page.click('#resync');
  await page.click('.modal-foot button:has-text("Resync")');
  await page.waitForSelector('.resync-result');
  await shot(page, '15-resync');

  step = 'support global';
  await page.click('a.nav-item:has-text("Support access")');
  await page.waitForSelector('tbody tr');
  await shot(page, '16-support-global');

  step = 'profile';
  await page.click('a.nav-item:has-text("Profile")');
  await page.waitForSelector('.profile');
  await shot(page, '17-profile');

  step = 'dark';
  await page.click('button[title="Toggle dark mode"]');
  await page.click('a.nav-item:has-text("Overview")');
  await page.waitForSelector('.kpis');
  await shot(page, '18-dark-overview');
  await page.goto(`${BASE}/#/tenants/alpha-tenant/enrollments`);
  await page.reload();
  await page.waitForSelector('tbody tr .tag');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await shot(page, '19-dark-enrollments');
  await page.click('button[title="Toggle dark mode"]');

  step = 'delete tenant';
  await page.goto(`${BASE}/#/tenants/gamma-tenant`);
  await page.click('#delete-tenant');
  const confirm = page.locator('.modal-foot button:has-text("Delete tenant")');
  assert.ok(await confirm.isDisabled());
  await page.fill('.modal input', 'gamma-tenan');
  assert.ok(await confirm.isDisabled());
  await page.fill('.modal input', 'gamma-tenant');
  await shot(page, '20-delete-tenant');
  await confirm.click();
  await page.waitForURL(/#\/tenants$/);
  await page.waitForSelector('tbody tr[data-key="alpha-tenant"]');
  assert.equal(await page.locator('tbody tr[data-key="gamma-tenant"]').count(), 0);

  step = 'not found + sign out';
  await page.goto(`${BASE}/#/nope`);
  await page.waitForSelector('.empty:has-text("Page not found")');
  await page.click('#user-menu');
  await shot(page, '21-user-menu');
  await page.click('#sign-out');
  await page.waitForSelector('#sign-in');
  await page.context().close();
}

async function mobileFlow(browser) {
  const page = await newPage(browser, { width: 390, height: 844 });
  step = 'mobile';
  await login(page, 'dat');
  await page.waitForSelector('.kpis');
  await shot(page, 'm1-overview', true);
  await page.click('.nav-toggle');
  await page.waitForTimeout(300);
  await shot(page, 'm2-nav');
  await page.click('a.nav-item:has-text("Tenants")');
  await page.goto(`${BASE}/#/tenants/alpha-tenant/users`);
  await page.waitForSelector('tbody tr:has-text("alpha-viewer")');
  await page.waitForTimeout(400);
  await shot(page, 'm3-users', true);
  await page.click('#new-user');
  await page.waitForTimeout(400);
  await shot(page, 'm4-new-user');
  await page.context().close();
  const login2 = await newPage(browser, { width: 390, height: 844 });
  await login2.goto(BASE);
  await login2.waitForSelector('#sign-in');
  await shot(login2, 'm5-login');
  await login2.context().close();
}

async function tenantAdminFlow(browser) {
  const page = await newPage(browser);
  step = 'tenant admin';
  await login(page, 'alpha-admin');
  await page.waitForURL(/#\/tenants\/alpha-tenant$/);
  await page.waitForSelector('.steps');
  await shot(page, 'ta1-overview', true);
  await page.click('a.nav-item:has-text("Users")');
  await page.waitForSelector('tbody tr:has-text("alpha-admin") .locked');
  assert.ok(await page.locator('button[title="Delete alpha-viewer"]').isVisible());
  await page.click('#new-user');
  assert.ok(await page.locator('select[name=role]').isDisabled());
  await shot(page, 'ta2-new-user');
  await page.click('.modal-foot button:has-text("Cancel")');
  await page.click('a.nav-item:has-text("Support access")');
  await page.waitForSelector('tbody tr');
  assert.equal(await page.locator('#grant-access').count(), 0);
  assert.equal(await page.locator('button[title="Revoke access"]').count(), 0);
  await shot(page, 'ta3-support');
  await page.goto(`${BASE}/#/tenants`);
  await page.waitForSelector('.empty:has-text("Not available")');
  await page.goto(`${BASE}/#/tenants/beta-tenant/users`);
  await page.waitForURL(/#\/tenants\/alpha-tenant$/);
  await page.context().close();
}

async function viewerAndBlocked(browser) {
  step = 'viewer';
  let page = await newPage(browser);
  await login(page, 'alpha-viewer');
  await page.waitForSelector('.hero:has-text("Welcome")');
  await shot(page, 'v1-viewer');
  await page.goto(`${BASE}/#/tenants/alpha-tenant`);
  await page.waitForSelector('.empty:has-text("Not available")');
  await page.context().close();

  step = 'blocked';
  page = await newPage(browser);
  await login(page, 'ghost');
  await page.waitForSelector('h2:has-text("Account not registered")');
  await shot(page, 'b1-not-registered');
  await page.context().close();
  page = await newPage(browser);
  await login(page, 'off-user');
  await page.waitForSelector('h2:has-text("Account disabled")');
  await page.context().close();
}

async function sessionFlow(browser) {
  step = 'deep link';
  let page = await newPage(browser);
  await login(page, 'dat', '/#/sync');
  await page.waitForSelector('.target');
  assert.match(page.url(), /#\/sync$/);
  await page.context().close();

  step = 'refresh';
  page = await newPage(browser);
  const before = (await (await fetch(`${BASE}/__log`)).json()).refresh;
  await login(page, 'shortlived');
  await page.waitForSelector('.kpis');
  await page.waitForTimeout(4000);
  await page.click('a.nav-item:has-text("Tenants")');
  await page.waitForSelector('#new-tenant');
  await page.waitForSelector('tbody tr[data-key="alpha-tenant"]');
  const after = (await (await fetch(`${BASE}/__log`)).json()).refresh;
  assert.ok(after > before, 'refresh grant used');
  await page.context().close();
}

(async () => {
  const browser = await chromium.launch();
  const flows = { platformFlow, mobileFlow, tenantAdminFlow, viewerAndBlocked, sessionFlow };
  let failed = false;
  for (const [name, fn] of Object.entries(flows)) {
    if (ONLY && ONLY !== name) continue;
    try {
      await fn(browser);
      console.log(`PASS ${name}`);
    } catch (e) {
      failed = true;
      console.log(`FAIL ${name} at [${step}]: ${e.message.split('\n').slice(0, 4).join(' | ')}`);
    }
  }
  await browser.close();
  console.log(problems.length ? problems.join('\n') : 'no console problems');
  process.exit(failed || problems.length ? 1 : 0);
})();
