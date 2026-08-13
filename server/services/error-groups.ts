import { and, count, desc, eq, inArray, lt, lte } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { errorGroupOccurrences, errorGroups, projects, scoutItems, type ErrorGroup } from '../db/schema.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { eventBus } from '../lib/event-bus.js';
import { logger } from '../lib/logger.js';
import { logAudit } from './audit.js';
import { isSqliteBusyError, nextItemUpdatedAt, type DbOrTx } from './items.js';
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
  samplePayload?: Record<string, unknown>;
  title?: string;
  message?: string;
  release?: string;
};

const SECRET_KEY_PATTERN = /(authorization|cookie|token|password|secret|key|credential|jwt)/i;
const SECRET_VALUE_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+|((?:authorization|cookie|token|password|secret|key|credential|jwt)=)[^&\s,}]+/gi;
const DEFAULT_SAMPLE_JSON_LENGTH = 20_000;
const DEFAULT_OCCURRENCE_LIMIT = 100;
const DEFAULT_REGRESSION_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_AUTO_RESOLVE_DAYS = 7;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const AUTO_ACCEPTED_RUNTIME_ITEM_NOTE = 'Auto-accepted system observability item. See linked runtime error group for operational details.';

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





export function resolveErrorProjectId(input: ErrorUpsertInput): string {
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get();
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
  return lines.join('\n');
}

function priorityForSeverity(severity: ErrorUpsertInput['severity']): 'critical' | 'high' | 'medium' | 'low' {
  if (severity === 'critical') return 'critical';
  if (severity === 'warning') return 'high';
  return 'medium';
}

function runImmediateErrorGroupTransaction<T>(operation: (tx: DbOrTx) => T): T {
  try {
    return db.transaction((tx) => operation(tx), { behavior: 'immediate' });
  } catch (error) {
    if (isSqliteBusyError(error)) {
      throw new ConflictError('Database is busy with a concurrent write; retry the operation', 'ITEM_STATE_CONFLICT');
    }
    throw error;
  }
}

export function upsertErrorGroup(input: ErrorUpsertInput, resolvedProjectId?: string): ErrorGroup {
  const projectId = resolvedProjectId ?? resolveErrorProjectId(input);
  const timestamp = input.occurredAt || now();
  const samplePayload = stringifySample(input.samplePayload);
  const createdLinkedItems: CreatedLinkedItem[] = [];
  const autoAcceptedItemStatusChanges: ItemStatusChange[] = [];

  const group = runImmediateErrorGroupTransaction((tx) => {
    const existing = tx.select().from(errorGroups)
      .where(and(eq(errorGroups.projectId, projectId), eq(errorGroups.environment, input.environment), eq(errorGroups.fingerprint, input.fingerprint)))
      .get();
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
        updatedAt: nextItemUpdatedAt(linkedItem.updatedAt),
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

/**
 * Close the groups nothing has reported for a while.
 *
 * An error that stopped happening is not open work, and a list that keeps every error ever seen
 * stops being read. A recurrence puts the group straight back to `active` through the upsert path,
 * and the gap counts as a regression, so closing early costs nothing.
 *
 * `ignored` groups are left alone: their state is a deliberate decision with its own expiry.
 */
export function resolveStaleErrorGroups(currentTime = now()): ErrorGroup[] {
  const days = getEnvInt('SCOUT_ERROR_AUTO_RESOLVE_DAYS', DEFAULT_AUTO_RESOLVE_DAYS, 0, 3650);
  if (days === 0) return [];

  const threshold = new Date(Date.parse(currentTime) - days * 24 * 60 * 60 * 1000).toISOString();
  const stale = db.select().from(errorGroups)
    .where(and(eq(errorGroups.state, 'active'), lt(errorGroups.lastSeenAt, threshold)))
    .all();
  if (stale.length === 0) return [];

  const staleIds = stale.map((group) => group.id);
  db.update(errorGroups).set({ state: 'resolved', updatedAt: currentTime }).where(inArray(errorGroups.id, staleIds)).run();

  return db.select().from(errorGroups).where(inArray(errorGroups.id, staleIds)).all();
}

export function startErrorMaintenanceWorker(): () => void {
  const intervalMs = getEnvInt('SCOUT_ERROR_MAINTENANCE_INTERVAL_MS', DEFAULT_MAINTENANCE_INTERVAL_MS, 60_000, 24 * 60 * 60 * 1000);
  const run = (): void => {
    let resolved: ErrorGroup[];
    try {
      resolved = resolveStaleErrorGroups();
    } catch (err) {
      logger.error({ err }, 'Scout error group auto-resolve failed');
      return;
    }
    if (resolved.length === 0) return;

    logger.info({ resolvedCount: resolved.length }, 'Scout resolved stale error groups');
    for (const errorGroup of resolved) {
      dispatchWebhooks(errorGroup.projectId, 'error_group.updated', { errorGroup }).catch(() => {});
      eventBus.publish({ type: 'error_group.updated', projectId: errorGroup.projectId, payload: { errorGroup } });
    }
  };

  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  run();
  return () => clearInterval(timer);
}
