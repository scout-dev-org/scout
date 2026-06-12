import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation, type Locale } from '../i18n';
import { formatDate } from '../lib/date';

export interface ErrorGroupCardData {
  id: string;
  fingerprint: string;
  environment: string;
  service: string;
  routeTemplate: string | null;
  method: string | null;
  upstreamService: string | null;
  errorType: string;
  statusCode: number | null;
  statusClass: string | null;
  severity: 'info' | 'warning' | 'critical';
  state: 'active' | 'ignored' | 'resolved';
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  linkedItemId?: string | null;
  linkedItemMessage?: string | null;
  sampleRequestId: string | null;
  sampleTraceId: string | null;
  grafanaLogsUrl: string | null;
  grafanaTraceUrl: string | null;
  lastRelease?: string | null;
}

interface ErrorGroupCardProps {
  group: ErrorGroupCardData;
  actions?: ReactNode;
  showLinkedItem?: boolean;
}

function severityClass(severity: ErrorGroupCardData['severity']) {
  if (severity === 'critical') return 'bg-red-100 text-red-800';
  if (severity === 'warning') return 'bg-yellow-100 text-yellow-800';
  return 'bg-blue-100 text-blue-800';
}

function stateClass(state: ErrorGroupCardData['state']) {
  if (state === 'active') return 'bg-orange-100 text-orange-800';
  if (state === 'ignored') return 'bg-gray-100 text-gray-700';
  return 'bg-green-100 text-green-800';
}

function SummaryRow({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="rounded-md bg-gray-50 px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-0.5 break-words text-sm text-gray-900 ${mono ? 'font-mono text-xs' : ''}`}>{value}</div>
    </div>
  );
}

function formatOccurrenceCount(count: number, locale: Locale) {
  if (locale === 'ru') {
    const mod10 = count % 10;
    const mod100 = count % 100;
    const word = mod10 === 1 && mod100 !== 11
      ? 'срабатывание'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'срабатывания'
        : 'срабатываний';
    return `${count} ${word}`;
  }

  if (locale === 'en') return `${count} occurrence${count === 1 ? '' : 's'}`;
  return `${count} takrorlanish`;
}

function firstMessageLine(message: string | null | undefined) {
  return message?.split(/\r?\n/)[0]?.trim();
}

export default function ErrorGroupCard({ group, actions, showLinkedItem = false }: ErrorGroupCardProps) {
  const { t, locale } = useTranslation();
  const route = group.routeTemplate ? `${group.method || '*'} ${group.routeTemplate}` : t('errors.fields.noRoute');
  const status = group.statusCode
    ? t('errors.summary.httpStatus', { status: String(group.statusCode) })
    : group.statusClass
      ? t('errors.summary.statusClass', { statusClass: group.statusClass })
      : t('errors.summary.statusMissing');
  const impact = t('errors.summary.impactValue', {
    count: formatOccurrenceCount(group.occurrenceCount, locale),
    lastSeen: formatDate(group.lastSeenAt, locale),
  });
  const firstSeen = formatDate(group.firstSeenAt, locale);

  return (
    <div className="rounded-md border border-gray-200 bg-white p-3 text-sm shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${severityClass(group.severity)}`}>{t(`errors.severities.${group.severity}`)}</span>
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${stateClass(group.state)}`}>{t(`errors.states.${group.state}`)}</span>
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">{group.environment}</span>
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">{group.service}</span>
          </div>
          <div className="text-base font-semibold text-gray-900">{group.errorType}</div>
          <p className="mt-1 text-xs text-gray-500">{t('errors.summary.cardHint')}</p>
        </div>
        {actions}
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <SummaryRow label={t('errors.summary.where')} value={route} mono={Boolean(group.routeTemplate)} />
        <SummaryRow label={t('errors.summary.impact')} value={impact} />
        <SummaryRow label={t('errors.summary.status')} value={status} />
        <SummaryRow label={t('errors.fields.firstSeen')} value={firstSeen} />
        <SummaryRow label={t('errors.fields.requestId')} value={group.sampleRequestId} mono />
        <SummaryRow label={t('errors.fields.traceId')} value={group.sampleTraceId} mono />
        <SummaryRow label={t('errors.summary.upstream')} value={group.upstreamService} />
        <SummaryRow label={t('errors.summary.release')} value={group.lastRelease} mono />
      </div>

      <div className="mt-3 rounded-md border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        {t('errors.summary.lookupHint')}
      </div>

      {showLinkedItem && group.linkedItemId && (
        <Link to={`/items/${group.linkedItemId}`} className="mt-3 inline-flex text-xs font-medium text-blue-600 hover:underline">
          {t('errors.fields.linkedItem')}: {firstMessageLine(group.linkedItemMessage) || `#${group.linkedItemId.slice(0, 8)}`}
        </Link>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {group.grafanaLogsUrl && <a href={group.grafanaLogsUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-blue-600 hover:underline">{t('errors.links.logs')}</a>}
        {group.grafanaTraceUrl && <a href={group.grafanaTraceUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-blue-600 hover:underline">{t('errors.links.trace')}</a>}
      </div>

      <details className="mt-3 text-xs text-gray-600">
        <summary className="cursor-pointer font-medium text-gray-700">{t('errors.summary.technicalDetails')}</summary>
        <div className="mt-2 grid gap-1 md:grid-cols-2">
          <span className="font-mono break-all">{t('errors.fields.fingerprint')}: {group.fingerprint}</span>
          <span>{t('errors.fields.lastSeen')}: {formatDate(group.lastSeenAt, locale)}</span>
        </div>
      </details>
    </div>
  );
}
