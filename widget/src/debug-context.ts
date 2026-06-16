type NavigationType = 'initial' | 'pushState' | 'replaceState' | 'popstate' | 'hashchange' | 'locationchange';
type ActionType = 'click' | 'submit' | 'input' | 'change' | 'focus';
type ConsoleLevel = 'error' | 'warn' | 'info' | 'log';

export interface RecordingSummary {
  hasRecording: boolean;
  recordingDurationMs: number;
  eventCount: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  fullSnapshotCount: number;
  incrementalEventCount: number;
  recordingPath: string | null;
  importantEvents: Array<{ ts: number; type: string; summary: string }>;
}

interface NavigationEntry {
  ts: number;
  type: NavigationType;
  url: string;
  title: string;
}

interface ActionEntry {
  ts: number;
  type: ActionType;
  selector: string;
  text: string;
  tag: string;
  url: string;
}

interface ConsoleEntry {
  ts: number;
  level: ConsoleLevel;
  message: string;
  stack?: string;
  url: string;
}

interface NetworkEntry {
  ts: number;
  method: string;
  url: string;
  status?: number;
  ok?: boolean;
  durationMs?: number;
  requestBody?: string;
  responseBody?: string;
  error?: string;
}

const BUFFER_DURATION_MS = 60_000;
const MAX_NAVIGATION = 30;
const MAX_ACTIONS = 80;
const MAX_CONSOLE = 80;
const MAX_NETWORK = 80;
const MAX_TEXT = 500;
const MAX_BODY = 2_000;
const MAX_SELECTOR = 350;
const MAX_STACK = 2_000;
const MAX_DEBUG_CONTEXT_JSON_CHARS = 180_000;
const SLOW_REQUEST_MS = 1_000;

let started = false;
let scoutRootId = 'scout-widget-root';
let scoutApiBase: URL | null = null;

let originalPushState: History['pushState'] | null = null;
let originalReplaceState: History['replaceState'] | null = null;
let originalFetch: typeof window.fetch | null = null;
let originalXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXhrSend: typeof XMLHttpRequest.prototype.send | null = null;

const originalConsole: Partial<Record<ConsoleLevel, (...data: unknown[]) => void>> = {};
const navigation: NavigationEntry[] = [];
const actions: ActionEntry[] = [];
const consoleEntries: ConsoleEntry[] = [];
const network: NetworkEntry[] = [];
const xhrInfo = new WeakMap<XMLHttpRequest, { method: string; url: string; requestBody?: string; startTime: number }>();

function nowTs(): number {
  return Date.now();
}

function truncate(value: unknown, max = MAX_TEXT): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function safeJson(value: unknown, max = MAX_TEXT): string {
  if (value instanceof Error) return truncate(value.stack || value.message, max);
  if (typeof value === 'string') return truncate(value, max);
  if (typeof value !== 'object' || value === null) return truncate(value, max);

  try {
    const seen = new WeakSet<object>();
    return truncate(JSON.stringify(value, (_key, nested) => {
      if (typeof nested === 'object' && nested !== null) {
        if (seen.has(nested)) return '[Circular]';
        seen.add(nested);
      }
      return nested;
    }), max);
  } catch {
    return truncate(value, max);
  }
}

function pushRolling<T extends { ts: number }>(buffer: T[], entry: T, maxEntries: number): void {
  const cutoff = nowTs() - BUFFER_DURATION_MS;
  while (buffer.length > 0 && buffer[0]!.ts < cutoff) buffer.shift();
  buffer.push(entry);
  while (buffer.length > maxEntries) buffer.shift();
}

function cssEscape(value: string): string {
  const css = window.CSS as { escape?: (input: string) => string } | undefined;
  if (css?.escape) return css.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function selectorFor(element: Element | null): string {
  if (!element) return '';
  try {
    if (element.id && element.id !== scoutRootId) return truncate(`#${cssEscape(element.id)}`, MAX_SELECTOR);

    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
      const tag = current.tagName.toLowerCase();
      if (current.id && current.id !== scoutRootId) {
        parts.unshift(`${tag}#${cssEscape(current.id)}`);
        break;
      }

      let part = tag;
      const classList = Array.from(current.classList).slice(0, 2).map(cssEscape);
      if (classList.length > 0) part += `.${classList.join('.')}`;

      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current!.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }

      parts.unshift(part);
      current = parent;
    }
    return truncate(parts.join(' > '), MAX_SELECTOR);
  } catch {
    return '';
  }
}

