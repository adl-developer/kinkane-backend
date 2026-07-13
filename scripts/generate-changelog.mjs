#!/usr/bin/env node
/**
 * Generates CHANGELOG.md from conventional commit history.
 * Entries are grouped by date (newest first), then by type within each date.
 * Only feat: and fix: commits are included; all others are silently skipped.
 */

import { execSync } from 'child_process';
import { writeFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = resolve(__dirname, '..', 'CHANGELOG.md');
const CHANGELOG_DIR = resolve(__dirname, '..', 'changelog');
const REPO_URL = 'https://adl.github.com/adl-developer/kinkane-backend';

// Looks for a detailed write-up in changelog/<date>-<slug>.md matching this
// entry. If several files share a date, picks the one whose slug words
// overlap most with the commit description (substring match handles simple
// plurals like "user" vs "users").
function findDetailFile(date, description) {
  let files;
  try {
    files = readdirSync(CHANGELOG_DIR).filter((f) => f.startsWith(`${date}-`) && f.endsWith('.md'));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  if (files.length === 1) return files[0];

  const descWords = description.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let best = null;
  let bestScore = 0;
  for (const f of files) {
    const slugWords = f.slice(date.length + 1, -3).split('-').filter(Boolean);
    const score = slugWords.filter((sw) => descWords.some((dw) => dw.includes(sw) || sw.includes(dw))).length;
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return best;
}

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
      const detail = findDetailFile(date, description);
      const detailLink = detail ? ` — [details](changelog/${detail})` : '';
      out += `* ${description} ([${hash}](${REPO_URL}/commit/${fullHash}))${detailLink}\n`;
    }
  }

  if (fixes.length) {
    out += '\n### Bug Fixes\n\n';
    for (const { hash, fullHash, description } of fixes) {
      const detail = findDetailFile(date, description);
      const detailLink = detail ? ` — [details](changelog/${detail})` : '';
      out += `* ${description} ([${hash}](${REPO_URL}/commit/${fullHash}))${detailLink}\n`;
    }
  }
}

writeFileSync(CHANGELOG_PATH, out + '\n');
console.log('CHANGELOG.md updated');
