import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { apiKeyRoutes } from '../server/routes/api-keys.js';
import { authRoutes } from '../server/routes/auth.js';
import { createTestContext, type TestContext } from './helpers.js';
import { randomUUID } from 'node:crypto';

// Mock the db module
vi.mock('../server/db/client.js', async () => {
  return { db: null, sqlite: { close: () => {} } };
});

describe('API Keys routes', () => {
  let ctx: TestContext;
  let app: Hono;

  beforeEach(async () => {
    ctx = createTestContext();
    const dbModule = await import('../server/db/client.js');
    (dbModule as any).db = ctx.db;

    app = new Hono();
    app.route('/api/api-keys', apiKeyRoutes);
    app.route('/api/auth', authRoutes);
  });

  function post(path: string, body: unknown, token: string) {
    return app.request(`/api/api-keys${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  async function createTestApiKey(token?: string) {
    const res = await post('/create', {
      projectId: ctx.projectId,
      name: 'Test Key',
    }, token || ctx.adminToken);
    const body = await res.json() as any;
    return body.data;
  }

  // === CREATE ===

  it('POST /create — admin can create API key', async () => {
    const res = await post('/create', {
      projectId: ctx.projectId,
      name: 'My CI Key',
      purpose: 'agent',
    }, ctx.adminToken);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.key).toBeDefined();
    expect(body.data.name).toBe('My CI Key');
    expect(body.data.purpose).toBe('agent');
    expect(body.data.scopes).toEqual(['items:read', 'items:comment', 'items:workflow', 'items:triage', 'storage:read']);
    expect(body.data.projectId).toBe(ctx.projectId);
    expect(body.data.id).toBeDefined();
  });

  it('POST /create — returned key starts with sk_live_', async () => {
    const data = await createTestApiKey();
    expect(data.key).toMatch(/^sk_live_[0-9a-f]{32}$/);
  });

  it('POST /create — non-admin cannot create (403)', async () => {
    const res = await post('/create', {
      projectId: ctx.projectId,
      name: 'Forbidden Key',
    }, ctx.memberToken);

    expect(res.status).toBe(403);
  });

  it('POST /create — developer member cannot create (403)', async () => {
    const res = await post('/create', {
      projectId: ctx.projectId,
      name: 'Developer Key',
    }, ctx.developerToken);

    expect(res.status).toBe(403);
  });

  it('POST /create — invalid project returns 404', async () => {
    const res = await post('/create', {
      projectId: randomUUID(),
      name: 'No Project Key',
    }, ctx.adminToken);

    expect(res.status).toBe(404);
  });

  // === LIST ===

  it('POST /list — admin can list keys (shows prefix, not full key)', async () => {
    const created = await createTestApiKey();
    const res = await post('/list', { projectId: ctx.projectId }, ctx.adminToken);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.items).toHaveLength(1);

    const key = body.data.items[0];
    expect(key.keyPrefix).toBe(created.keyPrefix);
    expect(key.name).toBe('Test Key');
    expect(key.purpose).toBe('custom');
    expect(key.scopes).toEqual(['items:read']);
    expect(key.userName).toBe('Test Admin');
    // Full key should NOT be present in list response
    expect(key.key).toBeUndefined();
    expect(key.keyHash).toBeUndefined();
  });

  it('POST /list — non-admin cannot list (403)', async () => {
    const res = await post('/list', { projectId: ctx.projectId }, ctx.memberToken);
    expect(res.status).toBe(403);
  });

  it('POST /list — empty project returns empty array', async () => {
    const res = await post('/list', { projectId: ctx.projectId }, ctx.adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.items).toHaveLength(0);
  });

  // === REVOKE ===

  it('POST /revoke — admin can revoke key', async () => {
    const created = await createTestApiKey();

    const res = await post('/revoke', { id: created.id }, ctx.adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.success).toBe(true);

    // Verify key shows as inactive in list
    const listRes = await post('/list', { projectId: ctx.projectId }, ctx.adminToken);
    const listBody = await listRes.json() as any;
    expect(listBody.data.items[0].isActive).toBe(false);
    expect(listBody.data.items[0].revokedAt).toBeTruthy();
  });

  it('POST /create — API key cannot create another API key', async () => {
    const created = await createTestApiKey();

    const res = await post('/create', {
      projectId: ctx.projectId,
      name: 'Nested Key',
    }, created.key);

    expect(res.status).toBe(403);
  });

  it('POST /revoke — non-admin cannot revoke (403)', async () => {
    const created = await createTestApiKey();

    const res = await post('/revoke', { id: created.id }, ctx.developerToken);
    expect(res.status).toBe(403);
  });

  it('POST /revoke — non-existent key returns 404', async () => {
    const res = await post('/revoke', { id: randomUUID() }, ctx.adminToken);
    expect(res.status).toBe(404);
  });

  // === API KEY AUTH FLOW ===

  it('created API key can be used as Bearer token to call /api/auth/me', async () => {
    const created = await createTestApiKey();

    const res = await app.request('/api/auth/me', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${created.key}`,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.user.id).toBe(ctx.adminId);
    expect(body.data.user.passwordHash).toBeUndefined();
  });

  it('purpose=agent API keys cannot mint a human JWT through /api/auth/refresh', async () => {
    const createRes = await post('/create', {
      projectId: ctx.projectId,
      name: 'Agent refresh guard',
      purpose: 'agent',
    }, ctx.adminToken);
    const created = await createRes.json() as any;

    const res = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.data.key}` },
    });

    expect(res.status).toBe(403);
  });

  it('custom API keys retain the existing /api/auth/refresh behavior', async () => {
    const created = await createTestApiKey();
    const res = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.key}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.token).toBeTypeOf('string');
  });

  it('revoked API key returns 401', async () => {
    const created = await createTestApiKey();

    // Revoke the key
    await post('/revoke', { id: created.id }, ctx.adminToken);

    // Try to use it
    const res = await app.request('/api/auth/me', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${created.key}`,
      },
    });

    expect(res.status).toBe(401);
  });

  // === Without auth ===

  it('all routes require authentication', async () => {
    const res = await app.request('/api/api-keys/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: ctx.projectId }),
    });
    expect(res.status).toBe(401);
  });
});
