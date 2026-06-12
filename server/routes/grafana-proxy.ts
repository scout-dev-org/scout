import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { UnauthorizedError } from '../lib/errors.js';
import { verifyToken } from '../services/auth.js';

const SCOUT_SESSION_COOKIE = 'scout_session';
const PROXY_PREFIX = '/grafana';

function getProxyTarget(): URL | null {
  const raw = process.env.SCOUT_GRAFANA_PROXY_TARGET?.trim() || process.env.SCOUT_GRAFANA_INTERNAL_URL?.trim();
  if (!raw) return null;
  try {
    const target = new URL(raw.endsWith('/') ? raw : `${raw}/`);
    return target.protocol === 'http:' || target.protocol === 'https:' ? target : null;
  } catch {
    return null;
  }
}

function extractToken(c: Context): string | null {
  const header = c.req.header('Authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return c.req.query('token') ?? getCookie(c, SCOUT_SESSION_COOKIE) ?? null;
}

function buildUpstreamUrl(requestUrl: string, targetBase: URL): URL {
  const source = new URL(requestUrl);
  const stripPrefix = process.env.SCOUT_GRAFANA_PROXY_STRIP_PREFIX === 'true';
  const path = !stripPrefix
    ? source.pathname
    : source.pathname === PROXY_PREFIX
    ? '/'
    : source.pathname.startsWith(`${PROXY_PREFIX}/`)
      ? source.pathname.slice(PROXY_PREFIX.length)
      : source.pathname;
  const upstream = new URL(path || '/', targetBase);
  upstream.search = source.search;
  upstream.searchParams.delete('token');
  return upstream;
}

function copyRequestHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete('host');
  headers.delete('cookie');
  headers.delete('authorization');
  headers.delete('content-length');
  headers.delete('accept-encoding');
  return headers;
}

function copyResponseHeaders(source: Headers, targetBase: URL): Headers {
  const headers = new Headers(source);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('transfer-encoding');

  const location = headers.get('location');
  if (location) {
    try {
      const parsed = new URL(location, targetBase);
      if (parsed.origin === targetBase.origin) {
        headers.set('location', `${PROXY_PREFIX}${parsed.pathname}${parsed.search}${parsed.hash}`);
      }
    } catch {
      if (location.startsWith('/')) headers.set('location', `${PROXY_PREFIX}${location}`);
    }
  }

  return headers;
}

export const grafanaProxyRoutes = new Hono()
  .use('*', async (c, next) => {
    const token = extractToken(c);
    if (!token) throw new UnauthorizedError('Missing authentication', 'UNAUTHORIZED');

    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      throw new UnauthorizedError('Invalid or expired token', 'TOKEN_EXPIRED');
    }

    const user = db.select().from(users).where(eq(users.id, payload.userId)).get();
    if (!user || !user.isActive) throw new UnauthorizedError('User not found or inactive', 'USER_INACTIVE');
    await next();
  })
  .all('/', async (c) => proxyGrafana(c))
  .all('/*', async (c) => proxyGrafana(c));

async function proxyGrafana(c: Context): Promise<Response> {
  const targetBase = getProxyTarget();
  if (!targetBase) return c.text('Grafana proxy is not configured', 503);

  const upstreamUrl = buildUpstreamUrl(c.req.url, targetBase);
  const method = c.req.method;
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: copyRequestHeaders(c.req.raw.headers),
    redirect: 'manual',
  };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = c.req.raw.body;
    init.duplex = 'half';
  }

  const upstream = await fetch(upstreamUrl, init);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: copyResponseHeaders(upstream.headers, targetBase),
  });
}
