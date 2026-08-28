import { WIDGET_STYLES } from './styles';
import { ensureToken, getToken, login, initSSO, tryPopupSSO } from './auth';
import { setVendorBase } from './vendor/load';
import { createFab, showFab, hideFab } from './fab';
import { pickElement, type PickedElement } from './element-picker';
import { createPanel, showPanel, hidePanel, attachPanelEvents, type PanelCallbacks } from './panel';
import { captureScreenshot } from './screenshot';
import { startRecording, pauseRecording, resumeRecording } from './recorder';
import { startDebugContextCapture } from './debug-context';
import { t } from './i18n';

interface ScoutConfig {
  apiUrl: string;
  projectSlug: string;
  /** Set to false to disable widget. Default: true. Override with ?scout=1 in URL. */
  enabled?: boolean;
}

declare global {
  interface Window {
    __SCOUT_CONFIG__?: ScoutConfig;
  }
}

function ensureViewportFitCover(): void {
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta) {
    const content = meta.getAttribute('content') || '';
    if (!content.includes('viewport-fit')) {
      meta.setAttribute('content', content + ', viewport-fit=cover');
    }
  } else {
    const newMeta = document.createElement('meta');
    newMeta.name = 'viewport';
    newMeta.content = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
    document.head.appendChild(newMeta);
  }
}

