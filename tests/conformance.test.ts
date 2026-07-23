/**
 * Runs the runtime-agnostic conformance suite (spec/conformance) against the
 * TypeScript reference walker. Any other walker implementation must pass the
 * same cases — see spec/conformance/README.md for the contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlanState, Value } from '../src/types.js';
import { compile } from '../src/compile.js';
import { WalkError, advance, initState, takeChoice } from '../src/state.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const casesDir = join(root, 'spec', 'conformance', 'cases');

interface Step {
  choose?: string;
  advance?: boolean;
  actor?: string;
  rationale?: string;
  expect?: {
    error?: string;
    current?: string;
    status?: string;
    variables?: Record<string, Value>;
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

  test(`conformance: ${spec.case}`, async () => {
    const source = readFileSync(join(root, spec.plan), 'utf8');
    const result = await compile(source, { file: spec.plan });
    assert.ok(result.ok && result.trajectory,
      `${spec.plan} must compile: ` + result.diagnostics.map((d) => d.message).join('; '));
    const trajectory = result.trajectory!;
    const state = initState(trajectory, 'system', AT);

    spec.steps.forEach((step, i) => {
      const where = `${spec.case} step ${i}`;
      const opts = { actor: step.actor ?? 'agent', rationale: step.rationale, at: AT };
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

      const expect = step.expect ?? {};
      if (expect.current !== undefined) {
        assert.equal(state.current, expect.current, `${where}: current node`);
      }
      if (expect.status !== undefined) {
        assert.equal(state.status, expect.status, `${where}: status`);
      }
      for (const [name, value] of Object.entries(expect.variables ?? {})) {
        assert.deepEqual(state.variables[name], value, `${where}: variable ${name}`);
      }
    });
  });
}

function runOp(
  trajectory: NonNullable<ReturnType<typeof compile>['trajectory']>,
  state: PlanState,
  step: Step,
  opts: { actor: string; rationale?: string; at: string },
): void {
  if (step.choose !== undefined) takeChoice(trajectory, state, step.choose, opts);
  else if (step.advance) advance(trajectory, state, opts);
}
