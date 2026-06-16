import type { PickedElement } from './element-picker';
import { SCREENSHOT_MIME } from './screenshot';
import { getRecordingCompressed, getRecordingSummary, resetBuffer, isRecordingAvailable } from './recorder';
import { getDebugContextPayload } from './debug-context';
import { ensureToken, getUser, clearAuth, resolveProjectId, resetProjectCache } from './auth';
import { t } from './i18n';

interface PanelElements {
  backdrop: HTMLDivElement;
  panel: HTMLDivElement;
  title: HTMLHeadingElement;
  elementInfo: HTMLDivElement;
  selectorDisplay: HTMLDivElement;
  textDisplay: HTMLDivElement;
  labelText: HTMLSpanElement;
  textarea: HTMLTextAreaElement;
  charCount: HTMLSpanElement;
  priorityField: HTMLDivElement;
  prioritySelect: HTMLSelectElement;
  screenshotLabel: HTMLLabelElement;
  screenshotCheckbox: HTMLInputElement;
  recordingLabel: HTMLLabelElement;
  recordingCheckbox: HTMLInputElement;
  modeSwitchBtn: HTMLButtonElement;
  submitBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  progressStatus: HTMLDivElement;
  screenshotPreview: HTMLDivElement;
}

export interface PanelCallbacks {
  onClose: () => void;
  onSubmitSuccess: (mode: PanelMode) => void;
  onSubmitError: (msg: string) => void;
  onLogout: () => void;
}

type PanelMode = 'bug' | 'note';

/**
 * Auto-capture environment metadata (Marker.io/Usersnap pattern).
 * All professional tools capture this silently — no checkboxes needed.
 */