async function init(): Promise<void> {
  const config = window.__SCOUT_CONFIG__;
  if (!config?.apiUrl || !config?.projectSlug) {
    console.warn('[Scout] Missing window.__SCOUT_CONFIG__ (apiUrl, projectSlug)');
    return;
  }

  // Visibility control: config.enabled + URL override ?scout=1
  const urlOverride = new URLSearchParams(window.location.search).get('scout') === '1';
  if (config.enabled === false && !urlOverride) {
    return; // Widget disabled by config, no URL override
  }

  // Ensure viewport-fit=cover for safe area insets (CapacitorJS)
  ensureViewportFitCover();

  const { apiUrl, projectSlug } = config;

  // The recorder and the screenshot library are fetched from the same place this script came from.
  setVendorBase(apiUrl);

  // --- Cross-domain SSO: fetch token from the configured Scout API via iframe ---
  await initSSO(apiUrl);

  // --- Shadow DOM setup ---
  const host = document.createElement('div');
  host.id = 'scout-widget-root';
  host.style.cssText = 'display:block;width:0;height:0;overflow:visible;pointer-events:none';

  document.body.appendChild(host);

  // Host pages stack their own modals with ever larger z-index values - one of
  // them already sat a single step above the widget and hid the button. The top
  // layer is above every z-index there is, so the widget stops competing on
  // numbers. A manual popover joins it without making the page inert.
  if ('popover' in HTMLElement.prototype) {
    host.setAttribute('popover', 'manual');
    host.showPopover();
  }
  const shadow = host.attachShadow({ mode: 'open' });

  // Inject styles
  const styleEl = document.createElement('style');
  styleEl.textContent = WIDGET_STYLES;
  shadow.appendChild(styleEl);

  // --- Start rrweb recorder ---
  // Only for a visitor who already holds a Scout session. The recording exists to show what happened
  // before a report, and a report cannot be filed without signing in; downloading the recorder for
  // everyone else spent a fifth of a megabyte on a buffer nobody would ever submit.
  if (getToken()) void startRecording();
  startDebugContextCapture({ scoutRootId: 'scout-widget-root', apiUrl });

  // --- Create overlay for element picker ---
  const overlay = document.createElement('div');
  overlay.className = 'scout-overlay hidden';
  shadow.appendChild(overlay);

  const highlight = document.createElement('div');
  highlight.className = 'scout-highlight hidden';
  shadow.appendChild(highlight);

  // --- Create toast ---
  const toast = document.createElement('div');
  toast.className = 'scout-toast';
  shadow.appendChild(toast);

  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function showToast(message: string, isError = false): void {
    if (toastTimer) clearTimeout(toastTimer);
    // Success toast: checkmark icon (industry standard — Marker.io, Usersnap, Gleap)
    if (!isError) {
      toast.innerHTML = `<svg class="scout-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>${message}`;
    } else {
      toast.textContent = message;
    }
    toast.classList.toggle('error', isError);
    toast.classList.add('visible');
    toastTimer = setTimeout(() => {
      toast.classList.remove('visible');
    }, 3000);
  }

  // --- Create login form container ---
  const loginContainer = document.createElement('div');
  loginContainer.className = 'scout-panel-backdrop hidden';
  const loginPanel = document.createElement('div');
  loginPanel.className = 'scout-panel';

  const loginHeader = document.createElement('div');
  loginHeader.className = 'scout-panel-header';
  const loginTitle = document.createElement('h2');
  loginTitle.textContent = t('login.title');
  const loginCloseBtn = document.createElement('button');
  loginCloseBtn.className = 'scout-panel-close';
  loginCloseBtn.setAttribute('aria-label', 'Close');
  loginCloseBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
  loginHeader.appendChild(loginTitle);
  loginHeader.appendChild(loginCloseBtn);

  const loginBody = document.createElement('div');
  loginBody.className = 'scout-login';

  const loginSubtitle = document.createElement('h3');
  loginSubtitle.textContent = t('login.subtitle');

  const loginDesc = document.createElement('p');
  loginDesc.textContent = t('login.description');

  const emailInput = document.createElement('input');
  emailInput.className = 'scout-input';
  emailInput.type = 'email';
  emailInput.placeholder = t('login.email');
  emailInput.autocomplete = 'email';

  const passwordInput = document.createElement('input');
  passwordInput.className = 'scout-input';
  passwordInput.type = 'password';
  passwordInput.placeholder = t('login.password');
  passwordInput.autocomplete = 'current-password';

  const loginError = document.createElement('p');
  loginError.className = 'scout-login-error';

  const loginBtn = document.createElement('button');
  loginBtn.className = 'scout-btn scout-btn-primary';
  loginBtn.textContent = t('login.button');

  loginBody.appendChild(loginSubtitle);
  loginBody.appendChild(loginDesc);
  loginBody.appendChild(emailInput);
  loginBody.appendChild(passwordInput);
  loginBody.appendChild(loginError);
  loginBody.appendChild(loginBtn);

  loginPanel.appendChild(loginHeader);
  loginPanel.appendChild(loginBody);
  loginContainer.appendChild(loginPanel);
  shadow.appendChild(loginContainer);

  function showLoginForm(): void {
    emailInput.value = '';
    passwordInput.value = '';
    loginError.textContent = '';
    loginBtn.disabled = false;
    loginBtn.textContent = t('login.button');
    loginContainer.classList.remove('hidden');
    void loginContainer.offsetHeight;
    loginContainer.classList.add('visible');
    loginPanel.classList.add('visible');
    setTimeout(() => emailInput.focus(), 300);
  }

  function hideLoginForm(): void {
    loginPanel.classList.remove('visible');
    loginContainer.classList.remove('visible');
    setTimeout(() => loginContainer.classList.add('hidden'), 250);
  }

  async function handleLogin(): Promise<boolean> {
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      loginError.textContent = t('login.required');
      return false;
    }

    loginBtn.disabled = true;
    loginBtn.textContent = '';
    const spinner = document.createElement('span');
    spinner.className = 'scout-spinner';
    loginBtn.appendChild(spinner);
    loginBtn.appendChild(document.createTextNode(t('login.loading')));
    loginError.textContent = '';

    try {
      await login(apiUrl, email, password);
      hideLoginForm();
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('login.error');
      loginError.textContent = msg;
      loginBtn.disabled = false;
  loginBtn.textContent = t('login.button');
      return false;
    }
  }

  loginBtn.addEventListener('click', async () => {
    const ok = await handleLogin();
    if (ok) {
      startScoutMode();
    }
  });

  // Enter key in password field triggers login
  passwordInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const ok = await handleLogin();
      if (ok) {
        startScoutMode();
      }
    }
  });

  loginCloseBtn.addEventListener('click', () => {
    hideLoginForm();
    showFab(fab);
  });

  // ESC to close login
  function onLoginEsc(e: KeyboardEvent): void {
    if (e.key === 'Escape' && !loginContainer.classList.contains('hidden')) {
      hideLoginForm();
      showFab(fab);
    }
  }
  document.addEventListener('keydown', onLoginEsc, true);

  // --- Loading overlay (shown between element pick and panel open) ---
  const loadingOverlay = document.createElement('div');
  loadingOverlay.className = 'scout-loading-overlay hidden';

  const loadingContent = document.createElement('div');
  loadingContent.className = 'scout-loading-content';

  const loadingSpinner = document.createElement('div');
  loadingSpinner.className = 'scout-loading-spinner';

  const loadingText = document.createElement('div');
  loadingText.className = 'scout-loading-text';
  loadingText.textContent = t('loading.screenshot');

  loadingContent.appendChild(loadingSpinner);
  loadingContent.appendChild(loadingText);
  loadingOverlay.appendChild(loadingContent);
  shadow.appendChild(loadingOverlay);

  function showLoading(text: string): void {
    loadingText.textContent = text;
    loadingOverlay.classList.remove('hidden');
    requestAnimationFrame(() => loadingOverlay.classList.add('visible'));
  }

  function hideLoading(): void {
    loadingOverlay.classList.remove('visible');
    setTimeout(() => loadingOverlay.classList.add('hidden'), 200);
  }

  // --- Create panel ---
  const panelElements = createPanel(shadow);
  let currentPicked: PickedElement | null = null;
  let preScreenshot: string | null = null;

  const panelCallbacks: PanelCallbacks = {
    onClose: () => {
      currentPicked = null;
      preScreenshot = null;
      resumeRecording();
      showFab(fab);
    },
    onSubmitSuccess: (mode) => {
      currentPicked = null;
      preScreenshot = null;
      resumeRecording();
      showFab(fab);
      showToast(t(mode === 'note' ? 'toast.noteSuccess' : 'toast.success'));
    },
    onSubmitError: (msg: string) => {
      showToast(msg, true);
    },
    onLogout: () => {
      currentPicked = null;
      preScreenshot = null;
      resumeRecording();
      showFab(fab);
      showToast(t('toast.logout'));
    },
  };

  attachPanelEvents(
    panelElements,
    apiUrl,
    projectSlug,
    () => currentPicked,
    () => preScreenshot,
    panelCallbacks,
  );

  // ESC to close panel
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panelElements.backdrop.classList.contains('hidden')) {
      hidePanel(panelElements);
      panelCallbacks.onClose();
    }
  }, true);

  // --- Scout mode ---
  async function startScoutMode(): Promise<void> {
    hideFab(fab);
    pauseRecording(); // Stop recording Scout UI interactions

    const picked = await pickElement(shadow, overlay, highlight);

    if (!picked) {
      // Cancelled
      resumeRecording();
      showFab(fab);
      return;
    }

    if (picked.itemType === 'note') {
      preScreenshot = null;
    } else {
      // Pre-capture screenshot with loading indicator (before panel opens)
      showLoading(t('loading.screenshot'));
      preScreenshot = await captureScreenshot(picked.cssSelector);
      hideLoading();
    }

    currentPicked = picked;
    showPanel(panelElements, picked, preScreenshot);
  }

  // --- Create FAB ---
  let fabBusy = false; // Prevent double-click opening multiple popups

  const fab = createFab(async () => {
    if (fabBusy) return;

    const token = await ensureToken(apiUrl);
    if (token) {
      startScoutMode();
      return;
    }

    // No token — try popup SSO first (cross-domain, all browsers). Inside a native WebView there is no
    // popup to answer, so this returns at once and the inline form takes over.
    fabBusy = true;
    hideFab(fab);
    let ssoOk = false;
    try {
      ssoOk = await tryPopupSSO(apiUrl);
    } finally {
      fabBusy = false;
      // The button must never stay hidden waiting for an answer: that left the widget unreachable
      // until the app was restarted.
      if (!ssoOk) showFab(fab);
    }

    if (ssoOk) {
      startScoutMode();
      return;
    }

    // Popup blocked, closed, or unanswerable — fall back to inline login
    showLoginForm();
  });
  shadow.appendChild(fab);

  // --- Keyboard shortcut: Ctrl+Shift+K to open (like Marker.io) ---
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'K') {
      e.preventDefault();
      // Only trigger if FAB is visible (widget is idle)
      if (!fab.classList.contains('hidden')) {
        fab.click();
      }
    }
  });
}

// --- Auto-init ---
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
