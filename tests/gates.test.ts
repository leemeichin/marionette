import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExpr, evalExpr, tryConstEval } from '../src/expr.js';
import { analyzeGate, eventuallyFalse, monotonicDirection, type GateContext } from '../src/gates.js';
import type { Action, Gate } from '../src/types.js';

const gate = (source: string): Gate => ({ source, ast: parseExpr(source) });
const action = (v: string, op: Action['op'], value: string): Action =>
  ({ var: v, op, value: parseExpr(value), source: value, line: 1 });

function ctx(partial: Partial<GateContext> = {}): GateContext {
  return {
    variables: { i: { type: 'number', initial: 0, line: 1 }, flag: { type: 'boolean', initial: false, line: 1 } },
    mutations: new Map(),
    ...partial,
  };
}

test('expression parsing and evaluation', async () => {
  assert.equal(evalExpr(parseExpr('1 + 2 * 3'), {}), 7);
  assert.equal(evalExpr(parseExpr('(1 + 2) * 3'), {}), 9);
  assert.equal(evalExpr(parseExpr('!(x > 2) || y == "a"'), { x: 1, y: 'b' }), true);
  assert.equal(evalExpr(parseExpr('x >= 3 and not done'), { x: 3, done: false }), true);
  assert.equal(tryConstEval(parseExpr('2 < 1')), false);
  assert.equal(tryConstEval(parseExpr('x < 1')), undefined);
  assert.throws(() => evalExpr(parseExpr('1 < "a"'), {}));
  assert.throws(() => parseExpr('1 +'));
});

test('constant gates are decidable', async () => {
  assert.equal(analyzeGate(gate('2 > 1'), ctx()).status, 'satisfiable');
  assert.equal(analyzeGate(gate('false'), ctx()).status, 'unsatisfiable');
});

test('never-mutated variables evaluate against initials', async () => {
  assert.equal(analyzeGate(gate('flag'), ctx()).status, 'unsatisfiable');
  assert.equal(analyzeGate(gate('i == 0'), ctx()).status, 'satisfiable');
});

test('monotonic direction detection', async () => {
  assert.equal(monotonicDirection('i', new Map([['i', [action('i', '+=', '1')]]])), 'inc');
  assert.equal(monotonicDirection('i', new Map([['i', [action('i', '-=', '2')]]])), 'dec');
  assert.equal(monotonicDirection('i', new Map([['i', [action('i', '+=', '1'), action('i', '-=', '1')]]])), 'unknown');
  assert.equal(monotonicDirection('i', new Map([['i', [action('i', '=', '5')]]])), 'unknown');
  assert.equal(monotonicDirection('i', new Map()), 'none');
});

test('increasing counter: >= gate eventually satisfiable; < gate eventually false', async () => {
  const mutations = new Map([['i', [action('i', '+=', '1')]]]);
  const c = ctx({ mutations });
  assert.equal(analyzeGate(gate('i >= 3'), c).status, 'satisfiable');
  assert.equal(analyzeGate(gate('3 <= i'), c).status, 'satisfiable');
  assert.equal(analyzeGate(gate('i < 3'), c).status, 'unknown');
  assert.ok(eventuallyFalse(gate('i < 3'), c));
  assert.ok(!eventuallyFalse(gate('i > 3'), c));
});

test('non-monotonic or reassigned counters stay unknown (no false verified claims)', async () => {
  const mutations = new Map([['i', [action('i', '=', 'i + 1')]]]);
  assert.equal(analyzeGate(gate('i >= 3'), ctx({ mutations })).status, 'unknown');
});

test('loop-scope monotonicity is invalidated by conflicting mutations elsewhere', async () => {
  const scopeMutations = new Map([['i', [action('i', '+=', '1')]]]);
  const mutations = new Map([['i', [action('i', '+=', '1'), action('i', '-=', '1')]]]);
  assert.equal(analyzeGate(gate('i >= 3'), ctx({ mutations, scopeMutations })).status, 'unknown');
});
