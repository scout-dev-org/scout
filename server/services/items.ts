import { db } from '../db/client.js';
import { scoutItems, scoutItemNotes, scoutItemEvidence, type User, type ItemStatus, type ItemPriority, type ItemType, type ItemSource } from '../db/schema.js';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NotFoundError, ConflictError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

// Both db and tx share these methods — use minimal interface
interface DbOrTx {
  insert: typeof db.insert;
  select: typeof db.select;
  update: typeof db.update;
  delete: typeof db.delete;
}

const VALID_TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  new: ['in_progress', 'cancelled'],
  in_progress: ['review', 'done', 'cancelled'],
  review: ['in_progress', 'done', 'changes_requested', 'cancelled'],
  done: ['new', 'changes_requested', 'verified'],
  changes_requested: ['in_progress', 'cancelled'],
  verified: ['new', 'changes_requested'],
  cancelled: ['new'],
};

type ItemEvidenceInput = {
  kind?: 'handoff' | 'verification' | 'audit' | 'blocker';
  result?: 'pass' | 'fail' | 'blocked' | 'partial';
  level?: 'static' | 'typecheck' | 'api_smoke' | 'browser_smoke' | 'browser_acceptance' | 'local_acceptance' | 'staging_acceptance' | 'production_acceptance' | 'user_acceptance';
  coverage?: 'item' | 'shared_root_cluster' | 'route_sweep' | 'audit_sample';
  environment: string;
  role?: string;
  url?: string;
  scenario: string;
  action: string;
  visibleResult: string;
  acceptanceScope?: string;
  consoleResult?: string;
  networkResult?: string;
  apiResult?: string;
  dbResult?: string;
  fixture?: string;
  cleanupResult?: string;
  commitSha?: string;
  deploySha?: string;
  risks?: string;
  uncheckedRisks?: string;
  source?: 'agent' | 'human' | 'ci' | 'deploy' | 'audit';
  verifiedAt?: string;
};

const DONE_EVIDENCE_LEVELS = new Set<ItemEvidenceInput['level']>([
  'local_acceptance',
  'staging_acceptance',
  'production_acceptance',
  'user_acceptance',
]);

const ITEM_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const ITEM_DEDUPE_CANDIDATE_LIMIT = 50;
const DEBUG_CONTEXT_MAX_JSON_CHARS = 200_000;
const SQLITE_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function now(): string {
  return new Date().toISOString();
}

function addAutoNote(
  tx: DbOrTx,
  itemId: string,
  userId: string,
  content: string,
  type: 'status_change' | 'assignment' | 'type_change',
): void {
  tx.insert(scoutItemNotes).values({
    id: randomUUID(),
    itemId,
    userId,
    content,
    type,
  }).run();
}

function addEvidence(
  tx: DbOrTx,
  itemId: string,
  userId: string,
  evidence: ItemEvidenceInput,
): string {
  const id = randomUUID();
  tx.insert(scoutItemEvidence).values({
    id,
    itemId,
    userId,
    kind: evidence.kind ?? 'handoff',
    result: evidence.result,
    level: evidence.level,
    coverage: evidence.coverage,
    environment: evidence.environment,
    role: evidence.role,
    url: evidence.url,
    scenario: evidence.scenario,
    action: evidence.action,
    visibleResult: evidence.visibleResult,
    acceptanceScope: evidence.acceptanceScope,
    consoleResult: evidence.consoleResult,
    networkResult: evidence.networkResult,
    apiResult: evidence.apiResult,
    dbResult: evidence.dbResult,
    fixture: evidence.fixture,
    cleanupResult: evidence.cleanupResult,
    commitSha: evidence.commitSha,
    deploySha: evidence.deploySha,
    risks: evidence.risks,
    uncheckedRisks: evidence.uncheckedRisks,
    source: evidence.source,
    verifiedAt: evidence.verifiedAt,
    createdAt: now(),
  }).run();
  return id;
}

