import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation, type I18nContextValue, type Locale } from '../i18n';
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
  samplePayload?: string | null;
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

type Translate = I18nContextValue['t'];
type JsonObject = Record<string, unknown>;

interface GatewayDiagnostics {
  request: JsonObject | null;
  upstreamResponse: JsonObject | null;
  gatewayResponse: JsonObject | null;
  rawPayload: unknown;
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function prettyJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function parseDiagnosticObject(value: unknown): JsonObject | null {
  const parsed = typeof value === 'string' ? parseJson(value) : value;
  return isRecord(parsed) ? parsed : null;
}

function objectField(source: JsonObject | null | undefined, key: string): JsonObject | null {
  const value = source?.[key];
  return isRecord(value) ? value : null;
}

function stringField(source: JsonObject | null | undefined, key: string): string | null {
  const value = source?.[key];
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function booleanField(source: JsonObject | null | undefined, key: string): boolean | null {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : null;
}

function hasRenderableValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function extractEscapedDiagnosticAttribute(rawText: string, attribute: string): JsonObject | null {
  const marker = `"${attribute}":"`;
  const start = rawText.indexOf(marker);
  if (start === -1) return null;

  let escaped = '';
  for (let index = start + marker.length; index < rawText.length; index += 1) {
    const char = rawText[index];
    if (char === '\\') {
      const next = rawText[index + 1];
      if (!next) return null;
      escaped += char + next;
      index += 1;
      continue;
    }
    if (char === '"') {
      const unescaped = parseJson(`"${escaped}"`);
      return parseDiagnosticObject(unescaped);
    }
    escaped += char;
  }

  return null;
}

function diagnosticFromPayload(payload: unknown, rawText: string | null, name: string): JsonObject | null {
  if (isRecord(payload)) {
    const direct = parseDiagnosticObject(payload[name]) ?? parseDiagnosticObject(objectField(payload, 'diagnostics')?.[name]);
    if (direct) return direct;
  }

  return rawText ? extractEscapedDiagnosticAttribute(rawText, `gateway.diagnostic.${name}`) : null;
}

function buildGatewayDiagnostics(samplePayload: string | null | undefined): GatewayDiagnostics | null {
  const rawText = samplePayload?.trim();
  if (!rawText) return null;

  const parsed = parseJson(rawText);
  return {
    request: diagnosticFromPayload(parsed, rawText, 'request'),
    upstreamResponse: diagnosticFromPayload(parsed, rawText, 'upstream_response'),
    gatewayResponse: diagnosticFromPayload(parsed, rawText, 'gateway_response'),
    rawPayload: parsed ?? rawText,
  };
}

function decodeBase64(value: string): string | null {
  try {
    const binary = window.atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

function bodyText(body: unknown): string | null {
  if (typeof body === 'string') return body;
  if (!isRecord(body)) return hasRenderableValue(body) ? prettyJson(body) : null;

  const value = body.value;
  if (typeof value === 'string') {
    return stringField(body, 'encoding') === 'base64' ? decodeBase64(value) ?? value : value;
  }
  if (value !== undefined) return prettyJson(value);
  return null;
}

function bodyDisplayValue(body: unknown): unknown | null {
  const decoded = bodyText(body);
  if (decoded === null) return null;
  return parseJson(decoded) ?? decoded;
}

function formatBytes(value: unknown, locale: Locale): string | null {
  const bytes = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(bytes)) return null;

  const units = ['B', 'KB', 'MB'] as const;
  let amount = bytes;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }

  const maximumFractionDigits = unitIndex === 0 || amount >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits }).format(amount)} ${units[unitIndex]}`;
}

function CodeBlock({ value }: { value: unknown }) {
  return (
    <pre className="mt-1 max-h-80 overflow-auto rounded-md border border-gray-200 bg-gray-950 px-3 py-2 text-[11px] leading-relaxed text-gray-100 shadow-inner">
      <code>{prettyJson(value)}</code>
    </pre>
  );
}

function DiagnosticPill({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="min-w-0 rounded-md border border-gray-200 bg-white px-3 py-2 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-0.5 break-words font-mono text-xs text-gray-900">{value}</div>
    </div>
  );
}

function DiagnosticJsonField({ label, value }: { label: string; value: unknown }) {
  if (!hasRenderableValue(value)) return null;
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <CodeBlock value={value} />
    </div>
  );
}

function DiagnosticBody({ body, locale, t }: { body: unknown; locale: Locale; t: Translate }) {
  if (!hasRenderableValue(body)) return null;

  const record = isRecord(body) ? body : null;
  const decoded = bodyDisplayValue(body);
  const meta = [
    { label: t('errors.diagnostics.type'), value: stringField(record, 'type') },
    { label: t('errors.diagnostics.encoding'), value: stringField(record, 'encoding') },
    { label: t('errors.diagnostics.size'), value: formatBytes(record?.size_bytes, locale) },
    { label: t('errors.diagnostics.captured'), value: formatBytes(record?.captured_bytes, locale) },
    {
      label: t('errors.diagnostics.truncated'),
      value: booleanField(record, 'truncated') === null
        ? null
        : t(booleanField(record, 'truncated') ? 'errors.diagnostics.yes' : 'errors.diagnostics.no'),
    },
  ].filter((item) => item.value);

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{t('errors.diagnostics.body')}</div>
      {meta.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {meta.map((item) => (
            <span key={item.label} className="rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-700">
              {item.label}: <span className="font-medium text-gray-900">{item.value}</span>
            </span>
          ))}
        </div>
      )}
      {decoded !== null && decoded !== '' ? <CodeBlock value={decoded} /> : <div className="mt-1 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">{t('errors.diagnostics.emptyBody')}</div>}
    </div>
  );
}

function DiagnosticPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-700">{title}</h4>
      <div className="mt-2 space-y-3">{children}</div>
    </section>
  );
}

function RequestDiagnostics({ request, locale, t }: { request: JsonObject; locale: Locale; t: Translate }) {
  return (
    <DiagnosticPanel title={t('errors.diagnostics.request')}>
      <div className="grid gap-2 sm:grid-cols-2">
        <DiagnosticPill label={t('errors.diagnostics.method')} value={stringField(request, 'method')} />
        <DiagnosticPill label={t('errors.diagnostics.path')} value={stringField(request, 'path')} />
        <DiagnosticPill label={t('errors.diagnostics.originalUrl')} value={stringField(request, 'original_url')} />
        <DiagnosticPill label={t('errors.diagnostics.currentUrl')} value={stringField(request, 'current_url')} />
        <DiagnosticPill label={t('errors.diagnostics.upstreamUrl')} value={stringField(request, 'upstream_url')} />
      </div>
      <DiagnosticJsonField label={t('errors.diagnostics.query')} value={request.query} />
      <DiagnosticJsonField label={t('errors.diagnostics.headers')} value={request.headers} />
      <DiagnosticBody body={request.body} locale={locale} t={t} />
    </DiagnosticPanel>
  );
}

function ResponseDiagnostics({ title, response, locale, t }: { title: string; response: JsonObject; locale: Locale; t: Translate }) {
  return (
    <DiagnosticPanel title={title}>
      <div className="grid gap-2 sm:grid-cols-2">
        <DiagnosticPill label={t('errors.diagnostics.statusCode')} value={stringField(response, 'status_code')} />
      </div>
      <DiagnosticJsonField label={t('errors.diagnostics.headers')} value={response.headers} />
      <DiagnosticBody body={response.body} locale={locale} t={t} />
    </DiagnosticPanel>
  );
}

function GatewayDiagnosticsViewer({ group, diagnostics, locale, t }: { group: ErrorGroupCardData; diagnostics: GatewayDiagnostics; locale: Locale; t: Translate }) {
  const responseStatus = stringField(diagnostics.upstreamResponse, 'status_code')
    ?? stringField(diagnostics.gatewayResponse, 'status_code')
    ?? (group.statusCode ? String(group.statusCode) : null);

  return (
    <details open className="mt-3 rounded-lg border border-slate-200 bg-slate-50/80 p-3 text-xs text-slate-800">
      <summary className="cursor-pointer list-none font-semibold text-slate-900 marker:hidden">
        <span className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <span>{t('errors.diagnostics.title')}</span>
          <span className="font-normal text-slate-500">{t('errors.diagnostics.subtitle')}</span>
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <DiagnosticPill label={t('errors.diagnostics.method')} value={stringField(diagnostics.request, 'method') ?? group.method} />
          <DiagnosticPill label={t('errors.diagnostics.path')} value={stringField(diagnostics.request, 'path') ?? group.routeTemplate} />
          <DiagnosticPill label={t('errors.diagnostics.statusCode')} value={responseStatus} />
          <DiagnosticPill label={t('errors.diagnostics.upstreamUrl')} value={stringField(diagnostics.request, 'upstream_url') ?? group.upstreamService} />
        </div>

        {diagnostics.request && <RequestDiagnostics request={diagnostics.request} locale={locale} t={t} />}
        {diagnostics.upstreamResponse && <ResponseDiagnostics title={t('errors.diagnostics.upstreamResponse')} response={diagnostics.upstreamResponse} locale={locale} t={t} />}
        {diagnostics.gatewayResponse && <ResponseDiagnostics title={t('errors.diagnostics.gatewayResponse')} response={diagnostics.gatewayResponse} locale={locale} t={t} />}

        <details className="rounded-md border border-dashed border-slate-300 bg-white/70 p-2">
          <summary className="cursor-pointer font-medium text-slate-700">{t('errors.diagnostics.rawPayload')}</summary>
          <CodeBlock value={diagnostics.rawPayload} />
        </details>
      </div>
    </details>
  );
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
  const diagnostics = buildGatewayDiagnostics(group.samplePayload);
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

      {diagnostics && <GatewayDiagnosticsViewer group={group} diagnostics={diagnostics} locale={locale} t={t} />}

      {showLinkedItem && group.linkedItemId && (
        <Link to={`/items/${group.linkedItemId}`} className="mt-3 inline-flex text-xs font-medium text-blue-600 hover:underline">
          {t('errors.fields.linkedItem')}: {firstMessageLine(group.linkedItemMessage) || `#${group.linkedItemId.slice(0, 8)}`}
        </Link>
      )}

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