function collectMetadata(): Record<string, string> {
  const ua = navigator.userAgent;
  let browser = 'Unknown';
  let os = 'Unknown';

  // Browser detection
  if (ua.includes('Firefox/')) browser = 'Firefox ' + (ua.match(/Firefox\/([\d.]+)/)?.[1] ?? '');
  else if (ua.includes('Edg/')) browser = 'Edge ' + (ua.match(/Edg\/([\d.]+)/)?.[1] ?? '');
  else if (ua.includes('Chrome/') && !ua.includes('Edg/')) browser = 'Chrome ' + (ua.match(/Chrome\/([\d.]+)/)?.[1] ?? '');
  else if (ua.includes('Safari/') && !ua.includes('Chrome/')) browser = 'Safari ' + (ua.match(/Version\/([\d.]+)/)?.[1] ?? '');

  // OS detection
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS X')) os = 'macOS ' + (ua.match(/Mac OS X ([\d_.]+)/)?.[1]?.replace(/_/g, '.') ?? '');
  else if (ua.includes('Linux')) os = 'Linux';
  else if (ua.includes('Android')) os = 'Android ' + (ua.match(/Android ([\d.]+)/)?.[1] ?? '');
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS ' + (ua.match(/OS ([\d_]+)/)?.[1]?.replace(/_/g, '.') ?? '');

  return {
    browser,
    os,
    language: navigator.language,
    devicePixelRatio: String(window.devicePixelRatio),
    screenResolution: `${screen.width}x${screen.height}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// --- Retry with exponential backoff (3 retries, 1/2/4s) ---
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1_000;

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  onRetry?: (attempt: number, maxAttempts: number) => void,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, options);

      // Don't retry client errors (4xx) — they won't succeed
      if (res.status >= 400 && res.status < 500) return res;

      // Retry server errors (5xx)
      if (!res.ok && attempt < MAX_RETRIES) {
        throw new Error(`Server error (${res.status})`);
      }

      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt); // 1s, 2s, 4s
        onRetry?.(attempt + 1, MAX_RETRIES);
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error(t('error.network'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/**
 * Create the slide-in panel DOM elements.
 */
export function createPanel(shadow: ShadowRoot): PanelElements {
  const backdrop = document.createElement('div');
  backdrop.className = 'scout-panel-backdrop hidden';

  const panel = document.createElement('div');
  panel.className = 'scout-panel';

  // Header
  const header = document.createElement('div');
  header.className = 'scout-panel-header';

  const title = document.createElement('h2');
  title.textContent = t('panel.title');

  const closeBtn = document.createElement('button');
  closeBtn.className = 'scout-panel-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>`;

  header.appendChild(title);
  header.appendChild(closeBtn);

  // User info bar (shows logged-in user + logout button — like Marker.io/Usersnap)
  const userBar = document.createElement('div');
  userBar.className = 'scout-user-bar';

  const userInfo = document.createElement('div');
  userInfo.className = 'scout-user-info';

  const userAvatar = document.createElement('div');
  userAvatar.className = 'scout-user-avatar';

  const userName = document.createElement('span');
  userName.className = 'scout-user-name';

  userInfo.appendChild(userAvatar);
  userInfo.appendChild(userName);

  const logoutBtn = document.createElement('button');
  logoutBtn.className = 'scout-logout-btn';
  logoutBtn.textContent = t('panel.logout');
  logoutBtn.setAttribute('aria-label', t('panel.logoutLabel'));

  userBar.appendChild(userInfo);
  userBar.appendChild(logoutBtn);

  // Body
  const body = document.createElement('div');
  body.className = 'scout-panel-body';

  // Element info
  const elementInfo = document.createElement('div');
  elementInfo.className = 'scout-element-info';

  const selectorLabel = document.createElement('div');
  selectorLabel.className = 'scout-element-info-label';
  selectorLabel.textContent = t('panel.element');

  const selectorDisplay = document.createElement('div');
  selectorDisplay.className = 'scout-element-info-value';

  const textLabel = document.createElement('div');
  textLabel.className = 'scout-element-info-label';
  textLabel.textContent = t('panel.text');

  const textDisplay = document.createElement('div');
  textDisplay.className = 'scout-element-text';

  elementInfo.appendChild(selectorLabel);
  elementInfo.appendChild(selectorDisplay);
  elementInfo.appendChild(textLabel);
  elementInfo.appendChild(textDisplay);

  // Textarea field
  const field = document.createElement('div');
  field.className = 'scout-field';

  const label = document.createElement('label');
  const labelText = document.createElement('span');
  labelText.textContent = t('panel.describe') + ' ';
  label.appendChild(labelText);
  const requiredSpan = document.createElement('span');
  requiredSpan.className = 'scout-required';
  requiredSpan.textContent = t('panel.required');
  label.appendChild(requiredSpan);

  const textarea = document.createElement('textarea');
  textarea.placeholder = t('panel.placeholder');
  textarea.setAttribute('minlength', '3');

  const charCount = document.createElement('div');
  charCount.className = 'scout-char-count';
  charCount.textContent = '0';

  textarea.addEventListener('input', () => {
    const len = textarea.value.length;
    charCount.textContent = `${len}`;
    if (len >= 3) {
      textarea.classList.remove('error');
    }
  });

  field.appendChild(label);
  field.appendChild(textarea);
  field.appendChild(charCount);

  const modeSwitchBtn = document.createElement('button');
  modeSwitchBtn.type = 'button';
  modeSwitchBtn.className = 'scout-mode-switch';
  modeSwitchBtn.textContent = t('panel.noteSwitch');

  // Priority selector
  const priorityField = document.createElement('div');
  priorityField.className = 'scout-field';

  const priorityLabel = document.createElement('label');
  priorityLabel.textContent = t('panel.priority');

  const prioritySelect = document.createElement('select');
  prioritySelect.className = 'scout-input';
  prioritySelect.style.padding = '8px 12px';

  const priorityOptions: [string, string][] = [
    ['critical', t('panel.priorityCritical')],
    ['high', t('panel.priorityHigh')],
    ['medium', t('panel.priorityMedium')],
    ['low', t('panel.priorityLow')],
  ];
  for (const [value, text] of priorityOptions) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    if (value === 'medium') opt.selected = true;
    prioritySelect.appendChild(opt);
  }

  priorityField.appendChild(priorityLabel);
  priorityField.appendChild(prioritySelect);

  // Checkboxes
  const screenshotLabel = document.createElement('label');
  screenshotLabel.className = 'scout-checkbox';
  const screenshotCheckbox = document.createElement('input');
  screenshotCheckbox.type = 'checkbox';
  screenshotCheckbox.checked = true;
  screenshotLabel.appendChild(screenshotCheckbox);
  screenshotLabel.appendChild(document.createTextNode(t('panel.screenshot')));

  const recordingLabel = document.createElement('label');
  recordingLabel.className = 'scout-checkbox';
  const recordingCheckbox = document.createElement('input');
  recordingCheckbox.type = 'checkbox';
  recordingCheckbox.checked = true;
  recordingLabel.appendChild(recordingCheckbox);
  recordingLabel.appendChild(document.createTextNode(t('panel.recording')));

  // Screenshot preview (professional pattern: show before sending)
  const screenshotPreview = document.createElement('div');
  screenshotPreview.className = 'scout-screenshot-preview hidden';

  // Progress status indicator
  const progressStatus = document.createElement('div');
  progressStatus.className = 'scout-progress-status hidden';

  body.appendChild(elementInfo);
  body.appendChild(field);
  body.appendChild(modeSwitchBtn);
  body.appendChild(priorityField);
  body.appendChild(screenshotLabel);
  body.appendChild(recordingLabel);
  body.appendChild(screenshotPreview);
  body.appendChild(progressStatus);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'scout-panel-footer';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'scout-btn scout-btn-primary';
  submitBtn.textContent = t('panel.submit');

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'scout-btn scout-btn-secondary';
  cancelBtn.textContent = t('panel.cancel');

  footer.appendChild(submitBtn);
  footer.appendChild(cancelBtn);

  // "Powered by Scout" badge (industry standard — Marker.io, Usersnap, BugHerd, Gleap all have it)
  const poweredBy = document.createElement('div');
  poweredBy.className = 'scout-powered-by';
  poweredBy.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 7v10M7 12h10"/><path d="M8 2l1.5 1.5M16 2l-1.5 1.5"/><path d="M3 10h2M19 10h2"/></svg> Powered by Scout`;

  // Assemble
  panel.appendChild(header);
  panel.appendChild(userBar);
  panel.appendChild(body);
  panel.appendChild(footer);
  panel.appendChild(poweredBy);

  backdrop.appendChild(panel);
  shadow.appendChild(backdrop);

  return {
    backdrop,
    panel,
    title,
    elementInfo,
    selectorDisplay,
    textDisplay,
    labelText,
    textarea,
    charCount,
    priorityField,
    prioritySelect,
    screenshotLabel,
    screenshotCheckbox,
    recordingLabel,
    recordingCheckbox,
    modeSwitchBtn,
    submitBtn,
    cancelBtn,
    progressStatus,
    screenshotPreview,
  };
}

