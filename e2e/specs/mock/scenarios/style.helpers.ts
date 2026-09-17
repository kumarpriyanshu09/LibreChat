import type { Locator, Page } from '@playwright/test';

/**
 * Style probes for the scenarios that assert what the app paints. Both sides of
 * every comparison are resolved by the browser out of the stylesheet the app
 * shipped, never written down here: the same assertion then holds in light mode,
 * dark mode, under a custom theme, and across a Tailwind major.
 */

/**
 * Paint a throwaway element with `classes` and read `property` off it. This is
 * how an expected value is obtained without restating it: the utility resolves
 * through the same CSS the app loaded.
 */
export function probeStyle(page: Page, classes: string, property: string): Promise<string> {
  return page.evaluate(
    ([className, name]) => {
      const probe = document.createElement('div');
      probe.className = className;
      document.body.append(probe);
      const value = getComputedStyle(probe).getPropertyValue(name);
      probe.remove();
      return value.trim();
    },
    [classes, property] as [string, string],
  );
}

/** Read several computed properties off a rendered element in one round trip. */
export function computedStyles<K extends string>(
  locator: Locator,
  properties: readonly K[],
): Promise<Record<K, string>> {
  return locator.evaluate((node, names: readonly string[]) => {
    const style = getComputedStyle(node as HTMLElement);
    const result: Record<string, string> = {};
    for (const name of names) {
      result[name] = (style.getPropertyValue(name) || style[name as never] || '').trim();
    }
    return result;
  }, properties) as Promise<Record<K, string>>;
}
