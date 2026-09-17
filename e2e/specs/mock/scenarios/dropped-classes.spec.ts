import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { computedStyles, probeStyle } from './style.helpers';

/**
 * `cn()` was deleting classes the caller wrote: `tailwind-merge@1.9.1` predates
 * Tailwind 3.3, so its conflict map had no group for `touch-action`, gradient
 * colour stops or `text-wrap`, and it dropped the earlier of two utilities it
 * only believed were in conflict. Nothing warned — the class simply never
 * reached the DOM. Each scenario below picks one of those surfaces and asks the
 * browser what it actually got.
 */

test.describe('classes that survive cn()', () => {
  test.describe('the mobile drawer', () => {
    /** Below `sm` the sidebar is a drawer; the mock config has one desktop
     *  project, so the spec declares the viewport it describes. */
    test.use({ viewport: { width: 390, height: 844 } });

    test('the mobile drawer keeps vertical panning @scenario:the-mobile-drawer-keeps-vertical-panning', async ({
      page,
    }) => {
      await page.goto('/c/new', { timeout: 30000 });

      const drawer = page.locator('#mobile-drawer');
      await expect(drawer).toBeAttached({ timeout: 30000 });

      /** `touch-pan-y touch-pinch-zoom` is the pair the drawer writes: the close
       *  swipe reads horizontal touches, and zoom stays with the browser. v1
       *  grouped the two as conflicting and kept only the last one. */
      const { touchAction } = await computedStyles(drawer, ['touchAction']);
      expect(touchAction).toContain('pan-y');
      expect(touchAction).toContain('pinch-zoom');
    });
  });

  test('the projects header keeps balanced wrapping @scenario:a-project-card-title-keeps-balanced-wrapping', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/projects', { timeout: 30000 });

    /** `text-balance` sits next to `truncate`, and `text-pretty` next to
     *  `line-clamp-2`; v1 treated each pair as one group and dropped the wrap
     *  mode, so titles and descriptions lost their wrapping rules. The style
     *  longhand is the assertion: the `text-wrap` shorthand also carries the
     *  mode, which `truncate` legitimately sets to `nowrap` on the same node. */
    const heading = page.getByRole('heading', { name: 'Projects' }).first();
    await expect(heading).toBeVisible({ timeout: 30000 });
    expect((await computedStyles(heading, ['textWrapStyle'])).textWrapStyle).toBe('balance');

    /** The description carries the other half of the pair, and it only exists on
     *  a project that has one — so the scenario makes its own rather than
     *  depending on what the database happens to hold. */
    const name = `cn wrapping ${Date.now()}`;
    const description = 'A description long enough to wrap onto a second line in the workspace.';
    await page.getByRole('button', { name: 'New project' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Project name' }).fill(name);
    await dialog.getByRole('textbox', { name: /Description/ }).fill(description);
    await dialog.getByRole('button', { name: 'Create project' }).click();

    await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 30000 });
    const title = page.getByRole('heading', { name }).first();
    expect((await computedStyles(title, ['textWrapStyle'])).textWrapStyle).toBe('balance');

    const pretty = page.getByText(description, { exact: true }).first();
    await expect(pretty).toBeVisible({ timeout: 30000 });
    expect((await computedStyles(pretty, ['textWrapStyle'])).textWrapStyle).toBe('pretty');
  });

  test.describe('a shared conversation', () => {
    /** The share flow runs from the conversation header's Export/Share menu,
     *  which is a desktop surface; the scenario declares the viewport it
     *  describes rather than inheriting a phone from the runner's matrix. */
    test.use({ viewport: { width: 1280, height: 800 } });

    test('a shared conversation fade keeps its gradient start color @scenario:a-shared-conversation-fade-keeps-its-gradient-start-color', async ({
      page,
    }) => {
      test.setTimeout(180_000);

      await page.goto(NEW_CHAT_PATH, { timeout: 30000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      await sendMessageAndWaitForCompletion(page, 'Share this conversation');

      await page.getByRole('button', { name: 'Export/Share' }).click();
      await page.getByTestId('share-conversation-menu-item').click();
      const dialog = page.getByRole('dialog', { name: 'Share link to chat' });
      await expect(dialog).toBeVisible({ timeout: 30000 });
      await page.getByRole('button', { name: 'Create a shared link' }).click();

      const url = page.getByTestId('shared-link-url');
      await expect(url).toHaveValue(/\/share\//, { timeout: 30000 });
      const shared = await url.inputValue();
      await page.goto(new URL(shared).pathname, { timeout: 30000 });

      /** `from-surface-secondary` is written beside `from-40%`; v1 grouped the
       *  colour with the stop position and discarded the colour, so the fade
       *  started from nothing. `from-40%` appears exactly once in the client. */
      const fade = page.locator('[class*="from-40%"]').first();
      await expect(fade).toBeAttached({ timeout: 30000 });

      const { backgroundImage } = await computedStyles(fade, ['backgroundImage']);
      /** The expected colour comes from the same utility, painted on a probe, so
       *  the assertion follows the token however it is declared — a channel
       *  triplet here, an `@theme inline` custom property later in the stack. */
      const expected = await probeStyle(page, 'bg-surface-secondary', 'background-color');
      expect(backgroundImage).toContain(expected);
      /** Painting no colour would leave the gradient starting transparent. */
      expect(backgroundImage.startsWith('linear-gradient(to top, rgba(0, 0, 0, 0)')).toBe(false);
    });
  });
});
