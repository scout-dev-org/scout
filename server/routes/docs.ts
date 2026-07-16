import { Hono } from 'hono';
import { ITEM_STATUSES } from '../db/schema.js';
import {
  DONE_EVIDENCE_LEVELS,
  ITEM_EVIDENCE_COVERAGES,
  ITEM_EVIDENCE_KINDS,
  ITEM_EVIDENCE_LEVELS,
  ITEM_EVIDENCE_REQUIRED_FIELDS,
  ITEM_EVIDENCE_RESULTS,
  ITEM_EVIDENCE_SOURCES,
  UPDATE_ITEM_STATUS_TARGETS,
} from '../lib/item-contract.js';

// ─── OpenAPI 3.0.3 Spec ──────────────────────────────────────────────────────

type OpenApiSchema = Record<string, unknown>;

const AUTH_SECURITY = [{ BearerAuth: [] }, { ApiKeyAuth: [] }];
const STATUS_CONFLICT_RESPONSE = {
  description: 'Переданный client-observed updatedAt устарел, либо SQLite занят конкурентной записью; перечитайте item и повторите допустимую операцию с новой revision',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
};
const ITEM_REVISION_PROPERTY = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  description: 'Opaque item revision token. Клиент обязан вернуть точное значение item.updatedAt из последнего прочитанного item without parsing, normalization, or reformatting; устаревшее или изменённое значение возвращает 409.',
};

function itemRequestSchema(extraProperties: OpenApiSchema = {}, extraRequired: string[] = []): OpenApiSchema {
  return {
    type: 'object',
    required: ['id', ...extraRequired],
    properties: {
      id: { type: 'string', format: 'uuid' },
      ...extraProperties,
    },
  };
}

