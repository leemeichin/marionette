/**
 * Runs the runtime-agnostic conformance suite (spec/conformance) against
 * BOTH walker implementations: the TypeScript reference walker
 * (src/state.ts) and the rule-base walker (spec/rules/marionette.pl §7 on
 * the bundled engine, driven via src/oracle.ts). Any other implementation
 * must pass the same cases — see spec/conformance/README.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Trajectory, Value } from '../src/types.js';
import { compile } from '../src/compile.js';
import { parsePlan } from '../src/parser.js';
import { emitFacts } from '../src/facts.js';
import { prologWalker } from '../src/oracle.js';
import { WalkError, advance, initState, observe, takeChoice } from '../src/state.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const casesDir = join(root, 'spec', 'conformance', 'cases');

interface Step {
  choose?: string;
  advance?: boolean;
  observe?: { name: string; value: Value };
  elapsed?: number;
  actor?: string;
  rationale?: string;
  expect?: {
    error?: string;
    current?: string;
    status?: string;
    variables?: Record<string, Value>;
    pendingObservations?: string[];
  };
}

interface Case {
  case: string;
  description: string;
  plan: string;
  steps: Step[];
}

// A fixed timestamp keeps refused-operation snapshots comparable bit-for-bit.
const AT = '2026-01-01T00:00:00.000Z';

const caseFiles = readdirSync(casesDir).filter((f) => f.endsWith('.json'));

test('conformance: suite is non-empty', async () => {
  assert.ok(caseFiles.length >= 2);
});

for (const file of caseFiles) {
  const spec = JSON.parse(readFileSync(join(casesDir, file), 'utf8')) as Case;

  test(`conformance: ${spec.case} (typescript walker)`, async () => {
    const source = readFileSync(join(root, spec.plan), 'utf8');
    const result = await compile(source, { file: spec.plan });
    assert.ok(result.ok && result.trajectory,
      `${spec.plan} must compile: ` + result.diagnostics.map((d) => d.message).join('; '));
    const trajectory = result.trajectory!;
    const state = initState(trajectory, 'system', AT);

    spec.steps.forEach((step, i) => {
      const where = `${spec.case} step ${i}`;
      const at = step.elapsed === undefined
        ? AT
        : new Date(Date.parse(AT) + step.elapsed * 1000).toISOString();
      const opts = { actor: step.actor ?? 'agent', rationale: step.rationale, at };
      const logBefore = state.log.length;

      if (step.expect?.error) {
        const before = JSON.stringify(state);
        assert.throws(
          () => runOp(trajectory, state, step, opts),
          (e: unknown) => e instanceof WalkError && e.code === step.expect!.error,
          `${where}: expected refusal "${step.expect.error}"`,
        );
        assert.equal(JSON.stringify(state), before, `${where}: a refusal must not change state`);
        return;
      }

      runOp(trajectory, state, step, opts);
      if (step.choose !== undefined || step.advance) {
        assert.equal(state.log.length, logBefore + 1,
          `${where}: a successful operation must append exactly one log entry (G4)`);
        const entry = state.log[state.log.length - 1];
        assert.equal(entry.actor, opts.actor, `${where}: log records the actor`);
        assert.ok(entry.rationale, `${where}: log records a rationale`);
      }

      checkState(where, step, {
        current: state.current,
        status: state.status,
        variables: state.variables,
        pendingObservations: state.pendingObservations,
      });
    });
  });

  test(`conformance: ${spec.case} (rule-base walker)`, async () => {
    const source = readFileSync(join(root, spec.plan), 'utf8');
    const plan = parsePlan(source);
    assert.ok(!plan.diagnostics.some((d) => d.severity === 'error'), `${spec.plan} must parse`);
    const walker = await prologWalker(emitFacts(plan));

    for (const [i, step] of spec.steps.entries()) {
      const where = `${spec.case} step ${i} (rules)`;
      if (step.elapsed !== undefined) walker.setElapsed(step.elapsed);
      const refused = step.choose !== undefined
        ? walker.choose(step.choose, step.actor ?? 'agent', step.rationale !== undefined)
        : step.advance
          ? walker.advance()
          : step.observe
            ? walker.observe(step.observe.name, step.observe.value, step.rationale !== undefined)
          : null;

      if (step.expect?.error) {
        const before = JSON.stringify(walker.snapshot());
        assert.equal(refused, step.expect.error, `${where}: expected refusal "${step.expect.error}"`);
        // Re-issue the refused operation: still refused, still no mutation.
        if (step.choose !== undefined) walker.choose(step.choose, step.actor ?? 'agent', step.rationale !== undefined);
        assert.equal(JSON.stringify(walker.snapshot()), before, `${where}: a refusal must not change state`);
        continue;
      }
      assert.equal(refused, null, `${where}: operation must succeed, got refusal "${refused}"`);
      checkState(where, step, walker.snapshot());
    }
  });
}

function checkState(
  where: string,
  step: Step,
  actual: {
    current: string;
    status: string;
    variables: Record<string, Value>;
    pendingObservations?: string[];
  },
): void {
  const expect = step.expect ?? {};
  if (expect.current !== undefined) {
    assert.equal(actual.current, expect.current, `${where}: current node`);
  }
  if (expect.status !== undefined) {
    assert.equal(actual.status, expect.status, `${where}: status`);
  }
  for (const [name, value] of Object.entries(expect.variables ?? {})) {
    assert.deepEqual(actual.variables[name], value, `${where}: variable ${name}`);
  }
  if (expect.pendingObservations !== undefined) {
    assert.deepEqual(actual.pendingObservations, expect.pendingObservations,
      `${where}: pending observations`);
  }
}

function runOp(
  trajectory: Trajectory,
  state: ReturnType<typeof initState>,
  step: Step,
  opts: { actor: string; rationale?: string; at: string },
): void {
  if (step.choose !== undefined) takeChoice(trajectory, state, step.choose, opts);
  else if (step.advance) advance(trajectory, state, opts);
  else if (step.observe) {
    observe(trajectory, state, step.observe.name, step.observe.value, opts);
  }
}
