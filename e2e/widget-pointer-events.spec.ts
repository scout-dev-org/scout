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
});
