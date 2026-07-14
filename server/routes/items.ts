import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and, desc, count, like, or, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ITEM_STATUSES, scoutItems, scoutItemNotes, scoutItemEvidence, scoutItemLinks, projects, users, errorGroups, type ApiKey, type ItemSource, type ScoutItemLink } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';
import { checkProjectAccess, hasProjectPermission, requireProjectPermission } from '../middleware/permissions.js';
import { randomUUID } from 'node:crypto';
import { NotFoundError, ForbiddenError, ConflictError } from '../lib/errors.js';
import {
  createItemSchema, listItemsSchema, getItemSchema,
  countItemsSchema, claimItemSchema, resolveItemSchema,
  cancelItemSchema, updateItemStatusSchema, verifyItemSchema, requestChangesItemSchema, addNoteSchema, addEvidenceSchema,
  deleteItemSchema, updateItemSchema, reopenItemSchema,
  linkItemSchema, unlinkItemSchema,
} from '../lib/schemas.js';
import { createItem, claimItem, resolveItem, updateItemStatus, deleteItem, updateItem, reopenItem, addItemEvidence } from '../services/items.js';
import { logAudit, getClientIp } from '../services/audit.js';
import { dispatchWebhooks } from '../services/webhooks.js';
import { eventBus } from '../lib/event-bus.js';

/** Resolve user name by id, with simple cache */
const userNameCache = new Map<string, string>();
function getUserName(userId: string | null): string | null {
  if (!userId) return null;
  if (userNameCache.has(userId)) return userNameCache.get(userId)!;
  const user = db.select({ name: users.name }).from(users).where(eq(users.id, userId)).get();
  const name = user?.name ?? null;
  if (name) userNameCache.set(userId, name);
  return name;
}

function enrichItem(item: typeof scoutItems.$inferSelect) {
  return {
    ...item,
    reporterName: getUserName(item.reporterId),
    assigneeName: getUserName(item.assigneeId),
  };
}

function getItemPermissions(item: typeof scoutItems.$inferSelect, user: typeof users.$inferSelect, apiKey: ApiKey | null) {
  const isNote = item.itemType === 'note';
  const canWorkflow = hasProjectPermission(user.id, user.role, item.projectId, 'workflow', apiKey);
  const canTriage = hasProjectPermission(user.id, user.role, item.projectId, 'triage', apiKey);
  const canComment = hasProjectPermission(user.id, user.role, item.projectId, 'comment', apiKey);
  const canUseGenericStatusUpdate = ['in_progress', 'review', 'changes_requested'].includes(item.status);
  const canCancelOwnNew = item.status === 'new' && item.reporterId === user.id && canComment;
  return {
    canClaim: !isNote && item.status === 'new' && canWorkflow,
    canUpdateStatus: !isNote && canWorkflow && canUseGenericStatusUpdate,
    canResolve: !isNote && canWorkflow,
    canVerify: !isNote && canTriage && item.status === 'done',
    canRequestChanges: !isNote && canTriage && (item.status === 'review' || item.status === 'done' || item.status === 'verified'),
    canCancel: canTriage || canCancelOwnNew,
    canReopen: canTriage,
    canUpdate: canTriage,
    canDelete: canTriage,
    canComment,
    canLinkItems: canWorkflow,
  };
}

function deriveItemSource(data: ReturnType<typeof createItemSchema.parse>, apiKey: ApiKey | null): ItemSource {
  if (apiKey?.purpose === 'agent') return 'agent';
  if (apiKey) return 'api';
  if (data.pageUrl || data.cssSelector || data.screenshot || data.sessionRecording || data.debugContext) return 'widget';
  return 'dashboard';
}

