#!/usr/bin/env node
/**
 * Works out the next release version from the commits since the last tag.
 *
 * Conventional prefixes decide the bump, and the highest one across the range
 * wins. Commits without a recognised prefix count as a patch, so ordinary
 * imperative messages still release rather than silently stalling the pipeline.
 * A range containing only documentation or housekeeping releases nothing.
 *
 * Prints the next version, or nothing at all when no release is warranted.
 * Pass --write to also update package.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Prefixes that describe work with no effect on what the package does. */
const SILENT = new Set(['docs', 'chore', 'ci', 'test', 'build', 'style']);
const MINOR = new Set(['feat']);

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const parse = (tag) => {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return match ? match.slice(1).map(Number) : null;
};

/**
 * Highest release tag anywhere in the repository.
 *
 * Deliberately not `git describe`, which only looks at ancestors of HEAD. This
 * repository rebase-merges, so a tag cut on a pull-request branch never becomes
 * an ancestor of main, and describe would report no tag at all and keep
 * re-running the first release forever.
 */
export function lastTag(tags) {
  return tags
    .map((tag) => ({ tag, version: parse(tag) }))
    .filter((entry) => entry.version)
    .sort((a, b) =>
      a.version[0] - b.version[0] || a.version[1] - b.version[1] || a.version[2] - b.version[2]
    )
    .at(-1)?.tag ?? '';
}

/** Subject plus body for each commit, separated by NUL so bodies stay intact. */
function commitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const log = git('log', range, '--format=%B%x00', '--no-merges');
  return log.split('\0').map((entry) => entry.trim()).filter(Boolean);
}

/** 'none' | 'patch' | 'minor' | 'major' for a single commit message. */
export function classify(message) {
  const subject = message.split('\n', 1)[0] ?? '';
  // A `!` before the colon, or a BREAKING CHANGE footer, is a major either way.
  const header = /^(?<type>[a-z]+)(?<scope>\([^)]*\))?(?<breaking>!)?:\s/.exec(subject);
  if (/^BREAKING[ -]CHANGE:/m.test(message)) return 'major';
  if (!header) return 'patch';
  if (header.groups.breaking) return 'major';
  const type = header.groups.type;
  if (MINOR.has(type)) return 'minor';
  if (SILENT.has(type)) return 'none';
  return 'patch';
}

const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

export function bumpFor(messages) {
  return messages.reduce((highest, message) => {
    const level = classify(message);
    return RANK[level] > RANK[highest] ? level : highest;
  }, 'none');
}

export function nextVersion(current, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`Expected a stable semantic version, got ${current}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  return '';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifestPath = 'package.json';
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const tag = lastTag(git('tag', '--list', 'v*').split('\n').filter(Boolean));

  // The newest tag is the source of truth for what is released, not the
  // manifest, which can drift when a tag is cut outside this workflow.
  const version = tag
    ? nextVersion(tag.slice(1), bumpFor(commitsSince(tag)))
    : manifest.version;
  if (!version) process.exit(0);

  if (process.argv.includes('--write') && manifest.version !== version) {
    manifest.version = version;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  process.stdout.write(version);
}
