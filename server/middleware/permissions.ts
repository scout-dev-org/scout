import { createMiddleware } from 'hono/factory';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pivotUsersProjects, type ApiKey, type ProjectRole, type UserRole } from '../db/schema.js';
import { getApiKeyScopes, type ApiKeyScope } from './auth.js';
import { ForbiddenError } from '../lib/errors.js';

export type ProjectPermission =
  | 'view'
  | 'create_item'
  | 'comment'
  | 'workflow'
  | 'triage'
  | 'accept_item'
  | 'read_errors'
  | 'write_errors'
  | 'triage_errors'
  | 'manage_project'
  | 'manage_members'
  | 'manage_integrations';

/**
 * `accept_item` here means "may accept anything in the project", which only `owner` may. Accepting
 * one's own report is not a role at all - see `canAcceptItem`, the only place acceptance is decided.
 */
const PROJECT_ROLE_PERMISSIONS: Record<ProjectRole, ProjectPermission[]> = {
  owner: ['view', 'create_item', 'comment', 'workflow', 'triage', 'accept_item', 'read_errors', 'write_errors', 'triage_errors', 'manage_project', 'manage_members', 'manage_integrations'],
  manager: ['view', 'create_item', 'comment', 'workflow', 'triage', 'read_errors', 'write_errors', 'triage_errors', 'manage_integrations'],
  developer: ['view', 'comment', 'workflow', 'read_errors'],
  reporter: ['view', 'create_item', 'comment'],
  viewer: ['view'],
};

const API_KEY_PERMISSION_SCOPES: Record<ProjectPermission, ApiKeyScope[]> = {
  view: ['items:read'],
  create_item: ['items:create'],
  comment: ['items:comment'],
  workflow: ['items:workflow'],
  triage: ['items:triage'],
  accept_item: ['items:triage'],
  read_errors: ['errors:read'],
  write_errors: ['errors:write'],
  triage_errors: ['errors:triage'],
  manage_project: [],
  manage_members: [],
  manage_integrations: [],
};

function hasApiKeyPermission(apiKey: ApiKey | null | undefined, projectId: string, permission: ProjectPermission): boolean {
  if (!apiKey) return true;
  if (apiKey.projectId !== projectId) return false;
  if (permission === 'accept_item' && apiKey.purpose === 'agent') return false;
  const allowedScopes = API_KEY_PERMISSION_SCOPES[permission];
  if (allowedScopes.length === 0) return false;
  const scopes = getApiKeyScopes(apiKey);
  return allowedScopes.some((scope) => scopes.includes(scope));
}

export function defaultProjectRoleForUserRole(role: string): ProjectRole {
  return 'reporter';
}

export function requireRole(...roles: UserRole[]) {
  return createMiddleware(async (c, next) => {
    const user = c.get('user');
    // Admin always has access
    if (user.role === 'admin') {
      await next();
      return;
    }
    if (!roles.includes(user.role as UserRole)) {
      throw new ForbiddenError(`Role '${user.role}' cannot access this resource`, 'FORBIDDEN');
    }
    await next();
  });
}

/**
 * Check if a user has access to a specific project via pivot_users_projects.
 * Admin always has access. Members must have a pivot entry.
 */
export function checkProjectAccess(userId: string, role: string, projectId: string, apiKey?: ApiKey | null): boolean {
  if (apiKey && !hasApiKeyPermission(apiKey, projectId, 'view')) return false;
  if (role === 'admin') return true;
  return getProjectRole(userId, role, projectId) !== null;
}

export function getProjectRole(userId: string, role: string, projectId: string): ProjectRole | null {
  if (role === 'admin') return 'owner';
  const access = db.select().from(pivotUsersProjects)
    .where(and(
      eq(pivotUsersProjects.userId, userId),
      eq(pivotUsersProjects.projectId, projectId),
    )).get();
  return access?.role ?? null;
}

export function hasProjectPermission(userId: string, role: string, projectId: string, permission: ProjectPermission, apiKey?: ApiKey | null): boolean {
  if (!hasApiKeyPermission(apiKey, projectId, permission)) return false;
  if (role === 'admin') return true;
  const projectRole = getProjectRole(userId, role, projectId);
  if (!projectRole) return false;
  return PROJECT_ROLE_PERMISSIONS[projectRole].includes(permission);
}

export function requireProjectPermission(userId: string, role: string, projectId: string, permission: ProjectPermission, apiKey?: ApiKey | null): void {
  if (!hasProjectPermission(userId, role, projectId, permission, apiKey)) {
    throw new ForbiddenError('Нет прав для этого действия в проекте', 'NO_PROJECT_PERMISSION');
  }
}

/**
 * Who may accept a finished item.
 *
 * Whoever reported it, whatever project role they hold: they are the one who said something was
 * wrong, so they are the one who can say it is answered, and the role handed out for filing a report
 * never carried acceptance. Nobody else may - the person who did the work does not sign off their own
 * work, and an agent API key is refused acceptance outright.
 *
 * `owner` keeps the right to accept anything, because a report has no reporter when the widget files
 * it anonymously, and a reporter who has left the project would otherwise leave the item waiting for
 * a person who can never come back.
 */
export function canAcceptItem(userId: string, role: string, projectId: string, reporterId: string | null, apiKey?: ApiKey | null): boolean {
  if (!hasApiKeyPermission(apiKey, projectId, 'accept_item')) return false;
  const projectRole = getProjectRole(userId, role, projectId);
  if (!projectRole) return false;
  if (reporterId && reporterId === userId) return true;
  return PROJECT_ROLE_PERMISSIONS[projectRole].includes('accept_item');
}

export function requireAcceptItem(userId: string, role: string, projectId: string, reporterId: string | null, apiKey?: ApiKey | null): void {
  if (!canAcceptItem(userId, role, projectId, reporterId, apiKey)) {
    throw new ForbiddenError('Принять задачу может её автор или владелец проекта', 'NO_PROJECT_PERMISSION');
  }
}