// --- iOS keyboard workaround: adjust panel when virtual keyboard opens ---
let viewportCleanup: (() => void) | null = null;

function setupViewportHandler(panel: HTMLDivElement): void {
  if (viewportCleanup) return;
  const vv = window.visualViewport;
  if (!vv) return; // Not supported (non-iOS or old browsers)

  function onResize() {
    if (!vv) return;
    // When keyboard opens, visualViewport.height shrinks
    // Adjust the panel max-height so it doesn't overflow behind the keyboard
    const offsetTop = vv.offsetTop;
    const height = vv.height;
    panel.style.height = `${height}px`;
    panel.style.top = `${offsetTop}px`;
  }

  function onScroll() {
    if (!vv) return;
    panel.style.top = `${vv.offsetTop}px`;
  }

  vv.addEventListener('resize', onResize);
  vv.addEventListener('scroll', onScroll);

  viewportCleanup = () => {
    vv.removeEventListener('resize', onResize);
    vv.removeEventListener('scroll', onScroll);
    panel.style.height = '';
    panel.style.top = '';
    viewportCleanup = null;
  };
}

function teardownViewportHandler(): void {
  if (viewportCleanup) viewportCleanup();
}

/**
 * Show the panel with the picked element info and optional pre-captured screenshot.
 */
