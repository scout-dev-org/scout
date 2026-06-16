import { sqliteTable, text, integer, index, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// === Audit Log ===
export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(), // 'login', 'create_item', 'delete_item', 'update_status', 'create_user', 'delete_user', etc.
  entityType: text('entity_type'), // 'item', 'user', 'project', 'auth'
  entityId: text('entity_id'),
  details: text('details'), // JSON string with action-specific details
  ipAddress: text('ip_address'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// === Projects ===
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  allowedOrigins: text('allowed_origins').notNull().default('[]'), // JSON array
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// === Users ===
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').unique().notNull(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  role: text('role', { enum: ['admin', 'member'] }).notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// === Pivot: Users <-> Projects ===
export const pivotUsersProjects = sqliteTable('pivot_users_projects', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  role: text('role', {
    enum: ['owner', 'manager', 'developer', 'reporter', 'viewer'],
  }).notNull().default('reporter'),
}, (table) => [
  primaryKey({ columns: [table.userId, table.projectId] }),
]);

export const ITEM_STATUSES = ['new', 'in_progress', 'review', 'done', 'changes_requested', 'verified', 'cancelled'] as const;

// === Scout Items ===
export const scoutItems = sqliteTable('scout_items', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  itemType: text('item_type', { enum: ['bug', 'note', 'task'] }).notNull().default('bug'),
  source: text('source', { enum: ['widget', 'dashboard', 'api', 'agent'] }).notNull().default('widget'),
  message: text('message').notNull(),
  status: text('status', {
    enum: ITEM_STATUSES,
  }).notNull().default('new'),
  pageUrl: text('page_url'),
  pageRoute: text('page_route'),
  componentFile: text('component_file'),
  cssSelector: text('css_selector'),
  elementText: text('element_text'),
  elementHtml: text('element_html'),
  viewportWidth: integer('viewport_width'),
  viewportHeight: integer('viewport_height'),
  screenshotPath: text('screenshot_path'),
  sessionRecordingPath: text('session_recording_path'),
  priority: text('priority', { enum: ['critical', 'high', 'medium', 'low'] }).default('medium'),
  labels: text('labels'), // JSON array of strings
  metadata: text('metadata'),  // JSON string: auto-captured environment data (browser, OS, etc.)
  debugContext: text('debug_context'), // JSON string: browser diagnostics and rrweb recording summary
  reporterId: text('reporter_id').references(() => users.id, { onDelete: 'set null' }),
  assigneeId: text('assignee_id').references(() => users.id, { onDelete: 'set null' }),
  resolvedById: text('resolved_by_id').references(() => users.id, { onDelete: 'set null' }),
  resolutionNote: text('resolution_note'),
  branchName: text('branch_name'),
  mrUrl: text('mr_url'),
  attemptCount: integer('attempt_count').notNull().default(0),
  resolvedAt: text('resolved_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_items_project_status').on(table.projectId, table.status),
  index('idx_items_project_type').on(table.projectId, table.itemType),
  index('idx_items_project_created').on(table.projectId, table.createdAt),
  index('idx_items_assignee').on(table.assigneeId),
]);

