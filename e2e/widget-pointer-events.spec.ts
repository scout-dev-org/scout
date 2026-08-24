import { expect, type Page, test } from '@playwright/test';

const API = 'http://localhost:10020';
const DEMO = `${API}/demo/`;
const VALID_TEST_TOKEN = 'eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDB9.signature';

type WidgetMetrics = {
  centerX: number;
  centerY: number;
  pointerEvents: string;
  cursor: string;
  corner: string | null;
};

async function waitForFab(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const host = document.querySelector('#scout-widget-root') as HTMLElement | null;
    return Boolean(host?.shadowRoot?.querySelector('.scout-fab'));
  });
}

async function getFabMetrics(page: Page): Promise<WidgetMetrics> {
  return page.evaluate(() => {
    const host = document.querySelector('#scout-widget-root') as HTMLElement;
    const fab = host.shadowRoot?.querySelector('.scout-fab') as HTMLElement;
    const rect = fab.getBoundingClientRect();
    const styles = getComputedStyle(fab);

    return {
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      pointerEvents: styles.pointerEvents,
      cursor: styles.cursor,
      corner: fab.dataset.corner ?? null,
    };
  });
}

test.describe('Widget pointer handling', () => {
  test('closed root is pass-through while FAB remains interactive through host pointer-events override', async ({ page }) => {
    await page.addInitScript((token) => {
      localStorage.setItem('__scout_token__', token);
      localStorage.setItem('__scout_user__', JSON.stringify({ id: 'e2e-user', email: 'e2e@example.test', name: 'E2E User' }));
    }, VALID_TEST_TOKEN);

    await page.goto(DEMO);
    await waitForFab(page);

    await page.evaluate(() => {
      const host = document.querySelector('#scout-widget-root') as HTMLElement;
      const target = document.createElement('button');
      target.id = 'scout-page-click-target';
      target.textContent = 'Page target';
      target.style.cssText = [
        'position:fixed',
        'right:84px',
        'bottom:20px',
        'width:160px',
        'height:48px',
        'border:0',
        'border-radius:8px',
        'background:#111827',
        'color:white',
        'cursor:pointer',
      ].join(';');
      target.addEventListener('click', () => {
        const win = window as Window & { __scoutPageClicks?: number };
        win.__scoutPageClicks = (win.__scoutPageClicks ?? 0) + 1;
      });
      document.body.insertBefore(target, host);
    });

    const pageTarget = await page.evaluate(() => {
      const target = document.querySelector('#scout-page-click-target') as HTMLElement;
      const rect = target.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(centerX, centerY) as HTMLElement | null;

      return {
        centerX,
        centerY,
        hitId: hit?.id ?? '',
        cursor: getComputedStyle(target).cursor,
      };
    });

    expect(pageTarget.hitId).toBe('scout-page-click-target');
    expect(pageTarget.cursor).toBe('pointer');

    await page.mouse.click(pageTarget.centerX, pageTarget.centerY);
    await expect.poll(() => page.evaluate(() => (window as Window & { __scoutPageClicks?: number }).__scoutPageClicks ?? 0)).toBe(1);

    await page.addStyleTag({ content: '#scout-widget-root{pointer-events:none}#scout-widget-root>*{pointer-events:auto}' });

    const initialFab = await getFabMetrics(page);
    expect(initialFab.pointerEvents).toBe('auto');
    expect(initialFab.cursor).toBe('grab');

    await page.mouse.move(initialFab.centerX, initialFab.centerY);
    await page.mouse.down();
    await page.mouse.move(80, initialFab.centerY, { steps: 8 });
    await page.mouse.up();

    await expect.poll(async () => (await getFabMetrics(page)).corner).toBe('bottom-left');
    await page.waitForTimeout(150);

    const draggedFab = await getFabMetrics(page);
    await page.mouse.click(draggedFab.centerX, draggedFab.centerY);

    await page.waitForFunction(() => {
      const host = document.querySelector('#scout-widget-root') as HTMLElement | null;
      const overlay = host?.shadowRoot?.querySelector('.scout-overlay') as HTMLElement | null;
      return Boolean(overlay && !overlay.classList.contains('hidden') && getComputedStyle(overlay).pointerEvents === 'auto');
    });

    await page.mouse.click(pageTarget.centerX, pageTarget.centerY);

    await page.waitForFunction(() => {
      const host = document.querySelector('#scout-widget-root') as HTMLElement | null;
      const shadow = host?.shadowRoot;
      const backdrop = Array.from(shadow?.querySelectorAll('.scout-panel-backdrop') ?? [])
        .find((el) => !el.classList.contains('hidden')) as HTMLElement | undefined;
      const panel = shadow?.querySelector('.scout-panel.visible') as HTMLElement | null;
      return Boolean(
        backdrop &&
        panel &&
        !backdrop.classList.contains('hidden') &&
        backdrop.classList.contains('visible') &&
        panel.classList.contains('visible') &&
        getComputedStyle(backdrop).pointerEvents === 'auto'
      );
    });

    await page.locator('.scout-panel.visible .scout-btn-secondary').click();

    await page.waitForFunction(() => {
      const host = document.querySelector('#scout-widget-root') as HTMLElement | null;
      const shadow = host?.shadowRoot;
      const backdrops = Array.from(shadow?.querySelectorAll('.scout-panel-backdrop') ?? []);
      const fab = shadow?.querySelector('.scout-fab') as HTMLElement | null;
      return Boolean(backdrops.every((el) => el.classList.contains('hidden')) && fab && !fab.classList.contains('hidden'));
    });
  });

  // A host page put its modal one step above the widget's highest layer and hid
  // the button, so the widget stopped competing on numbers: the top layer is
  // above every z-index a page can name.
  test('widget outranks host chrome at any z-index', async ({ page }) => {
    await page.addInitScript((token) => {
      localStorage.setItem('__scout_token__', token);
      localStorage.setItem('__scout_user__', JSON.stringify({ id: 'e2e-user', email: 'e2e@example.test', name: 'E2E User' }));
    }, VALID_TEST_TOKEN);

    await page.goto(DEMO);
    await waitForFab(page);

    for (const z of [1000011, 2147483647]) {
      const hit = await page.evaluate((zi) => {
        document.querySelector('#host-modal')?.remove();
        const modal = document.createElement('div');
        modal.id = 'host-modal';
        modal.style.cssText = `position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,0.5);z-index:${zi}`;
        document.body.appendChild(modal);

        const host = document.querySelector('#scout-widget-root') as HTMLElement;
        const rect = (host.shadowRoot?.querySelector('.scout-fab') as HTMLElement).getBoundingClientRect();
        const found = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { id: found?.id ?? null, inTopLayer: host.matches(':popover-open') };
      }, z);

      expect(hit.id).toBe('scout-widget-root');
      expect(hit.inTopLayer).toBe(true);
    }

    // Taking the host back out of the top layer must hand the modal the win -
    // otherwise this test would pass for the wrong reason.
    const withoutTopLayer = await page.evaluate(() => {
      const host = document.querySelector('#scout-widget-root') as HTMLElement & { hidePopover?: () => void };
      const rect = (host.shadowRoot?.querySelector('.scout-fab') as HTMLElement).getBoundingClientRect();
      host.hidePopover?.();
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.id ?? null;
    });
    expect(withoutTopLayer).toBe('host-modal');
  });

  // The picker banner used to sit as a full-width bar at the bottom of a phone
  // viewport, so nothing under it could be reported at all.
  test('active picker leaves the whole narrow viewport reachable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    await page.addInitScript((token) => {
      localStorage.setItem('__scout_token__', token);
      localStorage.setItem('__scout_user__', JSON.stringify({ id: 'e2e-user', email: 'e2e@example.test', name: 'E2E User' }));
    }, VALID_TEST_TOKEN);

    await page.goto(DEMO);
    await waitForFab(page);

    await page.evaluate(() => {
      const host = document.querySelector('#scout-widget-root') as HTMLElement;
      (host.shadowRoot?.querySelector('.scout-fab') as HTMLElement).click();
    });

    // Wait only for the banner to finish sliding in - it must already be an icon
    // by then, never a bar the person has to sit through.
    await page.waitForFunction(() => {
      const host = document.querySelector('#scout-widget-root') as HTMLElement | null;
      return Boolean(host?.shadowRoot?.querySelector('.scout-picker-banner.visible'));
    });
    await page.waitForTimeout(400);

    await expect(page.evaluate(() => {
      const host = document.querySelector('#scout-widget-root') as HTMLElement;
      return host.shadowRoot!.querySelector('.scout-picker-banner')!.classList.contains('collapsed');
    })).resolves.toBe(true);

    // Sample a grid of points and count the ones the widget makes unusable for
    // reporting: either its chrome hides the page there, or it eats the pointer.
    // The picker overlay and highlight are excluded — a translucent tint and an
    // outline keep the page both visible and pickable.
    const coverage = await page.evaluate(() => {
      const host = document.querySelector('#scout-widget-root') as HTMLElement;
      const shadow = host.shadowRoot as ShadowRoot;
      const overlay = shadow.querySelector('.scout-overlay') as HTMLElement;

      const opaque = Array.from(shadow.querySelectorAll('*'))
        .filter((el) => !el.closest('.scout-overlay') && !el.classList.contains('scout-highlight'))
        .map((el) => ({ el: el as HTMLElement, rect: el.getBoundingClientRect() }))
        .filter(({ el, rect }) => rect.width > 0 && rect.height > 0 && Number(getComputedStyle(el).opacity) > 0.01)
        .map(({ rect }) => rect);

      const step = 30;
      let sampled = 0;
      let unusable = 0;

      overlay.style.pointerEvents = 'none';
      for (let y = step / 2; y < window.innerHeight; y += step) {
        for (let x = step / 2; x < window.innerWidth; x += step) {
          sampled += 1;
          const hit = document.elementFromPoint(x, y);
          const eaten = Boolean(hit && (hit.id === 'scout-widget-root' || hit.closest('#scout-widget-root')));
          const hidden = opaque.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
          if (eaten || hidden) unusable += 1;
        }
      }
      overlay.style.pointerEvents = '';

      return { sampled, unusable };
    });

    expect(coverage.sampled).toBeGreaterThan(300);
    expect(coverage.unusable / coverage.sampled).toBeLessThan(0.03);
  });
});
