import { z } from 'zod';
import { ITEM_STATUSES, WEBHOOK_EVENT_TYPES } from '../db/schema.js';
import { normalizeOrigin } from './origins.js';

// === Shared ===
const paginationSchema = z.object({
  page: z.number().int().min(1).default(1),
  perPage: z.number().int().min(1).max(100).default(20),
});

const uuidSchema = z.string().uuid();
const projectSlugSchema = z.string()
  .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
  .min(2)
  .max(50);

function withIdAlias<T extends z.ZodRawShape>(targetKey: 'id' | 'itemId', schema: z.ZodObject<T>) {
  return z.preprocess((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const record = input as Record<string, unknown>;
    const sourceKey = targetKey === 'id' ? 'itemId' : 'id';
    if (record[targetKey] !== undefined || record[sourceKey] === undefined) return input;
    return { ...record, [targetKey]: record[sourceKey] };
  }, schema);
}

const allowedOriginSchema = z.string().url().max(500).transform((value, ctx) => {
  try {
    return normalizeOrigin(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Allowed origin must use http or https' });
    return z.NEVER;
  }
});

const base64Schema = (maxLength: number) => z.string()
  .max(maxLength)
  .refine((value) => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), {
    message: 'Must be valid base64',
  });

const itemEvidenceSchema = z.object({
  kind: z.enum(['handoff', 'verification', 'audit', 'blocker']).default('handoff'),
  result: z.enum(['pass', 'fail', 'blocked', 'partial']).optional(),
  level: z.enum([
    'static',
    'typecheck',
    'api_smoke',
    'browser_smoke',
    'browser_acceptance',
    'local_acceptance',
    'staging_acceptance',
    'production_acceptance',
    'user_acceptance',
  ]).optional(),
  coverage: z.enum(['item', 'shared_root_cluster', 'route_sweep', 'audit_sample']).optional(),
  environment: z.string().min(1).max(100),
  role: z.string().max(100).optional(),
  url: z.string().max(1000).optional(),
  scenario: z.string().min(1).max(2000),
  action: z.string().min(1).max(2000),
  visibleResult: z.string().min(1).max(2000),
  acceptanceScope: z.string().max(2000).optional(),
  consoleResult: z.string().max(2000).optional(),
  networkResult: z.string().max(2000).optional(),
  apiResult: z.string().max(2000).optional(),
  dbResult: z.string().max(2000).optional(),
  fixture: z.string().max(1000).optional(),
  cleanupResult: z.string().max(2000).optional(),
  commitSha: z.string().max(100).optional(),
  deploySha: z.string().max(100).optional(),
  risks: z.string().max(2000).optional(),
  uncheckedRisks: z.string().max(2000).optional(),
  source: z.enum(['agent', 'human', 'ci', 'deploy', 'audit']).optional(),
  verifiedAt: z.string().datetime().optional(),
});

// === Auth ===
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// === Projects ===
export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  slug: projectSlugSchema,
  allowedOrigins: z.array(allowedOriginSchema).default([]),
});

export const updateProjectSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(100).optional(),
  allowedOrigins: z.array(allowedOriginSchema).optional(),
  isActive: z.boolean().optional(),
});

export const getProjectSchema = z.object({ id: uuidSchema });
export const deleteProjectSchema = z.object({ id: uuidSchema });
export const listProjectsSchema = paginationSchema;

// === Users ===
const passwordSchema = z.string().min(8).max(128).regex(
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/,
  'Пароль должен содержать строчную, заглавную букву и цифру',
);

export const projectRoleSchema = z.enum(['owner', 'manager', 'developer', 'reporter', 'viewer']);

export const userProjectRoleSchema = z.object({
  projectId: uuidSchema,
  role: projectRoleSchema,
});

export const createUserSchema = z.object({
  email: z.string().email(),
  password: passwordSchema,
  name: z.string().min(1).max(100),
  role: z.enum(['admin', 'member']),
  projectRoles: z.array(userProjectRoleSchema).default([]),
});

export const updateUserSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(100).optional(),
  role: z.enum(['admin', 'member']).optional(),
  isActive: z.boolean().optional(),
  projectRoles: z.array(userProjectRoleSchema).optional(),
  password: passwordSchema.optional(),
});

export const getUserSchema = z.object({ id: uuidSchema });
export const deleteUserSchema = z.object({ id: uuidSchema });
export const listUsersSchema = paginationSchema.extend({
  projectId: uuidSchema.optional(),
});

// === Items ===
const itemTypeSchema = z.enum(['bug', 'note', 'task']);
const itemStatusSchema = z.enum(ITEM_STATUSES);
const updateItemStatusTargetSchema = z.enum(['in_progress', 'review']);

