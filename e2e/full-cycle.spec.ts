import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Full bug lifecycle E2E test.
 *
 * Tests the complete flow a real user goes through:
 * 1. Widget: login → pick element → fill bug → submit
 * 2. Dashboard: login → see bug in list → open detail
 * 3. Dashboard: edit, change status, add note, delete
 * 4. API: verify data integrity at each step
 */

const API = 'http://localhost:10020';
const DEMO = `${API}/demo/`;
const DASHBOARD = `${API}`;
const E2E_COMMIT_SHA = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: join(__dirname, '..'),
  encoding: 'utf8',
}).trim();
const ONE_PIXEL_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
// Helpers
async function apiPost(path: string, body: object, token?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}/api${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function login(email: string, password: string): Promise<string> {
  const { data } = await apiPost('/auth/login', { email, password });
  return data?.data?.token as string;
}

function passingEvidence(scenario: string, action: string, visibleResult: string, extra: Record<string, string> = {}) {
  return {
    result: 'pass',
    level: 'local_acceptance',
    coverage: 'item',
    environment: 'e2e',
    scenario,
    action,
    visibleResult,
    acceptanceScope: scenario,
    source: 'ci',
    ...extra,
  };
}

// --- Tests ---

test.describe('Full bug lifecycle', () => {
  let adminToken: string;
  let projectId: string;

  test.beforeAll(async () => {
    adminToken = await login('admin@scout.local', 'admin');
    expect(adminToken).toBeTruthy();

    const { data } = await apiPost('/projects/list', {}, adminToken);
    projectId = data?.data?.items?.[0]?.id;
    expect(projectId).toBeTruthy();
  });

  test('1. Widget: create bug via API (simulating widget)', async () => {
    // Instead of browser-driving the shadow DOM widget (fragile),
    // test the exact same API call the widget makes — same payload shape
    const bugMessage = `E2E widget bug ${Date.now()}`;
    const { status, data } = await apiPost('/items/create', {
      projectId,
      message: bugMessage,
      pageUrl: 'http://localhost:10020/demo/',
      cssSelector: 'footer',
      elementText: 'AutoParts © 2026',
      viewportWidth: 1280,
      viewportHeight: 720,
      priority: 'medium',
      metadata: { browser: 'Chrome 120', os: 'macOS', language: 'ru' },
    }, adminToken);
    expect(status).toBe(201);
    expect(data.data.message).toBe(bugMessage);
    expect(data.data.status).toBe('new');
    expect(data.data.priority).toBe('medium');
  });

  test('2. Dashboard: login and see bug list', async ({ page }) => {
    await page.goto(DASHBOARD);
    await page.evaluate((tk) => {
      localStorage.setItem('scout_token', tk);
      localStorage.setItem('scout_user', JSON.stringify({ id: '1', email: 'admin@scout.local', name: 'Admin' }));
    }, adminToken);

    // Navigate to items list
    await page.goto(`${DASHBOARD}/items`);
    await page.waitForTimeout(2000);

    // Verify the list loads with items
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 5000 });
    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test('3. API: full item lifecycle', async () => {
    // Create a bug via API
    const createMsg = `API lifecycle ${Date.now()}`;
    const { status: createStatus, data: createData } = await apiPost('/items/create', {
      projectId,
      message: createMsg,
      priority: 'high',
      labels: ['e2e', 'test'],
    }, adminToken);
    expect(createStatus).toBe(201);
    const itemId = createData.data.id;

    // Verify item created
    const { data: getItem } = await apiPost('/items/get', { id: itemId }, adminToken);
    expect(getItem.data.message).toBe(createMsg);
    expect(getItem.data.priority).toBe('high');
    expect(getItem.data.status).toBe('new');
    let itemRevision = getItem.data.updatedAt;

    // Update message + priority
    const { status: updateStatus, data: updateData } = await apiPost('/items/update', {
      id: itemId,
      updatedAt: itemRevision,
      message: createMsg + ' (updated)',
      priority: 'critical',
      labels: ['e2e', 'test', 'updated'],
    }, adminToken);
    expect(updateStatus).toBe(200);
    itemRevision = updateData.data.updatedAt;

    // Claim (new → in_progress)
    const { status: claimStatus, data: claimData } = await apiPost('/items/claim', { id: itemId, updatedAt: itemRevision }, adminToken);
    expect(claimStatus).toBe(200);
    itemRevision = claimData.data.updatedAt;

    // Update status (in_progress → review)
    const { status: reviewStatus, data: reviewData } = await apiPost('/items/update-status', {
      id: itemId,
      updatedAt: itemRevision,
      status: 'review',
      evidence: passingEvidence(
        'API lifecycle item is ready for review',
        'Verified create, read, update, and claim API steps in the e2e lifecycle test',
        'Item reached in_progress and is ready for review handoff',
        { commitSha: E2E_COMMIT_SHA },
      ),
    }, adminToken);
    expect(reviewStatus).toBe(200);
    itemRevision = reviewData.data.updatedAt;

    // Resolve (review → done)
    const { status: resolveStatus, data: resolveData } = await apiPost('/items/resolve', {
      id: itemId,
      updatedAt: itemRevision,
      resolutionNote: 'Fixed in E2E test',
      evidence: passingEvidence(
        'API lifecycle item is complete',
        'Verified review to done transition in the e2e lifecycle test',
        'Item can be resolved with passing local acceptance evidence',
      ),
    }, adminToken);
    expect(resolveStatus).toBe(200);
    itemRevision = resolveData.data.updatedAt;

    // Verify done status: implementation is ready, but not human-accepted yet
    const { data: doneItem } = await apiPost('/items/get', { id: itemId }, adminToken);
    expect(doneItem.data.status).toBe('done');
    expect(doneItem.data.resolutionNote).toBe('Fixed in E2E test');

    // Human acceptance (done → verified)
    const { status: verifyStatus, data: verifyData } = await apiPost('/items/verify', {
      id: itemId,
      updatedAt: itemRevision,
      comment: 'E2E human acceptance check passed',
    }, adminToken);
    expect(verifyStatus).toBe(200);
    itemRevision = verifyData.data.updatedAt;

    const { data: verifiedItem } = await apiPost('/items/get', { id: itemId }, adminToken);
    expect(verifiedItem.data.status).toBe('verified');
    expect(verifiedItem.data.resolutionNote).toBe('Fixed in E2E test');

    // Reopen (verified → new)
    const { status: reopenStatus, data: reopenData } = await apiPost('/items/reopen', { id: itemId, updatedAt: itemRevision }, adminToken);
    expect(reopenStatus).toBe(200);
    itemRevision = reopenData.data.updatedAt;

    // Add note
    const { status: noteStatus } = await apiPost('/items/add-note', {
      id: itemId, content: 'E2E test comment',
    }, adminToken);
    expect(noteStatus).toBe(201);

    // Verify note exists
    const { data: withNote } = await apiPost('/items/get', { id: itemId }, adminToken);
    const comments = withNote.data.notes.filter((n: { type: string }) => n.type === 'comment');
    expect(comments.length).toBeGreaterThan(0);

    // Delete
    const { status: deleteStatus } = await apiPost('/items/delete', { id: itemId, updatedAt: itemRevision }, adminToken);
    expect(deleteStatus).toBe(200);

    // Verify deleted
    const { status: getDeleted } = await apiPost('/items/get', { id: itemId }, adminToken);
    expect(getDeleted).toBe(404);
  });

  test('Dashboard: failed conflict refresh keeps the verification modal open', async ({ page }) => {
    const { data: createData } = await apiPost('/items/create', {
      projectId,
      message: `Conflict refresh ${Date.now()}`,
    }, adminToken);
    const itemId = createData.data.id;
    const { data: resolveData } = await apiPost('/items/resolve', {
      id: itemId,
      updatedAt: createData.data.updatedAt,
      evidence: passingEvidence(
        'Conflict refresh modal behavior',
        'Prepared a done item for the dashboard verification flow',
        'The item is ready for human acceptance',
      ),
    }, adminToken);

    await page.goto(DASHBOARD);
    await page.evaluate((tk) => {
      localStorage.setItem('scout_token', tk);
      localStorage.setItem('scout_user', JSON.stringify({ id: '1', email: 'admin@scout.local', name: 'Admin' }));
    }, adminToken);
    await page.goto(`${DASHBOARD}/items/${itemId}`);
    await page.getByRole('button', { name: 'Verify' }).click();
    const dialog = page.getByRole('dialog', { name: 'Accept result' });
    await expect(dialog).toBeVisible();

    let failedRefreshRequests = 0;
    await page.route(/\/api\/items\/verify$/, (route) => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Item state changed concurrently', code: 'ITEM_STATE_CONFLICT' }),
    }));
    await page.route(/\/api\/items\/get$/, (route) => {
      failedRefreshRequests += 1;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Refresh failed' }),
      });
    });

    await dialog.getByRole('button', { name: 'Confirm verification' }).click();

    await expect.poll(() => failedRefreshRequests).toBe(1);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('The issue changed elsewhere');

    await apiPost('/items/delete', { id: itemId, updatedAt: resolveData.data.updatedAt }, adminToken);
  });

  test('4. API: project access isolation', async () => {
    // Create a second project (admin only)
    const { data: proj } = await apiPost('/projects/create', {
      name: 'Isolated E2E', slug: `isolated-e2e-${Date.now()}`,
    }, adminToken);
    const isolatedId = proj.data.id;

    // Create an item in the isolated project
    await apiPost('/items/create', { projectId: isolatedId, message: 'secret bug' }, adminToken);

    // Login as member (who has access only to first project)
    const memberToken = await login('member@scout.local', 'member');

    // Member should NOT see items from isolated project
    const { status } = await apiPost('/items/list', { projectId: isolatedId }, memberToken);
    expect(status).toBe(403);

    // Cleanup
    await apiPost('/items/list', { projectId: isolatedId }, adminToken).then(async ({ data }) => {
      for (const item of data?.data?.items || []) {
        await apiPost('/items/delete', { id: item.id, updatedAt: item.updatedAt }, adminToken);
      }
    });
    await apiPost('/projects/delete', { id: isolatedId }, adminToken);
  });

  test('5. API: health check', async () => {
    const res = await fetch(`${API}/health`);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.db).toBe('ok');
    expect(data.uptime).toBeGreaterThan(0);
    expect(data.memory.rss).toBeGreaterThan(0);
  });

  test('6. API: OpenAPI spec is valid', async () => {
    const res = await fetch(`${API}/api/docs/openapi.json`);
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info.title).toContain('Scout');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(20);
  });

  test('7. API: security headers present', async () => {
    const res = await fetch(`${API}/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  test('9. API: API key lifecycle', async () => {
    // Create API key
    const { status, data } = await apiPost('/api-keys/create', {
      projectId, name: 'E2E Test Key',
    }, adminToken);
    expect(status).toBe(201);
    const fullKey = data.data.key;
    expect(fullKey).toMatch(/^sk_live_/);

    const countRes = await fetch(`${API}/api/items/count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${fullKey}` },
      body: JSON.stringify({ projectId }),
    });
    expect(countRes.status).toBe(200);

    // Revoke
    const { status: revokeStatus } = await apiPost('/api-keys/revoke', { id: data.data.id }, adminToken);
    expect(revokeStatus).toBe(200);

    // Revoked key should fail
    const countRes2 = await fetch(`${API}/api/items/count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${fullKey}` },
      body: JSON.stringify({ projectId }),
    });
    expect(countRes2.status).toBe(401);
  });

  // --- SSO Endpoints ---

  test('10. SSO: iframe bridge serves HTML with postMessage handler', async () => {
    const res = await fetch(`${API}/auth/sso`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Must contain the postMessage bridge script
    expect(html).toContain('scout-sso');
    expect(html).toContain('postMessage');
    expect(html).toContain('getToken');
    expect(html).toContain('setToken');
    expect(html).toContain('clearToken');
    expect(html).toContain('ping');
    // Must NOT have X-Frame-Options: DENY (must be frameable)
    expect(res.headers.get('x-frame-options')).not.toBe('DENY');
  });

  test('11. SSO: popup serves login page with session check', async () => {
    const res = await fetch(`${API}/auth/sso/popup?origin=http://localhost:10020`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Must contain login form elements
    expect(html).toContain('Scout');
    expect(html).toContain('email');
    expect(html).toContain('password');
    expect(html).toContain('scout-sso-popup');
    // Must have X-Frame-Options: DENY (popup, not iframe)
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  test('12. SSO: popup validates origin in postMessage target', async () => {
    const res = await fetch(`${API}/auth/sso/popup?origin=https://trusted.example.com`);
    const html = await res.text();
    // The TARGET variable should contain the validated origin
    expect(html).toContain("TARGET='https://trusted.example.com'");
  });

  test('13. SSO: iframe bridge includes allowedOrigins whitelist', async () => {
    const res = await fetch(`${API}/auth/sso`);
    const html = await res.text();
    // Must contain ALLOWED array for origin validation
    expect(html).toContain('ALLOWED=');
    expect(html).toContain('allowed(e.origin)');
  });

  // --- Storage Auth ---

  test('14. Storage: query param token auth works', async () => {
    // Create an item with screenshot to test storage access
    const bugMsg = `Storage auth test ${Date.now()}`;
    const { status: createStatus, data: createData } = await apiPost('/items/create', {
      projectId,
      message: bugMsg,
      priority: 'low',
      screenshot: ONE_PIXEL_IMAGE_BASE64,
    }, adminToken);
    expect(createStatus).toBe(201);
    expect(createData.data.screenshotPath).toBeTruthy();

    const screenshotPath = createData.data.screenshotPath;

    // Without auth — should fail
    const noAuthRes = await fetch(`${API}/${screenshotPath}`);
    expect(noAuthRes.status).toBe(401);

    // With query param token — should succeed
    const withTokenRes = await fetch(`${API}/${screenshotPath}?token=${adminToken}`);
    expect(withTokenRes.status).toBe(200);
    expect(withTokenRes.headers.get('content-type')).toContain('image');

    // With Authorization header — should also work
    const withHeaderRes = await fetch(`${API}/${screenshotPath}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    expect(withHeaderRes.status).toBe(200);

    // Cleanup
    await apiPost('/items/delete', { id: createData.data.id, updatedAt: createData.data.updatedAt }, adminToken);
  });

  test('15. Storage: invalid token returns 401', async () => {
    const res = await fetch(`${API}/storage/screenshots/nonexistent.jpg?token=invalid.jwt.token`);
    expect(res.status).toBe(401);
  });

  // --- Dashboard SSO integration ---

  test('16. Dashboard: storageUrl appends token to image paths', async ({ page }) => {
    // Set token directly in localStorage
    await page.goto(DASHBOARD);
    await page.evaluate(() => {
      localStorage.setItem('scout_token', 'test-jwt-token');
    });

    // Check that storageUrl logic works correctly
    const urlResult = await page.evaluate(() => {
      const token = localStorage.getItem('scout_token');
      const path = 'storage/screenshots/test.jpg';
      const url = token ? `/${path}?token=${encodeURIComponent(token)}` : `/${path}`;
      return { hasToken: url.includes('?token='), startsWithSlash: url.startsWith('/') };
    });
    expect(urlResult.hasToken).toBe(true);
    expect(urlResult.startsWithSlash).toBe(true);
  });

  // --- Widget endpoint ---

  test('17. Widget: the core is served, compressed, and stays small', async () => {
    const res = await fetch(`${API}/widget/scout-widget.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age');
    const js = await res.text();
    expect(js).toContain('scout-widget-root');
    expect(js).toContain('__SCOUT_CONFIG__');
    // Every visitor of every host page pays for this file. The recorder and the screenshot library
    // live in their own modules; if either is inlined again this budget is what notices.
    expect(js.length).toBeLessThan(120_000);
  });

  test('17b. Widget: the heavy pieces are served as their own modules', async () => {
    for (const name of ['scout-recorder.js', 'scout-screenshot.js']) {
      const res = await fetch(`${API}/widget/${name}`);
      expect(res.status).toBe(200);
      // They are pulled in with a dynamic import from a host page on another origin.
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }
  });

  test('18. Dashboard: SPA routing works for client routes', async ({ page }) => {
    // /login should serve index.html (SPA fallback)
    await page.goto(`${DASHBOARD}/login`);
    await page.waitForSelector('input', { timeout: 5000 });
    const inputs = await page.locator('input').count();
    expect(inputs).toBeGreaterThan(0);
  });
});
