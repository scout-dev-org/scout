import { useEffect, useRef, useState, useCallback, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '../lib/api';
import { formatDate, formatDateShort } from '../lib/date';
import { canCreateItems, isAdmin } from '../lib/auth';
import {
  findSelectableProjectId,
  getStoredSelectedProjectId,
  storeSelectedProjectId,
} from '../lib/project-selection';
import { useSSE } from '../hooks/useSSE';
import { useProjectOpenCounts } from '../hooks/useProjectOpenCounts';
import { BACKLOG_ITEM_TYPES, IMPROVEMENT_ITEM_TYPE, type ItemType } from '../lib/item-types';
import { useTranslation } from '../i18n';
import StatusBadge from '../components/StatusBadge';
import PriorityBadge from '../components/PriorityBadge';
import ItemTypeBadge from '../components/ItemTypeBadge';
import Labels, { parseLabels } from '../components/Labels';
import Pagination from '../components/Pagination';

interface Project {
  id: string;
  name: string;
  slug: string;
}

interface Item {
  id: string;
  itemType: string;
  message: string;
  status: string;
  priority: string | null;
  labels: string | null;
  reporterName: string | null;
  assigneeName: string | null;
  createdAt: string;
}

interface UserListItem {
  id: string;
  name: string;
}

interface PaginationData {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

interface Counts {
  new: number;
  in_progress: number;
  review: number;
  done: number;
  changes_requested: number;
  verified: number;
  cancelled: number;
}

type StatusKey = keyof Counts;
type QueueId = 'open' | 'in_progress' | 'needs_review' | 'needs_acceptance' | 'accepted' | 'archived' | 'improvements';

const DEFAULT_QUEUE: QueueId = 'open';
// `statuses: null` marks the type queue: every improvement, whatever its status.
const QUEUES: Array<{ id: QueueId; labelKey: string; statuses: StatusKey[] | null }> = [
  { id: 'open', labelKey: 'items.queues.open', statuses: ['new'] },
  { id: 'in_progress', labelKey: 'items.queues.in_progress', statuses: ['in_progress'] },
  { id: 'needs_review', labelKey: 'items.queues.needs_review', statuses: ['review', 'changes_requested'] },
  { id: 'needs_acceptance', labelKey: 'items.queues.needs_acceptance', statuses: ['done'] },
  { id: 'accepted', labelKey: 'items.queues.accepted', statuses: ['verified'] },
  { id: 'archived', labelKey: 'items.queues.archived', statuses: ['cancelled'] },
  { id: 'improvements', labelKey: 'items.queues.improvements', statuses: null },
];
const ITEM_TYPES = ['all', ...BACKLOG_ITEM_TYPES] as const;

const ITEM_TYPE_KEYS: Record<string, string> = {
  all: 'items.types.all',
  bug: 'items.types.bug',
  note: 'items.types.note',
  task: 'items.types.task',
};

const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

function createDedupeKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const FORM_CONTROL_CLASS =
  'h-9 rounded-md border border-gray-300 px-3 text-sm leading-5 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500';

function getInitialQueue(params: URLSearchParams): QueueId {
  const queue = params.get('queue');
  return QUEUES.some((entry) => entry.id === queue) ? queue as QueueId : DEFAULT_QUEUE;
}

function getQueue(queue: string) {
  return QUEUES.find((entry) => entry.id === queue) ?? QUEUES[0]!;
}

function getInitialPriority(params: URLSearchParams) {
  const priority = params.get('priority');
  return priority && PRIORITIES.includes(priority as (typeof PRIORITIES)[number]) ? priority : '';
}

function getInitialItemType(params: URLSearchParams) {
  const type = params.get('type');
  return type && ITEM_TYPES.includes(type as (typeof ITEM_TYPES)[number]) ? type : 'all';
}

function getInitialPage(params: URLSearchParams) {
  const page = Number(params.get('page'));
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export default function Items() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const admin = isAdmin();
  const { t, locale } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  // The address bar owns the project and every filter. Nothing mirrors them back into it,
  // so a navigation started by one control can never be overwritten by another one's state.
  const selectedProject = searchParams.get('project') ?? '';
  const queueFilter = getInitialQueue(searchParams);
  const itemTypeFilter = getInitialItemType(searchParams);
  const priorityFilter = getInitialPriority(searchParams);
  const assigneeFilter = searchParams.get('assignee') ?? '';
  const authorFilter = searchParams.get('author') ?? '';
  const search = searchParams.get('q') ?? '';
  const page = getInitialPage(searchParams);

  const [pageMeta, setPageMeta] = useState<Omit<PaginationData, 'page'>>({
    perPage: 20,
    total: 0,
    totalPages: 1,
  });
  const [counts, setCounts] = useState<Counts>({
    new: 0,
    in_progress: 0,
    review: 0,
    done: 0,
    changes_requested: 0,
    verified: 0,
    cancelled: 0,
  });
  const [improvementCount, setImprovementCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createType, setCreateType] = useState<ItemType>('task');
  const [createMessage, setCreateMessage] = useState('');
  const [createPriority, setCreatePriority] = useState('medium');
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState('');

  const [searchInput, setSearchInput] = useState(search);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [teamUsers, setTeamUsers] = useState<UserListItem[]>([]);

  /** Apply a filter change: rewrite the address bar, always back to the first page. */
  const applyFilter = useCallback((mutate: (params: URLSearchParams) => void, push = false) => {
    const next = new URLSearchParams(searchParams);
    mutate(next);
    if (selectedProject) next.set('project', selectedProject);
    next.delete('page');
    setSearchParams(next, { replace: !push });
  }, [searchParams, selectedProject, setSearchParams]);

  const { openCounts, reload: reloadOpenCounts } = useProjectOpenCounts(projects.map((p) => p.id));

  // Load projects
  useEffect(() => {
    api<{ items: Project[] }>('/api/projects/list', { perPage: 100 })
      .then((res) => setProjects(res.items))
      .catch(() => {});
  }, []);

  // Put a usable project in the address bar when it arrives without one.
  useEffect(() => {
    if (projects.length === 0) return;
    const next = findSelectableProjectId(projects, selectedProject, getStoredSelectedProjectId());
    if (!next) return;
    storeSelectedProjectId(next);
    if (next === selectedProject) return;
    const params = new URLSearchParams(searchParams);
    params.set('project', next);
    setSearchParams(params, { replace: true });
  }, [projects, selectedProject, searchParams, setSearchParams]);

  // Load users for assignee filter (admin only)
  useEffect(() => {
    if (!admin) return;
    api<{ items: UserListItem[] }>('/api/users/list', { perPage: 100 })
      .then((res) => setTeamUsers(res.items))
      .catch(() => {});
  }, []);

  // Fetch items + counts (showLoading=true on initial/filter load, false on SSE refresh)
  const fetchData = useCallback((showLoading = true) => {
    if (!selectedProject) return;

    if (showLoading) setLoading(true);

    const body: Record<string, unknown> = {
      projectId: selectedProject,
      page,
      perPage: 20,
    };
    const queueStatuses = getQueue(queueFilter).statuses;
    if (queueStatuses) {
      body.statuses = queueStatuses;
      if (itemTypeFilter !== 'all') body.itemType = itemTypeFilter;
      else body.itemTypes = BACKLOG_ITEM_TYPES;
    } else {
      body.itemType = IMPROVEMENT_ITEM_TYPE;
    }
    if (search) {
      body.search = search;
    }
    if (assigneeFilter) {
      body.assigneeId = assigneeFilter;
    }
    if (authorFilter) {
      body.reporterId = authorFilter;
    }
    if (priorityFilter) {
      body.priority = priorityFilter;
    }

    Promise.all([
      api<{ items: Item[]; pagination: PaginationData }>('/api/items/list', body),
      api<{ counts: Counts }>('/api/items/count', {
        projectId: selectedProject,
        ...(itemTypeFilter !== 'all' ? { itemType: itemTypeFilter } : { itemTypes: BACKLOG_ITEM_TYPES }),
      }),
      api<{ counts: Counts }>('/api/items/count', {
        projectId: selectedProject,
        itemType: IMPROVEMENT_ITEM_TYPE,
      }),
    ])
      .then(([listRes, countRes, improvementRes]) => {
        setItems(listRes.items);
        setPageMeta(listRes.pagination);
        setCounts(countRes.counts);
        setImprovementCount(Object.values(improvementRes.counts).reduce((sum, value) => sum + value, 0));
      })
      .catch(() => {})
      .finally(() => { if (showLoading) setLoading(false); });
  }, [selectedProject, itemTypeFilter, queueFilter, page, search, assigneeFilter, authorFilter, priorityFilter]);

  // Load items + counts when project or filter changes
  useEffect(() => {
    fetchData(true);
  }, [fetchData]);

  // SSE: refresh list and the per-project open counts on any item change
  const handleSSEEvent = useCallback(() => {
    fetchData(false);
    reloadOpenCounts();
  }, [fetchData, reloadOpenCounts]);

  useSSE({ projectId: selectedProject, onEvent: handleSSEEvent });

  function handleProjectChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const projectId = e.target.value;
    storeSelectedProjectId(projectId);
    setSearchInput('');
    setSearchParams(new URLSearchParams({ project: projectId }), { replace: true });
  }

  function handleQueueChange(queue: QueueId) {
    if (queue === queueFilter) return;
    applyFilter((params) => {
      if (queue === DEFAULT_QUEUE) params.delete('queue');
      else params.set('queue', queue);
      // The improvements queue is itself a type filter, so the type select goes away with it.
      if (!getQueue(queue).statuses) params.delete('type');
    }, true);
  }

  function handleItemTypeFilter(e: React.ChangeEvent<HTMLSelectElement>) {
    const type = e.target.value;
    applyFilter((params) => {
      if (type === 'all') params.delete('type');
      else params.set('type', type);
    });
  }

  function openCreateModal() {
    setCreateType('task');
    setCreateMessage('');
    setCreatePriority('medium');
    setCreateError('');
    setShowCreateModal(true);
  }

  async function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selectedProject || !createMessage.trim()) return;
    setCreateSaving(true);
    setCreateError('');
    try {
      const created = await api<Item>('/api/items/create', {
        projectId: selectedProject,
        itemType: createType,
        message: createMessage.trim(),
        dedupeKey: createDedupeKey(),
        ...(createType !== 'note' ? { priority: createPriority } : {}),
      });
      setShowCreateModal(false);
      await fetchData(true);
      navigate(itemPath(created.id));
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t('validation.saveError'));
    } finally {
      setCreateSaving(false);
    }
  }

  function handleSearchInput(value: string) {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      applyFilter((params) => {
        if (value) params.set('q', value);
        else params.delete('q');
      });
    }, 300);
  }

  function clearSearch() {
    setSearchInput('');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    applyFilter((params) => params.delete('q'));
  }

  function setParamFilter(key: string, value: string) {
    applyFilter((params) => {
      if (value) params.set(key, value);
      else params.delete(key);
    });
  }

  function handlePriorityFilter(e: React.ChangeEvent<HTMLSelectElement>) {
    setParamFilter('priority', e.target.value);
  }

  function handleAssigneeFilter(e: React.ChangeEvent<HTMLSelectElement>) {
    setParamFilter('assignee', e.target.value);
  }

  function handleAuthorFilter(e: React.ChangeEvent<HTMLSelectElement>) {
    setParamFilter('author', e.target.value);
  }

  function handlePageChange(nextPage: number) {
    const next = new URLSearchParams(searchParams);
    if (nextPage > 1) next.set('page', String(nextPage));
    else next.delete('page');
    setSearchParams(next, { replace: false });
  }

  function itemPath(itemId: string) {
    return `/items/${itemId}`;
  }

  const canCreateSelectedItem = selectedProject ? canCreateItems(selectedProject) : false;

  function getTabCount(queue: QueueId): number | null {
    const statuses = getQueue(queue).statuses;
    const value = statuses
      ? statuses.reduce((sum, status) => sum + counts[status], 0)
      : improvementCount;
    return value > 0 ? value : null;
  }

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 md:mb-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t('items.title')}</h1>
          <p className="mt-1 text-sm text-gray-500">{t('items.description')}</p>
        </div>
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <button
            type="button"
            onClick={openCreateModal}
            disabled={!selectedProject || !canCreateSelectedItem}
            className="w-full rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50 md:w-auto md:py-1.5"
          >
            {t('items.create')}
          </button>
          <select
            name="items-project"
            value={selectedProject}
            onChange={handleProjectChange}
            className={`w-full md:w-auto ${FORM_CONTROL_CLASS}`}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {openCounts[p.id] ? `${p.name} (${openCounts[p.id]})` : p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {/* Search + assignee filter */}
      <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
        <div className="relative flex-1">
          <input
            type="text"
            name="items-search"
            value={searchInput}
            onChange={(e) => handleSearchInput(e.target.value)}
            placeholder={t('items.filters.searchPlaceholder')}
            className={`block w-full pr-8 ${FORM_CONTROL_CLASS}`}
          />
          {searchInput && (
            <button
              onClick={clearSearch}
              aria-label={t('common.clear')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              type="button"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        {getQueue(queueFilter).statuses && (
          <select
            name="items-type"
            value={itemTypeFilter}
            onChange={handleItemTypeFilter}
            className={`w-full md:w-40 ${FORM_CONTROL_CLASS}`}
          >
            {ITEM_TYPES.map((type) => (
              <option key={type} value={type}>{t(ITEM_TYPE_KEYS[type]!)}</option>
            ))}
          </select>
        )}
        <select
          name="items-priority"
          value={priorityFilter}
          onChange={handlePriorityFilter}
          className={`w-full md:w-44 ${FORM_CONTROL_CLASS}`}
        >
          <option value="">{t('items.filters.allPriorities')}</option>
          <option value="critical">{t('items.priorities.critical')}</option>
          <option value="high">{t('items.priorities.high')}</option>
          <option value="medium">{t('items.priorities.medium')}</option>
          <option value="low">{t('items.priorities.low')}</option>
        </select>
        {admin && teamUsers.length > 0 && (
          <>
            <select
              name="items-author"
              value={authorFilter}
              onChange={handleAuthorFilter}
              className={`w-full md:w-48 ${FORM_CONTROL_CLASS}`}
            >
              <option value="">{t('items.filters.allAuthors')}</option>
              {teamUsers.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
            <select
              name="items-assignee"
              value={assigneeFilter}
              onChange={handleAssigneeFilter}
              className={`w-full md:w-48 ${FORM_CONTROL_CLASS}`}
            >
              <option value="">{t('items.filters.allAssignees')}</option>
              {teamUsers.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </>
        )}
      </div>

      {/* Queue tabs — horizontal scroll on mobile */}
      <div className="mb-4 flex gap-1 border-b border-gray-200 overflow-x-auto">
        {QUEUES.map((queue) => {
          const count = getTabCount(queue.id);
          return (
            <button
              key={queue.id}
              onClick={() => handleQueueChange(queue.id)}
              className={`relative shrink-0 px-3 py-2 text-sm font-medium transition-colors ${
                queueFilter === queue.id
                  ? 'border-b-2 border-gray-900 text-gray-900'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t(queue.labelKey)}
              {count !== null && (
                <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
              <th className="px-4 py-3">{t('items.table.message')}</th>
              <th className="px-4 py-3 w-28">{t('items.table.type')}</th>
              <th className="px-4 py-3 w-28">{t('items.table.status')}</th>
              <th className="px-4 py-3 w-28">{t('items.table.priority')}</th>
              <th className="px-4 py-3 w-36">{t('items.table.labels')}</th>
              <th className="px-4 py-3 w-36">{t('items.table.author')}</th>
              <th className="px-4 py-3 w-36">{t('items.table.assignee')}</th>
              <th className="px-4 py-3 w-40">{t('items.table.created')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                  {t('common.loading')}
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                  {search ? t('items.notFound') : t('items.empty')}
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr
                  key={item.id}
                  onClick={() => navigate(itemPath(item.id))}
                  className="cursor-pointer hover:bg-gray-50 transition-colors"
                >
                  <td className="px-4 py-3 max-w-md truncate text-gray-800">
                    <Link
                      to={itemPath(item.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="block truncate hover:text-gray-950 hover:underline"
                    >
                      {item.message}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <ItemTypeBadge itemType={item.itemType} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={item.status} />
                  </td>
                  <td className="px-4 py-3">
                    <PriorityBadge priority={item.priority} />
                  </td>
                  <td className="px-4 py-3">
                    <Labels labels={parseLabels(item.labels)} size="xs" />
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {item.reporterName ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {item.assigneeName ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {formatDate(item.createdAt, locale)}
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
        ) : items.length === 0 ? (
          <div className="py-8 text-center text-gray-400">
            {search ? t('items.notFound') : t('items.empty')}
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              onClick={() => navigate(itemPath(item.id))}
              className="cursor-pointer rounded-lg border border-gray-200 bg-white p-3 active:bg-gray-50 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <Link
                  to={itemPath(item.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="text-sm font-medium text-gray-800 line-clamp-2 hover:text-gray-950 hover:underline"
                >
                  {item.message}
                </Link>
                <div className="flex shrink-0 items-center gap-1.5">
                  <ItemTypeBadge itemType={item.itemType} />
                  <PriorityBadge priority={item.priority} />
                  <StatusBadge status={item.status} />
                </div>
              </div>
              {parseLabels(item.labels).length > 0 && (
                <div className="mt-1.5">
                  <Labels labels={parseLabels(item.labels)} size="xs" />
                </div>
              )}
              <div className="mt-2 flex items-center gap-3 text-xs text-gray-400">
                <span>{item.reporterName ?? '—'}</span>
                <span>{formatDateShort(item.createdAt, locale)}</span>
              </div>
            </div>
          ))
        )}
      </div>

      <Pagination
        page={page}
        totalPages={pageMeta.totalPages}
        onPageChange={handlePageChange}
      />

      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center">
          <form
            onSubmit={handleCreateSubmit}
            className="w-full rounded-t-xl border border-gray-200 bg-white p-5 shadow-xl md:max-w-lg md:rounded-lg md:p-6"
          >
            <h2 className="text-lg font-semibold text-gray-900">{t('items.create')}</h2>
            <p className="mt-1 text-sm text-gray-500">{t('items.createDescription')}</p>
            <label className="mt-4 block">
              <span className="text-sm font-medium text-gray-700">{t('items.form.type')}</span>
              <select
                value={createType}
                onChange={(e) => setCreateType(e.target.value as ItemType)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
              >
                <option value="task">{t('items.types.task')}</option>
                <option value="note">{t('items.types.note')}</option>
                <option value="bug">{t('items.types.bug')}</option>
                <option value="improvement">{t('items.types.improvement')}</option>
              </select>
            </label>
            <label className="mt-3 block">
              <span className="text-sm font-medium text-gray-700">{t('items.form.message')}</span>
              <textarea
                value={createMessage}
                onChange={(e) => setCreateMessage(e.target.value)}
                rows={5}
                placeholder={t(`items.form.placeholders.${createType}`)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
              />
            </label>
            {createType !== 'note' && (
              <label className="mt-3 block">
                <span className="text-sm font-medium text-gray-700">{t('items.table.priority')}</span>
                <select
                  value={createPriority}
                  onChange={(e) => setCreatePriority(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
                >
                  <option value="critical">{t('items.priorities.critical')}</option>
                  <option value="high">{t('items.priorities.high')}</option>
                  <option value="medium">{t('items.priorities.medium')}</option>
                  <option value="low">{t('items.priorities.low')}</option>
                </select>
              </label>
            )}
            {createError && (
              <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {createError}
              </div>
            )}
            <div className="mt-5 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                disabled={createSaving}
                className="w-full rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 md:w-auto"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={createSaving || !createMessage.trim()}
                className="w-full rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50 md:w-auto"
              >
                {createSaving ? t('common.saving') : t('common.create')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
