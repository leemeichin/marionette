import test from 'node:test';
import assert from 'node:assert/strict';
import { bumpFor, classify, lastTag, nextVersion } from '../scripts/next-version.mjs';

test('conventional prefixes decide the bump, and anything else is a patch', () => {
  assert.equal(classify('feat: add worktree reuse'), 'minor');
  assert.equal(classify('feat(planning): add worktree reuse'), 'minor');
  assert.equal(classify('fix: guard detached HEAD'), 'patch');
  assert.equal(classify('perf: trim projection'), 'patch');
  assert.equal(classify('docs: tidy runtime notes'), 'none');
  assert.equal(classify('chore: bump dependency'), 'none');
  assert.equal(classify('ci: cache npm'), 'none');

  // The existing imperative style must keep releasing rather than stalling.
  assert.equal(classify('Allow agents to amend live plans'), 'patch');
  assert.equal(classify('Publish a planning contract'), 'patch');
});

test('breaking changes are major however they are marked', () => {
  assert.equal(classify('feat!: drop legacy bind'), 'major');
  assert.equal(classify('refactor(api)!: rename approve'), 'major');
  assert.equal(classify('feat: rework binding\n\nBREAKING CHANGE: bind() now needs a run id.'), 'major');
  // The footer must be its own line, not a phrase inside prose.
  assert.equal(classify('fix: mention a BREAKING CHANGE: in the docs'), 'patch');
});

test('the highest bump across the range wins', () => {
  assert.equal(bumpFor(['docs: notes', 'fix: guard', 'feat: add']), 'minor');
  assert.equal(bumpFor(['feat: add', 'feat!: remove']), 'major');
  assert.equal(bumpFor(['docs: notes', 'chore: tidy']), 'none');
  assert.equal(bumpFor([]), 'none');
});

test('a documentation-only range releases nothing', () => {
  assert.equal(nextVersion('0.2.0', bumpFor(['docs: tidy runtime notes'])), '');
});

test('version arithmetic resets the lower components', () => {
  assert.equal(nextVersion('0.2.3', 'patch'), '0.2.4');
  assert.equal(nextVersion('0.2.3', 'minor'), '0.3.0');
  assert.equal(nextVersion('0.2.3', 'major'), '1.0.0');
  assert.equal(nextVersion('0.2.3', 'none'), '');
});

test('the newest tag is chosen by version order, not by string or ancestry', () => {
  // Sorting these as strings would pick v0.9.0 over v0.10.0.
  assert.equal(lastTag(['v0.2.0', 'v0.10.0', 'v0.9.0']), 'v0.10.0');
  assert.equal(lastTag(['v1.0.0', 'v0.20.0']), 'v1.0.0');
  assert.equal(lastTag(['v0.2.1', 'v0.2.10', 'v0.2.2']), 'v0.2.10');
  // Non-release tags are ignored, and no tags at all is not an error.
  assert.equal(lastTag(['nightly', 'v0.2.0', 'v0.2.0-rc.1']), 'v0.2.0');
  assert.equal(lastTag([]), '');
});
