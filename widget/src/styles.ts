export const WIDGET_STYLES = `
  :host {
    all: initial;
    /* Neutralise the UA styles that come with [popover]: it is a top-layer
       anchor for fixed-position children, not a box of its own. */
    position: fixed;
    top: 0;
    left: 0;
    right: auto;
    bottom: auto;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    display: block;
    width: 0;
    height: 0;
    overflow: visible;
    pointer-events: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    font-size: 14px;
    color: #111827;
    line-height: 1.5;
    box-sizing: border-box;
    --safe-top: env(safe-area-inset-top, 0px);
    --safe-bottom: env(safe-area-inset-bottom, 0px);
    --safe-left: env(safe-area-inset-left, 0px);
    --safe-right: env(safe-area-inset-right, 0px);
  }

  *, *::before, *::after {
    box-sizing: border-box;
  }

  .hidden {
    display: none !important;
  }

  .scout-fab,
  .scout-overlay,
  .scout-panel-backdrop,
  .scout-panel,
  .scout-loading-overlay {
    pointer-events: auto;
  }

  /* FAB */
  .scout-fab {
    position: fixed;
    bottom: calc(20px + var(--safe-bottom));
    right: calc(20px + var(--safe-right));
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: #3b82f6;
    color: #fff;
    border: none;
    cursor: grab;
    z-index: 999999;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 12px rgba(59, 130, 246, 0.32);
    opacity: 0.82;
    transition: opacity 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease, top 0.18s ease, right 0.18s ease, bottom 0.18s ease, left 0.18s ease;
    font-size: 0;
    line-height: 0;
    padding: 0;
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
  }

  .scout-fab:hover {
    transform: scale(1.08);
    box-shadow: 0 6px 18px rgba(59, 130, 246, 0.42);
    opacity: 1;
  }

  .scout-fab.dragging {
    cursor: grabbing;
    opacity: 0.9;
    transition: none;
  }

  .scout-fab:active {
    transform: scale(0.96);
  }

  .scout-fab svg {
    width: 24px;
    height: 24px;
    fill: none;
    stroke: #fff;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .scout-fab.hidden {
    display: none;
  }

  /* Overlay (element picker) */
  .scout-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000000;
    cursor: crosshair;
    background: rgba(59, 130, 246, 0.05);
    touch-action: none;
  }

  .scout-overlay.hidden {
    display: none;
  }

  .scout-highlight {
    position: fixed;
    border: 2px solid #3b82f6;
    background: rgba(59, 130, 246, 0.08);
    pointer-events: none;
    z-index: 1000001;
    border-radius: 2px;
    transition: top 0.05s ease, left 0.05s ease, width 0.05s ease, height 0.05s ease;
  }

  .scout-highlight.hidden {
    display: none;
  }

  /* Picker instruction banner */
  .scout-picker-banner {
    position: fixed;
    left: 50%;
    right: auto;
    bottom: calc(16px + var(--safe-bottom));
    z-index: 1000002;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: min(calc(100vw - 32px - var(--safe-left) - var(--safe-right)), 760px);
    padding: 10px 10px 10px 12px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 16px;
    background: rgba(15, 23, 42, 0.96);
    backdrop-filter: blur(8px);
    color: #fff;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 18px 45px rgba(15, 23, 42, 0.35);
    opacity: 0;
    pointer-events: none;
    transform: translate(-50%, calc(100% + 24px));
    transition: opacity 0.2s ease, transform 0.2s ease;
  }

  .scout-picker-banner.visible {
    opacity: 1;
    transform: translate(-50%, 0);
  }

  .scout-picker-banner-head {
    display: flex;
    align-items: center;
    flex: 1;
    gap: 8px;
    min-width: 0;
  }

  .scout-picker-banner-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    font-family: inherit;
    cursor: default;
    pointer-events: none;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }

  .scout-picker-banner-text {
    min-width: 0;
    line-height: 1.35;
  }

  .scout-picker-banner-actions {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    gap: 6px;
    pointer-events: auto;
  }

  .scout-picker-banner-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    opacity: 0.8;
  }

  .scout-picker-banner-cancel {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.15);
    border: none;
    color: #fff;
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    min-height: 36px;
    white-space: nowrap;
  }

  .scout-picker-banner-note {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #fff;
    border: none;
    color: #1e293b;
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    min-height: 36px;
    white-space: nowrap;
  }

  .scout-picker-banner-note:active {
    background: #e2e8f0;
  }

  .scout-picker-banner-cancel:active {
    background: rgba(255, 255, 255, 0.25);
  }

  @media (max-width: 640px) {
    .scout-picker-banner {
      bottom: calc(10px + var(--safe-bottom));
      width: calc(100vw - 20px - var(--safe-left) - var(--safe-right));
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
      padding: 10px;
    }

    .scout-picker-banner-text {
      font-size: 13px;
    }

    .scout-picker-banner-actions {
      width: 100%;
    }

    .scout-picker-banner-note,
    .scout-picker-banner-cancel {
      flex: 1;
      justify-content: center;
    }

    /* Collapsed to an icon so the picker can reach the bottom of the page */
    .scout-picker-banner-toggle {
      width: 32px;
      height: 32px;
      background: rgba(255, 255, 255, 0.14);
      cursor: pointer;
      pointer-events: auto;
    }

    .scout-picker-banner-toggle:active {
      background: rgba(255, 255, 255, 0.26);
    }

    .scout-picker-banner.collapsed {
      left: auto;
      right: calc(10px + var(--safe-right));
      width: 52px;
      height: 52px;
      padding: 0;
      border-radius: 50%;
      transform: translate(0, calc(100% + 24px));
    }

    .scout-picker-banner.collapsed.visible {
      transform: translate(0, 0);
    }

    .scout-picker-banner.collapsed .scout-picker-banner-text,
    .scout-picker-banner.collapsed .scout-picker-banner-actions {
      display: none;
    }

    .scout-picker-banner.collapsed .scout-picker-banner-head {
      justify-content: center;
    }

    .scout-picker-banner.collapsed .scout-picker-banner-toggle {
      width: 100%;
      height: 100%;
      background: transparent;
    }

    .scout-picker-banner.collapsed .scout-picker-banner-icon {
      width: 22px;
      height: 22px;
      opacity: 1;
    }
  }

  /* Loading overlay (between element pick and panel open) */
  .scout-loading-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000002;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .scout-loading-overlay.visible {
    opacity: 1;
  }

  .scout-loading-overlay.hidden {
    display: none;
  }

  .scout-loading-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    background: #fff;
    padding: 32px 40px;
    border-radius: 16px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
  }

  .scout-loading-spinner {
    width: 36px;
    height: 36px;
    border: 3px solid #e5e7eb;
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: scout-spin 0.7s linear infinite;
  }

  .scout-loading-text {
    font-size: 14px;
    font-weight: 500;
    color: #374151;
  }

  /* Panel */
  .scout-panel-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    z-index: 1000002;
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .scout-panel-backdrop.visible {
    opacity: 1;
  }

  .scout-panel-backdrop.hidden {
    display: none;
  }

  .scout-panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 400px;
    max-width: 100vw;
    background: #fff;
    z-index: 1000003;
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.15);
    transform: translateX(100%);
    transition: transform 0.25s ease;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .scout-panel.visible {
    transform: translateX(0);
  }

  .scout-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid #e5e7eb;
    flex-shrink: 0;
  }

  .scout-panel-header h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: #111827;
  }

  .scout-panel-close {
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px;
    color: #6b7280;
    line-height: 0;
    min-width: 44px;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    touch-action: manipulation;
  }

  .scout-panel-close:hover {
    color: #111827;
  }

  .scout-panel-close svg {
    width: 20px;
    height: 20px;
    stroke: currentColor;
    stroke-width: 2;
    fill: none;
  }

  .scout-panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
  }

  .scout-element-info {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 16px;
  }

  .scout-element-info-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #6b7280;
    margin-bottom: 4px;
    font-weight: 500;
  }

  .scout-element-info-value {
    font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
    font-size: 13px;
    color: #3b82f6;
    word-break: break-all;
    margin-bottom: 8px;
  }

  .scout-element-info-value:last-child {
    margin-bottom: 0;
  }

  .scout-element-text {
    font-family: inherit;
    font-size: 13px;
    color: #374151;
    font-style: italic;
  }

  .scout-field {
    margin-bottom: 16px;
  }

  .scout-field label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: #374151;
    margin-bottom: 6px;
  }

  .scout-field label .scout-required {
    color: #ef4444;
  }

  .scout-field textarea {
    width: 100%;
    min-height: 100px;
    padding: 10px 12px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    font-size: 16px;
    font-family: inherit;
    resize: vertical;
    color: #111827;
    background: #fff;
    outline: none;
    transition: border-color 0.15s ease;
  }

  .scout-field textarea:focus {
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  .scout-field textarea.error {
    border-color: #ef4444;
  }

  .scout-field .scout-char-count {
    font-size: 11px;
    color: #9ca3af;
    text-align: right;
    margin-top: 4px;
  }

  .scout-mode-switch {
    display: inline-flex;
    margin: -4px 0 16px;
    padding: 0;
    border: none;
    background: transparent;
    color: #2563eb;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }

  .scout-mode-switch:hover {
    color: #1d4ed8;
    text-decoration: underline;
  }

  .scout-checkbox {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    cursor: pointer;
    font-size: 13px;
    color: #374151;
    min-height: 44px;
  }

  .scout-checkbox input[type="checkbox"]:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Screenshot preview (professional pattern: show before sending) */
  .scout-screenshot-preview {
    margin-top: 12px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    overflow: hidden;
    background: #f9fafb;
  }

  .scout-screenshot-preview.hidden {
    display: none;
  }

  .scout-screenshot-img {
    display: block;
    width: 100%;
    max-height: 160px;
    object-fit: cover;
    object-position: top left;
  }

  .scout-checkbox input[type="checkbox"] {
    width: 20px;
    height: 20px;
    accent-color: #3b82f6;
    cursor: pointer;
    flex-shrink: 0;
  }

  .scout-panel-footer {
    display: flex;
    gap: 8px;
    padding: 16px 20px;
    border-top: 1px solid #e5e7eb;
    flex-shrink: 0;
  }

  .scout-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    border: none;
    transition: background 0.15s ease, opacity 0.15s ease;
    font-family: inherit;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }

  .scout-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .scout-btn-primary {
    background: #3b82f6;
    color: #fff;
    flex: 1;
  }

  .scout-btn-primary:hover:not(:disabled) {
    background: #2563eb;
  }

  .scout-btn-secondary {
    background: #f3f4f6;
    color: #374151;
  }

  .scout-btn-secondary:hover:not(:disabled) {
    background: #e5e7eb;
  }

  /* User info bar (between header and body) */
  .scout-user-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 20px;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
    flex-shrink: 0;
  }

  .scout-user-info {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .scout-user-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: #3b82f6;
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    letter-spacing: 0.5px;
  }

  .scout-user-name {
    font-size: 13px;
    font-weight: 500;
    color: #374151;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .scout-logout-btn {
    background: none;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 4px 12px;
    font-size: 12px;
    color: #6b7280;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
    transition: background 0.15s ease, color 0.15s ease;
    touch-action: manipulation;
  }

  .scout-logout-btn:hover {
    background: #fee2e2;
    color: #dc2626;
    border-color: #fca5a5;
  }

  /* "Powered by Scout" badge (industry standard) */
  .scout-powered-by {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 20px;
    font-size: 11px;
    color: #9ca3af;
    border-top: 1px solid #f3f4f6;
    flex-shrink: 0;
    letter-spacing: 0.02em;
  }

  .scout-powered-by svg {
    color: #9ca3af;
  }

  /* Login form */
  .scout-login {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overscroll-behavior: contain;
  }

  .scout-login h3 {
    margin: 0 0 4px 0;
    font-size: 16px;
    font-weight: 600;
    color: #111827;
  }

  .scout-login p {
    margin: 0 0 8px 0;
    font-size: 13px;
    color: #6b7280;
  }

  .scout-input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    font-size: 16px;
    font-family: inherit;
    color: #111827;
    background: #fff;
    outline: none;
    transition: border-color 0.15s ease;
    min-height: 44px;
  }

  .scout-input:focus {
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  .scout-login-error {
    color: #ef4444;
    font-size: 13px;
    margin: 0;
    min-height: 18px;
  }

  /* Toast */
  /* Always in the DOM and only faded in, so it must never take a page click:
     as an interactive element it swallowed a strip along the bottom of the page. */
  .scout-toast {
    pointer-events: none;
    position: fixed;
    bottom: calc(92px + var(--safe-bottom));
    right: calc(24px + var(--safe-right));
    background: #22c55e;
    color: #fff;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 4px 12px rgba(34, 197, 94, 0.3);
    z-index: 1000010;
    opacity: 0;
    transform: translateY(10px);
    transition: opacity 0.2s ease, transform 0.2s ease;
  }

  .scout-toast.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .scout-toast-icon {
    width: 18px;
    height: 18px;
    margin-right: 8px;
    vertical-align: -3px;
    flex-shrink: 0;
  }

  .scout-toast.error {
    background: #ef4444;
    box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
  }

  /* Spinner */
  .scout-spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: scout-spin 0.6s linear infinite;
    margin-right: 8px;
    flex-shrink: 0;
  }

  .scout-spinner-sm {
    width: 14px;
    height: 14px;
    border-color: rgba(59, 130, 246, 0.2);
    border-top-color: #3b82f6;
  }

  @keyframes scout-spin {
    to { transform: rotate(360deg); }
  }

  /* Progress status (step-by-step indicator during submission) */
  .scout-progress-status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    margin-top: 12px;
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    border-radius: 8px;
    font-size: 13px;
    color: #1d4ed8;
    animation: scout-fade-in 0.2s ease;
  }

  .scout-progress-status.hidden {
    display: none;
  }

  .scout-progress-warn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #f59e0b;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
  }

  @keyframes scout-fade-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* ===== Mobile (max-width: 640px) ===== */
  @media (max-width: 640px) {
    /* FAB: smaller + tighter offset */
    .scout-fab {
      width: 48px;
      height: 48px;
      bottom: calc(16px + var(--safe-bottom));
      right: calc(16px + var(--safe-right));
    }

    .scout-fab svg {
      width: 24px;
      height: 24px;
    }

    /* Panel: full-screen overlay */
    .scout-panel {
      width: 100%;
      height: 100%;
      max-height: 100%;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      border-radius: 0;
      box-shadow: none;
    }

    .scout-panel-header {
      padding-top: calc(16px + var(--safe-top));
      padding-left: calc(20px + var(--safe-left));
      padding-right: calc(20px + var(--safe-right));
    }

    .scout-user-bar {
      padding-left: calc(20px + var(--safe-left));
      padding-right: calc(20px + var(--safe-right));
    }

    .scout-panel-body {
      padding-left: calc(20px + var(--safe-left));
      padding-right: calc(20px + var(--safe-right));
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
    }

    .scout-panel-footer {
      padding-bottom: calc(16px + var(--safe-bottom));
      padding-left: calc(20px + var(--safe-left));
      padding-right: calc(20px + var(--safe-right));
      flex-direction: column;
    }

    .scout-panel-footer .scout-btn {
      width: 100%;
      min-height: 48px;
      font-size: 16px;
    }

    .scout-panel-footer .scout-btn-secondary {
      flex: none;
    }

    /* Textarea taller on mobile */
    .scout-field textarea {
      min-height: 120px;
    }

    /* Inputs: prevent iOS zoom (font-size >= 16px already set), ensure touch targets */
    .scout-input {
      min-height: 48px;
      font-size: 16px;
    }

    /* Login form: use safe area */
    .scout-login {
      padding: 20px calc(20px + var(--safe-left)) 20px calc(20px + var(--safe-right));
    }

    .scout-login .scout-btn {
      min-height: 48px;
      font-size: 16px;
    }

    /* Checkboxes: larger touch targets */
    .scout-checkbox {
      min-height: 48px;
      padding: 4px 0;
    }

    .scout-checkbox input[type="checkbox"] {
      width: 24px;
      height: 24px;
    }

    /* Element picker: thicker highlight border on mobile */
    .scout-highlight {
      border-width: 3px;
    }

    /* Toast: centered on mobile */
    .scout-toast {
      right: calc(16px + var(--safe-right));
      left: calc(16px + var(--safe-left));
      bottom: calc(76px + var(--safe-bottom));
      text-align: center;
    }
  }
`;
