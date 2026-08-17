import { useEffect, useRef, useState, useCallback, type FormEvent } from 'react';
import { useParams, useNavigate } from 'react-router';
import { Fancybox } from '@fancyapps/ui';
import '@fancyapps/ui/dist/fancybox/fancybox.css';
import { api, ApiError } from '../lib/api';
import { formatDate } from '../lib/date';
import { isAdmin, storageUrl } from '../lib/auth';
import { useSSE, type SSEEventType } from '../hooks/useSSE';
import { useTranslation, type Locale } from '../i18n';
import StatusBadge from '../components/StatusBadge';
import PriorityBadge from '../components/PriorityBadge';
import ItemTypeBadge from '../components/ItemTypeBadge';
import Labels, { parseLabels } from '../components/Labels';
import SessionPlayer from '../components/SessionPlayer';
import ErrorGroupCard, { type ErrorGroupCardData } from '../components/ErrorGroupCard';

interface Note {
  id: number;
  content: string;
  type: string;
  userName: string | null;
  createdAt: string;
}

interface EvidenceRecord {
  id: string;
  kind: 'handoff' | 'verification' | 'audit' | 'blocker';
  result: 'pass' | 'fail' | 'blocked' | 'partial' | null;
  level: EvidenceLevel | null;
  coverage: 'item' | 'shared_root_cluster' | 'route_sweep' | 'audit_sample' | null;
  environment: string;
  role: string | null;
  url: string | null;
  scenario: string;
  action: string;
  visibleResult: string;
  consoleResult: string | null;
  networkResult: string | null;
  apiResult: string | null;
  dbResult: string | null;
  fixture: string | null;
  cleanupResult: string | null;
  commitSha: string | null;
  deploySha: string | null;
  risks: string | null;
  uncheckedRisks: string | null;
  acceptanceScope: string | null;
  source: 'agent' | 'human' | 'ci' | 'deploy' | 'audit' | null;
  verifiedAt: string | null;
  userName: string | null;
  createdAt: string;
}

type HandoffStatus = 'review' | 'done';
type EvidenceLevel = 'static' | 'typecheck' | 'api_smoke' | 'browser_smoke' | 'browser_acceptance' | 'local_acceptance' | 'staging_acceptance' | 'production_acceptance' | 'user_acceptance';

type EvidenceDraft = {
  kind: 'handoff' | 'verification' | 'audit' | 'blocker';
  result: 'pass' | 'fail' | 'blocked' | 'partial';
  level: EvidenceLevel;
  coverage: 'item' | 'shared_root_cluster' | 'route_sweep' | 'audit_sample';
  source: 'agent' | 'human' | 'ci' | 'deploy' | 'audit';
  environment: string;
  role: string;
  url: string;
  scenario: string;
  action: string;
  visibleResult: string;
  consoleResult: string;
  networkResult: string;
  apiResult: string;
  dbResult: string;
  fixture: string;
  cleanupResult: string;
  commitSha: string;
  deploySha: string;
  risks: string;
  uncheckedRisks: string;
  acceptanceScope: string;
};

type ChangeRequestDraft = {
  summary: string;
  expected: string;
  actual: string;
  steps: string;
  url: string;
};

interface UserListItem {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface ItemData {
  id: string;
  projectId: string;
  itemType: 'bug' | 'note' | 'task';
  message: string;
  status: string;
  priority: string | null;
  labels: string | null;
  pageUrl: string | null;
  cssSelector: string | null;
  elementText: string | null;
  elementHtml: string | null;
  viewportWidth: number | null;
  viewportHeight: number | null;
  screenshotPath: string | null;
  sessionRecordingPath: string | null;
  metadata: string | null;
  debugContext: string | null;
  reporterName: string | null;
  assigneeName: string | null;
  assigneeId: string | null;
  branchName: string | null;
  mrUrl: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  resolvedById: string | null;
  createdAt: string;
  updatedAt: string;
  notes: Note[];
  evidence: EvidenceRecord[];
  errorGroups: ErrorGroupRecord[];
  relatedItems: RelatedItem[];
  permissions: ItemPermissions;
}

type ErrorGroupRecord = ErrorGroupCardData;

interface ItemPermissions {
  canClaim: boolean;
  canUpdateStatus: boolean;
  canResolve: boolean;
  canVerify: boolean;
  canRequestChanges: boolean;
  canCancel: boolean;
  canReopen: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canComment: boolean;
  canLinkItems: boolean;
}

interface RelatedItem {
  id: string;
  type: string;
  direction: 'incoming' | 'outgoing';
  createdAt: string;
  item: {
    id: string;
    itemType: string;
    message: string;
    status: string;
    priority: string | null;
    createdAt: string;
  };
}

interface LinkCandidate {
  id: string;
  itemType: string;
  message: string;
  status: string;
  priority: string | null;
  createdAt: string;
}

interface ParsedMetadata {
  browser?: string;
  os?: string;
  language?: string;
  devicePixelRatio?: string;
  screenResolution?: string;
  timezone?: string;
}

interface RecordingSummary {
  hasRecording?: boolean;
  recordingDurationMs?: number;
  eventCount?: number;
  firstTimestamp?: number | null;
  lastTimestamp?: number | null;
  fullSnapshotCount?: number;
  incrementalEventCount?: number;
  recordingPath?: string | null;
  importantEvents?: Array<{ ts?: number; type?: string; summary?: string }>;
}

interface DebugContext {
  version?: number;
  capturedAt?: string;
  page?: {
    url?: string;
    title?: string;
    referrer?: string;
    route?: string;
    visibilityState?: string;
    viewport?: { width?: number; height?: number };
    screen?: { width?: number; height?: number; devicePixelRatio?: string };
  };
  navigation?: Array<{ ts?: number; type?: string; url?: string; title?: string }>;
  actions?: Array<{ ts?: number; type?: string; selector?: string; text?: string; tag?: string; url?: string }>;
  console?: Array<{ ts?: number; level?: string; message?: string; stack?: string; url?: string }>;
  network?: Array<{ ts?: number; method?: string; url?: string; status?: number; ok?: boolean; durationMs?: number; requestBody?: string; responseBody?: string; error?: string }>;
  performance?: { navigationType?: string; loadTimeMs?: number; domContentLoadedMs?: number };
  recordingSummary?: RecordingSummary;
}

const noteTypeColors: Record<string, string> = {
  user: 'bg-blue-100 text-blue-700',
  system: 'bg-gray-100 text-gray-600',
  ai: 'bg-purple-100 text-purple-700',
  resolution: 'bg-green-100 text-green-700',
};

const itemStatusIds = ['new', 'in_progress', 'review', 'done', 'changes_requested', 'verified', 'cancelled'];

const initialEvidenceDraft: EvidenceDraft = {
  kind: 'handoff',
  result: 'pass',
  level: 'local_acceptance',
  coverage: 'item',
  source: 'human',
  environment: '',
  role: '',
  url: '',
  scenario: '',
  action: '',
  visibleResult: '',
  consoleResult: '',
  networkResult: '',
  apiResult: '',
  dbResult: '',
  fixture: '',
  cleanupResult: '',
  commitSha: '',
  deploySha: '',
  risks: '',
  uncheckedRisks: '',
  acceptanceScope: '',
};

const initialChangeRequestDraft: ChangeRequestDraft = {
  summary: '',
  expected: '',
  actual: '',
  steps: '',
  url: '',
};

const evidenceRequiredFields: Array<keyof EvidenceDraft> = ['environment', 'scenario', 'action', 'visibleResult'];
const doneEvidenceLevels: EvidenceLevel[] = ['local_acceptance', 'staging_acceptance', 'production_acceptance', 'user_acceptance'];
const evidenceLevels: EvidenceLevel[] = [
  'static',
  'typecheck',
  'api_smoke',
  'browser_smoke',
  'browser_acceptance',
  'local_acceptance',
  'staging_acceptance',
  'production_acceptance',
  'user_acceptance',
];

function parseMetadata(raw: string | null): ParsedMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) return parsed as ParsedMetadata;
    return null;
  } catch {
    return null;
  }
}

function parseDebugContext(raw: string | null): DebugContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as DebugContext;
    return null;
  } catch {
    return null;
  }
}

