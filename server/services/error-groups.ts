import { and, count, desc, eq, inArray, lte } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { errorGroupOccurrences, errorGroups, projects, scoutBridgeJobs, scoutItems, scoutItemNotes, type ErrorGroup } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { eventBus } from '../lib/event-bus.js';
import { logAudit } from './audit.js';
import { dispatchWebhooks } from './webhooks.js';

type ItemStatusChange = {
  item: typeof scoutItems.$inferSelect;
  oldStatus: typeof scoutItems.$inferSelect.status;
  errorGroupId: string;
};

type ErrorUpsertInput = {
  projectId?: string;
  projectSlug?: string;
  source: string;
  fingerprint: string;
  environment: string;
  service: string;
  routeTemplate?: string;
  method?: string;
  upstreamService?: string;
  errorType: string;
  statusCode?: number;
  statusClass?: string;
  severity: 'info' | 'warning' | 'critical';
  occurredAt?: string;
  sampleRequestId?: string;
  sampleTraceId?: string;
  grafanaLogsUrl?: string;
  grafanaTraceUrl?: string;
  samplePayload?: Record<string, unknown>;
  title?: string;
  message?: string;
  release?: string;
  cooldownKey?: string;
};

const SECRET_KEY_PATTERN = /(authorization|cookie|token|password|secret|key|credential|jwt)/i;
const SECRET_VALUE_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+|((?:authorization|cookie|token|password|secret|key|credential|jwt)=)[^&\s,}]+/gi;
const MAX_SAMPLE_JSON_LENGTH = 5000;
const DEFAULT_OCCURRENCE_LIMIT = 100;
const DEFAULT_REGRESSION_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_BRIDGE_BATCH_SIZE = 20;
const DEFAULT_BRIDGE_INTERVAL_MS = 30_000;
const DEFAULT_BRIDGE_MAX_ATTEMPTS = 10;
const DEFAULT_BRIDGE_BACKOFF_BASE_MS = 30_000;
const DEFAULT_BRIDGE_BACKOFF_MAX_MS = 60 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

function getEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function stringifySample(value: Record<string, unknown> | undefined): string | null {
  if (!value) return null;
  const redacted = redact(value);
  const json = JSON.stringify(redacted);
  return json.length > MAX_SAMPLE_JSON_LENGTH ? json.slice(0, MAX_SAMPLE_JSON_LENGTH) : json;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 20).map(redact);
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      result[key] = '<redacted>';
      continue;
    }
    if (typeof item === 'string') {
      result[key] = item
        .replace(SECRET_VALUE_PATTERN, (_match, bearerPrefix: string | undefined, keyPrefix: string | undefined) => `${bearerPrefix ?? keyPrefix}<redacted>`)
        .slice(0, 1000);
      continue;
    }
    result[key] = redact(item);
  }
  return result;
}

