import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { HTTPException } from 'hono/http-exception';
import { readFileSync } from 'node:fs';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { userRoutes } from './routes/users.js';
import { itemRoutes } from './routes/items.js';
import { webhookRoutes } from './routes/webhooks.js';
import { notificationRoutes } from './routes/notifications.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { integrationsErrorsRoutes } from './routes/integrations-errors.js';
import { grafanaProxyRoutes } from './routes/grafana-proxy.js';
import { startBridgeWorker } from './services/error-groups.js';
import { startDailyDigestWorker } from './services/email-digest.js';
import { eventRoutes } from './routes/events.js';
import { docsRoutes } from './routes/docs.js';
import { db, sqlite } from './db/client.js';
import { projects, scoutItems } from './db/schema.js';
import { eq, or } from 'drizzle-orm';
import { securityHeaders } from './middleware/security-headers.js';
import { rateLimit } from './middleware/rate-limit.js';
import { authMiddleware, storageAuth } from './middleware/auth.js';
import { checkProjectAccess } from './middleware/permissions.js';
import { logger } from './lib/logger.js';
import { normalizeOrigin } from './lib/origins.js';

const app = new Hono();

// Security headers on ALL responses
app.use('*', securityHeaders);

// Structured request logging via pino
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  logger.info({
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration,
  }, 'request');
});

// Deep health check (for Docker, monitoring)
app.get('/health', (c) => {
  try {
    // Check DB connectivity
    const dbCheck = sqlite.prepare('SELECT 1 as ok').get() as { ok: number } | undefined;

    const mem = process.memoryUsage();

    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      db: dbCheck?.ok === 1 ? 'ok' : 'error',
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      },
    });
  } catch (err) {
    logger.error({ err }, 'Health check failed');
    return c.json({ status: 'error', error: String(err) }, 503);
  }
});

app.get('/api/dashboard-config', (c) => {
  const dashboardWidgetProjectSlug = process.env.SCOUT_DASHBOARD_WIDGET_PROJECT_SLUG?.trim();

  return c.json({
    data: {
      dashboardWidget: dashboardWidgetProjectSlug
        ? { projectSlug: dashboardWidgetProjectSlug }
        : null,
    },
  });
});

