import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { securityHeaders } from '../server/middleware/security-headers.js';
import { itemRoutes } from '../server/routes/items.js';
import { createTestContext, type TestContext } from './helpers.js';
import { randomUUID } from 'node:crypto';
import * as schema from '../server/db/schema.js';

// Mock the db module
vi.mock('../server/db/client.js', async () => {
  return { db: null, sqlite: { close: () => {} } };
});

describe('Middleware', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = createTestContext();
    const dbModule = await import('../server/db/client.js');
    (dbModule as any).db = ctx.db;
  });

  // === SECURITY HEADERS ===

  describe('Security headers', () => {
    let app: Hono;

    beforeEach(() => {
      app = new Hono();
      app.use('*', securityHeaders);
      app.get('/test', (c) => c.json({ ok: true }));
    });

    it('response includes X-Content-Type-Options: nosniff', async () => {
      const res = await app.request('/test');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('response includes X-Frame-Options: DENY', async () => {
      const res = await app.request('/test');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('response includes Referrer-Policy', async () => {
      const res = await app.request('/test');
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    });

    it('response includes Permissions-Policy', async () => {
      const res = await app.request('/test');
      expect(res.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
    });

    it('response includes X-XSS-Protection: 0', async () => {
      const res = await app.request('/test');
      expect(res.headers.get('X-XSS-Protection')).toBe('0');
    });
  });

  // === PROJECT ACCESS ISOLATION ===

  describe('Project access isolation', () => {
    let app: Hono;
    let otherProjectId: string;

    beforeEach(() => {
      app = new Hono();
      app.route('/api/items', itemRoutes);

      // Create a second project that project members do NOT have pivot access to
      otherProjectId = randomUUID();
      ctx.db.insert(schema.projects).values({
        id: otherProjectId,
        name: 'Other Project',
        slug: 'other-project',
        allowedOrigins: '[]',
      }).run();
      // Note: NO pivot_users_projects entries for project members → they should get 403
    });

    function post(path: string, body: unknown, token: string) {
      return app.request(`/api/items${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    }

    it('member can access items in their project (200)', async () => {
      const res = await post('/list', { projectId: ctx.projectId }, ctx.memberToken);
      expect(res.status).toBe(200);
    });

    it('member CANNOT access items in another project (403)', async () => {
      const res = await post('/list', { projectId: otherProjectId }, ctx.memberToken);
      expect(res.status).toBe(403);
    });

    it('member CANNOT use non-canonical projectSlug field (400)', async () => {
      const res = await post('/list', { projectSlug: 'other-project' }, ctx.memberToken);
      expect(res.status).toBe(400);
    });

    it('developer member can access items in their project (200)', async () => {
      const res = await post('/list', { projectId: ctx.projectId }, ctx.developerToken);
      expect(res.status).toBe(200);
    });

    it('developer member CANNOT access items in another project (403)', async () => {
      const res = await post('/list', { projectId: otherProjectId }, ctx.developerToken);
      expect(res.status).toBe(403);
    });

    it('admin CAN access any project (200)', async () => {
      const res = await post('/list', { projectId: otherProjectId }, ctx.adminToken);
      expect(res.status).toBe(200);
    });

    it('member CANNOT count items in another project (403)', async () => {
      const res = await post('/count', { projectId: otherProjectId }, ctx.memberToken);
      expect(res.status).toBe(403);
    });

    it('member CANNOT create items in another project (403)', async () => {
      const res = await post('/create', {
        projectId: otherProjectId,
        message: 'Should be forbidden',
      }, ctx.memberToken);
      expect(res.status).toBe(403);
    });

    it('developer member CANNOT claim item from another project (403)', async () => {
      // Admin creates item in other project
      const createRes = await post('/create', {
        projectId: otherProjectId,
        message: 'Item in other project',
      }, ctx.adminToken);
      const createBody = await createRes.json() as any;
      const itemId = createBody.data.id;

      // Developer member tries to claim it — should fail
      const res = await post('/claim', { id: itemId, updatedAt: createBody.data.updatedAt }, ctx.developerToken);
      expect(res.status).toBe(403);
    });
  });
});