function hasFreshEvidence(itemId: string, itemUpdatedAt: string, newStatus: ItemStatus, mrUrl?: string): boolean {
  const updatedAt = Date.parse(itemUpdatedAt);
  if (Number.isNaN(updatedAt)) return false;

  const evidence = db.select()
    .from(scoutItemEvidence)
    .where(eq(scoutItemEvidence.itemId, itemId))
    .all();

  return evidence.some((entry) => {
    const createdAt = Date.parse(entry.createdAt);
    return !Number.isNaN(createdAt) && createdAt >= updatedAt && isEvidenceStrongEnough(newStatus, entry, mrUrl);
  });
}

function isEvidenceStrongEnough(
  newStatus: ItemStatus,
  evidence: { result?: ItemEvidenceInput['result'] | null; level?: ItemEvidenceInput['level'] | null; commitSha?: string | null },
  mrUrl?: string,
): boolean {
  if (newStatus !== 'review' && newStatus !== 'done') return true;
  if (evidence.result !== 'pass') return false;
  if (!evidence.level) return false;
  if (newStatus === 'review') return Boolean(evidence.commitSha || mrUrl);
  return DONE_EVIDENCE_LEVELS.has(evidence.level);
}

function requireHandoffEvidence(
  item: typeof scoutItems.$inferSelect,
  newStatus: ItemStatus,
  evidence?: ItemEvidenceInput,
  extra?: { mrUrl?: string },
): void {
  if (newStatus !== 'review' && newStatus !== 'done') return;
  if (evidence && isEvidenceStrongEnough(newStatus, evidence, extra?.mrUrl)) return;
  if (hasFreshEvidence(item.id, item.updatedAt, newStatus, extra?.mrUrl)) return;
  if (newStatus === 'review') {
    throw new ValidationError('Review requires fresh passing structured evidence with a commit SHA or MR URL', 'REVIEW_EVIDENCE_REQUIRED');
  }
  throw new ValidationError('Done requires fresh passing target-acceptance evidence', 'DONE_EVIDENCE_REQUIRED');
}

const RRWEB_FULL_SNAPSHOT_TYPE = 2;

function decodeBase64Strict(
  base64: string,
  errorMessage = 'Attachment payload must be valid base64',
  errorCode = 'INVALID_ATTACHMENT',
): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new ValidationError(errorMessage, errorCode);
  }
  return Buffer.from(base64, 'base64');
}

function assertRecordingEvents(buffer: Buffer): void {
  try {
    const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || !parsed.some((event) => typeof event === 'object' && event !== null && (event as { type?: unknown }).type === RRWEB_FULL_SNAPSHOT_TYPE)) {
      throw new Error('invalid rrweb events');
    }
  } catch {
    throw new ValidationError('Session recording must be a valid rrweb JSON event array', 'INVALID_SESSION_RECORDING');
  }
}

function saveFile(base64: string, dir: string, ext: string): string {
  const fullDir = join(process.cwd(), 'storage', dir);
  mkdirSync(fullDir, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  const filePath = join(fullDir, filename);
  const buffer = decodeBase64Strict(base64);
  writeFileSync(filePath, buffer);
  return `storage/${dir}/${filename}`;
}

/**
 * Save session recording — handles both raw JSON and gzip-compressed data.
 * Widget sends gzip-compressed base64 for smaller transport payload.
 * We decompress and save as JSON for dashboard compatibility.
 */
function saveRecording(base64: string, dir: string): string {
  const fullDir = join(process.cwd(), 'storage', dir);
  mkdirSync(fullDir, { recursive: true });
  const filename = `${randomUUID()}.json`;
  const filePath = join(fullDir, filename);
  const buffer = decodeBase64Strict(
    base64,
    'Session recording must be valid base64',
    'INVALID_SESSION_RECORDING',
  );
  let jsonBuffer = buffer;

  // Detect gzip magic bytes (0x1f 0x8b) — decompress if gzip
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      jsonBuffer = gunzipSync(buffer);
    } catch {
      throw new ValidationError('Compressed session recording is corrupted', 'INVALID_SESSION_RECORDING');
    }
  }

  assertRecordingEvents(jsonBuffer);
  writeFileSync(filePath, jsonBuffer);

  return `storage/${dir}/${filename}`;
}

