import { loadScreenshotVendor } from './vendor/load';

/**
 * Screenshot capture using html2canvas-pro.
 *
 * html2canvas-pro is a maintained fork that supports oklch, oklab, lab, lch,
 * color-mix, and other modern CSS color functions natively — no sanitization needed.
 *
 * Cross-origin iframes (SSO bridge, analytics, etc.) are replaced with placeholder
 * divs before capture to avoid Safari's "Blocked a frame" SecurityError.
 *
 * Returns base64-encoded JPEG string (without data: prefix), or null on failure.
 */

const SCREENSHOT_TIMEOUT_MS = 8_000;
const JPEG_QUALITY = 0.85;

/** Detect iOS Safari */
function isIOSSafari(): boolean {
  const ua = navigator?.userAgent ?? '';
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (/Macintosh/i.test(ua) && navigator?.maxTouchPoints > 1) return true;
  return false;
}

// ============================================================
// Cross-origin iframe handling
// ============================================================

interface ReplacedIframe {
  iframe: HTMLIFrameElement;
  placeholder: HTMLDivElement;
  parent: Node;
}

/**
 * Replace cross-origin iframes with gray placeholder divs.
 * Must be called BEFORE html2canvas — Safari blocks DOM cloning of cross-origin iframes.
 */
function replaceCrossOriginIframes(): ReplacedIframe[] {
  const replaced: ReplacedIframe[] = [];

  document.querySelectorAll('iframe').forEach((iframe) => {
    let isCrossOrigin = false;
    try {
      if (!iframe.contentDocument) isCrossOrigin = true;
    } catch {
      isCrossOrigin = true;
    }

    if (isCrossOrigin && iframe.parentNode) {
      const rect = iframe.getBoundingClientRect();
      const placeholder = document.createElement('div');
      // Only show visible placeholder for visible iframes
      if (rect.width > 0 && rect.height > 0) {
        placeholder.style.cssText = `width:${rect.width}px;height:${rect.height}px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:4px;`;
      } else {
        placeholder.style.cssText = iframe.style.cssText;
      }

      const parent = iframe.parentNode;
      parent.replaceChild(placeholder, iframe);
      replaced.push({ iframe, placeholder, parent });
    }
  });

  return replaced;
}

/** Restore original iframes from placeholders (no reload — same element re-inserted) */
function restoreIframes(replaced: ReplacedIframe[]): void {
  for (const { iframe, placeholder, parent } of replaced) {
    try {
      parent.replaceChild(iframe, placeholder);
    } catch {
      // Placeholder may have been removed — re-append iframe
      try { parent.appendChild(iframe); } catch { /* give up */ }
    }
  }
}

// ============================================================
// Screenshot capture
// ============================================================

export async function captureScreenshot(highlightSelector?: string): Promise<string | null> {
  let highlightOverlay: HTMLDivElement | null = null;
  let replacedIframes: ReplacedIframe[] = [];

  // Fetch the library before touching the page: the cross-origin iframes below are swapped for
  // placeholders, and waiting on a download with those in place would show the reporter a broken
  // page for as long as it takes.
  let html2canvas: Awaited<ReturnType<typeof loadScreenshotVendor>>['html2canvas'];
  try {
    ({ html2canvas } = await loadScreenshotVendor());
  } catch (err) {
    console.warn('[Scout] Screenshot library failed to load:', err);
    return null;
  }

  // Add element highlight overlay
  if (highlightSelector) {
    try {
      const el = document.querySelector(highlightSelector);
      if (el) {
        const rect = el.getBoundingClientRect();
        const absTop = rect.top + window.scrollY;
        const absLeft = rect.left + window.scrollX;

        highlightOverlay = document.createElement('div');
        highlightOverlay.setAttribute('data-scout-highlight', 'true');
        highlightOverlay.style.cssText = `
          position: absolute;
          top: ${absTop - 3}px;
          left: ${absLeft - 3}px;
          width: ${rect.width + 6}px;
          height: ${rect.height + 6}px;
          border: 3px solid #ef4444;
          border-radius: 4px;
          background: rgba(239, 68, 68, 0.08);
          pointer-events: none;
          z-index: 999998;
          box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.3);
        `;
        document.body.appendChild(highlightOverlay);
      }
    } catch {
      // Invalid selector — skip highlighting
    }
  }

  try {
    // Replace cross-origin iframes BEFORE html2canvas touches the DOM
    replacedIframes = replaceCrossOriginIframes();

    const ios = isIOSSafari();
    const captureWidth = ios
      ? window.innerWidth
      : Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, window.innerWidth);
    const captureHeight = ios
      ? window.innerHeight
      : Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, window.innerHeight);
    const scrollX = ios ? window.scrollX : 0;
    const scrollY = ios ? window.scrollY : 0;

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Screenshot timeout')), SCREENSHOT_TIMEOUT_MS),
    );

    const canvas = await Promise.race([
      html2canvas(document.documentElement, {
        width: captureWidth,
        height: captureHeight,
        windowWidth: captureWidth,
        windowHeight: captureHeight,
        scrollX: ios ? -scrollX : 0,
        scrollY: ios ? -scrollY : 0,
        x: ios ? scrollX : 0,
        y: ios ? scrollY : 0,
        scale: 1,
        backgroundColor: '#ffffff',
        ignoreElements: (element: Element) => element.id === 'scout-widget-root',
        useCORS: true,
        allowTaint: false,
        logging: false,
      }),
      timeout,
    ]);

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    return dataUrl.replace(/^data:image\/jpeg;base64,/, '');
  } catch (err) {
    console.warn('[Scout] Screenshot capture failed:', err);
    return null;
  } finally {
    restoreIframes(replacedIframes);
    if (highlightOverlay) highlightOverlay.remove();
  }
}

export const SCREENSHOT_MIME = 'image/jpeg';