export const createItemSchema = z.object({
  projectId: uuidSchema,
  itemType: itemTypeSchema.default('bug'),
  message: z.string().min(3),
  dedupeKey: z.string().min(8).max(200).optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  labels: z.array(z.string().max(50)).max(10).optional(),
  pageUrl: z.string().max(500).nullish(),
  pageRoute: z.string().max(255).nullish(),
  componentFile: z.string().max(255).nullish(),
  cssSelector: z.string().max(1000).nullish(),
  elementText: z.string().transform((v) => v?.substring(0, 500)).nullish(),
  elementHtml: z.string().transform((v) => v?.substring(0, 2000)).nullish(),
  viewportWidth: z.number().int().min(1).nullish(),
  viewportHeight: z.number().int().min(1).nullish(),
  screenshot: base64Schema(7_000_000).nullish(),       // base64, ~5MB file
  // Full validation happens in the item service so widget reports can degrade gracefully.
  sessionRecording: z.string().max(3_000_000).nullish(),
  metadata: z.record(z.string()).nullish(),               // auto-captured environment data
  debugContext: z.record(z.unknown()).nullish(),           // structured browser diagnostics
});

export const listItemsSchema = z.object({
  page: z.number().int().min(1).default(1),
  perPage: z.number().int().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  projectId: uuidSchema.optional(),
  projectSlug: projectSlugSchema.optional(),
  itemType: itemTypeSchema.optional(),
  status: itemStatusSchema.optional(),
  statuses: z.array(itemStatusSchema).min(1).max(ITEM_STATUSES.length).optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  assigneeId: uuidSchema.optional(),
  search: z.string().max(200).optional(),
}).refine((value) => value.projectId || value.projectSlug, {
  message: 'projectId or projectSlug is required',
  path: ['projectId'],
});

export const getItemSchema = withIdAlias('id', z.object({ id: uuidSchema }));

export const countItemsSchema = z.object({
  projectId: uuidSchema.optional(),
  projectSlug: projectSlugSchema.optional(),
  itemType: itemTypeSchema.optional(),
  status: itemStatusSchema.optional(),
}).refine((value) => value.projectId || value.projectSlug, {
  message: 'projectId or projectSlug is required',
  path: ['projectId'],
});

export const claimItemSchema = withIdAlias('id', z.object({ id: uuidSchema }));

export const resolveItemSchema = withIdAlias('id', z.object({
  id: uuidSchema,
  resolutionNote: z.string().max(5000).optional(),
  branchName: z.string().max(255).optional(),
  mrUrl: z.string().url().max(500).optional(),
  evidence: itemEvidenceSchema.optional(),
}));

export const cancelItemSchema = withIdAlias('id', z.object({ id: uuidSchema }));

export const updateItemStatusSchema = withIdAlias('id', z.object({
  id: uuidSchema,
  status: updateItemStatusTargetSchema,
  branchName: z.string().max(255).optional(),
  mrUrl: z.string().url().max(500).optional(),
  attemptCount: z.number().int().min(0).optional(),
  evidence: itemEvidenceSchema.optional(),
}));

export const verifyItemSchema = withIdAlias('id', z.object({
  id: uuidSchema,
  comment: z.string().max(5000).optional(),
  evidence: itemEvidenceSchema.optional(),
}));

export const requestChangesItemSchema = withIdAlias('id', z.object({
  id: uuidSchema,
  summary: z.string().min(3).max(2000),
  expected: z.string().min(1).max(2000),
  actual: z.string().min(1).max(2000),
  steps: z.string().max(5000).optional(),
  url: z.string().max(1000).optional(),
  evidence: itemEvidenceSchema.optional(),
}));

export const deleteItemSchema = withIdAlias('id', z.object({ id: uuidSchema }));

