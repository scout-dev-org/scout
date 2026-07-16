import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { docsRoutes } from '../server/routes/docs.js';

describe('OpenAPI item contracts', () => {
  it('documents lean summaries, opaque revisions, agent acceptance denial, and blocker orthogonality', async () => {
    const app = new Hono();
    app.route('/api/docs', docsRoutes);

    const res = await app.request('/api/docs/openapi.json');
    expect(res.status).toBe(200);
    const spec = await res.json() as any;
    const schemas = spec.components.schemas;
    const summaryProperties = schemas.ItemSummary.properties;

    expect(spec.paths['/items/list'].post.responses['200'].content['application/json']
      .schema.properties.data.properties.items.items.$ref).toBe('#/components/schemas/ItemSummary');
    expect(Object.keys(summaryProperties).sort()).toEqual([
      'assigneeId', 'assigneeName', 'createdAt', 'id', 'itemType', 'labels', 'message',
      'priority', 'projectId', 'reporterId', 'reporterName', 'source', 'status', 'updatedAt',
    ]);
    for (const heavyField of [
      'debugContext', 'metadata', 'pageUrl', 'cssSelector', 'viewportWidth',
      'screenshotPath', 'sessionRecordingPath', 'resolutionNote', 'branchName', 'mrUrl',
      'attemptCount',
    ]) {
      expect(summaryProperties).not.toHaveProperty(heavyField);
    }

    for (const revision of [
      schemas.Item.properties.updatedAt,
      schemas.ItemSummary.properties.updatedAt,
      spec.paths['/items/resolve'].post.requestBody.content['application/json'].schema.properties.updatedAt,
    ]) {
      expect(revision.type).toBe('string');
      expect(revision.format).toBeUndefined();
      expect(revision.description).toMatch(/opaque/i);
      expect(revision.description).toMatch(/without parsing, normalization, or reformatting/i);
    }

    expect(spec.paths['/items/verify'].post.description).toContain('purpose=agent API keys всегда запрещены');
    expect(spec.paths['/items/verify'].post.responses['403'].description).toContain('purpose=agent API key');
    expect(spec.paths['/items/add-evidence'].post.description).toContain('не меняет status или item.updatedAt revision');
    expect(spec.paths['/items/add-evidence'].post.description).toContain('не означает, что item исключён из active queue');
  });
});
