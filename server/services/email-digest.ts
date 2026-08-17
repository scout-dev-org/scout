import nodemailer, { type Transporter } from 'nodemailer';
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { emailDigestDeliveries, projects, scoutItemNotes, scoutItems, users, type ItemStatus, type ScoutItem, type ScoutItemNote, type User } from '../db/schema.js';
import { hasProjectPermission } from '../middleware/permissions.js';
import { logger } from '../lib/logger.js';

type DigestEventType = 'created' | 'status_change' | 'assignment' | 'type_change';

type DigestEvent = {
  type: DigestEventType;
  item: ScoutItem;
  note?: ScoutItemNote;
  actorId?: string | null;
  from?: string;
  to?: string;
};

/** An item the recipient still has to act on, independent of today's events. */
type ActionItem = {
  id: string;
  itemType: string;
  message: string;
  status: string;
  priority: string | null;
  projectName: string;
  updatedAt: string;
};

type RecipientActions = {
  pendingAcceptance: ActionItem[];
  changesRequested: ActionItem[];
  /** Items waiting longer than the action window, reported as a count only. */
  olderPendingCount: number;
};

type RecipientDigest = {
  user: User;
  digestDate: string;
  periodStart: string;
  periodEnd: string;
  itemCount: number;
  createdItemCount: number;
  statusChangeCount: number;
  assignmentCount: number;
  typeChangeCount: number;
  statusTransitions: Record<string, number>;
  currentStatusCounts: Record<string, number>;
  projectCounts: Record<string, number>;
  actions: RecipientActions;
};

type SendMailTransport = Pick<Transporter, 'sendMail'>;

export type DailyDigestResult = {
  digestDate: string;
  periodStart: string;
  periodEnd: string;
  dryRun: boolean;
  recipientCount: number;
  sentCount: number;
  skippedCount: number;
  summaries: Array<{
    userId: string;
    email: string;
    itemCount: number;
    createdItemCount: number;
    statusChangeCount: number;
    assignmentCount: number;
    typeChangeCount: number;
    pendingAcceptanceCount: number;
    changesRequestedCount: number;
    skipped: boolean;
  }>;
};

type SendDailyDigestsOptions = {
  date?: string;
  dryRun?: boolean;
  force?: boolean;
  recipientEmail?: string;
  now?: Date;
  transport?: SendMailTransport;
};

const DEFAULT_DIGEST_TIME = '18:00';
const DEFAULT_TIME_ZONE = 'Asia/Almaty';

const statusLabels: Record<ItemStatus, string> = {
  new: 'Новая',
  in_progress: 'В работе',
  review: 'На проверке',
  done: 'Ждёт приёмки',
  changes_requested: 'Нужны правки',
  verified: 'Принята',
  cancelled: 'Отменена',
};

const itemTypeLabels: Record<string, string> = {
  bug: 'Баг',
  note: 'Заметка',
  task: 'Задача',
};

const priorityLabels: Record<string, string> = {
  critical: 'Критический',
  high: 'Высокий',
  medium: 'Средний',
  low: 'Низкий',
};

/** How many items each action section lists before collapsing into a counter. */
const ACTION_LIST_LIMIT = 10;

/**
 * Only recently finished work is worth a daily nudge. Anything older is a
 * backlog the reader already knows about, so it collapses into one line.
 */
const ACTION_WINDOW_DAYS = 7;

function statusLabel(status: string): string {
  return statusLabels[status as ItemStatus] ?? status;
}

function requireSmtpConfig() {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM?.trim() || user;
  if (!host || !user || !pass || !from) {
    throw new Error('SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM are required for Scout daily digests');
  }

  const port = Number(process.env.SMTP_PORT || '587');
  return {
    host,
    port,
    user,
    pass,
    from,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
  };
}

function hasSmtpConfig(): boolean {
  return Boolean(process.env.SMTP_HOST?.trim() && process.env.SMTP_USER?.trim() && process.env.SMTP_PASS && (process.env.SMTP_FROM?.trim() || process.env.SMTP_USER?.trim()));
}