export const updateItemSchema = withIdAlias('id', z.object({
  id: uuidSchema,
  itemType: itemTypeSchema.optional(),
  message: z.string().min(3).optional(),
  assigneeId: uuidSchema.nullish(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  labels: z.array(z.string().max(50)).max(10).optional(),
}));

export const reopenItemSchema = withIdAlias('id', z.object({
  id: uuidSchema,
  status: z.enum(['new', 'in_progress']).optional(),
  reason: z.enum(['audit_failed', 'audit_blocked', 'staging_failed', 'regression', 'manual']).optional(),
  auditResult: z.enum(['fail', 'blocked']).optional(),
}));

export const addNoteSchema = withIdAlias('itemId', z.object({
  itemId: uuidSchema,
  content: z.string().min(1).max(5000),
}));

export const addEvidenceSchema = withIdAlias('itemId', itemEvidenceSchema.extend({
  itemId: uuidSchema,
}));

export const itemLinkTypeSchema = z.enum(['related', 'duplicate', 'blocks', 'blocked_by', 'caused_by', 'conflicts']);

export const linkItemSchema = z.object({
  sourceItemId: uuidSchema,
  targetItemId: uuidSchema,
  type: itemLinkTypeSchema.default('related'),
});

export const unlinkItemSchema = z.object({
  id: uuidSchema,
});

// === API Keys ===
const apiKeyPurposeEnum = z.enum(['agent', 'ci', 'integration', 'custom']);
const apiKeyScopeEnum = z.enum([
  'items:read',
  'items:create',
  'items:comment',
  'items:workflow',
  'items:triage',
  'storage:read',
  'errors:read',
  'errors:write',
  'errors:triage',
]);

export const createApiKeySchema = z.object({
  projectId: uuidSchema,
  name: z.string().min(1).max(100),
  purpose: apiKeyPurposeEnum.default('custom'),
  scopes: z.array(apiKeyScopeEnum).min(1).optional(),
  expiresAt: z.string().datetime().optional(),
});

export const listApiKeysSchema = z.object({
  projectId: uuidSchema,
});

export const revokeApiKeySchema = z.object({
  id: uuidSchema,
});

// === Auth Validation ===
export const validateTokenSchema = z.object({
  token: z.string().min(1),
});

// === Webhooks ===
const webhookEventEnum = z.enum(WEBHOOK_EVENT_TYPES);

export const createWebhookSchema = z.object({
  projectId: uuidSchema,
  url: z.string().url().max(500),
  secret: z.string().max(255).optional(),
  events: z.array(webhookEventEnum).min(1),
});

export const updateWebhookSchema = z.object({
  id: uuidSchema,
  url: z.string().url().max(500).optional(),
  secret: z.string().max(255).nullable().optional(),
  events: z.array(webhookEventEnum).min(1).optional(),
  isActive: z.boolean().optional(),
});

export const deleteWebhookSchema = z.object({ id: uuidSchema });
export const listWebhooksSchema = z.object({ projectId: uuidSchema });
export const testWebhookSchema = z.object({ id: uuidSchema });

// === Notifications ===
export const runDailyDigestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dryRun: z.boolean().optional(),
  force: z.boolean().optional(),
  recipientEmail: z.string().email().optional(),
});

// === Error integrations ===
const boundedUrlSchema = z.string().url().max(1000).optional();
const errorSeveritySchema = z.enum(['info', 'warning', 'critical']);
const errorStateSchema = z.enum(['active', 'ignored', 'resolved']);

export const errorUpsertSchema = z.object({
  projectId: uuidSchema.optional(),
  projectSlug: z.string().min(1).max(80).optional(),
  source: z.string().min(1).max(80).default('alertmanager'),
  fingerprint: z.string().min(1).max(200),
  environment: z.string().min(1).max(80),
  service: z.string().min(1).max(120),
  routeTemplate: z.string().max(300).optional(),
  method: z.string().max(20).optional(),
  upstreamService: z.string().max(120).optional(),
  errorType: z.string().min(1).max(120),
  statusCode: z.number().int().min(100).max(599).optional(),
  statusClass: z.string().max(20).optional(),
  severity: errorSeveritySchema.default('warning'),
  occurredAt: z.string().datetime().optional(),
  sampleRequestId: z.string().max(160).optional(),
  sampleTraceId: z.string().max(160).optional(),
  grafanaLogsUrl: boundedUrlSchema,
  grafanaTraceUrl: boundedUrlSchema,
  samplePayload: z.record(z.unknown()).optional(),
  title: z.string().max(240).optional(),
  message: z.string().max(4000).optional(),
  release: z.string().max(120).optional(),
  cooldownKey: z.string().max(120).optional(),
}).refine((value) => value.projectId || value.projectSlug, {
  message: 'projectId or projectSlug is required',
  path: ['projectId'],
});

export const listErrorGroupsSchema = paginationSchema.extend({
  projectId: uuidSchema,
  state: errorStateSchema.optional(),
  service: z.string().max(120).optional(),
  environment: z.string().max(80).optional(),
  severity: errorSeveritySchema.optional(),
  linkedItemId: uuidSchema.optional(),
});

export const getErrorGroupSchema = z.object({ id: uuidSchema });

export const ignoreErrorGroupSchema = z.object({
  id: uuidSchema,
  ignoredUntil: z.string().datetime().optional(),
  ignoreReason: z.string().min(1).max(1000),
});

export const unignoreErrorGroupSchema = z.object({ id: uuidSchema });

export const alertmanagerWebhookSchema = z.object({
  version: z.string().optional(),
  groupKey: z.string().max(500).optional(),
  status: z.enum(['firing', 'resolved']).optional(),
  receiver: z.string().max(120).optional(),
  groupLabels: z.record(z.string()).optional(),
  commonLabels: z.record(z.string()).optional(),
  commonAnnotations: z.record(z.string()).optional(),
  externalURL: z.string().max(1000).optional(),
  alerts: z.array(z.object({
    status: z.enum(['firing', 'resolved']),
    labels: z.record(z.string()).default({}),
    annotations: z.record(z.string()).default({}),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
    generatorURL: z.string().max(1000).optional(),
    fingerprint: z.string().max(200).optional(),
  })).min(1).max(50),
});