export function showPanel(
  elements: PanelElements,
  picked: PickedElement,
  preScreenshot?: string | null,
): void {
  // Update user info (Marker.io/Usersnap pattern: show who's logged in)
  const user = getUser();
  if (user) {
    const initials = (user.name ?? user.email).slice(0, 2).toUpperCase();
    const avatarEl = elements.panel.querySelector('.scout-user-avatar');
    const nameEl = elements.panel.querySelector('.scout-user-name');
    if (avatarEl) avatarEl.textContent = initials;
    if (nameEl) nameEl.textContent = user.name ?? user.email;
  }

  elements.selectorDisplay.textContent = picked.cssSelector;
  elements.textDisplay.textContent = picked.elementText || t('panel.noText');
  elements.textarea.value = '';
  elements.textarea.classList.remove('error');
  elements.charCount.textContent = '0';
  elements.prioritySelect.value = 'medium';
  elements.screenshotCheckbox.checked = true;
  elements.submitBtn.disabled = false;
  elements.cancelBtn.disabled = false;

  // Recording checkbox: only enable if recording is available
  const recAvailable = isRecordingAvailable();
  elements.recordingCheckbox.checked = recAvailable;
  elements.recordingCheckbox.disabled = !recAvailable;

  // Show pre-captured screenshot preview or reset
  if (preScreenshot) {
    showScreenshotPreview(elements, preScreenshot);
  } else {
    elements.screenshotPreview.classList.add('hidden');
    elements.screenshotPreview.textContent = '';
  }
  elements.progressStatus.classList.add('hidden');
  elements.progressStatus.textContent = '';
  setPanelMode(elements, picked.itemType === 'note' ? 'note' : 'bug');

  elements.backdrop.style.display = '';
  elements.backdrop.classList.remove('hidden');
  void elements.backdrop.offsetHeight;
  elements.backdrop.classList.add('visible');
  elements.panel.classList.add('visible');

  // iOS keyboard fix: adjust panel when virtual keyboard opens
  setupViewportHandler(elements.panel);

  setTimeout(() => elements.textarea.focus(), 300);
}

/**
 * Hide the panel.
 */
export function hidePanel(elements: PanelElements): void {
  teardownViewportHandler();
  elements.panel.classList.remove('visible');
  elements.backdrop.classList.remove('visible');
  setTimeout(() => {
    elements.backdrop.classList.add('hidden');
  }, 250);
}

function setProgress(elements: PanelElements, text: string): void {
  elements.progressStatus.innerHTML = `<span class="scout-spinner scout-spinner-sm"></span>${text}`;
  elements.progressStatus.classList.remove('hidden');
}

/**
 * Show screenshot preview thumbnail in the panel.
 */
function showScreenshotPreview(elements: PanelElements, base64: string): void {
  elements.screenshotPreview.textContent = '';
  const img = document.createElement('img');
  img.src = `data:${SCREENSHOT_MIME};base64,${base64}`;
  img.alt = t('panel.screenshotAlt');
  img.className = 'scout-screenshot-img';
  elements.screenshotPreview.appendChild(img);
  elements.screenshotPreview.classList.remove('hidden');
}

function setPanelMode(elements: PanelElements, mode: PanelMode): void {
  elements.panel.dataset.mode = mode;
  const isNote = mode === 'note';
  elements.title.textContent = isNote ? t('panel.noteTitle') : t('panel.title');
  elements.labelText.textContent = (isNote ? t('panel.noteDescribe') : t('panel.describe')) + ' ';
  elements.textarea.placeholder = isNote ? t('panel.notePlaceholder') : t('panel.placeholder');
  elements.submitBtn.textContent = isNote ? t('panel.noteSubmit') : t('panel.submit');
  elements.elementInfo.classList.toggle('hidden', isNote);
  elements.priorityField.classList.toggle('hidden', isNote);
  elements.screenshotLabel.classList.toggle('hidden', isNote);
  elements.recordingLabel.classList.toggle('hidden', isNote);
  elements.screenshotPreview.classList.toggle('hidden', isNote || elements.screenshotPreview.childElementCount === 0);
  elements.modeSwitchBtn.textContent = isNote ? t('panel.bugSwitch') : t('panel.noteSwitch');
}

/**
 * Wire up submit and cancel events for the panel.
 */
