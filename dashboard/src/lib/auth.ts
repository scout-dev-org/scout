import { api } from './api';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  projectRoles?: Array<{ projectId: string; role: 'owner' | 'manager' | 'developer' | 'reporter' | 'viewer' }>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

type ProjectRole = NonNullable<User['projectRoles']>[number]['role'];

const TOKEN_KEY = 'scout_token';
const USER_KEY = 'scout_user';
const SSO_TOKEN_KEY = '__scout_token__';
const SSO_USER_KEY = '__scout_user__';
const SSO_SESSION_COOKIE = 'scout_session';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

/** Build authenticated URL for storage files (screenshots, recordings). */
export function storageUrl(path: string): string {
  const token = getToken();
  const url = path.startsWith('/') ? path : `/${path}`;
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

export function isAdmin(): boolean {
  const user = getUser();
  return user?.role === 'admin';
}

export function hasOwnedProjects(): boolean {
  return canManageProjectSettings();
}

function getProjectRole(projectId: string): ProjectRole | null {
  const user = getUser();
  if (user?.role === 'admin') return 'owner';
  return user?.projectRoles?.find((project) => project.projectId === projectId)?.role ?? null;
}

function hasAnyProjectRole(roles: ProjectRole[]): boolean {
  const user = getUser();
  return user?.role === 'admin' || user?.projectRoles?.some((project) => roles.includes(project.role)) === true;
}

export function canCreateItems(projectId: string): boolean {
  const role = getProjectRole(projectId);
  return role === 'owner' || role === 'manager' || role === 'reporter';
}

export function canTriageErrors(projectId: string): boolean {
  const role = getProjectRole(projectId);
  return role === 'owner' || role === 'manager';
}

export function canManageProjectSettings(projectId?: string): boolean {
  if (!projectId) return hasAnyProjectRole(['owner']);
  return getProjectRole(projectId) === 'owner';
}

export function canManageMembers(projectId?: string): boolean {
  if (!projectId) return hasAnyProjectRole(['owner']);
  return getProjectRole(projectId) === 'owner';
}

export function canManageIntegrations(projectId?: string): boolean {
  if (!projectId) return hasAnyProjectRole(['owner', 'manager']);
  const role = getProjectRole(projectId);
  return role === 'owner' || role === 'manager';
}

export function canSeeProjectAdmin(): boolean {
  return canManageProjectSettings() || canManageMembers() || canManageIntegrations();
}

function syncAuthStorage(token: string, user: User): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  localStorage.setItem(SSO_TOKEN_KEY, token);
  localStorage.setItem(SSO_USER_KEY, JSON.stringify(user));
  document.cookie = `${SSO_SESSION_COOKIE}=${token}; path=/; max-age=604800; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}

function clearAuthStorage(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(SSO_TOKEN_KEY);
  localStorage.removeItem(SSO_USER_KEY);
  document.cookie = `${SSO_SESSION_COOKIE}=; path=/; max-age=0`;
}

export async function login(
  email: string,
  password: string,
): Promise<{ token: string; user: User }> {
  const result = await api<{ token: string; user: User }>('/api/auth/login', {
    email,
    password,
  });
  syncAuthStorage(result.token, result.user);
  return result;
}

export function logout(): void {
  clearAuthStorage();
  window.location.href = '/login';
}

export async function fetchMe(): Promise<User> {
  const result = await api<{ user: User }>('/api/auth/me');
  localStorage.setItem(USER_KEY, JSON.stringify(result.user));
  localStorage.setItem(SSO_USER_KEY, JSON.stringify(result.user));
  return result.user;
}
