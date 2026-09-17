import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { repoRoot, run } from './lint.helpers';

/**
 * Every job on this pull request died in `npm ci`: the lockfile entries the stack
 * added resolved to a private mirror that no GitHub runner and no contributor can
 * reach. What a clean install needs is that each locked tarball comes from a host
 * this repository already installs from, and that the registry actually serves
 * it — so the hosts are checked for the whole lockfile and the tarballs are then
 * asked for. Neither half depends on this being a branch: the same assertions
 * hold on `dev` and after this change merges.
 */

type LockEntry = { resolved?: string; integrity?: string; version?: string; link?: boolean };
type Lockfile = { packages: Record<string, LockEntry> };

const PUBLIC_REGISTRY = 'registry.npmjs.org';

/**
 * The one non-registry host this repository installs from: `xlsx` is published
 * on SheetJS's own CDN. It is named here so a second vendor host is a failure
 * rather than a silent precedent.
 */
const INHERITED_HOSTS = ['cdn.sheetjs.com'];

/** Workspace links resolve to a directory in this repo, not to a tarball. */
const tarballHost = (entry: LockEntry): string | undefined =>
  entry.link || !entry.resolved?.startsWith('https://') ? undefined : new URL(entry.resolved).host;

test.describe('the locked dependency set', () => {
  test('every locked package resolves from the public registry @scenario:every-locked-package-resolves-from-the-public-registry', async () => {
    test.setTimeout(180_000);

    const head = JSON.parse(
      readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8'),
    ) as Lockfile;
    const entries = Object.entries(head.packages);
    expect(entries.length).toBeGreaterThan(0);

    const allowed = [PUBLIC_REGISTRY, ...INHERITED_HOSTS];
    const foreign = entries
      .filter(([, entry]) => {
        const host = tarballHost(entry);
        return host !== undefined && !allowed.includes(host);
      })
      .map(([name, entry]) => `${name} -> ${entry.resolved}`);
    expect(
      foreign,
      'a locked tarball outside the public registry cannot be installed in CI',
    ).toEqual([]);

    /** What to ask the registry for: the entries this branch introduces when the
     *  base is fetched, and a deterministic slice otherwise — after this merges
     *  there is nothing to introduce, and the check still has to assert. */
    const base = run('git', ['show', 'origin/dev:package-lock.json']);
    const introduced =
      base.status === 0
        ? entries.filter(([name, entry]) => {
            const previous = (JSON.parse(base.stdout) as Lockfile).packages[name];
            return Boolean(entry.resolved) && (!previous || previous.version !== entry.version);
          })
        : [];
    const probe = introduced.length
      ? introduced
      : entries.filter(([, entry]) => tarballHost(entry) === PUBLIC_REGISTRY).slice(0, 5);
    expect(probe.length).toBeGreaterThan(0);

    /** A host name is a claim; a 200 from the registry is the behaviour CI needs.
     *  Six at a time keeps a 55-tarball sweep inside the test's clock. */
    const queue = [...probe];
    const failures: string[] = [];
    let unreachable = '';
    const fetchOne = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [name, entry] = next;
        try {
          const response = await fetch(entry.resolved!, { method: 'HEAD' });
          if (!response.ok) {
            failures.push(`${name}: ${response.status} for ${entry.resolved}`);
          }
        } catch (error) {
          unreachable = `the registry is unreachable from here: ${String(error)}`;
          queue.length = 0;
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, fetchOne));

    /** A confirmed miss is reported even if a later request then failed to
     *  connect: the skip is for an unreachable registry, not for hiding a 404
     *  that was already observed. */
    expect(
      failures,
      'a locked tarball the registry does not serve breaks every clean install',
    ).toEqual([]);
    test.skip(unreachable !== '', unreachable);
  });
});
