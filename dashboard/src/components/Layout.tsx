import { useEffect, useState, useCallback } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { canManageIntegrations, canManageMembers, canSeeProjectAdmin, getUser, logout } from '../lib/auth';
import { api } from '../lib/api';
import { useSSE, type SSEEventType } from '../hooks/useSSE';
import { useProjectOpenCounts } from '../hooks/useProjectOpenCounts';
import { useTranslation, LOCALE_LABELS, type Locale } from '../i18n';

const SCOUT_REPOSITORY_URL = 'https://github.com/scout-dev-org/scout';

export default function Layout() {
  const user = getUser();
  const canOpenProjectAdmin = canSeeProjectAdmin();
  const showWebhooks = canManageIntegrations();
  const showUsers = canManageMembers();
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const location = useLocation();
  const { t, locale, setLocale } = useTranslation();
  const { totalOpen: newCount, reload: reloadCounts } = useProjectOpenCounts(projectIds);

  // Close user menu on route change
  useEffect(() => {
    setShowUserMenu(false);
  }, [location.pathname]);

  useEffect(() => {
    api<{ items: { id: string }[] }>('/api/projects/list', { perPage: 100 })
      .then((res) => setProjectIds(res.items.map((project) => project.id)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const interval = setInterval(reloadCounts, 30_000);
    return () => clearInterval(interval);
  }, [reloadCounts]);

  // SSE: refresh badge count on item changes
  const handleSSEEvent = useCallback((event: SSEEventType) => {
    if (event === 'item.created' || event === 'item.status_changed' || event === 'item.deleted') {
      reloadCounts();
    }
  }, [reloadCounts]);

  useSSE({ onEvent: handleSSEEvent });

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
      isActive
        ? 'bg-gray-200 text-gray-900'
        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
    }`;

  const bottomNavLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex flex-col items-center gap-0.5 text-[11px] font-medium transition-colors ${
      isActive ? 'text-gray-900' : 'text-gray-400'
    }`;

  const localeSwitcher = (
    <div className="flex gap-1">
      {(['ru', 'en', 'uz'] as const).map((l: Locale) => (
        <button
          key={l}
          onClick={() => setLocale(l)}
          className={`px-2 py-1 text-xs rounded ${
            locale === l
              ? 'bg-gray-900 text-white'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {LOCALE_LABELS[l]}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-60 flex-col border-r border-gray-200 bg-gray-100">
        <div className="flex items-center gap-2 border-b border-gray-200 px-5 py-4">
          <svg
            className="h-6 w-6 text-gray-800"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4l3 3" />
          </svg>
          <span className="text-lg font-bold text-gray-900">Scout</span>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          <NavLink to="/items" className={linkClass}>
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
            {t('nav.items')}
            {newCount > 0 && (
              <span className="ml-auto rounded-full bg-yellow-400 px-2 py-0.5 text-xs font-semibold text-yellow-900">
                {newCount}
              </span>
            )}
          </NavLink>
          <NavLink to="/errors" className={linkClass}>
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
            {t('nav.errors')}
          </NavLink>
          {canOpenProjectAdmin && (
            <>
              <NavLink to="/projects" className={linkClass}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
                </svg>
                {t('nav.projects')}
              </NavLink>
              {showWebhooks && (
                <NavLink to="/webhooks" className={linkClass}>
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                  {t('nav.webhooks')}
                </NavLink>
              )}
              {showUsers && (
                <NavLink to="/users" className={linkClass}>
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                  {t('nav.users')}
                </NavLink>
              )}
            </>
          )}
        </nav>

        <div className="border-t border-gray-200 px-4 py-3">
          <div className="text-sm font-medium text-gray-800 truncate">
            {user?.name ?? user?.email ?? 'User'}
          </div>
          <div className="text-xs text-gray-500 truncate">{user?.email}</div>
          <div className="mt-2 flex items-center justify-between">
            <button
              onClick={logout}
              className="text-xs text-red-600 hover:text-red-800"
            >
              {t('nav.logout')}
            </button>
          </div>
          <div className="mt-2">
            {localeSwitcher}
          </div>
          <a
            href={SCOUT_REPOSITORY_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex text-xs text-gray-500 hover:text-gray-800 hover:underline"
          >
            {t('nav.sourceCode')}
          </a>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-30 flex md:hidden items-center justify-between border-b border-gray-200 bg-gray-100 px-4"
        style={{ paddingTop: 'calc(0.5rem + var(--safe-area-top))' , height: 'calc(3rem + var(--safe-area-top))' }}
      >
        <div className="flex items-center gap-2">
          <svg
            className="h-5 w-5 text-gray-800"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4l3 3" />
          </svg>
          <span className="text-base font-bold text-gray-900">Scout</span>
        </div>
        <span className="text-xs text-gray-500 truncate max-w-[140px]">{user?.name ?? user?.email ?? ''}</span>
      </div>

      {/* Mobile user menu overlay (triggered from bottom nav profile button) */}
      {showUserMenu && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setShowUserMenu(false)}>
          <div className="absolute inset-0 bg-black/20" />
          <div
            className="absolute inset-x-0 bottom-0 rounded-t-xl border-t border-gray-200 bg-white px-5 pt-4"
            style={{ paddingBottom: 'calc(1rem + var(--safe-area-bottom))' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 text-sm font-medium text-gray-800">{user?.name ?? 'User'}</div>
            <div className="mb-3 text-xs text-gray-500">{user?.email}</div>
            <div className="mb-4">
              {localeSwitcher}
            </div>
            <a
              href={SCOUT_REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              className="mb-3 block rounded-md border border-gray-200 px-4 py-2.5 text-center text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              {t('nav.sourceCode')}
            </a>
            <button
              onClick={logout}
              className="w-full rounded-md border border-red-200 px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50"
            >
              {t('nav.logout')}
            </button>
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {/* Mobile spacing for fixed top bar and bottom nav */}
        <div
          className="block md:hidden"
          style={{ height: 'calc(3rem + var(--safe-area-top))' }}
        />
        <Outlet />
        <div
          className="block md:hidden"
          style={{ height: 'calc(3.5rem + var(--safe-area-bottom))' }}
        />
      </main>

      {/* Mobile bottom navigation */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 flex md:hidden items-center justify-around border-t border-gray-200 bg-white pt-1.5 pb-1.5"
        style={{ paddingBottom: 'calc(0.375rem + var(--safe-area-bottom))' }}
      >
        <NavLink to="/items" className={bottomNavLinkClass}>
          <div className="relative">
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
            {newCount > 0 && (
              <span className="absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-yellow-400 px-1 text-[10px] font-bold text-yellow-900">
                {newCount}
              </span>
            )}
          </div>
          {t('nav.items')}
        </NavLink>
        <NavLink to="/errors" className={bottomNavLinkClass}>
          <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
          {t('nav.errors')}
        </NavLink>
          {canOpenProjectAdmin && (
          <>
            <NavLink to="/projects" className={bottomNavLinkClass}>
              <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
              </svg>
              {t('nav.projects')}
            </NavLink>
            {showWebhooks && (
              <NavLink to="/webhooks" className={bottomNavLinkClass}>
                <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                {t('nav.webhooks')}
              </NavLink>
            )}
            {showUsers && (
              <NavLink to="/users" className={bottomNavLinkClass}>
                <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                {t('nav.users')}
              </NavLink>
            )}
          </>
        )}
        <button
          onClick={() => setShowUserMenu((v) => !v)}
          className="flex flex-col items-center gap-0.5 text-[11px] font-medium text-gray-400 transition-colors"
        >
          <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          {t('nav.profile')}
        </button>
      </nav>
    </div>
  );
}
