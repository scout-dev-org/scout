import { t } from './i18n';

const TOKEN_KEY = '__scout_token__';
const USER_KEY = '__scout_user__';
const COOKIE_TOKEN = 'scout_t';
const COOKIE_USER = 'scout_u';
const COOKIE_MAX_AGE = 604_800; // 7 days (matches JWT TTL)

interface ScoutUser {
  id: string;
  email: string;
  name?: string;
}

interface LoginResponse {
  data: {
    token: string;
    user: ScoutUser;
  };
}

// --- In-memory cache ---
let cachedToken: string | null = null;
let cachedUser: ScoutUser | null = null;

// --- SSO iframe bridge ---
let ssoIframe: HTMLIFrameElement | null = null;
let ssoWindow: Window | null = null; // Cached contentWindow to avoid repeated cross-origin access
let ssoReady = false;
let ssoOrigin = '';
let msgId = 0;
const pendingMessages = new Map<number, (data: Record<string, unknown>) => void>();

const SSO_IFRAME_TIMEOUT_MS = 2_000;
const SSO_MSG_TIMEOUT_MS = 1_500;
const POPUP_POLL_INTERVAL_MS = 300;
const POPUP_GIVE_UP_MS = 120_000;
const TOKEN_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

let refreshPromise: Promise<string | null> | null = null;

/** Validate JWT format: 3 base64url segments separated by dots */
function isValidJWT(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

function getJWTExpiryMs(token: string): number | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const json = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isExpiredJWT(token: string): boolean {
  const expiresAt = getJWTExpiryMs(token);
  return expiresAt === null || expiresAt <= Date.now();
}

function shouldRefreshJWT(token: string): boolean {
  const expiresAt = getJWTExpiryMs(token);
  return expiresAt !== null && expiresAt - Date.now() <= TOKEN_REFRESH_WINDOW_MS;
}

function isUsableJWT(token: string): boolean {
  return isValidJWT(token) && !isExpiredJWT(token);
}

// ============================================================
// Cookie-based SSO for subdomains (works in ALL browsers)
// ============================================================

function getParentDomain(): string | null {
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || /^\d+(\.\d+){3}$/.test(hostname)) return null;
  const parts = hostname.split('.');
  if (parts.length < 3) return null;
  // Browser silently rejects public suffixes (.co.uk, etc.)
  return '.' + parts.slice(-2).join('.');
}

function saveToCookie(token: string, user: ScoutUser): void {
  const domain = getParentDomain();
  if (!domain) return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  const base = `path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}; domain=${domain}`;
  try {
    document.cookie = `${COOKIE_TOKEN}=${token}; ${base}`;
    document.cookie = `${COOKIE_USER}=${encodeURIComponent(JSON.stringify(user))}; ${base}`;
  } catch { /* cookie API blocked */ }
}

function loadFromCookie(): boolean {
  try {
    const cookies = document.cookie.split(';');
    let token: string | null = null;
    let user: ScoutUser | null = null;
    for (const c of cookies) {
      const trimmed = c.trim();
      if (trimmed.startsWith(COOKIE_TOKEN + '=')) {
        const val = trimmed.slice(COOKIE_TOKEN.length + 1);
        if (isUsableJWT(val)) token = val;
      }
      if (trimmed.startsWith(COOKIE_USER + '=')) {
        try { user = JSON.parse(decodeURIComponent(trimmed.slice(COOKIE_USER.length + 1))); } catch { /* skip */ }
      }
    }
    if (token) {
      cachedToken = token;
      cachedUser = user;
      saveToLocalStorage(token, user);
      return true;
    }
  } catch { /* cookie API blocked */ }
  return false;
}

function clearCookie(): void {
  const domain = getParentDomain();
  if (!domain) return;
  try {
    document.cookie = `${COOKIE_TOKEN}=; path=/; max-age=0; domain=${domain}`;
    document.cookie = `${COOKIE_USER}=; path=/; max-age=0; domain=${domain}`;
  } catch { /* ignore */ }
}

// ============================================================
// SSO iframe bridge (cross-domain, Chrome + Firefox)
// ============================================================

function onSSOMessage(e: MessageEvent): void {
  // SECURITY: only accept messages from the SSO origin
  if (e.origin !== ssoOrigin) return;
  const data = e.data;
  if (!data || data.ns !== 'scout-sso' || typeof data.id !== 'number') return;
  const resolve = pendingMessages.get(data.id);
  if (resolve) {
    pendingMessages.delete(data.id);
    resolve(data);
  }
}