function buildGrafanaExploreUrl(generatorUrl: unknown): string | undefined {
  if (typeof generatorUrl !== 'string' || generatorUrl.trim() === '') return undefined;
  const grafanaBase = process.env.SCOUT_GRAFANA_URL?.trim() || process.env.GRAFANA_PUBLIC_URL?.trim();
  if (!grafanaBase) return generatorUrl;

  try {
    const source = new URL(generatorUrl);
    const expr = source.searchParams.get('g0.expr');
    if (!expr) return generatorUrl;

    const target = new URL('/explore', grafanaBase.endsWith('/') ? grafanaBase : `${grafanaBase}/`);
    target.searchParams.set('orgId', '1');
    target.searchParams.set('left', JSON.stringify({
      datasource: 'Prometheus',
      queries: [{ refId: 'A', expr }],
      range: { from: 'now-1h', to: 'now' },
    }));
    return target.toString();
  } catch {
    return generatorUrl;
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function firstUrl(...values: unknown[]): string | undefined {
  const value = firstString(...values);
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parseStatusCode(value: unknown): number | undefined {
  const raw = firstString(value);
  if (!raw) return undefined;
  const statusCode = Number(raw);
  return Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : undefined;
}

export function resolveErrorProjectId(input: ErrorUpsertInput): string {
  if (input.projectId) {
    const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get();
    if (!project) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
    return project.id;
  }

  if (!input.projectSlug) throw new ValidationError('projectId or projectSlug is required', 'PROJECT_REQUIRED');
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.slug, input.projectSlug)).get();
  if (!project) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
  return project.id;
}

function buildItemMessage(input: ErrorUpsertInput): string {
  const title = input.title || `[${input.environment}][${input.service}] ${input.errorType}`;
  const lines = [
    title,
    '',
    input.message || 'Automatically created from observability alert/error ingestion.',
    '',
    `Fingerprint: ${input.fingerprint}`,
    `Environment: ${input.environment}`,
    `Service: ${input.service}`,
    `Error type: ${input.errorType}`,
  ];
  if (input.routeTemplate) lines.push(`Route: ${input.method || '*'} ${input.routeTemplate}`);
  if (input.upstreamService) lines.push(`Upstream: ${input.upstreamService}`);
  if (input.sampleRequestId) lines.push(`Request ID: ${input.sampleRequestId}`);
  if (input.sampleTraceId) lines.push(`Trace ID: ${input.sampleTraceId}`);
  if (input.grafanaLogsUrl) lines.push(`Grafana logs: ${input.grafanaLogsUrl}`);
  if (input.grafanaTraceUrl) lines.push(`Grafana trace: ${input.grafanaTraceUrl}`);
  return lines.join('\n');
}

function priorityForSeverity(severity: ErrorUpsertInput['severity']): 'critical' | 'high' | 'medium' | 'low' {
  if (severity === 'critical') return 'critical';
  if (severity === 'warning') return 'high';
  return 'medium';
}

export function upsertErrorGroup(input: ErrorUpsertInput, resolvedProjectId?: string): ErrorGroup {
  const projectId = resolvedProjectId ?? resolveErrorProjectId(input);
  const timestamp = input.occurredAt || now();
  const samplePayload = stringifySample(input.samplePayload);
  const existing = db.select().from(errorGroups)
    .where(and(eq(errorGroups.projectId, projectId), eq(errorGroups.environment, input.environment), eq(errorGroups.fingerprint, input.fingerprint)))
    .get();
  const reopenedItemStatusChanges: ItemStatusChange[] = [];

  const group = db.transaction((tx) => {
    if (!existing) {
      const itemId = randomUUID();
      tx.insert(scoutItems).values({
        id: itemId,
        projectId,
        itemType: 'bug',
        source: 'api',
        message: buildItemMessage(input),
        priority: priorityForSeverity(input.severity),
        labels: JSON.stringify(['gateway', 'observability', 'auto-created', `env:${input.environment}`, `service:${input.service}`, `error:${input.errorType}`]),
        metadata: JSON.stringify({ source: 'error_group', fingerprint: input.fingerprint }),
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();

      const groupId = randomUUID();
      tx.insert(errorGroups).values({
        id: groupId,
        projectId,
        source: input.source,
        fingerprint: input.fingerprint,
        environment: input.environment,
        service: input.service,
        routeTemplate: input.routeTemplate ?? null,
        method: input.method ?? null,
        upstreamService: input.upstreamService ?? null,
        errorType: input.errorType,
        statusCode: input.statusCode ?? null,
        statusClass: input.statusClass ?? null,
        severity: input.severity,
        state: 'active',
        occurrenceCount: 1,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        linkedItemId: itemId,
        sampleRequestId: input.sampleRequestId ?? null,
        sampleTraceId: input.sampleTraceId ?? null,
        grafanaLogsUrl: input.grafanaLogsUrl ?? null,
        grafanaTraceUrl: input.grafanaTraceUrl ?? null,
        samplePayload,
        lastRelease: input.release ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
      insertOccurrence(tx, groupId, input, timestamp, samplePayload);
      enforceOccurrenceLimit(tx, groupId);
      return tx.select().from(errorGroups).where(eq(errorGroups.id, groupId)).get()!;
    }

    const ignoredActive = existing.state === 'ignored' && (!existing.ignoredUntil || Date.parse(existing.ignoredUntil) > Date.now());
    const nextState = ignoredActive ? existing.state : 'active';
    const linkedItem = existing.linkedItemId
      ? tx.select().from(scoutItems).where(eq(scoutItems.id, existing.linkedItemId)).get() ?? null
      : null;
    const reopenAsRegression = shouldReopenRegression(existing, linkedItem, input, timestamp, ignoredActive);
    tx.update(errorGroups).set({
      source: input.source,
      service: input.service,
      routeTemplate: input.routeTemplate ?? existing.routeTemplate,
      method: input.method ?? existing.method,
      upstreamService: input.upstreamService ?? existing.upstreamService,
      errorType: input.errorType,
      occurrenceCount: existing.occurrenceCount + 1,
      lastSeenAt: timestamp,
      state: nextState,
      statusCode: input.statusCode ?? existing.statusCode,
      statusClass: input.statusClass ?? existing.statusClass,
      severity: input.severity,
      sampleRequestId: input.sampleRequestId ?? existing.sampleRequestId,
      sampleTraceId: input.sampleTraceId ?? existing.sampleTraceId,
      grafanaLogsUrl: input.grafanaLogsUrl ?? existing.grafanaLogsUrl,
      grafanaTraceUrl: input.grafanaTraceUrl ?? existing.grafanaTraceUrl,
      samplePayload: samplePayload ?? existing.samplePayload,
      lastRelease: input.release ?? existing.lastRelease,
      lastRegressionAt: reopenAsRegression ? timestamp : existing.lastRegressionAt,
      updatedAt: now(),
    }).where(eq(errorGroups.id, existing.id)).run();
    insertOccurrence(tx, existing.id, input, timestamp, samplePayload);
    enforceOccurrenceLimit(tx, existing.id);

    if (reopenAsRegression && linkedItem) {
      tx.update(scoutItems).set({
        status: 'new',
        assigneeId: null,
        resolvedById: null,
        resolvedAt: null,
        updatedAt: now(),
      }).where(eq(scoutItems.id, linkedItem.id)).run();
      tx.insert(scoutItemNotes).values({
        id: randomUUID(),
        itemId: linkedItem.id,
        content: JSON.stringify({ type: 'status_change', from: linkedItem.status, to: 'new', reason: 'regression', release: input.release ?? null }),
        type: 'status_change',
        createdAt: now(),
      }).run();
      reopenedItemStatusChanges.push({
        item: tx.select().from(scoutItems).where(eq(scoutItems.id, linkedItem.id)).get()!,
        oldStatus: linkedItem.status,
        errorGroupId: existing.id,
      });
    }

    return tx.select().from(errorGroups).where(eq(errorGroups.id, existing.id)).get()!;
  });

  for (const { item, oldStatus, errorGroupId } of reopenedItemStatusChanges) {
    logAudit({
      userId: null,
      action: 'reopen_item',
      entityType: 'item',
      entityId: item.id,
      details: { status: 'new', reason: 'regression', errorGroupId, release: input.release ?? null },
    });
    dispatchWebhooks(item.projectId, 'item.status_changed', { item, oldStatus, newStatus: 'new' }).catch(() => {});
    eventBus.publish({ type: 'item.status_changed', projectId: item.projectId, payload: { item, oldStatus, newStatus: 'new' } });
  }

  return group;
}

function shouldReopenRegression(
  existing: ErrorGroup,
  linkedItem: typeof scoutItems.$inferSelect | null,
  input: ErrorUpsertInput,
  occurredAt: string,
  ignoredActive: boolean,
): boolean {
  if (ignoredActive) return false;
  if (!linkedItem || (linkedItem.status !== 'done' && linkedItem.status !== 'verified' && linkedItem.status !== 'cancelled')) return false;

  if (input.release && existing.lastRelease && input.release !== existing.lastRelease) return true;

  const previousSeenAt = Date.parse(existing.lastSeenAt);
  const currentSeenAt = Date.parse(occurredAt);
  if (!Number.isFinite(previousSeenAt) || !Number.isFinite(currentSeenAt)) return false;

  return currentSeenAt - previousSeenAt >= getEnvInt('SCOUT_ERROR_REGRESSION_COOLDOWN_MS', DEFAULT_REGRESSION_COOLDOWN_MS, 1_000, 30 * 24 * 60 * 60 * 1000);
}

function insertOccurrence(tx: any, groupId: string, input: ErrorUpsertInput, occurredAt: string, samplePayload: string | null): void {
  tx.insert(errorGroupOccurrences).values({
    id: randomUUID(),
    errorGroupId: groupId,
    occurredAt,
    requestId: input.sampleRequestId ?? null,
    traceId: input.sampleTraceId ?? null,
    statusCode: input.statusCode ?? null,
    samplePayload,
    createdAt: now(),
  }).run();
}

function enforceOccurrenceLimit(tx: any, groupId: string): void {
  const limit = getEnvInt('SCOUT_ERROR_OCCURRENCES_LIMIT', DEFAULT_OCCURRENCE_LIMIT, 1, 10_000);
  const rows = tx.select({ id: errorGroupOccurrences.id })
    .from(errorGroupOccurrences)
    .where(eq(errorGroupOccurrences.errorGroupId, groupId))
    .orderBy(desc(errorGroupOccurrences.occurredAt), desc(errorGroupOccurrences.createdAt))
    .all() as Array<{ id: string }>;
  const staleIds = rows.slice(limit).map((row) => row.id);
  if (staleIds.length > 0) tx.delete(errorGroupOccurrences).where(inArray(errorGroupOccurrences.id, staleIds)).run();
}

export function listErrorGroups(params: { projectId: string; state?: string; service?: string; environment?: string; severity?: string; linkedItemId?: string; page: number; perPage: number }) {
  const conditions = [eq(errorGroups.projectId, params.projectId)];
  if (params.state) conditions.push(eq(errorGroups.state, params.state as ErrorGroup['state']));
  if (params.service) conditions.push(eq(errorGroups.service, params.service));
  if (params.environment) conditions.push(eq(errorGroups.environment, params.environment));
  if (params.severity) conditions.push(eq(errorGroups.severity, params.severity as ErrorGroup['severity']));
  if (params.linkedItemId) conditions.push(eq(errorGroups.linkedItemId, params.linkedItemId));
  const where = conditions.length === 1 ? conditions[0]! : and(...conditions);
  const rows = db.select({
    group: errorGroups,
    projectName: projects.name,
    linkedItemMessage: scoutItems.message,
  })
    .from(errorGroups)
    .leftJoin(projects, eq(errorGroups.projectId, projects.id))
    .leftJoin(scoutItems, eq(errorGroups.linkedItemId, scoutItems.id))
    .where(where)
    .orderBy(desc(errorGroups.lastSeenAt))
    .limit(params.perPage)
    .offset((params.page - 1) * params.perPage)
    .all();
  const items = rows.map((row) => ({ ...row.group, projectName: row.projectName, linkedItemMessage: row.linkedItemMessage }));
  const [{ total }] = db.select({ total: count() }).from(errorGroups).where(where).all();
  return { items, pagination: { page: params.page, perPage: params.perPage, total, totalPages: Math.ceil(total / params.perPage) } };
}

export function ignoreErrorGroup(id: string, ignoreReason: string, ignoredUntil?: string): ErrorGroup {
  const existing = db.select().from(errorGroups).where(eq(errorGroups.id, id)).get();
  if (!existing) throw new NotFoundError('Error group', 'ERROR_GROUP_NOT_FOUND');
  db.update(errorGroups).set({ state: 'ignored', ignoreReason, ignoredUntil: ignoredUntil ?? null, updatedAt: now() }).where(eq(errorGroups.id, id)).run();
  return db.select().from(errorGroups).where(eq(errorGroups.id, id)).get()!;
}

export function unignoreErrorGroup(id: string): ErrorGroup {
  const existing = db.select().from(errorGroups).where(eq(errorGroups.id, id)).get();
  if (!existing) throw new NotFoundError('Error group', 'ERROR_GROUP_NOT_FOUND');
  db.update(errorGroups).set({ state: 'active', ignoreReason: null, ignoredUntil: null, updatedAt: now() }).where(eq(errorGroups.id, id)).run();
  return db.select().from(errorGroups).where(eq(errorGroups.id, id)).get()!;
}

export function enqueueBridgeJob(payload: unknown): { id: string; eventId: string; inserted: boolean } {
  const body = JSON.stringify(redact(payload));
  const eventId = createHash('sha256').update(body).digest('hex');
  const existing = db.select().from(scoutBridgeJobs).where(eq(scoutBridgeJobs.eventId, eventId)).get();
  if (existing) return { id: existing.id, eventId, inserted: false };
  const id = randomUUID();
  db.insert(scoutBridgeJobs).values({ id, eventId, payload: body, nextAttemptAt: now(), createdAt: now(), updatedAt: now() }).run();
  return { id, eventId, inserted: true };
}

export function normalizeAlertmanagerPayload(payload: any): ErrorUpsertInput[] {
  return payload.alerts
    .filter((alert: any) => alert.status === 'firing')
    .map((alert: any) => {
      const labels = { ...(payload.commonLabels || {}), ...(alert.labels || {}) };
      const annotations = { ...(payload.commonAnnotations || {}), ...(alert.annotations || {}) };
      const env = labels.env || labels.environment || 'unknown';
      const service = labels.service || labels.job || 'unknown';
      const alertname = labels.alertname || 'AlertmanagerAlert';
      const fingerprint = alert.fingerprint || createHash('sha256').update(`${env}|${service}|${alertname}|${labels.route_template || ''}|${labels.error_type || ''}`).digest('hex');
      const explicitLogsUrl = firstUrl(annotations.grafana_logs_url, annotations.logs_url, labels.grafana_logs_url, labels.logs_url);
      return {
        projectSlug: labels.project || labels.project_slug || 'avtozor',
        source: 'alertmanager',
        fingerprint,
        environment: env,
        service,
        routeTemplate: labels.route_template,
        method: labels.method,
        upstreamService: labels.upstream_service,
        errorType: labels.error_type || alertname,
        statusCode: parseStatusCode(labels.status_code || labels.statusCode),
        statusClass: labels.status_class,
        severity: labels.severity === 'critical' ? 'critical' : labels.severity === 'info' ? 'info' : 'warning',
        occurredAt: alert.startsAt && !Number.isNaN(Date.parse(alert.startsAt)) ? new Date(alert.startsAt).toISOString() : now(),
        sampleRequestId: firstString(labels.request_id, labels.requestId, annotations.request_id, annotations.requestId),
        sampleTraceId: firstString(labels.trace_id, labels.traceId, labels.traceID, annotations.trace_id, annotations.traceId, annotations.traceID),
        grafanaLogsUrl: explicitLogsUrl || buildGrafanaExploreUrl(alert.generatorURL),
        grafanaTraceUrl: firstUrl(annotations.grafana_trace_url, annotations.trace_url, labels.grafana_trace_url, labels.trace_url),
        title: `[${env}][${service}] ${alertname}`,
        message: annotations.summary || annotations.description,
        release: labels.release || labels.deploy_sha || labels.deployment_sha,
        samplePayload: { labels, annotations, status: alert.status, groupKey: payload.groupKey, externalURL: payload.externalURL },
      };
    });
}

export function processBridgeJobs(limit = DEFAULT_BRIDGE_BATCH_SIZE, currentTime = now()): { processed: number; failed: number; dead: number } {
  const jobs = db.select().from(scoutBridgeJobs)
    .where(and(eq(scoutBridgeJobs.status, 'pending'), lte(scoutBridgeJobs.nextAttemptAt, currentTime)))
    .limit(limit)
    .all();
  let processed = 0;
  let failed = 0;
  let dead = 0;
  for (const job of jobs) {
    try {
      db.update(scoutBridgeJobs).set({ status: 'processing', attempts: job.attempts + 1, processingStartedAt: now(), updatedAt: now() }).where(eq(scoutBridgeJobs.id, job.id)).run();
      const payload = JSON.parse(job.payload);
      for (const event of normalizeAlertmanagerPayload(payload)) upsertErrorGroup(event);
      db.update(scoutBridgeJobs).set({ status: 'delivered', processingStartedAt: null, lastError: null, updatedAt: now() }).where(eq(scoutBridgeJobs.id, job.id)).run();
      processed++;
    } catch (error) {
      const attempts = job.attempts + 1;
      const maxAttempts = getEnvInt('SCOUT_ERROR_BRIDGE_MAX_ATTEMPTS', DEFAULT_BRIDGE_MAX_ATTEMPTS, 1, 100);
      const status = attempts >= maxAttempts ? 'dead' : 'pending';
      const delayMs = Math.min(
        getEnvInt('SCOUT_ERROR_BRIDGE_BACKOFF_MAX_MS', DEFAULT_BRIDGE_BACKOFF_MAX_MS, 1_000, 24 * 60 * 60 * 1000),
        getEnvInt('SCOUT_ERROR_BRIDGE_BACKOFF_BASE_MS', DEFAULT_BRIDGE_BACKOFF_BASE_MS, 1_000, 60 * 60 * 1000) * 2 ** Math.max(0, attempts - 1),
      );
      const currentTimestamp = Date.parse(currentTime);
      const next = new Date((Number.isFinite(currentTimestamp) ? currentTimestamp : Date.now()) + delayMs).toISOString();
      db.update(scoutBridgeJobs).set({ status, attempts, nextAttemptAt: next, processingStartedAt: null, lastError: String(error).slice(0, 1000), updatedAt: now() }).where(eq(scoutBridgeJobs.id, job.id)).run();
      if (status === 'dead') dead++;
      else failed++;
    }
  }
  return { processed, failed, dead };
}

function countBridgeJobs(status: 'pending' | 'processing' | 'delivered' | 'dead'): number {
  return db.select({ total: count() }).from(scoutBridgeJobs).where(eq(scoutBridgeJobs.status, status)).get()?.total ?? 0;
}

export function getBridgeStatus(currentTime = now()) {
  const due = db.select({ total: count() }).from(scoutBridgeJobs)
    .where(and(eq(scoutBridgeJobs.status, 'pending'), lte(scoutBridgeJobs.nextAttemptAt, currentTime)))
    .get()?.total ?? 0;
  return {
    pending: countBridgeJobs('pending'),
    pendingDue: due,
    processing: countBridgeJobs('processing'),
    delivered: countBridgeJobs('delivered'),
    dead: countBridgeJobs('dead'),
  };
}

export function startBridgeWorker(): () => void {
  if (process.env.SCOUT_ERROR_BRIDGE_WORKER_ENABLED === 'false') return () => {};
  const intervalMs = getEnvInt('SCOUT_ERROR_BRIDGE_WORKER_INTERVAL_MS', DEFAULT_BRIDGE_INTERVAL_MS, 1_000, 60 * 60 * 1000);
  const batchSize = getEnvInt('SCOUT_ERROR_BRIDGE_BATCH_SIZE', DEFAULT_BRIDGE_BATCH_SIZE, 1, 1_000);
  const timer = setInterval(() => {
    processBridgeJobs(batchSize);
  }, intervalMs);
  timer.unref?.();
  processBridgeJobs(batchSize);
  return () => clearInterval(timer);
}