function eventTouchesScoutUi(event: Event): boolean {
  try {
    return event.composedPath().some((node) => node instanceof HTMLElement && node.id === scoutRootId);
  } catch {
    const target = event.target;
    return target instanceof Element && Boolean(target.closest(`#${scoutRootId}`));
  }
}

function textForElement(element: Element): string {
  const htmlElement = element as HTMLElement;
  const formElement = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const label = htmlElement.getAttribute('aria-label')
    || htmlElement.getAttribute('title')
    || ('placeholder' in formElement ? formElement.placeholder : '')
    || htmlElement.innerText
    || htmlElement.textContent
    || htmlElement.getAttribute('name')
    || '';
  return truncate(label.replace(/\s+/g, ' ').trim(), MAX_TEXT);
}

function recordAction(event: Event, type: ActionType): void {
  if (eventTouchesScoutUi(event)) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  pushRolling(actions, {
    ts: nowTs(),
    type,
    selector: selectorFor(target),
    text: textForElement(target),
    tag: target.tagName.toLowerCase(),
    url: window.location.href,
  }, MAX_ACTIONS);
}

function recordNavigation(type: NavigationType): void {
  pushRolling(navigation, {
    ts: nowTs(),
    type,
    url: window.location.href,
    title: document.title,
  }, MAX_NAVIGATION);
}

function normalizeUrl(value: unknown): string {
  try {
    if (value instanceof Request) return value.url;
    if (value instanceof URL) return value.href;
    return new URL(String(value), window.location.href).href;
  } catch {
    return truncate(value, 1_000);
  }
}

function isScoutInternalUrl(url: string): boolean {
  if (!scoutApiBase) return false;
  try {
    const target = new URL(url, window.location.href);
    if (target.origin !== scoutApiBase.origin) return false;

    const basePath = scoutApiBase.pathname.replace(/\/$/, '');
    const apiPath = `${basePath}/api`.replace(/^\/\//, '/');
    return [
      `${apiPath}/auth/login`,
      `${apiPath}/auth/refresh`,
      `${apiPath}/items/create`,
      `${apiPath}/projects/list`,
    ].some((path) => target.pathname === path);
  } catch {
    return false;
  }
}

function bodySummary(body: unknown): string | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return truncate(body, MAX_BODY);
  if (body instanceof URLSearchParams) return truncate(body.toString(), MAX_BODY);
  if (body instanceof FormData) return `[FormData fields=${Array.from(body.keys()).join(',')}]`;
  if (body instanceof Blob) return `[Blob type=${body.type || 'unknown'} size=${body.size}]`;
  if (body instanceof ArrayBuffer) return `[ArrayBuffer bytes=${body.byteLength}]`;
  if (ArrayBuffer.isView(body)) return `[${body.constructor.name} bytes=${body.byteLength}]`;
  return truncate(body, MAX_BODY);
}

function shouldCaptureResponseBody(response: Response): boolean {
  const contentType = response.headers.get('content-type') || '';
  if (!/json|text|html|xml|javascript/i.test(contentType)) return false;
  const length = Number(response.headers.get('content-length') || '0');
  return !Number.isFinite(length) || length === 0 || length <= 20_000;
}

async function fillFetchResponseBody(response: Response, entry: NetworkEntry): Promise<void> {
  if (!shouldCaptureResponseBody(response)) return;
  try {
    entry.responseBody = truncate(await response.clone().text(), MAX_BODY);
  } catch {
    // Response body may be streamed, opaque, or already consumed. Keep metadata only.
  }
}

