import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, trajectoryHash } from '../src/compile.js';
import {
  DriftError, WalkError, advance, bindState, frontier, initState, takeChoice,
} from '../src/state.js';

const SOURCE = `
VAR iteration = 0
=== build_mvp ===
Ship the smallest testable slice.
~ iteration += 1
* [Metrics green] @human -> beta_launch
+ {iteration < 3} [Learnings, go again] ~loop~ -> build_mvp
* {iteration >= 3} [Three strikes] -> pivot_or_kill
=== beta_launch ===
-> END
=== pivot_or_kill ===
* [Kill it] @human -> END
`;

async function compiled() {
  const result = await compile(SOURCE, { file: 'test.mar' });
  assert.ok(result.ok, result.diagnostics.map((d) => d.message).join('; '));
  return result.trajectory!;
}

test('P0.7 hash is stable, semantic, and ignores comments/whitespace/source path', async () => {
  const a = (await compile(SOURCE, { file: 'a.mar' })).trajectory!;
  const b = (await compile('// a comment\n' + SOURCE.replace('slice.', 'slice.'), { file: 'b.mar' })).trajectory!;
  assert.equal(a.hash, b.hash);
  const c = (await compile(SOURCE.replace('iteration < 3', 'iteration < 4'))).trajectory!;
  assert.notEqual(a.hash, c.hash);
  assert.equal(a.hash, await trajectoryHash(a));
});

test('P0.7 drift detection: mutated script invalidates stale state', async () => {
  const t = await compiled();
  const state = initState(t);
  const edited = (await compile(SOURCE.replace('iteration < 3', 'iteration < 4'))).trajectory!;
  assert.throws(() => bindState(edited, state), DriftError);
  assert.doesNotThrow(() => bindState(t, state));
  assert.throws(() => bindState(edited, state), /reconcil/i);
});

test('walker: init applies entry actions and evaluates the frontier', async () => {
  const t = await compiled();
  const state = initState(t, 'system', '2026-01-01T00:00:00Z');
  assert.equal(state.current, 'build_mvp');
  assert.equal(state.variables['iteration'], 1);
  const options = frontier(t, state);
  assert.equal(options[0].blocked, null);              // @human, but present
  assert.equal(options[1].blocked, null);              // iteration < 3
  assert.match(options[2].blocked ?? '', /false/);     // iteration >= 3
});

test('walker: @human checkpoints refuse agents and demand rationale (G4)', async () => {
  const t = await compiled();
  const state = initState(t);
  assert.throws(() => takeChoice(t, state, '0', { actor: 'agent', rationale: 'x' }), WalkError);
  assert.throws(() => takeChoice(t, state, '0', { actor: 'lee' }), WalkError);
  assert.throws(() => takeChoice(t, state, '1', { actor: 'agent' }), /rationale/);
  takeChoice(t, state, '0', { actor: 'lee', rationale: 'metrics green' });
  assert.equal(state.current, 'beta_launch');
  const last = state.log.at(-1)!;
  assert.equal(last.actor, 'lee');
  assert.equal(last.rationale, 'metrics green');
  assert.ok(last.at);
});

test('walker: sticky loops iterate, counters progress, gated exit opens', async () => {
  const t = await compiled();
  const state = initState(t);
  takeChoice(t, state, 'Learnings', { actor: 'agent', rationale: 'iteration 1 red' });
  takeChoice(t, state, 'Learnings', { actor: 'agent', rationale: 'iteration 2 red' });
  assert.equal(state.variables['iteration'], 3);
  const options = frontier(t, state);
  assert.match(options[1].blocked ?? '', /gate/);      // loop gate now false
  assert.equal(options[2].blocked, null);              // three-strikes exit open
  takeChoice(t, state, 'Three', { actor: 'agent', rationale: 'three strikes' });
  assert.equal(state.current, 'pivot_or_kill');
  assert.equal(state.log.filter((entry) => entry.choice !== null).length, 3);
});

test('walker: automatic advance and completion', async () => {
  const t = await compiled();
  const state = initState(t);
  takeChoice(t, state, '0', { actor: 'lee', rationale: 'green' });
  advance(t, state, { actor: 'agent' });
  assert.equal(state.status, 'completed');
  assert.equal(state.current, 'END');
  assert.throws(() => advance(t, state, { actor: 'agent' }), WalkError);
});

test('walker: once-only choices exhaust; unknown refs error helpfully', async () => {
  const t = (await compile(`
=== a ===
* [Solo] -> a2
* [Other] -> END
=== a2 ===
* [Back] ~loop~ -> a
* [Out] -> END
`)).trajectory!;
  const state = initState(t);
  takeChoice(t, state, 'Solo', { actor: 'agent', rationale: 'first' });
  takeChoice(t, state, 'Back', { actor: 'agent', rationale: 'loop' });
  const options = frontier(t, state);
  assert.match(options[0].blocked ?? '', /already taken/);
  assert.throws(() => takeChoice(t, state, 'Nope', { actor: 'agent', rationale: 'x' }), /available/);
});
