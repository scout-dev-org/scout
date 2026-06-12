import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { errorGroups } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';
import { checkProjectAccess, requireProjectPermission } from '../middleware/permissions.js';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../lib/errors.js';
import { alertmanagerWebhookSchema, errorUpsertSchema, getErrorGroupSchema, ignoreErrorGroupSchema, listErrorGroupsSchema, unignoreErrorGroupSchema } from '../lib/schemas.js';
import { enqueueBridgeJob, getBridgeStatus, ignoreErrorGroup, listErrorGroups, processBridgeJobs, resolveErrorProjectId, unignoreErrorGroup, upsertErrorGroup } from '../services/error-groups.js';
import { eventBus } from '../lib/event-bus.js';
import { HTTPException } from 'hono/http-exception';
import { dispatchWebhooks } from '../services/webhooks.js';

const BRIDGE_SECRET_HEADER = 'x-scout-error-bridge-secret';

function requireBridgeSecret(c: { req: { header: (name: string) => string | undefined } }): void {
  const configuredSecret = process.env.SCOUT_ERROR_BRIDGE_SECRET?.trim();
  if (!configuredSecret) throw new HTTPException(503, { message: 'Scout error bridge is disabled' });

  const authorization = c.req.header('authorization')?.trim() ?? '';
  const bearerSecret = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
  const providedSecret = c.req.header(BRIDGE_SECRET_HEADER)?.trim() || bearerSecret;
  const configured = Buffer.from(configuredSecret);
  const provided = Buffer.from(providedSecret);
  if (configured.length !== provided.length || !timingSafeEqual(configured, provided)) {
    throw new UnauthorizedError('Invalid bridge secret', 'BRIDGE_SECRET_INVALID');
  }
}

export const integrationsErrorsRoutes = new Hono()
  .post('/upsert', authMiddleware, zValidator('json', errorUpsertSchema), async (c) => {
    const input = c.req.valid('json');
    const user = c.get('user');
    const apiKey = c.get('apiKey');
    const projectId = resolveErrorProjectId(input);
    requireProjectPermission(user.id, user.role, projectId, 'write_errors', apiKey);
    const group = upsertErrorGroup(input, projectId);
    const eventType = group.occurrenceCount === 1 ? 'error_group.created' : 'error_group.updated';
    dispatchWebhooks(group.projectId, eventType, { errorGroup: group }).catch(() => {});
    eventBus.publish({ type: eventType, projectId: group.projectId, payload: { errorGroup: group } });
    return c.json({ data: { errorGroup: group } }, group.occurrenceCount === 1 ? 201 : 200);
  })
  .post('/list', authMiddleware, zValidator('json', listErrorGroupsSchema), async (c) => {
    const input = c.req.valid('json');
    const user = c.get('user');
    if (!checkProjectAccess(user.id, user.role, input.projectId, c.get('apiKey'))) throw new ForbiddenError('Нет доступа к этому проекту', 'NO_PROJECT_ACCESS');
    return c.json({ data: listErrorGroups(input) });
  })
  .post('/get', authMiddleware, zValidator('json', getErrorGroupSchema), async (c) => {
    const { id } = c.req.valid('json');
    const group = db.select().from(errorGroups).where(eq(errorGroups.id, id)).get();
    if (!group) throw new NotFoundError('Error group', 'ERROR_GROUP_NOT_FOUND');
    const user = c.get('user');
    if (!checkProjectAccess(user.id, user.role, group.projectId, c.get('apiKey'))) throw new ForbiddenError('Нет доступа к этому проекту', 'NO_PROJECT_ACCESS');
    return c.json({ data: { errorGroup: group } });
  })
  .post('/ignore', authMiddleware, zValidator('json', ignoreErrorGroupSchema), async (c) => {
    const input = c.req.valid('json');
    const existing = db.select().from(errorGroups).where(eq(errorGroups.id, input.id)).get();
    if (!existing) throw new NotFoundError('Error group', 'ERROR_GROUP_NOT_FOUND');
    const user = c.get('user');
    requireProjectPermission(user.id, user.role, existing.projectId, 'triage_errors', c.get('apiKey'));
    const group = ignoreErrorGroup(input.id, input.ignoreReason, input.ignoredUntil);
    dispatchWebhooks(group.projectId, 'error_group.updated', { errorGroup: group }).catch(() => {});
    eventBus.publish({ type: 'error_group.updated', projectId: group.projectId, payload: { errorGroup: group } });
    return c.json({ data: { errorGroup: group } });
  })
  .post('/unignore', authMiddleware, zValidator('json', unignoreErrorGroupSchema), async (c) => {
    const input = c.req.valid('json');
    const existing = db.select().from(errorGroups).where(eq(errorGroups.id, input.id)).get();
    if (!existing) throw new NotFoundError('Error group', 'ERROR_GROUP_NOT_FOUND');
    const user = c.get('user');
    requireProjectPermission(user.id, user.role, existing.projectId, 'triage_errors', c.get('apiKey'));
    const group = unignoreErrorGroup(input.id);
    dispatchWebhooks(group.projectId, 'error_group.updated', { errorGroup: group }).catch(() => {});
    eventBus.publish({ type: 'error_group.updated', projectId: group.projectId, payload: { errorGroup: group } });
    return c.json({ data: { errorGroup: group } });
  })
  .post('/bridge/alertmanager', zValidator('json', alertmanagerWebhookSchema), async (c) => {
    requireBridgeSecret(c);
    const job = enqueueBridgeJob(c.req.valid('json'));
    await processBridgeJobs(10);
    return c.json({ data: { queued: true, ...job } }, job.inserted ? 202 : 200);
  })
  .get('/bridge/health', (c) => c.json({ data: { status: 'ok', queue: getBridgeStatus() } }));
