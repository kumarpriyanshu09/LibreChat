import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { expect, test } from '@playwright/test';
import { repoRoot, run, staticChecks } from './lint.helpers';

/**
 * `eslint-suppressions.json` records what the tree already owed when the design
 * rules landed, as a count per file and rule. Three things about that record are
 * behaviour a contributor meets: the commit that FIXES one of those violations
 * must not be rejected for leaving the count too high, a file move must not leave
 * the old path silencing a future file that reuses it, and a diff that edits only
 * the record must still be looked at by something. None of the three needs the
 * browser; each runs the configured command and reads what it does.
 */

type Suppressions = Record<string, Record<string, { count: number }>>;
type PackageManifest = { scripts: Record<string, string> };
type Workflow = {
  on: { pull_request: { paths: string[] } };
  jobs: { 'static-checks': { steps: { id?: string; with?: { filters: string } }[] } };
};

const SUPPRESSIONS_FILE = 'eslint-suppressions.json';
const suppressionsPath = resolve(repoRoot, SUPPRESSIONS_FILE);
const ESLINT = resolve(repoRoot, 'node_modules/.bin/eslint');

const readBaseline = (): Suppressions =>
  JSON.parse(readFileSync(suppressionsPath, 'utf8')) as Suppressions;

/** A scratch baseline; ESLint takes its location as an argument. */
function writeBaseline(name: string, content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'lc-suppressions-')), name);
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`);
  return path;
}

/** lint-staged's config is CommonJS, so it is loaded the way lint-staged loads
 *  it. Executing it is the point: the assertion is about the real commands. */
const loadHookConfig = (path: string): Record<string, string[]> =>
  createRequire(__filename)(path) as Record<string, string[]>;

test.describe('the recorded design-rule backlog', () => {
  test('fixing a recorded violation keeps the configured lint runs green @scenario:fixing-a-recorded-violation-keeps-the-configured-lint-runs-green', () => {
    test.setTimeout(180_000);

    /** Pick a real recorded file and claim one more violation than it has, which
     *  is the state a fix leaves behind until the counts are pruned. */
    const baseline = readBaseline();
    const [file, rules] = Object.entries(baseline)[0];
    const [rule, { count }] = Object.entries(rules)[0];
    const overCounted = writeBaseline(SUPPRESSIONS_FILE, {
      [file]: { [rule]: { count: count + 1 } },
    });
    const baselineText = readFileSync(suppressionsPath, 'utf8');

    /** The real pre-commit commands, read by executing the hook's own config:
     *  a copy of the command list here would pass while the hook was broken. */
    const hook = loadHookConfig(resolve(repoRoot, '.husky/lint-staged.config.js'));
    const commands = hook['*.{js,jsx,ts,tsx}'].filter((command) => command.includes('eslint'));
    expect(commands.length).toBeGreaterThan(0);

    for (const command of commands) {
      const [, ...args] = command.split(' ');
      const green = run(ESLINT, [...args, '--suppressions-location', overCounted, '--', file]);
      expect(green.status, `${command} rejected the diff that fixed a recorded violation`).toBe(0);

      /** The counter-proof: the same command without the flag exits 2, so the
       *  flag is what keeps the fixing commit committable. */
      const withoutFlag = args.filter((arg) => arg !== '--pass-on-unpruned-suppressions');
      const red = run(ESLINT, [...withoutFlag, '--suppressions-location', overCounted, '--', file]);
      expect(red.status).toBe(2);
      expect(red.output).toContain('suppressions left that do not occur anymore');
    }

    /** The local runner and the CI step have to pass what the hook passes. The
     *  flag's effect is what the two runs above measure, with the same ESLint
     *  binary and the same argument set; here the two other invocations are read
     *  rather than executed, because the runner's baseline location is
     *  `<root>/eslint-suppressions.json` — exercising its over-count would mean
     *  writing the repository's own baseline, and `npm run static-checks` on a
     *  real diff is the run that exercises it for real. */
    const runnerSource = readFileSync(resolve(repoRoot, 'scripts/static-checks.mts'), 'utf8');
    const runnerArgs = runnerSource.slice(
      runnerSource.indexOf('function lintChangedFiles'),
      runnerSource.indexOf('function checkFormatting'),
    );
    expect(runnerArgs, 'the local runner omits the flag the hook and CI pass').toContain(
      '--pass-on-unpruned-suppressions',
    );

    const lane = readFileSync(resolve(repoRoot, '.github/workflows/static-checks.yml'), 'utf8');
    const eslintStep = lane.slice(
      lane.indexOf('Run ESLint on changed files'),
      lane.indexOf('Run Prettier --check'),
    );
    expect(eslintStep, 'the Static Checks lane omits the flag').toContain(
      '--pass-on-unpruned-suppressions',
    );

    /** The other half of the policy: the commit stays possible, and the lane
     *  then asks for the prune. Capacity a fix freed is capacity the next change
     *  could spend, so the suppressions check rejects a count higher than the
     *  file's violations and names the command that tightens it. */
    const scratch = resolve(repoRoot, 'e2e/specs/.test-results/unused-capacity');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(
      join(scratch, SUPPRESSIONS_FILE),
      `${JSON.stringify({ [file]: { [rule]: { count: count + 3 } } }, null, 2)}\n`,
    );
    const capacity = staticChecks([join(scratch, SUPPRESSIONS_FILE), '--only', 'suppressions']);
    expect(capacity.status, 'unused suppression capacity passed the lane').not.toBe(0);
    expect(capacity.output).toContain('would silence a later violation');
    expect(capacity.output).toContain('npm run lint:design:prune');
    rmSync(scratch, { force: true, recursive: true });

    /** And the repository's own baseline is exactly as it was: this scenario
     *  writes only into `os.tmpdir()`. */
    expect(readFileSync(suppressionsPath, 'utf8')).toBe(baselineText);
  });

  test('re-recording a moved file drops its old path @scenario:re-recording-a-moved-file-drops-its-old-path', () => {
    test.setTimeout(180_000);

    /** Suppressions are keyed by path, so a move records the new path and leaves
     *  the old one behind; only the prune removes it. Chaining the two is what
     *  makes the documented move recipe complete. */
    const manifest = JSON.parse(
      readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
    ) as PackageManifest;
    expect(manifest.scripts['lint:design:suppress']).toContain('--suppress-rule');
    expect(manifest.scripts['lint:design:suppress'].trimEnd()).toMatch(
      /&&\s*npm run lint:design:prune$/,
    );

    const baseline = readBaseline();
    const recorded = Object.keys(baseline);
    const linted = recorded.find((path) => path.startsWith('client/src/a11y/')) ?? recorded[0];
    const directory = linted.slice(0, linted.lastIndexOf('/'));
    const outside = recorded.find((path) => !path.startsWith(`${directory}/`));
    if (!outside) {
      throw new Error('the baseline records only one directory; pick another fixture');
    }
    const phantom = `${directory}/ThisFileMovedAway.tsx`;
    expect(existsSync(resolve(repoRoot, phantom))).toBe(false);

    const scratch = writeBaseline(SUPPRESSIONS_FILE, {
      [linted]: baseline[linted],
      [phantom]: { 'shadcn/no-restyle': { count: 4 } },
      [outside]: baseline[outside],
    });

    const pruned = run(ESLINT, [
      '--no-warn-ignored',
      '--prune-suppressions',
      '--suppressions-location',
      scratch,
      directory,
    ]);
    expect(pruned.status, pruned.output).toBe(0);

    const after = JSON.parse(readFileSync(scratch, 'utf8')) as Suppressions;
    expect(after[phantom]).toBeUndefined();
    /** A file the prune never linted keeps its entry: the sweep removes paths,
     *  it does not silently rewrite counts for the rest of the tree. */
    expect(after[outside]).toEqual(baseline[outside]);
    expect(after[linted]).toEqual(baseline[linted]);
  });

  test('a suppressions-only change is selected and validated by static checks @scenario:a-suppressions-only-change-is-selected-and-validated-by-static-checks', () => {
    test.setTimeout(180_000);

    /** Part one: the lane starts at all. The baseline has to be named in the
     *  trigger the workflow declares and in the filter group that gates the
     *  ESLint steps — the entries `dorny/paths-filter` reads. */
    const workflow = load(
      readFileSync(resolve(repoRoot, '.github/workflows/static-checks.yml'), 'utf8'),
    ) as Workflow;

    expect(workflow.on.pull_request.paths).toContain(SUPPRESSIONS_FILE);

    const paths = workflow.jobs['static-checks'].steps.find((step) => step.id === 'paths');
    if (!paths?.with) {
      throw new Error('the workflow no longer declares a paths-filter step');
    }
    const filters = load(paths.with.filters) as Record<string, string[]>;
    expect(filters.suppressions).toContain(SUPPRESSIONS_FILE);
    expect(filters.eslint).toContain(SUPPRESSIONS_FILE);
    /** Deliberately not this one: it gates the full-tree double sweep, which can
     *  learn nothing from a count changing. */
    expect(filters.eslint_config).not.toContain(SUPPRESSIONS_FILE);

    /** And the local mirror, which owns the same decision, has to reach it by
     *  actually matching the path rather than by declaring it. */
    const listed = staticChecks([SUPPRESSIONS_FILE, '--list']);
    expect(listed.output).toMatch(/Design-rule suppressions \(suppressions\)\s+would run/);

    /** Part two: the record is actually read. The committed baseline passes. */
    const passing = staticChecks([SUPPRESSIONS_FILE, '--only', 'suppressions']);
    expect(passing.status, passing.output).toBe(0);

    /** And each way it can stop saying what it claims fails, naming the key. The
     *  check validates every suppressions file the target names, so the invalid
     *  ones live under the lane's own ignored results directory and the
     *  repository's baseline is never written to. */
    const scratchDir = resolve(repoRoot, 'e2e/specs/.test-results/suppression-probe');
    const baselineText = readFileSync(suppressionsPath, 'utf8');
    const invalid: [string, unknown, string][] = [
      ['a shape ESLint cannot load', [], 'expected an object keyed by file path'],
      [
        'a count no run can reach',
        { 'client/src/App.jsx': { 'shadcn/no-restyle': { count: 0 } } },
        'positive integer count',
      ],
      [
        'a rule the plugin does not define',
        { 'client/src/App.jsx': { 'shadcn/no-shadows': { count: 1 } } },
        'is not a rule @shadcn/lint defines',
      ],
      [
        'a path that no longer exists',
        { 'client/src/Gone.tsx': { 'shadcn/no-restyle': { count: 1 } } },
        'recorded path no longer exists',
      ],
    ];
    mkdirSync(scratchDir, { recursive: true });
    for (const [label, content, expected] of invalid) {
      const probe = join(scratchDir, SUPPRESSIONS_FILE);
      writeFileSync(probe, `${JSON.stringify(content, null, 2)}\n`);
      const rejected = staticChecks([probe, '--only', 'suppressions']);
      expect(rejected.status, `${label} was accepted`).toBe(1);
      expect(rejected.output, label).toContain(expected);
    }
    rmSync(scratchDir, { force: true, recursive: true });

    /** And a diff that deletes the baseline outright is the same kind of
     *  failure: the group still activates, the changed-file lint has no source
     *  to report through, so the check has to say so rather than skip. The
     *  deletion is exercised in a synthetic root, not in the checkout. */
    const emptyRoot = mkdtempSync(join(tmpdir(), 'lc-no-baseline-'));
    mkdirSync(join(emptyRoot, 'scripts'), { recursive: true });
    copyFileSync(
      resolve(repoRoot, 'scripts/static-checks.mts'),
      join(emptyRoot, 'scripts/static-checks.mts'),
    );
    copyFileSync(resolve(repoRoot, 'package.json'), join(emptyRoot, 'package.json'));
    symlinkSync(resolve(repoRoot, 'node_modules'), join(emptyRoot, 'node_modules'), 'dir');
    const deleted = run(process.execPath, [
      join(emptyRoot, 'scripts/static-checks.mts'),
      SUPPRESSIONS_FILE,
      '--only',
      'suppressions',
    ]);
    expect(deleted.status, 'a deleted baseline passed validation').not.toBe(0);
    expect(deleted.output).toContain('is missing');
    rmSync(emptyRoot, { force: true, recursive: true });

    /** Nothing in the checkout moved while that ran. */
    expect(readFileSync(suppressionsPath, 'utf8')).toBe(baselineText);
  });
});
