import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { repoRoot } from './lint.helpers';

/**
 * A consumer following the documented setup loads one file from this package:
 * the exported Tailwind preset. The published components write `animate-in`,
 * `fade-in-0`, `zoom-in-95` and `slide-in-from-*` on dialogs, popovers and
 * dropdowns, and those are `tailwindcss-animate` utilities — so the preset has
 * to register the plugin, or the surfaces arrive without their motion and
 * nothing says why. This compiles the preset the way a consumer's build does
 * and asks for the CSS.
 */

type ClientManifest = { peerDependencies: Record<string, string> };

/** The classes the components actually emit, read from the components. */
const ANIMATION_CANDIDATES = [
  'animate-in',
  'fade-in-0',
  'zoom-in-95',
  'slide-in-from-bottom-10',
  'animate-out',
  'fade-out-0',
];

test.describe('the published preset', () => {
  test('the published preset generates the components animations @scenario:the-published-preset-generates-the-components-animations', async () => {
    test.setTimeout(120_000);

    /** The plugin is the consumer's to install, so it is declared as a peer. */
    const manifest = JSON.parse(
      readFileSync(resolve(repoRoot, 'packages/client/package.json'), 'utf8'),
    ) as ClientManifest;
    expect(manifest.peerDependencies['tailwindcss-animate']).toBeDefined();

    /** Compile with the preset alone — no app config, the way a consumer does. */
    const { compile } = (await import('tailwindcss')) as {
      compile: (
        css: string,
        options: {
          base: string;
          loadModule: (
            id: string,
            base: string,
          ) => Promise<{ base: string; module: unknown; path: string }>;
          loadStylesheet: (
            id: string,
            base: string,
          ) => Promise<{ base: string; content: string; path: string }>;
        },
      ) => Promise<{ build: (candidates: string[]) => string }>;
    };
    const packageRoot = resolve(repoRoot, 'packages/client');
    const compiler = await compile(`@import "tailwindcss";\n@config "./tailwind.config.js";\n`, {
      base: packageRoot,
      loadModule: async (id, base) => {
        const modulePath = id.startsWith('.') ? resolve(base, id) : require.resolve(id);
        const loaded = (await import(modulePath)) as { default?: unknown };
        return {
          base: resolve(modulePath, '..'),
          module: loaded.default ?? loaded,
          path: modulePath,
        };
      },
      loadStylesheet: async (id, base) => {
        const stylesheet =
          id === 'tailwindcss'
            ? resolve(require.resolve('tailwindcss/package.json'), '../index.css')
            : resolve(base, id);
        return {
          base: resolve(stylesheet, '..'),
          content: readFileSync(stylesheet, 'utf8'),
          path: stylesheet,
        };
      },
    });

    const css = compiler.build([...ANIMATION_CANDIDATES, 'p-4']);
    for (const candidate of ANIMATION_CANDIDATES) {
      expect(css, `${candidate} generated no CSS from the published preset`).toContain(
        `.${candidate}`,
      );
    }
    /** Animations mean keyframes, not just a class that exists. */
    expect(css).toContain('@keyframes');
    /** The control: an ordinary utility still compiles, so a miss above is the
     *  plugin and not a broken compile. */
    expect(css).toContain('.p-4');
  });
});