function itemMutationRequestSchema(extraProperties: OpenApiSchema = {}, extraRequired: string[] = []): OpenApiSchema {
  return itemRequestSchema({ updatedAt: ITEM_REVISION_PROPERTY, ...extraProperties }, ['updatedAt', ...extraRequired]);
}

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Scout Bug Tracking API',
    version: '1.0.0',
    description:
      'Scout — self-hosted bug tracker for AI-assisted product teams. Agent workflows are expected to drive actionable work to the furthest honest status with structured evidence, asking only for hard gates such as missing access, production release, destructive action, external communication, live-money/provider action, secrets exposure, or human acceptance. Для AI/operator completion используйте один endpoint `/items/resolve`; он сам доводит активные рабочие статусы до `done` при наличии passing target evidence. Все API-эндпоинты используют метод POST с JSON-телом (кроме health, events, docs). Авторизация через Bearer JWT или API Key (`sk_live_...`). OpenAPI path keys are relative to `servers[0].url`: for example `/items/list` becomes `/api/items/list` at runtime. Use the exact method, path, and JSON body fields shown by this OpenAPI document; do not infer REST-style item URLs, query-string item reads, or payload fields from endpoint names. Compatibility decision: Scout is pre-release, so item mutation requests intentionally make client-observed `updatedAt` mandatory without a legacy fallback; clients must read the item first and return that opaque string byte-for-byte without parsing, normalization, or reformatting, while stale revisions receive 409. Unknown `/api/*` paths return JSON `API_ENDPOINT_NOT_FOUND` with a docs link and endpoint hint instead of dashboard HTML.',
    contact: { url: 'https://your-scout.example' },
  },
  servers: [
    { url: '/api', description: 'Canonical API base path' },
  ],
  tags: [
    { name: 'Auth', description: 'Аутентификация и валидация токенов' },
    { name: 'Items', description: 'Баги, заметки и задачи (создание, управление статусами, комментарии)' },
    { name: 'Projects', description: 'Управление проектами' },
    { name: 'Users', description: 'Управление пользователями и project roles' },
    { name: 'Webhooks', description: 'Вебхуки для проектных интеграций' },
    { name: 'Notifications', description: 'Email digests and operational notifications' },
    { name: 'API Keys', description: 'Project-scoped API keys для программного доступа' },
    { name: 'Error Integrations', description: 'Runtime error groups and observability bridge endpoints' },
    { name: 'Events', description: 'Server-Sent Events (SSE) для real-time обновлений' },
    { name: 'Health', description: 'Проверка состояния сервера' },
    { name: 'Docs', description: 'Документация API' },
  ],

  // ─── Components ──────────────────────────────────────────────────────────
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT-токен, полученный через POST /auth/login',
      },
      ApiKeyAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API Key',
        description: 'API-ключ формата `sk_live_...`, передаётся как Bearer token',
      },
    },
    schemas: {
      // ── Enums ──
      ItemStatus: {
        type: 'string',
        enum: [...ITEM_STATUSES],
      },
      ItemPriority: {
        type: 'string',
        enum: ['critical', 'high', 'medium', 'low'],
      },
      ItemType: {
        type: 'string',
        enum: ['bug', 'note', 'task'],
      },
      ItemSource: {
        type: 'string',
        enum: ['widget', 'dashboard', 'api', 'agent'],
      },
      DebugContext: {
        type: 'object',
        description: 'Bounded machine-readable browser diagnostic artifact captured by the widget: page, navigation, user actions, console, network, performance, and rrweb recording summary. Stored on Item.debugContext as a JSON string for API responses.',
        properties: {
          version: { type: 'integer', example: 1 },
          capturedAt: { type: 'string', format: 'date-time' },
          page: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              title: { type: 'string' },
              referrer: { type: 'string' },
              route: { type: 'string' },
              visibilityState: { type: 'string' },
              viewport: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } } },
              screen: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' }, devicePixelRatio: { type: 'string' } } },
            },
          },
          navigation: { type: 'array', items: { type: 'object' } },
          actions: { type: 'array', items: { type: 'object' } },
          console: { type: 'array', items: { type: 'object' } },
          network: { type: 'array', items: { type: 'object' } },
          performance: { type: 'object' },
          recordingSummary: {
            type: 'object',
            properties: {
              hasRecording: { type: 'boolean' },
              recordingDurationMs: { type: 'integer' },
              eventCount: { type: 'integer' },
              firstTimestamp: { type: 'integer' },
              lastTimestamp: { type: 'integer' },
              fullSnapshotCount: { type: 'integer' },
              incrementalEventCount: { type: 'integer' },
              recordingPath: { type: 'string', nullable: true },
              importantEvents: { type: 'array', items: { type: 'object' } },
            },
          },
        },
        additionalProperties: true,
      },
      UserRole: {
        type: 'string',
        enum: ['admin', 'member'],
      },
      ProjectRole: {
        type: 'string',
        enum: ['owner', 'manager', 'developer', 'reporter', 'viewer'],
      },
      UserProjectRole: {
        type: 'object',
        required: ['projectId', 'role'],
        properties: {
          projectId: { type: 'string', format: 'uuid' },
          role: { $ref: '#/components/schemas/ProjectRole' },
        },
      },
      WebhookEvent: {
        type: 'string',
        enum: ['item.created', 'item.status_changed', 'item.assigned', 'item.commented', 'item.deleted', 'error_group.created', 'error_group.updated'],
      },
      NoteType: {
        type: 'string',
        enum: ['comment', 'status_change', 'assignment', 'type_change'],
      },
      ItemLinkType: {
        type: 'string',
        enum: ['related', 'duplicate', 'blocks', 'blocked_by', 'caused_by', 'conflicts'],
      },

      // ── Pagination ──
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer', example: 1 },
          perPage: { type: 'integer', example: 20 },
          total: { type: 'integer', example: 42 },
          totalPages: { type: 'integer', example: 3 },
        },
      },
      PaginationInput: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          perPage: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },

      // ── Entities ──
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          name: { type: 'string' },
          role: { $ref: '#/components/schemas/UserRole' },
          isActive: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      UserWithProjects: {
        allOf: [
          { $ref: '#/components/schemas/User' },
          {
            type: 'object',
            properties: {
              projectRoles: { type: 'array', items: { $ref: '#/components/schemas/UserProjectRole' } },
            },
          },
        ],
      },
      Project: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          slug: { type: 'string' },
          allowedOrigins: { type: 'string', description: 'JSON array of allowed origins' },
          isActive: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Item: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          itemType: { $ref: '#/components/schemas/ItemType' },
          source: { $ref: '#/components/schemas/ItemSource' },
          message: { type: 'string' },
          status: { $ref: '#/components/schemas/ItemStatus' },
          priority: { allOf: [{ $ref: '#/components/schemas/ItemPriority' }], nullable: true, description: 'Null for notes; required domain field for bugs/tasks' },
          labels: { type: 'string', nullable: true, description: 'JSON array of label strings' },
          metadata: { type: 'string', nullable: true, description: 'JSON object with environment data' },
          debugContext: { type: 'string', nullable: true, description: 'JSON object string with structured browser diagnostics and rrweb recordingSummary' },
          pageUrl: { type: 'string', nullable: true },
          pageRoute: { type: 'string', nullable: true },
          componentFile: { type: 'string', nullable: true },
          cssSelector: { type: 'string', nullable: true },
          elementText: { type: 'string', nullable: true },
          elementHtml: { type: 'string', nullable: true },
          viewportWidth: { type: 'integer', nullable: true },
          viewportHeight: { type: 'integer', nullable: true },
          screenshotPath: { type: 'string', nullable: true },
          sessionRecordingPath: { type: 'string', nullable: true },
          reporterId: { type: 'string', format: 'uuid', nullable: true },
          reporterName: { type: 'string', nullable: true },
          assigneeId: { type: 'string', format: 'uuid', nullable: true },
          assigneeName: { type: 'string', nullable: true },
          resolvedById: { type: 'string', format: 'uuid', nullable: true },
          resolutionNote: { type: 'string', nullable: true },
          branchName: { type: 'string', nullable: true },
          mrUrl: { type: 'string', nullable: true },
          attemptCount: { type: 'integer' },
          resolvedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: ITEM_REVISION_PROPERTY,
        },
      },
      ItemSummary: {
        type: 'object',
        required: ['id', 'projectId', 'itemType', 'source', 'message', 'status', 'priority', 'labels', 'reporterId', 'reporterName', 'assigneeId', 'assigneeName', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          itemType: { $ref: '#/components/schemas/ItemType' },
          source: { $ref: '#/components/schemas/ItemSource' },
          message: { type: 'string' },
          status: { $ref: '#/components/schemas/ItemStatus' },
          priority: { allOf: [{ $ref: '#/components/schemas/ItemPriority' }], nullable: true },
          labels: { type: 'string', nullable: true, description: 'JSON array of label strings' },
          reporterId: { type: 'string', format: 'uuid', nullable: true },
          reporterName: { type: 'string', nullable: true },
          assigneeId: { type: 'string', format: 'uuid', nullable: true },
          assigneeName: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: ITEM_REVISION_PROPERTY,
        },
      },
      ItemPermissions: {
        type: 'object',
        properties: {
          canClaim: { type: 'boolean' },
          canUpdateStatus: { type: 'boolean' },
          canResolve: { type: 'boolean' },
          canVerify: { type: 'boolean', description: 'Human acceptance permission. Always false for purpose=agent API keys.' },
          canRequestChanges: { type: 'boolean' },
          canCancel: { type: 'boolean' },
          canReopen: { type: 'boolean' },
          canUpdate: { type: 'boolean' },
          canDelete: { type: 'boolean' },
          canComment: { type: 'boolean' },
          canLinkItems: { type: 'boolean' },
        },
      },
      RelatedItem: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Link id' },
          type: { $ref: '#/components/schemas/ItemLinkType' },
          direction: { type: 'string', enum: ['incoming', 'outgoing'] },
          createdAt: { type: 'string', format: 'date-time' },
          item: { $ref: '#/components/schemas/Item' },
        },
      },
      ItemNote: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          itemId: { type: 'string', format: 'uuid' },
          userId: { type: 'string', format: 'uuid', nullable: true },
          userName: { type: 'string', nullable: true },
          content: { type: 'string' },
          type: { $ref: '#/components/schemas/NoteType' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      ItemEvidenceInput: {
        type: 'object',
        required: [...ITEM_EVIDENCE_REQUIRED_FIELDS],
        properties: {
          kind: { type: 'string', enum: [...ITEM_EVIDENCE_KINDS], default: 'handoff' },
          result: { type: 'string', enum: [...ITEM_EVIDENCE_RESULTS], nullable: true },
          level: { type: 'string', enum: [...ITEM_EVIDENCE_LEVELS], nullable: true },
          coverage: { type: 'string', enum: [...ITEM_EVIDENCE_COVERAGES], nullable: true },
          environment: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
          role: { type: 'string', maxLength: 100, nullable: true },
          url: { type: 'string', maxLength: 1000, nullable: true },
          scenario: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
          action: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
          visibleResult: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
          acceptanceScope: { type: 'string', maxLength: 2000, nullable: true },
          consoleResult: { type: 'string', maxLength: 2000, nullable: true },
          networkResult: { type: 'string', maxLength: 2000, nullable: true },
          apiResult: { type: 'string', maxLength: 2000, nullable: true },
          dbResult: { type: 'string', maxLength: 2000, nullable: true },
          fixture: { type: 'string', maxLength: 1000, nullable: true },
          cleanupResult: { type: 'string', maxLength: 2000, nullable: true },
          commitSha: { type: 'string', maxLength: 100, nullable: true },
          deploySha: { type: 'string', maxLength: 100, nullable: true },
          risks: { type: 'string', maxLength: 2000, nullable: true },
          uncheckedRisks: { type: 'string', maxLength: 2000, nullable: true },
          source: { type: 'string', enum: [...ITEM_EVIDENCE_SOURCES], nullable: true },
          verifiedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      CompletionEvidenceInput: {
        allOf: [
          { $ref: '#/components/schemas/ItemEvidenceInput' },
          {
            type: 'object',
            required: ['result', 'level', 'coverage', 'acceptanceScope'],
            properties: {
              result: { type: 'string', enum: ['pass'] },
              level: { type: 'string', enum: [...DONE_EVIDENCE_LEVELS] },
              coverage: { type: 'string', enum: [...ITEM_EVIDENCE_COVERAGES] },
              acceptanceScope: {
                type: 'string',
                minLength: 1,
                maxLength: 2000,
                pattern: '\\S',
                description: 'Non-empty, item-specific statement of the acceptance behavior covered by this completion evidence.',
              },
            },
          },
        ],
      },
      ItemEvidence: {
        allOf: [
          { $ref: '#/components/schemas/ItemEvidenceInput' },
          {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              itemId: { type: 'string', format: 'uuid' },
              userId: { type: 'string', format: 'uuid', nullable: true },
              userName: { type: 'string', nullable: true },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        ],
      },
      ErrorGroup: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          source: { type: 'string' },
          fingerprint: { type: 'string' },
          environment: { type: 'string' },
          service: { type: 'string' },
          routeTemplate: { type: 'string', nullable: true },
          method: { type: 'string', nullable: true },
          upstreamService: { type: 'string', nullable: true },
          errorType: { type: 'string' },
          statusCode: { type: 'integer', nullable: true },
          statusClass: { type: 'string', nullable: true },
          severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
          state: { type: 'string', enum: ['active', 'ignored', 'resolved'] },
          occurrenceCount: { type: 'integer' },
          firstSeenAt: { type: 'string', format: 'date-time' },
          lastSeenAt: { type: 'string', format: 'date-time' },
          linkedItemId: { type: 'string', format: 'uuid', nullable: true },
          linkedItemMessage: { type: 'string', nullable: true },
          ignoredUntil: { type: 'string', format: 'date-time', nullable: true },
          ignoreReason: { type: 'string', nullable: true },
          sampleRequestId: { type: 'string', nullable: true },
          sampleTraceId: { type: 'string', nullable: true },
          grafanaLogsUrl: { type: 'string', nullable: true },
          grafanaTraceUrl: { type: 'string', nullable: true },
          samplePayload: { type: 'string', nullable: true },
          lastRelease: { type: 'string', nullable: true },
          lastRegressionAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Webhook: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          url: { type: 'string', format: 'uri' },
          secret: { type: 'string', nullable: true },
          events: { type: 'string', description: 'JSON array of webhook event types' },
          isActive: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      ApiKeyInfo: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          userId: { type: 'string', format: 'uuid' },
          userName: { type: 'string', nullable: true },
          name: { type: 'string' },
          purpose: { type: 'string', enum: ['agent', 'ci', 'integration', 'custom'] },
          scopes: { type: 'array', items: { type: 'string' } },
          keyPrefix: { type: 'string', description: 'First 16 characters of the key (e.g. sk_live_a1b2c3d4)' },
          lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          revokedAt: { type: 'string', format: 'date-time', nullable: true },
          isActive: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },

      // ── Error ──
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          code: { type: 'string', description: 'Stable machine-readable error code when available' },
        },
        required: ['error'],
      },
    },
  },

  // ─── Paths ───────────────────────────────────────────────────────────────
  paths: {
    // ═══════════════════════ Health ═══════════════════════
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        description: 'Проверка состояния сервера, БД и памяти. Не требует авторизации. Путь: GET /health (не под /api/).',
        servers: [{ url: '/' }],
        responses: {
          200: {
            description: 'Сервер работает',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['ok'] },
                    timestamp: { type: 'string', format: 'date-time' },
                    uptime: { type: 'integer', description: 'Uptime in seconds' },
                    db: { type: 'string', enum: ['ok', 'error'] },
                    memory: {
                      type: 'object',
                      properties: {
                        rss: { type: 'integer', description: 'RSS in MB' },
                        heapUsed: { type: 'integer', description: 'Heap used in MB' },
                      },
                    },
                  },
                },
              },
            },
          },
          503: {
            description: 'Сервер в нерабочем состоянии',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },

    // ═══════════════════════ Auth ═══════════════════════
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Вход в систему',
        description: 'Возвращает JWT-токен и данные пользователя. Rate limit: 5 req/min.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 1 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Успешный вход',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        token: { type: 'string' },
                        user: { $ref: '#/components/schemas/User' },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Неверные email или пароль', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/auth/me': {
      post: {
        tags: ['Auth'],
        summary: 'Текущий пользователь',
        description: 'Возвращает данные текущего авторизованного пользователя.',
        security: AUTH_SECURITY,
        responses: {
          200: {
            description: 'Данные пользователя',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        user: { $ref: '#/components/schemas/User' },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Не авторизован', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Обновить JWT',
        description: 'Возвращает новый JWT-токен и актуальные данные текущего авторизованного пользователя. purpose=agent API keys получают 403 и не могут обменять ограниченный credential на human JWT; другие API key purposes сохраняют текущее поведение.',
        security: AUTH_SECURITY,
        responses: {
          200: {
            description: 'Токен обновлён',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        token: { type: 'string' },
                        user: { $ref: '#/components/schemas/User' },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Не авторизован', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'purpose=agent API key не может получить human JWT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/auth/validate': {
      post: {
        tags: ['Auth'],
        summary: 'Валидация токена',
        description: 'SSO-эндпоинт — внешние сервисы валидируют JWT или API Key. Не требует авторизации.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token'],
                properties: {
                  token: { type: 'string', minLength: 1, description: 'JWT-токен или API-ключ (sk_live_...)' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Результат валидации',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    valid: { type: 'boolean' },
                    user: { $ref: '#/components/schemas/User' },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ═══════════════════════ Items ═══════════════════════
    '/items/create': {
      post: {
        tags: ['Items'],
        summary: 'Создать item',
        description: 'Создаёт баг, заметку или задачу в проекте. Виджет по умолчанию создаёт bug; заметки нужно преобразовать в task перед workflow-работой. Требуется project permission `create_item` (admin/owner/manager/reporter). Rate limit: 20 req/min.',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['projectId', 'message'],
                properties: {
                  projectId: { type: 'string', format: 'uuid' },
                  itemType: { $ref: '#/components/schemas/ItemType', default: 'bug' },
                  message: { type: 'string', minLength: 3 },
                  dedupeKey: { type: 'string', minLength: 8, maxLength: 200, description: 'Optional idempotency key. Reusing it shortly after a successful create returns the existing item instead of creating a duplicate.' },
                  priority: { $ref: '#/components/schemas/ItemPriority', default: 'medium', description: 'Ignored and stored as null for notes' },
                  labels: { type: 'array', items: { type: 'string', maxLength: 50 }, maxItems: 10 },
                  pageUrl: { type: 'string', maxLength: 500, nullable: true },
                  pageRoute: { type: 'string', maxLength: 255, nullable: true },
                  componentFile: { type: 'string', maxLength: 255, nullable: true },
                  cssSelector: { type: 'string', maxLength: 1000, nullable: true },
                  elementText: { type: 'string', nullable: true, description: 'Truncated to 500 chars' },
                  elementHtml: { type: 'string', nullable: true, description: 'Truncated to 2000 chars' },
                  viewportWidth: { type: 'integer', minimum: 1, nullable: true },
                  viewportHeight: { type: 'integer', minimum: 1, nullable: true },
                  screenshot: { type: 'string', maxLength: 7000000, nullable: true, description: 'Base64-encoded image (~5MB max)' },
                  sessionRecording: { type: 'string', maxLength: 3000000, nullable: true, description: 'Base64-encoded raw or gzip-compressed rrweb JSON event array (~2MB max)' },
                  metadata: { type: 'object', additionalProperties: { type: 'string' }, nullable: true, description: 'Auto-captured environment data' },
                  debugContext: { allOf: [{ $ref: '#/components/schemas/DebugContext' }], nullable: true },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Item создан',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Item' } } },
              },
            },
          },
          200: {
            description: 'Duplicate submission accepted; existing recent item returned',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Item' } } },
              },
            },
          },
          401: { description: 'Не авторизован', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Нет доступа к проекту', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Проект не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/items/list': {
      post: {
        tags: ['Items'],
        summary: 'Список items',
        description: 'Пагинированный lightweight summary список items проекта с фильтрацией. Полный context и тяжёлые diagnostics доступны через `/items/get`. Требуется доступ к проекту.',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['projectId'],
                properties: {
                  projectId: { type: 'string', format: 'uuid' },
                  itemType: { $ref: '#/components/schemas/ItemType' },
                  status: { $ref: '#/components/schemas/ItemStatus' },
                  statuses: { type: 'array', items: { $ref: '#/components/schemas/ItemStatus' }, minItems: 1, maxItems: ITEM_STATUSES.length, description: 'Filter by multiple statuses, useful for human queue groups such as Needs Review = review + changes_requested. If status is provided, status takes precedence.' },
                  priority: { $ref: '#/components/schemas/ItemPriority' },
                  assigneeId: { type: 'string', format: 'uuid' },
                  search: { type: 'string', maxLength: 200, description: 'Поиск по тексту сообщения (LIKE)' },
                  page: { type: 'integer', minimum: 1, default: 1 },
                  perPage: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Список items',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        items: { type: 'array', items: { $ref: '#/components/schemas/ItemSummary' } },
                        pagination: { $ref: '#/components/schemas/Pagination' },
                      },
                    },
                  },
                },
              },
            },
          },
          403: { description: 'Нет доступа к проекту', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/items/get': {
      post: {
        tags: ['Items'],
        summary: 'Получить item с заметками и evidence',
        description: 'Возвращает item, заметки, structured evidence, связанные items, linked runtime error groups и permissions текущего пользователя. Требуется доступ к проекту.',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: itemRequestSchema(),
            },
          },
        },
        responses: {
          200: {
            description: 'Item с заметками',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      allOf: [
                        { $ref: '#/components/schemas/Item' },
                        {
                          type: 'object',
                          properties: {
                            notes: { type: 'array', items: { $ref: '#/components/schemas/ItemNote' } },
                            evidence: { type: 'array', items: { $ref: '#/components/schemas/ItemEvidence' } },
                            errorGroups: { type: 'array', items: { $ref: '#/components/schemas/ErrorGroup' } },
                            relatedItems: { type: 'array', items: { $ref: '#/components/schemas/RelatedItem' } },
                            permissions: { $ref: '#/components/schemas/ItemPermissions' },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          404: { description: 'Item не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/items/count': {
      post: {
        tags: ['Items'],
        summary: 'Количество items по статусам',
        description: 'Возвращает количество items по каждому статусу для проекта. Требуется доступ к проекту.',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['projectId'],
                properties: {
                  projectId: { type: 'string', format: 'uuid' },
                  itemType: { $ref: '#/components/schemas/ItemType' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Counts по статусам',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        counts: {
                          type: 'object',
                          properties: {
                            new: { type: 'integer' },
                            in_progress: { type: 'integer' },
                            review: { type: 'integer' },
                            done: { type: 'integer' },
                            changes_requested: { type: 'integer' },
                            verified: { type: 'integer' },
                            cancelled: { type: 'integer' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/items/claim': {
      post: {
        tags: ['Items'],
        summary: 'Взять item в работу',
        description: 'Назначает текущего пользователя исполнителем и переводит новый item в in_progress, когда агент начинает длительную работу без готового completion evidence. Не используйте `/items/claim` как предварительный шаг перед `/items/resolve`: completion endpoint сам доводит активный item до `done`. Требуется project permission `workflow` (admin/owner/manager/developer).',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: itemMutationRequestSchema(),
            },
          },
        },
        responses: {
          200: {
            description: 'Item обновлён',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Item' } } } } },
          },
          409: STATUS_CONFLICT_RESPONSE,
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Item не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/items/resolve': {
      post: {
        tags: ['Items'],
        summary: 'Подготовить item к human acceptance (resolve)',
        description: 'Единственный endpoint для AI/operator completion. Переводит активный item из `new`, `in_progress`, `review` или `changes_requested` в `done` только с inline `CompletionEvidenceInput`: passing result, accepted completion level, coverage и непустые environment/scenario/action/visibleResult/item-specific acceptanceScope обязательны. Переход сохраняет текущего assignee; resolvedById фиксирует выполнившего completion пользователя. Каждый вызов, включая вызов для уже `done` item, обязан передать точный текущий `updatedAt`; stale revision всегда возвращает 409, поскольку запрос не содержит operation/request identity для доказуемо безопасного stale retry. При текущей revision идентичные refs/resolutionNote/evidence не меняют item и не дублируют evidence; изменённые refs/resolutionNote или новое evidence обновляют item и публикуют SSE `item.updated` без нового status transition. Вызов для уже `done` item может не содержать evidence; переданное evidence обязано соответствовать completion schema и сохраняется как `kind:"verification"`. `verified` и `cancelled` через resolve не меняются; конкурентное изменение состояния или revision возвращает 409. Требуется project permission `workflow` (admin/owner/manager/developer).',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: itemMutationRequestSchema({
                resolutionNote: { type: 'string', maxLength: 5000 },
                branchName: { type: 'string', maxLength: 255 },
                mrUrl: { type: 'string', format: 'uri', maxLength: 500 },
                evidence: { $ref: '#/components/schemas/CompletionEvidenceInput' },
              }),
            },
          },
        },
        responses: {
          200: {
            description: 'Item resolved',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Item' } } } } },
          },
          409: STATUS_CONFLICT_RESPONSE,
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Item не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/items/cancel': {
      post: {
        tags: ['Items'],
        summary: 'Отменить item',
        description: 'Переводит item в статус cancelled, сохраняя assignee. Reporter может отменить только свой item, который всё ещё находится в `new`; конкурентное изменение статуса возвращает 409. Требуется project permission `triage`, кроме указанного reporter-сценария.',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: itemMutationRequestSchema(),
            },
          },
        },
        responses: {
          200: {
            description: 'Item cancelled',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Item' } } } } },
          },
          409: STATUS_CONFLICT_RESPONSE,
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Item не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/items/update-status': {
      post: {
        tags: ['Items'],
        summary: 'Обновить статус item',
        description: 'Универсальный эндпоинт только для промежуточных инженерных workflow-переходов в `in_progress` или `review`. Используйте `/items/claim` только для начала длительной работы над новым item, `/items/resolve` как единственный AI/operator completion endpoint для `done`, `/items/verify` для `verified`, `/items/request-changes` для `changes_requested`, `/items/cancel` для `cancelled` и `/items/reopen` для возврата в `new`. Переход сохраняет assignee; переход в review требует inline structured evidence в этом запросе, включая `result:"pass"` и `commitSha`. Конкурентное изменение статуса возвращает 409. Требуется project permission `workflow` (admin/owner/manager/developer).',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: itemMutationRequestSchema({
                status: { type: 'string', enum: [...UPDATE_ITEM_STATUS_TARGETS] },
                branchName: { type: 'string', maxLength: 255 },
                mrUrl: { type: 'string', format: 'uri', maxLength: 500 },
                attemptCount: { type: 'integer', minimum: 0 },
                evidence: { $ref: '#/components/schemas/ItemEvidenceInput' },
              }, ['status']),
            },
          },
        },
        responses: {
          200: {
            description: 'Статус обновлён',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Item' } } } } },
          },
          409: STATUS_CONFLICT_RESPONSE,
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Item не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/items/verify': {
      post: {
        tags: ['Items'],
        summary: 'Принять item человеком',
        description: 'Переводит item из done в verified после human acceptance. Не перетирает assignee, resolvedById или resolvedAt; переданный comment сохраняется атомарно с переходом. Конкурентное изменение состояния или revision возвращает 409. Требуется project permission `accept_item` (admin/owner/manager); purpose=agent API keys всегда запрещены, включая ключи system admin. JWT human sessions и другие API key purposes следуют обычной role/scope policy.',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: itemMutationRequestSchema({
                comment: { type: 'string', maxLength: 5000 },
                evidence: { $ref: '#/components/schemas/ItemEvidenceInput' },
              }),
            },
          },
        },
        responses: {
          200: {
            description: 'Item verified',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Item' } } } } },
          },
          409: STATUS_CONFLICT_RESPONSE,
          403: { description: 'Нет human acceptance permission либо credential является purpose=agent API key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Item не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/items/request-changes': {
      post: {
        tags: ['Items'],
        summary: 'Вернуть item на правки',
        description: 'Переводит item из review/done/verified в changes_requested, сохраняет assignee и атомарно добавляет actionable note с expected/actual context. Конкурентное изменение состояния или revision возвращает 409. Требуется project permission `triage` (admin/owner/manager).',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: itemMutationRequestSchema({
                summary: { type: 'string', minLength: 3, maxLength: 2000 },
                expected: { type: 'string', minLength: 1, maxLength: 2000 },
                actual: { type: 'string', minLength: 1, maxLength: 2000 },
                steps: { type: 'string', maxLength: 5000 },
                url: { type: 'string', maxLength: 1000 },
                evidence: { $ref: '#/components/schemas/ItemEvidenceInput' },
              }, ['summary', 'expected', 'actual']),
            },
          },
        },
        responses: {
          200: {
            description: 'Changes requested',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Item' } } } } },
          },
          409: STATUS_CONFLICT_RESPONSE,
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Item не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/items/reopen': {
      post: {
        tags: ['Items'],
        summary: 'Переоткрыть item',
        description: 'Возвращает item из done/verified/cancelled в статус new с очисткой assignee или сразу в in_progress с явным назначением текущего пользователя. Конкурентное изменение статуса возвращает 409. Требуется project permission `triage` (admin/owner/manager).',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: itemMutationRequestSchema({
                status: { type: 'string', enum: ['new', 'in_progress'], description: 'Optional target status. Defaults to new. Use in_progress to reopen and assign the item to the caller.' },
                reason: { type: 'string', enum: ['audit_failed', 'audit_blocked', 'staging_failed', 'regression', 'manual'], description: 'Optional reopen reason for structured history and audit logs.' },
                auditResult: { type: 'string', enum: ['fail', 'blocked'], description: 'Optional completed-item audit result that caused the reopen.' },
              }),
            },
          },
        },
        responses: {
          200: {
            description: 'Item reopened',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Item' } } } } },
          },
          409: STATUS_CONFLICT_RESPONSE,
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Item не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/items/update': {
      post: {
        tags: ['Items'],
        summary: 'Обновить item',
        description: 'Обновляет поля item (itemType, message, priority, labels, assigneeId) с revision-aware CAS. Конкурентное изменение item возвращает 409. Требуется project permission `triage` (admin/owner/manager).',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: itemMutationRequestSchema({
                itemType: { $ref: '#/components/schemas/ItemType' },
                message: { type: 'string', minLength: 3 },
                assigneeId: { type: 'string', format: 'uuid', nullable: true },
                priority: { $ref: '#/components/schemas/ItemPriority' },
                labels: { type: 'array', items: { type: 'string', maxLength: 50 }, maxItems: 10 },
              }),
            },
          },
        },
        responses: {
          200: {
            description: 'Item обновлён',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Item' } } } } },
          },
          409: STATUS_CONFLICT_RESPONSE,
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Item не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/items/delete': {
      post: {
        tags: ['Items'],
        summary: 'Удалить item',
        description: 'Удаляет item и связанные заметки. Требуется project permission `triage` (admin/owner/manager).',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: itemMutationRequestSchema(),
            },
          },
        },
        responses: {
          200: {
            description: 'Item удалён',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: { type: 'object', properties: { ok: { type: 'boolean' } } } } },
              },
            },
          },
          409: STATUS_CONFLICT_RESPONSE,
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Item не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/items/add-evidence': {
      post: {
        tags: ['Items'],
        summary: 'Добавить structured evidence',
        description: 'Добавляет supplemental structured evidence к item. Blocker evidence ортогонален workflow status: запись сама по себе не меняет status или item.updatedAt revision и не означает, что item исключён из active queue. Для переходов в review/done агентские workflow передают evidence inline в status request. Требуется project permission `comment`.',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/ItemEvidenceInput' },
                  itemRequestSchema(),
                ],
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Evidence создан',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/ItemEvidence' } } } } },
          },
          404: { description: 'Item не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/items/add-note': {
      post: {
        tags: ['Items'],
        summary: 'Добавить заметку',
        description: 'Добавляет комментарий к item. Требуется project permission `comment` (admin/owner/manager/developer/reporter).',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: itemRequestSchema({
                content: { type: 'string', minLength: 1, maxLength: 5000 },
              }, ['content']),
            },
          },
        },
        responses: {
          201: {
            description: 'Заметка создана',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/ItemNote' } } },
              },
            },
          },
          404: { description: 'Item не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/items/link': {
      post: {
        tags: ['Items'],
        summary: 'Связать items',
        description: 'Создаёт связь между двумя items одного проекта. Требуется project permission `workflow` (admin/owner/manager/developer).',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sourceItemId', 'targetItemId', 'type'],
                properties: {
                  sourceItemId: { type: 'string', format: 'uuid' },
                  targetItemId: { type: 'string', format: 'uuid' },
                  type: { $ref: '#/components/schemas/ItemLinkType' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Связь создана' },
          200: { description: 'Связь уже существовала' },
          400: { description: 'Нельзя связать item с самим собой или items из разных проектов', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Item не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/items/unlink': {
      post: {
        tags: ['Items'],
        summary: 'Удалить связь items',
        description: 'Удаляет связь между items. Требуется project permission `workflow` (admin/owner/manager/developer).',
        security: AUTH_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string', format: 'uuid', description: 'Link id from relatedItems[].id' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Связь удалена' },
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Связь или item не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ═══════════════════════ Notifications ═══════════════════════
    '/notifications/daily-digest/run': {
      post: {
        tags: ['Notifications'],
        summary: 'Run daily email digest',
        description: 'Admin-only operational endpoint. Builds the concise per-user daily Scout email digest for a date (`YYYY-MM-DD`) and either sends it through SMTP or returns a dry-run summary. Normal delivery is handled by the daily worker using `SCOUT_DAILY_DIGEST_TIME` and `SCOUT_DAILY_DIGEST_TIMEZONE`.',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Local digest date. Defaults to today in the configured digest timezone.' },
                  dryRun: { type: 'boolean', description: 'When true, returns summaries without sending email or recording delivery.' },
                  force: { type: 'boolean', description: 'When true, sends even if delivery for this user/date is already recorded.' },
                  recipientEmail: { type: 'string', format: 'email', description: 'Optional exact recipient email filter for one-off operational sends.' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Digest run summary',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          403: { description: 'Only system admin can run notification jobs manually', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ═══════════════════════ Projects ═══════════════════════
    '/projects/create': {
      post: {
        tags: ['Projects'],
        summary: 'Создать проект',
        description: 'Создаёт новый проект. Slug должен быть уникальным. Требуется system admin.',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'slug'],
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 100 },
                  slug: { type: 'string', minLength: 2, maxLength: 50, pattern: '^[a-z0-9-]+$', description: 'Lowercase alphanumeric with hyphens' },
                  allowedOrigins: { type: 'array', items: { type: 'string', format: 'uri' }, default: [] },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Проект создан',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Project' } } } } },
          },
          403: { description: 'Только system admin', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: 'Slug уже существует', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/projects/list': {
      post: {
        tags: ['Projects'],
        summary: 'Список проектов',
        description: 'Пагинированный список проектов. System admin видит все, остальные — только назначенные проекты.',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                allOf: [{ $ref: '#/components/schemas/PaginationInput' }],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Список проектов',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        items: { type: 'array', items: { $ref: '#/components/schemas/Project' } },
                        pagination: { $ref: '#/components/schemas/Pagination' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/projects/get': {
      post: {
        tags: ['Projects'],
        summary: 'Получить проект',
        description: 'Возвращает данные проекта. Требуется доступ к проекту.',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Данные проекта',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Project' } } } } },
          },
          403: { description: 'Нет доступа к проекту', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Проект не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/projects/update': {
      post: {
        tags: ['Projects'],
        summary: 'Обновить проект',
        description: 'Обновляет поля проекта. Требуется system admin или project permission `manage_project` (owner).',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  name: { type: 'string', minLength: 1, maxLength: 100 },
                  allowedOrigins: { type: 'array', items: { type: 'string', format: 'uri' } },
                  isActive: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Проект обновлён',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Project' } } } } },
          },
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Проект не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/projects/delete': {
      post: {
        tags: ['Projects'],
        summary: 'Удалить проект',
        description: 'Удаляет проект (только если нет items). Требуется system admin.',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Проект удалён',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: { type: 'object', properties: { success: { type: 'boolean' } } } } },
              },
            },
          },
          403: { description: 'Только system admin', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Проект не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          422: { description: 'Проект содержит items', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ═══════════════════════ Users ═══════════════════════
    '/users/create': {
      post: {
        tags: ['Users'],
        summary: 'Создать пользователя',
        description: 'Создаёт нового пользователя с назначением на проекты. Доступ: system admin или project owner для своих проектов.',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password', 'name', 'role'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 8, maxLength: 128, description: 'Must contain lowercase, uppercase letter and digit' },
                  name: { type: 'string', minLength: 1, maxLength: 100 },
                  role: { $ref: '#/components/schemas/UserRole' },
                  projectRoles: { type: 'array', items: { $ref: '#/components/schemas/UserProjectRole' } },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Пользователь создан',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/UserWithProjects' } } } } },
          },
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: 'Email уже существует', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/users/list': {
      post: {
        tags: ['Users'],
        summary: 'Список пользователей',
        description: 'Пагинированный список пользователей, опционально фильтрация по проекту. System admin видит всех; project owner видит пользователей управляемых проектов.',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  projectId: { type: 'string', format: 'uuid', description: 'Фильтр по проекту' },
                  page: { type: 'integer', minimum: 1, default: 1 },
                  perPage: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Список пользователей',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        items: { type: 'array', items: { $ref: '#/components/schemas/UserWithProjects' } },
                        pagination: { $ref: '#/components/schemas/Pagination' },
                      },
                    },
                  },
                },
              },
            },
          },
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/users/get': {
      post: {
        tags: ['Users'],
        summary: 'Получить пользователя',
        description: 'Возвращает данные пользователя с назначенными проектами. System admin видит всех; project owner видит пользователей управляемых проектов.',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Данные пользователя',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/UserWithProjects' } } } } },
          },
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Пользователь не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/users/update': {
      post: {
        tags: ['Users'],
        summary: 'Обновить пользователя',
        description: 'Обновляет поля пользователя и/или привязку к проектам. System admin может менять системные поля; project owner может менять только роли в управляемых проектах.',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  name: { type: 'string', minLength: 1, maxLength: 100 },
                  role: { $ref: '#/components/schemas/UserRole' },
                  isActive: { type: 'boolean' },
                  projectRoles: { type: 'array', items: { $ref: '#/components/schemas/UserProjectRole' } },
                  password: { type: 'string', minLength: 8, maxLength: 128, description: 'Must contain lowercase, uppercase letter and digit' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Пользователь обновлён',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/UserWithProjects' } } } } },
          },
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Пользователь не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/users/delete': {
      post: {
        tags: ['Users'],
        summary: 'Удалить пользователя',
        description: 'Удаляет пользователя (нельзя удалить самого себя). Требуется system admin.',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Пользователь удалён',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: { type: 'object', properties: { success: { type: 'boolean' } } } } },
              },
            },
          },
          403: { description: 'Только system admin', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Пользователь не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: 'Нельзя удалить самого себя', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ═══════════════════════ Webhooks ═══════════════════════
    '/webhooks/create': {
      post: {
        tags: ['Webhooks'],
        summary: 'Создать вебхук',
        description: 'Создаёт webhook для проекта. Требуется project permission `manage_integrations` (admin/owner/manager).',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['projectId', 'url', 'events'],
                properties: {
                  projectId: { type: 'string', format: 'uuid' },
                  url: { type: 'string', format: 'uri', maxLength: 500 },
                  secret: { type: 'string', maxLength: 255, description: 'HMAC signing secret' },
                  events: {
                    type: 'array',
                    minItems: 1,
                    items: { $ref: '#/components/schemas/WebhookEvent' },
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Webhook создан',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Webhook' } } } } },
          },
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Проект не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/webhooks/list': {
      post: {
        tags: ['Webhooks'],
        summary: 'Список вебхуков',
        description: 'Список вебхуков проекта. Требуется project permission `manage_integrations` (admin/owner/manager).',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['projectId'],
                properties: {
                  projectId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Список вебхуков',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        items: { type: 'array', items: { $ref: '#/components/schemas/Webhook' } },
                      },
                    },
                  },
                },
              },
            },
          },
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/webhooks/update': {
      post: {
        tags: ['Webhooks'],
        summary: 'Обновить вебхук',
        description: 'Обновляет настройки webhook. Требуется project permission `manage_integrations` (admin/owner/manager).',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  url: { type: 'string', format: 'uri', maxLength: 500 },
                  secret: { type: 'string', maxLength: 255 },
                  events: {
                    type: 'array',
                    minItems: 1,
                    items: { $ref: '#/components/schemas/WebhookEvent' },
                  },
                  isActive: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Webhook обновлён',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Webhook' } } } } },
          },
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Webhook не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/webhooks/delete': {
      post: {
        tags: ['Webhooks'],
        summary: 'Удалить вебхук',
        description: 'Удаляет webhook. Требуется project permission `manage_integrations` (admin/owner/manager).',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Webhook удалён',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: { type: 'object', properties: { ok: { type: 'boolean' } } } } },
              },
            },
          },
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Webhook не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/webhooks/test': {
      post: {
        tags: ['Webhooks'],
        summary: 'Тест вебхука',
        description: 'Отправляет тестовый payload на URL вебхука. Требуется project permission `manage_integrations` (admin/owner/manager).',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Результат отправки',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        success: { type: 'boolean' },
                        statusCode: { type: 'integer' },
                        error: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Webhook не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ═══════════════════════ API Keys ═══════════════════════
    '/api-keys/create': {
      post: {
        tags: ['API Keys'],
        summary: 'Создать API-ключ',
        description: 'Генерирует новый project-scoped API-ключ. Полный ключ возвращается ТОЛЬКО один раз. Требуется project permission `manage_integrations` (admin/owner/manager). API keys не могут выпускать другие API keys.',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['projectId', 'name'],
                properties: {
                  projectId: { type: 'string', format: 'uuid' },
                  name: { type: 'string', minLength: 1, maxLength: 100, description: 'Human-readable name (e.g. "CI/CD", "Slack Bot")' },
                  purpose: { type: 'string', enum: ['agent', 'ci', 'integration', 'custom'], default: 'custom' },
                  scopes: { type: 'array', items: { type: 'string' }, description: 'Optional explicit scopes. Defaults are chosen from purpose.' },
                  expiresAt: { type: 'string', format: 'date-time', description: 'Optional expiration date. Null = never expires.' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'API-ключ создан (полный ключ показывается один раз)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        key: { type: 'string', description: 'Full API key (sk_live_...). Shown only once!' },
                        id: { type: 'string', format: 'uuid' },
                        name: { type: 'string' },
                        purpose: { type: 'string' },
                        scopes: { type: 'array', items: { type: 'string' } },
                        keyPrefix: { type: 'string' },
                        projectId: { type: 'string', format: 'uuid' },
                        expiresAt: { type: 'string', format: 'date-time', nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Проект не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api-keys/list': {
      post: {
        tags: ['API Keys'],
        summary: 'Список API-ключей',
        description: 'Список API-ключей проекта (без полного ключа, только prefix). Требуется project permission `manage_integrations` (admin/owner/manager).',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['projectId'],
                properties: {
                  projectId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Список API-ключей',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        items: { type: 'array', items: { $ref: '#/components/schemas/ApiKeyInfo' } },
                      },
                    },
                  },
                },
              },
            },
          },
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api-keys/revoke': {
      post: {
        tags: ['API Keys'],
        summary: 'Отозвать API-ключ',
        description: 'Отзывает API-ключ (isActive = false, revokedAt = now). Требуется project permission `manage_integrations` (admin/owner/manager).',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'API-ключ отозван',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: { type: 'object', properties: { success: { type: 'boolean' } } } } },
              },
            },
          },
          403: { description: 'Недостаточно прав', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'API-ключ не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ═══════════════════════ Error Integrations ═══════════════════════
    '/integrations/errors/upsert': {
      post: {
        tags: ['Error Integrations'],
        summary: 'Create or update runtime error group',
        description: 'Upserts an error group from observability/runtime data. New linked Scout items are auto-accepted as `verified` system evidence, and existing non-cancelled linked runtime items are normalized to `verified` on recurrence instead of reopening into the normal work queue. Requires `write_errors` project permission or API key scope `errors:write`.',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['projectId', 'fingerprint', 'environment', 'service', 'errorType'],
                properties: {
                  projectId: { type: 'string', format: 'uuid' },
                  source: { type: 'string', default: 'alertmanager' },
                  fingerprint: { type: 'string', maxLength: 200 },
                  environment: { type: 'string', maxLength: 80 },
                  service: { type: 'string', maxLength: 120 },
                  routeTemplate: { type: 'string', maxLength: 300 },
                  method: { type: 'string', maxLength: 20 },
                  upstreamService: { type: 'string', maxLength: 120 },
                  errorType: { type: 'string', maxLength: 120 },
                  statusCode: { type: 'integer', minimum: 100, maximum: 599 },
                  statusClass: { type: 'string', maxLength: 20 },
                  severity: { type: 'string', enum: ['info', 'warning', 'critical'], default: 'warning' },
                  occurredAt: { type: 'string', format: 'date-time' },
                  sampleRequestId: { type: 'string', maxLength: 160 },
                  sampleTraceId: { type: 'string', maxLength: 160 },
                  grafanaLogsUrl: { type: 'string', format: 'uri' },
                  grafanaTraceUrl: { type: 'string', format: 'uri' },
                  samplePayload: { type: 'object', additionalProperties: true },
                  title: { type: 'string', maxLength: 240 },
                  message: { type: 'string', maxLength: 4000 },
                  release: { type: 'string', maxLength: 120 },
                  cooldownKey: { type: 'string', maxLength: 120 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Error group updated', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { errorGroup: { $ref: '#/components/schemas/ErrorGroup' } } } } } } } },
          201: { description: 'Error group created', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { errorGroup: { $ref: '#/components/schemas/ErrorGroup' } } } } } } } },
          409: STATUS_CONFLICT_RESPONSE,
        },
      },
    },
    '/integrations/errors/list': {
      post: {
        tags: ['Error Integrations'],
        summary: 'List runtime error groups',
        description: 'Lists error groups for a project. Requires project access or API key scope `items:read`/project match.',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['projectId'],
                properties: {
                  projectId: { type: 'string', format: 'uuid' },
                  state: { type: 'string', enum: ['active', 'ignored', 'resolved'] },
                  service: { type: 'string', maxLength: 120 },
                  environment: { type: 'string', maxLength: 80 },
                  severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
                  linkedItemId: { type: 'string', format: 'uuid' },
                  page: { type: 'integer', minimum: 1, default: 1 },
                  perPage: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Error groups', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/ErrorGroup' } }, pagination: { $ref: '#/components/schemas/Pagination' } } } } } } } },
        },
      },
    },
    '/integrations/errors/get': {
      post: {
        tags: ['Error Integrations'],
        summary: 'Get runtime error group',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } } },
        responses: { 200: { description: 'Error group', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { errorGroup: { $ref: '#/components/schemas/ErrorGroup' } } } } } } } } },
      },
    },
    '/integrations/errors/ignore': {
      post: {
        tags: ['Error Integrations'],
        summary: 'Ignore runtime error group',
        description: 'Requires `triage_errors` project permission or API key scope `errors:triage`.',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['id', 'ignoreReason'], properties: { id: { type: 'string', format: 'uuid' }, ignoredUntil: { type: 'string', format: 'date-time' }, ignoreReason: { type: 'string', minLength: 1, maxLength: 1000 } } } } } },
        responses: { 200: { description: 'Error group ignored', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { errorGroup: { $ref: '#/components/schemas/ErrorGroup' } } } } } } } } },
      },
    },
    '/integrations/errors/unignore': {
      post: {
        tags: ['Error Integrations'],
        summary: 'Unignore runtime error group',
        description: 'Requires `triage_errors` project permission or API key scope `errors:triage`.',
        security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } } },
        responses: { 200: { description: 'Error group restored', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { errorGroup: { $ref: '#/components/schemas/ErrorGroup' } } } } } } } } },
      },
    },
    '/integrations/errors/bridge/alertmanager': {
      post: {
        tags: ['Error Integrations'],
        summary: 'Alertmanager bridge webhook',
        description: 'Queues Alertmanager payloads. Guarded by `SCOUT_ERROR_BRIDGE_SECRET` via `X-Scout-Error-Bridge-Secret` or Bearer secret.',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['alerts'], properties: { alerts: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object' } } } } } } },
        responses: { 202: { description: 'Queued' }, 200: { description: 'Duplicate already queued' }, 503: { description: 'Bridge disabled' } },
      },
    },
    '/integrations/errors/bridge/health': {
      get: {
        tags: ['Error Integrations'],
        summary: 'Error bridge queue health',
        security: [],
        responses: { 200: { description: 'Bridge queue status' } },
      },
    },

    // ═══════════════════════ Events (SSE) ═══════════════════════
    '/events/stream': {
      get: {
        tags: ['Events'],
        summary: 'Real-time события (SSE)',
        description:
          'Server-Sent Events stream. Авторизация через query parameter `token` (EventSource не поддерживает заголовки). Опциональный фильтр по projectId. Путь: GET /api/events/stream (зарегистрирован ДО rate limiter).',
        parameters: [
          {
            name: 'token',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'JWT-токен для авторизации',
          },
          {
            name: 'projectId',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'uuid' },
            description: 'Фильтр по проекту (если не указан — все доступные проекты)',
          },
        ],
        responses: {
          200: {
            description: 'SSE stream. События: item.created, item.status_changed, item.assigned, item.commented, item.deleted, item.updated. Heartbeat каждые 30 сек.',
            content: {
              'text/event-stream': {
                schema: { type: 'string' },
              },
            },
          },
          401: {
            description: 'Token отсутствует или невалиден',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },

    // ═══════════════════════ Docs ═══════════════════════
    '/docs/openapi.json': {
      get: {
        tags: ['Docs'],
        summary: 'OpenAPI спецификация',
        description: 'Возвращает OpenAPI 3.0.3 JSON спецификацию API.',
        servers: [{ url: '/api' }],
        responses: {
          200: {
            description: 'OpenAPI spec',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
} as const;

// ─── Swagger UI HTML ──────────────────────────────────────────────────────────

const swaggerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Scout API Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none !important; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/docs/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [
        SwaggerUIBundle.presets.apis,
        SwaggerUIBundle.SwaggerUIStandalonePreset,
      ],
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>`;

// ─── Routes ───────────────────────────────────────────────────────────────────

export const docsRoutes = new Hono()
  .get('/openapi.json', (c) => c.json(spec))
  .get('/', (c) => c.html(swaggerHtml));
