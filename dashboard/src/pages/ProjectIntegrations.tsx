import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../lib/api';
import { useTranslation } from '../i18n';

interface ProjectRaw {
  id: string;
  name: string;
  slug: string;
  allowedOrigins: string;
  isActive: boolean;
}

interface Project extends Omit<ProjectRaw, 'allowedOrigins'> {
  allowedOrigins: string[];
}

interface ApiKeyItem {
  id: string;
  name: string;
  purpose: 'agent' | 'ci' | 'integration' | 'custom';
  scopes: string[];
  keyPrefix: string;
  userName: string | null;
  isActive: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const AGENT_SCOPES = ['items:read', 'items:comment', 'items:workflow', 'items:triage', 'storage:read'];

function parseProject(project: ProjectRaw): Project {
  let allowedOrigins: string[] = [];
  try {
    allowedOrigins = JSON.parse(project.allowedOrigins) as string[];
  } catch {
    allowedOrigins = [];
  }
  return { ...project, allowedOrigins };
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export default function ProjectIntegrations() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const [project, setProject] = useState<Project | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');
  const [expiresIn, setExpiresIn] = useState('90');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const widgetCode = project
    ? `<script>\n  window.__SCOUT_CONFIG__ = {\n    apiUrl: '${window.location.origin}',\n    projectSlug: '${project.slug}',\n  };\n</script>\n<script src="${window.location.origin}/widget/scout-widget.js" async></script>`
    : '';

  const envBlock = project && createdKey
    ? `export SCOUT_URL="${window.location.origin}"\nexport SCOUT_PROJECT_SLUG="${project.slug}"\nexport SCOUT_API_KEY="${createdKey}"`
    : '';

  async function copyText(text: string, idToMark: string) {
    const fallbackCopy = () => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    };

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
    setCopiedId(idToMark);
    window.setTimeout(() => setCopiedId(null), 1800);
  }