function patchFetch(): void {
  if (originalFetch || typeof window.fetch !== 'function') return;
  originalFetch = window.fetch.bind(window);

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = normalizeUrl(input);
    if (isScoutInternalUrl(url)) return originalFetch!(input, init);

    const method = truncate((init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase(), 20);
    const entry: NetworkEntry = {
      ts: nowTs(),
      method,
      url,
      requestBody: bodySummary(init?.body),
    };
    const start = performance.now();

    try {
      const response = await originalFetch!(input, init);
      entry.status = response.status;
      entry.ok = response.ok;
      entry.durationMs = Math.round(performance.now() - start);
      pushRolling(network, entry, MAX_NETWORK);
      void fillFetchResponseBody(response, entry);
      return response;
    } catch (error) {
      entry.durationMs = Math.round(performance.now() - start);
      entry.ok = false;
      entry.error = safeJson(error, MAX_TEXT);
      pushRolling(network, entry, MAX_NETWORK);
      throw error;
    }
  }) as typeof window.fetch;
}

function patchXhr(): void {
  if (originalXhrOpen || typeof XMLHttpRequest === 'undefined') return;

  originalXhrOpen = XMLHttpRequest.prototype.open;
  originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(...args: Parameters<typeof XMLHttpRequest.prototype.open>) {
    const method = truncate(String(args[0] || 'GET').toUpperCase(), 20);
    const url = normalizeUrl(args[1]);
    xhrInfo.set(this, { method, url, startTime: 0 });
    return originalXhrOpen!.apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.send = function patchedSend(body?: Document | XMLHttpRequestBodyInit | null) {
    const info = xhrInfo.get(this);
    if (!info || isScoutInternalUrl(info.url)) return originalXhrSend!.call(this, body ?? null);

    info.requestBody = bodySummary(body);
    info.startTime = performance.now();

    const finalize = (error?: string) => {
      const entry: NetworkEntry = {
        ts: nowTs(),
        method: info.method,
        url: info.url,
        status: this.status || undefined,
        ok: this.status >= 200 && this.status < 400,
        durationMs: Math.round(performance.now() - info.startTime),
        requestBody: info.requestBody,
        error,
      };

      try {
        if (!error && (!this.responseType || this.responseType === 'text')) {
          entry.responseBody = truncate(this.responseText, MAX_BODY);
        }
      } catch {
        // Some response types throw on responseText access.
      }

      pushRolling(network, entry, MAX_NETWORK);
      xhrInfo.delete(this);
    };

    this.addEventListener('loadend', () => finalize(), { once: true });
    this.addEventListener('error', () => finalize('XMLHttpRequest error'), { once: true });
    this.addEventListener('timeout', () => finalize('XMLHttpRequest timeout'), { once: true });
    this.addEventListener('abort', () => finalize('XMLHttpRequest abort'), { once: true });

    return originalXhrSend!.call(this, body ?? null);
  } as typeof XMLHttpRequest.prototype.send;
}

function patchConsole(): void {
  (['error', 'warn', 'info', 'log'] as ConsoleLevel[]).forEach((level) => {
    if (originalConsole[level]) return;
    const original = console[level].bind(console) as (...data: unknown[]) => void;
    originalConsole[level] = original;
    console[level] = ((...args: unknown[]) => {
      try {
        const errorArg = args.find((arg): arg is Error => arg instanceof Error);
        pushRolling(consoleEntries, {
          ts: nowTs(),
          level,
          message: truncate(args.map((arg) => safeJson(arg, MAX_TEXT)).join(' '), MAX_BODY),
          stack: errorArg?.stack ? truncate(errorArg.stack, MAX_STACK) : undefined,
          url: window.location.href,
        }, MAX_CONSOLE);
      } catch {
        // Console capture must never block page logging.
      }
      original(...args);
    }) as typeof console[typeof level];
  });
}

function patchHistory(): void {
  if (originalPushState || originalReplaceState) return;
  originalPushState = history.pushState;
  originalReplaceState = history.replaceState;

  history.pushState = function patchedPushState(...args: Parameters<History['pushState']>) {
    const result = originalPushState!.apply(this, args);
    recordNavigation('pushState');
    return result;
  } as History['pushState'];

  history.replaceState = function patchedReplaceState(...args: Parameters<History['replaceState']>) {
    const result = originalReplaceState!.apply(this, args);
    recordNavigation('replaceState');
    return result;
  } as History['replaceState'];

  window.addEventListener('popstate', () => recordNavigation('popstate'), true);
  window.addEventListener('hashchange', () => recordNavigation('hashchange'), true);
}

function attachActionListeners(): void {
  const entries: Array<[keyof DocumentEventMap, ActionType]> = [
    ['click', 'click'],
    ['submit', 'submit'],
    ['input', 'input'],
    ['change', 'change'],
    ['focus', 'focus'],
  ];
  for (const [eventName, actionType] of entries) {
    document.addEventListener(eventName, (event) => recordAction(event, actionType), true);
  }
}

function performanceSummary() {
  try {
    const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (navEntry) {
      return {
        navigationType: navEntry.type,
        loadTimeMs: Math.round(navEntry.loadEventEnd || navEntry.responseEnd || 0),
        domContentLoadedMs: Math.round(navEntry.domContentLoadedEventEnd || 0),
      };
    }

    const timing = performance.timing;
    if (timing?.navigationStart) {
      return {
        navigationType: 'legacy',
        loadTimeMs: Math.max(0, timing.loadEventEnd - timing.navigationStart),
        domContentLoadedMs: Math.max(0, timing.domContentLoadedEventEnd - timing.navigationStart),
      };
    }
  } catch {
    // Ignore unsupported Performance APIs.
  }

  return {
    navigationType: 'unknown',
    loadTimeMs: 0,
    domContentLoadedMs: 0,
  };
}

function currentPageContext() {
  return {
    url: window.location.href,
    title: document.title,
    referrer: document.referrer,
    route: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    visibilityState: document.visibilityState,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      devicePixelRatio: String(window.devicePixelRatio),
    },
  };
}

