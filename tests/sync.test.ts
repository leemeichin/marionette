import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compile.js';
import { initState, takeChoice } from '../src/state.js';
import {
  bindTrackerInSource, buildSyncManifest, linkNodeInSource, resolveTracker,
  SyncEditError, syncFileFor,
} from '../src/sync.js';
import { CODES } from '../src/types.js';

const BOUND = `
# project: sprint
# tracker: github
# github:repo: acme/platform
VAR remaining = 2

=== work_queue ===
Work the backlog.
- #12 Fix login
- #14 Add SSO
# github:issue: 12, 14
~ remaining -= 1
+ {remaining > 0} [Issue done, more remain] ~loop~ -> work_queue
* {remaining <= 0} [Backlog clear] -> wrap_up

=== wrap_up ===
Write the retro.
* [Retro written] -> END
`;

const AMBIGUOUS = `
# project: amb
# github:repo: acme/x
# jira:site: https://acme.atlassian.net

=== a ===
Do the thing.
* [Done] -> END
`;

async function compiled(source: string) {
  const result = await compile(source, { file: 'plan.mar' });
  assert.ok(result.ok, result.diagnostics.map((d) => d.message).join('; '));
  return result.trajectory!;
}

test('tracker resolution: explicit # tracker: wins', async () => {
  const { binding } = resolveTracker(await compiled(BOUND));
  assert.equal(binding?.provider, 'github');
  assert.equal(binding?.source, 'explicit');
  assert.equal(binding?.context, 'acme/platform');
});

test('tracker resolution: single provider context is inferred', async () => {
  const t = await compiled('# linear:workspace: acme\n=== a ===\nBody.\n* [Done] -> END\n');
  const { binding } = resolveTracker(t);
  assert.equal(binding?.provider, 'linear');
  assert.equal(binding?.source, 'inferred');
});

test('tracker resolution: ambiguity yields candidates and guidance, not a guess', async () => {
  const { binding, candidates, needs } = resolveTracker(await compiled(AMBIGUOUS));
  assert.equal(binding, null);
  assert.deepEqual(candidates.sort(), ['github', 'jira']);
  assert.match(needs!, /sync bind/);
});

test('MAR020: unknown # tracker: value warns', async () => {
  const result = await compile('# tracker: asana\n=== a ===\nBody.\n* [Done] -> END\n');
  assert.ok(result.ok);
  const warning = result.diagnostics.find((d) => d.code === CODES.UNKNOWN_TRACKER);
  assert.ok(warning, 'expected an MAR020 warning');
  assert.match(warning.message, /asana/);
});

test('MAR020: node-level # tracker: warns as plan-level-only (and does not bind)', async () => {
  const result = await compile('=== a ===\nBody.\n# tracker: github\n* [Done] -> END\n');
  assert.ok(result.ok);
  const warning = result.diagnostics.find((d) => d.code === CODES.UNKNOWN_TRACKER);
  assert.ok(warning, 'expected an MAR020 warning');
  assert.match(warning.message, /plan-level/);
  assert.equal(warning.line, 1); // anchored at the phase header, like delivery warnings
  // The stray node tag must not create a binding either.
  assert.equal(resolveTracker(result.trajectory!).binding, null);
});

test('manifest: unlinked phases become ensure-issue ops with write-back commands', async () => {
  const t = await compiled(BOUND);
  const manifest = buildSyncManifest(t, null, { file: 'plan.mar' });
  const ensures = manifest.ops.filter((o) => o.op === 'ensure-issue');
  assert.deepEqual(ensures.map((o) => o.node), ['wrap_up']); // work_queue is already linked
  assert.equal(ensures[0].title, 'Write the retro.');
  assert.match(ensures[0].body, /Exits:/);
  assert.match(ensures[0].writeback!, /marionette sync link plan\.mar wrap_up/);
  assert.equal(manifest.cursor.to, 0); // no state yet
});