function deleteFile(path: string | null): void {
  if (!path) return;
  const fullPath = join(process.cwd(), path);
  if (existsSync(fullPath)) unlinkSync(fullPath);
}

function normalizeDedupeString(value?: string | null): string {
  return (value ?? '').trim();
}

function parseDbTimestamp(value: string): number {
  if (SQLITE_UTC_TIMESTAMP_RE.test(value)) return Date.parse(`${value.replace(' ', 'T')}Z`);
  return Date.parse(value);
}

function parseMetadata(metadata: string | null): Record<string, string> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

function serializeMetadata(metadata?: Record<string, string> | null, dedupeKey?: string): string | null {
  const next = { ...(metadata ?? {}) };
  if (dedupeKey) next.dedupeKey = dedupeKey;
  return Object.keys(next).length > 0 ? JSON.stringify(next) : null;
}

function serializeDebugContext(debugContext?: Record<string, unknown> | null, sessionRecordingPath?: string | null): string | null {
  if (!debugContext) return null;

  try {
    const next: Record<string, unknown> = { ...debugContext };
    const summary = next.recordingSummary;

    if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
      next.recordingSummary = {
        ...(summary as Record<string, unknown>),
        hasRecording: Boolean(sessionRecordingPath),
        recordingPath: sessionRecordingPath ?? null,
      };
    } else if (sessionRecordingPath) {
      next.recordingSummary = {
        hasRecording: true,
        recordingPath: sessionRecordingPath,
      };
    }

    const serialized = JSON.stringify(next);
    return serialized.length <= DEBUG_CONTEXT_MAX_JSON_CHARS ? serialized : null;
  } catch {
    return null;
  }
}

function findDuplicateItem(data: {
  projectId: string;
  itemType: ItemType;
  source: ItemSource;
  message: string;
  reporterId: string;
  priority: ItemPriority | null;
  labelsJson: string | null;
  pageUrl?: string | null;
  pageRoute?: string | null;
  componentFile?: string | null;
  cssSelector?: string | null;
  elementText?: string | null;
  elementHtml?: string | null;
  dedupeKey?: string;
}): typeof scoutItems.$inferSelect | null {
  const candidates = db.select().from(scoutItems)
    .where(and(
      eq(scoutItems.projectId, data.projectId),
      eq(scoutItems.itemType, data.itemType),
      eq(scoutItems.source, data.source),
      eq(scoutItems.reporterId, data.reporterId),
    ))
    .orderBy(desc(scoutItems.createdAt))
    .limit(ITEM_DEDUPE_CANDIDATE_LIMIT)
    .all();

  const cutoff = Date.now() - ITEM_DEDUPE_WINDOW_MS;
  for (const candidate of candidates) {
    const createdAt = parseDbTimestamp(candidate.createdAt);
    if (Number.isNaN(createdAt) || createdAt < cutoff) continue;
    if (candidate.status === 'cancelled') continue;

    if (data.dedupeKey && parseMetadata(candidate.metadata).dedupeKey === data.dedupeKey) {
      return candidate;
    }

    const isSameFingerprint =
      normalizeDedupeString(candidate.message) === normalizeDedupeString(data.message) &&
      candidate.priority === data.priority &&
      candidate.labels === data.labelsJson &&
      normalizeDedupeString(candidate.pageUrl) === normalizeDedupeString(data.pageUrl) &&
      normalizeDedupeString(candidate.pageRoute) === normalizeDedupeString(data.pageRoute) &&
      normalizeDedupeString(candidate.componentFile) === normalizeDedupeString(data.componentFile) &&
      normalizeDedupeString(candidate.cssSelector) === normalizeDedupeString(data.cssSelector) &&
      normalizeDedupeString(candidate.elementText) === normalizeDedupeString(data.elementText) &&
      normalizeDedupeString(candidate.elementHtml) === normalizeDedupeString(data.elementHtml);

    if (isSameFingerprint) return candidate;
  }

  return null;
}

