/**
 * Runtime-agnostic vectors exercised against the production Prolog facade and
 * the quarantined TypeScript shadow. The shadow is test-only and exists solely
 * for the 30-day cutover confidence window.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlanState, Trajectory, Value } from '../src/types.ts';
import { compile, trajectoryHash } from '../src/compile.ts';
import {
  WalkError,
  advance,
  frontier,
  initState,
  observe,
  takeChoice,
} from '../src/state.ts';
import * as shadow from './reference/state.ts';

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

const AT = '2026-01-01T00:00:00.000Z';
const caseFiles = readdirSync(casesDir).filter((file) => file.endsWith('.json'));

test('conformance: suite is non-empty', () => {
  assert.ok(caseFiles.length >= 2);
});

for (const file of caseFiles) {
  const spec = JSON.parse(readFileSync(join(casesDir, file), 'utf8')) as Case;

  test(`conformance: ${spec.case} (Prolog production vs TypeScript shadow)`, async () => {
    const source = readFileSync(join(root, spec.plan), 'utf8');
    const result = await compile(source, { file: spec.plan });
    assert.ok(result.ok && result.trajectory,
      `${spec.plan} must compile: ` + result.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
    // Frozen conformance vectors predate the authority split. Exercise them
    // as archived spec-0.5 epochs; spec-0.6 interactions have dedicated cases.
    const trajectory = result.trajectory!;
    trajectory.spec = '0.5.0';
    trajectory.hash = await trajectoryHash(trajectory);
    let production = await initState(trajectory, 'system', AT);
    const reference = shadow.initState(trajectory, 'system', AT);

    compareState(`${spec.case} initial`, production, reference);
    await compareFrontier(`${spec.case} initial`, trajectory, production, reference, AT);

    for (const [index, step] of spec.steps.entries()) {
      const where = `${spec.case} step ${index}`;
      const at = step.elapsed === undefined
        ? AT
        : new Date(Date.parse(AT) + step.elapsed * 1000).toISOString();
      const options = { actor: step.actor ?? 'agent', rationale: step.rationale, at };
      const productionBefore = structuredClone(production);
      const referenceBefore = structuredClone(reference);

      if (step.expect?.error) {
        await assert.rejects(
          runProduction(trajectory, production, step, options),
          (error: unknown) =>
            error instanceof WalkError && error.code === step.expect!.error,
          `${where}: production refusal`,
        );
        assert.throws(
          () => runShadow(trajectory, reference, step, options),
          (error: unknown) =>
            error instanceof shadow.WalkError && error.code === step.expect!.error,
          `${where}: shadow refusal`,
        );
        assert.deepEqual(production, productionBefore, `${where}: production refusal is immutable`);
        assert.deepEqual(reference, referenceBefore, `${where}: shadow refusal is atomic`);
      } else {
        production = await runProduction(trajectory, production, step, options);
        runShadow(trajectory, reference, step, options);
        checkExpected(where, step, production);
      }

      compareState(where, production, reference);
      await compareFrontier(where, trajectory, production, reference, at);
    }
  });
}

async function runProduction(
  trajectory: Trajectory,
  state: PlanState,
  step: Step,
  options: { actor: string; rationale?: string; at: string },
): Promise<PlanState> {
  if (step.choose !== undefined) return takeChoice(trajectory, state, step.choose, options);
  if (step.advance) return advance(trajectory, state, options);
  if (step.observe) {
    return observe(trajectory, state, step.observe.name, step.observe.value, options);
  }
  return state;
}

function runShadow(
  trajectory: Trajectory,
  state: PlanState,
  step: Step,
  options: { actor: string; rationale?: string; at: string },
): void {
  if (step.choose !== undefined) shadow.takeChoice(trajectory, state, step.choose, options);
  else if (step.advance) shadow.advance(trajectory, state, options);
  else if (step.observe) {
    shadow.observe(trajectory, state, step.observe.name, step.observe.value, options);
  }
}

function compareState(where: string, production: PlanState, reference: PlanState): void {
  assert.deepEqual(production, reference, `${where}: full semantic and audit state`);
}

async function compareFrontier(
  where: string,
  trajectory: Trajectory,
  production: PlanState,
  reference: PlanState,
  at: string,
): Promise<void> {
  const actual = (await frontier(trajectory, production, { at })).map((item) => ({
    id: item.choice.id,
    blockedCode: item.blockedCode,
  }));
  const expected = shadow.frontier(trajectory, reference, { at }).map((item) => ({
    id: item.choice.id,
    blockedCode: item.blockedCode,
  }));
  assert.deepEqual(actual, expected, `${where}: evaluated frontier`);
}

function checkExpected(where: string, step: Step, actual: PlanState): void {
  const expected = step.expect ?? {};
  if (expected.current !== undefined) {
    assert.equal(actual.current, expected.current, `${where}: current node`);
  }
  if (expected.status !== undefined) {
    assert.equal(actual.status, expected.status, `${where}: status`);
  }
  for (const [name, value] of Object.entries(expected.variables ?? {})) {
    assert.deepEqual(actual.variables[name], value, `${where}: variable ${name}`);
  }
  if (expected.pendingObservations !== undefined) {
    assert.deepEqual(
      actual.pendingObservations,
      expected.pendingObservations,
      `${where}: pending observations`,
    );
  }
}