function cloneRecent<T extends { ts: number }>(buffer: T[]): T[] {
  const cutoff = nowTs() - BUFFER_DURATION_MS;
  return buffer.filter((entry) => entry.ts >= cutoff);
}

function fitDebugContext(context: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    if (JSON.stringify(context).length <= MAX_DEBUG_CONTEXT_JSON_CHARS) return context;

    const reducedNetwork = cloneRecent(network).slice(-40).map((entry) => ({
      ...entry,
      requestBody: entry.requestBody ? truncate(entry.requestBody, 400) : undefined,
      responseBody: entry.responseBody ? truncate(entry.responseBody, 400) : undefined,
    }));
    const reduced = {
      ...context,
      actions: cloneRecent(actions).slice(-40),
      console: cloneRecent(consoleEntries).slice(-40),
      network: reducedNetwork,
    };
    if (JSON.stringify(reduced).length <= MAX_DEBUG_CONTEXT_JSON_CHARS) return reduced;

    const minimal = {
      version: context.version,
      capturedAt: context.capturedAt,
      page: context.page,
      navigation: cloneRecent(navigation).slice(-10),
      actions: cloneRecent(actions).slice(-10),
      console: cloneRecent(consoleEntries).filter((entry) => entry.level === 'error' || entry.level === 'warn').slice(-10),
      network: cloneRecent(network).filter((entry) => entry.error || entry.ok === false || (entry.status ?? 0) >= 400 || (entry.durationMs ?? 0) >= SLOW_REQUEST_MS).slice(-10),
      performance: context.performance,
      recordingSummary: context.recordingSummary,
    };
    return JSON.stringify(minimal).length <= MAX_DEBUG_CONTEXT_JSON_CHARS ? minimal : undefined;
  } catch {
    return undefined;
  }
}

export function startDebugContextCapture(options?: { scoutRootId?: string; apiUrl?: string }): void {
  scoutRootId = options?.scoutRootId || scoutRootId;
  try {
    scoutApiBase = options?.apiUrl ? new URL(options.apiUrl, window.location.href) : null;
  } catch {
    scoutApiBase = null;
  }

  if (started) return;
  started = true;

  try {
    recordNavigation('initial');
    patchHistory();
    patchConsole();
    patchFetch();
    patchXhr();
    attachActionListeners();
  } catch {
    // Debug context is best-effort; bug and note creation must continue.
  }
}

export function getDebugContextPayload(recordingSummary: RecordingSummary): Record<string, unknown> | undefined {
  try {
    return fitDebugContext({
      version: 1,
      capturedAt: new Date().toISOString(),
      page: currentPageContext(),
      navigation: cloneRecent(navigation),
      actions: cloneRecent(actions),
      console: cloneRecent(consoleEntries),
      network: cloneRecent(network),
      performance: performanceSummary(),
      recordingSummary,
    });
  } catch {
    return undefined;
  }
}