function formatDurationMs(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '0ms';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function formatDebugTimestamp(ts: number | null | undefined, locale: Locale): string {
  if (!ts) return '—';
  return formatDate(new Date(ts).toISOString(), locale);
}

function shortText(value: string | null | undefined, max = 160): string {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function hasRecordingStats(summary: RecordingSummary | null | undefined): boolean {
  return Boolean(summary && (summary.hasRecording || summary.eventCount || summary.recordingDurationMs));
}

interface AutoNote {
  key: string;
  params?: Record<string, string>;
}

const NOTE_SECTION_LABELS = [
  'Итог',
  'Как понял задачу',
  'Причина и последствия',
  'Причина',
  'Root cause',
  'Что изменилось',
  'Решение',
  'Сделано',
  'Технические детали',
  'Deployed images',
  'Проверка доступности',
  'Проверка API',
  'Проверка UI',
  'Проверка',
  'Commit/ветка/PR',
  'Статус и риски',
  'Статус',
  'Осталось',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeNoteContent(content: string): string {
  let normalized = content.replace(/\\n/g, '\n').replace(/\r\n?/g, '\n').trim();
  for (const label of NOTE_SECTION_LABELS) {
    normalized = normalized.replace(
      new RegExp(`\\s+(${escapeRegExp(label)}:)`, 'g'),
      '\n\n$1',
    );
  }
  return normalized.replace(/\n{3,}/g, '\n\n');
}

function renderInlineText(text: string) {
  return text.split(/(`[^`]+`)/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={index} className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.85em] text-gray-700">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

function renderPlainNoteContent(content: string) {
  return normalizeNoteContent(content).split(/\n{2,}/).map((block, blockIndex) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const bulletLines = lines
      .map((line) => line.match(/^[-*•]\s+(.+)$/)?.[1])
      .filter((line): line is string => Boolean(line));

    if (bulletLines.length === lines.length && bulletLines.length > 0) {
      return (
        <ul key={blockIndex} className="list-disc space-y-1 pl-5">
          {bulletLines.map((line, lineIndex) => (
            <li key={lineIndex}>{renderInlineText(line)}</li>
          ))}
        </ul>
      );
    }

    return (
      <p key={blockIndex}>
        {lines.map((line, lineIndex) => (
          <span key={lineIndex}>
            {lineIndex > 0 && <br />}
            {renderInlineText(line)}
          </span>
        ))}
      </p>
    );
  });
}

/** Try to parse note content as structured JSON auto-note. */
function parseAutoNote(content: string): AutoNote | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.key === 'string') {
      return parsed as AutoNote;
    }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') return null;
    if (parsed.type === 'status_change' && typeof parsed.from === 'string' && typeof parsed.to === 'string') {
      return { key: 'notes.statusChange', params: { from: parsed.from, to: parsed.to } };
    }
    if (parsed.type === 'assignment') {
      return { key: 'notes.assigned', params: { name: typeof parsed.userName === 'string' ? parsed.userName : '' } };
    }
    if (parsed.type === 'type_change' && typeof parsed.from === 'string' && typeof parsed.to === 'string') {
      return { key: 'notes.typeChange', params: { from: parsed.from, to: parsed.to } };
    }
    if (parsed.type === 'reopen') {
      if (typeof parsed.from !== 'string' || typeof parsed.to !== 'string') return { key: 'notes.reopened' };
      const details = [parsed.reason, parsed.auditResult]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(', ');
      return {
        key: 'notes.reopenedDetailed',
        params: {
          from: parsed.from,
          to: parsed.to,
          details,
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

export default function ItemDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const admin = isAdmin();
  const { t, locale } = useTranslation();
  const [item, setItem] = useState<ItemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [modalError, setModalError] = useState('');

  // Review/done handoff modal state
  const [showHandoffModal, setShowHandoffModal] = useState(false);
  const [handoffStatus, setHandoffStatus] = useState<HandoffStatus>('done');
  const [handoffRevision, setHandoffRevision] = useState('');
  const [resolutionNote, setResolutionNote] = useState('');
  const [branchName, setBranchName] = useState('');
  const [mrUrl, setMrUrl] = useState('');
  const [evidenceDraft, setEvidenceDraft] = useState<EvidenceDraft>(initialEvidenceDraft);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifyRevision, setVerifyRevision] = useState('');
  const [verifyComment, setVerifyComment] = useState('');
  const [showChangesModal, setShowChangesModal] = useState(false);
  const [changesRevision, setChangesRevision] = useState('');
  const [changeRequest, setChangeRequest] = useState<ChangeRequestDraft>(initialChangeRequestDraft);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [editRevision, setEditRevision] = useState('');
  const [editItemType, setEditItemType] = useState<'bug' | 'note' | 'task'>('bug');
  const [editMessage, setEditMessage] = useState('');
  const [editPriority, setEditPriority] = useState('medium');
  const [editLabels, setEditLabels] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Assignee state
  const [teamUsers, setTeamUsers] = useState<UserListItem[]>([]);
  const [assigneeLoading, setAssigneeLoading] = useState(false);

  // Related items state
  const [linkTargetId, setLinkTargetId] = useState('');
  const [linkSearch, setLinkSearch] = useState('');
  const [linkCandidates, setLinkCandidates] = useState<LinkCandidate[]>([]);
  const [linkCandidatesLoading, setLinkCandidatesLoading] = useState(false);
  const [linkType, setLinkType] = useState('related');
  const [linkSaving, setLinkSaving] = useState(false);

  async function loadItem(): Promise<boolean> {
    try {
      setLoading(true);
      const data = await api<ItemData>('/api/items/get', { id });
      setItem(data);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('validation.loadError'));
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function refreshAfterConflict(err: unknown): Promise<boolean> {
    if (!(err instanceof ApiError) || err.status !== 409) return false;
    return loadItem();
  }

  function mutationErrorMessage(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback;
  }

  async function loadUsers() {
    try {
      const res = await api<{ items: UserListItem[] }>('/api/users/list', { perPage: 100 });
      setTeamUsers(res.items);
    } catch {
      // Users list not available (non-admin) — ignore
    }
  }

  useEffect(() => {
    loadItem();
    if (admin) loadUsers();
  }, [id]);

  useEffect(() => {
    if (!item?.permissions.canLinkItems) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLinkCandidatesLoading(true);
      try {
        const res = await api<{ items: LinkCandidate[] }>('/api/items/list', {
          projectId: item.projectId,
          perPage: 12,
          ...(linkSearch.trim() ? { search: linkSearch.trim() } : {}),
        });
        if (cancelled) return;
        const linkedIds = new Set(item.relatedItems.map((link) => link.item.id));
        const candidates = res.items.filter((candidate) => (
          candidate.id !== item.id && !linkedIds.has(candidate.id)
        ));
        setLinkCandidates(candidates);
        setLinkTargetId((current) => (
          current && candidates.some((candidate) => candidate.id === current)
            ? current
            : candidates[0]?.id ?? ''
        ));
      } catch {
        if (!cancelled) setLinkCandidates([]);
      } finally {
        if (!cancelled) setLinkCandidatesLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [item, linkSearch]);

  // SSE: real-time updates for this item
  const handleSSEEvent = useCallback((event: SSEEventType, data: unknown) => {
    const d = data as Record<string, unknown> | null;
    if (!d) return;

    // Item deleted → navigate back
    if (event === 'item.deleted' && d.itemId === id) {
      navigate('/items');
      return;
    }

    // Any change to this item → refetch
    const itemObj = d.item as Record<string, unknown> | undefined;
    if (itemObj?.id === id || d.itemId === id) {
      loadItem();
    }
  }, [id, navigate]);

  useSSE({ onEvent: handleSSEEvent });

  // Fancybox for screenshot zoom
  useEffect(() => {
    Fancybox.bind('[data-fancybox]', {});
    return () => { Fancybox.destroy(); };
  }, [item]);

  async function handleAction(
    action: 'claim' | 'cancel' | 'update-status',
    extra?: Record<string, unknown>,
  ) {
    if (!item) return;
    setActionLoading(true);
    try {
      if (action === 'claim') {
        await api('/api/items/claim', { id: item.id, updatedAt: item.updatedAt }, t);
      } else if (action === 'cancel') {
        await api('/api/items/cancel', { id: item.id, updatedAt: item.updatedAt }, t);
      } else if (action === 'update-status') {
        await api('/api/items/update-status', { id: item.id, updatedAt: item.updatedAt, ...extra }, t);
      }
      await loadItem();
    } catch (err) {
      await refreshAfterConflict(err);
      setError(mutationErrorMessage(err, t('validation.requestError')));
    } finally {
      setActionLoading(false);
    }
  }

  function openHandoffModal(status: HandoffStatus) {
    if (!item) return;
    setError('');
    setModalError('');
    setHandoffStatus(status);
    setHandoffRevision(item.updatedAt);
    setResolutionNote('');
    setBranchName('');
    setMrUrl('');
    setEvidenceDraft({
      ...initialEvidenceDraft,
      url: item.pageUrl ?? '',
    });
    setShowHandoffModal(true);
  }

  function updateEvidenceField(field: keyof EvidenceDraft, value: string) {
    setEvidenceDraft((current) => ({ ...current, [field]: value } as EvidenceDraft));
  }

  function buildEvidencePayload() {
    const entries = Object.entries(evidenceDraft)
      .map(([key, value]) => [key, value.trim()] as const)
      .filter(([, value]) => value.length > 0);
    return { ...Object.fromEntries(entries), verifiedAt: new Date().toISOString() };
  }

  const baseEvidenceReady = evidenceRequiredFields.every((field) => evidenceDraft[field].trim().length > 0);
  const passingEvidenceReady = evidenceDraft.result === 'pass';
  const reviewEvidenceReady = handoffStatus !== 'review' || evidenceDraft.commitSha.trim().length > 0;
  const doneEvidenceReady = handoffStatus !== 'done' || (
    doneEvidenceLevels.includes(evidenceDraft.level)
    && Boolean(evidenceDraft.coverage)
    && evidenceDraft.acceptanceScope.trim().length > 0
  );
  const evidenceReady = baseEvidenceReady && passingEvidenceReady && reviewEvidenceReady && doneEvidenceReady;

  async function handleHandoff() {
    if (!item || !handoffRevision || !evidenceReady) return;
    setActionLoading(true);
    setModalError('');
    try {
      const evidence = buildEvidencePayload();
      if (handoffStatus === 'done') {
        await api('/api/items/resolve', {
          id: item.id,
          updatedAt: handoffRevision,
          resolutionNote: resolutionNote || undefined,
          branchName: branchName || undefined,
          mrUrl: mrUrl || undefined,
          evidence,
        }, t);
      } else {
        await api('/api/items/update-status', {
          id: item.id,
          updatedAt: handoffRevision,
          status: 'review',
          branchName: branchName || undefined,
          mrUrl: mrUrl || undefined,
          evidence,
        }, t);
      }
      setShowHandoffModal(false);
      setResolutionNote('');
      setBranchName('');
      setMrUrl('');
      setEvidenceDraft(initialEvidenceDraft);
      await loadItem();
    } catch (err) {
      const message = mutationErrorMessage(err, t('validation.requestError'));
      if (await refreshAfterConflict(err)) {
        setShowHandoffModal(false);
        setError(message);
      } else {
        setModalError(message);
      }
    } finally {
      setActionLoading(false);
    }
  }

  function openVerifyModal() {
    if (!item) return;
    setError('');
    setModalError('');
    setVerifyRevision(item.updatedAt);
    setVerifyComment('');
    setShowVerifyModal(true);
  }

  function openChangesModal() {
    if (!item) return;
    setError('');
    setModalError('');
    setChangesRevision(item.updatedAt);
    setChangeRequest({
      ...initialChangeRequestDraft,
      url: item?.pageUrl ?? '',
    });
    setShowChangesModal(true);
  }

  function updateChangeRequestField(field: keyof ChangeRequestDraft, value: string) {
    setChangeRequest((current) => ({ ...current, [field]: value }));
  }

  const changeRequestReady = Boolean(changeRequest.summary.trim() && changeRequest.expected.trim() && changeRequest.actual.trim());

  async function handleVerify() {
    if (!item || !verifyRevision) return;
    setActionLoading(true);
    setModalError('');
    try {
      await api('/api/items/verify', {
        id: item.id,
        updatedAt: verifyRevision,
        comment: verifyComment.trim() || undefined,
      }, t);
      setShowVerifyModal(false);
      setVerifyComment('');
      await loadItem();
    } catch (err) {
      const message = mutationErrorMessage(err, t('validation.requestError'));
      if (await refreshAfterConflict(err)) {
        setShowVerifyModal(false);
        setError(message);
      } else {
        setModalError(message);
      }
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRequestChanges() {
    if (!item || !changesRevision || !changeRequestReady) return;
    setActionLoading(true);
    setModalError('');
    try {
      await api('/api/items/request-changes', {
        id: item.id,
        updatedAt: changesRevision,
        summary: changeRequest.summary.trim(),
        expected: changeRequest.expected.trim(),
        actual: changeRequest.actual.trim(),
        steps: changeRequest.steps.trim() || undefined,
        url: changeRequest.url.trim() || undefined,
      }, t);
      setShowChangesModal(false);
      setChangeRequest(initialChangeRequestDraft);
      await loadItem();
    } catch (err) {
      const message = mutationErrorMessage(err, t('validation.requestError'));
      if (await refreshAfterConflict(err)) {
        setShowChangesModal(false);
        setError(message);
      } else {
        setModalError(message);
      }
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDelete() {
    if (!item) return;
    if (!window.confirm(t('items.detail.deleteConfirm'))) return;
    setActionLoading(true);
    try {
      await api('/api/items/delete', { id: item.id, updatedAt: item.updatedAt }, t);
      navigate('/items');
    } catch (err) {
      await refreshAfterConflict(err);
      setError(mutationErrorMessage(err, t('validation.deleteError')));
      setActionLoading(false);
    }
  }

  async function handleReopen() {
    if (!item) return;
    setActionLoading(true);
    try {
      await api('/api/items/reopen', {
        id: item.id,
        updatedAt: item.updatedAt,
      }, t);
      await loadItem();
    } catch (err) {
      await refreshAfterConflict(err);
      setError(mutationErrorMessage(err, t('validation.requestError')));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleMakeTask() {
    if (!item || item.itemType !== 'note') return;
    setActionLoading(true);
    try {
      await api('/api/items/update', { id: item.id, updatedAt: item.updatedAt, itemType: 'task' }, t);
      await loadItem();
    } catch (err) {
      await refreshAfterConflict(err);
      setError(mutationErrorMessage(err, t('validation.updateError')));
    } finally {
      setActionLoading(false);
    }
  }

  function startEditing() {
    if (!item) return;
    setEditItemType(item.itemType);
    setEditRevision(item.updatedAt);
    setEditMessage(item.message);
    setEditPriority(item.priority ?? 'medium');
    setEditLabels(parseLabels(item.labels).join(', '));
    setEditing(true);
  }

  async function handleEditSave() {
    if (!item || !editRevision || !editMessage.trim()) return;
    setEditSaving(true);
    try {
      const labelsArr = editLabels
        .split(',')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      await api('/api/items/update', {
        id: item.id,
        updatedAt: editRevision,
        itemType: editItemType,
        message: editMessage.trim(),
        ...(editItemType !== 'note' ? { priority: editPriority } : {}),
        labels: labelsArr,
      }, t);
      setEditing(false);
      await loadItem();
    } catch (err) {
      if (await refreshAfterConflict(err)) setEditing(false);
      setError(mutationErrorMessage(err, t('validation.saveError')));
    } finally {
      setEditSaving(false);
    }
  }

  async function handleAssigneeChange(assigneeId: string) {
    if (!item) return;
    setAssigneeLoading(true);
    try {
      await api('/api/items/update', {
        id: item.id,
        updatedAt: item.updatedAt,
        assigneeId: assigneeId || null,
      }, t);
      await loadItem();
    } catch (err) {
      await refreshAfterConflict(err);
      setError(mutationErrorMessage(err, t('validation.assignError')));
    } finally {
      setAssigneeLoading(false);
    }
  }

  const notesRef = useRef<HTMLDivElement>(null);

  async function handleAddNote(e: FormEvent) {
    e.preventDefault();
    if (!item || !noteContent.trim()) return;
    setNoteSaving(true);
    try {
      await api('/api/items/add-note', {
        id: item.id,
        content: noteContent.trim(),
      });
      setNoteContent('');
      // Add note to local state without full reload to preserve scroll
      const getRes = await api<{ notes: typeof item.notes }>('/api/items/get', { id: item.id });
      setItem((prev) => prev ? { ...prev, notes: getRes.notes } : prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('validation.noteError'));
    } finally {
      setNoteSaving(false);
    }
  }

  async function handleLinkItem(e: FormEvent) {
    e.preventDefault();
    if (!item || !linkTargetId.trim()) return;
    setLinkSaving(true);
    try {
      await api('/api/items/link', {
        sourceItemId: item.id,
        targetItemId: linkTargetId,
        type: linkType,
      });
      setLinkTargetId('');
      setLinkSearch('');
      setLinkType('related');
      await loadItem();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('validation.requestError'));
    } finally {
      setLinkSaving(false);
    }
  }

  async function handleUnlinkItem(linkId: string) {
    if (!item) return;
    setLinkSaving(true);
    try {
      await api('/api/items/unlink', { id: linkId });
      await loadItem();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('validation.requestError'));
    } finally {
      setLinkSaving(false);
    }
  }

  /** Render note content — auto-notes (JSON) get translated, plain text gets readable spacing. */
  function renderNoteContent(content: string) {
    const autoNote = parseAutoNote(content);
    if (autoNote) {
      const params = autoNote.params ? { ...autoNote.params } : undefined;
      if (params?.from && itemStatusIds.includes(params.from)) params.from = t(`items.statuses.${params.from}`);
      if (params?.to && itemStatusIds.includes(params.to)) params.to = t(`items.statuses.${params.to}`);
      return t(autoNote.key, params);
    }
    return renderPlainNoteContent(content);
  }

  const noteTypeLabels: Record<string, string> = {
    comment: t('items.detail.notes.types.comment'),
    status_change: t('items.detail.notes.types.status'),
    assignment: t('items.detail.notes.types.assignment'),
    type_change: t('items.detail.notes.types.typeChange'),
  };

  const linkTypeLabels: Record<string, string> = {
    related: t('items.detail.links.types.related'),
    duplicate: t('items.detail.links.types.duplicate'),
    blocks: t('items.detail.links.types.blocks'),
    blocked_by: t('items.detail.links.types.blocked_by'),
    caused_by: t('items.detail.links.types.caused_by'),
    conflicts: t('items.detail.links.types.conflicts'),
  };

  if (loading) {
    return (
      <div className="p-4 md:p-6 text-gray-400">{t('common.loading')}</div>
    );
  }

  if (error && !item) {
    return (
      <div className="p-4 md:p-6">
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  if (!item) return null;

  const screenshotUrl = item.screenshotPath
    ? storageUrl(item.screenshotPath)
    : null;
  const recordingUrl = item.sessionRecordingPath
    ? storageUrl(item.sessionRecordingPath)
    : null;

  const viewportStr = item.viewportWidth && item.viewportHeight
    ? `${item.viewportWidth}×${item.viewportHeight}`
    : null;

  const meta = parseMetadata(item.metadata);
  const debugContext = parseDebugContext(item.debugContext);
  const debugContextInvalid = Boolean(item.debugContext && !debugContext);
  const navigationEntries = Array.isArray(debugContext?.navigation) ? debugContext.navigation : [];
  const actionEntries = Array.isArray(debugContext?.actions) ? debugContext.actions : [];
  const consoleIssues = (Array.isArray(debugContext?.console) ? debugContext.console : [])
    .filter((entry) => entry.level === 'error' || entry.level === 'warn');
  const networkIssues = (Array.isArray(debugContext?.network) ? debugContext.network : [])
    .filter((entry) => entry.error || entry.ok === false || (entry.status ?? 0) >= 400 || (entry.durationMs ?? 0) >= 1_000);
  const recordingSummary = debugContext?.recordingSummary ?? null;
  const rawDebugContext = debugContext ? JSON.stringify(debugContext, null, 2) : item.debugContext;
  const itemText = splitItemMessage(item.message);

  const isTerminal = item.status === 'verified' || item.status === 'cancelled';

  return (
    <div className="p-4 md:p-6">
      {/* Header */}
      <div className="mb-4 md:mb-6">
        {/* Back button — sticky on mobile */}
        <div className="sticky top-0 z-10 -mx-4 mb-3 bg-gray-50 px-4 py-2 md:static md:mx-0 md:bg-transparent md:p-0 md:mb-3">
          <button
            onClick={() => navigate(-1)}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            &larr; {t('items.detail.back')}
          </button>
        </div>
        <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-start md:justify-between md:gap-4">
          <div className="min-w-0">
            {/* Page title: first line of the item message */}
            <h1 className="text-lg font-bold leading-snug text-gray-900 break-words mb-2">
              {itemText.title}
            </h1>
            <div className="flex flex-wrap items-center gap-2 md:gap-3 text-sm text-gray-500">
              <ItemTypeBadge itemType={item.itemType} />
              <StatusBadge status={item.status} />
              <PriorityBadge priority={item.priority} />
              <span className="font-mono text-xs">#{item.id.slice(0, 8)}</span>
              <span>{formatDate(item.createdAt, locale)}</span>
            </div>
            {parseLabels(item.labels).length > 0 && (
              <div className="mt-1.5">
                <Labels labels={parseLabels(item.labels)} />
              </div>
            )}
            {editing ? (
              <div className="mt-2 space-y-3">
                <textarea
                  value={editMessage}
                  onChange={(e) => setEditMessage(e.target.value)}
                  rows={4}
                  className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
                />
                <div className="flex flex-col gap-3 md:flex-row md:items-center">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <span className="text-xs font-medium text-gray-500">{t('items.table.type')}</span>
                    <select
                      value={editItemType}
                      onChange={(e) => setEditItemType(e.target.value as 'bug' | 'note' | 'task')}
                      className="rounded-md border border-gray-300 px-2 py-1 text-sm shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
                    >
                      <option value="bug">{t('items.types.bug')}</option>
                      <option value="note">{t('items.types.note')}</option>
                      <option value="task">{t('items.types.task')}</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <span className="text-xs font-medium text-gray-500">{t('items.table.priority')}</span>
                    <select
                      value={editPriority}
                      onChange={(e) => setEditPriority(e.target.value)}
                      className="rounded-md border border-gray-300 px-2 py-1 text-sm shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
                    >
                      <option value="critical">{t('items.priorities.critical')}</option>
                      <option value="high">{t('items.priorities.high')}</option>
                      <option value="medium">{t('items.priorities.medium')}</option>
                      <option value="low">{t('items.priorities.low')}</option>
                    </select>
                  </label>
                  <label className="flex flex-1 items-center gap-2 text-sm text-gray-700">
                    <span className="text-xs font-medium text-gray-500 shrink-0">{t('items.table.labels')}</span>
                    <input
                      type="text"
                      value={editLabels}
                      onChange={(e) => setEditLabels(e.target.value)}
                      placeholder="bug, UI, urgent"
                      className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
                    />
                  </label>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleEditSave}
                    disabled={editSaving || !editMessage.trim()}
                    className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                  >
                    {editSaving ? t('common.saving') : t('common.save')}
                  </button>
                  <button
                    onClick={() => setEditing(false)}
                    disabled={editSaving}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-2 flex items-center gap-2">
                {item.permissions.canUpdate && !isTerminal && (
                  <button
                    onClick={startEditing}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                    title={t('items.detail.actions.edit')}
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                    {t('items.detail.actions.edit')}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Action buttons — below the description on mobile, inline with the title on desktop */}
          <div className="order-last flex flex-col gap-2 md:order-none md:flex-row md:flex-shrink-0 md:flex-wrap">
            {item.itemType === 'note' && item.permissions.canUpdate && !isTerminal && (
              <button
                onClick={handleMakeTask}
                disabled={actionLoading}
                className="w-full md:w-auto rounded-md bg-emerald-600 px-3 py-2 md:py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {t('items.detail.actions.makeTask')}
              </button>
            )}
            {item.status === 'new' && (item.permissions.canClaim || item.permissions.canCancel) && (
              <>
                {item.permissions.canClaim && (
                  <button
                    onClick={() => handleAction('claim')}
                    disabled={actionLoading}
                    className="w-full md:w-auto rounded-md bg-blue-600 px-3 py-2 md:py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {t('items.detail.actions.claim')}
                  </button>
                )}
                {item.permissions.canCancel && (
                  <button
                    onClick={() => handleAction('cancel')}
                    disabled={actionLoading}
                    className="w-full md:w-auto rounded-md border border-gray-300 px-3 py-2 md:py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {t('items.detail.actions.cancel')}
                  </button>
                )}
              </>
            )}
            {item.status === 'in_progress' && item.permissions.canUpdateStatus && (
              <>
                <button
                  onClick={() =>
                    openHandoffModal('review')
                  }
                  disabled={actionLoading}
                  className="w-full md:w-auto rounded-md bg-purple-600 px-3 py-2 md:py-1.5 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
                >
                  {t('items.detail.actions.review')}
                </button>
                <button
                  onClick={() => openHandoffModal('done')}
                  disabled={actionLoading}
                  className="w-full md:w-auto rounded-md bg-green-600 px-3 py-2 md:py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {t('items.detail.actions.done')}
                </button>
                {item.permissions.canCancel && (
                  <button
                    onClick={() => handleAction('cancel')}
                    disabled={actionLoading}
                    className="w-full md:w-auto rounded-md border border-gray-300 px-3 py-2 md:py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {t('items.detail.actions.cancel')}
                  </button>
                )}
              </>
            )}
            {item.status === 'changes_requested' && item.permissions.canUpdateStatus && (
              <>
                <button
                  onClick={() => handleAction('update-status', { status: 'in_progress' })}
                  disabled={actionLoading}
                  className="w-full md:w-auto rounded-md bg-blue-600 px-3 py-2 md:py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {t('items.detail.actions.returnToWork')}
                </button>
                {item.permissions.canCancel && (
                  <button
                    onClick={() => handleAction('cancel')}
                    disabled={actionLoading}
                    className="w-full md:w-auto rounded-md border border-gray-300 px-3 py-2 md:py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {t('items.detail.actions.cancel')}
                  </button>
                )}
              </>
            )}
            {item.status === 'review' && item.permissions.canUpdateStatus && (
              <>
                <button
                  onClick={() =>
                    handleAction('update-status', { status: 'in_progress' })
                  }
                  disabled={actionLoading}
                  className="w-full md:w-auto rounded-md border border-gray-300 px-3 py-2 md:py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {t('items.detail.actions.returnToWork')}
                </button>
                <button
                  onClick={() => openHandoffModal('done')}
                  disabled={actionLoading}
                  className="w-full md:w-auto rounded-md bg-green-600 px-3 py-2 md:py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {t('items.detail.actions.done')}
                </button>
              </>
            )}
            {item.permissions.canVerify && (
              <button
                onClick={openVerifyModal}
                disabled={actionLoading}
                className="w-full md:w-auto rounded-md bg-emerald-600 px-3 py-2 md:py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {t('items.detail.actions.verify')}
              </button>
            )}
            {item.permissions.canRequestChanges && (
              <button
                onClick={openChangesModal}
                disabled={actionLoading}
                className="w-full md:w-auto rounded-md border border-red-200 px-3 py-2 md:py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                {t('items.detail.actions.requestChanges')}
              </button>
            )}
            {item.status === 'cancelled' && item.permissions.canReopen && (item.itemType !== 'note' || item.status === 'cancelled') && (
              <button
                onClick={handleReopen}
                disabled={actionLoading}
                className="w-full md:w-auto rounded-md bg-yellow-500 px-3 py-2 md:py-1.5 text-sm font-medium text-white hover:bg-yellow-600 disabled:opacity-50"
              >
                {t('items.detail.actions.reopen')}
              </button>
            )}
            {item.permissions.canDelete && (
              <button
                onClick={handleDelete}
                disabled={actionLoading}
                className="w-full md:w-auto rounded-md bg-red-600 px-3 py-2 md:py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {t('items.detail.actions.delete')}
              </button>
            )}
          </div>

          {/* Full description — always expanded, across the whole content width */}
          {itemText.details && (
            <div className="w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-[15px] leading-relaxed text-gray-800 whitespace-pre-wrap break-words md:basis-full">
              {itemText.details}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {item.errorGroups?.length > 0 && (
        <div className="mb-4 md:mb-6 rounded-lg border border-orange-200 bg-orange-50 p-3 md:p-4">
          <h3 className="mb-3 text-sm font-medium text-orange-900">{t('errors.itemContext.title')}</h3>
          <div className="space-y-3">
            {item.errorGroups.map((group) => (
              <ErrorGroupCard key={group.id} group={group} />
            ))}
          </div>
        </div>
      )}

      {/* Info grid — single column on mobile, 2 cols on desktop */}
      <div className="mb-4 md:mb-6 grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4 rounded-lg border border-gray-200 bg-white p-3 md:p-4">
        <InfoRow label={t('items.detail.elementInfo.url')} value={item.pageUrl} link />
        <InfoRow label={t('items.detail.elementInfo.selector')} value={item.cssSelector} mono />
        <InfoRow label={t('items.detail.elementInfo.element')} value={item.elementText} />
        <InfoRow label={t('items.detail.elementInfo.resolution')} value={viewportStr} />
        <InfoRow label={t('items.detail.elementInfo.author')} value={item.reporterName} />
        {/* Assignee — project triagers can assign, others see static text */}
        {item.permissions.canUpdate && teamUsers.length > 0 ? (
          <div>
            <dt className="text-xs font-medium text-gray-500">{t('items.detail.elementInfo.assignee')}</dt>
            <dd className="mt-0.5">
              <select
                value={item.assigneeId ?? ''}
                onChange={(e) => handleAssigneeChange(e.target.value)}
                disabled={assigneeLoading}
                className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:opacity-50"
              >
                <option value="">{t('items.detail.elementInfo.unassigned')}</option>
                {teamUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </dd>
          </div>
        ) : (
          <InfoRow label={t('items.detail.elementInfo.assignee')} value={item.assigneeName} />
        )}
      </div>

      {/* Metadata / environment info */}
      {meta && (
        <div className="mb-4 md:mb-6 grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 rounded-lg border border-gray-200 bg-white p-3 md:p-4">
          <div className="col-span-2 md:col-span-4">
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide">{t('items.detail.metadata.title')}</h3>
          </div>
          {meta.browser && <InfoRow label={t('items.detail.metadata.browser')} value={meta.browser} />}
          {meta.os && <InfoRow label={t('items.detail.metadata.os')} value={meta.os} />}
          {meta.screenResolution && <InfoRow label={t('items.detail.metadata.screen')} value={meta.screenResolution} />}
          {meta.timezone && <InfoRow label={t('items.detail.metadata.timezone')} value={meta.timezone} />}
          {meta.language && <InfoRow label={t('items.detail.metadata.language')} value={meta.language} />}
          {meta.devicePixelRatio && <InfoRow label={t('items.detail.metadata.dpr')} value={meta.devicePixelRatio} />}
        </div>
      )}

      {(debugContext || debugContextInvalid) && (
        <div className="mb-4 md:mb-6 rounded-lg border border-slate-200 bg-white p-3 md:p-4">
          <div className="mb-3 flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
            <h3 className="text-sm font-medium text-gray-800">{t('items.detail.debug.title')}</h3>
            {debugContext?.capturedAt && (
              <span className="text-xs text-gray-400">
                {t('items.detail.debug.capturedAt', { value: formatDate(debugContext.capturedAt, locale) })}
              </span>
            )}
          </div>

          {debugContextInvalid ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {t('items.detail.debug.invalid')}
            </div>
          ) : debugContext && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <InfoRow label={t('items.detail.debug.currentUrl')} value={debugContext.page?.url} link />
                <InfoRow label={t('items.detail.debug.titleLabel')} value={debugContext.page?.title} />
                <InfoRow label={t('items.detail.debug.route')} value={debugContext.page?.route} mono />
                <InfoRow label={t('items.detail.debug.visibility')} value={debugContext.page?.visibilityState} />
                <InfoRow
                  label={t('items.detail.debug.viewport')}
                  value={debugContext.page?.viewport?.width && debugContext.page?.viewport?.height ? `${debugContext.page.viewport.width}×${debugContext.page.viewport.height}` : null}
                />
                <InfoRow
                  label={t('items.detail.debug.performance')}
                  value={debugContext.performance ? `${debugContext.performance.navigationType ?? 'unknown'} · DCL ${formatDurationMs(debugContext.performance.domContentLoadedMs)} · load ${formatDurationMs(debugContext.performance.loadTimeMs)}` : null}
                />
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{t('items.detail.debug.navigation')}</h4>
                  {navigationEntries.length === 0 ? (
                    <p className="text-sm text-gray-400">{t('items.detail.debug.empty')}</p>
                  ) : (
                    <div className="space-y-2">
                      {navigationEntries.slice(-8).map((entry, index) => (
                        <div key={`${entry.ts}-${index}`} className="rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-xs">
                          <div className="mb-1 flex flex-wrap items-center gap-2 text-gray-500">
                            <span className="rounded bg-white px-1.5 py-0.5 font-mono text-gray-700">{entry.type ?? 'navigation'}</span>
                            <span>{formatDebugTimestamp(entry.ts, locale)}</span>
                          </div>
                          <div className="break-all font-mono text-gray-700">{entry.url}</div>
                          {entry.title && <div className="mt-1 text-gray-500">{shortText(entry.title)}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{t('items.detail.debug.actions')}</h4>
                  {actionEntries.length === 0 ? (
                    <p className="text-sm text-gray-400">{t('items.detail.debug.empty')}</p>
                  ) : (
                    <div className="space-y-2">
                      {actionEntries.slice(-10).map((entry, index) => (
                        <div key={`${entry.ts}-${index}`} className="rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-xs">
                          <div className="mb-1 flex flex-wrap items-center gap-2 text-gray-500">
                            <span className="rounded bg-white px-1.5 py-0.5 font-mono text-gray-700">{entry.type ?? 'action'}</span>
                            <span>{entry.tag}</span>
                            <span>{formatDebugTimestamp(entry.ts, locale)}</span>
                          </div>
                          {entry.text && <div className="text-gray-700">{shortText(entry.text)}</div>}
                          {entry.selector && <div className="mt-1 break-all font-mono text-gray-500">{entry.selector}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{t('items.detail.debug.console')}</h4>
                  {consoleIssues.length === 0 ? (
                    <p className="text-sm text-gray-400">{t('items.detail.debug.noConsoleIssues')}</p>
                  ) : (
                    <div className="space-y-2">
                      {consoleIssues.slice(-8).map((entry, index) => (
                        <div key={`${entry.ts}-${index}`} className="rounded-md border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-900">
                          <div className="mb-1 flex flex-wrap items-center gap-2 text-red-700">
                            <span className="rounded bg-white px-1.5 py-0.5 font-mono">{entry.level}</span>
                            <span>{formatDebugTimestamp(entry.ts, locale)}</span>
                          </div>
                          <div className="break-words">{shortText(entry.message, 260)}</div>
                          {entry.stack && <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-white/70 p-2 font-mono text-[11px] text-red-800">{shortText(entry.stack, 800)}</pre>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{t('items.detail.debug.network')}</h4>
                  {networkIssues.length === 0 ? (
                    <p className="text-sm text-gray-400">{t('items.detail.debug.noNetworkIssues')}</p>
                  ) : (
                    <div className="space-y-2">
                      {networkIssues.slice(-8).map((entry, index) => (
                        <div key={`${entry.ts}-${index}`} className="rounded-md border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-950">
                          <div className="mb-1 flex flex-wrap items-center gap-2 text-amber-700">
                            <span className="rounded bg-white px-1.5 py-0.5 font-mono">{entry.method ?? 'GET'}</span>
                            {entry.status !== undefined && <span>{entry.status}</span>}
                            {entry.durationMs !== undefined && <span>{formatDurationMs(entry.durationMs)}</span>}
                            <span>{formatDebugTimestamp(entry.ts, locale)}</span>
                          </div>
                          <div className="break-all font-mono text-amber-900">{entry.url}</div>
                          {entry.error && <div className="mt-1 text-red-700">{shortText(entry.error)}</div>}
                          {entry.responseBody && <div className="mt-1 break-words text-amber-800">{shortText(entry.responseBody, 260)}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {recordingSummary && (
                <div className="rounded-md border border-blue-100 bg-blue-50 p-3">
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-blue-700">{t('items.detail.debug.recordingSummary')}</h4>
                  <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
                    <InfoRow label={t('items.detail.debug.hasRecording')} value={recordingSummary.hasRecording ? t('common.yes') : t('common.no')} />
                    <InfoRow label={t('items.detail.debug.duration')} value={formatDurationMs(recordingSummary.recordingDurationMs)} />
                    <InfoRow label={t('items.detail.debug.eventCount')} value={String(recordingSummary.eventCount ?? 0)} />
                    <InfoRow label={t('items.detail.debug.snapshots')} value={`${recordingSummary.fullSnapshotCount ?? 0} / ${recordingSummary.incrementalEventCount ?? 0}`} />
                  </div>
                  {Array.isArray(recordingSummary.importantEvents) && recordingSummary.importantEvents.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {recordingSummary.importantEvents.slice(0, 8).map((entry, index) => (
                        <span key={`${entry.ts}-${index}`} className="rounded-full bg-white px-2 py-1 text-xs text-blue-800">
                          {entry.type}: {shortText(entry.summary, 80)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {rawDebugContext && (
                <details className="rounded-md border border-gray-200 bg-gray-50">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-gray-600">{t('items.detail.debug.raw')}</summary>
                  <pre className="max-h-96 overflow-auto border-t border-gray-200 p-3 text-xs text-gray-700">
                    <code>{rawDebugContext}</code>
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      )}

      {item.elementHtml && (
        <div className="mb-4 md:mb-6">
          <h3 className="mb-2 text-sm font-medium text-gray-700">
            {t('items.detail.html')}
          </h3>
          <pre className="overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
            <code>{item.elementHtml}</code>
          </pre>
        </div>
      )}

      {/* Screenshot with lightbox */}
      {screenshotUrl && (
        <div className="mb-4 md:mb-6">
          <h3 className="mb-2 text-sm font-medium text-gray-700">{t('items.detail.screenshot.title')}</h3>
          <div className="rounded-lg border border-gray-200 overflow-auto max-h-[400px]">
            <a href={screenshotUrl} data-fancybox="screenshot" data-caption={t('items.detail.screenshot.caption')}>
              <img
                src={screenshotUrl}
                alt={t('items.detail.screenshot.title')}
                className="w-full h-auto cursor-zoom-in hover:opacity-90 transition-opacity"
              />
            </a>
          </div>
          <p className="mt-1 text-xs text-gray-400">{t('items.detail.screenshot.hint')}</p>
        </div>
      )}

      {/* Resolution / handoff context should remain visible after review or requested changes. */}
      {(item.branchName || item.mrUrl || item.resolvedAt || item.resolutionNote) && (
        <div className="mb-4 md:mb-6 rounded-lg border border-green-200 bg-green-50 p-3 md:p-4">
          <h3 className="mb-3 text-sm font-medium text-green-800">{t('items.detail.resolution.title')}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {item.branchName && (
              <div>
                <dt className="text-xs font-medium text-green-700">{t('items.detail.resolution.branch')}</dt>
                <dd className="mt-0.5 text-sm text-green-900 font-mono break-all">{item.branchName}</dd>
              </div>
            )}
            {item.mrUrl && (
              <div>
                <dt className="text-xs font-medium text-green-700">{t('items.detail.resolution.mrUrl')}</dt>
                <dd className="mt-0.5 text-sm break-all">
                  <a
                    href={item.mrUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    {item.mrUrl}
                  </a>
                </dd>
              </div>
            )}
            {item.resolvedAt && (
              <div>
                <dt className="text-xs font-medium text-green-700">{t('items.detail.resolution.date')}</dt>
                <dd className="mt-0.5 text-sm text-green-900">{formatDate(item.resolvedAt, locale)}</dd>
              </div>
            )}
            {item.resolutionNote && (
              <div className="md:col-span-2">
                <dt className="text-xs font-medium text-green-700">{t('items.detail.resolution.comment')}</dt>
                <dd className="mt-0.5 text-sm text-green-900 whitespace-pre-wrap">{item.resolutionNote}</dd>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Structured evidence */}
      <div className="mb-4 md:mb-6 rounded-lg border border-gray-200 bg-white p-3 md:p-4">
        <div className="mb-3 flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-800">{t('items.detail.evidence.title')}</h3>
            <p className="text-xs text-gray-500">{t('items.detail.evidence.description')}</p>
          </div>
        </div>
        {item.evidence.length === 0 ? (
          <p className="text-sm text-gray-400">{t('items.detail.evidence.empty')}</p>
        ) : (
          <div className="space-y-3">
            {item.evidence.map((entry) => (
              <div key={entry.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <span className="rounded-full bg-gray-200 px-2 py-0.5 font-medium text-gray-700">
                    {t(`items.detail.evidence.kinds.${entry.kind}`)}
                  </span>
                  {entry.result && <span>{t(`items.detail.evidence.results.${entry.result}`)}</span>}
                  {entry.level && <span>{t(`items.detail.evidence.levels.${entry.level}`)}</span>}
                  <span>{entry.environment}</span>
                  {entry.role && <span>{entry.role}</span>}
                  <span>{entry.userName ?? 'System'}</span>
                  <span>{formatDate(entry.createdAt, locale)}</span>
                </div>
                <div className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
                  <InfoRow label={t('items.detail.evidence.scenario')} value={entry.scenario} />
                  <InfoRow label={t('items.detail.evidence.coverage')} value={entry.coverage ? t(`items.detail.evidence.coverageValues.${entry.coverage}`) : null} />
                  <InfoRow label={t('items.detail.evidence.source')} value={entry.source ? t(`items.detail.evidence.sources.${entry.source}`) : null} />
                  <InfoRow label={t('items.detail.evidence.action')} value={entry.action} />
                  <InfoRow label={t('items.detail.evidence.visibleResult')} value={entry.visibleResult} />
                  <InfoRow label={t('items.detail.evidence.acceptanceScope')} value={entry.acceptanceScope} />
                  <InfoRow label={t('items.detail.evidence.networkResult')} value={entry.networkResult} />
                  <InfoRow label={t('items.detail.evidence.consoleResult')} value={entry.consoleResult} />
                  <InfoRow label={t('items.detail.evidence.apiResult')} value={entry.apiResult} />
                  <InfoRow label={t('items.detail.evidence.dbResult')} value={entry.dbResult} />
                  <InfoRow label={t('items.detail.evidence.fixture')} value={entry.fixture} />
                  <InfoRow label={t('items.detail.evidence.cleanupResult')} value={entry.cleanupResult} />
                  <InfoRow label={t('items.detail.evidence.commitSha')} value={entry.commitSha} mono />
                  <InfoRow label={t('items.detail.evidence.deploySha')} value={entry.deploySha} mono />
                  <InfoRow label={t('items.detail.evidence.risks')} value={entry.risks} />
                  <InfoRow label={t('items.detail.evidence.uncheckedRisks')} value={entry.uncheckedRisks} />
                  <InfoRow label={t('items.detail.evidence.verifiedAt')} value={entry.verifiedAt ? formatDate(entry.verifiedAt, locale) : null} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Related items */}
      <div className="mb-4 md:mb-6 rounded-lg border border-gray-200 bg-white p-3 md:p-4">
        <div className="mb-3 flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-800">{t('items.detail.links.title')}</h3>
            <p className="text-xs text-gray-500">{t('items.detail.links.description')}</p>
          </div>
        </div>

        {item.relatedItems.length === 0 ? (
          <p className="text-sm text-gray-400">{t('items.detail.links.empty')}</p>
        ) : (
          <div className="space-y-2">
            {item.relatedItems.map((link) => (
              <div key={link.id} className="rounded-md border border-gray-200 bg-gray-50 p-3">
                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <button
                    type="button"
                    onClick={() => navigate(`/items/${link.item.id}`)}
                    className="min-w-0 text-left"
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-700">
                        {linkTypeLabels[link.type] ?? link.type}
                      </span>
                      <ItemTypeBadge itemType={link.item.itemType} />
                      <StatusBadge status={link.item.status} />
                      <PriorityBadge priority={link.item.priority} />
                      <span className="font-mono text-[11px] text-gray-400">#{link.item.id.slice(0, 8)}</span>
                    </div>
                    <div className="line-clamp-2 text-sm text-gray-800 hover:text-blue-700">
                      {link.item.message}
                    </div>
                  </button>
                  {item.permissions.canLinkItems && (
                    <button
                      type="button"
                      onClick={() => handleUnlinkItem(link.id)}
                      disabled={linkSaving}
                      className="shrink-0 text-xs text-gray-400 hover:text-red-600 disabled:opacity-50"
                    >
                      {t('items.detail.links.unlink')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {item.permissions.canLinkItems && (
          <form onSubmit={handleLinkItem} className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="mb-2">
              <label htmlFor="related-item-search" className="text-xs font-medium uppercase tracking-wide text-gray-500">
                {t('items.detail.links.choose')}
              </label>
              <input
                id="related-item-search"
                type="search"
                name="related-item-search"
                value={linkSearch}
                onChange={(e) => setLinkSearch(e.target.value)}
                placeholder={t('items.detail.links.searchPlaceholder')}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
              />
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_auto] md:items-center">
              <select
                name="related-item-target"
                aria-label={t('items.detail.links.choose')}
                value={linkTargetId}
                onChange={(e) => setLinkTargetId(e.target.value)}
                disabled={linkCandidatesLoading || linkCandidates.length === 0}
                className="min-w-0 rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-100 disabled:text-gray-400"
              >
                {linkCandidatesLoading ? (
                  <option value="">{t('common.loading')}</option>
                ) : linkCandidates.length === 0 ? (
                  <option value="">{t('items.detail.links.noCandidates')}</option>
                ) : (
                  linkCandidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      #{candidate.id.slice(0, 8)} · {t(`items.types.${candidate.itemType || 'bug'}`)} · {candidate.message}
                    </option>
                  ))
                )}
              </select>
              <select
                name="related-item-type"
                aria-label={t('items.detail.links.type')}
                value={linkType}
                onChange={(e) => setLinkType(e.target.value)}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
              >
                <option value="related">{t('items.detail.links.types.related')}</option>
                <option value="duplicate">{t('items.detail.links.types.duplicate')}</option>
                <option value="blocks">{t('items.detail.links.types.blocks')}</option>
                <option value="blocked_by">{t('items.detail.links.types.blocked_by')}</option>
                <option value="caused_by">{t('items.detail.links.types.caused_by')}</option>
                <option value="conflicts">{t('items.detail.links.types.conflicts')}</option>
              </select>
              <button
                type="submit"
                disabled={linkSaving || !linkTargetId.trim()}
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              >
                {linkSaving ? t('common.saving') : t('items.detail.links.add')}
              </button>
            </div>
            <p className="mt-2 text-xs text-gray-500">{t('items.detail.links.helper')}</p>
          </form>
        )}
      </div>

      {/* Session recording — full width with scroll on mobile */}
      {recordingUrl && (
        <div className="mb-4 md:mb-6 overflow-x-auto">
          <h3 className="mb-2 text-sm font-medium text-gray-700">
            {t('items.detail.recording')}
          </h3>
          {hasRecordingStats(recordingSummary) && (
            <div className="mb-3 grid grid-cols-2 gap-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs md:grid-cols-4">
              <InfoRow label={t('items.detail.debug.duration')} value={formatDurationMs(recordingSummary?.recordingDurationMs)} />
              <InfoRow label={t('items.detail.debug.eventCount')} value={String(recordingSummary?.eventCount ?? 0)} />
              <InfoRow label={t('items.detail.debug.firstTimestamp')} value={formatDebugTimestamp(recordingSummary?.firstTimestamp, locale)} />
              <InfoRow label={t('items.detail.debug.lastTimestamp')} value={formatDebugTimestamp(recordingSummary?.lastTimestamp, locale)} />
              <InfoRow label={t('items.detail.debug.eventCategories')} value={`${t('items.detail.debug.fullSnapshots')}: ${recordingSummary?.fullSnapshotCount ?? 0}, ${t('items.detail.debug.incrementalEvents')}: ${recordingSummary?.incrementalEventCount ?? 0}, ${t('items.detail.debug.importantEvents')}: ${recordingSummary?.importantEvents?.length ?? 0}`} />
            </div>
          )}
          <SessionPlayer recordingPath={recordingUrl} />
        </div>
      )}

      {/* Notes timeline — full width */}
      <div className="mb-4 md:mb-6" ref={notesRef}>
        <h3 className="mb-3 text-sm font-medium text-gray-700">{t('items.detail.notes.title')}</h3>
        <div className="space-y-3">
          {item.notes.length === 0 ? (
            <p className="text-sm text-gray-400">{t('items.detail.notes.empty')}</p>
          ) : (
            item.notes.map((note) => (
              <div
                key={note.id}
                className="rounded-lg border border-gray-200 bg-white p-3"
              >
                <div className="mb-1 flex flex-wrap items-center gap-1.5 md:gap-2 text-xs text-gray-500">
                  <span className="font-medium text-gray-700">
                    {note.userName ?? 'System'}
                  </span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                      noteTypeColors[note.type] ?? 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {noteTypeLabels[note.type] ?? note.type}
                  </span>
                  <span>{formatDate(note.createdAt, locale)}</span>
                </div>
                <div className="space-y-3 text-sm leading-6 text-gray-800 break-words">
                  {renderNoteContent(note.content)}
                </div>
              </div>
            ))
          )}
        </div>

        {item.permissions.canComment && (
          <form onSubmit={handleAddNote} className="mt-4">
            <textarea
              value={noteContent}
              onChange={(e) => setNoteContent(e.target.value)}
              placeholder={t('items.detail.notes.placeholder')}
              rows={3}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
            />
            <button
              type="submit"
              disabled={noteSaving || !noteContent.trim()}
              className="mt-2 w-full md:w-auto rounded-md bg-gray-900 px-4 py-2 md:py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {noteSaving ? t('items.detail.notes.sending') : t('items.detail.notes.send')}
            </button>
          </form>
        )}
      </div>

      {/* Review/done handoff modal — full screen on mobile, centered on desktop */}
      {showHandoffModal && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40">
          <div className="w-full md:max-w-2xl rounded-t-xl md:rounded-lg border border-gray-200 bg-white p-5 md:p-6 shadow-xl max-h-[90vh] overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="handoff-dialog-title">
            <h3 id="handoff-dialog-title" className="mb-4 text-lg font-semibold text-gray-900">
              {handoffStatus === 'done' ? t('items.detail.resolve.title') : t('items.detail.review.title')}
            </h3>
            <p className="mb-4 text-sm text-gray-500">{t('items.detail.evidence.requiredHint')}</p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <span className="text-sm font-medium text-gray-700">{t('items.detail.evidence.result')}</span>
                <div className="mt-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
                  {t('items.detail.evidence.results.pass')}
                </div>
              </div>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">{t('items.detail.evidence.level')} *</span>
                <select
                  value={evidenceDraft.level}
                  onChange={(e) => updateEvidenceField('level', e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  {evidenceLevels.map((level) => (
                    <option key={level} value={level}>{t(`items.detail.evidence.levels.${level}`)}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">{t('items.detail.evidence.environment')} *</span>
                <input
                  type="text"
                  value={evidenceDraft.environment}
                  onChange={(e) => updateEvidenceField('environment', e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  placeholder="staging"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">{t('items.detail.evidence.role')}</span>
                <input
                  type="text"
                  value={evidenceDraft.role}
                  onChange={(e) => updateEvidenceField('role', e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  placeholder="admin / dealer / reporter"
                />
              </label>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">
                  {t('items.detail.evidence.coverage')}{handoffStatus === 'done' ? ' *' : ''}
                </span>
                <select
                  value={evidenceDraft.coverage}
                  onChange={(e) => updateEvidenceField('coverage', e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  {(['item', 'shared_root_cluster', 'route_sweep', 'audit_sample'] as const).map((coverage) => (
                    <option key={coverage} value={coverage}>{t(`items.detail.evidence.coverageValues.${coverage}`)}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">{t('items.detail.evidence.source')}</span>
                <select
                  value={evidenceDraft.source}
                  onChange={(e) => updateEvidenceField('source', e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  {(['human', 'agent', 'ci', 'deploy', 'audit'] as const).map((source) => (
                    <option key={source} value={source}>{t(`items.detail.evidence.sources.${source}`)}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-3 block">
              <span className="text-sm font-medium text-gray-700">{t('items.detail.evidence.url')}</span>
              <input
                type="text"
                value={evidenceDraft.url}
                onChange={(e) => updateEvidenceField('url', e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="mt-3 block">
              <span className="text-sm font-medium text-gray-700">{t('items.detail.evidence.scenario')} *</span>
              <textarea
                value={evidenceDraft.scenario}
                onChange={(e) => updateEvidenceField('scenario', e.target.value)}
                rows={2}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="mt-3 block">
              <span className="text-sm font-medium text-gray-700">{t('items.detail.evidence.action')} *</span>
              <textarea
                value={evidenceDraft.action}
                onChange={(e) => updateEvidenceField('action', e.target.value)}
                rows={2}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="mt-3 block">
              <span className="text-sm font-medium text-gray-700">{t('items.detail.evidence.visibleResult')} *</span>
              <textarea
                value={evidenceDraft.visibleResult}
                onChange={(e) => updateEvidenceField('visibleResult', e.target.value)}
                rows={2}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              {(['consoleResult', 'networkResult', 'apiResult', 'dbResult', 'fixture', 'cleanupResult', 'commitSha', 'deploySha', 'acceptanceScope', 'risks', 'uncheckedRisks'] as Array<keyof EvidenceDraft>).map((field) => (
                <label key={field} className="block">
                  <span className="text-sm font-medium text-gray-700">
                    {t(`items.detail.evidence.${field}`)}{
                      (handoffStatus === 'done' && field === 'acceptanceScope')
                      || (handoffStatus === 'review' && field === 'commitSha')
                        ? ' *'
                        : ''
                    }
                  </span>
                  <textarea
                    value={evidenceDraft[field]}
                    onChange={(e) => updateEvidenceField(field, e.target.value)}
                    rows={field === 'risks' || field === 'uncheckedRisks' || field === 'acceptanceScope' ? 2 : 1}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </label>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">{t('items.detail.resolve.branch')}</span>
                <input
                  type="text"
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  placeholder="fix/issue-123"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">{t('items.detail.resolve.mrUrl')}</span>
                <input
                  type="url"
                  value={mrUrl}
                  onChange={(e) => setMrUrl(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  placeholder="https://gitlab.com/..."
                />
              </label>
            </div>
            {handoffStatus === 'done' && (
              <label className="mt-3 block">
                <span className="text-sm font-medium text-gray-700">
                  {t('items.detail.resolve.note')}
                </span>
                <textarea
                  value={resolutionNote}
                  onChange={(e) => setResolutionNote(e.target.value)}
                  rows={3}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
            )}
            {modalError && (
              <div className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {modalError}
              </div>
            )}
            <div className="mt-5 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
              <button
                onClick={() => { setShowHandoffModal(false); setModalError(''); }}
                className="w-full md:w-auto rounded-md border border-gray-300 px-4 py-2 md:py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleHandoff}
                disabled={actionLoading || !evidenceReady}
                className="w-full md:w-auto rounded-md bg-green-600 px-4 py-2 md:py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {actionLoading ? t('items.detail.resolve.saving') : (handoffStatus === 'done' ? t('items.detail.resolve.submit') : t('items.detail.review.submit'))}
              </button>
            </div>
          </div>
        </div>
      )}

      {showVerifyModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center">
          <div className="w-full rounded-t-xl border border-gray-200 bg-white p-5 shadow-xl md:max-w-lg md:rounded-lg md:p-6" role="dialog" aria-modal="true" aria-labelledby="verify-dialog-title">
            <h3 id="verify-dialog-title" className="text-lg font-semibold text-gray-900">{t('items.detail.verify.title')}</h3>
            <p className="mt-1 text-sm text-gray-500">{t('items.detail.verify.description')}</p>
            <label className="mt-4 block">
              <span className="text-sm font-medium text-gray-700">{t('items.detail.verify.comment')}</span>
              <textarea
                name="verify-comment"
                value={verifyComment}
                onChange={(e) => setVerifyComment(e.target.value)}
                rows={4}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                placeholder={t('items.detail.verify.commentPlaceholder')}
              />
            </label>
            {modalError && (
              <div className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {modalError}
              </div>
            )}
            <div className="mt-5 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
              <button
                type="button"
                onClick={() => { setShowVerifyModal(false); setModalError(''); }}
                className="w-full rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 md:w-auto md:py-1.5"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleVerify}
                disabled={actionLoading}
                className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50 md:w-auto md:py-1.5"
              >
                {actionLoading ? t('common.saving') : t('items.detail.verify.submit')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showChangesModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center">
          <div className="w-full rounded-t-xl border border-gray-200 bg-white p-5 shadow-xl md:max-w-2xl md:rounded-lg md:p-6" role="dialog" aria-modal="true" aria-labelledby="changes-dialog-title">
            <h3 id="changes-dialog-title" className="text-lg font-semibold text-gray-900">{t('items.detail.requestChanges.title')}</h3>
            <p className="mt-1 text-sm text-gray-500">{t('items.detail.requestChanges.description')}</p>
            <div className="mt-4 grid gap-3">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">{t('items.detail.requestChanges.summary')} *</span>
                <textarea
                  name="request-changes-summary"
                  value={changeRequest.summary}
                  onChange={(e) => updateChangeRequestField('summary', e.target.value)}
                  rows={2}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  placeholder={t('items.detail.requestChanges.summaryPlaceholder')}
                />
              </label>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="text-sm font-medium text-gray-700">{t('items.detail.requestChanges.expected')} *</span>
                  <textarea
                    name="request-changes-expected"
                    value={changeRequest.expected}
                    onChange={(e) => updateChangeRequestField('expected', e.target.value)}
                    rows={3}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-gray-700">{t('items.detail.requestChanges.actual')} *</span>
                  <textarea
                    name="request-changes-actual"
                    value={changeRequest.actual}
                    onChange={(e) => updateChangeRequestField('actual', e.target.value)}
                    rows={3}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">{t('items.detail.requestChanges.steps')}</span>
                <textarea
                  name="request-changes-steps"
                  value={changeRequest.steps}
                  onChange={(e) => updateChangeRequestField('steps', e.target.value)}
                  rows={3}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">{t('items.detail.requestChanges.url')}</span>
                <input
                  type="url"
                  name="request-changes-url"
                  value={changeRequest.url}
                  onChange={(e) => updateChangeRequestField('url', e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  placeholder="https://example.com/path"
                />
              </label>
            </div>
            {modalError && (
              <div className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {modalError}
              </div>
            )}
            <div className="mt-5 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
              <button
                type="button"
                onClick={() => { setShowChangesModal(false); setModalError(''); }}
                className="w-full rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 md:w-auto md:py-1.5"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleRequestChanges}
                disabled={actionLoading || !changeRequestReady}
                className="w-full rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 md:w-auto md:py-1.5"
              >
                {actionLoading ? t('common.saving') : t('items.detail.requestChanges.submit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function splitItemMessage(message: string) {
  const [firstLine = '', ...rest] = message.split(/\r?\n/);
  const title = firstLine.trim() || message.trim();
  const details = rest
    .filter((line) => !isRuntimeMachineLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, details };
}

function isRuntimeMachineLine(line: string) {
  const normalized = line.trim().toLowerCase();
  if (!normalized) return false;
  return [
    'fingerprint:',
    'environment:',
    'service:',
    'error type:',
    'route:',
    'upstream:',
    'request id:',
    'trace id:',
  ].some((prefix) => normalized.startsWith(prefix));
}

function InfoRow({
  label,
  value,
  mono,
  link,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  link?: boolean;
}) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs font-medium text-gray-500">{label}</dt>
      <dd
        className={`mt-0.5 text-sm text-gray-800 break-all ${mono ? 'font-mono' : ''}`}
      >
        {link ? (
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
