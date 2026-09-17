module.exports = {
  '*.{js,jsx,ts,tsx}': [
    'node scripts/sort-imports.mts',
    'prettier --write',
    // Same invocation as the Static Checks CI job: warnings are failures there,
    // and changed files under config-ignored paths must not trip it.
    // --pass-on-unpruned-suppressions: fixing a design-rule violation recorded in
    // eslint-suppressions.json otherwise fails the commit that fixed it. Tighten the
    // recorded counts with `npm run lint:design:prune`.
    // One invocation, not a bare `eslint --fix` followed by this one: ESLint applies
    // suppressions after fixes, so a single run reports the post-fix state, while a
    // first run without the flag exits 2 on the suppression the fix just made unused
    // and lint-staged never reaches the command that tolerates it.
    'eslint --fix --config eslint.config.mjs --no-warn-ignored --max-warnings=0 --pass-on-unpruned-suppressions',
  ],
  '*.json': ['prettier --write'],
};
