import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { canManageMembers, isAdmin } from '../lib/auth';
import { useTranslation } from '../i18n';
import Pagination from '../components/Pagination';

interface UserItem {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  isActive: boolean;
  projectRoles?: ProjectRoleAssignment[];
  createdAt: string;
}

type ProjectRole = 'owner' | 'manager' | 'developer' | 'reporter' | 'viewer';

interface ProjectRoleAssignment {
  projectId: string;
  role: ProjectRole;
}

interface Project {
  id: string;
  name: string;
}

interface PaginationData {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

const emptyForm = {
  email: '',
  password: '',
  name: '',
  role: 'member' as 'admin' | 'member',
  isActive: true,
  projectRoles: [] as ProjectRoleAssignment[],
};

export default function Users() {
  const { t } = useTranslation();
  const admin = isAdmin();
  const [users, setUsers] = useState<UserItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [pagination, setPagination] = useState<PaginationData>({
    page: 1,
    perPage: 20,
    total: 0,
    totalPages: 1,
  });
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function loadUsers() {
    setLoading(true);
    try {
      const res = await api<{ items: UserItem[]; pagination: PaginationData }>(
        '/api/users/list',
        { page: pagination.page, perPage: 20 },
      );
      setUsers(res.items);
      setPagination(res.pagination);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  async function loadProjects() {
    try {
      const res = await api<{ items: Project[] }>('/api/projects/list', {
        perPage: 100,
      });
      setProjects(res.items);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    loadUsers();
    loadProjects();
  }, [pagination.page]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setError('');
    setShowModal(true);
  }

  function openEdit(u: UserItem) {
    setEditingId(u.id);
    setForm({
      email: u.email,
      password: '',
      name: u.name,
      role: u.role,
      isActive: u.isActive,
      // Only roles in projects the current user can manage: the rest are neither
      // editable nor sent back, and the server keeps them untouched.
      projectRoles: (u.projectRoles ?? []).filter((role) => canManageMembers(role.projectId)),
    });
    setError('');
    setShowModal(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        const body: Record<string, unknown> = {
          id: editingId,
          name: form.name,
          projectRoles: form.projectRoles,
        };
        if (admin) {
          body.role = form.role;
          body.isActive = form.isActive;
        }
        if (admin && form.password) {
          body.password = form.password;
        }
        await api('/api/users/update', body, t);
      } else {
        await api('/api/users/create', {
          email: form.email,
          password: form.password,
          name: form.name,
          role: form.role,
          projectRoles: form.projectRoles,
        }, t);
      }
      setShowModal(false);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('validation.saveError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t('users.deleteConfirm'))) return;
    try {
      await api('/api/users/delete', { id }, t);
      await loadUsers();
    } catch (err) {
      alert(err instanceof Error ? err.message : t('validation.deleteError'));
    }
  }

  function toggleProject(pid: string) {
    setForm((f) => ({
      ...f,
      projectRoles: f.projectRoles.some((projectRole) => projectRole.projectId === pid)
        ? f.projectRoles.filter((x) => x.projectId !== pid)
        : [...f.projectRoles, { projectId: pid, role: 'reporter' }],
    }));
  }

  function setProjectRole(projectId: string, role: ProjectRole) {
    setForm((f) => ({
      ...f,
      projectRoles: f.projectRoles.map((projectRole) => (
        projectRole.projectId === projectId ? { ...projectRole, role } : projectRole
      )),
    }));
  }

  const manageableProjects = projects.filter((p) => canManageMembers(p.id));

  const roleBadge: Record<string, string> = {
    admin: 'bg-red-100 text-red-700',
    member: 'bg-blue-100 text-blue-700',
  };

  const roleKeys: Record<string, string> = {
    admin: 'users.roles.admin',
    member: 'users.roles.member',
  };

  const projectRoleLabels: Record<ProjectRole, string> = {
    owner: t('users.projectRoles.owner'),
    manager: t('users.projectRoles.manager'),
    developer: t('users.projectRoles.developer'),
    reporter: t('users.projectRoles.reporter'),
    viewer: t('users.projectRoles.viewer'),
  };

  function projectRoleSummary(user: UserItem): string {
    const roles = user.projectRoles ?? [];
    if (user.role === 'admin') return t('users.projects.all');
    if (roles.length === 0) return t('users.projects.none');
    return roles.map((role) => {
      const project = projects.find((p) => p.id === role.projectId);
      return `${project?.name ?? t('users.projects.unknown')} · ${projectRoleLabels[role.role]}`;
    }).join(', ');
  }

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 md:mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t('users.title')}</h1>
          <p className="mt-1 text-sm text-gray-500">{t('users.description')}</p>
        </div>
        <button
          onClick={openCreate}
          className="rounded-md bg-gray-900 px-3 md:px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-800"
        >
          <span className="hidden md:inline">{t('users.create')}</span>
          <span className="md:hidden">{t('users.createShort')}</span>
        </button>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
              <th className="px-4 py-3">{t('users.table.name')}</th>
              <th className="px-4 py-3">{t('users.table.email')}</th>
              <th className="px-4 py-3 w-24">{t('users.table.role')}</th>
              <th className="px-4 py-3">{t('users.table.projects')}</th>
              <th className="px-4 py-3 w-20 text-center">{t('users.table.active')}</th>
              <th className="px-4 py-3 w-28 text-right">{t('users.table.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                  {t('common.loading')}
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                  {t('common.noData')}
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-800">
                    {u.name}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{u.email}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                        roleBadge[u.role] ?? 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {t(roleKeys[u.role] ?? u.role)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 max-w-xs truncate" title={projectRoleSummary(u)}>
                    {projectRoleSummary(u)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {u.isActive ? (
                      <span className="text-green-600">{t('common.yes')}</span>
                    ) : (
                      <span className="text-gray-400">{t('common.no')}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => openEdit(u)}
                      className="text-sm text-blue-600 hover:underline"
                    >
                      {t('common.edit')}
                    </button>
                    {admin && (
                      <button
                        onClick={() => handleDelete(u.id)}
                        className="ml-3 text-sm text-red-600 hover:underline"
                      >
                        {t('common.delete')}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile card list */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="py-8 text-center text-gray-400">{t('common.loading')}</div>
        ) : users.length === 0 ? (
          <div className="py-8 text-center text-gray-400">{t('common.noData')}</div>
        ) : (
          users.map((u) => (
            <div
              key={u.id}
              className="rounded-lg border border-gray-200 bg-white p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-800">{u.name}</div>
                  <div className="text-xs text-gray-400 mt-0.5 truncate">{u.email}</div>
                  <div className="mt-1 text-xs text-gray-500 line-clamp-2">{projectRoleSummary(u)}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      roleBadge[u.role] ?? 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {t(roleKeys[u.role] ?? u.role)}
                  </span>
                  {u.isActive ? (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">{t('common.active')}</span>
                  ) : (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">{t('common.inactive')}</span>
                  )}
                </div>
              </div>
              <div className="mt-2.5 flex items-center justify-end gap-3">
                <button
                  onClick={() => openEdit(u)}
                  className="text-xs text-blue-600 hover:underline"
                >
                  {t('common.edit')}
                </button>
                {admin && (
                  <button
                    onClick={() => handleDelete(u.id)}
                    className="text-xs text-red-600 hover:underline"
                  >
                    {t('common.delete')}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <Pagination
        page={pagination.page}
        totalPages={pagination.totalPages}
        onPageChange={(p) => setPagination((prev) => ({ ...prev, page: p }))}
      />

      {/* Modal — full screen on mobile, centered on desktop */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40">
          <form
            onSubmit={handleSubmit}
            className="w-full md:max-w-md rounded-t-xl md:rounded-lg border border-gray-200 bg-white p-5 md:p-6 shadow-xl max-h-[90vh] overflow-y-auto"
          >
            <h3 className="mb-4 text-lg font-semibold text-gray-900">
              {editingId ? t('users.modal.edit') : t('users.modal.create')}
            </h3>

            {error && (
              <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}

            <label className="block">
              <span className="text-sm font-medium text-gray-700">{t('users.form.name')}</span>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </label>

            <label className="mt-3 block">
              <span className="text-sm font-medium text-gray-700">{t('users.form.email')}</span>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
                disabled={!!editingId}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-500"
              />
            </label>

            {admin || !editingId ? (
              <label className="mt-3 block">
                <span className="text-sm font-medium text-gray-700">
                  {t('users.form.password')}{editingId ? ` (${t('users.form.passwordHint')})` : ''}
                </span>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  required={!editingId}
                  minLength={8}
                  placeholder={t('users.passwordMinLength')}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
            ) : null}

            <label className="mt-3 block">
              <span className="text-sm font-medium text-gray-700">{t('users.form.role')}</span>
              <p className="mt-0.5 text-xs text-gray-500">{t('users.form.roleHint')}</p>
              <select
                value={form.role}
                onChange={(e) =>
                  setForm({
                    ...form,
                    role: e.target.value as 'admin' | 'member',
                  })
                }
                disabled={!admin && !!editingId}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {admin && <option value="admin">{t('users.roles.admin')}</option>}
                <option value="member">{t('users.roles.member')}</option>
              </select>
            </label>

            {editingId && admin && (
              <label className="mt-3 flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) =>
                    setForm({ ...form, isActive: e.target.checked })
                  }
                  className="rounded border-gray-300"
                />
                {t('users.form.active')}
              </label>
            )}

            {manageableProjects.length > 0 && (
              <div className="mt-4">
                <span className="text-sm font-medium text-gray-700">
                  {t('users.form.projects')}
                </span>
                <p className="mt-0.5 text-xs text-gray-500">{t('users.form.projectsHint')}</p>
                <div className="mt-1 max-h-36 space-y-1 overflow-y-auto rounded-md border border-gray-200 p-2">
                  {manageableProjects.map((p) => {
                    const enabled = form.projectRoles.some((role) => role.projectId === p.id);
                    const projectRole = form.projectRoles.find((role) => role.projectId === p.id)?.role ?? 'reporter';
                    return (
                      <div key={p.id} className="flex items-center gap-2 text-sm text-gray-700">
                        <label className="flex min-w-0 flex-1 items-center gap-2">
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={() => toggleProject(p.id)}
                            className="rounded border-gray-300"
                          />
                          <span className="truncate">{p.name}</span>
                        </label>
                        {enabled && (
                          <select
                            value={projectRole}
                            onChange={(e) => setProjectRole(p.id, e.target.value as ProjectRole)}
                            className="rounded border border-gray-300 px-2 py-1 text-xs"
                          >
                            {Object.entries(projectRoleLabels).map(([value, label]) => (
                              <option key={value} value={value}>{label}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="mt-5 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="w-full md:w-auto rounded-md border border-gray-300 px-4 py-2 md:py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="w-full md:w-auto rounded-md bg-gray-900 px-4 py-2 md:py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              >
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
