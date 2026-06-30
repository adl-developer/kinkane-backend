#!/usr/bin/env node
/**
 * Generates CHANGELOG.md from conventional commit history.
 * Entries are grouped by date (newest first), then by type within each date.
 * Only feat: and fix: commits are included; all others are silently skipped.
 */

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = resolve(__dirname, '..', 'CHANGELOG.md');
const REPO_URL = 'https://adl.github.com/adl-developer/kinkane-backend';

const raw = execSync('git log --pretty=format:"%H|%ad|%s" --date=short', { encoding: 'utf8' });

// { date -> { features: [...], fixes: [...] } }
const byDate = new Map();

for (const line of raw.trim().split('\n')) {
  const [hash, date, ...rest] = line.split('|');
  const subject = rest.join('|').trim();

  let type, description;
  if (subject.startsWith('feat:')) {
    type = 'features';
    description = subject.slice(5).trim();
  } else if (subject.startsWith('fix:')) {
    type = 'fixes';
    description = subject.slice(4).trim();
  } else {
    continue;
  }

  if (!byDate.has(date)) byDate.set(date, { features: [], fixes: [] });
  byDate.get(date)[type].push({ hash: hash.slice(0, 7), fullHash: hash, description });
}

const sortedDates = [...byDate.keys()].sort((a, b) => (a < b ? 1 : -1));

let out = '# Changelog\n';

for (const date of sortedDates) {
  const { features, fixes } = byDate.get(date);
  out += `\n\n## ${date}\n`;

  if (features.length) {
    out += '\n### Features\n\n';
    for (const { hash, fullHash, description } of features) {
      out += `* ${description} ([${hash}](${REPO_URL}/commit/${fullHash}))\n`;
    }
  }

  if (fixes.length) {
    out += '\n### Bug Fixes\n\n';
    for (const { hash, fullHash, description } of fixes) {
      out += `* ${description} ([${hash}](${REPO_URL}/commit/${fullHash}))\n`;
    }
  }
}

writeFileSync(CHANGELOG_PATH, out + '\n');
console.log('CHANGELOG.md updated');
