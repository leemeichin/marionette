import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compile.ts';
import { interactionKind } from '../src/gates.ts';
import type { Choice } from '../src/types.ts';

const choice = (overrides: Partial<Choice> = {}): Choice => ({
  id: 'review#0',
  label: 'Review',
  sticky: false,
  gate: null,
  human: false,
  ask: false,
  input: false,
  loop: false,
  timeout: null,
  target: 'END',
  line: 1,
  ...overrides,
});

test('gate semantics preserve archived spec-0.5 ask as fixed-target input', () => {
  const archived = choice({ ask: true });
  delete archived.input;
  assert.equal(interactionKind({ spec: '0.5.0' }, archived), 'input');
});

test('parser emits an explicit input bit without overloading ask', async () => {
  const trajectory = (await compile(`
=== clarify ===
* [Need context] @input -> END
`)).trajectory!;
  assert.equal(trajectory.nodes[0].choices[0].input, true);
  assert.equal(trajectory.nodes[0].choices[0].ask, false);
  assert.equal(interactionKind(trajectory, trajectory.nodes[0].choices[0]), 'input');
});

test('spec-0.6 separates operator ask, free-text input, and evidenced human confirmation', () => {
  assert.equal(interactionKind({ spec: '0.6.0' }, choice({ ask: true })), 'ask');
  assert.equal(interactionKind({ spec: '0.6.0' }, choice({ input: true })), 'input');
  assert.equal(interactionKind({ spec: '0.6.0' }, choice({ human: true })), 'external-human');
  assert.equal(interactionKind({ spec: '0.6.0' }, choice()), 'agent');
});