export function validateTransition(from: ItemStatus, to: ItemStatus): void {
  if (!VALID_TRANSITIONS[from]?.includes(to)) {
    throw new ValidationError(`Invalid status transition: ${from} → ${to}`, 'INVALID_STATUS_TRANSITION');
  }
}

export function createItem(data: {
  projectId: string;
  itemType?: ItemType;
  source?: ItemSource;
  message: string;
  dedupeKey?: string;
  reporterId: string;
  priority?: ItemPriority;
  labels?: string[];
  pageUrl?: string | null;
  pageRoute?: string | null;
  componentFile?: string | null;
  cssSelector?: string | null;
  elementText?: string | null;
  elementHtml?: string | null;
  viewportWidth?: number | null;
  viewportHeight?: number | null;
  screenshot?: string | null;
  sessionRecording?: string | null;
  metadata?: Record<string, string> | null;
  debugContext?: Record<string, unknown> | null;
}): { item: typeof scoutItems.$inferSelect; deduped: boolean } {
  const itemType = data.itemType ?? 'bug';
  const priority = itemType === 'note' ? null : (data.priority ?? 'medium');
  const source = data.source ?? 'widget';
  const labelsJson = data.labels ? JSON.stringify(data.labels) : null;
  const dedupeKey = data.dedupeKey?.trim();
  const metadataJson = serializeMetadata(data.metadata, dedupeKey);

  const duplicate = findDuplicateItem({
    projectId: data.projectId,
    itemType,
    source,
    message: data.message,
    reporterId: data.reporterId,
    priority,
    labelsJson,
    pageUrl: data.pageUrl,
    pageRoute: data.pageRoute,
    componentFile: data.componentFile,
    cssSelector: data.cssSelector,
    elementText: data.elementText,
    elementHtml: data.elementHtml,
    dedupeKey,
  });
  if (duplicate) return { item: duplicate, deduped: true };

  // Save files before the transaction (file I/O outside DB transaction)
  let screenshotPath: string | null = null;
  let sessionRecordingPath: string | null = null;

  if (data.screenshot) {
    screenshotPath = saveFile(data.screenshot, 'screenshots', 'jpg');
  }
  if (data.sessionRecording) {
    try {
      sessionRecordingPath = saveRecording(data.sessionRecording, 'recordings');
    } catch (err) {
      if (source !== 'widget' || !(err instanceof ValidationError) || err.code !== 'INVALID_SESSION_RECORDING') {
        throw err;
      }
      logger.warn({ projectId: data.projectId }, 'Discarding invalid optional widget session recording');
    }
  }

  const debugContextJson = serializeDebugContext(data.debugContext, sessionRecordingPath);

  const id = randomUUID();

  try {
    const item = db.transaction((tx) => {
      tx.insert(scoutItems).values({
        id,
        projectId: data.projectId,
        itemType,
        source,
        message: data.message,
        priority,
        labels: labelsJson,
        pageUrl: data.pageUrl ?? null,
        pageRoute: data.pageRoute ?? null,
        componentFile: data.componentFile ?? null,
        cssSelector: data.cssSelector ?? null,
        elementText: data.elementText ?? null,
        elementHtml: data.elementHtml ?? null,
        viewportWidth: data.viewportWidth ?? null,
        viewportHeight: data.viewportHeight ?? null,
        screenshotPath,
        sessionRecordingPath,
        metadata: metadataJson,
        debugContext: debugContextJson,
        reporterId: data.reporterId,
      }).run();

      return tx.select().from(scoutItems).where(eq(scoutItems.id, id)).get()!;
    });
    return { item, deduped: false };
  } catch (err) {
    // If insert fails, clean up orphaned files
    deleteFile(screenshotPath);
    deleteFile(sessionRecordingPath);
    throw err;
  }
}