function getRelatedItems(itemId: string) {
  const links = db.select().from(scoutItemLinks)
    .where(or(eq(scoutItemLinks.sourceItemId, itemId), eq(scoutItemLinks.targetItemId, itemId)))
    .orderBy(desc(scoutItemLinks.createdAt))
    .all();

  return links.map((link) => {
    const relatedId = link.sourceItemId === itemId ? link.targetItemId : link.sourceItemId;
    const related = db.select().from(scoutItems).where(eq(scoutItems.id, relatedId)).get();
    if (!related) return null;
    return {
      id: link.id,
      type: link.type,
      direction: link.sourceItemId === itemId ? 'outgoing' : 'incoming',
      createdAt: link.createdAt,
      item: enrichItem(related),
    };
  }).filter((link): link is NonNullable<typeof link> => link !== null);
}

function getItemEvidence(itemId: string) {
  return db.select().from(scoutItemEvidence)
    .where(eq(scoutItemEvidence.itemId, itemId))
    .orderBy(desc(scoutItemEvidence.createdAt))
    .all()
    .map((entry) => ({
      ...entry,
      userName: getUserName(entry.userId),
    }));
}

function normalizeLinkPair(sourceItemId: string, targetItemId: string, type: ScoutItemLink['type']) {
  if (type === 'blocks' || type === 'blocked_by' || type === 'caused_by') {
    return { sourceItemId, targetItemId, type };
  }
  return sourceItemId < targetItemId
    ? { sourceItemId, targetItemId, type }
    : { sourceItemId: targetItemId, targetItemId: sourceItemId, type };
}

