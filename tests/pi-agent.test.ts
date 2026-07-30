import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgentBridge } from '../src/pi-agent.ts';
import { ProtocolError, type RuntimeProjection } from '../src/runtime-protocol.ts';

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
        ? `* [Operator approves] @ask -> ${target}`
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
    assert.equal(waiting.status, 'awaiting-operator');
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

test('Pi bridge exposes protocol capabilities, records, events, and external refresh', () =>
  withPlan(async (file, storeRoot) => {
    const first = await PiAgentBridge.open({
      planFile: file,
      runId: 'host-contract',
      sessionId: 'session-1',
      storeRoot,
    });
    const initialized = await first.initialize({ name: 'pibarm', version: '1' });
    assert.deepEqual(
      (initialized.result.capabilities as { operations: string[] }).operations,
      ['next', 'choose', 'confirm', 'ask', 'answer', 'advance', 'observe', 'record', 'events'],
    );

    const attached = await first.record(
      'architecture-decision',
      'Use the versioned Pi integration envelope',
      'record-1',
      { rationale: 'pibarm needs one stable notification shape' },
    );
    assert.equal(attached.events[0].kind, 'record.attached');

    const second = await PiAgentBridge.open({
      planFile: file,
      runId: 'host-contract',
      sessionId: 'session-2',
      storeRoot,
    });
    await second.choose('phase_1#0', 'phase one complete', 'external-step');

    const refreshed = projectionOf(await first.next());
    assert.equal(refreshed.node?.id, 'phase_2');
    assert.equal(refreshed.revision, 2);

    const history = await first.events(2, 10);
    const events = history.result.events as Array<{ kind: string }>;
    assert.ok(events.some((event) => event.kind === 'record.attached'));
    assert.ok(events.some((event) => event.kind === 'decision.committed'));

    await Promise.all([
      first.choose('phase_2#0', 'phase two complete', 'concurrent-step-2'),
      first.choose('phase_3#0', 'phase three complete', 'concurrent-step-3'),
    ]);
    assert.equal(projectionOf(await first.next()).node?.id, 'phase_4');
  }));

test('Pi bridge opens @ask as agent and answers through the trusted human surface', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-pi-ask-'));
  const file = join(root, 'plan.mar');
  const storeRoot = join(root, 'store');
  writeFileSync(file, [
    '=== decide ===',
    '* [I am not sure] @input -> reconsider',
    '=== reconsider ===',
    'Use the clarification.',
    '-> END',
    '',
  ].join('\n'));
  try {
    const bridge = await PiAgentBridge.open({
      planFile: file,
      runId: 'ask',
      sessionId: 'session-ask',
      storeRoot,
    });
    const opened = await bridge.ask(
      'decide#0',
      'Which release targets are required?',
      'the matrix is ambiguous',
      'ask-1',
    );
    const waiting = projectionOf(opened);
    assert.equal(waiting.status, 'awaiting-elicitation');
    assert.equal(waiting.elicitation?.question, 'Which release targets are required?');

    const resolved = await bridge.humanAnswer(
      { id: 'lee', uri: 'pi://human/lee' },
      'macOS arm64 and x86_64 Linux',
      'answer-1',
    );
    const active = projectionOf(resolved);
    assert.equal(active.node?.id, 'reconsider');
    assert.equal(active.clarification?.answer, 'macOS arm64 and x86_64 Linux');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
