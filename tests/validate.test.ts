import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compile.js';
import { CODES, type Severity } from '../src/types.js';

/** Each defect class (P0.3) has a failing fixture; every diagnostic must carry a line and a suggestion where promised. */
async function expectDiagnostic(source: string, code: string, severity: Severity = 'error') {
  const result = await compile(source);
  const hit = result.diagnostics.find((d) => d.code === code);
  assert.ok(hit, `expected ${code}, got: ` +
    result.diagnostics.map((d) => `${d.code}(${d.severity})`).join(', '));
  assert.equal(hit!.severity, severity);
  return { hit: hit!, result };
}

test('MAR002 duplicate phase', async () => {
  await expectDiagnostic(`
=== a ===
-> END
=== a ===
-> END
`, CODES.DUPLICATE_PHASE);
});

test('MAR003 undefined divert target, with did-you-mean suggestion', async () => {
  const { hit } = await expectDiagnostic(`
=== a ===
* [Go] -> beta_lunch
* [Stop] -> END
=== beta_launch ===
-> END
`, CODES.UNDEFINED_TARGET);
  assert.match(hit.suggestion ?? '', /beta_launch/);
});

test('MAR004 undefined variable in gate, with suggestion', async () => {
  const { hit } = await expectDiagnostic(`
VAR iteration = 0
=== a ===
~ iteration += 1
* {iteraton < 3} [Go] -> END
`, CODES.UNDEFINED_VARIABLE);
  assert.match(hit.suggestion ?? '', /iteration/);
});

test('MAR005 duplicate variable', async () => {
  await expectDiagnostic(`
VAR x = 1
VAR x = 2
=== a ===
-> END
`, CODES.DUPLICATE_VARIABLE);
});

test('MAR006 dead end: phase with no choices and no divert', async () => {
  await expectDiagnostic(`
=== a ===
* [Onward] -> b
=== b ===
This phase goes nowhere.
`, CODES.DEAD_END);
});

test('MAR006 effective dead end: all choices constant-false', async () => {
  await expectDiagnostic(`
=== a ===
* {false} [Never] -> END
`, CODES.DEAD_END);
});

test('MAR007 unreachable phase', async () => {
  await expectDiagnostic(`
=== a ===
-> END
=== orphan ===
-> END
`, CODES.UNREACHABLE);
});

test('MAR008 undeclared cycle', async () => {
  const { hit } = await expectDiagnostic(`
=== a ===
* [To b] -> b
* [Out] -> END
=== b ===
* [Back] -> a
`, CODES.UNDECLARED_CYCLE);
  assert.match(hit.suggestion ?? '', /~loop~/);
});

test('MAR009 declared loop with no exit path at all', async () => {
  await expectDiagnostic(`
=== a ===
+ [Again] ~loop~ -> a
`, CODES.LOOP_WITHOUT_EXIT);
});

test('MAR010 loop whose only exits are unsatisfiable', async () => {
  await expectDiagnostic(`
VAR done = false
=== a ===
+ [Again] ~loop~ -> a
* {done} [Exit] -> END
`, CODES.LOOP_EXIT_UNSATISFIABLE);
});

test('MAR011 constant-false gate warning', async () => {
  await expectDiagnostic(`
=== a ===
* {1 > 2} [Never] -> b
* [Out] -> END
=== b ===
-> END
`, CODES.CONSTANT_FALSE_GATE, 'warning');
});

test('MAR012 @human choice without escalation path', async () => {
  await expectDiagnostic(`
=== a ===
* [Needs a human] @human
`, CODES.HUMAN_WITHOUT_ESCALATION);
});

test('MAR013 ~loop~ on an edge that does not close a cycle', async () => {
  await expectDiagnostic(`
=== a ===
+ [Onward] ~loop~ -> b
=== b ===
-> END
`, CODES.LOOP_NOT_A_CYCLE, 'warning');
});

test('MAR014 unverified gate warning enumerates undecidable gates', async () => {
  await expectDiagnostic(`
VAR green = false
=== a ===
~ green = true
* {green} [Ship] -> END
* [Hold] -> END
`, CODES.UNVERIFIED_GATE, 'warning');
});