function formatRequestChangesNote(data: { summary: string; expected: string; actual: string; steps?: string; url?: string }) {
  return [
    'Нужны правки',
    `Проблема: ${data.summary}`,
    `Ожидалось: ${data.expected}`,
    `Фактически: ${data.actual}`,
    data.steps ? `Шаги: ${data.steps}` : null,
    data.url ? `URL: ${data.url}` : null,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export const itemRoutes = new Hono()
  .use('/*', authMiddleware)

  // CREATE — project reporter/developer/manager/owner, or system admin
  .post('/create',
    zValidator('json', createItemSchema),
    async (c) => {
      const data = c.req.valid('json');
      const user = c.get('user');

      // Verify project exists
      const project = db.select().from(projects).where(eq(projects.id, data.projectId)).get();
      if (!project) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');

      requireProjectPermission(user.id, user.role, data.projectId, 'create_item', c.get('apiKey'));

      const source = deriveItemSource(data, c.get('apiKey'));
      const { item, deduped } = createItem({ ...data, reporterId: user.id, source });
      if (!deduped) {
        logAudit({ userId: user.id, action: 'create_item', entityType: 'item', entityId: item.id, details: { projectId: data.projectId, itemType: item.itemType, source: item.source, priority: item.priority }, ipAddress: getClientIp(c) });
        dispatchWebhooks(data.projectId, 'item.created', { item }).catch(() => {});
        eventBus.publish({ type: 'item.created', projectId: data.projectId, payload: { item } });
      }
      return c.json({ data: item }, deduped ? 200 : 201);
    })

  // LIST — all roles
  .post('/list',
    zValidator('json', listItemsSchema),
    async (c) => {
      const { projectId, itemType, status, statuses, priority, assigneeId, search, page, perPage } = c.req.valid('json');
      const user = c.get('user');
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
      const pageSize = perPage ?? 20;

      // Check project access
      if (!checkProjectAccess(user.id, user.role, projectId, c.get('apiKey'))) {
        throw new ForbiddenError('Нет доступа к этому проекту', 'NO_PROJECT_ACCESS');
      }

      const conditions = [eq(scoutItems.projectId, projectId)];
      if (itemType) conditions.push(eq(scoutItems.itemType, itemType));
      if (status) conditions.push(eq(scoutItems.status, status));
      else if (statuses) conditions.push(inArray(scoutItems.status, statuses));
      if (priority) conditions.push(eq(scoutItems.priority, priority));
      if (assigneeId) conditions.push(eq(scoutItems.assigneeId, assigneeId));
      if (search) conditions.push(like(scoutItems.message, `%${search}%`));

      const where = conditions.length === 1 ? conditions[0]! : and(...conditions);

      const items = db.select().from(scoutItems)
        .where(where)
        .orderBy(desc(scoutItems.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();

      const [{ total }] = db.select({ total: count() }).from(scoutItems).where(where).all();

      return c.json({
        data: {
          items: items.map(enrichItem),
          pagination: {
            page,
            perPage: pageSize,
            total,
            totalPages: Math.ceil(total / pageSize),
          },
        },
      });
    })

  // GET — all roles (item + notes)
  .post('/get',
    zValidator('json', getItemSchema),
    async (c) => {
      const { id } = c.req.valid('json');
      const item = db.select().from(scoutItems).where(eq(scoutItems.id, id)).get();
      if (!item) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');

      const user = c.get('user');
      if (!checkProjectAccess(user.id, user.role, item.projectId, c.get('apiKey'))) {
        throw new ForbiddenError('Нет доступа к этому проекту', 'NO_PROJECT_ACCESS');
      }

      const notes = db.select().from(scoutItemNotes)
        .where(eq(scoutItemNotes.itemId, id))
        .orderBy(scoutItemNotes.createdAt)
        .all();

      const enrichedNotes = notes.map((n) => ({
        ...n,
        userName: getUserName(n.userId),
      }));

      return c.json({
        data: {
          ...enrichItem(item),
          notes: enrichedNotes,
          evidence: getItemEvidence(id),
          errorGroups: db.select().from(errorGroups).where(eq(errorGroups.linkedItemId, id)).orderBy(desc(errorGroups.lastSeenAt)).all(),
          relatedItems: getRelatedItems(id),
          permissions: getItemPermissions(item, user, c.get('apiKey')),
        },
      });
    })

  // COUNT — all roles
  .post('/count',
    zValidator('json', countItemsSchema),
    async (c) => {
      const { projectId, itemType } = c.req.valid('json');
      const user = c.get('user');
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');

      // Check project access
      if (!checkProjectAccess(user.id, user.role, projectId, c.get('apiKey'))) {
        throw new ForbiddenError('Нет доступа к этому проекту', 'NO_PROJECT_ACCESS');
      }
      const counts: Record<string, number> = {};

      for (const status of ITEM_STATUSES) {
        const [{ total }] = db.select({ total: count() }).from(scoutItems)
          .where(and(
            eq(scoutItems.projectId, projectId),
            eq(scoutItems.status, status),
            ...(itemType ? [eq(scoutItems.itemType, itemType)] : []),
          ))
          .all();
        counts[status] = total;
      }

      return c.json({ data: { counts } });
    })

  // CLAIM — project developer/manager/owner, or system admin
  .post('/claim',
    zValidator('json', claimItemSchema),
    async (c) => {
      const { id, updatedAt } = c.req.valid('json');
      const user = c.get('user');

      // Check project access via item's projectId
      const existing = db.select({ projectId: scoutItems.projectId }).from(scoutItems).where(eq(scoutItems.id, id)).get();
      if (!existing) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
      requireProjectPermission(user.id, user.role, existing.projectId, 'workflow', c.get('apiKey'));

      const item = claimItem(id, user, { updatedAt });
      logAudit({ userId: user.id, action: 'claim_item', entityType: 'item', entityId: id, ipAddress: getClientIp(c) });
      dispatchWebhooks(existing.projectId, 'item.assigned', { item, assignee: { id: user.id, name: user.name, email: user.email } }).catch(() => {});
      eventBus.publish({ type: 'item.assigned', projectId: existing.projectId, payload: { item } });
      return c.json({ data: item });
    })

  // RESOLVE — project developer/manager/owner, or system admin
  .post('/resolve',
    zValidator('json', resolveItemSchema),
    async (c) => {
      const { id, updatedAt, resolutionNote, branchName, mrUrl, evidence } = c.req.valid('json');
      const user = c.get('user');

      // Check project access via item's projectId
      const existing = db.select({ projectId: scoutItems.projectId }).from(scoutItems).where(eq(scoutItems.id, id)).get();
      if (!existing) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
      requireProjectPermission(user.id, user.role, existing.projectId, 'workflow', c.get('apiKey'));

      const result = resolveItem(id, user, { updatedAt }, {
        resolutionNote, branchName, mrUrl, evidence,
      });
      const { item } = result;
      logAudit({ userId: user.id, action: 'resolve_item', entityType: 'item', entityId: id, details: { branchName, mrUrl }, ipAddress: getClientIp(c) });
      if (result.statusChanged) {
        dispatchWebhooks(existing.projectId, 'item.status_changed', { item, oldStatus: result.oldStatus, newStatus: 'done' }).catch(() => {});
        eventBus.publish({ type: 'item.status_changed', projectId: existing.projectId, payload: { item, oldStatus: result.oldStatus, newStatus: 'done' } });
      } else if (result.changed) {
        eventBus.publish({ type: 'item.updated', projectId: existing.projectId, payload: { item } });
      }
      return c.json({ data: item });
    })

  // CANCEL — project manager/owner/system admin, or reporter cancelling own new item
  .post('/cancel',
    zValidator('json', cancelItemSchema),
    async (c) => {
      const { id, updatedAt } = c.req.valid('json');
      const user = c.get('user');

      // Check project access via item's projectId
      const existing = db.select().from(scoutItems).where(eq(scoutItems.id, id)).get();
      if (!existing) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
      const canAttemptOwnCancel = existing.reporterId === user.id
        && hasProjectPermission(user.id, user.role, existing.projectId, 'comment', c.get('apiKey'));
      if (canAttemptOwnCancel && existing.updatedAt !== updatedAt) {
        throw new ConflictError('Item state changed concurrently; refresh and retry', 'ITEM_STATE_CONFLICT');
      }
      const canCancelOwnNew = existing.status === 'new' && canAttemptOwnCancel;
      if (!canCancelOwnNew) {
        requireProjectPermission(user.id, user.role, existing.projectId, 'triage', c.get('apiKey'));
      }

      const { item, oldStatus } = updateItemStatus(id, 'cancelled', user, { updatedAt });
      logAudit({ userId: user.id, action: 'cancel_item', entityType: 'item', entityId: id, ipAddress: getClientIp(c) });
      dispatchWebhooks(existing.projectId, 'item.status_changed', { item, oldStatus, newStatus: 'cancelled' }).catch(() => {});
      eventBus.publish({ type: 'item.status_changed', projectId: existing.projectId, payload: { item, oldStatus, newStatus: 'cancelled' } });
      return c.json({ data: item });
    })

  // UPDATE STATUS — project developer/manager/owner, or system admin
  .post('/update-status',
    zValidator('json', updateItemStatusSchema),
    async (c) => {
      const { id, updatedAt, status, branchName, mrUrl, attemptCount, evidence } = c.req.valid('json');
      const user = c.get('user');

      // Check project access via item's projectId
      const existing = db.select({ projectId: scoutItems.projectId }).from(scoutItems).where(eq(scoutItems.id, id)).get();
      if (!existing) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
      requireProjectPermission(user.id, user.role, existing.projectId, 'workflow', c.get('apiKey'));

      const { item, oldStatus } = updateItemStatus(id, status, user, { updatedAt }, {
        branchName, mrUrl, attemptCount, evidence,
      });
      logAudit({ userId: user.id, action: 'update_status', entityType: 'item', entityId: id, details: { status }, ipAddress: getClientIp(c) });
      dispatchWebhooks(existing.projectId, 'item.status_changed', { item, oldStatus, newStatus: status }).catch(() => {});
      eventBus.publish({ type: 'item.status_changed', projectId: existing.projectId, payload: { item, oldStatus, newStatus: status } });
      return c.json({ data: item });
    })

  // VERIFY — human acceptance after the AI agent has moved the item to done
  .post('/verify',
    zValidator('json', verifyItemSchema),
    async (c) => {
      const { id, updatedAt, comment, evidence } = c.req.valid('json');
      const user = c.get('user');

      const existing = db.select({ projectId: scoutItems.projectId }).from(scoutItems).where(eq(scoutItems.id, id)).get();
      if (!existing) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
      requireProjectPermission(user.id, user.role, existing.projectId, 'triage', c.get('apiKey'));

      const trimmedComment = comment?.trim();
      const { item, note, oldStatus } = updateItemStatus(
        id,
        'verified',
        user,
        { updatedAt },
        { evidence, comment: trimmedComment || undefined },
      );

      logAudit({ userId: user.id, action: 'verify_item', entityType: 'item', entityId: id, ipAddress: getClientIp(c) });
      dispatchWebhooks(existing.projectId, 'item.status_changed', { item, oldStatus, newStatus: 'verified' }).catch(() => {});
      if (note) dispatchWebhooks(existing.projectId, 'item.commented', { item, note }).catch(() => {});
      eventBus.publish({ type: 'item.status_changed', projectId: existing.projectId, payload: { item, oldStatus, newStatus: 'verified' } });
      if (note) eventBus.publish({ type: 'item.commented', projectId: existing.projectId, payload: { itemId: id } });
      return c.json({ data: enrichItem(item) });
    })

  // REQUEST CHANGES — human QA/reviewer rejection with actionable context for the agent
  .post('/request-changes',
    zValidator('json', requestChangesItemSchema),
    async (c) => {
      const { id, updatedAt, summary, expected, actual, steps, url, evidence } = c.req.valid('json');
      const user = c.get('user');

      const existing = db.select({ projectId: scoutItems.projectId }).from(scoutItems).where(eq(scoutItems.id, id)).get();
      if (!existing) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
      requireProjectPermission(user.id, user.role, existing.projectId, 'triage', c.get('apiKey'));

      const { item, note, oldStatus } = updateItemStatus(
        id,
        'changes_requested',
        user,
        { updatedAt },
        { evidence, comment: formatRequestChangesNote({ summary, expected, actual, steps, url }) },
      );

      logAudit({ userId: user.id, action: 'request_changes', entityType: 'item', entityId: id, details: { summary }, ipAddress: getClientIp(c) });
      dispatchWebhooks(existing.projectId, 'item.status_changed', { item, oldStatus, newStatus: 'changes_requested' }).catch(() => {});
      dispatchWebhooks(existing.projectId, 'item.commented', { item, note }).catch(() => {});
      eventBus.publish({ type: 'item.status_changed', projectId: existing.projectId, payload: { item, oldStatus, newStatus: 'changes_requested' } });
      eventBus.publish({ type: 'item.commented', projectId: existing.projectId, payload: { itemId: id } });
      return c.json({ data: enrichItem(item) });
    })

  // DELETE — project manager/owner, or system admin
  .post('/delete',
    zValidator('json', deleteItemSchema),
    async (c) => {
      const { id, updatedAt } = c.req.valid('json');
      const user = c.get('user');

      // Check project access via item's projectId
      const existing = db.select({ projectId: scoutItems.projectId }).from(scoutItems).where(eq(scoutItems.id, id)).get();
      if (!existing) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
      requireProjectPermission(user.id, user.role, existing.projectId, 'triage', c.get('apiKey'));

      deleteItem(id, { updatedAt });
      logAudit({ userId: user.id, action: 'delete_item', entityType: 'item', entityId: id, ipAddress: getClientIp(c) });
      dispatchWebhooks(existing.projectId, 'item.deleted', { itemId: id }).catch(() => {});
      eventBus.publish({ type: 'item.deleted', projectId: existing.projectId, payload: { itemId: id } });
      return c.json({ data: { ok: true } });
    })

  // UPDATE — project manager/owner, or system admin
  .post('/update',
    zValidator('json', updateItemSchema),
    async (c) => {
      const data = c.req.valid('json');
      const user = c.get('user');

      // Check project access via item's projectId
      const existing = db.select({ projectId: scoutItems.projectId }).from(scoutItems).where(eq(scoutItems.id, data.id)).get();
      if (!existing) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
      requireProjectPermission(user.id, user.role, existing.projectId, 'triage', c.get('apiKey'));

      const item = updateItem(data.id, {
        itemType: data.itemType,
        message: data.message,
        assigneeId: data.assigneeId,
        priority: data.priority,
        labels: data.labels,
      }, { updatedAt: data.updatedAt }, user);
      logAudit({ userId: user.id, action: 'update_item', entityType: 'item', entityId: data.id, details: { itemType: data.itemType, message: data.message, priority: data.priority, labels: data.labels }, ipAddress: getClientIp(c) });
      eventBus.publish({ type: 'item.updated', projectId: existing.projectId, payload: { item } });
      return c.json({ data: enrichItem(item) });
    })

  // REOPEN — project manager/owner, or system admin
  .post('/reopen',
    zValidator('json', reopenItemSchema),
    async (c) => {
      const { id, updatedAt, status, reason, auditResult } = c.req.valid('json');
      const user = c.get('user');

      // Check project access via item's projectId
      const existing = db.select({ projectId: scoutItems.projectId }).from(scoutItems).where(eq(scoutItems.id, id)).get();
      if (!existing) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
      requireProjectPermission(user.id, user.role, existing.projectId, 'triage', c.get('apiKey'));

      const newStatus: 'new' | 'in_progress' = status ?? 'new';
      const { item, oldStatus } = reopenItem(id, user, { updatedAt }, newStatus, { reason, auditResult });
      logAudit({ userId: user.id, action: 'reopen_item', entityType: 'item', entityId: id, details: { status: newStatus, reason, auditResult }, ipAddress: getClientIp(c) });
      dispatchWebhooks(existing.projectId, 'item.status_changed', { item, oldStatus, newStatus }).catch(() => {});
      eventBus.publish({ type: 'item.status_changed', projectId: existing.projectId, payload: { item, oldStatus, newStatus } });
      return c.json({ data: enrichItem(item) });
    })

  // ADD EVIDENCE — all roles with comment access
  .post('/add-evidence',
    zValidator('json', addEvidenceSchema),
    async (c) => {
      const { id, ...evidence } = c.req.valid('json');
      const user = c.get('user');

      const item = db.select().from(scoutItems).where(eq(scoutItems.id, id)).get();
      if (!item) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
      requireProjectPermission(user.id, user.role, item.projectId, 'comment', c.get('apiKey'));

      const record = addItemEvidence(id, user, evidence);
      logAudit({ userId: user.id, action: 'add_evidence', entityType: 'item', entityId: id, details: { kind: evidence.kind, environment: evidence.environment }, ipAddress: getClientIp(c) });
      return c.json({ data: { ...record, userName: getUserName(record.userId) } }, 201);
    })

  // ADD NOTE — all roles
  .post('/add-note',
    zValidator('json', addNoteSchema),
    async (c) => {
      const { id: itemId, content } = c.req.valid('json');
      const user = c.get('user');

      // Verify item exists
      const item = db.select().from(scoutItems).where(eq(scoutItems.id, itemId)).get();
      if (!item) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');

      requireProjectPermission(user.id, user.role, item.projectId, 'comment', c.get('apiKey'));

      const id = randomUUID();
      db.insert(scoutItemNotes).values({
        id, itemId, userId: user.id, content, type: 'comment',
      }).run();

      const note = db.select().from(scoutItemNotes).where(eq(scoutItemNotes.id, id)).get()!;
      dispatchWebhooks(item.projectId, 'item.commented', { item, note }).catch(() => {});
      eventBus.publish({ type: 'item.commented', projectId: item.projectId, payload: { itemId } });
      return c.json({ data: note }, 201);
    })

  // LINK — project developer/manager/owner, or system admin
  .post('/link',
    zValidator('json', linkItemSchema),
    async (c) => {
      const data = c.req.valid('json');
      const user = c.get('user');

      if (data.sourceItemId === data.targetItemId) {
        return c.json({ error: 'Item cannot be linked to itself', code: 'VALIDATION_FAILED' }, 400);
      }

      const source = db.select().from(scoutItems).where(eq(scoutItems.id, data.sourceItemId)).get();
      const target = db.select().from(scoutItems).where(eq(scoutItems.id, data.targetItemId)).get();
      if (!source || !target) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
      if (source.projectId !== target.projectId) {
        return c.json({ error: 'Items must belong to the same project', code: 'VALIDATION_FAILED' }, 400);
      }
      requireProjectPermission(user.id, user.role, source.projectId, 'workflow', c.get('apiKey'));

      const normalized = normalizeLinkPair(data.sourceItemId, data.targetItemId, data.type);
      const existing = db.select().from(scoutItemLinks)
        .where(and(
          eq(scoutItemLinks.sourceItemId, normalized.sourceItemId),
          eq(scoutItemLinks.targetItemId, normalized.targetItemId),
          eq(scoutItemLinks.type, normalized.type),
        ))
        .get();
      if (existing) return c.json({ data: existing });

      const id = randomUUID();
      db.insert(scoutItemLinks).values({
        id,
        sourceItemId: normalized.sourceItemId,
        targetItemId: normalized.targetItemId,
        type: normalized.type,
        createdById: user.id,
      }).run();

      const link = db.select().from(scoutItemLinks).where(eq(scoutItemLinks.id, id)).get()!;
      logAudit({ userId: user.id, action: 'link_item', entityType: 'item', entityId: data.sourceItemId, details: { targetItemId: data.targetItemId, type: data.type }, ipAddress: getClientIp(c) });
      eventBus.publish({ type: 'item.updated', projectId: source.projectId, payload: { item: enrichItem(source) } });
      eventBus.publish({ type: 'item.updated', projectId: target.projectId, payload: { item: enrichItem(target) } });
      return c.json({ data: link }, 201);
    })

  // UNLINK — project developer/manager/owner, or system admin
  .post('/unlink',
    zValidator('json', unlinkItemSchema),
    async (c) => {
      const { id } = c.req.valid('json');
      const user = c.get('user');

      const link = db.select().from(scoutItemLinks).where(eq(scoutItemLinks.id, id)).get();
      if (!link) throw new NotFoundError('Item link', 'NOT_FOUND');

      const source = db.select().from(scoutItems).where(eq(scoutItems.id, link.sourceItemId)).get();
      const target = db.select().from(scoutItems).where(eq(scoutItems.id, link.targetItemId)).get();
      const projectId = source?.projectId ?? target?.projectId;
      if (!projectId) throw new NotFoundError('Item', 'ITEM_NOT_FOUND');
      requireProjectPermission(user.id, user.role, projectId, 'workflow', c.get('apiKey'));

      db.delete(scoutItemLinks).where(eq(scoutItemLinks.id, id)).run();
      logAudit({ userId: user.id, action: 'unlink_item', entityType: 'item', entityId: link.sourceItemId, details: { targetItemId: link.targetItemId, type: link.type }, ipAddress: getClientIp(c) });
      if (source) eventBus.publish({ type: 'item.updated', projectId, payload: { item: enrichItem(source) } });
      if (target) eventBus.publish({ type: 'item.updated', projectId, payload: { item: enrichItem(target) } });
      return c.json({ data: { ok: true } });
    });