export function claimItem(itemId: string, user: User) {
  const existing = db.select({ itemType: scoutItems.itemType }).from(scoutItems).where(eq(scoutItems.id, itemId)).get();
  if (!existing) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
  if (existing.itemType === 'note') {
    throw new ValidationError('Notes must be converted to tasks before being claimed', 'NOTE_REQUIRES_TRIAGE');
  }

  return db.transaction((tx) => {
    // Atomic: only claim if status=new AND unassigned
    const result = tx.update(scoutItems)
      .set({
        status: 'in_progress',
        assigneeId: user.id,
        updatedAt: now(),
      })
      .where(and(
        eq(scoutItems.id, itemId),
        eq(scoutItems.status, 'new'),
        isNull(scoutItems.assigneeId),
      ))
      .run();

    if (result.changes === 0) {
      const item = tx.select().from(scoutItems).where(eq(scoutItems.id, itemId)).get();
      if (!item) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
      throw new ConflictError('Item already claimed or not in "new" status', 'CONFLICT');
    }

    addAutoNote(tx, itemId, user.id, JSON.stringify({ type: 'assignment', userName: user.name }), 'assignment');
    addAutoNote(tx, itemId, user.id, JSON.stringify({ type: 'status_change', from: 'new', to: 'in_progress' }), 'status_change');

    return tx.select().from(scoutItems).where(eq(scoutItems.id, itemId)).get()!;
  });
}

export function updateItemStatus(
  itemId: string,
  newStatus: ItemStatus,
  user: User,
  extra?: {
    branchName?: string;
    mrUrl?: string;
    attemptCount?: number;
    resolutionNote?: string;
    evidence?: ItemEvidenceInput;
  },
) {
  const item = db.select().from(scoutItems).where(eq(scoutItems.id, itemId)).get();
  if (!item) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
  if (item.itemType === 'note' && newStatus !== 'cancelled') {
    throw new ValidationError('Notes must be converted to tasks before workflow transitions', 'NOTE_REQUIRES_TRIAGE');
  }

  validateTransition(item.status as ItemStatus, newStatus);
  requireHandoffEvidence(item, newStatus, extra?.evidence, extra);

  return db.transaction((tx) => {
    const updateData: Record<string, unknown> = {
      status: newStatus,
      updatedAt: now(),
    };

    if (extra?.branchName !== undefined) updateData.branchName = extra.branchName;
    if (extra?.mrUrl !== undefined) updateData.mrUrl = extra.mrUrl;
    if (extra?.attemptCount !== undefined) updateData.attemptCount = extra.attemptCount;
    if (extra?.resolutionNote !== undefined) updateData.resolutionNote = extra.resolutionNote;

    if (newStatus === 'done') {
      updateData.resolvedById = user.id;
      updateData.resolvedAt = now();
    }

    if (newStatus === 'new') {
      updateData.assigneeId = null;
      updateData.resolvedById = null;
      updateData.resolvedAt = null;
    }

    if (newStatus === 'changes_requested' || newStatus === 'in_progress') {
      updateData.resolvedById = null;
      updateData.resolvedAt = null;
    }

    tx.update(scoutItems).set(updateData).where(eq(scoutItems.id, itemId)).run();
    if (extra?.evidence) addEvidence(tx, itemId, user.id, extra.evidence);
    addAutoNote(tx, itemId, user.id, JSON.stringify({ type: 'status_change', from: item.status, to: newStatus }), 'status_change');

    return tx.select().from(scoutItems).where(eq(scoutItems.id, itemId)).get()!;
  });
}

