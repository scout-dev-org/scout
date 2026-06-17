import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { integrationsErrorsRoutes } from '../server/routes/integrations-errors.js';
import { enqueueBridgeJob, getBridgeStatus, processBridgeJobs } from '../server/services/error-groups.js';
import { createTestContext, type TestContext } from './helpers.js';
import { apiKeys, auditLog, errorGroupOccurrences, errorGroups, projects, scoutBridgeJobs, scoutItems } from '../server/db/schema.js';
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

  function bridge(body: Record<string, unknown>, secret?: string, useBearer = false) {
    return app.request('/api/integrations/errors/bridge/alertmanager', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? (useBearer ? { Authorization: `Bearer ${secret}` } : { 'x-scout-error-bridge-secret': secret }) : {}),
      },
      body: JSON.stringify(body),
    });
  }

  function bridgePayload(projectSlug = 'test-project', fingerprint = `bridge-${randomUUID()}`) {
    return {
      receiver: 'scout-error-bridge',
      status: 'firing',
      commonLabels: {
        project_slug: projectSlug,
        env: 'local',
        service: 'gateway',
        alertname: 'GatewayHigh5xxRate',
        severity: 'critical',
      },
      commonAnnotations: { summary: 'Gateway 5xx rate is high' },
      alerts: [{ status: 'firing', labels: {}, annotations: {}, startsAt: '2026-01-01T00:00:00.000Z', fingerprint }],
    };
  }

  const basePayload = {
    projectId: '',
    source: 'alertmanager',
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

  it('upsert creates error group and linked Scout item', async () => {
    const key = await createApiKey(['errors:write']);
    const res = await upsert({
      ...basePayload,
      projectId: ctx.projectId,
      samplePayload: {
        Authorization: 'redaction-test-value',
        url: 'https://example.test/path?token=redaction-url-secret',
        safe: 'value',
      },
    }, key);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.errorGroup.occurrenceCount).toBe(1);
    expect(body.data.errorGroup.linkedItemId).toBeTruthy();

    const item = ctx.db.select().from(scoutItems).where(eq(scoutItems.id, body.data.errorGroup.linkedItemId)).get();
    expect(item?.itemType).toBe('bug');
    expect(item?.labels).toContain('auto-created');
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

  it('does not reopen linked done item within regression cooldown', async () => {
    vi.stubEnv('SCOUT_ERROR_REGRESSION_COOLDOWN_MS', String(60 * 60 * 1000));
    const key = await createApiKey(['errors:write']);
    const first = await upsert({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-01-01T00:00:00.000Z' }, key);
    const firstBody = await first.json() as any;
    ctx.db.update(scoutItems).set({ status: 'done' }).where(eq(scoutItems.id, firstBody.data.errorGroup.linkedItemId)).run();

    await upsert({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-01-01T00:10:00.000Z' }, key);
    const item = ctx.db.select().from(scoutItems).where(eq(scoutItems.id, firstBody.data.errorGroup.linkedItemId)).get();
    expect(item?.status).toBe('done');
  });

  it('reopens linked verified item after regression cooldown', async () => {
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
    expect(item?.status).toBe('new');

    expect(events.some((event) => event.type === 'item.status_changed'
      && event.projectId === ctx.projectId
      && event.payload.oldStatus === 'verified'
      && event.payload.newStatus === 'new')).toBe(true);
    const audit = ctx.db.select().from(auditLog).where(eq(auditLog.entityId, firstBody.data.errorGroup.linkedItemId)).all();
    expect(audit.some((entry) => entry.action === 'reopen_item' && entry.details?.includes('regression'))).toBe(true);
  });

  it('reopens linked done item when release changes', async () => {
    vi.stubEnv('SCOUT_ERROR_REGRESSION_COOLDOWN_MS', String(60 * 60 * 1000));
    const key = await createApiKey(['errors:write']);
    const first = await upsert({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-01-01T00:00:00.000Z', release: 'release-a' }, key);
    const firstBody = await first.json() as any;
    ctx.db.update(scoutItems).set({ status: 'done' }).where(eq(scoutItems.id, firstBody.data.errorGroup.linkedItemId)).run();

    await upsert({ ...basePayload, projectId: ctx.projectId, occurredAt: '2026-01-01T00:10:00.000Z', release: 'release-b' }, key);
    const item = ctx.db.select().from(scoutItems).where(eq(scoutItems.id, firstBody.data.errorGroup.linkedItemId)).get();
    expect(item?.status).toBe('new');
  });

  it('does not reopen ignored linked item', async () => {
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
    expect(item?.status).toBe('done');
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

  it('rejects bridge webhook when secret is not configured', async () => {
    vi.stubEnv('SCOUT_ERROR_BRIDGE_SECRET', '');
    const res = await bridge(bridgePayload());
    expect(res.status).toBe(503);
  });

  it('rejects bridge webhook with missing secret', async () => {
    vi.stubEnv('SCOUT_ERROR_BRIDGE_SECRET', 'bridge-test-value');
    const res = await bridge(bridgePayload());
    expect(res.status).toBe(401);
  });

  it('rejects bridge webhook with invalid secret', async () => {
    vi.stubEnv('SCOUT_ERROR_BRIDGE_SECRET', 'bridge-test-value');
    const res = await bridge(bridgePayload(), 'wrong-test-value');
    expect(res.status).toBe(401);
  });

  it('accepts bridge webhook with valid secret', async () => {
    vi.stubEnv('SCOUT_ERROR_BRIDGE_SECRET', 'bridge-test-value');
    const res = await bridge(bridgePayload('test-project', 'bridge-valid-header'), 'bridge-test-value');
    expect(res.status).toBe(202);
  });

  it('accepts bridge webhook with bearer secret', async () => {
    vi.stubEnv('SCOUT_ERROR_BRIDGE_SECRET', 'bridge-test-value');
    const res = await bridge(bridgePayload('test-project', 'bridge-valid-bearer'), 'bridge-test-value', true);
    expect(res.status).toBe(202);
  });

  it('maps Alertmanager Prometheus generator URL to public Grafana Explore URL', async () => {
    vi.stubEnv('SCOUT_ERROR_BRIDGE_SECRET', 'bridge-test-value');
    vi.stubEnv('SCOUT_GRAFANA_URL', 'https://grafana.example.test');
    const payload = bridgePayload('test-project', 'bridge-grafana-url');
    payload.alerts[0]!.generatorURL = 'http://prometheus:9090/graph?g0.expr=sum+by+%28env%2C+service%29+%28rate%28gateway_requests_total%7Bstatus_class%3D%225xx%22%7D%5B5m%5D%29%29&g0.tab=1';

    const res = await bridge(payload, 'bridge-test-value');
    expect(res.status).toBe(202);

    const group = ctx.db.select().from(errorGroups).get()!;
    expect(group.grafanaLogsUrl).toContain('https://grafana.example.test/explore?');
    expect(group.grafanaLogsUrl).not.toContain('prometheus:9090');
    const left = JSON.parse(new URL(group.grafanaLogsUrl!).searchParams.get('left')!);
    expect(left.queries[0].expr).toContain('gateway_requests_total');
    const item = ctx.db.select().from(scoutItems).where(eq(scoutItems.id, group.linkedItemId!)).get()!;
    expect(item.message).toContain('https://grafana.example.test/explore?');
    expect(item.message).not.toContain('prometheus:9090');
  });

  it('stores Alertmanager troubleshooting labels when provided', async () => {
    vi.stubEnv('SCOUT_ERROR_BRIDGE_SECRET', 'bridge-test-value');
    const payload = bridgePayload('test-project', 'bridge-troubleshooting-labels');
    payload.alerts[0]!.labels = {
      route_template: '/api/orders/:id',
      method: 'GET',
      upstream_service: 'billing',
      error_type: 'GatewayUpstream5xx',
      status_code: '502',
      status_class: '5xx',
      request_id: 'req-bridge-test',
      trace_id: 'trace-bridge-test',
    };
    payload.alerts[0]!.annotations = {
      grafana_trace_url: 'https://grafana.example.test/explore?trace=test',
    };

    const res = await bridge(payload, 'bridge-test-value');
    expect(res.status).toBe(202);

    const group = ctx.db.select().from(errorGroups).get()!;
    expect(group.routeTemplate).toBe('/api/orders/:id');
    expect(group.method).toBe('GET');
    expect(group.upstreamService).toBe('billing');
    expect(group.errorType).toBe('GatewayUpstream5xx');
    expect(group.statusCode).toBe(502);
    expect(group.statusClass).toBe('5xx');
    expect(group.sampleRequestId).toBe('req-bridge-test');
    expect(group.sampleTraceId).toBe('trace-bridge-test');
    expect(group.grafanaTraceUrl).toBe('https://grafana.example.test/explore?trace=test');
  });

  it('enriches Alertmanager bridge events with matching Tempo trace diagnostics', async () => {
    vi.stubEnv('SCOUT_ERROR_BRIDGE_SECRET', 'bridge-test-value');
    vi.stubEnv('SCOUT_TEMPO_URL', 'http://tempo.test');
    vi.stubEnv('SCOUT_GRAFANA_URL', 'https://grafana.example.test');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl);
      if (url.pathname === '/api/search') {
        expect(url.searchParams.get('tags')).toContain('http.status_code=500');
        expect(url.searchParams.get('tags')).toContain('http.target=/api/orders/42');
        return new Response(JSON.stringify({
          traces: [{ traceID: 'tempo-trace-test', rootServiceName: 'gateway', rootTraceName: 'POST *', startTimeUnixNano: '1767225600000000000', durationMs: 42 }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/api/traces/tempo-trace-test') {
        return new Response(JSON.stringify({
          batches: [{
            resource: { attributes: [{ key: 'service.name', value: { stringValue: 'gateway' } }] },
            scopeSpans: [{
              spans: [{
                name: 'POST *',
                kind: 'SPAN_KIND_SERVER',
                status: { code: 'STATUS_CODE_ERROR' },
                attributes: [
                  { key: 'http.method', value: { stringValue: 'POST' } },
                  { key: 'http.target', value: { stringValue: '/api/orders/42' } },
                  { key: 'http.status_code', value: { intValue: '500' } },
                  { key: 'exception.message', value: { stringValue: 'upstream failed' } },
                ],
              }],
            }],
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected URL: ${rawUrl}`);
    });
    const payload = bridgePayload('test-project', 'bridge-tempo-enrichment');
    payload.alerts[0]!.labels = {
      route_template: '^/api/orders/42$',
      method: 'POST',
      upstream_service: 'billing',
      error_type: 'upstream_5xx',
      status_class: '5xx',
    };

    const res = await bridge(payload, 'bridge-test-value');
    expect(res.status).toBe(202);

    const group = ctx.db.select().from(errorGroups).get()!;
    expect(group.sampleTraceId).toBe('tempo-trace-test');
    expect(group.grafanaTraceUrl).toContain('https://grafana.example.test/explore?');
    expect(group.samplePayload).toContain('upstream failed');
    const item = ctx.db.select().from(scoutItems).where(eq(scoutItems.id, group.linkedItemId!)).get()!;
    expect(item.message).toContain('Trace ID: tempo-trace-test');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not create active error groups from resolved bridge alerts', async () => {
    vi.stubEnv('SCOUT_ERROR_BRIDGE_SECRET', 'bridge-test-value');
    const payload = bridgePayload('test-project', 'bridge-resolved-only');
    payload.status = 'resolved';
    payload.alerts[0]!.status = 'resolved';

    const res = await bridge(payload, 'bridge-test-value');

    expect(res.status).toBe(202);
    expect(ctx.db.select().from(errorGroups).all()).toHaveLength(0);
    expect(ctx.db.select().from(scoutItems).all()).toHaveLength(0);
  });

  it('does not print bridge secret in logs', async () => {
    const secret = 'bridge-test-value-not-for-logs';
    const output: string[] = [];
    (vi.spyOn(process.stdout, 'write') as any).mockImplementation((chunk: unknown) => { output.push(String(chunk)); return true; });
    (vi.spyOn(process.stderr, 'write') as any).mockImplementation((chunk: unknown) => { output.push(String(chunk)); return true; });
    vi.stubEnv('SCOUT_ERROR_BRIDGE_SECRET', secret);

    await bridge(bridgePayload('test-project', 'bridge-no-log-secret'), secret);

    expect(output.join('\n')).not.toContain(secret);
  });

  it('keeps failed bridge jobs pending with nextAttemptAt', async () => {
    vi.stubEnv('SCOUT_ERROR_BRIDGE_BACKOFF_BASE_MS', '1000');
    const currentTime = '2026-01-01T00:00:00.000Z';
    const job = enqueueBridgeJob(bridgePayload('missing-project', 'bridge-fail-pending'));
    ctx.db.update(scoutBridgeJobs).set({ nextAttemptAt: currentTime }).where(eq(scoutBridgeJobs.id, job.id)).run();

    const result = await processBridgeJobs(10, currentTime);

    const row = ctx.db.select().from(scoutBridgeJobs).where(eq(scoutBridgeJobs.id, job.id)).get()!;
    expect(result.failed).toBe(1);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(Date.parse(row.nextAttemptAt)).toBeGreaterThan(Date.parse(currentTime));
  });

  it('moves bridge jobs to dead after max attempts', async () => {
    vi.stubEnv('SCOUT_ERROR_BRIDGE_MAX_ATTEMPTS', '2');
    const job = enqueueBridgeJob(bridgePayload('missing-project', 'bridge-dead'));
    ctx.db.update(scoutBridgeJobs).set({ attempts: 1, nextAttemptAt: '2026-01-01T00:00:00.000Z' }).where(eq(scoutBridgeJobs.id, job.id)).run();

    const result = await processBridgeJobs(10, '2026-01-01T00:00:00.000Z');

    const row = ctx.db.select().from(scoutBridgeJobs).where(eq(scoutBridgeJobs.id, job.id)).get()!;
    expect(result.dead).toBe(1);
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(2);
  });

  it('delivers bridge job on successful retry', async () => {
    const job = enqueueBridgeJob(bridgePayload('missing-project', 'bridge-retry-success'));
    ctx.db.update(scoutBridgeJobs).set({ nextAttemptAt: '2026-01-01T00:00:00.000Z' }).where(eq(scoutBridgeJobs.id, job.id)).run();
    await processBridgeJobs(10, '2026-01-01T00:00:00.000Z');
    ctx.db.insert(projects).values({ id: randomUUID(), name: 'Missing Project', slug: 'missing-project', allowedOrigins: '[]' }).run();
    ctx.db.update(scoutBridgeJobs).set({ nextAttemptAt: '2026-01-01T00:00:00.000Z' }).where(eq(scoutBridgeJobs.id, job.id)).run();

    const result = await processBridgeJobs(10, '2026-01-01T00:00:00.000Z');

    const row = ctx.db.select().from(scoutBridgeJobs).where(eq(scoutBridgeJobs.id, job.id)).get()!;
    expect(result.processed).toBe(1);
    expect(row.status).toBe('delivered');
  });

  it('bridge health exposes queue counts', async () => {
    const pending = enqueueBridgeJob(bridgePayload('missing-project-a', 'bridge-health-pending'));
    const dead = enqueueBridgeJob(bridgePayload('missing-project-b', 'bridge-health-dead'));
    ctx.db.update(scoutBridgeJobs).set({ status: 'dead' }).where(eq(scoutBridgeJobs.id, dead.id)).run();
    ctx.db.update(scoutBridgeJobs).set({ nextAttemptAt: '2026-01-01T00:00:00.000Z' }).where(eq(scoutBridgeJobs.id, pending.id)).run();

    const res = await app.request('/api/integrations/errors/bridge/health');
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.data.queue.pending).toBe(1);
    expect(body.data.queue.dead).toBe(1);
    expect(getBridgeStatus('2026-01-01T00:00:00.000Z').pendingDue).toBe(1);
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
