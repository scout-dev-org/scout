import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { itemRoutes } from '../server/routes/items.js';
import { projects, scoutItems } from '../server/db/schema.js';
import { createTestContext, type TestContext } from './helpers.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

// Mock the db module
vi.mock('../server/db/client.js', async () => {
  return { db: null, sqlite: { close: () => {} } };
});

describe('Items routes', () => {
  let ctx: TestContext;
  let app: Hono;

  beforeEach(async () => {
    ctx = createTestContext();
    const dbModule = await import('../server/db/client.js');
    (dbModule as any).db = ctx.db;

    app = new Hono();
    app.route('/api/items', itemRoutes);
  });

  function post(path: string, body: unknown, token: string) {
    return app.request(`/api/items${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  async function createTestItem(token?: string, projectId = ctx.projectId) {
    const testId = randomUUID();
    const res = await post('/create', {
      projectId,
      message: `Test bug report ${testId}`,
      pageUrl: 'http://localhost:3000/page',
      cssSelector: '.btn-submit',
    }, token || ctx.adminToken);
    const body = await res.json() as any;
    return body.data;
  }

  function testEvidence(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'handoff',
      result: 'pass',
      level: 'local_acceptance',
      coverage: 'item',
      environment: 'local',
      scenario: 'Automated test scenario',
      action: 'Ran the status transition through the API',
      visibleResult: 'The API returned the expected item status',
      acceptanceScope: 'Single item acceptance path',
      commitSha: 'abc1234',
      source: 'agent',
      verifiedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      ...overrides,
    };
  }

  async function resolveTestItem(
    itemId: string,
    token = ctx.developerToken,
    extra: Record<string, unknown> = {},
  ) {
    const res = await post('/resolve', {
      id: itemId,
      evidence: testEvidence({ scenario: 'Resolve setup evidence' }),
      ...extra,
    }, token);
    expect(res.status).toBe(200);
    return res;
  }

  // === CREATE ===

  it('POST /create — admin can create item', async () => {
    const res = await post('/create', {
      projectId: ctx.projectId,
      message: 'Button broken on mobile',
    }, ctx.adminToken);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.status).toBe('new');
    expect(body.data.reporterId).toBe(ctx.adminId);
  });

  it('POST /create — member can create item', async () => {
    const res = await post('/create', {
      projectId: ctx.projectId,
      message: 'Another bug report',
    }, ctx.memberToken);

    expect(res.status).toBe(201);
  });

  it('POST /create — developer member cannot create item', async () => {
    const res = await post('/create', {
      projectId: ctx.projectId,
      message: 'Developer should not create',
    }, ctx.developerToken);

    expect(res.status).toBe(403);
  });

  it('POST /create — without auth returns 401', async () => {
    const res = await app.request('/api/items/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: ctx.projectId, message: 'No auth' }),
    });

    expect(res.status).toBe(401);
  });

  // === LIST ===

  it('POST /list — returns items with pagination', async () => {
    await createTestItem();
    await createTestItem();

    const res = await post('/list', { projectId: ctx.projectId }, ctx.adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.items).toHaveLength(2);
    expect(body.data.pagination.total).toBe(2);
  });

  it('POST /list — filter by status', async () => {
    await createTestItem();

    const res = await post('/list', {
      projectId: ctx.projectId,
      status: 'in_progress',
    }, ctx.adminToken);

    const body = await res.json() as any;
    expect(body.data.items).toHaveLength(0);
  });

  it('POST /list — filter by multiple statuses', async () => {
    const newItem = await createTestItem();
    const inProgressItem = await createTestItem();
    await post('/claim', { id: inProgressItem.id }, ctx.developerToken);

    const res = await post('/list', {
      projectId: ctx.projectId,
      statuses: ['new', 'in_progress'],
    }, ctx.adminToken);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.items.map((item: any) => item.id).sort()).toEqual([newItem.id, inProgressItem.id].sort());
  });

  it('POST /list — uses projectId and perPage', async () => {
    await createTestItem();
    await createTestItem();

    const res = await post('/list', {
      projectId: ctx.projectId,
      statuses: ['new'],
      perPage: 1,
    }, ctx.adminToken);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.items).toHaveLength(1);
    expect(body.data.pagination.perPage).toBe(1);
    expect(body.data.pagination.total).toBe(2);
  });

  // === GET ===

  it('POST /get — returns item with notes', async () => {
    const item = await createTestItem();

    const res = await post('/get', { id: item.id }, ctx.adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.id).toBe(item.id);
    expect(body.data.notes).toBeDefined();
    expect(Array.isArray(body.data.notes)).toBe(true);
    expect(body.data.evidence).toBeDefined();
    expect(Array.isArray(body.data.evidence)).toBe(true);
  });

  it('POST /get — rejects non-canonical itemId field', async () => {
    const item = await createTestItem();

    const res = await post('/get', { itemId: item.id }, ctx.adminToken);
    expect(res.status).toBe(400);
  });

  it('POST /get — non-existent returns 404', async () => {
    const res = await post('/get', { id: randomUUID() }, ctx.adminToken);
    expect(res.status).toBe(404);
  });

  // === COUNT ===

  it('POST /count — returns counts by status', async () => {
    await createTestItem();
    await createTestItem();

    const res = await post('/count', { projectId: ctx.projectId }, ctx.adminToken);
    const body = await res.json() as any;
    expect(body.data.counts.new).toBe(2);
    expect(body.data.counts.in_progress).toBe(0);
    expect(body.data.counts.changes_requested).toBe(0);
    expect(body.data.counts.verified).toBe(0);
  });

  it('POST /count — uses projectId only', async () => {
    await createTestItem();

    const res = await post('/count', { projectId: ctx.projectId }, ctx.adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.counts.new).toBe(1);
  });

  // === CLAIM ===

  it('POST /claim — developer member claims new item', async () => {
    const item = await createTestItem();

    const res = await post('/claim', { id: item.id }, ctx.developerToken);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('in_progress');
    expect(body.data.assigneeId).toBe(ctx.developerId);
  });

  it('POST /claim — double claim fails with 409', async () => {
    const item = await createTestItem();

    await post('/claim', { id: item.id }, ctx.developerToken);
    const res = await post('/claim', { id: item.id }, ctx.developerToken);
    expect(res.status).toBe(409);
  });

  it('POST /claim — member cannot claim', async () => {
    const item = await createTestItem();
    const res = await post('/claim', { id: item.id }, ctx.memberToken);
    expect(res.status).toBe(403);
  });

  // === RESOLVE ===

  it('POST /resolve — from in_progress to done', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);

    const res = await post('/resolve', {
      id: item.id,
      resolutionNote: 'Fixed the button handler',
      branchName: 'fix/scout-123',
      evidence: testEvidence({ scenario: 'Resolve item from in_progress' }),
    }, ctx.developerToken);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('done');
    expect(body.data.resolvedAt).toBeDefined();
    expect(body.data.resolutionNote).toBe('Fixed the button handler');
  });

  it('POST /resolve — from new fails (invalid transition)', async () => {
    const item = await createTestItem();
    const res = await post('/resolve', { id: item.id }, ctx.developerToken);
    expect(res.status).toBe(400);
  });

  it('POST /resolve — rejects weak non-acceptance evidence', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);

    const res = await post('/resolve', {
      id: item.id,
      evidence: testEvidence({
        level: 'api_smoke',
        scenario: 'Only API smoke was checked',
      }),
    }, ctx.developerToken);

    expect(res.status).toBe(400);
  });

  it('POST /verify — triager can accept a done item', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);
    await resolveTestItem(item.id, ctx.developerToken, { resolutionNote: 'Fixed and ready for QA' });

    const res = await post('/verify', {
      id: item.id,
      comment: 'Accepted by QA',
    }, ctx.adminToken);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('verified');
    expect(body.data.resolvedAt).toBeTruthy();
    expect(body.data.resolutionNote).toBe('Fixed and ready for QA');

    const getRes = await post('/get', { id: item.id }, ctx.adminToken);
    const getBody = await getRes.json() as any;
    expect(getBody.data.notes.some((note: any) => note.content === 'Accepted by QA')).toBe(true);
  });

  it('POST /request-changes — triager can return a done item with actionable context', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);
    await resolveTestItem(item.id);

    const res = await post('/request-changes', {
      id: item.id,
      summary: 'Button still fails on mobile',
      expected: 'Tap submits the form',
      actual: 'Tap does nothing',
      steps: 'Open the page at mobile width and tap Submit',
      url: 'http://localhost:3000/page',
    }, ctx.adminToken);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('changes_requested');
    expect(body.data.resolvedAt).toBeNull();
    expect(body.data.resolvedById).toBeNull();

    const getRes = await post('/get', { id: item.id }, ctx.adminToken);
    const getBody = await getRes.json() as any;
    expect(getBody.data.notes.some((note: any) => note.content.includes('Button still fails on mobile'))).toBe(true);
  });

  // === CANCEL ===

  it('POST /cancel — admin cancels new item', async () => {
    const item = await createTestItem();
    const res = await post('/cancel', { id: item.id }, ctx.adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('cancelled');
  });

  it('POST /cancel — cannot cancel done item', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);
    await resolveTestItem(item.id);

    const res = await post('/cancel', { id: item.id }, ctx.adminToken);
    expect(res.status).toBe(400);
  });

  // === ADD NOTE ===

  it('POST /add-note — any role can add note', async () => {
    const item = await createTestItem();

    const res = await post('/add-note', {
      id: item.id,
      content: 'This is a manual comment',
    }, ctx.memberToken);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.content).toBe('This is a manual comment');
    expect(body.data.type).toBe('comment');
  });

  // === LINKS ===

  it('POST /link — developer member can link related items', async () => {
    const first = await createTestItem();
    const second = await createTestItem();

    const res = await post('/link', {
      sourceItemId: first.id,
      targetItemId: second.id,
      type: 'duplicate',
    }, ctx.developerToken);

    expect(res.status).toBe(201);

    const getRes = await post('/get', { id: first.id }, ctx.adminToken);
    const body = await getRes.json() as any;
    expect(body.data.relatedItems).toHaveLength(1);
    expect(body.data.relatedItems[0].type).toBe('duplicate');
    expect(body.data.relatedItems[0].item.id).toBe(second.id);
  });

  it('POST /link — duplicate link is idempotent', async () => {
    const first = await createTestItem();
    const second = await createTestItem();

    const firstRes = await post('/link', {
      sourceItemId: first.id,
      targetItemId: second.id,
      type: 'related',
    }, ctx.developerToken);
    const secondRes = await post('/link', {
      sourceItemId: second.id,
      targetItemId: first.id,
      type: 'related',
    }, ctx.developerToken);

    expect(firstRes.status).toBe(201);
    expect(secondRes.status).toBe(200);

    const getRes = await post('/get', { id: first.id }, ctx.adminToken);
    const body = await getRes.json() as any;
    expect(body.data.relatedItems).toHaveLength(1);
  });

  it('POST /link — member cannot link items', async () => {
    const first = await createTestItem();
    const second = await createTestItem();

    const res = await post('/link', {
      sourceItemId: first.id,
      targetItemId: second.id,
      type: 'related',
    }, ctx.memberToken);

    expect(res.status).toBe(403);
  });

  it('POST /link — rejects self-link', async () => {
    const item = await createTestItem();

    const res = await post('/link', {
      sourceItemId: item.id,
      targetItemId: item.id,
      type: 'related',
    }, ctx.developerToken);

    expect(res.status).toBe(400);
  });

  it('POST /link — rejects cross-project links', async () => {
    const first = await createTestItem();
    const otherProjectId = randomUUID();
    ctx.db.insert(projects).values({
      id: otherProjectId,
      name: 'Other Project',
      slug: 'other-project',
      allowedOrigins: '[]',
    }).run();
    const second = await createTestItem(ctx.adminToken, otherProjectId);

    const res = await post('/link', {
      sourceItemId: first.id,
      targetItemId: second.id,
      type: 'related',
    }, ctx.adminToken);

    expect(res.status).toBe(400);
  });

  it('POST /unlink — developer member can remove link', async () => {
    const first = await createTestItem();
    const second = await createTestItem();

    const linkRes = await post('/link', {
      sourceItemId: first.id,
      targetItemId: second.id,
      type: 'related',
    }, ctx.developerToken);
    const linkBody = await linkRes.json() as any;

    const unlinkRes = await post('/unlink', { id: linkBody.data.id }, ctx.developerToken);
    expect(unlinkRes.status).toBe(200);

    const getRes = await post('/get', { id: first.id }, ctx.adminToken);
    const body = await getRes.json() as any;
    expect(body.data.relatedItems).toHaveLength(0);
  });

  it('POST /unlink — member cannot remove link', async () => {
    const first = await createTestItem();
    const second = await createTestItem();

    const linkRes = await post('/link', {
      sourceItemId: first.id,
      targetItemId: second.id,
      type: 'related',
    }, ctx.developerToken);
    const linkBody = await linkRes.json() as any;

    const unlinkRes = await post('/unlink', { id: linkBody.data.id }, ctx.memberToken);
    expect(unlinkRes.status).toBe(403);
  });

  // === AUTO-NOTES ===

  it('claim + resolve creates auto-notes', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);
    await resolveTestItem(item.id);

    const res = await post('/get', { id: item.id }, ctx.adminToken);
    const body = await res.json() as any;
    const notes = body.data.notes;

    // Expect: claim(assignment) + claim(status_change) + resolve(status_change) = 3 auto-notes
    expect(notes.length).toBeGreaterThanOrEqual(3);
    const types = notes.map((n: any) => n.type);
    expect(types).toContain('assignment');
    expect(types).toContain('status_change');
  });

  // === UPDATE ===

  it('POST /update — admin can update message', async () => {
    const item = await createTestItem();

    const res = await post('/update', {
      id: item.id,
      message: 'Updated bug report message',
    }, ctx.adminToken);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.message).toBe('Updated bug report message');
  });

  it('POST /update — admin can update priority', async () => {
    const item = await createTestItem();

    const res = await post('/update', {
      id: item.id,
      priority: 'critical',
    }, ctx.adminToken);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.priority).toBe('critical');
  });

  it('POST /update — admin can update labels', async () => {
    const item = await createTestItem();

    const res = await post('/update', {
      id: item.id,
      labels: ['ui', 'regression'],
    }, ctx.adminToken);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(JSON.parse(body.data.labels)).toEqual(['ui', 'regression']);
  });

  it('POST /update — admin can reassign (update assigneeId)', async () => {
    const item = await createTestItem();

    const res = await post('/update', {
      id: item.id,
      assigneeId: ctx.developerId,
    }, ctx.adminToken);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.assigneeId).toBe(ctx.developerId);
  });

  it('POST /update — non-admin cannot update (403)', async () => {
    const item = await createTestItem();

    const res = await post('/update', {
      id: item.id,
      message: 'Hacked message',
    }, ctx.memberToken);

    expect(res.status).toBe(403);
  });

  it('POST /update — non-existent item returns 404', async () => {
    const res = await post('/update', {
      id: randomUUID(),
      message: 'No such item',
    }, ctx.adminToken);

    expect(res.status).toBe(404);
  });

  // === DELETE ===

  it('POST /delete — admin can delete item', async () => {
    const item = await createTestItem();

    const res = await post('/delete', { id: item.id }, ctx.adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.ok).toBe(true);

    // Verify it's actually gone
    const getRes = await post('/get', { id: item.id }, ctx.adminToken);
    expect(getRes.status).toBe(404);
  });

  it('POST /delete — non-admin cannot delete (403)', async () => {
    const item = await createTestItem();

    const res = await post('/delete', { id: item.id }, ctx.memberToken);
    expect(res.status).toBe(403);
  });

  it('POST /delete — non-existent item returns 404', async () => {
    const res = await post('/delete', { id: randomUUID() }, ctx.adminToken);
    expect(res.status).toBe(404);
  });

  // === REOPEN ===

  it('POST /reopen — admin can reopen done item (→ new)', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);
    await resolveTestItem(item.id);

    const res = await post('/reopen', { id: item.id }, ctx.adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('new');
    expect(body.data.assigneeId).toBeNull();
  });

  it('POST /reopen — admin can reopen done item directly to in_progress', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);
    await resolveTestItem(item.id);

    const res = await post('/reopen', { id: item.id, status: 'in_progress' }, ctx.adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('in_progress');
    expect(body.data.assigneeId).toBe(ctx.adminId);
  });

  it('POST /reopen — records audit reason in auto-note', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);
    await resolveTestItem(item.id);

    const res = await post('/reopen', {
      id: item.id,
      status: 'in_progress',
      reason: 'audit_failed',
      auditResult: 'fail',
    }, ctx.adminToken);
    expect(res.status).toBe(200);

    const getRes = await post('/get', { id: item.id }, ctx.adminToken);
    const body = await getRes.json() as any;
    const reopenNote = body.data.notes
      .map((note: any) => {
        try { return JSON.parse(note.content); } catch { return null; }
      })
      .find((note: any) => note?.type === 'reopen');

    expect(reopenNote).toMatchObject({
      from: 'done',
      to: 'in_progress',
      reason: 'audit_failed',
      auditResult: 'fail',
    });
  });

  it('POST /reopen — admin can reopen cancelled item (→ new)', async () => {
    const item = await createTestItem();
    await post('/cancel', { id: item.id }, ctx.adminToken);

    const res = await post('/reopen', { id: item.id }, ctx.adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('new');
  });

  it('POST /reopen — cannot reopen item already in new (400)', async () => {
    const item = await createTestItem();

    const res = await post('/reopen', { id: item.id }, ctx.adminToken);
    expect(res.status).toBe(400);
  });

  it('POST /reopen — cannot reopen item in in_progress (400)', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);

    const res = await post('/reopen', { id: item.id }, ctx.adminToken);
    expect(res.status).toBe(400);
  });

  it('POST /reopen — non-admin cannot reopen (403)', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);
    await resolveTestItem(item.id);

    const res = await post('/reopen', { id: item.id }, ctx.developerToken);
    expect(res.status).toBe(403);
  });

  // === UPDATE STATUS (generic) ===

  it('POST /update-status — developer member can change in_progress → review', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);

    const res = await post('/update-status', {
      id: item.id,
      status: 'review',
      evidence: testEvidence({ scenario: 'Move item to review' }),
    }, ctx.developerToken);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('review');
  });

  it('POST /update-status — developer member can change review → done', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);
    await post('/update-status', {
      id: item.id,
      status: 'review',
      evidence: testEvidence({ scenario: 'Move item to review handoff' }),
    }, ctx.developerToken);

    const doneRes = await post('/resolve', {
      id: item.id,
      evidence: testEvidence({ scenario: 'Resolve item after review' }),
    }, ctx.developerToken);
    expect(doneRes.status).toBe(200);
    const doneBody = await doneRes.json() as any;
    expect(doneBody.data.status).toBe('done');
  });

  it('POST /update-status — rejects human-only statuses', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);
    await resolveTestItem(item.id);

    const verifiedRes = await post('/update-status', {
      id: item.id,
      status: 'verified',
    }, ctx.developerToken);

    const changesRequestedRes = await post('/update-status', {
      id: item.id,
      status: 'changes_requested',
    }, ctx.developerToken);

    expect(verifiedRes.status).toBe(400);
    expect(changesRequestedRes.status).toBe(400);
  });

  it('POST /update-status — rejects statuses with dedicated endpoints', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);
    await resolveTestItem(item.id);

    for (const status of ['new', 'done', 'cancelled']) {
      const res = await post('/update-status', { id: item.id, status }, ctx.developerToken);
      expect(res.status).toBe(400);
    }

    const unchanged = ctx.db.select().from(scoutItems).where(eq(scoutItems.id, item.id)).get();
    expect(unchanged?.status).toBe('done');
    expect(unchanged?.resolvedAt).toBeTruthy();
    expect(unchanged?.resolvedById).toBe(ctx.developerId);
  });

  it('POST /update-status — rejects new → in_progress without claim', async () => {
    const item = await createTestItem();

    const res = await post('/update-status', {
      id: item.id,
      status: 'in_progress',
    }, ctx.developerToken);

    expect(res.status).toBe(400);

    const unchanged = ctx.db.select().from(scoutItems).where(eq(scoutItems.id, item.id)).get();
    expect(unchanged?.status).toBe('new');
    expect(unchanged?.assigneeId).toBeNull();
  });

  it('POST /update-status — review requires evidence', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);

    const res = await post('/update-status', {
      id: item.id,
      status: 'review',
    }, ctx.developerToken);

    expect(res.status).toBe(400);
  });

  it('POST /update-status — review requires commitSha evidence', async () => {
    const item = await createTestItem();
    await post('/claim', { id: item.id }, ctx.developerToken);

    const res = await post('/update-status', {
      id: item.id,
      status: 'review',
      evidence: {
        kind: 'handoff',
        result: 'pass',
        level: 'browser_acceptance',
        coverage: 'item',
        environment: 'local',
        scenario: 'Move item to review without commit evidence',
        action: 'Checked UI path',
        visibleResult: 'UI path passes',
      },
    }, ctx.developerToken);

    expect(res.status).toBe(400);
  });

  it('POST /update-status — invalid transition returns 400', async () => {
    const item = await createTestItem();

    // new → review is not a valid transition
    const res = await post('/update-status', {
      id: item.id,
      status: 'review',
    }, ctx.developerToken);

    expect(res.status).toBe(400);
  });

  it('POST /update-status — member cannot update status (403)', async () => {
    const item = await createTestItem();

    const res = await post('/update-status', {
      id: item.id,
      status: 'in_progress',
    }, ctx.memberToken);

    expect(res.status).toBe(403);
  });
});
