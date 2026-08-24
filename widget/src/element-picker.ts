import { generateSelector } from './selector';
import { t } from './i18n';

export interface PickedElement {
  itemType?: 'bug' | 'note';
  cssSelector: string;
  elementText: string;
  elementHtml: string;
  pageUrl: string;
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * Activate the element picker. Shows an overlay with a crosshair cursor.
 * Hovering (or touch-moving) highlights elements. Clicking/tapping captures
 * element info and resolves the promise.
 * ESC key cancels (resolves with null).
 *
 * Hardened with try/catch around all DOM operations for cross-browser safety.
 * If elementFromPoint or getBoundingClientRect fails in any browser,
 * the picker degrades gracefully instead of crashing.
 */
export function pickElement(
  shadow: ShadowRoot,
  overlay: HTMLDivElement,
  highlight: HTMLDivElement,
): Promise<PickedElement | null> {
  return new Promise((resolve) => {
    overlay.classList.remove('hidden');
    highlight.classList.add('hidden');

    // Instruction banner — tells user what to do
    const banner = document.createElement('div');
    banner.className = 'scout-picker-banner';

    const head = document.createElement('div');
    head.className = 'scout-picker-banner-head';

    const toggle = document.createElement('button');
    toggle.className = 'scout-picker-banner-toggle';

    const bannerText = document.createElement('span');
    bannerText.className = 'scout-picker-banner-text';

    const bannerIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    bannerIcon.setAttribute('class', 'scout-picker-banner-icon');
    bannerIcon.setAttribute('viewBox', '0 0 24 24');
    bannerIcon.setAttribute('fill', 'none');
    bannerIcon.setAttribute('stroke', 'currentColor');
    bannerIcon.setAttribute('stroke-width', '2');
    bannerIcon.setAttribute('stroke-linecap', 'round');
    bannerIcon.setAttribute('stroke-linejoin', 'round');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '10');
    const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line1.setAttribute('d', 'M12 16v-4');
    const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line2.setAttribute('d', 'M12 8h.01');
    bannerIcon.appendChild(circle);
    bannerIcon.appendChild(line1);
    bannerIcon.appendChild(line2);

    toggle.appendChild(bannerIcon);
    bannerText.appendChild(document.createTextNode(t('picker.hint')));

    const actions = document.createElement('div');
    actions.className = 'scout-picker-banner-actions';

    const noteBtn = document.createElement('button');
    noteBtn.className = 'scout-picker-banner-note';
    noteBtn.textContent = t('picker.note');

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'scout-picker-banner-cancel';
    cancelBtn.setAttribute('aria-label', t('picker.cancel'));
    cancelBtn.textContent = t('picker.cancel');

    head.appendChild(toggle);
    head.appendChild(bannerText);
    banner.appendChild(head);
    actions.appendChild(noteBtn);
    actions.appendChild(cancelBtn);
    banner.appendChild(actions);
    shadow.appendChild(banner);

    // Trigger animation
    requestAnimationFrame(() => banner.classList.add('visible'));

    // On narrow screens the banner covers the bottom of the page, so it shrinks
    // to an icon shortly after showing the hint and can be reopened by tapping it.
    let autoCollapse: number | undefined;

    function setCollapsed(collapsed: boolean): void {
      banner.classList.toggle('collapsed', collapsed);
      toggle.setAttribute('aria-label', t(collapsed ? 'picker.expand' : 'picker.collapse'));
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }

    setCollapsed(false);

    if (window.matchMedia('(max-width: 640px)').matches) {
      autoCollapse = window.setTimeout(() => setCollapsed(true), 2500);
    }

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      window.clearTimeout(autoCollapse);
      setCollapsed(!banner.classList.contains('collapsed'));
    });

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cleanup();
      resolve(null);
    });

    noteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cleanup();
      resolve({
        itemType: 'note',
        cssSelector: '',
        elementText: '',
        elementHtml: '',
        pageUrl: window.location.href,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
    });

    let currentTarget: Element | null = null;

    function updateHighlight(el: Element): void {
      try {
        const rect = el.getBoundingClientRect();
        // Validate rect — some browsers return all-zero for hidden/detached elements
        if (rect.width === 0 && rect.height === 0) {
          highlight.classList.add('hidden');
          return;
        }
        highlight.style.top = `${rect.top}px`;
        highlight.style.left = `${rect.left}px`;
        highlight.style.width = `${rect.width}px`;
        highlight.style.height = `${rect.height}px`;
        highlight.classList.remove('hidden');
      } catch {
        // getBoundingClientRect can fail on detached or special elements
        highlight.classList.add('hidden');
      }
    }

    function resolveElementAt(x: number, y: number): Element | null {
      try {
        // Temporarily disable pointer events on overlay to "see through" it
        overlay.style.pointerEvents = 'none';
        const el = document.elementFromPoint(x, y);
        overlay.style.pointerEvents = '';

        if (!el) return null;

        // Exclude scout widget elements
        if (el.id === 'scout-widget-root' || el.closest('#scout-widget-root')) {
          return null;
        }

        // Skip <html> and <body> — not useful for bug reports
        if (el === document.documentElement || el === document.body) {
          return null;
        }

        return el;
      } catch {
        // elementFromPoint can fail in some edge cases (e.g., cross-origin iframes)
        overlay.style.pointerEvents = '';
        return null;
      }
    }

    function onMouseMove(e: MouseEvent): void {
      const el = resolveElementAt(e.clientX, e.clientY);

      if (!el) {
        highlight.classList.add('hidden');
        currentTarget = null;
        return;
      }

      currentTarget = el;
      updateHighlight(el);
    }

    function onTouchMove(e: TouchEvent): void {
      e.preventDefault(); // Prevent scrolling while picking
      const touch = e.touches[0];
      if (!touch) return;

      const el = resolveElementAt(touch.clientX, touch.clientY);

      if (!el) {
        highlight.classList.add('hidden');
        currentTarget = null;
        return;
      }

      currentTarget = el;
      updateHighlight(el);
    }

    function onTouchStart(e: TouchEvent): void {
      e.preventDefault(); // Prevent scrolling
      const touch = e.touches[0];
      if (!touch) return;

      const el = resolveElementAt(touch.clientX, touch.clientY);

      if (!el) {
        highlight.classList.add('hidden');
        currentTarget = null;
        return;
      }

      currentTarget = el;
      updateHighlight(el);
    }

    function finishPick(): void {
      if (!currentTarget) {
        cleanup();
        resolve(null);
        return;
      }

      const el = currentTarget;

      try {
        const result: PickedElement = {
          cssSelector: generateSelector(el),
          elementText: (el.textContent ?? '').trim().slice(0, 500),
          elementHtml: el.outerHTML.slice(0, 2000),
          pageUrl: window.location.href,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        };

        cleanup();
        resolve(result);
      } catch {
        // If selector generation or DOM access fails, still return basic info
        cleanup();
        resolve({
          cssSelector: el.tagName?.toLowerCase() ?? 'unknown',
          elementText: '',
          elementHtml: '',
          pageUrl: window.location.href,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        });
      }
    }

    function onClick(e: MouseEvent): void {
      e.preventDefault();
      e.stopPropagation();
      finishPick();
    }

    function onTouchEnd(e: TouchEvent): void {
      e.preventDefault();
      e.stopPropagation();
      finishPick();
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
        resolve(null);
      }
    }

    function cleanup(): void {
      window.clearTimeout(autoCollapse);
      overlay.classList.add('hidden');
      highlight.classList.add('hidden');
      banner.classList.remove('visible');
      setTimeout(() => banner.remove(), 200);
      overlay.removeEventListener('mousemove', onMouseMove);
      overlay.removeEventListener('click', onClick);
      overlay.removeEventListener('touchstart', onTouchStart);
      overlay.removeEventListener('touchmove', onTouchMove);
      overlay.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('keydown', onKeyDown, true);
    }

    overlay.addEventListener('mousemove', onMouseMove);
    overlay.addEventListener('click', onClick);
    overlay.addEventListener('touchstart', onTouchStart, { passive: false });
    overlay.addEventListener('touchmove', onTouchMove, { passive: false });
    overlay.addEventListener('touchend', onTouchEnd, { passive: false });
    document.addEventListener('keydown', onKeyDown, true);
  });
}
