import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { notificationRoutes } from '../server/routes/notifications.js';
import { emailDigestDeliveries, scoutItemNotes, scoutItems, users } from '../server/db/schema.js';
import { sendDailyDigests } from '../server/services/email-digest.js';
import { createTestContext, type TestContext } from './helpers.js';

vi.mock('../server/db/client.js', async () => {
  return { db: null, sqlite: { close: () => {} } };
});

describe('Daily email digest', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = createTestContext();
    const dbModule = await import('../server/db/client.js');
    (dbModule as any).db = ctx.db;
    process.env.SCOUT_DAILY_DIGEST_TIMEZONE = 'Asia/Almaty';
    process.env.SMTP_HOST = 'smtp.test.local';
    process.env.SMTP_USER = 'scout@test.local';
    process.env.SMTP_PASS = 'password';
    process.env.SMTP_FROM = 'Scout <scout@test.local>';
  });

  function seedChangedItem() {
    const itemId = randomUUID();
    ctx.db.insert(scoutItems).values({
      id: itemId,
      projectId: ctx.projectId,
      message: 'Daily digest test item',
      status: 'done',
      reporterId: ctx.memberId,
      assigneeId: ctx.developerId,
      resolvedById: ctx.developerId,
      createdAt: '2026-06-08 19:30:00',
      updatedAt: '2026-06-09 08:00:00',
    }).run();
    ctx.db.insert(scoutItemNotes).values([
      {
        id: randomUUID(),
        itemId,
        userId: ctx.developerId,
        type: 'status_change',
        content: JSON.stringify({ type: 'status_change', from: 'new', to: 'in_progress' }),
        createdAt: '2026-06-09 03:00:00',
      },
      {
        id: randomUUID(),
        itemId,
        userId: ctx.developerId,
        type: 'status_change',
        content: JSON.stringify({ type: 'status_change', from: 'in_progress', to: 'done' }),
        createdAt: '2026-06-09 08:00:00',
      },
      {
        id: randomUUID(),
        itemId,
        userId: ctx.developerId,
        type: 'assignment',
        content: JSON.stringify({ type: 'assignment', userName: 'Test Developer' }),
        createdAt: '2026-06-09 02:00:00',
      },
    ]).run();
    return itemId;
  }

  it('aggregates concise daily summaries by related users', async () => {
    seedChangedItem();

    const result = await sendDailyDigests({ date: '2026-06-09', dryRun: true });

    expect(result.periodStart).toBe('2026-06-08 19:00:00');
    expect(result.periodEnd).toBe('2026-06-09 19:00:00');
    expect(result.recipientCount).toBe(3);
    expect(result.sentCount).toBe(0);
    expect(result.summaries.map((summary) => summary.email).sort()).toEqual(['admin@test.local', 'developer@test.local', 'member@test.local']);
    for (const summary of result.summaries.filter((summary) => summary.email !== 'admin@test.local')) {
      expect(summary.itemCount).toBe(1);
      expect(summary.createdItemCount).toBe(1);
      expect(summary.statusChangeCount).toBe(2);
      expect(summary.assignmentCount).toBe(1);
    }
  });

  it('skips Scout-local placeholder email addresses', async () => {
    ctx.db.update(users).set({ email: 'developer@scout.local' }).where(eq(users.id, ctx.developerId)).run();
    seedChangedItem();

    const result = await sendDailyDigests({ date: '2026-06-09', dryRun: true });

    expect(result.recipientCount).toBe(2);
    expect(result.summaries.map((summary) => summary.email).sort()).toEqual(['admin@test.local', 'member@test.local']);
  });

  it('sends once per user per digest date unless forced', async () => {
    seedChangedItem();
    const sendMail = vi.fn(async () => ({ messageId: randomUUID() }));

    const first = await sendDailyDigests({ date: '2026-06-09', transport: { sendMail } as any });
    const second = await sendDailyDigests({ date: '2026-06-09', transport: { sendMail } as any });

    expect(first.sentCount).toBe(3);
    expect(second.sentCount).toBe(0);
    expect(second.skippedCount).toBe(3);
    expect(sendMail).toHaveBeenCalledTimes(3);
    const deliveries = ctx.db.select().from(emailDigestDeliveries).all();
    expect(deliveries).toHaveLength(3);
    expect(deliveries.every((delivery) => delivery.digestDate === '2026-06-09')).toBe(true);
  });

  it('can target one recipient for operational resends', async () => {
    seedChangedItem();
    const sendMail = vi.fn(async () => ({ messageId: randomUUID() }));

    const result = await sendDailyDigests({
      date: '2026-06-09',
      recipientEmail: 'developer@test.local',
      force: true,
      transport: { sendMail } as any,
    });

    expect(result.recipientCount).toBe(1);
    expect(result.sentCount).toBe(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe('developer@test.local');
    expect(ctx.db.select().from(emailDigestDeliveries).all()).toHaveLength(1);
  });

  it('lists items waiting for the recipient to accept them, even without events that day', async () => {
    process.env.SCOUT_PUBLIC_URL = 'https://scout.test.local';
    const itemId = randomUUID();
    ctx.db.insert(scoutItems).values({
      id: itemId,
      projectId: ctx.projectId,
      itemType: 'bug',
      message: 'Кнопка сохранения не работает\nвторая строка описания',
      status: 'done',
      priority: 'critical',
      reporterId: ctx.memberId,
      assigneeId: ctx.developerId,
      resolvedById: ctx.developerId,
      createdAt: '2026-05-01 10:00:00',
      updatedAt: '2026-06-05 10:00:00',
      resolvedAt: '2026-06-05 10:00:00',
    }).run();
    const sendMail = vi.fn(async () => ({ messageId: randomUUID() }));

    const result = await sendDailyDigests({ date: '2026-06-09', transport: { sendMail } as any });

    expect(result.summaries.map((summary) => summary.email)).toEqual(['admin@test.local']);
    expect(result.summaries[0]).toMatchObject({ itemCount: 0, pendingAcceptanceCount: 1, changesRequestedCount: 0 });
    const mail = sendMail.mock.calls[0][0] as any;
    expect(mail.subject).toBe('Scout: 1 задача ждёт вашей приёмки — сводка за 2026-06-09');
    expect(mail.text).toContain('ЖДУТ ВАШЕЙ ПРИЁМКИ (1)');
    expect(mail.text).toContain('Кнопка сохранения не работает');
    expect(mail.text).not.toContain('вторая строка описания');
    expect(mail.text).toContain(`https://scout.test.local/items/${itemId}`);
    expect(mail.html).toContain(`href="https://scout.test.local/items/${itemId}"`);
    expect(mail.html).toContain('Баг · Критический · Test Project');
    delete process.env.SCOUT_PUBLIC_URL;
  });

  it('lists only recently finished work and counts the older backlog', async () => {
    const recentId = randomUUID();
    const staleId = randomUUID();
    ctx.db.insert(scoutItems).values([
      {
        id: recentId,
        projectId: ctx.projectId,
        message: 'Свежая задача на приёмку',
        status: 'done',
        reporterId: ctx.memberId,
        resolvedById: ctx.developerId,
        createdAt: '2026-06-01 10:00:00',
        updatedAt: '2026-06-08 10:00:00',
        resolvedAt: '2026-06-08 10:00:00',
      },
      {
        id: staleId,
        projectId: ctx.projectId,
        message: 'Старая задача из бэклога',
        status: 'done',
        reporterId: ctx.memberId,
        resolvedById: ctx.developerId,
        createdAt: '2026-01-10 10:00:00',
        updatedAt: '2026-01-11 10:00:00',
        resolvedAt: '2026-01-11 10:00:00',
      },
    ]).run();
    const sendMail = vi.fn(async () => ({ messageId: randomUUID() }));

    const result = await sendDailyDigests({ date: '2026-06-09', transport: { sendMail } as any });

    expect(result.summaries[0]).toMatchObject({ pendingAcceptanceCount: 1 });
    const mail = sendMail.mock.calls[0][0] as any;
    expect(mail.text).toContain('Свежая задача на приёмку');
    expect(mail.text).not.toContain('Старая задача из бэклога');
    expect(mail.text).toContain('Дольше недели приёмки ждут ещё 1 задача');
    expect(mail.html).toContain('Дольше недели приёмки ждут ещё 1 задача');
  });

  it('names rework in the subject when nothing waits for acceptance', async () => {
    ctx.db.insert(scoutItems).values({
      id: randomUUID(),
      projectId: ctx.projectId,
      message: 'Вернули на доработку',
      status: 'changes_requested',
      reporterId: ctx.memberId,
      assigneeId: ctx.developerId,
      createdAt: '2026-06-01 10:00:00',
      updatedAt: '2026-06-08 10:00:00',
    }).run();
    const sendMail = vi.fn(async () => ({ messageId: randomUUID() }));

    await sendDailyDigests({ date: '2026-06-09', recipientEmail: 'developer@test.local', transport: { sendMail } as any });

    const mail = sendMail.mock.calls[0][0] as any;
    expect(mail.subject).toBe('Scout: 1 задача вернулась к вам на доработку — сводка за 2026-06-09');
    expect(mail.text).toContain('ВОЗВРАЩЕНЫ ВАМ НА ДОРАБОТКУ (1)');
  });

  it('translates statuses in the daily section', async () => {
    seedChangedItem();
    const sendMail = vi.fn(async () => ({ messageId: randomUUID() }));

    await sendDailyDigests({ date: '2026-06-09', recipientEmail: 'member@test.local', transport: { sendMail } as any });

    const mail = sendMail.mock.calls[0][0] as any;
    expect(mail.text).toContain('Новая → В работе');
    expect(mail.text).toContain('В работе → Ждёт приёмки');
    expect(mail.text).not.toContain('in_progress');
  });

  it('exposes admin-only dry-run endpoint', async () => {
    seedChangedItem();
    const app = new Hono();
    app.route('/api/notifications', notificationRoutes);

    const memberRes = await app.request('/api/notifications/daily-digest/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.memberToken}` },
      body: JSON.stringify({ date: '2026-06-09', dryRun: true }),
    });
    expect(memberRes.status).toBe(403);

    const adminRes = await app.request('/api/notifications/daily-digest/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.adminToken}` },
      body: JSON.stringify({ date: '2026-06-09', dryRun: true }),
    });
    expect(adminRes.status).toBe(200);
    const body = await adminRes.json() as any;
    expect(body.data.recipientCount).toBe(3);
    expect(ctx.db.select().from(emailDigestDeliveries).where(eq(emailDigestDeliveries.digestDate, '2026-06-09')).all()).toHaveLength(0);
  });
});