function createTransport(): SendMailTransport {
  const config = requireSmtpConfig();
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });
}

function formatSqlDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseLocalDate(date: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error('Digest date must use YYYY-MM-DD format');
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function getTimeZoneOffsetMs(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour) % 24;
  const asUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), hour, Number(values.minute), Number(values.second));
  return asUtc - date.getTime();
}

function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const { year, month, day } = parseLocalDate(date);
  const [hourRaw, minuteRaw] = time.split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('Digest time must use HH:mm format');
  }

  let utc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let i = 0; i < 3; i += 1) {
    utc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - getTimeZoneOffsetMs(timeZone, utc));
  }
  return utc;
}

function addLocalDays(date: string, days: number): string {
  const { year, month, day } = parseLocalDate(date);
  const next = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return next.toISOString().slice(0, 10);
}

function getLocalDateString(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getDigestPeriod(date: string, timeZone = DEFAULT_TIME_ZONE) {
  const start = zonedTimeToUtc(date, '00:00', timeZone);
  const end = zonedTimeToUtc(addLocalDays(date, 1), '00:00', timeZone);
  return { periodStart: formatSqlDate(start), periodEnd: formatSqlDate(end) };
}

function parseNoteJson(note: ScoutItemNote): Record<string, unknown> {
  try {
    const parsed = JSON.parse(note.content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isDeliverableDigestEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return normalized.includes('@') && !normalized.endsWith('@scout.local');
}

function getEvents(periodStart: string, periodEnd: string): DigestEvent[] {
  const created = db.select().from(scoutItems)
    .where(and(gte(scoutItems.createdAt, periodStart), lt(scoutItems.createdAt, periodEnd)))
    .all()
    .map((item) => ({ type: 'created' as const, item, actorId: item.reporterId }));

  const notes = db.select().from(scoutItemNotes)
    .where(and(
      inArray(scoutItemNotes.type, ['status_change', 'assignment', 'type_change']),
      gte(scoutItemNotes.createdAt, periodStart),
      lt(scoutItemNotes.createdAt, periodEnd),
    ))
    .all();

  const itemIds = unique(notes.map((note) => note.itemId));
  const itemRows = itemIds.length === 0
    ? []
    : db.select().from(scoutItems).where(inArray(scoutItems.id, itemIds)).all();
  const itemsById = new Map(itemRows.map((item) => [item.id, item]));

  const noteEvents = notes.flatMap((note): DigestEvent[] => {
    const item = itemsById.get(note.itemId);
    if (!item) return [];
    const parsed = parseNoteJson(note);
    const from = typeof parsed.from === 'string' ? parsed.from : undefined;
    const to = typeof parsed.to === 'string' ? parsed.to : undefined;
    return [{ type: note.type as DigestEventType, item, note, actorId: note.userId, from, to }];
  });

  return [...created, ...noteEvents];
}

function getProjectNames(projectIds: string[]): Map<string, string> {
  if (projectIds.length === 0) return new Map();
  const rows = db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, unique(projectIds))).all();
  return new Map(rows.map((project) => [project.id, project.name]));
}

function getRecipients(events: DigestEvent[]): User[] {
  const userIds = unique(events.flatMap((event) => [
    event.actorId,
    event.item.reporterId,
    event.item.assigneeId,
    event.item.resolvedById,
  ].filter((id): id is string => Boolean(id))));

  if (userIds.length === 0) return [];
  return db.select().from(users)
    .where(and(inArray(users.id, userIds), eq(users.isActive, true)))
    .all()
    .filter((user) => isDeliverableDigestEmail(user.email));
}

function toActionItem(item: ScoutItem, projectNames: Map<string, string>): ActionItem {
  return {
    id: item.id,
    itemType: item.itemType,
    message: item.message,
    status: item.status,
    priority: item.priority,
    projectName: projectNames.get(item.projectId) ?? item.projectId,
    updatedAt: item.updatedAt,
  };
}

function sortActionItems(items: ActionItem[]): ActionItem[] {
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Items waiting on a person: `done` needs someone who can accept it,
 * `changes_requested` needs the assignee who has to redo the work.
 */
function getOpenActionsByUser(projectNames: Map<string, string>, digestDate: string): Map<string, RecipientActions> {
  const waiting = db.select().from(scoutItems)
    .where(inArray(scoutItems.status, ['done', 'changes_requested']))
    .all();
  if (waiting.length === 0) return new Map();

  const actionsByUser = new Map<string, RecipientActions>();
  const actionsFor = (userId: string): RecipientActions => {
    const existing = actionsByUser.get(userId);
    if (existing) return existing;
    const created: RecipientActions = { pendingAcceptance: [], changesRequested: [], olderPendingCount: 0 };
    actionsByUser.set(userId, created);
    return created;
  };

  const candidates = db.select().from(users).where(eq(users.isActive, true)).all()
    .filter((user) => isDeliverableDigestEmail(user.email));
  const acceptCache = new Map<string, boolean>();
  const canAccept = (user: User, projectId: string): boolean => {
    const key = `${user.id}:${projectId}`;
    const cached = acceptCache.get(key);
    if (cached !== undefined) return cached;
    const allowed = hasProjectPermission(user.id, user.role, projectId, 'accept_item');
    acceptCache.set(key, allowed);
    return allowed;
  };

  const windowStart = `${addLocalDays(digestDate, -ACTION_WINDOW_DAYS)} 00:00:00`;
  const isRecent = (item: ScoutItem): boolean => (item.resolvedAt ?? item.updatedAt) >= windowStart;

  for (const item of waiting) {
    if (item.status === 'changes_requested') {
      if (item.assigneeId && isRecent(item)) actionsFor(item.assigneeId).changesRequested.push(toActionItem(item, projectNames));
      continue;
    }
    for (const user of candidates) {
      if (!canAccept(user, item.projectId)) continue;
      if (isRecent(item)) actionsFor(user.id).pendingAcceptance.push(toActionItem(item, projectNames));
      else actionsFor(user.id).olderPendingCount += 1;
    }
  }

  for (const actions of actionsByUser.values()) {
    sortActionItems(actions.pendingAcceptance);
    sortActionItems(actions.changesRequested);
  }
  return actionsByUser;
}

function isUserRelatedToEvent(userId: string, event: DigestEvent): boolean {
  return event.actorId === userId ||
    event.item.reporterId === userId ||
    event.item.assigneeId === userId ||
    event.item.resolvedById === userId;
}

function increment(record: Record<string, number>, key: string, amount = 1): void {
  record[key] = (record[key] ?? 0) + amount;
}

function buildRecipientDigest(user: User, events: DigestEvent[], digestDate: string, periodStart: string, periodEnd: string, projectNames: Map<string, string>, actions: RecipientActions): RecipientDigest {
  const relevant = events.filter((event) => isUserRelatedToEvent(user.id, event));
  const uniqueItems = unique(relevant.map((event) => event.item.id));
  const digest: RecipientDigest = {
    user,
    digestDate,
    periodStart,
    periodEnd,
    itemCount: uniqueItems.length,
    createdItemCount: relevant.filter((event) => event.type === 'created').length,
    statusChangeCount: relevant.filter((event) => event.type === 'status_change').length,
    assignmentCount: relevant.filter((event) => event.type === 'assignment').length,
    typeChangeCount: relevant.filter((event) => event.type === 'type_change').length,
    statusTransitions: {},
    currentStatusCounts: {},
    projectCounts: {},
    actions,
  };

  const itemsById = new Map(relevant.map((event) => [event.item.id, event.item]));
  for (const item of itemsById.values()) {
    increment(digest.currentStatusCounts, statusLabels[item.status]);
    increment(digest.projectCounts, projectNames.get(item.projectId) ?? item.projectId);
  }

  for (const event of relevant) {
    if (event.type === 'status_change') {
      increment(digest.statusTransitions, `${statusLabel(event.from ?? '?')} → ${statusLabel(event.to ?? '?')}`);
    }
  }

  return digest;
}

const NO_ACTIONS: RecipientActions = { pendingAcceptance: [], changesRequested: [], olderPendingCount: 0 };

function hasContent(digest: RecipientDigest): boolean {
  return digest.itemCount > 0
    || digest.actions.pendingAcceptance.length > 0
    || digest.actions.changesRequested.length > 0;
}

function buildDigests(digestDate: string, periodStart: string, periodEnd: string): RecipientDigest[] {
  const events = getEvents(periodStart, periodEnd);
  const openItems = db.select({ projectId: scoutItems.projectId }).from(scoutItems)
    .where(inArray(scoutItems.status, ['done', 'changes_requested']))
    .all();
  if (events.length === 0 && openItems.length === 0) return [];

  const projectNames = getProjectNames([
    ...events.map((event) => event.item.projectId),
    ...openItems.map((item) => item.projectId),
  ]);
  const actionsByUser = getOpenActionsByUser(projectNames, digestDate);

  const eventRecipients = getRecipients(events);
  const known = new Set(eventRecipients.map((user) => user.id));
  const actionOnlyIds = [...actionsByUser.keys()].filter((userId) => !known.has(userId));
  const actionOnlyRecipients = actionOnlyIds.length === 0
    ? []
    : db.select().from(users)
      .where(and(inArray(users.id, actionOnlyIds), eq(users.isActive, true)))
      .all()
      .filter((user) => isDeliverableDigestEmail(user.email));

  return [...eventRecipients, ...actionOnlyRecipients]
    .map((user) => buildRecipientDigest(user, events, digestDate, periodStart, periodEnd, projectNames, actionsByUser.get(user.id) ?? NO_ACTIONS))
    .filter(hasContent);
}

function formatCounts(record: Record<string, number>, emptyText: string): string[] {
  const entries = Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? [`- ${emptyText}`] : entries.map(([key, value]) => `- ${key}: ${value}`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!));
}

function getBaseUrl(): string {
  return (process.env.SCOUT_PUBLIC_URL?.trim() || process.env.SCOUT_URL?.trim() || '').replace(/\/+$/, '');
}

function itemUrl(itemId: string): string {
  const baseUrl = getBaseUrl();
  return baseUrl ? `${baseUrl}/items/${itemId}` : '';
}

function itemTitle(message: string): string {
  const firstLine = message.split(/\r?\n/)[0]?.trim() || message.trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function itemMeta(item: ActionItem): string {
  return [
    itemTypeLabels[item.itemType] ?? item.itemType,
    item.priority ? priorityLabels[item.priority] ?? item.priority : null,
    item.projectName,
  ].filter(Boolean).join(' · ');
}

function actionSections(digest: RecipientDigest): Array<{ title: string; hint: string; items: ActionItem[] }> {
  return [
    {
      title: 'Ждут вашей приёмки',
      hint: 'Работа завершена — нужно проверить результат и принять задачу или вернуть на доработку.',
      items: digest.actions.pendingAcceptance,
    },
    {
      title: 'Возвращены вам на доработку',
      hint: 'По этим задачам запросили правки.',
      items: digest.actions.changesRequested,
    },
  ].filter((section) => section.items.length > 0);
}

function buildDigestSubject(digest: RecipientDigest): string {
  const pending = digest.actions.pendingAcceptance.length;
  if (pending > 0) {
    return `Scout: ${pending} ${plural(pending, 'задача ждёт', 'задачи ждут', 'задач ждут')} вашей приёмки — сводка за ${digest.digestDate}`;
  }
  const rework = digest.actions.changesRequested.length;
  if (rework > 0) {
    return `Scout: ${rework} ${plural(rework, 'задача вернулась', 'задачи вернулись', 'задач вернулись')} к вам на доработку — сводка за ${digest.digestDate}`;
  }
  return `Scout: ежедневная сводка за ${digest.digestDate}`;
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function buildDigestText(digest: RecipientDigest): string {
  const baseUrl = getBaseUrl();
  const lines = [
    `Здравствуйте, ${digest.user.name}.`,
    '',
    `Сводка Scout за ${digest.digestDate} (${process.env.SCOUT_DAILY_DIGEST_TIMEZONE || DEFAULT_TIME_ZONE}).`,
  ];

  for (const section of actionSections(digest)) {
    lines.push('', `${section.title.toUpperCase()} (${section.items.length})`, section.hint, '');
    for (const item of section.items.slice(0, ACTION_LIST_LIMIT)) {
      lines.push(`- ${itemTitle(item.message)}`);
      lines.push(`  ${itemMeta(item)}`);
      const url = itemUrl(item.id);
      if (url) lines.push(`  ${url}`);
    }
    if (section.items.length > ACTION_LIST_LIMIT) {
      lines.push(`- и ещё ${section.items.length - ACTION_LIST_LIMIT}`);
    }
  }

  if (digest.actions.olderPendingCount > 0) {
    lines.push('', `Дольше недели приёмки ждут ещё ${digest.actions.olderPendingCount} ${plural(digest.actions.olderPendingCount, 'задача', 'задачи', 'задач')} — они не перечислены здесь.`);
  }

  if (digest.itemCount === 0) {
    lines.push('', 'За день изменений по вашим задачам не было.');
  } else {
    lines.push(
      '',
      'Что произошло за день:',
      `- затронуто задач: ${digest.itemCount}`,
      `- создано задач: ${digest.createdItemCount}`,
      `- переходов статусов: ${digest.statusChangeCount}`,
      `- назначений: ${digest.assignmentCount}`,
      `- изменений типа: ${digest.typeChangeCount}`,
    );
    if (Object.keys(digest.statusTransitions).length > 0) {
      lines.push('', 'Переходы статусов:', ...formatCounts(digest.statusTransitions, ''));
    }
    if (Object.keys(digest.currentStatusCounts).length > 0) {
      lines.push('', 'Текущие статусы затронутых задач:', ...formatCounts(digest.currentStatusCounts, ''));
    }
    if (Object.keys(digest.projectCounts).length > 0) {
      lines.push('', 'Проекты:', ...formatCounts(digest.projectCounts, ''));
    }
  }

  if (baseUrl) lines.push('', `Открыть Scout: ${baseUrl}`);
  return lines.join('\n');
}

function countRow(label: string, value: number): string {
  return `<tr><td style="padding:4px 0;color:#4b5563;font-size:14px;">${escapeHtml(label)}</td>`
    + `<td align="right" style="padding:4px 0;color:#111827;font-size:14px;font-weight:600;">${value}</td></tr>`;
}

function listRows(record: Record<string, number>, emptyText: string): string {
  const entries = Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return `<tr><td colspan="2" style="padding:4px 0;color:#9ca3af;font-size:14px;">${escapeHtml(emptyText)}</td></tr>`;
  }
  return entries.map(([key, value]) => countRow(key, value)).join('');
}

function actionItemHtml(item: ActionItem): string {
  const url = itemUrl(item.id);
  const title = escapeHtml(itemTitle(item.message));
  const heading = url
    ? `<a href="${escapeHtml(url)}" style="color:#1d4ed8;text-decoration:none;font-weight:600;font-size:15px;">${title}</a>`
    : `<span style="color:#111827;font-weight:600;font-size:15px;">${title}</span>`;
  return `<tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;">`
    + `${heading}`
    + `<div style="margin-top:4px;color:#6b7280;font-size:13px;">${escapeHtml(itemMeta(item))}</div>`
    + `</td></tr>`;
}

function sectionHtml(title: string, hint: string, items: ActionItem[]): string {
  const rows = items.slice(0, ACTION_LIST_LIMIT).map(actionItemHtml).join('');
  const rest = items.length > ACTION_LIST_LIMIT
    ? `<div style="margin-top:10px;color:#6b7280;font-size:13px;">и ещё ${items.length - ACTION_LIST_LIMIT}</div>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;">`
    + `<tr><td style="padding:16px 20px;">`
    + `<div style="color:#92400e;font-size:16px;font-weight:700;">${escapeHtml(title)} (${items.length})</div>`
    + `<div style="margin-top:4px;color:#92400e;font-size:13px;">${escapeHtml(hint)}</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">${rows}</table>`
    + rest
    + `</td></tr></table>`;
}

function namedSection(title: string, record: Record<string, number>): string {
  if (Object.keys(record).length === 0) return '';
  return `<div style="margin-top:20px;color:#111827;font-size:15px;font-weight:700;">${escapeHtml(title)}</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">${listRows(record, '')}</table>`;
}

function buildDigestHtml(digest: RecipientDigest): string {
  const baseUrl = getBaseUrl();
  const timeZone = process.env.SCOUT_DAILY_DIGEST_TIMEZONE || DEFAULT_TIME_ZONE;
  const actions = actionSections(digest)
    .map((section) => sectionHtml(section.title, section.hint, section.items))
    .join('')
    + (digest.actions.olderPendingCount > 0
      ? `<div style="margin:0 0 20px;color:#6b7280;font-size:13px;">Дольше недели приёмки ждут ещё ${digest.actions.olderPendingCount} ${plural(digest.actions.olderPendingCount, 'задача', 'задачи', 'задач')} — они не перечислены здесь.</div>`
      : '');

  const daily = digest.itemCount === 0
    ? `<div style="padding-top:12px;color:#6b7280;font-size:14px;">За день изменений по вашим задачам не было.</div>`
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="padding-top:12px;color:#111827;font-size:15px;font-weight:700;">Что произошло за день</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
${countRow('Затронуто задач', digest.itemCount)}
${countRow('Создано задач', digest.createdItemCount)}
${countRow('Переходов статусов', digest.statusChangeCount)}
${countRow('Назначений', digest.assignmentCount)}
${countRow('Изменений типа', digest.typeChangeCount)}
</table>
${namedSection('Переходы статусов', digest.statusTransitions)}
${namedSection('Текущие статусы затронутых задач', digest.currentStatusCounts)}
${namedSection('Проекты', digest.projectCounts)}`;

  const button = baseUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 0;"><tr><td style="background:#111827;border-radius:6px;">`
      + `<a href="${escapeHtml(baseUrl)}/items" style="display:inline-block;padding:10px 18px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">Открыть Scout</a>`
      + `</td></tr></table>`
    : '';

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scout</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:10px;border:1px solid #e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<tr><td style="padding:24px 24px 8px;">
<div style="color:#111827;font-size:20px;font-weight:700;">Сводка Scout за ${escapeHtml(digest.digestDate)}</div>
<div style="margin-top:4px;color:#6b7280;font-size:13px;">${escapeHtml(digest.user.name)} · ${escapeHtml(timeZone)}</div>
</td></tr>
<tr><td style="padding:16px 24px 0;">
${actions}
${daily}
</td></tr>
<tr><td style="padding:20px 24px 24px;">${button}</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function wasAlreadySent(userId: string, digestDate: string): boolean {
  return Boolean(db.select({ id: emailDigestDeliveries.id }).from(emailDigestDeliveries)
    .where(and(eq(emailDigestDeliveries.recipientUserId, userId), eq(emailDigestDeliveries.digestDate, digestDate)))
    .get());
}

function recordDelivery(digest: RecipientDigest, messageId: string | null): void {
  const sentAt = new Date().toISOString();
  const row = {
    recipientEmail: digest.user.email,
    periodStart: digest.periodStart,
    periodEnd: digest.periodEnd,
    itemCount: digest.itemCount,
    createdItemCount: digest.createdItemCount,
    statusChangeCount: digest.statusChangeCount,
    assignmentCount: digest.assignmentCount,
    typeChangeCount: digest.typeChangeCount,
    statusTransitions: JSON.stringify(digest.statusTransitions),
    messageId,
    sentAt,
  };
  db.insert(emailDigestDeliveries).values({
    id: randomUUID(),
    recipientUserId: digest.user.id,
    digestDate: digest.digestDate,
    ...row,
  }).onConflictDoUpdate({
    target: [emailDigestDeliveries.recipientUserId, emailDigestDeliveries.digestDate],
    set: row,
  }).run();
}

export async function sendDailyDigests(options: SendDailyDigestsOptions = {}): Promise<DailyDigestResult> {
  const timeZone = process.env.SCOUT_DAILY_DIGEST_TIMEZONE || DEFAULT_TIME_ZONE;
  const digestDate = options.date ?? getLocalDateString(options.now ?? new Date(), timeZone);
  const { periodStart, periodEnd } = getDigestPeriod(digestDate, timeZone);
  const recipientEmail = options.recipientEmail?.trim().toLowerCase();
  const digests = buildDigests(digestDate, periodStart, periodEnd)
    .filter((digest) => !recipientEmail || digest.user.email.trim().toLowerCase() === recipientEmail);
  const dryRun = options.dryRun === true;
  const transport = dryRun ? null : (options.transport ?? createTransport());
  const smtpFrom = dryRun ? 'dry-run@scout.local' : requireSmtpConfig().from;
  let sentCount = 0;
  let skippedCount = 0;
  const summaries: DailyDigestResult['summaries'] = [];

  for (const digest of digests) {
    const skipped = !options.force && wasAlreadySent(digest.user.id, digestDate);
    summaries.push({
      userId: digest.user.id,
      email: digest.user.email,
      itemCount: digest.itemCount,
      createdItemCount: digest.createdItemCount,
      statusChangeCount: digest.statusChangeCount,
      assignmentCount: digest.assignmentCount,
      typeChangeCount: digest.typeChangeCount,
      pendingAcceptanceCount: digest.actions.pendingAcceptance.length,
      changesRequestedCount: digest.actions.changesRequested.length,
      skipped,
    });

    if (skipped) {
      skippedCount += 1;
      continue;
    }
    if (dryRun) continue;

    const info = await transport!.sendMail({
      from: smtpFrom,
      to: digest.user.email,
      subject: buildDigestSubject(digest),
      text: buildDigestText(digest),
      html: buildDigestHtml(digest),
    });
    recordDelivery(digest, typeof info.messageId === 'string' ? info.messageId : null);
    sentCount += 1;
  }

  return {
    digestDate,
    periodStart,
    periodEnd,
    dryRun,
    recipientCount: digests.length,
    sentCount,
    skippedCount,
    summaries,
  };
}

function getNextRunDelay(now: Date, timeZone: string, time: string): { delayMs: number; runAt: Date; digestDate: string } {
  const today = getLocalDateString(now, timeZone);
  let digestDate = today;
  let runAt = zonedTimeToUtc(today, time, timeZone);
  if (runAt.getTime() <= now.getTime() + 1_000) {
    digestDate = addLocalDays(today, 1);
    runAt = zonedTimeToUtc(digestDate, time, timeZone);
  }
  return { delayMs: Math.max(1_000, runAt.getTime() - now.getTime()), runAt, digestDate };
}

export function startDailyDigestWorker(): () => void {
  if (process.env.SCOUT_DAILY_DIGEST_ENABLED === 'false') {
    logger.info('Scout daily email digest worker disabled');
    return () => {};
  }
  if (!hasSmtpConfig()) {
    logger.warn('Scout daily email digest worker not started: SMTP env is incomplete');
    return () => {};
  }

  const timeZone = process.env.SCOUT_DAILY_DIGEST_TIMEZONE || DEFAULT_TIME_ZONE;
  const time = process.env.SCOUT_DAILY_DIGEST_TIME || DEFAULT_DIGEST_TIME;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    const next = getNextRunDelay(new Date(), timeZone, time);
    logger.info({ runAt: next.runAt.toISOString(), digestDate: next.digestDate, timeZone }, 'Scheduled Scout daily email digest');
    timer = setTimeout(async () => {
      try {
        const result = await sendDailyDigests({ date: next.digestDate });
        logger.info({ digestDate: result.digestDate, sentCount: result.sentCount, skippedCount: result.skippedCount, recipientCount: result.recipientCount }, 'Scout daily email digest completed');
      } catch (err) {
        logger.error({ err }, 'Scout daily email digest failed');
      } finally {
        schedule();
      }
    }, next.delayMs);
    timer.unref?.();
  };

  schedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
