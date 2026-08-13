import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { integrationsErrorsRoutes } from '../server/routes/integrations-errors.js';
import { ignoreErrorGroup, resolveStaleErrorGroups, upsertErrorGroup } from '../server/services/error-groups.js';
import { createTestContext, type TestContext } from './helpers.js';
import { apiKeys, auditLog, errorGroupOccurrences, errorGroups, projects, scoutItems } from '../server/db/schema.js';
import { eventBus, type SSEEvent } from '../server/lib/event-bus.js';

vi.mock('../server/db/client.js', async () => {
  return { db: null, sqlite: { close: () => {} } };
});

describe('Error integrations routes', () => {
  let ctx: TestContext;
  let app: Hono;

  beforeEach(async () => {
    vi.unstubAllEnvs();
    ctx = createTestContext();
    const dbModule = await import('../server/db/client.js');
    (dbModule as any).db = ctx.db;

    app = new Hono();
    app.route('/api/integrations/errors', integrationsErrorsRoutes);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function createApiKey(scopes: string[]) {
    const rawKey = `sk_live_${randomBytes(16).toString('hex')}`;
    ctx.db.insert(apiKeys).values({
      id: randomUUID(),
      projectId: ctx.projectId,
      userId: ctx.adminId,
      name: 'Errors key',
      purpose: 'integration',
      scopes: JSON.stringify(scopes),
      keyHash: await bcrypt.hash(rawKey, 10),
      keyPrefix: rawKey.slice(0, 16),
    }).run();
    return rawKey;
  }

  function upsert(body: Record<string, unknown>, token: string) {
    return app.request('/api/integrations/errors/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  const basePayload = {
    projectId: '',
    source: 'runtime',
    fingerprint: 'gateway:local:test',
    environment: 'local',
    service: 'gateway',
    routeTemplate: '/health',
    method: 'POST',
    errorType: 'upstream_5xx',
    statusCode: 500,
    statusClass: '5xx',
    severity: 'critical',
    sampleRequestId: 'req-test',
    sampleTraceId: 'trace-test',
    samplePayload: { Authorization: 'redaction-test-value', safe: 'value' },
  };

  it('upsert creates error group and auto-accepted linked Scout item', async () => {
    const key = await createApiKey(['errors:write']);
    const events: SSEEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => events.push(event));
    const res = await upsert({
      ...basePayload,
      projectId: ctx.projectId,
      samplePayload: {
        Authorization: 'redaction-test-value',
        url: 'https://example.test/path?token=redaction-url-secret',
        safe: 'value',
      },
    }, key);
    unsubscribe();

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.errorGroup.occurrenceCount).toBe(1);
    expect(body.data.errorGroup.linkedItemId).toBeTruthy();

    const item = ctx.db.select().from(scoutItems).where(eq(scoutItems.id, body.data.errorGroup.linkedItemId)).get();
    expect(item?.itemType).toBe('bug');
    expect(item?.status).toBe('verified');
    expect(item?.labels).toContain('auto-created');
    expect(item?.metadata).toContain('autoAccepted');
    expect(item?.resolutionNote).toContain('Auto-accepted system observability item');
    expect(item?.resolvedAt).toBeTruthy();
    expect(events.some((event) => event.type === 'item.created'
      && event.projectId === ctx.projectId
      && (event.payload.item as { status?: string } | undefined)?.status === 'verified')).toBe(true);
    const audit = ctx.db.select().from(auditLog).where(eq(auditLog.entityId, item!.id)).all();
    expect(audit.some((entry) => entry.action === 'create_item' && entry.details?.includes('autoAccepted'))).toBe(true);
    expect(body.data.errorGroup.samplePayload).not.toContain('redaction-test-value');
    expect(body.data.errorGroup.samplePayload).not.toContain('redaction-url-secret');
  });

  it('repeated upsert is idempotent and does not create duplicate item', async () => {
    const key = await createApiKey(['errors:write']);
    await upsert({ ...basePayload, projectId: ctx.projectId }, key);
    const res = await upsert({ ...basePayload, projectId: ctx.projectId, sampleRequestId: 'req-test-2' }, key);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.errorGroup.occurrenceCount).toBe(2);
    expect(ctx.db.select().from(errorGroups).all()).toHaveLength(1);
    expect(ctx.db.select().from(scoutItems).all()).toHaveLength(1);
    expect(ctx.db.select().from(scoutItems).get()?.status).toBe('verified');
  });

  it('concurrent create re-reads the group after acquiring the write lock', async () => {
    const key = await createApiKey(['errors:write']);
    const originalTransaction = ctx.db.transaction.bind(ctx.db);
    vi.spyOn(ctx.db, 'transaction').mockImplementationOnce(((callback: any, config: any) => {
      upsertErrorGroup({ ...basePayload, projectId: ctx.projectId, sampleRequestId: 'concurrent-winner' }, ctx.projectId);
      return originalTransaction(callback, config);
    }) as any);

    const res = await upsert({ ...basePayload, projectId: ctx.projectId, sampleRequestId: 'concurrent-follower' }, key);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.data.errorGroup.occurrenceCount).toBe(2);
    expect(ctx.db.select().from(errorGroups).all()).toHaveLength(1);
    expect(ctx.db.select().from(scoutItems).all()).toHaveLength(1);
  });

  it('concurrent upsert uses state and counters read inside the write transaction', async () => {
    const key = await createApiKey(['errors:write']);
    const first = await upsert({ ...basePayload, projectId: ctx.projectId }, key);
    const firstBody = await first.json() as any;
    const originalTransaction = ctx.db.transaction.bind(ctx.db);
    vi.spyOn(ctx.db, 'transaction').mockImplementationOnce(((callback: any, config: any) => {
      ctx.db.update(errorGroups).set({
        state: 'ignored',
        ignoredUntil: '2099-01-01T00:00:00.000Z',
        occurrenceCount: 7,
      }).where(eq(errorGroups.id, firstBody.data.errorGroup.id)).run();
      return originalTransaction(callback, config);
    }) as any);

    const res = await upsert({ ...basePayload, projectId: ctx.projectId, sampleRequestId: 'after-concurrent-update' }, key);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.data.errorGroup.state).toBe('ignored');
    expect(body.data.errorGroup.occurrenceCount).toBe(8);
  });

  it('ignored group updates counters without creating a new item', async () => {
    const key = await createApiKey(['errors:write', 'errors:triage']);
    const first = await upsert({ ...basePayload, projectId: ctx.projectId }, key);
    const firstBody = await first.json() as any;

    const ignore = await app.request('/api/integrations/errors/ignore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ id: firstBody.data.errorGroup.id, ignoreReason: 'maintenance' }),
    });
    expect(ignore.status).toBe(200);

    const repeat = await upsert({ ...basePayload, projectId: ctx.projectId }, key);
    const repeatBody = await repeat.json() as any;
    expect(repeatBody.data.errorGroup.state).toBe('ignored');
    expect(repeatBody.data.errorGroup.occurrenceCount).toBe(2);
    expect(ctx.db.select().from(scoutItems).all()).toHaveLength(1);
  });

  it('unignore returns group to active state', async () => {
    const key = await createApiKey(['errors:write', 'errors:triage']);
    const first = await upsert({ ...basePayload, projectId: ctx.projectId }, key);
    const firstBody = await first.json() as any;
    await app.request('/api/integrations/errors/ignore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ id: firstBody.data.errorGroup.id, ignoreReason: 'maintenance' }),
    });

    const res = await app.request('/api/integrations/errors/unignore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ id: firstBody.data.errorGroup.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.errorGroup.state).toBe('active');
  });

  it('rejects cross-project writes for project-scoped API keys', async () => {
    const key = await createApiKey(['errors:write']);
    const otherProjectId = randomUUID();
    ctx.db.insert(projects).values({ id: otherProjectId, name: 'Other Project', slug: 'other-project', allowedOrigins: '[]' }).run();

    const res = await upsert({ ...basePayload, projectId: otherProjectId, fingerprint: 'gateway:local:other-project' }, key);

    expect(res.status).toBe(403);
  });

  it('rejects projectSlug in public upsert payload', async () => {
    const key = await createApiKey(['errors:write']);
    const { projectId: _projectId, ...payload } = basePayload;

    const res = await upsert({ ...payload, projectSlug: 'test-project', fingerprint: 'gateway:local:test-project-slug' }, key);

    expect(res.status).toBe(400);
  });

  it('auto-accepts existing linked done item without opening the queue', async () => {
    vi.stubEnv('SCOUT_ERROR_REGRESSION_COOLDOWN_MS', String(60 * 60 * 1000));
    const key = await createApiKey(['errors:write']);
    const first = await upsert({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-01-01T00:00:00.000Z' }, key);
    const firstBody = await first.json() as any;
    ctx.db.update(scoutItems).set({ status: 'done' }).where(eq(scoutItems.id, firstBody.data.errorGroup.linkedItemId)).run();

    await upsert({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-01-01T00:10:00.000Z' }, key);
    const item = ctx.db.select().from(scoutItems).where(eq(scoutItems.id, firstBody.data.errorGroup.linkedItemId)).get();
    expect(item?.status).toBe('verified');
    const audit = ctx.db.select().from(auditLog).where(eq(auditLog.entityId, firstBody.data.errorGroup.linkedItemId)).all();
    expect(audit.some((entry) => entry.action === 'auto_accept_runtime_item')).toBe(true);
  });

  it('records regression without reopening linked verified item after cooldown', async () => {
    vi.stubEnv('SCOUT_ERROR_REGRESSION_COOLDOWN_MS', String(60 * 60 * 1000));
    const key = await createApiKey(['errors:write']);
    const first = await upsert({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-01-01T00:00:00.000Z' }, key);
    const firstBody = await first.json() as any;
    ctx.db.update(scoutItems).set({ status: 'verified' }).where(eq(scoutItems.id, firstBody.data.errorGroup.linkedItemId)).run();
    const events: SSEEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => events.push(event));

    await upsert({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-01-01T02:00:00.000Z' }, key);
    unsubscribe();
    const item = ctx.db.select().from(scoutItems).where(eq(scoutItems.id, firstBody.data.errorGroup.linkedItemId)).get();
    expect(item?.status).toBe('verified');
    const group = ctx.db.select().from(errorGroups).where(eq(errorGroups.id, firstBody.data.errorGroup.id)).get();
    expect(group?.lastRegressionAt).toBe('2026-01-01T02:00:00.000Z');

    expect(events.some((event) => event.type === 'item.status_changed'
      && event.projectId === ctx.projectId
      && event.payload.oldStatus === 'verified'
      && event.payload.newStatus === 'new')).toBe(false);
    const audit = ctx.db.select().from(auditLog).where(eq(auditLog.entityId, firstBody.data.errorGroup.linkedItemId)).all();
    expect(audit.some((entry) => entry.action === 'reopen_item')).toBe(false);
  });

  it('records release-change regression and auto-accepts existing linked done item', async () => {
    vi.stubEnv('SCOUT_ERROR_REGRESSION_COOLDOWN_MS', String(60 * 60 * 1000));
    const key = await createApiKey(['errors:write']);
    const first = await upsert({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-01-01T00:00:00.000Z', release: 'release-a' }, key);
    const firstBody = await first.json() as any;
    ctx.db.update(scoutItems).set({ status: 'done' }).where(eq(scoutItems.id, firstBody.data.errorGroup.linkedItemId)).run();

    await upsert({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-01-01T00:10:00.000Z', release: 'release-b' }, key);
    const item = ctx.db.select().from(scoutItems).where(eq(scoutItems.id, firstBody.data.errorGroup.linkedItemId)).get();
    expect(item?.status).toBe('verified');
    const group = ctx.db.select().from(errorGroups).where(eq(errorGroups.id, firstBody.data.errorGroup.id)).get();
    expect(group?.lastRegressionAt).toBe('2026-01-01T00:10:00.000Z');
  });

  it('auto-accepts ignored linked item without unignoring group', async () => {
    vi.stubEnv('SCOUT_ERROR_REGRESSION_COOLDOWN_MS', String(60 * 60 * 1000));
    const key = await createApiKey(['errors:write', 'errors:triage']);
    const first = await upsert({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-01-01T00:00:00.000Z' }, key);
    const firstBody = await first.json() as any;
    await app.request('/api/integrations/errors/ignore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ id: firstBody.data.errorGroup.id, ignoreReason: 'maintenance' }),
    });
    ctx.db.update(scoutItems).set({ status: 'done' }).where(eq(scoutItems.id, firstBody.data.errorGroup.linkedItemId)).run();

    await upsert({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-01-01T02:00:00.000Z' }, key);
    const item = ctx.db.select().from(scoutItems).where(eq(scoutItems.id, firstBody.data.errorGroup.linkedItemId)).get();
    expect(item?.status).toBe('verified');
    const group = ctx.db.select().from(errorGroups).where(eq(errorGroups.id, firstBody.data.errorGroup.id)).get();
    expect(group?.state).toBe('ignored');
  });

  it('caps stored occurrences per group', async () => {
    vi.stubEnv('SCOUT_ERROR_OCCURRENCES_LIMIT', '2');
    const key = await createApiKey(['errors:write']);

    for (let i = 0; i < 5; i++) {
      await upsert({ ...basePayload, projectId: ctx.projectId, occurredAt: `2026-01-01T00:0${i}:00.000Z`, sampleRequestId: `req-${i}` }, key);
    }

    const group = ctx.db.select().from(errorGroups).get()!;
    const occurrences = ctx.db.select().from(errorGroupOccurrences).where(eq(errorGroupOccurrences.errorGroupId, group.id)).all();
    expect(occurrences).toHaveLength(2);
    expect(occurrences.map((occurrence) => occurrence.requestId).sort()).toEqual(['req-3', 'req-4']);
  });

  it('resolves a group nothing has reported for longer than the window', async () => {
    vi.stubEnv('SCOUT_ERROR_AUTO_RESOLVE_DAYS', '7');
    upsertErrorGroup({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-01-01T00:00:00.000Z' }, ctx.projectId);

    const resolved = resolveStaleErrorGroups('2026-02-01T00:00:00.000Z');

    expect(resolved).toHaveLength(1);
    expect(ctx.db.select().from(errorGroups).get()!.state).toBe('resolved');
  });

  it('leaves recent and ignored groups untouched', async () => {
    vi.stubEnv('SCOUT_ERROR_AUTO_RESOLVE_DAYS', '7');
    upsertErrorGroup({ ...basePayload, projectId: ctx.projectId, fingerprint: 'recent', occurredAt: '2026-01-31T00:00:00.000Z' }, ctx.projectId);
    const stale = upsertErrorGroup({ ...basePayload, projectId: ctx.projectId, fingerprint: 'stale', occurredAt: '2026-01-01T00:00:00.000Z' }, ctx.projectId);
    ignoreErrorGroup(stale.id, 'known noise');

    expect(resolveStaleErrorGroups('2026-02-01T00:00:00.000Z')).toHaveLength(0);
    expect(ctx.db.select().from(errorGroups).where(eq(errorGroups.fingerprint, 'recent')).get()!.state).toBe('active');
    expect(ctx.db.select().from(errorGroups).where(eq(errorGroups.fingerprint, 'stale')).get()!.state).toBe('ignored');
  });

  it('returns a resolved group to active on recurrence and records the regression', async () => {
    vi.stubEnv('SCOUT_ERROR_AUTO_RESOLVE_DAYS', '7');
    upsertErrorGroup({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-01-01T00:00:00.000Z' }, ctx.projectId);
    resolveStaleErrorGroups('2026-02-01T00:00:00.000Z');

    upsertErrorGroup({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-02-01T00:00:00.000Z' }, ctx.projectId);

    const group = ctx.db.select().from(errorGroups).get()!;
    expect(group.state).toBe('active');
    expect(group.occurrenceCount).toBe(2);
    expect(group.lastRegressionAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('keeps every group when the auto-resolve window is zero', async () => {
    vi.stubEnv('SCOUT_ERROR_AUTO_RESOLVE_DAYS', '0');
    upsertErrorGroup({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-01-01T00:00:00.000Z' }, ctx.projectId);

    expect(resolveStaleErrorGroups('2026-02-01T00:00:00.000Z')).toHaveLength(0);
    expect(ctx.db.select().from(errorGroups).get()!.state).toBe('active');
  });

  it('requires errors:write scope', async () => {
    const key = await createApiKey(['items:create']);
    const res = await upsert({ ...basePayload, projectId: ctx.projectId }, key);
    expect(res.status).toBe(403);
  });

  it('rejects invalid payload', async () => {
    const key = await createApiKey(['errors:write']);
    const res = await upsert({ projectId: ctx.projectId }, key);
    expect(res.status).toBe(400);
  });
});