// === Scout Item Notes ===
export const scoutItemNotes = sqliteTable('scout_item_notes', {
  id: text('id').primaryKey(),
  itemId: text('item_id').notNull().references(() => scoutItems.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  content: text('content').notNull(),
  type: text('type', {
    enum: ['comment', 'status_change', 'assignment', 'type_change'],
  }).notNull().default('comment'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_notes_item_created').on(table.itemId, table.createdAt),
]);

// === Scout Item Evidence ===
export const scoutItemEvidence = sqliteTable('scout_item_evidence', {
  id: text('id').primaryKey(),
  itemId: text('item_id').notNull().references(() => scoutItems.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  kind: text('kind', {
    enum: ['handoff', 'verification', 'audit', 'blocker'],
  }).notNull().default('handoff'),
  result: text('result', { enum: ['pass', 'fail', 'blocked', 'partial'] }),
  level: text('level', {
    enum: ['static', 'typecheck', 'api_smoke', 'browser_smoke', 'browser_acceptance', 'local_acceptance', 'staging_acceptance', 'production_acceptance', 'user_acceptance'],
  }),
  coverage: text('coverage', { enum: ['item', 'shared_root_cluster', 'route_sweep', 'audit_sample'] }),
  environment: text('environment').notNull(),
  role: text('role'),
  url: text('url'),
  scenario: text('scenario').notNull(),
  action: text('action').notNull(),
  visibleResult: text('visible_result').notNull(),
  acceptanceScope: text('acceptance_scope'),
  consoleResult: text('console_result'),
  networkResult: text('network_result'),
  apiResult: text('api_result'),
  dbResult: text('db_result'),
  fixture: text('fixture'),
  cleanupResult: text('cleanup_result'),
  commitSha: text('commit_sha'),
  deploySha: text('deploy_sha'),
  risks: text('risks'),
  uncheckedRisks: text('unchecked_risks'),
  source: text('source', { enum: ['agent', 'human', 'ci', 'deploy', 'audit'] }),
  verifiedAt: text('verified_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_evidence_item_created').on(table.itemId, table.createdAt),
]);

// === Scout Item Links ===
export const scoutItemLinks = sqliteTable('scout_item_links', {
  id: text('id').primaryKey(),
  sourceItemId: text('source_item_id').notNull().references(() => scoutItems.id, { onDelete: 'cascade' }),
  targetItemId: text('target_item_id').notNull().references(() => scoutItems.id, { onDelete: 'cascade' }),
  type: text('type', {
    enum: ['related', 'duplicate', 'blocks', 'blocked_by', 'caused_by', 'conflicts'],
  }).notNull().default('related'),
  createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_item_links_source').on(table.sourceItemId),
  index('idx_item_links_target').on(table.targetItemId),
  index('idx_item_links_source_target_type').on(table.sourceItemId, table.targetItemId, table.type),
]);

// === Error Groups ===
export const errorGroups = sqliteTable('error_groups', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  fingerprint: text('fingerprint').notNull(),
  environment: text('environment').notNull(),
  service: text('service').notNull(),
  routeTemplate: text('route_template'),
  method: text('method'),
  upstreamService: text('upstream_service'),
  errorType: text('error_type').notNull(),
  statusCode: integer('status_code'),
  statusClass: text('status_class'),
  severity: text('severity', { enum: ['info', 'warning', 'critical'] }).notNull().default('warning'),
  state: text('state', { enum: ['active', 'ignored', 'resolved'] }).notNull().default('active'),
  occurrenceCount: integer('occurrence_count').notNull().default(1),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  linkedItemId: text('linked_item_id').references(() => scoutItems.id, { onDelete: 'set null' }),
  ignoredUntil: text('ignored_until'),
  ignoreReason: text('ignore_reason'),
  sampleRequestId: text('sample_request_id'),
  sampleTraceId: text('sample_trace_id'),
  grafanaLogsUrl: text('grafana_logs_url'),
  grafanaTraceUrl: text('grafana_trace_url'),
  samplePayload: text('sample_payload'),
  lastRelease: text('last_release'),
  lastRegressionAt: text('last_regression_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_error_groups_project_env_fingerprint_unique').on(table.projectId, table.environment, table.fingerprint),
  index('idx_error_groups_project_state').on(table.projectId, table.state),
  index('idx_error_groups_project_service').on(table.projectId, table.service),
  index('idx_error_groups_linked_item').on(table.linkedItemId),
]);

export const errorGroupOccurrences = sqliteTable('error_group_occurrences', {
  id: text('id').primaryKey(),
  errorGroupId: text('error_group_id').notNull().references(() => errorGroups.id, { onDelete: 'cascade' }),
  occurredAt: text('occurred_at').notNull(),
  requestId: text('request_id'),
  traceId: text('trace_id'),
  statusCode: integer('status_code'),
  samplePayload: text('sample_payload'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_error_occurrences_group_created').on(table.errorGroupId, table.createdAt),
]);

export const scoutBridgeJobs = sqliteTable('scout_bridge_jobs', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull(),
  source: text('source').notNull().default('alertmanager'),
  status: text('status', { enum: ['pending', 'processing', 'delivered', 'failed', 'dead'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: text('next_attempt_at').notNull(),
  processingStartedAt: text('processing_started_at'),
  lastError: text('last_error'),
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_scout_bridge_jobs_event_unique').on(table.eventId),
  index('idx_scout_bridge_jobs_status_next').on(table.status, table.nextAttemptAt),
]);

export const emailDigestDeliveries = sqliteTable('email_digest_deliveries', {
  id: text('id').primaryKey(),
  recipientUserId: text('recipient_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  recipientEmail: text('recipient_email').notNull(),
  digestDate: text('digest_date').notNull(),
  periodStart: text('period_start').notNull(),
  periodEnd: text('period_end').notNull(),
  itemCount: integer('item_count').notNull().default(0),
  createdItemCount: integer('created_item_count').notNull().default(0),
  statusChangeCount: integer('status_change_count').notNull().default(0),
  assignmentCount: integer('assignment_count').notNull().default(0),
  typeChangeCount: integer('type_change_count').notNull().default(0),
  statusTransitions: text('status_transitions').notNull().default('{}'),
  messageId: text('message_id'),
  sentAt: text('sent_at').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_email_digest_user_date_unique').on(table.recipientUserId, table.digestDate),
  index('idx_email_digest_date').on(table.digestDate),
]);

// === Webhooks ===
export const webhooks = sqliteTable('webhooks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  secret: text('secret'), // HMAC signing secret
  events: text('events').notNull().default('["item.created","item.status_changed"]'), // JSON array of event types
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_webhooks_project').on(table.projectId),
  index('idx_webhooks_project_active').on(table.projectId, table.isActive),
]);

// === API Keys ===
export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), // "CI/CD", "Slack Bot", etc.
  purpose: text('purpose', { enum: ['agent', 'ci', 'integration', 'custom'] }).notNull().default('custom'),
  scopes: text('scopes').notNull().default('["items:read","items:create","items:comment","items:workflow","items:triage","storage:read"]'), // JSON array of allowed API key scopes
  keyHash: text('key_hash').notNull(), // bcrypt hash of the key
  keyPrefix: text('key_prefix').notNull(), // first 16 chars for identification (e.g., "sk_live_a1b2c3d4")
  lastUsedAt: text('last_used_at'),
  expiresAt: text('expires_at'), // null = never expires
  revokedAt: text('revoked_at'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_api_keys_prefix').on(table.keyPrefix),
  index('idx_api_keys_project').on(table.projectId),
]);

// === Inferred types ===
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type ScoutItem = typeof scoutItems.$inferSelect;
export type NewScoutItem = typeof scoutItems.$inferInsert;
export type ScoutItemNote = typeof scoutItemNotes.$inferSelect;
export type ScoutItemEvidence = typeof scoutItemEvidence.$inferSelect;
export type ScoutItemLink = typeof scoutItemLinks.$inferSelect;
export type ErrorGroup = typeof errorGroups.$inferSelect;
export type NewErrorGroup = typeof errorGroups.$inferInsert;
export type ErrorGroupOccurrence = typeof errorGroupOccurrences.$inferSelect;
export type ScoutBridgeJob = typeof scoutBridgeJobs.$inferSelect;
export type EmailDigestDelivery = typeof emailDigestDeliveries.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type ItemStatus = NonNullable<ScoutItem['status']>;
export type ItemPriority = NonNullable<ScoutItem['priority']>;
export type ItemType = NonNullable<ScoutItem['itemType']>;
export type ItemSource = NonNullable<ScoutItem['source']>;
export type UserRole = NonNullable<User['role']>;
export type ProjectRole = NonNullable<typeof pivotUsersProjects.$inferSelect['role']>;

export const WEBHOOK_EVENT_TYPES = [
  'item.created',
  'item.status_changed',
  'item.assigned',
  'item.commented',
  'item.deleted',
  'error_group.created',
  'error_group.updated',
] as const;
export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];