function sendSSOMessage(cmd: string, payload?: Record<string, string>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!ssoWindow) { reject(new Error('No iframe')); return; }
    const id = ++msgId;
    const timer = setTimeout(() => {
      pendingMessages.delete(id);
      reject(new Error('SSO timeout'));
    }, SSO_MSG_TIMEOUT_MS);
    pendingMessages.set(id, (data) => { clearTimeout(timer); resolve(data); });
    ssoWindow.postMessage({ ns: 'scout-sso', id, cmd, ...payload }, ssoOrigin);
  });
}

/** Start iframe SSO in background (non-blocking) */
function startIframeSSO(apiUrl: string): void {
  if (window.location.origin === ssoOrigin) return;

  window.addEventListener('message', onSSOMessage);

  ssoIframe = document.createElement('iframe');
  ssoIframe.src = `${apiUrl}/auth/sso`;
  ssoIframe.style.cssText = 'display:none;width:0;height:0;border:none;position:absolute';
  ssoIframe.setAttribute('aria-hidden', 'true');
  // Cache contentWindow once on load to avoid repeated cross-origin access warnings in Safari
  ssoIframe.addEventListener('load', () => {
    try { ssoWindow = ssoIframe?.contentWindow ?? null; } catch { ssoWindow = null; }
  }, { once: true });
  document.body.appendChild(ssoIframe);

  // Non-blocking: try to ping iframe, mark ready if it responds
  let attempts = 0;
  const maxAttempts = Math.ceil(SSO_IFRAME_TIMEOUT_MS / 200);

  function tryPing(): void {
    attempts++;
    sendSSOMessage('ping')
      .then(() => {
        ssoReady = true;
        // If no token yet, try iframe
        if (!cachedToken) {
          sendSSOMessage('getToken').then((data) => {
            if (data.token && typeof data.token === 'string' && isUsableJWT(data.token)) {
              cachedToken = data.token;
              if (data.user && typeof data.user === 'string') {
                try { cachedUser = JSON.parse(data.user); } catch { /* skip */ }
              }
              saveToLocalStorage(cachedToken, cachedUser);
            }
          }).catch(() => { /* ignore */ });
        }
      })
      .catch(() => {
        if (attempts < maxAttempts) setTimeout(tryPing, 200);
      });
  }

  ssoIframe.addEventListener('load', () => setTimeout(tryPing, 50), { once: true });
  setTimeout(() => { if (attempts === 0) tryPing(); }, 500);
}

// ============================================================
// Popup-based SSO (cross-domain, works in ALL browsers)
// ============================================================

/**
 * A native WebView sends `window.open` to the system browser, which has no `opener` to answer on and
 * whose `closed` never turns true. The popup promise then never settled: the host app hid its button
 * waiting for an answer that could not arrive, and the only way out was restarting the app.
 */
export function hasPopupChannel(): boolean {
  const nativeBridge = (window as unknown as { Capacitor?: unknown; cordova?: unknown; ReactNativeWebView?: unknown });
  return !nativeBridge.Capacitor && !nativeBridge.cordova && !nativeBridge.ReactNativeWebView;
}

/**
 * Try to authenticate via popup SSO.
 * Returns true if authenticated, false if popup was blocked/closed/unanswerable.
 */
export function tryPopupSSO(apiUrl: string): Promise<boolean> {
  if (!hasPopupChannel()) return Promise.resolve(false);

  return new Promise((resolve) => {
    let resolved = false;

    function done(result: boolean): void {
      if (resolved) return;
      resolved = true;
      window.removeEventListener('message', onMessage);
      clearInterval(pollTimer);
      clearTimeout(giveUpTimer);
      resolve(result);
    }

    // A browser that neither answers nor reports the window closed must still let the caller move on.
    const giveUpTimer = setTimeout(() => done(false), POPUP_GIVE_UP_MS);

    const w = 420;
    const h = 540;
    const left = Math.round((screen.width - w) / 2);
    const top = Math.round((screen.height - h) / 2);

    // Pass opener origin for server-side validation
    const popupUrl = `${apiUrl}/auth/sso/popup?origin=${encodeURIComponent(window.location.origin)}`;
    const popup = window.open(
      popupUrl,
      'scout-sso',
      `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=no`,
    );

    if (!popup) { done(false); return; }

    function onMessage(e: MessageEvent): void {
      // SECURITY: only accept messages from the SSO origin
      if (e.origin !== ssoOrigin) return;
      const data = e.data;
      if (!data || data.ns !== 'scout-sso-popup') return;

      if (data.token && typeof data.token === 'string' && isUsableJWT(data.token)) {
        cachedToken = data.token;
        try { cachedUser = data.user ? JSON.parse(data.user) : null; } catch { cachedUser = null; }
        saveToCookie(cachedToken, cachedUser);
        saveToLocalStorage(cachedToken, cachedUser);
        if (ssoReady) {
          sendSSOMessage('setToken', { token: cachedToken, user: data.user ?? '' }).catch(() => { /* skip */ });
        }
        done(true);
      } else {
        done(false);
      }
    }

    window.addEventListener('message', onMessage);

    const pollTimer = setInterval(() => {
      try {
        if (popup.closed) done(false);
      } catch { /* cross-origin — still open */ }
    }, POPUP_POLL_INTERVAL_MS);
  });
}