test('manifest: decision log past the cursor becomes comment ops; completion closes linked issues', async () => {
  const t = await compiled(BOUND);
  let state = await initState(t);
  state = await takeChoice(t, state, '0', { actor: 'agent', rationale: 'fixed #12' });
  state = await takeChoice(t, state, '1', { actor: 'agent', rationale: 'shipped #14, queue empty' });
  state = await takeChoice(t, state, '0', { actor: 'agent', rationale: 'retro written' });
  assert.equal(state.status, 'completed');

  const manifest = buildSyncManifest(t, state, { file: 'plan.mar' });
  const comments = manifest.ops.filter((o) => o.op === 'comment');
  // Entries 1..3 exit a phase; the wrap_up exit has no linked issue to comment on.
  assert.equal(comments.length, 2);
  assert.ok(comments.every((o) => o.node === 'work_queue'));
  assert.match(comments[0].body, /fixed #12/);
  assert.match(comments[0].idempotencyKey, /:log:1$/);

  const closes = manifest.ops.filter((o) => o.op === 'close');
  assert.deepEqual(closes.map((o) => o.ref!.id).sort(), ['acme/platform#12', 'acme/platform#14']);

  // Advancing the cursor drops mirrored comments but keeps declarative closes.
  const after = buildSyncManifest(t, state, { file: 'plan.mar', cursor: state.log.length });
  assert.equal(after.ops.filter((o) => o.op === 'comment').length, 0);
  assert.equal(after.ops.filter((o) => o.op === 'close').length, 2);
});

test('manifest: unbound tracker computes no ops and explains what it needs', async () => {
  const manifest = buildSyncManifest(await compiled(AMBIGUOUS), null, { file: 'plan.mar' });
  assert.equal(manifest.tracker, null);
  assert.equal(manifest.ops.length, 0);
  assert.match(manifest.needs!, /Ask the plan owner/);
});

test('bindTrackerInSource inserts with preamble tags, replaces an existing binding, and recompiles', async () => {
  const bound = bindTrackerInSource(AMBIGUOUS, 'jira');
  const t = await compiled(bound);
  assert.equal(resolveTracker(t).binding?.provider, 'jira');
  const lines = bound.split('\n');
  const tagIdx = lines.findIndex((l) => l === '# tracker: jira');
  const headerIdx = lines.findIndex((l) => l.startsWith('==='));
  assert.ok(tagIdx > -1 && tagIdx < headerIdx, 'tag sits in the preamble');

  const rebound = bindTrackerInSource(bound, 'github');
  assert.equal(resolveTracker(await compiled(rebound)).binding?.provider, 'github');
  assert.equal(rebound.split('\n').filter((l) => l.startsWith('# tracker:')).length, 1);
});

test('linkNodeInSource writes the issue under the phase header and survives recompilation', async () => {
  const linked = linkNodeInSource(BOUND, 'wrap_up', 'github', '#22');
  const t = await compiled(linked);
  const node = t.nodes.find((n) => n.id === 'wrap_up')!;
  assert.ok(node.refs.some((r) => r.provider === 'github' && r.kind === 'issue' && r.id === 'acme/platform#22'));
  // The linked plan has nothing left to ensure.
  const manifest = buildSyncManifest(t, null, { file: 'plan.mar' });
  assert.equal(manifest.ops.filter((o) => o.op === 'ensure-issue').length, 0);
});

test('bind/link edits never touch fenced metadata content', async () => {
  const FENCED = [
    '# project: fenced',
    '# prompt: """',
    'The ask mentions # tracker: asana and a fake header:',
    '=== work_queue ===',
    '"""',
    '# github:repo: acme/x',
    '',
    '=== work_queue ===',
    'Do the thing.',
    '* [Done] -> END',
    '',
  ].join('\n');

  // bind must insert after the fence, not replace the "# tracker:" text inside it.
  const bound = bindTrackerInSource(FENCED, 'github');
  const t = await compiled(bound);
  assert.equal((t.meta['prompt'] as string).includes('# tracker: asana'), true, 'fence content untouched');
  assert.equal(resolveTracker(t).binding?.source, 'explicit');

  // link must anchor on the real phase header, not the identical line in the fence.
  const linked = await compiled(linkNodeInSource(FENCED, 'work_queue', 'github', '9'));
  const node = linked.nodes.find((n) => n.id === 'work_queue')!;
  assert.ok(node.refs.some((r) => r.kind === 'issue' && r.id === 'acme/x#9'));
  assert.equal((linked.meta['prompt'] as string).includes('=== work_queue ==='), true);
});

test('linkNodeInSource validates ids and phase names', async () => {
  assert.throws(() => linkNodeInSource(BOUND, 'wrap_up', 'jira', 'not an id'), SyncEditError);
  assert.throws(() => linkNodeInSource(BOUND, 'no_such_phase', 'github', '12'), SyncEditError);
});

test('syncFileFor mirrors the state-file naming convention', async () => {
  assert.equal(syncFileFor('plans/x.mar'), 'plans/x.sync.json');
  assert.equal(syncFileFor('plans/x.trajectory.json'), 'plans/x.sync.json');
});
