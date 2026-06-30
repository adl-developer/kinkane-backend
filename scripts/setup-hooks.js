#!/usr/bin/env node
// Points git at .githooks/ for the CHANGELOG-generation pre-commit hook,
// but only if hooksPath isn't already set to something else — e.g. husky
// or another tool a future contributor adds. Silently overriding someone
// else's hook setup on every `npm install` would disable their checks
// without any warning, so this backs off and tells the developer instead.
const { execSync } = require('child_process');

const TARGET = '.githooks';

function run(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

// Not inside a git repo (e.g. installed as a dependency, or a CI cache step) — no-op.
if (!run('git rev-parse --is-inside-work-tree')) {
  process.exit(0);
}

const current = run('git config --get core.hooksPath');

if (current && current !== TARGET) {
  console.warn(
    `[setup-hooks] core.hooksPath is already set to "${current}" — leaving it alone.\n` +
      `[setup-hooks] The CHANGELOG.md pre-commit hook in ${TARGET}/ will not run unless you wire it up manually.`,
  );
  process.exit(0);
}

execSync(`git config core.hooksPath ${TARGET}`);