export function addItemEvidence(itemId: string, user: User, evidence: ItemEvidenceInput) {
  const item = db.select().from(scoutItems).where(eq(scoutItems.id, itemId)).get();
  if (!item) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');

  return db.transaction((tx) => {
    const evidenceId = addEvidence(tx, itemId, user.id, evidence);
    return tx.select().from(scoutItemEvidence).where(eq(scoutItemEvidence.id, evidenceId)).get()!;
  });
}

export function updateItem(itemId: string, data: {
  itemType?: ItemType;
  message?: string;
  assigneeId?: string | null;
  priority?: ItemPriority;
  labels?: string[];
}, user?: User) {
  const item = db.select().from(scoutItems).where(eq(scoutItems.id, itemId)).get();
  if (!item) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');

  const updates: Record<string, unknown> = { updatedAt: now() };
  const nextItemType = data.itemType ?? item.itemType;
  if (data.itemType !== undefined) updates.itemType = data.itemType;
  if (data.message !== undefined) updates.message = data.message;
  if (data.assigneeId !== undefined) updates.assigneeId = data.assigneeId;
  if (nextItemType === 'note') updates.priority = null;
  else if (data.priority !== undefined) updates.priority = data.priority;
  else if (data.itemType !== undefined && item.priority === null) updates.priority = 'medium';
  if (data.labels !== undefined) updates.labels = JSON.stringify(data.labels);

  return db.transaction((tx) => {
    tx.update(scoutItems).set(updates).where(eq(scoutItems.id, itemId)).run();
    if (user && data.itemType !== undefined && item.itemType !== data.itemType) {
      addAutoNote(tx, itemId, user.id, JSON.stringify({ type: 'type_change', from: item.itemType, to: data.itemType }), 'type_change');
    }
    return tx.select().from(scoutItems).where(eq(scoutItems.id, itemId)).get()!;
  });
}

export function reopenItem(
  itemId: string,
  user: User,
  targetStatus: Extract<ItemStatus, 'new' | 'in_progress'> = 'new',
  extra?: {
    reason?: 'audit_failed' | 'audit_blocked' | 'staging_failed' | 'regression' | 'manual';
    auditResult?: 'fail' | 'blocked';
  },
) {
  const item = db.select().from(scoutItems).where(eq(scoutItems.id, itemId)).get();
  if (!item) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
  if (item.itemType === 'note' && targetStatus !== 'new') {
    throw new ValidationError('Notes must be converted to tasks before workflow transitions', 'NOTE_REQUIRES_TRIAGE');
  }

  validateTransition(item.status as ItemStatus, 'new');

  return db.transaction((tx) => {
    tx.update(scoutItems).set({
      status: targetStatus,
      assigneeId: targetStatus === 'in_progress' ? user.id : null,
      resolvedById: null,
      resolvedAt: null,
      updatedAt: now(),
    }).where(eq(scoutItems.id, itemId)).run();

    addAutoNote(
      tx,
      itemId,
      user.id,
      JSON.stringify({
        type: 'reopen',
        from: item.status,
        to: targetStatus,
        ...(extra?.reason ? { reason: extra.reason } : {}),
        ...(extra?.auditResult ? { auditResult: extra.auditResult } : {}),
      }),
      'status_change',
    );

    return tx.select().from(scoutItems).where(eq(scoutItems.id, itemId)).get()!;
  });
}

export function deleteItem(itemId: string): void {
  const item = db.select().from(scoutItems).where(eq(scoutItems.id, itemId)).get();
  if (!item) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');

  // Delete from DB first — if this fails, files remain (can be cleaned up later)
  db.delete(scoutItems).where(eq(scoutItems.id, itemId)).run();

  // Clean up files after successful DB delete
  deleteFile(item.screenshotPath);
  deleteFile(item.sessionRecordingPath);
}
