import { and, count, desc, eq, inArray, lte } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { errorGroupOccurrences, errorGroups, projects, scoutBridgeJobs, scoutItems, type ErrorGroup } from '../db/schema.js';
import { NotFoundError } from '../lib/errors.js';
import { eventBus } from '../lib/event-bus.js';
import { logAudit } from './audit.js';
import { dispatchWebhooks } from './webhooks.js';

type ItemStatusChange = {
  item: typeof scoutItems.$inferSelect;
  oldStatus: typeof scoutItems.$inferSelect.status;
  newStatus: typeof scoutItems.$inferSelect.status;
  errorGroupId: string;
};

type CreatedLinkedItem = {
  item: typeof scoutItems.$inferSelect;
  errorGroupId: string;
};

type ErrorUpsertInput = {
  projectId: string;
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
const DEFAULT_SAMPLE_JSON_LENGTH = 20_000;
const DEFAULT_OCCURRENCE_LIMIT = 100;
const DEFAULT_REGRESSION_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_BRIDGE_BATCH_SIZE = 20;
const DEFAULT_BRIDGE_INTERVAL_MS = 30_000;
const DEFAULT_BRIDGE_MAX_ATTEMPTS = 10;
const DEFAULT_BRIDGE_BACKOFF_BASE_MS = 30_000;
const DEFAULT_BRIDGE_BACKOFF_MAX_MS = 60 * 60 * 1000;
const DEFAULT_TEMPO_SEARCH_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_TEMPO_TIMEOUT_MS = 2_000;
const MAX_TEMPO_SPANS = 8;
const AUTO_ACCEPTED_RUNTIME_ITEM_NOTE = 'Auto-accepted system observability item. See linked runtime error group for operational details.';

type TempoSearchTrace = {
  traceID?: string;
  rootServiceName?: string;
  rootTraceName?: string;
  startTimeUnixNano?: string;
  durationMs?: number;
};

type TempoSearchResponse = { traces?: TempoSearchTrace[] };
type TempoTraceResponse = { batches?: TempoBatch[] };
type TempoBatch = { resource?: { attributes?: TempoAttribute[] }; scopeSpans?: Array<{ spans?: TempoSpan[] }> };
type TempoSpan = { name?: string; kind?: string; startTimeUnixNano?: string; endTimeUnixNano?: string; attributes?: TempoAttribute[]; status?: Record<string, unknown> };
type TempoAttribute = { key?: string; value?: Record<string, unknown> };

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
  const maxLength = getEnvInt('SCOUT_ERROR_SAMPLE_MAX_JSON_LENGTH', DEFAULT_SAMPLE_JSON_LENGTH, 1_000, 250_000);
  return json.length > maxLength ? json.slice(0, maxLength) : json;
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

function buildGrafanaTraceUrl(traceId: string): string | undefined {
  const grafanaBase = process.env.SCOUT_GRAFANA_URL?.trim() || process.env.GRAFANA_PUBLIC_URL?.trim();
  if (!grafanaBase) return undefined;

  const datasource = process.env.SCOUT_GRAFANA_TEMPO_DATASOURCE?.trim() || 'Tempo';
  try {
    const target = new URL('/explore', grafanaBase.endsWith('/') ? grafanaBase : `${grafanaBase}/`);
    target.searchParams.set('orgId', '1');
    target.searchParams.set('left', JSON.stringify({
      datasource,
      queries: [{ refId: 'A', query: traceId, queryType: 'traceid' }],
      range: { from: 'now-6h', to: 'now' },
    }));
    return target.toString();
  } catch {
    return undefined;
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

function routeTemplateToHttpTarget(routeTemplate: string | undefined): string | undefined {
  if (!routeTemplate) return undefined;
  let value = routeTemplate.trim();
  if (value.startsWith('^')) value = value.slice(1);
  if (value.endsWith('$')) value = value.slice(0, -1);
  value = value.replace(/\\\//g, '/');
  if (!value.startsWith('/') || /[()[\]{}+?|]/.test(value)) return undefined;
  return value;
}

function tempoStatusCandidates(input: ErrorUpsertInput): number[] {
  if (input.statusCode) return [input.statusCode];
  if (input.statusClass === '5xx') return [500, 502, 503, 504];
  if (input.statusClass === '4xx') return [400, 401, 403, 404, 429];
  return [];
}

function tempoAttributeValue(attribute: TempoAttribute): unknown {
  const value = attribute.value;
  if (!value || typeof value !== 'object') return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('boolValue' in value) return Boolean(value.boolValue);
  if ('arrayValue' in value || 'kvlistValue' in value) return value;
  return undefined;
}

function tempoAttributesMap(attributes: TempoAttribute[] | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const attribute of attributes ?? []) {
    if (!attribute.key) continue;
    const value = tempoAttributeValue(attribute);
    if (value !== undefined) result[attribute.key] = value;
  }
  return result;
}

function summarizeTempoTrace(trace: TempoTraceResponse, searchTrace: TempoSearchTrace): Record<string, unknown> {
  const gatewaySpans: Array<Record<string, unknown>> = [];
  const otherSpans: Array<Record<string, unknown>> = [];
  for (const batch of trace.batches ?? []) {
    const resource = tempoAttributesMap(batch.resource?.attributes);
    for (const scopeSpan of batch.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        const attributes = tempoAttributesMap(span.attributes);
        const attributeKeys = Object.keys(attributes);
        const hasGatewayAttributes = attributeKeys.some((key) => key.startsWith('gateway.'));
        const hasDiagnosticAttributes = hasGatewayAttributes || attributeKeys.some((key) => (
          key.startsWith('http.')
          || key.startsWith('exception.')
          || key.startsWith('db.')
          || key.startsWith('net.')
          || key === 'route_template'
          || key === 'error_type'
          || key === 'upstream_service'
        ));
        if (!hasDiagnosticAttributes && !span.status) continue;
        const summary = {
          name: span.name,
          kind: span.kind,
          startTimeUnixNano: span.startTimeUnixNano,
          endTimeUnixNano: span.endTimeUnixNano,
          status: span.status,
          resource,
          attributes,
        };
        if (hasGatewayAttributes) gatewaySpans.push(summary);
        else if (otherSpans.length < MAX_TEMPO_SPANS) otherSpans.push(summary);
      }
    }
  }
  const spans = [...gatewaySpans, ...otherSpans].slice(0, MAX_TEMPO_SPANS);

  return {
    traceID: searchTrace.traceID,
    rootServiceName: searchTrace.rootServiceName,
    rootTraceName: searchTrace.rootTraceName,
    startTimeUnixNano: searchTrace.startTimeUnixNano,
    durationMs: searchTrace.durationMs,
    spans,
  };
}

async function fetchTempoJson<T>(url: URL, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Tempo returned ${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

async function enrichFromTempo(input: ErrorUpsertInput): Promise<ErrorUpsertInput> {
  const tempoBase = process.env.SCOUT_TEMPO_URL?.trim();
  if (!tempoBase || input.sampleTraceId) return input;

  const occurredAt = Date.parse(input.occurredAt || now());
  if (!Number.isFinite(occurredAt)) return input;

  const timeoutMs = getEnvInt('SCOUT_TEMPO_TIMEOUT_MS', DEFAULT_TEMPO_TIMEOUT_MS, 100, 30_000);
  const windowMs = getEnvInt('SCOUT_TEMPO_SEARCH_WINDOW_MS', DEFAULT_TEMPO_SEARCH_WINDOW_MS, 1_000, 24 * 60 * 60 * 1000);
  const statusCandidates = tempoStatusCandidates(input);
  const target = routeTemplateToHttpTarget(input.routeTemplate);
  const tagParts = [`service.name=${input.service}`];
  if (input.environment) tagParts.push(`deployment.environment=${input.environment}`);
  if (input.method) tagParts.push(`http.method=${input.method}`);
  if (target) tagParts.push(`http.target=${target}`);
  const candidates = statusCandidates.length > 0 ? statusCandidates.map((status) => [...tagParts, `http.status_code=${status}`]) : [tagParts];

  try {
    const base = new URL(tempoBase.endsWith('/') ? tempoBase : `${tempoBase}/`);
    for (const tags of candidates) {
      const searchUrl = new URL('/api/search', base);
      searchUrl.searchParams.set('tags', tags.join(' '));
      searchUrl.searchParams.set('start', String(Math.floor((occurredAt - windowMs) / 1000)));
      searchUrl.searchParams.set('end', String(Math.ceil((occurredAt + windowMs) / 1000)));
      searchUrl.searchParams.set('limit', '1');
      const search = await fetchTempoJson<TempoSearchResponse>(searchUrl, timeoutMs);
      const trace = search.traces?.find((item) => typeof item.traceID === 'string' && item.traceID.trim() !== '');
      if (!trace?.traceID) continue;

      const traceUrl = new URL(`/api/traces/${encodeURIComponent(trace.traceID)}`, base);
      const traceBody = await fetchTempoJson<TempoTraceResponse>(traceUrl, timeoutMs);
      return {
        ...input,
        sampleTraceId: trace.traceID,
        grafanaTraceUrl: input.grafanaTraceUrl ?? buildGrafanaTraceUrl(trace.traceID),
        samplePayload: {
          ...(input.samplePayload ?? {}),
          tempo: {
            searchTags: tags,
            trace: summarizeTempoTrace(traceBody, trace),
          },
        },
      };
    }
  } catch {
    return input;
  }

  return input;
}

export function resolveErrorProjectId(input: ErrorUpsertInput): string {
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get();
  if (!project) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
  return project.id;
}

function resolveBridgeProjectId(labels: Record<string, unknown>): string {
  const slug = firstString(labels.project, labels.project_slug) ?? 'avtozor';
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get();
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
  const createdLinkedItems: CreatedLinkedItem[] = [];
  const autoAcceptedItemStatusChanges: ItemStatusChange[] = [];

  const group = db.transaction((tx) => {
    if (!existing) {
      const itemId = randomUUID();
      tx.insert(scoutItems).values({
        id: itemId,
        projectId,
        itemType: 'bug',
        source: 'api',
        message: buildItemMessage(input),
        status: 'verified',
        priority: priorityForSeverity(input.severity),
        labels: JSON.stringify(['gateway', 'observability', 'auto-created', `env:${input.environment}`, `service:${input.service}`, `error:${input.errorType}`]),
        metadata: JSON.stringify({ source: 'error_group', fingerprint: input.fingerprint, autoAccepted: true }),
        resolutionNote: AUTO_ACCEPTED_RUNTIME_ITEM_NOTE,
        resolvedAt: timestamp,
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
      createdLinkedItems.push({
        item: tx.select().from(scoutItems).where(eq(scoutItems.id, itemId)).get()!,
        errorGroupId: groupId,
      });
      return tx.select().from(errorGroups).where(eq(errorGroups.id, groupId)).get()!;
    }

    const ignoredActive = existing.state === 'ignored' && (!existing.ignoredUntil || Date.parse(existing.ignoredUntil) > Date.now());
    const nextState = ignoredActive ? existing.state : 'active';
    const linkedItem = existing.linkedItemId
      ? tx.select().from(scoutItems).where(eq(scoutItems.id, existing.linkedItemId)).get() ?? null
      : null;
    const recordRegression = shouldRecordRegression(existing, linkedItem, input, timestamp, ignoredActive);
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
      lastRegressionAt: recordRegression ? timestamp : existing.lastRegressionAt,
      updatedAt: now(),
    }).where(eq(errorGroups.id, existing.id)).run();
    insertOccurrence(tx, existing.id, input, timestamp, samplePayload);
    enforceOccurrenceLimit(tx, existing.id);

    if (linkedItem && linkedItem.status !== 'verified' && linkedItem.status !== 'cancelled') {
      tx.update(scoutItems).set({
        status: 'verified',
        assigneeId: null,
        resolvedById: null,
        resolutionNote: AUTO_ACCEPTED_RUNTIME_ITEM_NOTE,
        resolvedAt: timestamp,
        updatedAt: now(),
      }).where(eq(scoutItems.id, linkedItem.id)).run();
      autoAcceptedItemStatusChanges.push({
        item: tx.select().from(scoutItems).where(eq(scoutItems.id, linkedItem.id)).get()!,
        oldStatus: linkedItem.status,
        newStatus: 'verified',
        errorGroupId: existing.id,
      });
    }

    return tx.select().from(errorGroups).where(eq(errorGroups.id, existing.id)).get()!;
  });

  for (const { item, errorGroupId } of createdLinkedItems) {
    logAudit({
      userId: null,
      action: 'create_item',
      entityType: 'item',
      entityId: item.id,
      details: { projectId: item.projectId, itemType: item.itemType, source: item.source, priority: item.priority, status: item.status, autoAccepted: true, errorGroupId },
    });
    dispatchWebhooks(item.projectId, 'item.created', { item }).catch(() => {});
    eventBus.publish({ type: 'item.created', projectId: item.projectId, payload: { item } });
  }

  for (const { item, oldStatus, newStatus, errorGroupId } of autoAcceptedItemStatusChanges) {
    logAudit({
      userId: null,
      action: 'auto_accept_runtime_item',
      entityType: 'item',
      entityId: item.id,
      details: { status: newStatus, oldStatus, errorGroupId, release: input.release ?? null },
    });
    dispatchWebhooks(item.projectId, 'item.status_changed', { item, oldStatus, newStatus }).catch(() => {});
    eventBus.publish({ type: 'item.status_changed', projectId: item.projectId, payload: { item, oldStatus, newStatus } });
  }

  return group;
}

function shouldRecordRegression(
  existing: ErrorGroup,
  linkedItem: typeof scoutItems.$inferSelect | null,
  input: ErrorUpsertInput,
  occurredAt: string,
  ignoredActive: boolean,
): boolean {
  if (ignoredActive) return false;
  if (!linkedItem || linkedItem.status === 'cancelled') return false;

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
        projectId: resolveBridgeProjectId(labels),
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

export async function processBridgeJobs(limit = DEFAULT_BRIDGE_BATCH_SIZE, currentTime = now()): Promise<{ processed: number; failed: number; dead: number }> {
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
      for (const event of normalizeAlertmanagerPayload(payload)) upsertErrorGroup(await enrichFromTempo(event));
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
    processBridgeJobs(batchSize).catch(() => {});
  }, intervalMs);
  timer.unref?.();
  processBridgeJobs(batchSize).catch(() => {});
  return () => clearInterval(timer);
}
