import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgentBridge } from '../src/pi-agent.js';
import { ProtocolError, type RuntimeProjection } from '../src/runtime-protocol.js';

const projectionOf = (result: Awaited<ReturnType<PiAgentBridge['next']>>): RuntimeProjection =>
  result.result.projection as RuntimeProjection;

const withPlan = async (fn: (file: string, store: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-pi-agent-'));
  const file = join(root, 'plan.mar');
  const nodes: string[] = [];
  for (let index = 1; index <= 15; index++) {
    const id = `phase_${index}`;
    const target = index === 15 ? 'END' : `phase_${index + 1}`;
    const choices = index === 5
      ? `* [Continue] -> ${target}\n+ [Retry once] ~loop~ -> ${id}`
      : index === 10
        ? `* [Human approves] @human -> ${target}`
        : `* [Continue] -> ${target}`;
    nodes.push(`=== ${id} ===\nPhase ${index}.\n${choices}`);
  }
  writeFileSync(file, nodes.join('\n\n') + '\n', 'utf8');
  try {
    await fn(file, join(root, 'store'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('Pi bridge traverses a 15-phase run with a loop and durable human handoff', () =>
  withPlan(async (file, storeRoot) => {
    let bridge = await PiAgentBridge.open({
      planFile: file,
      runId: 'proving-ground',
      sessionId: 'session-1',
      storeRoot,
    });

    for (let index = 1; index <= 4; index++) {
      await bridge.choose(`phase_${index}#0`, `phase ${index} complete`, `step-${index}`);
    }
    await bridge.choose('phase_5#1', 'first pass needs one retry', 'step-5-retry');
    await bridge.choose('phase_5#0', 'retry succeeded', 'step-5');
    for (let index = 6; index <= 9; index++) {
      await bridge.choose(`phase_${index}#0`, `phase ${index} complete`, `step-${index}`);
    }

    const waiting = projectionOf(await bridge.next());
    assert.equal(waiting.status, 'awaiting-human');
    assert.equal(waiting.node?.id, 'phase_10');
    assert.ok(waiting.escalation?.id);
    assert.deepEqual(waiting.escalation?.fallbacks, []);
    const escalationId = waiting.escalation!.id;
    const revision = bridge.revision();

    await assert.rejects(
      () => bridge.choose(
        'phase_10#0',
        'the model cannot approve its own work',
        'forbidden-human-choice',
      ),
      (error: unknown) => error instanceof ProtocolError && error.code === 'forbidden',
    );
    assert.equal(bridge.revision(), revision);

    bridge = await PiAgentBridge.open({
      planFile: file,
      runId: 'proving-ground',
      sessionId: 'session-2',
      storeRoot,
    });
    const resumed = projectionOf(await bridge.next());
    assert.equal(resumed.escalation?.id, escalationId);

    const approved = await bridge.humanChoose(
      { id: 'lee', uri: 'pi://human/lee' },
      'phase_10#0',
      'reviewed the evidence and approved',
      `human:${escalationId}:phase_10#0`,
    );
    assert.equal(projectionOf(approved).node?.id, 'phase_11');

    const replay = await bridge.humanChoose(
      { id: 'lee', uri: 'pi://human/lee' },
      'phase_10#0',
      'reviewed the evidence and approved',
      `human:${escalationId}:phase_10#0`,
    );
    assert.equal(replay.replayed, true);

    for (let index = 11; index <= 15; index++) {
      await bridge.choose(`phase_${index}#0`, `phase ${index} complete`, `step-${index}`);
    }
    const completed = projectionOf(await bridge.next());
    assert.equal(completed.status, 'completed');
    assert.equal(completed.escalation, null);
  }));
