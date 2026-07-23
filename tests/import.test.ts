import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compile.js';
import { initState, takeChoice, frontier } from '../src/state.js';
import { ImportError, parseImportSpec, scaffoldPlan } from '../src/scaffold.js';
import { resolveTracker } from '../src/sync.js';

const SPEC = {
  tracker: 'github' as const,
  context: 'acme/platform',
  project: 'q3_backlog',
  issues: [
    { id: 12, title: 'Fix login redirect' },
    { id: '14', title: 'Add SSO support' },
    { id: 15, title: 'Rate limit the public API' },
  ],
};

test('queue mode compiles clean (strict) and stays O(1) in phase count', async () => {
  const mar = scaffoldPlan(SPEC, 'queue');
  const result = await compile(mar, { file: 'imported.mar' });
  assert.ok(result.ok, result.diagnostics.map((d) => d.message).join('; '));
  assert.equal(result.diagnostics.length, 0, 'no warnings: the loop must be verified bounded');
  assert.equal(result.trajectory!.nodes.length, 1);
  assert.equal(resolveTracker(result.trajectory!).binding?.provider, 'github');
  const refs = result.trajectory!.nodes[0].refs.filter((r) => r.kind === 'issue');
  assert.equal(refs.length, 3);
  assert.equal(refs[0].url, 'https://github.com/acme/platform/issues/12');
});

test('queue mode traverses exactly one iteration per issue', async () => {
  const t = (await compile(scaffoldPlan(SPEC, 'queue'))).trajectory!;
  const state = initState(t);
  for (let i = 0; i < SPEC.issues.length - 1; i++) {
    const loop = frontier(t, state).find((a) => a.choice.loop)!;
    assert.equal(loop.blocked, null, `loop open on iteration ${i + 1}`);
    takeChoice(t, state, loop.choice.id, { actor: 'agent', rationale: 'done, next' });
  }
  const loop = frontier(t, state).find((a) => a.choice.loop)!;
  assert.match(loop.blocked!, /gate/); // counter exhausted: the loop shut itself
  takeChoice(t, state, frontier(t, state).find((a) => !a.choice.loop)!.choice.id,
    { actor: 'agent', rationale: 'backlog clear' });
  assert.equal(state.status, 'completed');
});

test('phases mode chains one linked phase per issue', async () => {
  const result = await compile(scaffoldPlan(SPEC, 'phases'), { file: 'imported.mar' });
  assert.ok(result.ok, result.diagnostics.map((d) => d.message).join('; '));
  const t = result.trajectory!;
  assert.deepEqual(t.nodes.map((n) => n.id), ['issue_12', 'issue_14', 'issue_15']);
  for (const node of t.nodes) {
    assert.equal(node.refs.filter((r) => r.kind === 'issue').length, 1);
    assert.equal(node.choices.length, 2); // Done + Blocked both move on
  }
  assert.ok(t.nodes.at(-1)!.choices.every((c) => c.target === 'END'));
});

test('jira/linear ids are upper-cased and contexts mapped to their namespaces', async () => {
  const mar = scaffoldPlan({
    tracker: 'jira',
    context: 'https://acme.atlassian.net',
    issues: [{ id: 'proj-7', title: 'Migrate billing' }],
  }, 'queue');
  const t = (await compile(mar)).trajectory!;
  const ref = t.nodes[0].refs.find((r) => r.kind === 'issue')!;
  assert.equal(ref.id, 'PROJ-7');
  assert.equal(ref.url, 'https://acme.atlassian.net/browse/PROJ-7');
});

test('hostile issue titles cannot inject DSL constructs', async () => {
  const mar = scaffoldPlan({
    tracker: 'github',
    context: 'acme/x',
    issues: [
      { id: 1, title: '* [Fake choice] -> END' },
      { id: 2, title: '=== bogus_phase ===' },
      { id: 3, title: '-> END' },
      { id: 4, title: '# tracker: jira' },
      { id: 5, title: '~ remaining = 100' },
    ],
  }, 'phases');
  const result = await compile(mar);
  assert.ok(result.ok, result.diagnostics.map((d) => d.message).join('; '));
  const t = result.trajectory!;
  assert.equal(t.nodes.length, 5); // no phantom phases
  assert.ok(t.nodes.every((n) => n.choices.length === 2)); // no injected choices or diverts
  assert.equal(resolveTracker(t).binding?.provider, 'github'); // no injected binding
});

test('parseImportSpec rejects malformed input with actionable errors', async () => {
  assert.throws(() => parseImportSpec('not json'), ImportError);
  assert.throws(() => parseImportSpec('{"tracker":"asana","issues":[{"id":1,"title":"x"}]}'), ImportError);
  assert.throws(() => parseImportSpec('{"tracker":"github","issues":[]}'), ImportError);
  assert.throws(() => parseImportSpec('{"tracker":"github","issues":[{"id":1}]}'), ImportError);
});