export function attachPanelEvents(
  elements: PanelElements,
  apiUrl: string,
  projectSlug: string,
  picked: () => PickedElement | null,
  getPreScreenshot: () => string | null,
  callbacks: PanelCallbacks,
): void {
  elements.cancelBtn.addEventListener('click', () => {
    hidePanel(elements);
    callbacks.onClose();
  });

  const closeBtn = elements.panel.querySelector('.scout-panel-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      hidePanel(elements);
      callbacks.onClose();
    });
  }

  // Logout button
  const logoutBtn = elements.panel.querySelector('.scout-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      clearAuth();
      resetProjectCache();
      hidePanel(elements);
      callbacks.onLogout();
    });
  }

  elements.modeSwitchBtn.addEventListener('click', () => {
    const mode = elements.panel.dataset.mode === 'note' ? 'note' : 'bug';
    if (mode === 'bug') {
      setPanelMode(elements, 'note');
      return;
    }

    const p = picked();
    if (p?.cssSelector) {
      setPanelMode(elements, 'bug');
    } else {
      hidePanel(elements);
      callbacks.onClose();
    }
  });

  elements.submitBtn.addEventListener('click', async () => {
    const p = picked();
    if (!p) return;
    const mode: PanelMode = elements.panel.dataset.mode === 'note' ? 'note' : 'bug';

    const message = elements.textarea.value.trim();
    if (message.length < 3) {
      elements.textarea.classList.add('error');
      elements.textarea.focus();
      return;
    }

    // Disable controls
    elements.submitBtn.disabled = true;
    elements.cancelBtn.disabled = true;
    elements.submitBtn.textContent = '';
    const btnSpinner = document.createElement('span');
    btnSpinner.className = 'scout-spinner';
    elements.submitBtn.appendChild(btnSpinner);
    elements.submitBtn.appendChild(document.createTextNode(t('panel.preparing')));

    try {
      const token = await ensureToken(apiUrl);
      if (!token) throw new Error(t('error.unauthorized'));

      // Step 1: Resolve project
      setProgress(elements, t('panel.connecting'));
      const projectId = await resolveProjectId(apiUrl, projectSlug);

      // Step 2: Use pre-captured screenshot (if checkbox is still checked)
      const screenshot = mode === 'bug' && elements.screenshotCheckbox.checked
        ? getPreScreenshot() ?? undefined
        : undefined;

      // Step 3: Serialize + compress recording (fflate gzip)
      let sessionRecording: string | undefined;
      if (mode === 'bug' && elements.recordingCheckbox.checked) {
        setProgress(elements, t('panel.compressing'));
        elements.submitBtn.textContent = t('panel.recording_progress');

        const result = getRecordingCompressed();
        if (result !== null) {
          sessionRecording = result;
        }
      }

      // Step 4: Send with retry (exponential backoff: 1s, 2s, 4s)
      setProgress(elements, t('panel.uploading'));
      elements.submitBtn.textContent = t('panel.sending');

      // Auto-capture environment metadata (Marker.io/Usersnap pattern)
      const metadata = collectMetadata();
      const debugContext = getDebugContextPayload(getRecordingSummary(Boolean(sessionRecording)));

      const body = {
        projectId,
        itemType: mode,
        message,
        dedupeKey: createDedupeKey(),
        pageUrl: p.pageUrl,
        viewportWidth: p.viewportWidth,
        viewportHeight: p.viewportHeight,
        metadata,
        debugContext,
        ...(mode === 'bug' ? {
          priority: elements.prioritySelect.value,
          cssSelector: p.cssSelector,
          elementText: p.elementText,
          elementHtml: p.elementHtml,
          screenshot,
          sessionRecording,
        } : {}),
      };

      const res = await fetchWithRetry(
        `${apiUrl}/api/items/create`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        },
        (attempt, max) => {
          setProgress(elements, t('panel.retrying', { attempt: String(attempt), max: String(max) }));
        },
      );

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        if (res.status === 401) {
          clearAuth();
          resetProjectCache();
          throw new Error(t('error.sessionExpired'));
        }
        throw new Error(errBody?.error ?? errBody?.message ?? t('error.submitFailed', { status: String(res.status) }));
      }

      // Success
      if (mode === 'bug') resetBuffer();
      hidePanel(elements);
      callbacks.onSubmitSuccess(mode);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('error.unknown');
      elements.submitBtn.disabled = false;
      elements.cancelBtn.disabled = false;
      elements.submitBtn.textContent = mode === 'note' ? t('panel.noteSubmit') : t('panel.submit');
      elements.progressStatus.classList.add('hidden');
      callbacks.onSubmitError(msg);
    }
  });
}