test('MAR014 loop exits that cannot be verified warn instead of erroring', async () => {
  await expectDiagnostic(`
VAR approved = false
=== review ===
~ approved = true
+ [Revise] ~loop~ -> review
* {approved} [Accept] -> END
`, CODES.UNVERIFIED_GATE, 'warning');
});

test('MAR015 type mismatch: += on a boolean', async () => {
  await expectDiagnostic(`
VAR flag = true
=== a ===
~ flag += 1
* {flag} [Go] -> END
* [Stop] -> END
`, CODES.TYPE_MISMATCH);
});

test('MAR016 unused variable warning', async () => {
  await expectDiagnostic(`
VAR never_read = 1
=== a ===
-> END
`, CODES.UNUSED_VARIABLE, 'warning');
});

test('MAR017 once-only loop choice warning', async () => {
  await expectDiagnostic(`
VAR i = 0
=== a ===
~ i += 1
* {i < 3} [Again] ~loop~ -> a
* {i >= 3} [Done] -> END
`, CODES.LOOP_ONCE_ONLY, 'warning');
});

test('sound plan: monotonic counter loop with satisfiable exit is clean', async () => {
  const result = await compile(`
VAR i = 0
=== a ===
~ i += 1
+ {i < 3} [Again] ~loop~ -> a
* {i >= 3} [Done] -> END
`);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.ok);
});

test('monotonic continue gate verifies on a cycle edge without the ~loop~ mark', async () => {
  // The ~loop~ mark sits on reconcile -> transform; the gated continue edge
  // transform -> reconcile is part of the same cycle and must not warn MAR014.
  const result = await compile(`
VAR patches = 0
=== transform ===
~ patches += 1
+ {patches < 5} [Bugs found, reconcile] -> reconcile
* [Clean run] -> END
* {patches >= 5} [Budget spent] @human -> END
=== reconcile ===
+ [Patched, retry] ~loop~ -> transform
`);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.ok);
});

test('counter reset keeps gates unverified (MAR014) by design', async () => {
  const result = await compile(`
VAR tries = 0
=== work ===
~ tries += 1
+ {tries < 3} [Retry] ~loop~ -> work
* {tries >= 3} [Escalate] @human -> reset_and_return
* [Works] -> END
=== reset_and_return ===
~ tries = 0
+ [Start the evaluation over] ~loop~ -> work
+ [Stop] @human -> END
`);
  assert.ok(result.ok);
  assert.ok(result.diagnostics.some((d) => d.code === 'MAR014'));
});

test('loop verified by an ungated @human exit', async () => {
  const result = await compile(`
=== a ===
+ [Again] ~loop~ -> a
* [Enough. Decide.] @human -> END
`);
  assert.deepEqual(result.diagnostics, []);
});

test('MAR021 malformed timebox warns and is ignored', async () => {
  const { result } = await expectDiagnostic(`
=== spike ===
Try the thing.
# timebox: fortnight
* [Worked] -> END
* [Abandon] -> END
`, CODES.MALFORMED_TIMEBOX, 'warning');
  assert.ok(result.ok, 'a malformed timebox is advisory, not a build failure');
});

test('MAR022 unknown priority warns with the allowed set', async () => {
  const { hit } = await expectDiagnostic(`
=== spike ===
Try the thing.
# priority: urgent
-> END
`, CODES.UNKNOWN_PRIORITY, 'warning');
  assert.match(hit.suggestion!, /critical, high, normal, low/);
});

test('MAR023 timebox without an alternative exit warns', async () => {
  await expectDiagnostic(`
=== spike ===
Try the thing.
# timebox: 3d
-> END
`, CODES.TIMEBOX_WITHOUT_ALTERNATIVE, 'warning');

  const twoDoors = await compile(`
=== spike ===
Try the thing.
# timebox: 3d
* [Worked — adopt] -> END
* [Not viable or timebox spent] -> END
`);
  assert.ok(!twoDoors.diagnostics.some((d) => d.code === CODES.TIMEBOX_WITHOUT_ALTERNATIVE),
    'a worked door plus an abandon door satisfies the timebox shape');
});