// ============================================================
// localStorage fallback
// ============================================================

function loadFromLocalStorage(): void {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    cachedToken = (raw && isUsableJWT(raw)) ? raw : null;
    if (raw && !cachedToken) saveToLocalStorage(null, null);
    const userRaw = localStorage.getItem(USER_KEY);
    cachedUser = cachedToken && userRaw ? JSON.parse(userRaw) : null;
  } catch {
    cachedToken = null;
    cachedUser = null;
  }
}

function saveToLocalStorage(token: string | null, user: ScoutUser | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch { /* localStorage may be blocked */ }
}

// ============================================================
// Initialization
// ============================================================

/**
 * Initialize SSO. Non-blocking — cookie + localStorage are checked synchronously,
 * iframe SSO starts in background.
 */
export async function initSSO(apiUrl: string): Promise<void> {
  ssoOrigin = new URL(apiUrl).origin;

  // 1. Cookie (subdomain SSO — instant, works everywhere)
  if (loadFromCookie()) {
    startIframeSSO(apiUrl); // background sync
    return;
  }

  // 2. Same origin — just use localStorage
  if (window.location.origin === ssoOrigin) {
    loadFromLocalStorage();
    return;
  }

  // 3. localStorage fallback
  loadFromLocalStorage();

  // 4. Start iframe SSO in background (may find token later)
  startIframeSSO(apiUrl);
}

// ============================================================
// Public API
// ============================================================

export function getToken(): string | null {
  if (cachedToken && isExpiredJWT(cachedToken)) {
    clearAuth();
  }
  return cachedToken;
}

async function refreshAuth(apiUrl: string, token: string): Promise<string | null> {
  const res = await fetch(`${apiUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  }).catch(() => null);

  if (!res) return token;
  if (res.status === 401) {
    clearAuth();
    return null;
  }
  if (!res.ok) return token;

  try {
    const json: LoginResponse = await res.json();
    const { token: nextToken, user } = json.data;
    if (!isUsableJWT(nextToken)) return token;
    saveAuth(nextToken, user);
    return nextToken;
  } catch {
    return token;
  }
}

export async function ensureToken(apiUrl: string): Promise<string | null> {
  const token = getToken();
  if (!token) return null;
  if (!shouldRefreshJWT(token)) return token;

  refreshPromise ??= refreshAuth(apiUrl, token).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export function getUser(): ScoutUser | null {
  return cachedUser;
}

export function saveAuth(token: string, user: ScoutUser): void {
  cachedToken = token;
  cachedUser = user;
  saveToCookie(token, user);
  saveToLocalStorage(token, user);
  if (ssoReady) {
    sendSSOMessage('setToken', { token, user: JSON.stringify(user) }).catch(() => { /* skip */ });
  }
}

export function clearAuth(): void {
  cachedToken = null;
  cachedUser = null;
  clearCookie();
  saveToLocalStorage(null, null);
  if (ssoReady) {
    sendSSOMessage('clearToken').catch(() => { /* skip */ });
  }
}

export async function login(apiUrl: string, email: string, password: string): Promise<{ token: string; user: ScoutUser }> {
  const res = await fetch(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? body?.message ?? t('error.loginFailed', { status: String(res.status) }));
  }
  const json: LoginResponse = await res.json();
  const { token, user } = json.data;
  saveAuth(token, user);
  return { token, user };
}

let cachedProjectId: string | null = null;

export async function resolveProjectId(apiUrl: string, projectSlug: string): Promise<string> {
  if (cachedProjectId !== null) return cachedProjectId;
  const token = await ensureToken(apiUrl);
  if (!token) throw new Error(t('error.unauthorized'));
  const res = await fetch(`${apiUrl}/api/projects/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    if (res.status === 401) { clearAuth(); throw new Error(t('error.sessionExpired')); }
    throw new Error(t('error.projectLoad', { status: String(res.status) }));
  }
  const json = await res.json();
  const items: Array<{ id: string; slug: string }> = json.data?.items ?? [];
  const project = items.find((p) => p.slug === projectSlug);
  if (!project) throw new Error(t('error.projectNotFound', { slug: projectSlug }));
  cachedProjectId = project.id;
  return project.id;
}

export function resetProjectCache(): void {
  cachedProjectId = null;
}