// --- CORS ---
const isProduction = process.env.NODE_ENV === 'production';
const corsOrigins = (process.env.SCOUT_CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((origin) => {
    try { return normalizeOrigin(origin); } catch { logger.warn({ origin }, 'Skipping invalid CORS origin'); return null; }
  })
  .filter((origin): origin is string => origin !== null);

// Cache of all allowed origins: env var + project allowedOrigins from DB (refreshed every 60s)
let cachedOrigins: Set<string> = new Set();
let cacheExpiry = 0;

function getAllowedOrigins(): Set<string> {
  const now = Date.now();
  if (now < cacheExpiry) return cachedOrigins;

  const origins = new Set<string>();
  // Add env var origins
  for (const o of corsOrigins) origins.add(o);
  // Add project origins from DB
  try {
    const allProjects = db.select({ allowedOrigins: projects.allowedOrigins })
      .from(projects)
      .where(eq(projects.isActive, true))
      .all();
    for (const p of allProjects) {
      try {
        const arr: string[] = JSON.parse(p.allowedOrigins);
        for (const o of arr) {
          try { origins.add(normalizeOrigin(o)); } catch { /* skip invalid origin */ }
        }
      } catch { /* skip malformed JSON */ }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load project origins for CORS');
  }

  cachedOrigins = origins;
  cacheExpiry = now + 60_000; // Cache for 60s
  return origins;
}

app.use('/api/*', cors({
  origin: (origin) => {
    // Same-origin requests (no Origin header) — always allowed
    if (!origin) return origin;
    // In dev allow all origins
    if (!isProduction) return origin;
    // In production: check env whitelist + project DB origins
    const allowed = getAllowedOrigins();
    if (allowed.has(origin)) return origin;
    // Reject — return empty string to deny
    return '';
  },
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// --- SSE (registered before rate limiter — long-lived connections) ---
app.route('/api/events', eventRoutes);

// --- API Docs (public, no auth/rate-limit) ---
app.route('/api/docs', docsRoutes);

// --- Rate limiting ---
// Auth routes: 5 req/min per IP (brute-force protection)
app.use('/api/auth/*', rateLimit(60_000, 5));
// Item creation: 20 req/min per IP
app.use('/api/items/create', rateLimit(60_000, 20));
// All API routes: 100 req/min per IP
app.use('/api/*', rateLimit(60_000, 100));

const apiRoutes = new Hono();
apiRoutes.route('/auth', authRoutes);
apiRoutes.route('/projects', projectRoutes);
apiRoutes.route('/users', userRoutes);
apiRoutes.route('/items', itemRoutes);
apiRoutes.route('/webhooks', webhookRoutes);
apiRoutes.route('/notifications', notificationRoutes);
apiRoutes.route('/api-keys', apiKeyRoutes);
apiRoutes.route('/integrations/errors', integrationsErrorsRoutes);

app.route('/api', apiRoutes);

function getApiNotFoundHint(path: string): string {
  if (/^\/api\/items\/[0-9a-f-]{36}$/i.test(path)) {
    return 'Use POST /api/items/get with JSON body { "id": "<item-id>" }. Scout item endpoints are POST JSON, not REST-style item URLs.';
  }
  return 'Inspect /api/docs/openapi.json and call the documented POST JSON endpoint.';
}

// Keep API misses machine-readable. Without this guard, wrong /api/* paths can
// fall through to the dashboard SPA and look like successful HTML responses.
app.all('/api/*', (c) => c.json({
  error: 'API endpoint not found',
  code: 'API_ENDPOINT_NOT_FOUND',
  method: c.req.method,
  path: c.req.path,
  docs: '/api/docs/openapi.json',
  hint: getApiNotFoundHint(c.req.path),
}, 404));

// Static files: screenshots, recordings — require authentication and project access.
// Supports both Authorization header and ?token= query param (for <img src>, fetch without headers).
app.use('/storage/*', storageAuth, async (c, next) => {
  const storagePath = c.req.path.replace(/^\/+/, '');
  const item = db.select({ projectId: scoutItems.projectId }).from(scoutItems)
    .where(or(eq(scoutItems.screenshotPath, storagePath), eq(scoutItems.sessionRecordingPath, storagePath)))
    .get();
  if (!item) throw new HTTPException(404, { message: 'Storage file not found' });

  const user = c.get('user');
  const apiKey = c.get('apiKey');
  if (apiKey) {
    if (apiKey.projectId !== item.projectId) throw new HTTPException(403, { message: 'No access to this storage file' });
  } else if (!checkProjectAccess(user.id, user.role, item.projectId)) {
    throw new HTTPException(403, { message: 'No access to this storage file' });
  }
  await next();
}, serveStatic({ root: './' }));

// Same-origin Grafana proxy for Scout-authenticated users. This keeps the
// public Grafana hostname protected while allowing Scout links to open directly.
app.route('/grafana', grafanaProxyRoutes);

// SSO bridge — lightweight HTML page for cross-domain token storage via postMessage
app.get('/auth/sso', (c) => {
  // Build allowedOrigins JSON for inline script
  const origins = getAllowedOrigins();
  const originsJson = JSON.stringify([...origins]);

  return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Scout SSO</title></head>
<body><script>
(function(){
  var TK='__scout_token__',UK='__scout_user__';
  var ALLOWED=${originsJson};
  var ALLOW_ALL=${JSON.stringify(!isProduction)};
  function allowed(o){if(ALLOW_ALL)return true;for(var i=0;i<ALLOWED.length;i++){if(ALLOWED[i]===o)return true}return false}
  function g(k){try{return localStorage.getItem(k)}catch(e){return null}}
  function s(k,v){try{localStorage.setItem(k,v)}catch(e){}}
  function r(k){try{localStorage.removeItem(k)}catch(e){}}
  window.addEventListener('message',function(e){
    if(!allowed(e.origin))return;
    var d=e.data;
    if(!d||d.ns!=='scout-sso')return;
    var resp={ns:'scout-sso',id:d.id};
    if(d.cmd==='getToken'){resp.token=g(TK);resp.user=g(UK)}
    else if(d.cmd==='setToken'){if(d.token)s(TK,d.token);if(d.user)s(UK,d.user);resp.ok=true}
    else if(d.cmd==='clearToken'){r(TK);r(UK);resp.ok=true}
    else if(d.cmd==='ping'){resp.ok=true}
    e.source.postMessage(resp,e.origin);
  });
})();
</script></body></html>`);
});

// SSO popup — login page opened as popup for cross-domain auth
app.get('/auth/sso/popup', (c) => {
  c.header('X-Frame-Options', 'DENY');

  // Validate opener origin against allowedOrigins
  const openerOrigin = c.req.query('origin') || '';
  const allowed = getAllowedOrigins();
  const validOrigin = (!isProduction || allowed.has(openerOrigin)) ? openerOrigin : '';

  // Use request host for same-origin API calls (avoids host header injection)
  const proto = isProduction ? 'https' : (c.req.header('x-forwarded-proto') || 'http');
  const host = c.req.header('host') || 'localhost';
  const apiOrigin = `${proto}://${host}`;

  return c.html(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Scout — Вход</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;color:#111827}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,0.08);padding:32px;width:100%;max-width:380px}
h2{font-size:20px;font-weight:600;margin-bottom:4px}
.sub{color:#6b7280;font-size:14px;margin-bottom:24px}
label{display:block;font-size:13px;font-weight:500;color:#374151;margin-bottom:6px}
input{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:16px;font-family:inherit;outline:none;transition:border-color .15s;margin-bottom:16px}
input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,0.1)}
.btn{width:100%;padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:500;cursor:pointer;font-family:inherit;transition:background .15s}
.btn:hover{background:#2563eb}
.btn:disabled{opacity:.6;cursor:not-allowed}
.err{color:#ef4444;font-size:13px;min-height:18px;margin-bottom:12px}
.spinner{width:32px;height:32px;border:3px solid #e5e7eb;border-top-color:#3b82f6;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 16px}
.done{text-align:center;padding:40px 0;color:#22c55e;font-size:15px;font-weight:500}
.done svg{display:block;margin:0 auto 12px;width:48px;height:48px}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head><body>
<div class="card">
<div id="loading"><div class="spinner"></div><p style="text-align:center;color:#6b7280;font-size:14px">Проверка сессии...</p></div>
<div id="form" style="display:none">
<h2>Scout</h2>
<p class="sub">Войдите, чтобы сообщать о багах</p>
<label for="e">Эл. почта</label>
<input id="e" type="email" autocomplete="email">
<label for="p">Пароль</label>
<input id="p" type="password" autocomplete="current-password">
<p class="err" id="err"></p>
<button class="btn" id="btn" type="button">Войти</button>
</div>
<div id="done" style="display:none" class="done">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
Вы вошли! Вернитесь на сайт.
</div>
</div>
<script>
(function(){
var API='${apiOrigin}';
var TARGET='${validOrigin}';
var CK='scout_session';
function getCk(){var m=document.cookie.match(new RegExp('(^| )'+CK+'=([^;]+)'));return m?m[2]:null}
function setCk(t){document.cookie=CK+'='+t+'; path=/; max-age=604800; SameSite=Lax'+(location.protocol==='https:'?'; Secure':'')}
function delCk(){document.cookie=CK+'=; path=/; max-age=0'}
function send(token,user){
  if(window.opener&&TARGET){
    window.opener.postMessage({ns:'scout-sso-popup',token:token,user:JSON.stringify(user)},TARGET);
    try{window.close()}catch(e){}
    setTimeout(function(){if(!window.closed){
      document.getElementById('loading').style.display='none';
      document.getElementById('form').style.display='none';
      document.getElementById('done').style.display='';
    }},300);
  }else{
    document.getElementById('loading').style.display='none';
    document.getElementById('form').style.display='none';
    document.getElementById('done').style.display='';
  }
}
function showForm(){document.getElementById('loading').style.display='none';document.getElementById('form').style.display='';document.getElementById('e').focus()}
var tk=getCk();
if(tk){
  fetch(API+'/api/auth/me',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+tk}})
  .then(function(r){return r.json()})
  .then(function(d){if(d.data&&d.data.user){send(tk,d.data.user)}else{delCk();showForm()}})
  .catch(function(){delCk();showForm()});
}else{showForm()}
document.getElementById('btn').addEventListener('click',function(){
  var email=document.getElementById('e').value.trim();
  var pass=document.getElementById('p').value;
  var err=document.getElementById('err');
  var btn=document.getElementById('btn');
  if(!email||!pass){err.textContent='Введите почту и пароль';return}
  btn.disabled=true;btn.textContent='Вход...';err.textContent='';
  fetch(API+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email,password:pass})})
  .then(function(r){return r.json().then(function(b){return{ok:r.ok,body:b}})})
  .then(function(r){
    if(!r.ok){throw new Error(r.body.error||r.body.message||'Ошибка входа')}
    setCk(r.body.data.token);send(r.body.data.token,r.body.data.user);
  }).catch(function(e){err.textContent=e.message;btn.disabled=false;btn.textContent='Войти'});
});
document.getElementById('p').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('btn').click()});
})();
</script>
</body></html>`);
});

// Widget JS (built by Vite)
app.use('/widget/*', serveStatic({
  root: './',
  rewriteRequestPath: (path) => path.replace('/widget/', '/widget/dist/'),
}));

// Demo stand
app.use('/demo/*', serveStatic({ root: './', rewriteRequestPath: (path) => path }));

// Dashboard SPA — try static file first, fallback to index.html for client-side routing
app.use('/*', serveStatic({ root: './dashboard/dist/' }));
app.get('/*', (c) => {
  try {
    const html = readFileSync('./dashboard/dist/index.html', 'utf-8');
    return c.html(html);
  } catch {
    return c.text('Dashboard not built. Run: pnpm build', 404);
  }
});

// Global error handler — no stack traces to client
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    const code = 'code' in err ? (err as { code: string }).code : undefined;
    return c.json({ error: err.message, ...(code && { code }) }, err.status);
  }
  logger.error({ err, method: c.req.method, path: c.req.path }, 'Unhandled request error');
  return c.json({ error: 'Internal server error' }, 500);
});

// Start server
const port = Number(process.env.SCOUT_PORT) || 10009;

serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, 'Scout started');
});

const stopBridgeWorker = startBridgeWorker();
const stopDailyDigestWorker = startDailyDigestWorker();

// Graceful shutdown
function shutdown() {
  logger.info('Shutting down');
  stopBridgeWorker();
  stopDailyDigestWorker();
  sqlite.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app };