  async function loadData() {
    if (!id) return;
    setLoading(true);
    try {
      const [projectRes, keysRes] = await Promise.all([
        api<ProjectRaw>('/api/projects/get', { id }),
        api<{ items: ApiKeyItem[] }>('/api/api-keys/list', { projectId: id }),
      ]);
      setProject(parseProject(projectRes));
      setApiKeys(keysRes.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('validation.requestError'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, [id]);

  async function createAgentKey(event: FormEvent) {
    event.preventDefault();
    if (!project) return;
    setSaving(true);
    setError('');
    setCreatedKey(null);
    try {
      const expiresAt = expiresIn === 'never'
        ? undefined
        : addDays(new Date(), Number(expiresIn)).toISOString();
      const res = await api<{ key: string }>('/api/api-keys/create', {
        projectId: project.id,
        name: keyName.trim() || `${project.slug} agent`,
        purpose: 'agent',
        scopes: AGENT_SCOPES,
        expiresAt,
      });
      setCreatedKey(res.key);
      setKeyName('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('validation.saveError'));
    } finally {
      setSaving(false);
    }
  }

  async function revokeKey(key: ApiKeyItem) {
    if (!confirm(t('integrations.apiKeys.revokeConfirm'))) return;
    setBusyKeyId(key.id);
    try {
      await api('/api/api-keys/revoke', { id: key.id });
      await loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : t('validation.deleteError'));
    } finally {
      setBusyKeyId(null);
    }
  }

  if (loading) {
    return <div className="p-4 md:p-6 text-sm text-gray-500">{t('common.loading')}</div>;
  }

  if (!project) {
    return <div className="p-4 md:p-6 text-sm text-red-600">{error || t('errors.PROJECT_NOT_FOUND')}</div>;
  }

  return (
    <div className="p-4 md:p-6">
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <Link to="/projects" className="text-sm font-medium text-blue-600 hover:underline">
            {t('integrations.backToProjects')}
          </Link>
          <h1 className="mt-2 text-xl font-bold text-gray-900">{t('integrations.title')}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {project.name} · <span className="font-mono">{project.slug}</span>
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-gray-900">{t('integrations.widget.title')}</h2>
              <p className="mt-1 text-sm text-gray-500">{t('integrations.widget.description')}</p>
            </div>
            <button
              type="button"
              onClick={() => copyText(widgetCode, 'widget')}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              {copiedId === 'widget' ? t('common.copied') : t('integrations.widget.copy')}
            </button>
          </div>
          <pre className="mt-4 max-h-72 overflow-auto rounded-md bg-gray-950 p-3 text-xs leading-relaxed text-gray-100"><code>{widgetCode}</code></pre>
          <div className="mt-4 rounded-md bg-gray-50 p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{t('integrations.widget.origins')}</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {project.allowedOrigins.length === 0 ? (
                <span className="text-sm text-gray-400">{t('common.noData')}</span>
              ) : project.allowedOrigins.map((origin) => (
                <span key={origin} className="rounded bg-white px-2 py-1 text-xs font-mono text-gray-600 ring-1 ring-gray-200">{origin}</span>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{t('integrations.apiKeys.title')}</h2>
            <p className="mt-1 text-sm text-gray-500">{t('integrations.apiKeys.description')}</p>
          </div>

          {createdKey && (
            <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3">
              <div className="text-sm font-semibold text-green-900">{t('integrations.apiKeys.createdTitle')}</div>
              <p className="mt-1 text-xs text-green-800">{t('integrations.apiKeys.createdWarning')}</p>
              <pre className="mt-3 overflow-auto rounded-md bg-white p-3 text-xs text-gray-800 ring-1 ring-green-200"><code>{createdKey}</code></pre>
              <pre className="mt-2 overflow-auto rounded-md bg-gray-950 p-3 text-xs leading-relaxed text-gray-100"><code>{envBlock}</code></pre>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => copyText(createdKey, 'created-key')}
                  className="rounded-md border border-green-300 px-3 py-1.5 text-sm font-medium text-green-900 hover:bg-green-100"
                >
                  {copiedId === 'created-key' ? t('common.copied') : t('integrations.apiKeys.copyKey')}
                </button>
                <button
                  type="button"
                  onClick={() => copyText(envBlock, 'env-block')}
                  className="rounded-md border border-green-300 px-3 py-1.5 text-sm font-medium text-green-900 hover:bg-green-100"
                >
                  {copiedId === 'env-block' ? t('common.copied') : t('integrations.apiKeys.copyEnv')}
                </button>
              </div>
            </div>
          )}

          <form onSubmit={createAgentKey} className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="text-sm font-semibold text-gray-900">{t('integrations.apiKeys.createAgent')}</div>
            <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto_auto]">
              <label className="block">
                <span className="text-xs font-medium text-gray-600">{t('integrations.apiKeys.name')}</span>
                <input
                  type="text"
                  name="api-key-name"
                  value={keyName}
                  onChange={(event) => setKeyName(event.target.value)}
                  placeholder={`${project.slug} agent`}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">{t('integrations.apiKeys.expires')}</span>
                <select
                  name="api-key-expiry"
                  value={expiresIn}
                  onChange={(event) => setExpiresIn(event.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="30">{t('integrations.apiKeys.expiry.30')}</option>
                  <option value="90">{t('integrations.apiKeys.expiry.90')}</option>
                  <option value="365">{t('integrations.apiKeys.expiry.365')}</option>
                  <option value="never">{t('integrations.apiKeys.expiry.never')}</option>
                </select>
              </label>
              <button
                type="submit"
                disabled={saving}
                className="self-end rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              >
                {saving ? t('common.saving') : t('integrations.apiKeys.create')}
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {AGENT_SCOPES.map((scope) => (
                <span key={scope} className="rounded bg-white px-2 py-1 text-xs font-mono text-gray-600 ring-1 ring-gray-200">{scope}</span>
              ))}
            </div>
          </form>

          <div className="mt-4 overflow-hidden rounded-lg border border-gray-200">
            <div className="border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
              {t('integrations.apiKeys.existing')}
            </div>
            {apiKeys.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-gray-400">{t('integrations.apiKeys.empty')}</div>
            ) : (
              <div className="divide-y divide-gray-100">
                {apiKeys.map((key) => (
                  <div key={key.id} className="p-3">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-gray-900">{key.name}</span>
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-600">{t(`integrations.apiKeys.purposes.${key.purpose}`)}</span>
                          {key.isActive ? (
                            <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">{t('common.active')}</span>
                          ) : (
                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">{t('integrations.apiKeys.revoked')}</span>
                          )}
                        </div>
                        <div className="mt-1 font-mono text-xs text-gray-500">{key.keyPrefix}...</div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {key.scopes.map((scope) => (
                            <span key={scope} className="rounded bg-gray-50 px-1.5 py-0.5 text-[10px] font-mono text-gray-500 ring-1 ring-gray-200">{scope}</span>
                          ))}
                        </div>
                        <div className="mt-2 text-xs text-gray-500">
                          {t('integrations.apiKeys.createdBy')}: {key.userName || '—'} · {t('integrations.apiKeys.lastUsed')}: {key.lastUsedAt || t('common.never')} · {t('integrations.apiKeys.expires')}: {key.expiresAt || t('common.never')}
                        </div>
                      </div>
                      {key.isActive && (
                        <button
                          type="button"
                          onClick={() => revokeKey(key)}
                          disabled={busyKeyId === key.id}
                          className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          {t('integrations.apiKeys.revoke')}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
