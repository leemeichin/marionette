import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../src/parser.ts';
import { emitFacts } from '../src/facts.ts';
import { ruleGraphFindings, ruleWalkInit } from '../src/rule-engine.ts';

test('rule engine serializes concurrent callers without leaking plan facts', async () => {
  const dead = emitFacts(parsePlan(`
=== dead ===
No way forward.
`));
  const clean = emitFacts(parsePlan(`
VAR n = 0
=== start ===
~ n += 1
-> END
`));

  const calls = Array.from({ length: 20 }, async (_, index) => {
    if (index % 2 === 0) {
      const findings = await ruleGraphFindings(dead);
      assert.deepEqual(findings.map((finding) => finding.code), ['MAR006']);
    } else {
      const initialized = await ruleWalkInit(clean, 1_767_225_600_000);
      assert.equal(initialized.ok, true);
      assert.equal(initialized.state.current, 'start');
      assert.deepEqual(initialized.state.variables, { n: 1 });
    }
  });

  await Promise.all(calls);
});
